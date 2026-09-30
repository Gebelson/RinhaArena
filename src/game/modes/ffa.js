// Free-For-All (Todos contra Todos) — No teams, every player for themselves!
// First to killsToWin (default 10) frags wins the match, or highest frags when round ends.

import { emit, endRound } from '../sim.js';
import { clamp, norm2, circlePushOut } from '../../core/math.js';

const getP = (sim, id) => sim.state.players.find((p) => p.id === id);

const ZERO = { mx: 0, mz: 0, ax: 0, az: 0, ad: 7, run: 1, throw: false, grab: false, punch: false, jump: false, dash: false };

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

function createFfaBrain(id, rng = Math.random) {
  return {
    id,
    strafe: rng() < 0.5 ? -1 : 1,
    bombCool: 1.5 + rng() * 2,

    think(sim, dt) {
      const me = getP(sim, this.id);
      if (!me || me.state !== 'alive' || sim.state.phase !== 'play') return ZERO;
      this.bombCool = Math.max(0, this.bombCool - dt);

      // Find nearest living opponent (everyone else is an enemy!)
      let target = null;
      let d = Infinity;
      for (const p of sim.state.players) {
        if (p.id === me.id || p.state !== 'alive') continue;
        const dd = Math.hypot(p.x - me.x, p.z - me.z);
        if (dd < d) { d = dd; target = p; }
      }
      if (!target) return ZERO;
      let to = norm2(target.x - me.x, target.z - me.z);

      // Seek nearby powerups / bomb boxes
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

      // Holding a lit bomb: cook and throw at predicted target pos
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
          input.ax = px - me.x;
          input.az = pz - me.z;
          input.ad = Math.hypot(input.ax, input.az);
          input.punch = true; // LMB throws held bomb!
          this.bombCool = 1.8 + rng() * 1.5;
        }
        return input;
      }

      // Evade dangerous bombs near feet
      let evade = null;
      for (const b of sim.state.bombs) {
        if (b.holder === me.id) continue;
        const bd = Math.hypot(b.x - me.x, b.z - me.z);
        if (bd < 3.2 && (b.fuse == null || b.fuse < 1.2)) {
          const away = norm2(me.x - b.x, me.z - b.z);
          evade = away;
          break;
        }
      }

      let moveDir = evade ?? steerTo;
      if (!evade && d < 3.8 && !boxTarget) {
        // Circle / strafe target
        const sDir = rot(to, (Math.PI / 2) * this.strafe);
        moveDir = {
          x: to.x * 0.35 + sDir.x * 0.65,
          z: to.z * 0.35 + sDir.z * 0.65,
        };
      }

      // Obstacle avoidance
      if (blockedAhead(sim.level, me, moveDir, 1.8)) {
        let side = rot(moveDir, this.strafe * 1.1);
        if (blockedAhead(sim.level, me, side, 1.8)) {
          this.strafe *= -1;
          side = rot(moveDir, this.strafe * 1.1);
        }
        moveDir = side;
      }

      // Don't charge off the ledge
      const rimProbe = 1.9;
      const testX = me.x + moveDir.x * rimProbe;
      const testZ = me.z + moveDir.z * rimProbe;
      const hw = sim.level.bounds.w / 2 - 0.7;
      const hd = sim.level.bounds.d / 2 - 0.7;
      if (Math.abs(testX) > hw || Math.abs(testZ) > hd) {
        moveDir = norm2(0 - me.x, 0 - me.z);
      }

      const input = {
        ...ZERO,
        mx: moveDir.x,
        mz: moveDir.z,
      };

      // In punch range
      if (me.punchCd <= 0 && d < 1.75 && !me.heldBomb && !me.heldPlayer) {
        input.ax = to.x; input.az = to.z;
        input.punch = true;
        return input;
      }

      // Dash to close in or escape
      if (me.dashCd <= 0 && d > 2.5 && d < 8.5 && rng() < 0.25) {
        input.dash = true;
      }

      return input;
    },
  };
}

export const FfaMode = {
  id: 'ffa',
  name: 'Todos contra Todos',

  init(sim) {
    sim.state.flags = null; // No flags in FFA
    sim.state.ffaScores = {};
    for (const p of sim.state.players) {
      sim.state.ffaScores[p.id] = 0;
    }
  },

  tick(sim, dt) {},

  createBrain(id) {
    return createFfaBrain(id);
  },

  onKO(sim, victim) {
    const s = sim.state;
    s.ffaScores = s.ffaScores || {};
    const killer = victim.lastHitBy ? getP(sim, victim.lastHitBy) : null;
    if (killer && killer.id !== victim.id) {
      s.ffaScores[killer.id] = (s.ffaScores[killer.id] || 0) + 1;
    }

    emit(sim, {
      t: 'frag',
      killer: killer ? killer.id : null,
      killerName: killer ? killer.name : null,
      killerTeam: killer ? killer.team : null,
      victim: victim.id,
      victimName: victim.name,
      victimTeam: victim.team,
      cause: null,
      ffaScores: s.ffaScores,
    });

    if (s.phase !== 'play') return;
    const threshold = sim.config.rules.ffaKillsToWin ?? 10;
    if (killer && s.ffaScores[killer.id] >= threshold) {
      endRound(sim, killer.id);
    }
  },
};
