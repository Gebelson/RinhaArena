// Death Match — no flags, no objectives beyond frags. Two teams (red vs
// blue), kills score a point for the KILLER'S team (BombSquad credits the
// killer's team even in the rare friendly-fire case; an unattributed death —
// suicide, a fall into the void — hands the point to the OTHER team). First
// team to killsToWin * (largest team size) wins.
//
// A mode is a plain object of hooks the sim calls (see sim.js header). All
// mode state lives inside sim.state; Death Match doesn't need any beyond the
// scores the sim already tracks, so there's nothing here to serialize.

import { emit, endRound } from '../sim.js';
import { otherTeam } from '../../core/config.js';
import { clamp, norm2, circlePushOut } from '../../core/math.js';

const getP = (sim, id) => sim.state.players.find((p) => p.id === id);

const ZERO = { mx: 0, mz: 0, ax: 0, az: 0, ad: 7, run: 1, throw: false, grab: false, punch: false, jump: false, dash: false };

// Unlike the Physics Lab (an obstacle-free room), Death Match plays out on
// the real arena levels — crates, walls, pillars. A pure "walk straight at
// the target" steer gets bots stuck against that geometry forever, so route
// around it exactly like bots.js's match brain does.
function blockedAhead(level, me, dir, probe) {
  const px = me.x + dir.x * probe;
  const pz = me.z + dir.z * probe;
  for (const box of level.solids) {
    if (box.h < 0.5) continue;
    if (circlePushOut(px, pz, 0.72, box)) return true;
  }
  return false;
}

const rot = (d, a) => {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return { x: d.x * c - d.z * s, z: d.x * s + d.z * c };
};

// Combat bot brain — adapted from sandbox.js's createFighterBrain (approach
// + strafe, two-stage bombing, momentum punches, bomb-dodging) but targeting
// whichever living enemy is CLOSEST rather than a single fixed opponent
// (Death Match teams can be bigger than one), and never touching
// sim.state.flags (it's null here).
function createDeathMatchBrain(id, rng = Math.random) {
  return {
    id,
    strafe: rng() < 0.5 ? -1 : 1,
    bombCool: 2 + rng() * 2,

    think(sim, dt) {
      const me = getP(sim, this.id);
      if (!me || me.state !== 'alive' || sim.state.phase !== 'play') return ZERO;
      this.bombCool = Math.max(0, this.bombCool - dt);

      // nearest living enemy
      let target = null;
      let d = Infinity;
      for (const p of sim.state.players) {
        if (p.team === me.team || p.state !== 'alive') continue;
        const dd = Math.hypot(p.x - me.x, p.z - me.z);
        if (dd < d) { d = dd; target = p; }
      }
      if (!target) return ZERO;
      let to = norm2(target.x - me.x, target.z - me.z);

      // seek nearby powerups / bomb boxes
      const boxes = sim.state.powerups ?? [];
      let boxTarget = null;
      if (!me.heldBomb && boxes.length) {
        let bestDist = 12;
        for (const box of boxes) {
          if (box.kind === 'curse') continue;
          const bd = Math.hypot(box.x - me.x, box.z - me.z);
          if (bd < bestDist) {
            bestDist = bd;
            boxTarget = box;
          }
        }
      }
      let steerTo = to;
      if (boxTarget && (d > 4 || this.bombCool <= 0)) {
        steerTo = norm2(boxTarget.x - me.x, boxTarget.z - me.z);
      }
      if (sim.level.id === 'foundry' && Math.abs(me.x) > 13.5 && Math.abs(me.z) > 1.2) {
        steerTo = norm2((me.x > 0 ? 12 : -12) - me.x, 0 - me.z);
      }

      // holding a lit bomb: cook it briefly, then hurl it at the target's
      // predicted position — panic-throw the instant the fuse runs short or
      // they're right on top of us
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
          this.bombCool = 2 + rng() * 3;
        }
        return input;
      }

      // steering: close in aggressively, attack in punch range
      let mx, mz;
      if (d > 1.3) {
        mx = steerTo.x; mz = steerTo.z;
      } else {
        mx = to.x * 0.7 - to.z * this.strafe * 0.4;
        mz = to.z * 0.7 + to.x * this.strafe * 0.4;
        if (rng() < 0.02) this.strafe *= -1;
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
      let dir = norm2(mx, mz);
      // route around crates/walls instead of walking straight into them
      if (blockedAhead(sim.level, me, dir, 1.7)) {
        let side = rot(dir, this.strafe * 0.95);
        if (blockedAhead(sim.level, me, side, 1.7)) {
          this.strafe *= -1;
          side = rot(dir, this.strafe * 0.95);
        }
        dir = side;
      }
      const hw = sim.level.bounds.w / 2 - 1.3;
      const hd = sim.level.bounds.d / 2 - 1.3;
      const ahead = { x: clamp(me.x + dir.x * 2, -hw, hw), z: clamp(me.z + dir.z * 2, -hd, hd) };
      dir = norm2(ahead.x - me.x, ahead.z - me.z);
      const input = { ...ZERO, mx: dir.x, mz: dir.z };

      // jump approach
      if (d < 3.5 && d > 1.8 && rng() < 0.05) {
        input.jump = true;
      }

      // punch in fist range
      if (me.punchCd <= 0 && d < 1.75 && !me.carryFlag && !me.heldPlayer && !me.heldBomb) {
        input.ax = to.x; input.az = to.z;
        input.punch = true;
        return input;
      }

      // dash to close in when attacking
      if (me.dashCd <= 0 && d > 2.0 && d < 9 && rng() < 0.2) {
        input.dash = true;
      }
      return input;
    },
  };
}

export const DeathMatchMode = {
  id: 'deathmatch',
  name: 'Death Match',

  init(sim) {
    sim.state.flags = null; // no flags in Death Match
  },

  tick(sim, dt) {},

  createBrain(id) {
    return createDeathMatchBrain(id);
  },

  // Award the kill: credited to the killer's team (even friendly fire), or
  // to the OTHER team if the death is unattributed (self-elimination / void
  // fall). Then check for a round win.
  onKO(sim, victim) {
    const s = sim.state;
    const killer = victim.lastHitBy ? getP(sim, victim.lastHitBy) : null;
    const scoringTeam = killer ? killer.team : otherTeam(victim.team);
    s.scores[scoringTeam]++;
    emit(sim, {
      t: 'frag',
      killer: killer ? killer.id : null,
      killerName: killer ? killer.name : null,
      killerTeam: killer ? killer.team : null,
      victim: victim.id,
      victimName: victim.name,
      victimTeam: victim.team,
      cause: null,
    });

    if (s.phase !== 'play') return;
    let redCount = 0;
    let blueCount = 0;
    for (const p of s.players) {
      if (p.team === 'red') redCount++;
      else if (p.team === 'blue') blueCount++;
    }
    const maxTeamSize = Math.max(redCount, blueCount);
    const threshold = sim.config.rules.killsToWin * maxTeamSize;
    if (s.scores[scoringTeam] >= threshold) {
      endRound(sim, scoringTeam);
    }
  },
};
