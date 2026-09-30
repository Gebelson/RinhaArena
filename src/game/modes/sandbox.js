// Physics Lab (sandbox) — the dedicated space for verifying physics and
// interactions. No scoring, no timer, endless session. Two variants:
//
//   sandbox-doll : a stationary TRAINING DOLL that takes hits, ragdolls,
//                  respawns fast at its post and slowly walks back if
//                  knocked away — repeatable, consistent interaction tests.
//   sandbox-duel : a LIVE FIGHTER bot that actually fights (punches, bombs,
//                  the occasional grab-and-throw, jump punches) — playtest
//                  combat under pressure.
//
// Both variants place two neutral PRACTICE FLAGS on stands: anyone can
// grab, carry, throw, punch or kick them; untouched flags return to their
// stand after idleReturn. All the CTF flag physics, none of the rules.
//
// The lab overrides a few config values (fast respawn, minimal spawn
// protection, endless round) via makeLabConfig() so tests iterate quickly.

import { emit } from '../sim.js';
import { integrateBody, collideBodies, blastKick, applyImpulse, invMass } from '../physics.js';
import { CONFIG } from '../../core/config.js';
import { clamp, norm2 } from '../../core/math.js';

const ZERO = { mx: 0, mz: 0, ax: 0, az: 0, ad: 7, run: 1, throw: false, grab: false, punch: false, jump: false, dash: false };

export function makeLabConfig() {
  const c = structuredClone(CONFIG);
  c.rules.roundTime = 36000; // endless (the HUD shows "LAB")
  c.rules.countdown = 1;
  c.player.respawnTime = 1.5; // fast iteration
  c.player.invulnTime = 0.5; // hits register almost immediately after reset
  c.flag.idleReturn = 12; // practice flags tidy themselves up sooner
  return c;
}

const mkFlag = (team, pos) => ({
  team, st: 'home',
  x: pos.x, z: pos.z, y: 0, vx: 0, vz: 0, vy: 0,
  carrier: null, idle: 0, cd: 0, pcd: 0,
});

const getP = (sim, id) => sim.state.players.find((p) => p.id === id);

// ---------------------------------------------------------------- brains

// Training doll: stands at its post; if physics carried it away, it calmly
// walks back so the next test starts from the same spot.
function createDollBrain(id) {
  return {
    id,
    post: null,
    think(sim) {
      const me = getP(sim, this.id);
      if (!me || me.state !== 'alive' || sim.state.phase !== 'play') return ZERO;
      if (!this.post) this.post = { x: me.x, z: me.z }; // first spawn = post
      const d = Math.hypot(this.post.x - me.x, this.post.z - me.z);
      if (d > 1.2) {
        const dir = norm2(this.post.x - me.x, this.post.z - me.z);
        return { ...ZERO, mx: dir.x * 0.5, mz: dir.z * 0.5 }; // deliberate walk
      }
      return ZERO;
    },
  };
}

// Live fighter: pure combat pressure — approach/strafe, predictive bombs at
// range, momentum punches up close, occasional jump-punch and grab+throw.
function createFighterBrain(id, rng = Math.random) {
  return {
    id,
    strafe: rng() < 0.5 ? -1 : 1,
    bombCool: 2 + rng() * 2,
    grabCool: 5 + rng() * 4,
    jumpCool: 3 + rng() * 3,
    holdT: 0,

    think(sim, dt) {
      const me = getP(sim, this.id);
      if (!me || me.state !== 'alive' || sim.state.phase !== 'play') return ZERO;
      this.bombCool = Math.max(0, this.bombCool - dt);
      this.grabCool = Math.max(0, this.grabCool - dt);
      this.jumpCool = Math.max(0, this.jumpCool - dt);

      const target = sim.state.players.find((p) => p.team !== me.team && p.state === 'alive');
      if (!target) return ZERO;
      const dx = target.x - me.x;
      const dz = target.z - me.z;
      const d = Math.hypot(dx, dz);
      let to = norm2(dx, dz);

      // seek nearby powerup boxes (especially bombs) when not holding one
      const boxes = sim.state.powerups ?? [];
      let boxTarget = null;
      if (!me.heldBomb && boxes.length) {
        let bestDist = 10;
        for (const box of boxes) {
          if (box.kind === 'curse') continue;
          const bd = Math.hypot(box.x - me.x, box.z - me.z);
          if (bd < bestDist) {
            bestDist = bd;
            boxTarget = box;
          }
        }
      }
      if (boxTarget && (this.bombCool <= 0 || d > 3.5)) {
        to = norm2(boxTarget.x - me.x, boxTarget.z - me.z);
      }

      // holding someone: carry them a beat, then hurl them (toward the
      // open east rim if we're facing it — hazard throws are the point)
      if (me.heldPlayer) {
        this.holdT += dt;
        const input = { ...ZERO, mx: to.x * 0.6, mz: to.z * 0.6 };
        if (this.holdT > 0.7) {
          this.holdT = 0;
          return { ...input, ax: Math.sin(me.face), az: Math.cos(me.face), ad: 9, throw: true };
        }
        return input;
      }
      this.holdT = 0;

      // holding a lit bomb: cook it briefly, then hurl it at the target
      // (or panic-throw the instant the fuse runs short)
      if (me.heldBomb) {
        const bomb = sim.state.bombs.find((b) => b.id === me.heldBomb);
        const fuse = bomb ? bomb.fuse : 0;
        const input = { ...ZERO, mx: to.x, mz: to.z };
        if (fuse < 2.4 || d < 3.5) {
          const leadT = Math.max(0.3, fuse - 0.4);
          const hw2 = sim.level.bounds.w / 2 - 1.3;
          const hd2 = sim.level.bounds.d / 2 - 1.3;
          const px = clamp(target.x + target.vx * leadT, -hw2, hw2);
          const pz = clamp(target.z + target.vz * leadT, -hd2, hd2);
          const a = Math.atan2(px - me.x, pz - me.z) + (rng() * 2 - 1) * 0.1;
          input.ax = Math.sin(a);
          input.az = Math.cos(a);
          input.ad = Math.hypot(px - me.x, pz - me.z);
          input.throw = true;
          this.bombCool = 3 + rng() * 3;
        }
        return input;
      }

      // steering: close in at range, circle at punch range
      let mx, mz;
      if (d > 2.4) {
        mx = to.x; mz = to.z;
      } else {
        mx = to.x * 0.25 - to.z * this.strafe;
        mz = to.z * 0.25 + to.x * this.strafe;
        if (rng() < 0.005) this.strafe *= -1;
      }
      // dodge lit bombs (imperfectly, same as match bots)
      for (const b of sim.state.bombs) {
        if (b.holder || b.fuse > 0.6) continue;
        const bx = me.x - b.x;
        const bz = me.z - b.z;
        const bd = Math.hypot(bx, bz);
        if (bd < sim.config.bomb.blastRadius && bd > 0.01) {
          mx += (bx / bd) * 2.2;
          mz += (bz / bd) * 2.2;
        }
      }
      const hw = sim.level.bounds.w / 2 - 1.3;
      const hd = sim.level.bounds.d / 2 - 1.3;
      const ahead = { x: clamp(me.x + mx * 2, -hw, hw), z: clamp(me.z + mz * 2, -hd, hd) };
      const dir = norm2(ahead.x - me.x, ahead.z - me.z);
      const input = { ...ZERO, mx: dir.x, mz: dir.z };

      // jump-punch approach
      if (this.jumpCool <= 0 && d < 4.2 && d > 2.2) {
        input.jump = true;
        this.jumpCool = 3 + rng() * 4;
      }
      // punch in fist range (also mid-air = jump punch)
      if (me.punchCd <= 0 && d < 1.6) {
        input.ax = to.x; input.az = to.z;
        input.punch = true;
        return input;
      }
      // occasional grab (tests grabs under combat pressure)
      if (this.grabCool <= 0 && d < 1.35) {
        input.grab = true;
        this.grabCool = 6 + rng() * 5;
        return input;
      }
      // dash to close in when chasing target
      if (me.dashCd <= 0 && d > 3.5 && d < 9 && rng() < 0.12) {
        input.dash = true;
      }
      return input;
    },
  };
}

// ------------------------------------------------------------------ mode

function makeSandbox(variant) {
  return {
    id: `sandbox-${variant}`,
    name: variant === 'doll' ? 'Physics Lab — Training Doll' : 'Physics Lab — Live Bot',
    variant,

    init(sim) {
      sim.state.lab = { variant };
      sim.state.flags = {
        red: mkFlag('red', sim.level.flags.red),
        blue: mkFlag('blue', sim.level.flags.blue),
      };
    },

    createBrain(id) {
      return variant === 'doll' ? createDollBrain(id) : createFighterBrain(id);
    },

    tick(sim, dt) {
      for (const f of Object.values(sim.state.flags)) this.tickFlag(sim, f, dt);
    },

    // practice flags: full physics, neutral ownership, tidy-up idle return
    tickFlag(sim, f, dt) {
      const cfg = sim.config.flag;
      f.cd = Math.max(0, f.cd - dt);

      if (f.st === 'carry') {
        const c = getP(sim, f.carrier);
        if (!c || c.state !== 'alive' || c.carryFlag !== f.team) {
          this.dropCarried(sim, c ?? f, 0, 0, f);
          return;
        }
        f.x = c.x; f.z = c.z; f.y = c.y;
        f.vx = c.vx; f.vz = c.vz; f.vy = 0;
        return;
      }

      integrateBody(sim.level, sim.world, f, sim.mats.flag, dt);
      if (f.st === 'drop') {
        // kickable while loose
        for (const p of sim.state.players) {
          if (p.state !== 'alive') continue;
          collideBodies(f, sim.mats.flag, p, sim.mats.player, { e: 0.2 });
        }
        f.idle += dt;
        if (f.idle >= cfg.idleReturn) this.returnFlag(sim, f, true);
      } else {
        const stand = sim.level.flags[f.team];
        if (Math.hypot(f.x - stand.x, f.z - stand.z) > cfg.homeDrift) {
          f.st = 'drop';
          f.idle = 0;
          emit(sim, { t: 'flagDrop', team: f.team, x: f.x, z: f.z });
        }
      }
      if (f.y < sim.config.world.fallY) {
        this.returnFlag(sim, f, true);
        emit(sim, { t: 'flagVoid', team: f.team });
      }
    },

    // anyone may grab either practice flag
    tryGrab(sim, p) {
      let best = null;
      let bd = sim.config.flag.grabRange;
      for (const f of Object.values(sim.state.flags)) {
        if (f.st === 'carry' || f.cd > 0) continue;
        const d = Math.hypot(p.x - f.x, p.z - f.z);
        if (d < bd) { bd = d; best = f; }
      }
      if (!best) return false;
      best.st = 'carry';
      best.carrier = p.id;
      best.idle = 0;
      p.carryFlag = best.team;
      emit(sim, { t: 'flagSteal', id: p.id, name: p.name, team: best.team, byTeam: p.team });
      return true;
    },

    dropCarried(sim, p, vx, vz, flagOverride) {
      const f = flagOverride ?? (p.carryFlag ? sim.state.flags[p.carryFlag] : null);
      if (!f) return;
      if (p.carryFlag !== undefined) p.carryFlag = null;
      f.st = 'drop';
      f.carrier = null;
      f.x = p.x ?? f.x;
      f.z = p.z ?? f.z;
      f.y = Math.max(p.y ?? 0, 0.05);
      f.vx = vx; f.vz = vz; f.vy = 1.5;
      f.idle = 0;
      f.cd = sim.config.flag.dropLockout;
      emit(sim, { t: 'flagDrop', team: f.team, x: f.x, z: f.z });
    },

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

    returnFlag(sim, f, announce) {
      const stand = sim.level.flags[f.team];
      f.st = 'home';
      f.carrier = null;
      f.x = stand.x; f.z = stand.z; f.y = 0;
      f.vx = 0; f.vz = 0; f.vy = 0;
      f.idle = 0; f.cd = 0;
      if (announce) emit(sim, { t: 'flagReturn', team: f.team });
    },

    onKO() { /* drop handled via breakGrabs -> dropCarried */ },

    // flags are completely unaffected by bomb explosions (neither home nor dropped flags move)
    onExplosion(sim, x, z, radius) {
      // Flags are immune to bomb explosions
    },

    // flags are completely unaffected by punches (punches do not impart impulse)
    onPunchObject(sim, fx, fz, radius, dir, vFist, invFist) {
      // Flags are immune to punches
    },

    // lab panel's "reset scene": bombs gone, flags home, bots back at their
    // posts with full hp. The human keeps their position but every carried
    // object / grab constraint is released (bombs and flags were just
    // recalled — no dangling references).
    resetScene(sim) {
      sim.state.bombs = [];
      sim.state.powerups = [];
      sim.state.puPend = [];
      for (const p of sim.state.players) {
        p.carryFlag = null; p.heldBomb = null; p.heldPlayer = null; p.heldBy = null;
        p.shieldHp = 0; p.glovesT = 0; p.frozenT = 0; p.curseT = 0;
        p.mines = 0; p.bombKind = 'normal'; p.bombKindT = 0;
        p.bombCount = sim.config.bomb.perPlayer; p.tripleT = 0;
        if (!p.bot) continue;
        const s = sim.level.spawns[p.team][0];
        p.x = s.x; p.z = s.z; p.y = 0;
        p.vx = 0; p.vz = 0; p.vy = 0;
        p.hp = sim.config.player.hp;
        p.state = 'alive';
        p.knockT = 0;
        p.gearSpd = 0;
      }
      for (const f of Object.values(sim.state.flags)) this.returnFlag(sim, f, false);
      emit(sim, { t: 'labReset' });
    },
  };
}

export const SandboxDuel = makeSandbox('duel');
export const SandboxDoll = makeSandbox('doll');
