// Capture the Flag, BombSquad rules — two flags, both fully simulated
// physics objects.
//
//   - Each team's flag sits on a stand at its base.
//   - STEAL: press grab near the ENEMY flag to carry it (one carrier at a
//     time — the single grab constraint).
//   - SCORE: bring the enemy flag to your own base... but only while YOUR
//     flag is home. If yours is stolen, you must get it back first.
//   - RETURN: touching your own dropped flag returns it (instant by
//     default, config flag.returnOnTouch). Untouched flags fly home after
//     flag.idleReturn seconds. Falling off the map returns immediately.
//   - The flag itself slides, bounces, gets punched, rides explosion
//     shockwaves, and can be THROWN downfield by its carrier (it inherits
//     carrier momentum — the flag-relay play). A carrier who takes a hard
//     hit drops it as a free-flying physics object.
//
// A mode is a plain object of hooks the sim calls (see sim.js header). All
// mode state lives inside sim.state (here: sim.state.flags) so it
// serializes into snapshots for free.

import { emit, endRound, overFloor } from '../sim.js';
import { integrateBody, collideBodies, blastKick, applyImpulse, invMass } from '../physics.js';
import { otherTeam } from '../../core/config.js';

const mkFlag = (team, pos) => ({
  team,
  st: 'home', // 'home' | 'carry' | 'drop'
  x: pos.x, z: pos.z, y: 0,
  vx: 0, vz: 0, vy: 0,
  carrier: null,
  lastCarrier: null, // credited if the flag scores after being thrown in
  idle: 0, // seconds since dropped (untouched)
  cd: 0, // grab lockout right after a drop
  pcd: 0, // punch lockout (one smack per swing)
});

const getP = (sim, id) => sim.state.players.find((p) => p.id === id);

export const CtfMode = {
  id: 'ctf',
  name: 'Capture the Flag',

  init(sim) {
    sim.state.flags = {
      red: mkFlag('red', sim.level.flags.red),
      blue: mkFlag('blue', sim.level.flags.blue),
    };
    this._blockedAt = 0;
  },

  tick(sim, dt) {
    for (const team of ['red', 'blue']) this.tickFlag(sim, sim.state.flags[team], dt);
  },

  tickFlag(sim, f, dt) {
    const s = sim.state;
    const cfg = sim.config.flag;
    f.cd = Math.max(0, f.cd - dt);
    f.pcd = Math.max(0, f.pcd - dt);

    if (f.st === 'carry') {
      const c = getP(sim, f.carrier);
      if (!c || c.state !== 'alive' || c.carryFlag !== f.team) {
        this.dropCarried(sim, c ?? f, 0, 0, f);
        return;
      }
      f.x = c.x; f.z = c.z; f.y = c.y;
      f.vx = c.vx; f.vz = c.vz; f.vy = 0;
      // score: carrier reaches their own base — IF their own flag is home
      const base = sim.level.bases[c.team];
      if (s.phase === 'play' && Math.hypot(c.x - base.x, c.z - base.z) < base.r) {
        if (s.flags[c.team].st === 'home') {
          this.score(sim, c, f);
        } else if (s.tick - this._blockedAt > 120) {
          this._blockedAt = s.tick;
          emit(sim, { t: 'scoreBlocked', id: c.id, team: c.team });
        }
      }
      return;
    }

    // free flag: full projectile physics (slides, bounces, falls off)
    this.flagPhysics(sim, f, dt);

    if (f.st === 'drop') {
      f.idle += dt;
      if (f.idle >= cfg.idleReturn) {
        this.returnFlag(sim, f, true);
        return;
      }
      // BombSquad scores when the flag ENTERS the base region — carried or
      // not. A thrown/punched flag sliding into the enemy base counts (the
      // relay play), still gated on that team's own flag being home.
      const team = otherTeam(f.team);
      const base = sim.level.bases[team];
      if (s.phase === 'play' && Math.hypot(f.x - base.x, f.z - base.z) < base.r) {
        if (s.flags[team].st === 'home') {
          const c = getP(sim, f.lastCarrier);
          this.score(sim, c && c.team === team ? c : { team, id: null, name: 'A flying flag' }, f);
          return;
        }
        if (s.tick - this._blockedAt > 120) {
          this._blockedAt = s.tick;
          emit(sim, { t: 'scoreBlocked', id: f.lastCarrier, team });
        }
      }
    }

    // home flag knocked off its stand counts as dropped
    if (f.st === 'home') {
      const stand = sim.level.flags[f.team];
      if (Math.hypot(f.x - stand.x, f.z - stand.z) > cfg.homeDrift) {
        f.st = 'drop';
        f.idle = 0;
        emit(sim, { t: 'flagDrop', team: f.team, x: f.x, z: f.z });
      }
    }

    // own team touching their dropped flag returns it (BombSquad rule)
    if (f.st === 'drop' && cfg.returnOnTouch && sim.state.phase === 'play') {
      for (const p of s.players) {
        if (p.team !== f.team || p.state !== 'alive') continue;
        if (Math.hypot(p.x - f.x, p.z - f.z) < cfg.touchRadius + 0.4) {
          this.returnFlag(sim, f, true, p);
          break;
        }
      }
    }
  },

  flagPhysics(sim, f, dt) {
    // full rigid-body treatment via the common physics core: impulse wall
    // bounces, floor restitution, Coulomb slide friction (μ=0.85 — heavy,
    // plants itself), per-step damping, CCD when hurled
    integrateBody(sim.level, sim.world, f, sim.mats.flag, dt);

    // a loose flag can be kicked around by anyone running into it —
    // the midfield scramble (home flags are clamped by their stand)
    if (f.st === 'drop') {
      for (const p of sim.state.players) {
        if (p.state !== 'alive') continue;
        collideBodies(f, sim.mats.flag, p, sim.mats.player, { e: 0.2 });
      }
    }

    if (!overFloor(sim.level, f.x, f.z) && f.y < sim.config.world.fallY) {
      this.returnFlag(sim, f, true); // lost to the void -> zips home
      emit(sim, { t: 'flagVoid', team: f.team });
    }
  },

  // grab button near the ENEMY flag steals it (own flag can't be carried)
  tryGrab(sim, p) {
    const f = sim.state.flags[otherTeam(p.team)];
    if (f.st === 'carry' || f.cd > 0) return false;
    if (Math.hypot(p.x - f.x, p.z - f.z) > sim.config.flag.grabRange) return false;
    f.st = 'carry';
    f.carrier = p.id;
    f.lastCarrier = p.id;
    f.idle = 0;
    p.carryFlag = f.team;
    emit(sim, { t: 'flagSteal', id: p.id, name: p.name, team: f.team, byTeam: p.team });
    return true;
  },

  // carrier lost the flag (KO, hard hit, deliberate set-down): it comes
  // free with whatever momentum it had
  dropCarried(sim, p, vx, vz, flagOverride) {
    const f = flagOverride ?? (p.carryFlag ? sim.state.flags[p.carryFlag] : null);
    if (!f) return;
    if (p.carryFlag !== undefined) p.carryFlag = null;
    f.st = 'drop';
    f.carrier = null;
    f.x = p.x ?? f.x;
    f.z = p.z ?? f.z;
    f.y = Math.max(p.y ?? 0, 0.05);
    f.vx = vx;
    f.vz = vz;
    f.vy = 1.5;
    f.idle = 0;
    f.cd = sim.config.flag.dropLockout;
    emit(sim, { t: 'flagDrop', team: f.team, x: f.x, z: f.z });
  },

  // throw button while carrying: hurl the flag downfield with the universal
  // throw (full momentum inheritance — the classic flag-relay play; a flag
  // that sails into your base while your own is home SCORES)
  throwCarried(sim, p, dir, vel) {
    const f = sim.state.flags[p.carryFlag];
    if (!f) return;
    p.carryFlag = null;
    f.st = 'drop';
    f.carrier = null;
    f.x = p.x + dir.x * 0.6;
    f.z = p.z + dir.z * 0.6;
    f.y = p.y + 1.0;
    f.vx = vel.vx;
    f.vz = vel.vz;
    f.vy = vel.vy;
    f.idle = 0;
    f.cd = sim.config.flag.dropLockout;
    emit(sim, { t: 'flagThrow', id: p.id, team: f.team, x: f.x, z: f.z });
  },

  returnFlag(sim, f, announce, by) {
    const stand = sim.level.flags[f.team];
    f.st = 'home';
    f.carrier = null;
    f.x = stand.x;
    f.z = stand.z;
    f.y = 0;
    f.vx = 0; f.vz = 0; f.vy = 0;
    f.idle = 0;
    f.cd = 0;
    if (announce) emit(sim, { t: 'flagReturn', team: f.team, by: by?.name });
  },

  onKO(sim, p) {
    // sim.breakGrabs already routed the drop through dropCarried
  },

  // flags are completely unaffected by bomb explosions (neither home nor dropped flags move)
  onExplosion(sim, x, z, radius) {
    // Flags are immune to bomb explosions
  },

  // flags are completely unaffected by punches (punches do not impart impulse)
  onPunchObject(sim, fx, fz, radius, dir, vFist, invFist) {
    // Flags are immune to punches
  },

  score(sim, c, stolenFlag) {
    const s = sim.state;
    s.scores[c.team]++;
    c.carryFlag = null;
    this.returnFlag(sim, stolenFlag, false);
    emit(sim, { t: 'score', id: c.id, name: c.name, team: c.team, scores: { ...s.scores } });
    if (s.scores[c.team] >= sim.config.rules.captureLimit) {
      endRound(sim, c.team);
    }
  },
};
