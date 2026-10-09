// Bot AI for two-flag CTF. Bots consume the exact same input shape as
// humans — the sim can't tell them apart. Objectives, in priority order:
//   carrying the enemy flag -> run it home (loiter there if we can't score
//   because our own flag is out)
//   our flag is being carried -> hunt the thief
//   our flag is dropped -> nearest teammate goes to touch-return it
//   otherwise -> nearest teammate to the enemy flag goes stealing, the
//   rest brawl (bombs at range, punches up close)

import { clamp, norm2 } from '../core/math.js';
import { otherTeam } from '../core/config.js';
import { steerBot } from './botNavigation.js';

const ZERO = { mx: 0, mz: 0, ax: 0, az: 0, ad: 7, run: 1, throw: false, grab: false, punch: false, jump: false };

const nearest = (list, to) => {
  let best = null;
  let bd = Infinity;
  for (const p of list) {
    const d = Math.hypot(p.x - to.x, p.z - to.z);
    if (d < bd) { bd = d; best = p; }
  }
  return best;
};

export function createBotBrain(id, rng = Math.random) {
  return {
    id,
    aimErr: 0.08 + rng() * 0.14,
    aggro: 0.6 + rng() * 0.5,
    strafe: rng() < 0.5 ? -1 : 1,
    cool: 1 + rng() * 2,
    lane: Math.floor(rng() * 3),

    think(sim, dt) {
      const s = sim.state;
      const me = s.players.find((p) => p.id === this.id);
      if (!me || me.state !== 'alive' || s.phase !== 'play') return ZERO;
      this.cool = Math.max(0, this.cool - dt);

      const enemies = s.players.filter((p) => p.team !== me.team && p.state === 'alive');
      const mates = s.players.filter((p) => p.team === me.team && p.state === 'alive');
      const myFlag = s.flags[me.team];
      const enemyFlag = s.flags[otherTeam(me.team)];
      const myBase = sim.level.bases[me.team];

      // --- objective selection
      let target = null;
      let throwAt = null;
      let wantGrabFlag = false;
      let brawling = false;
      if (me.carryFlag) {
        target = myBase; // run it home (and hold there if our flag is out)
      } else if (myFlag.st === 'carry') {
        const thief = s.players.find((p) => p.id === myFlag.carrier);
        target = thief ?? myFlag;
        throwAt = thief;
      } else if (myFlag.st === 'drop' && nearest(mates, myFlag) === me) {
        target = myFlag; // touch it to return it
      } else if (enemyFlag.st !== 'carry' && nearest(mates, enemyFlag) === me) {
        target = enemyFlag; // go steal
        wantGrabFlag = true;
      } else if (enemyFlag.st === 'carry') {
        // escort our carrier by harassing whoever is closest to them
        const carrier = s.players.find((p) => p.id === enemyFlag.carrier);
        const e = carrier ? nearest(enemies, carrier) : nearest(enemies, me);
        target = e ?? myBase;
        throwAt = e;
      } else {
        const e = nearest(enemies, me);
        target = e ?? myBase;
        throwAt = e;
        brawling = true;
      }
      if (!throwAt) {
        const e = nearest(enemies, me);
        if (e && Math.hypot(e.x - me.x, e.z - me.z) < 10.5) throwAt = e;
      }

      // --- powerups: a cursed bot sprints for a med-pack (the only cure),
      // a hurt one detours for a close med-pack, and a brawler snags any
      // nearby box — except the curse, which bots know better than to touch
      const boxes = s.powerups ?? [];
      if (!me.carryFlag && boxes.length) {
        const health = nearest(boxes.filter((u) => u.kind === 'health'), me);
        if (me.curseT > 0 && health) {
          target = health;
          throwAt = null;
          wantGrabFlag = false;
        } else if (me.hp < 45 && health && Math.hypot(health.x - me.x, health.z - me.z) < 14) {
          target = health;
        } else if (brawling) {
          const grab = nearest(boxes.filter((u) => u.kind !== 'curse'), me);
          if (grab && Math.hypot(grab.x - me.x, grab.z - me.z) < 8) target = grab;
        }
      }

      // --- steering
      let steerTarget = target;
      if (sim.level.botRoutes?.length && Math.hypot(target.x - me.x, target.z - me.z) > 8) {
        const route = sim.level.botRoutes[this.lane % sim.level.botRoutes.length];
        const forward = target.x >= me.x;
        const candidates = forward ? route : [...route].reverse();
        steerTarget = candidates.find((point) => forward ? point.x > me.x + 2.5 : point.x < me.x - 2.5) ?? target;
      }
      let dir = norm2(steerTarget.x - me.x, steerTarget.z - me.z);
      // flinch away from bombs about to pop — deliberately late/imperfect,
      // a bot that always escapes the blast radius is no fun to fight.
      // Armed land mines get a permanent wide berth instead.
      const kinds = sim.config.bomb.kinds;
      for (const b of s.bombs) {
        if (b.holder || b.stuckTo) continue;
        const mine = b.kind === 'mine';
        if (mine ? b.arm > 0 : (b.fuse == null || b.fuse > 0.6)) continue;
        const dx = me.x - b.x;
        const dz = me.z - b.z;
        const d = Math.hypot(dx, dz);
        const r = (kinds[b.kind]?.radius ?? sim.config.bomb.blastRadius) + (mine ? 0.6 : 0);
        if (d < r && d > 0.01) {
          dir.x += (dx / d) * 2.2;
          dir.z += (dz / d) * 2.2;
        }
      }
      dir = norm2(dir.x, dir.z);
      dir = steerBot(sim, me, steerTarget, this, dt, dir);
      // never charge off the rim
      const hw = sim.level.bounds.w / 2 - 1.3;
      const hd = sim.level.bounds.d / 2 - 1.3;
      const ahead = { x: clamp(me.x + dir.x * 2, -hw, hw), z: clamp(me.z + dir.z * 2, -hd, hd) };
      dir = norm2(ahead.x - me.x, ahead.z - me.z);

      const input = { mx: dir.x, mz: dir.z, ax: 0, az: 0, ad: 7, run: 1, throw: false, grab: false, punch: false, jump: false, dash: false };

      // --- holding a lit bomb: cook it a beat, then throw at the target's
      // predicted position — and panic-throw the moment the fuse runs short
      if (me.heldBomb) {
        const bomb = s.bombs.find((b) => b.id === me.heldBomb);
        const fuse = bomb ? bomb.fuse : 0;
        const at = throwAt ?? nearest(enemies, me);
        const dd = at ? Math.hypot(at.x - me.x, at.z - me.z) : 99;
        if (bomb?.kind === 'impact' || fuse < 2.5 || dd < 4 || !at) {
          const leadT = bomb?.kind === 'impact' ? 0.45 : Math.max(0.3, fuse - 0.4);
          const px = clamp((at?.x ?? me.x + dir.x * 8) + (at?.vx || 0) * leadT, -hw, hw);
          const pz = clamp((at?.z ?? me.z + dir.z * 8) + (at?.vz || 0) * leadT, -hd, hd);
          const a = Math.atan2(px - me.x, pz - me.z) + (rng() * 2 - 1) * this.aimErr;
          input.ax = Math.sin(a);
          input.az = Math.cos(a);
          input.ad = Math.hypot(px - me.x, pz - me.z);
          input.throw = true;
          this.cool = 0.8 + (rng() * 1.6) / this.aggro;
        }
        return input; // no punching/grabbing with a bomb overhead
      }

      if (!me.carryFlag && !me.heldPlayer && this.cool <= 0 && ((me.bombAmmo || 0) > 0 || me.mines > 0)) {
        input.throw = true;
      }

      // --- melee: momentum punch when an enemy is in fist range
      // (BombSquad: no swinging while carrying anything)
      if (me.punchCd <= 0 && !me.carryFlag && !me.heldPlayer) {
        const e = nearest(enemies, me);
        if (e && Math.hypot(e.x - me.x, e.z - me.z) < 1.55) {
          const a = norm2(e.x - me.x, e.z - me.z);
          input.ax = a.x;
          input.az = a.z;
          input.punch = true;
        }
      }

      // occasional dash to close distance or escape
      if (me.dashCd <= 0 && (input.punch || (throwAt && Math.hypot(throwAt.x - me.x, throwAt.z - me.z) > 4 && rng() < 0.15))) {
        input.dash = true;
      }

      // steal needs a deliberate grab near the enemy flag
      if (wantGrabFlag && Math.hypot(enemyFlag.x - me.x, enemyFlag.z - me.z) < 1.4) {
        input.grab = true;
      }
      return input;
    },
  };
}
