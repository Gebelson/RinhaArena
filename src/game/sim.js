// The authoritative game simulation. Pure JS, fixed-timestep, no DOM and no
// three.js — the browser runs it directly for solo play and the Node server
// runs the identical code for online play. All gameplay randomness lives
// here (never in the renderer).
//
// The mechanics mirror BombSquad's open-source engine (see
// docs/bombsquad-parity.md for the value-by-value derivation):
//   - roller-ball locomotion: walk, then a run "gear" that winds up with
//     speed; no steering mid-air; gentle skid stops
//   - punches ride body momentum: standing jabs tickle, sprint punches take
//     ~40% and knock people out cold
//   - a single hard hit = KNOCKOUT (unconscious ragdoll, wakes with hp)
//   - ANY damage drops whatever you're holding
//   - the bomb button pulls out a LIT bomb held overhead (fuse burns in
//     hand); pressing again throws it — running throws go far
//   - blasts kick every body equally (mass-normalized) and pop them upward
//   - impact damage: wall slams, hard landings, flying-body collisions
//   - powerup boxes drop on level spawn points every 8s: boxing gloves,
//     shields, triple/ice/impact/sticky bombs, land mines, med-packs and
//     the curse (see config.powerups + docs/bombsquad-parity.md)
//
// State shape (everything JSON-serializable — this IS the network snapshot):
//   players[]: { id, name, team, bot, cos, x, z, y, vx, vz, vy, face, hp,
//                state('alive'|'ko'), respawn, invuln, knockT,
//                carryFlag('red'|'blue'|null), heldBomb, heldPlayer, heldBy,
//                heldT, throwT, punchCd, punchT, jumpCd, impactCd, gearSpd,
//                koT, hurtT, spd,
//                shieldHp, glovesT, frozenT, curseT, mines, bombKind,
//                bombKindT, bombCount, tripleT }
//   bombs[]:   { id, kind, x, z, y, vx, vz, vy, fuse(null=mine), arm,
//                holder, owner, stuckTo }
//   powerups[]: { id, kind, x, z, y, vx, vz, vy, life }  (+ puWave/puPend
//                spawner state)
//   flags:     owned by the active mode (see modes/ctf.js)
//
// Game modes plug in via an object with hooks:
//   { id, init(sim), tick(sim, dt), onKO(sim, p),
//     tryGrab?(sim, p) -> bool          — grab button, before bombs/players
//     dropCarried?(sim, p, vx, vz)      — carrier lost their flag
//     throwCarried?(sim, p, dir, vel)   — throw with {vx, vz, vy}
//     onExplosion?(sim, x, z, radius)   — push mode objects (flags) around
//     onPunchObject?(sim, x, z, r, dir, vFist, invFist)

import { clamp, norm2, angleLerp } from '../core/math.js';
import {
  integrateBody, collideBodies, applyImpulse, blastKick, invMass,
} from './physics.js';

const HIT_CREDIT = 5; // seconds a recent attacker stays eligible for the kill credit

const EMPTY_INPUT = { mx: 0, mz: 0, ax: 0, az: 0, ad: 7, run: 0, throw: false, grab: false, punch: false, jump: false, dash: false };

export function createSim({ level, mode, config }) {
  const sim = {
    level,
    mode,
    config,
    // physics world params + materials, precomputed for the hot path
    world: {
      gravity: config.world.gravity,
      maxSpeed: config.physics.maxSpeed,
      sleepSpeed: config.physics.sleepSpeed,
    },
    mats: config.physics.materials,
    state: {
      tick: 0,
      phase: 'countdown', // countdown -> play -> over -> (auto reset)
      countdown: config.rules.countdown,
      timeLeft: config.rules.roundTime,
      overT: 0,
      scores: { red: 0, blue: 0 },
      modeId: mode.id,
      winner: null,
      players: [],
      bombs: [],
      powerups: [], // live powerup boxes
      puWave: 0, // time until the next spawn wave (first wave drops at once)
      puPend: [], // staggered per-point spawns queued within a wave
      flags: null,
    },
    events: [], // transient per-tick events, drained by the host
    nextId: 1,
    prevIn: new Map(), // last button state per player (edge detection)
    punchHits: new Map(), // per-swing hit sets (one hit per target per swing)
    spawnIdx: { red: 0, blue: 0 },
    lastPowerup: null, // a med-pack always follows a curse box
  };
  mode.init(sim);
  return sim;
}

export const emit = (sim, ev) => sim.events.push(ev);

export const overFloor = (level, x, z) =>
  Math.abs(x) <= level.bounds.w / 2 && Math.abs(z) <= level.bounds.d / 2;

export function addPlayer(sim, { name, team, bot = false, cos }) {
  const id = 'p' + sim.nextId++;
  const p = {
    id, name, team, bot, cos,
    x: 0, z: 0, y: 0, vx: 0, vz: 0, vy: 0,
    face: team === 'red' ? Math.PI / 2 : -Math.PI / 2, // face the enemy base
    hp: sim.config.player.hp,
    state: 'alive', respawn: 0, invuln: sim.config.player.invulnTime,
    knockT: 0,
    lastHitBy: null, lastHitByT: 0,
    carryFlag: null, heldBomb: null, heldPlayer: null, heldBy: null,
    heldT: 9, throwT: 0, punchCd: 0, punchT: 0, punchArm: 0,
    jumpCd: 0, impactCd: 0, gearSpd: 0, koT: 0, hurtT: 0, punchedT: 0, spd: 0,
    dashCd: 0, dashT: 0, dashImpactWindow: 0, blastedT: 0,
    // powerup carry state (everything here is lost on death)
    shieldHp: 0, glovesT: 0, frozenT: 0, curseT: 0, mines: 0,
    bombKind: 'normal', bombKindT: 0,
    bombCount: sim.config.bomb.perPlayer, tripleT: 0,
  };
  placeAtSpawn(sim, p);
  sim.state.players.push(p);
  emit(sim, { t: 'spawn', id, team, x: p.x, z: p.z });
  return id;
}

export function removePlayer(sim, id) {
  const p = sim.state.players.find((p) => p.id === id);
  if (!p) return;
  breakGrabs(sim, p, 0, 0);
  sim.prevIn.delete(id);
  sim.punchHits.delete(id);
  sim.state.players = sim.state.players.filter((p) => p.id !== id);
  emit(sim, { t: 'leave', id, name: p.name });
}

function placeAtSpawn(sim, p) {
  let list = sim.level.spawns?.[p.team];
  if (!list || list.length === 0) {
    const all = [];
    if (sim.level.spawns?.red) all.push(...sim.level.spawns.red);
    if (sim.level.spawns?.blue) all.push(...sim.level.spawns.blue);
    list = all.length > 0 ? all : [{ x: 0, z: 0 }];
  }
  sim.spawnIdx = sim.spawnIdx || {};
  const sKey = p.team || 'all';
  sim.spawnIdx[sKey] = sim.spawnIdx[sKey] || 0;
  const s = list[sim.spawnIdx[sKey]++ % list.length];
  const jitterX = (Math.random() - 0.5) * 0.5;
  const jitterZ = (Math.random() - 0.5) * 0.5;
  p.x = s.x + jitterX; p.z = s.z + jitterZ; p.y = 0;
  p.vx = 0; p.vz = 0; p.vy = 0;
  p.face = p.team === 'red' ? Math.PI / 2 : (p.team === 'blue' ? -Math.PI / 2 : Math.random() * Math.PI * 2);
}

const getP = (sim, id) => sim.state.players.find((p) => p.id === id);

// ---------------------------------------------------------------- main step

export function step(sim, inputs, dt) {
  const s = sim.state;
  s.tick++;

  if (s.phase === 'countdown') {
    const before = Math.ceil(s.countdown);
    s.countdown -= dt;
    const after = Math.ceil(s.countdown);
    if (after !== before && after > 0) emit(sim, { t: 'tick', n: after });
    if (s.countdown <= 0) {
      s.phase = 'play';
      emit(sim, { t: 'go' });
    }
  } else if (s.phase === 'play') {
    s.timeLeft = Math.max(0, s.timeLeft - dt);
    if (s.timeLeft <= 0) {
      if (sim.mode.id === 'ffa') {
        let bestId = 'draw';
        let bestScore = -1;
        for (const [id, score] of Object.entries(s.ffaScores || {})) {
          if (score > bestScore) {
            bestScore = score;
            bestId = id;
          } else if (score === bestScore) {
            bestId = 'draw';
          }
        }
        endRound(sim, bestId);
      } else {
        const { red, blue } = s.scores;
        endRound(sim, red === blue ? 'draw' : red > blue ? 'red' : 'blue');
      }
    }
  } else if (s.phase === 'over') {
    s.overT -= dt;
    if (s.overT <= 0) resetRound(sim);
  }

  const paused = s.phase !== 'play';
  for (const p of s.players) {
    updatePlayer(sim, p, inputs.get(p.id) ?? EMPTY_INPUT, dt, paused);
  }
  applyGrabs(sim, dt);
  playerCollisions(sim, s.players);
  updateBombs(sim, dt);
  updatePowerups(sim, dt);
  sim.mode.tick(sim, dt);
}

// ------------------------------------------------------------------ players

function updatePlayer(sim, p, i, dt, paused) {
  const cfg = sim.config.player;
  p.throwT = Math.max(0, p.throwT - dt);
  p.punchCd = Math.max(0, p.punchCd - dt);
  p.punchT = Math.max(0, p.punchT - dt);
  p.jumpCd = Math.max(0, p.jumpCd - dt);
  p.impactCd = Math.max(0, p.impactCd - dt);
  p.invuln = Math.max(0, p.invuln - dt);
  p.hurtT = Math.max(0, p.hurtT - dt);
  p.punchedT = Math.max(0, (p.punchedT || 0) - dt);
  p.lastHitByT = Math.max(0, p.lastHitByT - dt);
  if (p.lastHitByT <= 0) p.lastHitBy = null;
  p.heldT += dt;
  p.dashCd = Math.max(0, (p.dashCd || 0) - dt);
  p.dashT = Math.max(0, (p.dashT || 0) - dt);
  p.dashImpactWindow = Math.max(0, (p.dashImpactWindow || 0) - dt);
  p.blastedT = Math.max(0, (p.blastedT || 0) - dt);

  // carried powerups wear off (spaz.py POWERUP_WEAR_OFF_TIME, 20s)
  if (p.glovesT > 0) {
    p.glovesT = Math.max(0, p.glovesT - dt);
    if (!p.glovesT) emit(sim, { t: 'wearOff', id: p.id, kind: 'gloves' });
  }
  if (p.bombKindT > 0) {
    p.bombKindT = Math.max(0, p.bombKindT - dt);
    if (!p.bombKindT) {
      emit(sim, { t: 'wearOff', id: p.id, kind: p.bombKind });
      p.bombKind = 'normal';
    }
  }
  if (p.tripleT > 0) {
    p.tripleT = Math.max(0, p.tripleT - dt);
    if (!p.tripleT) {
      p.bombCount = sim.config.bomb.perPlayer;
      emit(sim, { t: 'wearOff', id: p.id, kind: 'triple' });
    }
  }
  if (p.frozenT > 0) {
    p.frozenT = Math.max(0, p.frozenT - dt);
    if (!p.frozenT) emit(sim, { t: 'thaw', id: p.id });
  }
  // the curse: a 5s heartbeat, then you go up in a blast — unless a
  // med-pack saved you first
  if (!paused && p.state === 'alive' && p.curseT > 0) {
    p.curseT = Math.max(0, p.curseT - dt);
    if (!p.curseT) {
      koPlayer(sim, p, 'curse');
      detonate(sim, p.x, p.z, Math.max(0, p.y), 'curse');
      return;
    }
  }

  const onFloor = overFloor(sim.level, p.x, p.z);
  const onGround = onFloor && p.y >= -0.05 && p.y <= 0.05;
  // knockout wears off at full rate on the ground, half rate airborne
  // (BombSquad decrements every 5 steps grounded, 10 airborne)
  p.knockT = Math.max(0, p.knockT - dt * (onGround ? 1 : 0.5));
  if (p.knockT > 0 || p.frozenT > 0) p.punchT = 0; // knockout/freeze cancels a mid-swing punch

  if (p.state === 'ko') {
    p.koT += dt;
    // limp body keeps sliding where the blast sent it; Coulomb ground
    // friction (μ·g) brings it to rest naturally
    integrateBody(sim.level, sim.world, p, sim.mats.player, dt, { wallE: 0 });
    p.spd = 0;
    p.respawn -= dt;
    if (p.respawn <= 0 && sim.state.phase !== 'over') respawnPlayer(sim, p);
    return;
  }

  // (no hp regen — BombSquad damage is permanent until you respawn)

  // --- locomotion: BombSquad's roller-ball model. Stick magnitude walks;
  // the run gear engages as smoothed speed builds (slow spool-up, quick
  // drop), motor force is finite (wide turns at speed), releasing the stick
  // is a gentle braked skid, and mid-air there is NO steering at all.
  const m = norm2(i.mx || 0, i.mz || 0);
  const mlen = Math.min(1, Math.hypot(i.mx || 0, i.mz || 0));
  const run = clamp(i.run ?? 1, 0, 1);

  const spd2 = Math.hypot(p.vx, p.vz);
  const sm = spd2 > p.gearSpd ? cfg.gearUp : cfg.gearDown;
  p.gearSpd = sm * p.gearSpd + (1 - sm) * spd2;
  const gear = Math.min(1, p.gearSpd / cfg.gearSpeed);

  const mutualGrapple = p.heldBy && p.heldPlayer === p.heldBy;
  let ctrl = onGround ? 1 : (onFloor ? cfg.airControl : 0);
  if (p.heldBy && !mutualGrapple) ctrl = 0; // hoisted overhead: a passenger
  if (p.knockT > 0 || p.frozenT > 0 || paused) ctrl = 0; // out cold / frozen solid / round paused

  if (mlen > 0.01 && ctrl > 0 && p.dashT <= 0 && (p.blastedT || 0) <= 0) {
    const target = mlen * (cfg.walkSpeed + gear * run * (cfg.runSpeed - cfg.walkSpeed));
    const a = cfg.accel * ctrl * dt;
    p.vx += clamp(m.x * target - p.vx, -a, a);
    p.vz += clamp(m.z * target - p.vz, -a, a);
  } else if (ctrl > 0 && p.dashT <= 0 && (p.blastedT || 0) <= 0) {
    const a = cfg.brakeDecel * ctrl * dt;
    p.vx += clamp(-p.vx, -a, a);
    p.vz += clamp(-p.vz, -a, a);
  }

  // while control is active, "muscles" own horizontal speed — physics
  // ground friction only takes over when balance is lost (knockout/airborne/blasted)
  const out = integrateBody(sim.level, sim.world, p, sim.mats.player, dt, {
    wallE: 0, // characters don't bounce off walls, they slide along them
    noGroundFriction: ctrl > 0.5 || p.dashT > 0 || (p.blastedT || 0) > 0,
  });

  // impact damage (BombSquad head-jolt model): wall slams and hard landings
  if (p.impactCd <= 0) {
    const icfg = cfg.impact;
    let dmg = 0;
    let isDashWall = false;
    if (out.wallImpact >= icfg.wallMinDv) {
      let wDmg = (out.wallImpact - icfg.wallMinDv) * icfg.dmgPerDv;
      if (p.dashT > 0 || (p.dashImpactWindow || 0) > 0) {
        isDashWall = true;
        p.dashT = 0;
        p.dashImpactWindow = 0;
        wDmg = Math.max(1, Math.min(wDmg, cfg.dashWallMaxDamage ?? 12));
      }
      dmg = Math.max(dmg, wDmg);
    }
    if (out.floorImpact >= icfg.floorMinDv) {
      dmg = Math.max(dmg, (out.floorImpact - icfg.floorMinDv) * icfg.dmgPerDv);
    }
    if (dmg >= 1) impactDamage(sim, p, dmg, isDashWall);
  }
  if (p.state !== 'alive') return; // a lethal impact can end the update here

  if (p.y < sim.config.world.fallY) {
    koPlayer(sim, p, 'fall');
    return;
  }

  // face where you run (throws/punches snap facing to the aim; mobile
  // aim-stick sets i.aiming so you strafe while lining up a shot)
  let fx = 0, fz = 0;
  if (i.aiming && (i.ax || i.az)) { fx = i.ax; fz = i.az; }
  else if (mlen > 0.05) { fx = m.x; fz = m.z; }
  if ((fx || fz) && p.knockT <= 0 && p.frozenT <= 0) p.face = angleLerp(p.face, Math.atan2(fx, fz), Math.min(1, 14 * dt));
  p.spd = Math.hypot(p.vx, p.vz);

  // live fist: the swing is a moving collider that connects mid-arc
  if (p.punchT > 0 && !p.heldBy) resolvePunch(sim, p);

  if (paused) return;

  const prev = sim.prevIn.get(p.id) ?? EMPTY_INPUT;
  const throwEdge = i.throw && !prev.throw;
  const grabEdge = i.grab && !prev.grab;
  const punchEdge = i.punch && !prev.punch;
  const jumpEdge = i.jump && !prev.jump;
  const dashEdge = i.dash && !prev.dash;
  sim.prevIn.set(p.id, { throw: !!i.throw, grab: !!i.grab, punch: !!i.punch, jump: !!i.jump, dash: !!i.dash });

  if (p.knockT > 0 || p.frozenT > 0) return; // out cold / frozen solid: no actions

  if (dashEdge && p.dashCd <= 0 && p.state === 'alive') {
    let ddirX = mlen > 0.05 ? m.x : Math.sin(p.face);
    let ddirZ = mlen > 0.05 ? m.z : Math.cos(p.face);
    const dlen = Math.hypot(ddirX, ddirZ);
    if (dlen > 0.001) {
      ddirX /= dlen;
      ddirZ /= dlen;
    } else {
      ddirX = Math.sin(p.face);
      ddirZ = Math.cos(p.face);
    }
    const dspeed = cfg.dashSpeed ?? 16.5;
    p.vx = ddirX * dspeed;
    p.vz = ddirZ * dspeed;
    p.dashCd = cfg.dashCooldown ?? 1.6;
    p.dashT = cfg.dashDuration ?? 0.18;
    p.dashImpactWindow = 0.35;
    emit(sim, { t: 'dash', id: p.id, x: p.x, z: p.z, dx: ddirX, dz: ddirZ });
  }

  if (jumpEdge && onGround && p.jumpCd <= 0) {
    p.jumpCd = cfg.jumpCooldown;
    p.vy = cfg.jumpVel;
    p.y = 0.02; // leave the floor; momentum is preserved
    emit(sim, { t: 'jump', id: p.id, x: p.x, z: p.z });
  }
  if (punchEdge) doPunch(sim, p, i);
  if (throwEdge) doThrow(sim, p, i);
  if (grabEdge) doGrab(sim, p, i);
}

// Player-vs-player: impulse collisions (equal masses exchange momentum).
// e=0 between bodies that are just bumping; the interesting case is a
// launched body slamming into someone — BombSquad deals IMPACT damage from
// the jolt (and any damage makes both drop whatever they held). Yes, a
// thrown player is a weapon.
function playerCollisions(sim, players) {
  const mat = sim.mats.player;
  const icfg = sim.config.player.impact;
  for (let i = 0; i < players.length; i++) {
    const a = players[i];
    if (a.state !== 'alive') continue;
    for (let k = i + 1; k < players.length; k++) {
      const b = players[k];
      if (b.state !== 'alive') continue;
      // grab pairs are SUPPOSED to be touching
      if (a.heldPlayer === b.id || b.heldPlayer === a.id) continue;
      const j = collideBodies(a, mat, b, mat, { e: 0 });
      if (j <= 0) continue;
      const dv = j * invMass(mat); // per-body velocity jolt

      // If either player was dashing, do NOT stun or inflict body slam damage.
      // Dash is a gap-closer / movement mechanic: body contact should resolve solid physics smoothly
      // without stunning either character or interrupting melee combat.
      const isDashCollision = (a.dashT > 0 || (a.dashImpactWindow || 0) > 0 || b.dashT > 0 || (b.dashImpactWindow || 0) > 0);
      if (isDashCollision) {
        if (a.dashT > 0) { a.dashT = 0; a.dashImpactWindow = 0; }
        if (b.dashT > 0) { b.dashT = 0; b.dashImpactWindow = 0; }
        continue;
      }

      if (dv < icfg.pairMinDv) continue;
      const dmg = (dv - icfg.pairMinDv) * icfg.dmgPerDv;
      if (dmg < 1) continue;
      for (const p of [a, b]) {
        if (p.impactCd <= 0) impactDamage(sim, p, dmg);
      }
      emit(sim, { t: 'bodySlam', x: a.x, z: a.z, j: Math.round(dv) });
    }
  }
}

// Grab constraints, two regimes:
//   ONE-WAY: the victim is hoisted OVERHEAD like a carried item. Until they
//     react they simply ride along — but they can punch down at the grabber
//     (any damage forces a drop) or grab back to start a grapple.
//   MUTUAL: both players grounded in a wrestling lock, holding each other
//     with equal strength — the pair moves by the AVERAGE of both players'
//     steering, so movement is a genuine tug-of-war.
function applyGrabs(sim, dt) {
  const done = new Set();
  for (const holder of sim.state.players) {
    if (!holder.heldPlayer || done.has(holder.id)) continue;
    const t = getP(sim, holder.heldPlayer);
    if (!t || t.state !== 'alive' || holder.state !== 'alive') {
      releasePlayer(sim, holder);
      continue;
    }
    if (t.heldPlayer === holder.id) {
      // mutual grapple lock
      done.add(holder.id);
      done.add(t.id);
      // equal strength: the pair moves by the average of both muscles.
      // Shuffle friction bleeds off inherited momentum so an opposed
      // stalemate actually stalls instead of coasting.
      const damp = Math.exp(-2.5 * dt);
      const avx = ((holder.vx + t.vx) / 2) * damp;
      const avz = ((holder.vz + t.vz) / 2) * damp;
      holder.vx = t.vx = avx;
      holder.vz = t.vz = avz;
      holder.y = 0; t.y = 0;
      holder.vy = 0; t.vy = 0;
      // pin at grapple distance, face to face
      const dx = t.x - holder.x;
      const dz = t.z - holder.z;
      const d = Math.hypot(dx, dz) || 1;
      const nx = dx / d;
      const nz = dz / d;
      const midX = (holder.x + t.x) / 2;
      const midZ = (holder.z + t.z) / 2;
      const half = 0.62;
      holder.x = midX - nx * half; holder.z = midZ - nz * half;
      t.x = midX + nx * half; t.z = midZ + nz * half;
      holder.face = Math.atan2(nx, nz);
      t.face = Math.atan2(-nx, -nz);
    } else {
      // hoisted overhead: rides the grabber like a carried item
      t.x = holder.x + Math.sin(holder.face) * 0.12;
      t.z = holder.z + Math.cos(holder.face) * 0.12;
      t.y = holder.y + 2.05;
      t.vx = holder.vx; t.vz = holder.vz; t.vy = 0;
      t.face = holder.face;
    }
  }
}

function releasePlayer(sim, holder) {
  const t = holder.heldPlayer ? getP(sim, holder.heldPlayer) : null;
  if (t && t.heldBy === holder.id) t.heldBy = null;
  holder.heldPlayer = null;
}

// Anything in your hands (flag, bomb, player) comes loose.
// If keepFlag is true, carried flags remain held (e.g. non-lethal punch/bomb damage).
export function breakGrabs(sim, p, vx = 0, vz = 0, keepFlag = false) {
  let droppedSomething = false;
  if (p.carryFlag && !keepFlag) {
    sim.mode.dropCarried?.(sim, p, vx, vz);
    droppedSomething = true;
  }
  if (p.heldBomb) {
    const b = sim.state.bombs.find((b) => b.id === p.heldBomb);
    if (b) b.holder = null;
    p.heldBomb = null;
    droppedSomething = true;
  }
  if (p.heldPlayer) {
    releasePlayer(sim, p);
    droppedSomething = true;
  }
  if (p.heldBy) {
    const holder = getP(sim, p.heldBy);
    if (holder) releasePlayer(sim, holder);
    p.heldBy = null;
    droppedSomething = true;
  }
  if (droppedSomething) emit(sim, { t: 'gripBreak', id: p.id });
}

// ------------------------------------------------------------------ actions

// Punch, the BombSquad way: pressing punch starts a SWING; the fist is a
// live collider for ~0.3s that tracks your body, and damage rides on how
// fast the body is moving when it connects (plus a timing curve that peaks
// mid-swing). Standing jab ≈ 4hp. Sprint punch ≈ 40hp — enough to knock the
// target out cold and send them flying. You can't swing while holding
// something; a held victim can still pummel their grabber.
function doPunch(sim, p, i) {
  const cfg = sim.config.punch;
  if (p.punchCd > 0) return;
  // boxing gloves: faster cooldown (400→300ms) and harder hits (spazfactory)
  const gcfg = sim.config.powerups.gloves;
  const cooldown = p.glovesT > 0 ? gcfg.cooldown : cfg.cooldown;
  const power = p.glovesT > 0 ? gcfg.powerScale : 1;

  // held in someone's grip (overhead or grapple): hammer on the grabber —
  // bodies co-move so there's no momentum, just chip damage... but ANY
  // damage forces a drop, so one clean pummel breaks you free.
  // With boxing gloves, punching the grabber gives an INSTANT KNOCKOUT!
  if (p.heldBy) {
    p.punchCd = cooldown;
    p.punchT = cfg.swingTime;
    p.punchArm = p.punchArm ? 0 : 1;
    const holder = getP(sim, p.heldBy);
    emit(sim, { t: 'punch', id: p.id, x: p.x, z: p.z });
    if (holder && holder.state === 'alive') {
      const isGloves = p.glovesT > 0;
      if (isGloves) {
        if (holder.shieldHp > 0) {
          holder.shieldHp = 0;
          emit(sim, { t: 'shieldDown', id: holder.id, x: holder.x, z: holder.z });
        }
        damagePlayer(sim, holder, 100, 0, 0, 8, 'punch', p.id);
        emit(sim, { t: 'punchHit', id: p.id, target: holder.id, x: holder.x, z: holder.z, dmg: 100, instaKO: true });
      } else {
        const dmg = cfg.dmgBase * 1.5 * power;
        damagePlayer(sim, holder, dmg, 0, 0, 0, 'punch', p.id);
        emit(sim, { t: 'punchHit', id: p.id, target: holder.id, x: holder.x, z: holder.z, dmg: Math.round(dmg) });
      }
    }
    return;
  }

  // If holding anything (flag, bomb, player), punching acts as throw
  if (p.carryFlag || p.heldBomb || p.heldPlayer) {
    throwHeld(sim, p, i, false);
    return;
  }

  p.punchCd = cooldown;
  p.punchT = cfg.swingTime;
  p.punchArm = p.punchArm ? 0 : 1; // alternate fists: right, left, right...
  sim.punchHits.set(p.id, new Set());
  const aim = norm2(i.ax || 0, i.az || 0);
  if (aim.len > 0.01) p.face = Math.atan2(aim.x, aim.z);
  emit(sim, {
    t: 'punch', id: p.id,
    x: p.x + Math.sin(p.face) * cfg.range,
    z: p.z + Math.cos(p.face) * cfg.range,
  });
}

// Resolve fist contacts each tick of the active swing window. One hit per
// target per swing; the timing factor peaks mid-swing (BombSquad
// punch_power: 0.7 -> 1.0 -> 0.7 over 200ms).
function resolvePunch(sim, p) {
  const cfg = sim.config.punch;
  const age = cfg.swingTime - p.punchT;
  if (age < cfg.windowStart || age > cfg.windowEnd) return;
  const hits = sim.punchHits.get(p.id);
  if (!hits) return;

  const dir = { x: Math.sin(p.face), z: Math.cos(p.face) };
  const fx = p.x + dir.x * cfg.range;
  const fz = p.z + dir.z * cfg.range;
  const tNorm = Math.min(1, age / 0.2);
  const timing = 0.7 + 0.3 * (0.5 + 0.5 * Math.sin(tNorm * 2 * Math.PI - Math.PI / 2));
  const v3 = Math.hypot(p.vx, p.vz, p.vy); // jumps count toward momentum
  const isGloves = p.glovesT > 0;
  const gcfg = sim.config.powerups.gloves;
  const power = isGloves ? gcfg.powerScale : 1;
  const matP = sim.mats.player;

  for (const o of sim.state.players) {
    if (o === p || o.state !== 'alive' || hits.has(o.id)) continue;
    if (!sim.config.rules.friendlyFire && o.team === p.team) continue;
    if (Math.abs(o.y - p.y) > 1.3) continue;
    if (Math.hypot(o.x - fx, o.z - fz) > cfg.fistRadius + matP.radius) continue;
    hits.add(o.id);

    const rad = norm2(o.x - p.x, o.z - p.z);
    const kx = dir.x * 0.75 + rad.x * 0.25;
    const kz = dir.z * 0.75 + rad.z * 0.25;

    if (isGloves) {
      // INSTA NOCAUTE (Boxing Gloves Powerup):
      // Instantly shatters any energy shield and defeats/knocks out the victim in one hit
      if (o.shieldHp > 0) {
        o.shieldHp = 0;
        emit(sim, { t: 'shieldDown', id: o.id, x: o.x, z: o.z });
      }
      const dv = gcfg.launchDv ?? 24;
      const lift = gcfg.liftDv ?? 9;
      const dmg = gcfg.damage ?? 100;
      damagePlayer(sim, o, dmg, kx * dv, kz * dv, lift, 'punch', p.id);
      emit(sim, { t: 'punchHit', id: p.id, target: o.id, x: o.x, z: o.z, dmg, instaKO: true });
      if (hits.size === 1) {
        p.vx -= dir.x * 2.2;
        p.vz -= dir.z * 2.2;
      }
    } else {
      // damage rides on body momentum — friendly fire is real in BombSquad
      const dmg = Math.min(cfg.dmgCap * power, (cfg.dmgBase + cfg.dmgPerSpeed * v3) * timing * power);
      const dv = dmg * cfg.kbPerDmg;
      damagePlayer(sim, o, dmg, kx * dv, kz * dv, dv * cfg.liftFrac, 'punch', p.id);
      emit(sim, { t: 'punchHit', id: p.id, target: o.id, x: o.x, z: o.z, dmg: Math.round(dmg) });
      if (hits.size === 1) {
        // recoil on the first contact only (BombSquad kick_back)
        p.vx -= dir.x * cfg.selfKick;
        p.vz -= dir.z * cfg.selfKick;
      }
    }
  }

  // smack loose objects with the fist-as-impulse model (light props fly —
  // punches shove bombs but do NOT detonate them)
  const vFist = (isGloves ? 16 : cfg.swingSpeed) + Math.hypot(p.vx, p.vz);
  const invFist = 1 / cfg.fistMass;
  for (const b of sim.state.bombs) {
    if (b.holder || b.stuckTo || hits.has(b.id)) continue;
    if (Math.hypot(b.x - fx, b.z - fz) > cfg.fistRadius + sim.mats.bomb.radius + 0.15) continue;
    hits.add(b.id);
    const j = ((1 + cfg.restitution) * vFist) / (invFist + invMass(sim.mats.bomb));
    applyImpulse(b, sim.mats.bomb, dir.x * j, dir.z * j, j * (isGloves ? 0.45 : 0.25));
  }
  // powerup boxes get knocked around too (BombSquad: punches don't pop them)
  for (const u of sim.state.powerups) {
    if (hits.has(u.id)) continue;
    if (Math.hypot(u.x - fx, u.z - fz) > cfg.fistRadius + sim.mats.box.radius + 0.15) continue;
    hits.add(u.id);
    const j = ((1 + cfg.restitution) * vFist) / (invFist + invMass(sim.mats.box));
    applyImpulse(u, sim.mats.box, dir.x * j, dir.z * j, j * 0.25);
  }
  sim.mode.onPunchObject?.(sim, fx, fz, cfg.fistRadius + 0.45, dir, vFist, invFist);
}

// Throw: with something in hand it hurls it. Empty-handed it does nothing
// (bombs ONLY appear when picked up by walking over powerup boxes!).
function doThrow(sim, p, i) {
  if (p.carryFlag || p.heldBomb || p.heldPlayer) {
    throwHeld(sim, p, i, false);
    return;
  }
}

// The universal throw — BombSquad hurls whatever you hold (flag, bomb,
// player) with a fixed ~45° lob. Power comes from your aim magnitude,
// momentum inheritance is FULL (running throws sail), and objects thrown
// right after pickup fly weaker (the just-picked-up penalty).
function throwHeld(sim, p, i, viaGrab = false) {
  const cfg = sim.config.throw;
  const bcfg = sim.config.bomb;
  const isPlayerThrow = !!p.heldPlayer;
  const aim = norm2(i.ax || 0, i.az || 0);
  const dir = aim.len > 0.01 ? aim : { x: Math.sin(p.face), z: Math.cos(p.face) };
  const pf = clamp(((i.ad ?? bcfg.aimRangeMax) - bcfg.aimRangeMin) / (bcfg.aimRangeMax - bcfg.aimRangeMin), 0, 1);
  let s = cfg.speedMin + (cfg.speedMax - cfg.speedMin) * pf;
  if (!isPlayerThrow && p.heldT < cfg.quickWindow) {
    s *= cfg.quickMin + (1 - cfg.quickMin) * (p.heldT / cfg.quickWindow);
  }
  const sh = Math.cos(cfg.pitch) * s;
  const sv = Math.sin(cfg.pitch) * s;

  if (p.carryFlag) {
    sim.mode.throwCarried?.(sim, p, dir, {
      vx: dir.x * sh + p.vx * cfg.inherit,
      vz: dir.z * sh + p.vz * cfg.inherit,
      vy: sv,
    });
  } else if (p.heldPlayer) {
    const t = getP(sim, p.heldPlayer);
    // throwing out of a mutual grapple breaks BOTH grips
    if (t && t.heldPlayer === p.id) releasePlayer(sim, t);
    releasePlayer(sim, p);
    if (t) {
      // Super Yeet: launches held player far across the arena in a high majestic arc!
      const throwSpeedH = viaGrab ? 21.0 : 19.0;
      const throwSpeedV = viaGrab ? 12.5 : 11.5;
      t.vx = dir.x * throwSpeedH + p.vx * 1.3;
      t.vz = dir.z * throwSpeedH + p.vz * 1.3;
      t.vy = Math.max(t.vy, 0) + throwSpeedV;
      t.y = Math.max(t.y, 0.05);
      t.knockT = Math.max(t.knockT, 1.8); // tumbles through the air until landing
      emit(sim, { t: 'playerThrow', id: p.id, target: t.id, x: t.x, z: t.z, viaGrab });
    }
  } else if (p.heldBomb) {
    const b = sim.state.bombs.find((b) => b.id === p.heldBomb);
    p.heldBomb = null;
    if (b) {
      b.holder = null;
      b.owner = p.id;
      b.x = p.x + dir.x * 0.6;
      b.z = p.z + dir.z * 0.6;
      b.y = p.y + 1.6;
      b.vx = dir.x * sh + p.vx * cfg.inherit;
      b.vz = dir.z * sh + p.vz * cfg.inherit;
      b.vy = sv;
    }
    emit(sim, { t: 'throw', id: p.id, x: p.x, z: p.z });
  }

  // thrower recoil (BombSquad kick_back on throws)
  const kick = isPlayerThrow ? (viaGrab ? 3.2 : 2.5) : cfg.kickback;
  p.vx -= dir.x * kick;
  p.vz -= dir.z * kick;
  p.face = Math.atan2(dir.x, dir.z);
  p.throwT = 0.35;
}

// Grab, the BombSquad pickup button: with something in hand it THROWS it
// (both buttons throw — there is one universal throw). Empty-handed: mode
// objects first (steal the enemy flag), then loose bombs, then other
// players. A player being held can grab their own holder back, turning the
// carry into a mutual grapple. Spawn-protected players can't be grabbed.
function doGrab(sim, p, i) {
  const cfg = sim.config;
  if (p.carryFlag || p.heldBomb || p.heldPlayer) {
    throwHeld(sim, p, i, true);
    return;
  }

  if (sim.mode.tryGrab?.(sim, p)) {
    p.heldT = 0;
    return;
  }

  // grab another player (they stay live: they punch back and get thrown)
  let bestP = null;
  let pd = cfg.grab.playerRange;
  for (const o of sim.state.players) {
    if (o === p || o.state !== 'alive') continue;
    if (o.invuln > 0) continue; // can't grab spawn-protected players
    if (!sim.config.rules.friendlyFire && o.team === p.team) continue; // allies cannot grab each other
    const counterGrab = o.id === p.heldBy; // reaching down at your holder
    if (o.heldBy && !(o.heldBy === p.id)) continue; // already in another grip
    if (!counterGrab && Math.abs(o.y - p.y) > 1.2) continue;
    const d = Math.hypot(p.x - o.x, p.z - o.z);
    if (d < pd) { pd = d; bestP = o; }
  }
  if (bestP) {
    p.heldPlayer = bestP.id;
    bestP.heldBy = p.id;
    p.heldT = 0;
    emit(sim, { t: 'grabPlayer', id: p.id, target: bestP.id, x: p.x, z: p.z, mutual: bestP.heldPlayer === p.id });
  }
}

// -------------------------------------------------------------------- bombs

function updateBombs(sim, dt) {
  const s = sim.state;
  const matB = sim.mats.bomb;
  const matP = sim.mats.player;
  for (let i = s.bombs.length - 1; i >= 0; i--) {
    const b = s.bombs[i];
    if (b.fuse != null) b.fuse -= dt; // the fuse burns whether held or flying
    if (b.arm > 0) {
      b.arm = Math.max(0, b.arm - dt);
      if (!b.arm && b.kind === 'mine') emit(sim, { t: 'mineArm', x: b.x, z: b.z });
    }
    const armed = !b.arm;

    if (b.holder) {
      const p = getP(sim, b.holder);
      if (!p || p.state !== 'alive') {
        b.holder = null;
      } else {
        // hoisted overhead with both hands (BombSquad carry)
        b.x = p.x + Math.sin(p.face) * 0.15;
        b.z = p.z + Math.cos(p.face) * 0.15;
        b.y = p.y + 2.05;
        b.vx = p.vx; b.vz = p.vz; b.vy = 0;
      }
    } else if (b.stuckTo) {
      // a sticky bomb that found a victim rides them to the end
      const t = getP(sim, b.stuckTo);
      if (t) {
        b.x = t.x; b.z = t.z; b.y = t.y + 1.15;
        b.vx = t.vx; b.vz = t.vz; b.vy = 0;
      } else {
        b.stuckTo = null;
      }
    }

    if (!b.holder && !b.stuckTo) {
      const out = integrateBody(sim.level, sim.world, b, matB, dt, { restY: matB.radius });
      if (out.bounced && out.impact > 3) emit(sim, { t: 'bounce', x: b.x, z: b.z });

      let boom = false;
      // impact bombs: once armed, ANY contact sets them off — including
      // the floor they land on (bomb.py: explode on collision)
      if (b.kind === 'impact' && armed && (out.wallImpact > 0 || out.floorImpact > 0)) boom = true;
      // sticky bombs splat where they land instead of bouncing on
      if (b.kind === 'sticky' && armed && (out.floorImpact > 0 || out.wallImpact > 0)) {
        b.vx = 0; b.vz = 0; b.vy = 0;
      }
      // armed land mines are proximity traps: ANY body touching one —
      // its owner included — sets it off (bomb.py excludes only mines)
      if (b.kind === 'mine' && armed) {
        for (const p of s.players) {
          if (p.state !== 'alive') continue;
          if (!sim.config.rules.friendlyFire && b.owner) {
            const owner = getP(sim, b.owner);
            if (owner && p.team === owner.team && p.id !== owner.id) continue;
          }
          if (Math.abs(p.y - b.y) > 1.2) continue;
          if (Math.hypot(p.x - b.x, p.z - b.z) < matB.radius + matP.radius + 0.05) { boom = true; break; }
        }
      }

      // bomb <-> player contact: real impulse exchange. Walking into a
      // resting bomb KICKS it ahead of you; a thrown bomb bonks whoever it
      // hits and caroms off (mass ratio does the work).
      for (const p of s.players) {
        if (p.state !== 'alive') continue;
        const j = collideBodies(b, matB, p, matP, { maxYGap: 1.4 });
        if (j <= 0) continue;
        if (j > 2.5) emit(sim, { t: 'bounce', x: b.x, z: b.z });
        if (!armed) continue;
        if (b.kind === 'impact' && p.id !== b.owner) {
          if (!sim.config.rules.friendlyFire && b.owner) {
            const owner = getP(sim, b.owner);
            if (owner && p.team === owner.team) continue;
          }
          boom = true;
        }
        if (b.kind === 'sticky' && !b.stuckTo) {
          if (!sim.config.rules.friendlyFire && b.owner) {
            const owner = getP(sim, b.owner);
            if (owner && p.team === owner.team && p.id !== owner.id) continue;
          }
          b.stuckTo = p.id;
          emit(sim, { t: 'stick', id: p.id, x: b.x, z: b.z });
        }
      }

      if (boom) {
        s.bombs.splice(i, 1);
        explode(sim, b);
        continue;
      }

      if (b.y < sim.config.world.fallY) {
        s.bombs.splice(i, 1); // lost to the void (owner may pull a new one)
        continue;
      }
    }

    if (b.fuse != null && b.fuse <= 0) {
      s.bombs.splice(i, 1);
      explode(sim, b);
    }
  }
}

function explode(sim, b) {
  if (b.holder) {
    const p = getP(sim, b.holder);
    if (p) p.heldBomb = null;
  }
  detonate(sim, b.x, b.z, Math.max(0, b.y), b.kind ?? 'normal', b.owner ?? null);
}

// One blast, any source — bombs of every kind and the curse. Per-kind
// radius/damage/kick multipliers live in config.bomb.kinds; ice blasts
// additionally FREEZE whoever they reach (damage lands first, exactly as
// BombSquad's Blast sends HitMessage then FreezeMessage). `by` (the
// attacker id for kill attribution) is optional — bombs pass their owner,
// the curse's self-detonation leaves it null (no one else did this to you).
export function detonate(sim, x, z, y, kind, by = null) {
  const cfg = sim.config.bomb;
  const k = cfg.kinds[kind] ?? cfg.kinds.normal;
  const s = sim.state;
  emit(sim, { t: 'explode', x, z, y, kind });

  // players: linear-falloff damage to ZERO at the edge, point-blank is
  // lethal; the velocity kick launches players in range far into the air.
  // Friendly fire is real: your own and your teammates' bombs hurt.
  const owner = by ? s.players.find((pl) => pl.id === by) : null;
  for (const p of s.players) {
    if (p.state !== 'alive') continue;
    if (!sim.config.rules.friendlyFire && owner && p.team === owner.team && p.id !== owner.id) continue;
    const dx = p.x - x;
    const dz = p.z - z;
    const d = Math.hypot(dx, dz);
    if (d >= k.radius || Math.abs(p.y + 0.8 - y) > 3) continue;
    const t = 1 - d / k.radius;
    let nx = dx / (d || 1);
    let nz = dz / (d || 1);
    if (d < 0.01) {
      const a = Math.random() * Math.PI * 2;
      nx = Math.sin(a); nz = Math.cos(a);
    }
    // High-impact knockback push: players anywhere in the blast zone
    // get launched outwards with significant force (impulse floor of 45%)
    const push = 0.45 + 0.55 * t;
    const dvXZ = cfg.blastDvXZ * k.dvMult * push;
    const dvY = cfg.blastDvY * k.dvMult * (0.35 + 0.65 * t);
    damagePlayer(
      sim, p,
      cfg.maxDamage * k.dmgMult * t,
      nx * dvXZ,
      nz * dvXZ,
      dvY,
      'bomb',
      by,
    );
    if (k.freezes) freezePlayer(sim, p);
  }

  // bombs caught in the blast get kicked and cook off 0.1–0.2s later —
  // chain reactions (held bombs chain too, but ride their holder; even
  // fuseless mines are set off this way)
  for (const ob of s.bombs) {
    const d = Math.hypot(ob.x - x, ob.z - z);
    if (d >= k.radius) continue;
    if (!ob.holder && !ob.stuckTo) blastKick(ob, x, z, k.radius, cfg.blastDvXZ * k.dvMult, cfg.blastDvY * k.dvMult * 0.6);
    ob.fuse = Math.min(ob.fuse ?? 99, cfg.chainFuseMin + Math.random() * (cfg.chainFuseMax - cfg.chainFuseMin));
  }

  // powerup boxes caught in a blast are destroyed (powerupbox.py: any
  // non-punch hit is fatal to the box)
  for (let i = s.powerups.length - 1; i >= 0; i--) {
    const u = s.powerups[i];
    if (Math.hypot(u.x - x, u.z - z) >= k.radius) continue;
    s.powerups.splice(i, 1);
    emit(sim, { t: 'powerupBoom', id: u.id, x: u.x, z: u.z });
  }

  // let the mode blast its own objects (flags) around
  sim.mode.onExplosion?.(sim, x, z, k.radius);
}

// ----------------------------------------------------------------- powerups

// Weighted pick from the BombSquad distribution, with its one special rule:
// right after a curse box, the next box is always a med-pack.
function pickPowerupType(sim) {
  const cfg = sim.config.powerups;
  if (sim.lastPowerup === 'curse') {
    sim.lastPowerup = 'health';
    return 'health';
  }
  let total = 0;
  for (const [, w] of cfg.distribution) total += w;
  let r = Math.random() * total;
  for (const [kind, w] of cfg.distribution) {
    r -= w;
    if (r < 0) {
      sim.lastPowerup = kind;
      return kind;
    }
  }
  return 'triple';
}

// Powerup boxes: dropped in waves on the level's powerupSpawns points
// (every 8s, staggered 0.4s apart, first wave the moment play starts),
// expiring after 7s if nobody takes them. The boxes are physics props —
// they can be punched around and blasts destroy them — and are collected
// by simply TOUCHING them (powerupbox.py's accept-on-contact material).
function updatePowerups(sim, dt) {
  const s = sim.state;
  const pts = sim.level.powerupSpawns || sim.level.powerups;
  const cfg = sim.config.powerups;

  if (pts?.length && s.phase === 'play') {
    s.puWave -= dt;
    if (s.puWave <= 0) {
      s.puWave += cfg.interval;
      for (let i = 0; i < pts.length; i++) s.puPend.push({ t: i * cfg.stagger, i });
    }
  }
  for (let i = s.puPend.length - 1; i >= 0; i--) {
    const q = s.puPend[i];
    q.t -= dt;
    if (q.t > 0) continue;
    s.puPend.splice(i, 1);
    const pt = pts[q.i];
    const box = {
      id: 'u' + sim.nextId++,
      kind: pickPowerupType(sim),
      x: pt.x, z: pt.z, y: 2.4, // drops in from above
      vx: 0, vz: 0, vy: 0,
      life: cfg.boxLife,
    };
    s.powerups.push(box);
    emit(sim, { t: 'powerupSpawn', id: box.id, kind: box.kind, x: box.x, z: box.z });
  }

  const mat = sim.mats.box;
  const matP = sim.mats.player;
  for (let i = s.powerups.length - 1; i >= 0; i--) {
    const u = s.powerups[i];
    u.life -= dt;
    if (u.life <= 0) {
      s.powerups.splice(i, 1);
      emit(sim, { t: 'powerupExpire', id: u.id, x: u.x, z: u.z });
      continue;
    }
    integrateBody(sim.level, sim.world, u, mat, dt, { restY: mat.radius });
    if (u.y < sim.config.world.fallY) {
      s.powerups.splice(i, 1);
      continue;
    }
    for (const p of s.players) {
      if (p.state !== 'alive') continue;
      if (Math.abs(p.y - u.y) > 1.4) continue;
      if (Math.hypot(p.x - u.x, p.z - u.z) > mat.radius + matP.radius) continue;
      s.powerups.splice(i, 1);
      grantPowerup(sim, p, u.kind);
      if (u.kind === 'bomb' || u.kind === 'triple' || u.kind === 'ice' || u.kind === 'impact' || u.kind === 'sticky') {
        givePlayerBomb(sim, p, u.kind === 'triple' ? (p.bombKind || 'normal') : (u.kind === 'bomb' ? 'normal' : u.kind));
      }
      break;
    }
  }
}

// Spawns a lit bomb directly into a player's hands when free
export function givePlayerBomb(sim, p, kind = 'normal') {
  if (p.heldBomb || p.carryFlag || p.heldPlayer || p.state !== 'alive') return null;
  const cfg = sim.config.bomb;
  const id = 'b' + sim.nextId++;
  sim.state.bombs.push({
    id,
    kind,
    x: p.x + Math.sin(p.face) * 0.15,
    z: p.z + Math.cos(p.face) * 0.15,
    y: p.y + 2.05,
    vx: p.vx, vz: p.vz, vy: 0,
    fuse: kind === 'mine' ? null : kind === 'impact' ? cfg.impactFuse : cfg.fuse,
    arm: kind === 'mine' ? cfg.mineArm : kind === 'impact' ? cfg.impactArm : kind === 'sticky' ? cfg.stickyArm : 0,
    holder: p.id,
    owner: p.id,
    stuckTo: null,
  });
  p.heldBomb = id;
  p.heldT = 0;
  emit(sim, { t: 'bombOut', id: p.id, kind, x: p.x, z: p.z });
  return id;
}

// Apply a powerup to a player (spaz.py PowerupMessage handling). Exported
// for the smoke harness — grabbing a box in-game routes through here too.
export function grantPowerup(sim, p, kind) {
  const cfg = sim.config.powerups;
  switch (kind) {
    case 'bomb':
      givePlayerBomb(sim, p, 'normal');
      break;
    case 'triple': // three live bombs at once, for a while
      p.bombCount = 3;
      p.tripleT = cfg.wearOff;
      break;
    case 'ice':
    case 'impact':
    case 'sticky': // your bomb button pulls this kind, for a while
      p.bombKind = kind;
      p.bombKindT = cfg.wearOff;
      break;
    case 'mines': // ammo, not a timer: +3, carried max 3
      p.mines = Math.min(p.mines + cfg.mines.count, cfg.mines.count);
      break;
    case 'gloves':
      p.glovesT = cfg.wearOff;
      break;
    case 'shield':
      p.shieldHp = cfg.shield.hp;
      break;
    case 'health': // full heal — and the only cure for the curse
      p.hp = sim.config.player.hp;
      p.curseT = 0;
      break;
    case 'curse':
      if (p.curseT <= 0) emit(sim, { t: 'curse', id: p.id, name: p.name, x: p.x, z: p.z });
      p.curseT = cfg.curse.time;
      break;
  }
  emit(sim, { t: 'powerup', id: p.id, kind, x: p.x, z: p.z });
}

// Ice-blast freeze: 5 seconds as a statue. Shields and spawn protection
// block it (spaz.py FreezeMessage); a hard hit while frozen SHATTERS you.
function freezePlayer(sim, p) {
  if (p.state !== 'alive' || p.invuln > 0 || p.shieldHp > 0) return;
  if (p.frozenT <= 0) emit(sim, { t: 'freeze', id: p.id, x: p.x, z: p.z });
  p.frozenT = sim.config.powerups.freeze.time;
}

// All damage funnels through here with a velocity kick (Δv). BombSquad
// rules: ANY damage drops whatever the target is holding, and a single hit
// past the knockout threshold puts them out cold — an unconscious ragdoll
// that wakes up with its remaining hp. A shield eats hits FIRST — damage
// and knockback both — and only the breaking hit's overshoot beyond the
// spillover threshold reaches the player (spaz.py / spazfactory.py).
export function damagePlayer(sim, p, dmg, dvx, dvz, dvy, cause, by = null, isDashWall = false) {
  if (p.state !== 'alive' || p.invuln > 0) return;
  // credit a real hit to its source (never self; env/self impacts pass by=null
  // and must PRESERVE whoever last hit us, so a shove-off-the-edge gets credited)
  if (by && by !== p.id) { p.lastHitBy = by; p.lastHitByT = HIT_CREDIT; }
  if (p.shieldHp > 0 && dmg > 0) {
    const spill = sim.config.powerups.shield.spillover;
    p.shieldHp -= dmg;
    emit(sim, { t: 'shieldHit', id: p.id, hp: Math.max(0, Math.round(p.shieldHp)), x: p.x, z: p.z });
    if (p.shieldHp > 0) return; // good job, shield
    const leftover = -p.shieldHp;
    p.shieldHp = 0;
    emit(sim, { t: 'shieldDown', id: p.id, x: p.x, z: p.z });
    if (leftover <= spill) return; // the shield died so you didn't
    const ratio = (leftover - spill) / dmg;
    dmg *= ratio; dvx *= ratio; dvz *= ratio; dvy *= ratio;
  }
  p.hp -= dmg;
  p.hurtT = 1.0; // brief hit-flash window (no regen — damage is permanent)
  if (cause === 'punch') {
    p.punchedT = 0.45;
  }
  p.vx += dvx;
  p.vz += dvz;
  if (dvy) {
    p.vy = Math.max(p.vy, 0) + dvy;
    p.y = Math.max(p.y, 0.02);
  }
  if (cause === 'bomb') {
    p.blastedT = Math.max(p.blastedT || 0, 0.65);
  }
  const isPunchOrBomb = cause === 'punch' || cause === 'bomb';
  const keepFlag = isPunchOrBomb && p.hp > 0;
  if (dmg > 0) breakGrabs(sim, p, p.vx, p.vz, keepFlag);
  // frozen solid: a hard-enough (or lethal) hit shatters you outright
  if (p.frozenT > 0 && (dmg >= sim.config.powerups.freeze.shatterDamage || p.hp <= 0)) {
    emit(sim, { t: 'shatter', id: p.id, x: p.x, z: p.z });
    koPlayer(sim, p, 'shatter');
    return;
  }
  const k = sim.config.player.knockout;
  const units = Math.min(k.maxUnits, dmg * k.unitsPerDamage - k.baseUnits);
  if (isDashWall && p.hp > 0) {
    const stunT = sim.config.player.dashWallStunDuration ?? 0.45;
    p.knockT = stunT;
    emit(sim, { t: 'knockout', id: p.id, x: p.x, z: p.z });
  } else if (units >= 1 && p.hp > 0) {
    const t = units / k.unitsPerSec;
    if (t > p.knockT) {
      p.knockT = t;
      emit(sim, { t: 'knockout', id: p.id, x: p.x, z: p.z });
    }
  }
  if (dmg > 0) emit(sim, { t: 'hurt', id: p.id, hp: Math.max(0, Math.round(p.hp)) });
  if (p.hp <= 0) koPlayer(sim, p, cause);
}

// Impact damage with BombSquad's mercy rule: if an ordinary impact would
// kill, it's reduced to max(dmg − mercyReduce, hp − 1) — big enough hits
// still finish the job.
function impactDamage(sim, p, dmg, isDashWall = false) {
  const icfg = sim.config.player.impact;
  p.impactCd = icfg.cooldown;
  if (dmg >= p.hp) dmg = Math.max(dmg - icfg.mercyReduce, p.hp - 1);
  if (dmg < 1) return;
  damagePlayer(sim, p, dmg, 0, 0, 0, 'impact', null, isDashWall);
  emit(sim, { t: 'impact', id: p.id, x: p.x, z: p.z, dmg: Math.round(dmg) });
}

function koPlayer(sim, p, cause) {
  if (p.state === 'ko') return;
  p.state = 'ko';
  p.hp = 0;
  p.koT = 0;
  p.knockT = 0;
  p.shieldHp = 0; // the shield dies with its owner
  p.curseT = 0;
  p.frozenT = 0;
  p.respawn = sim.config.player.respawnTime;
  breakGrabs(sim, p, p.vx, p.vz);
  sim.mode.onKO?.(sim, p);
  emit(sim, { t: 'ko', id: p.id, name: p.name, team: p.team, cause, x: p.x, z: p.z });
}

// death loses every powerup — a respawned spaz starts clean (BombSquad)
function clearPowerups(sim, p) {
  p.shieldHp = 0;
  p.glovesT = 0;
  p.frozenT = 0;
  p.curseT = 0;
  p.mines = 0;
  p.bombKind = 'normal';
  p.bombKindT = 0;
  p.bombCount = sim.config.bomb.perPlayer;
  p.tripleT = 0;
}

function respawnPlayer(sim, p) {
  placeAtSpawn(sim, p);
  p.state = 'alive';
  p.hp = sim.config.player.hp;
  p.invuln = sim.config.player.invulnTime;
  p.carryFlag = null;
  p.knockT = 0;
  p.gearSpd = 0;
  p.heldT = 9;
  p.impactCd = 0;
  p.jumpCd = 0;
  p.dashCd = 0;
  p.dashT = 0;
  p.dashImpactWindow = 0;
  p.blastedT = 0;
  p.koT = 0;
  p.lastHitBy = null;
  p.lastHitByT = 0;
  clearPowerups(sim, p);
  emit(sim, { t: 'spawn', id: p.id, team: p.team, x: p.x, z: p.z });
}

// -------------------------------------------------------------- round flow

export function endRound(sim, winner) {
  const s = sim.state;
  if (s.phase === 'over') return;
  s.phase = 'over';
  s.winner = winner;
  s.overT = sim.config.rules.overTime;
  emit(sim, { t: 'roundOver', winner, scores: { ...s.scores } });
}

export function resetRound(sim) {
  const s = sim.state;
  s.phase = 'countdown';
  s.countdown = sim.config.rules.countdown;
  s.timeLeft = sim.config.rules.roundTime;
  s.scores = { red: 0, blue: 0 };
  s.ffaScores = {};
  for (const p of s.players) s.ffaScores[p.id] = 0;
  s.winner = null;
  s.bombs = [];
  s.powerups = [];
  s.puWave = 0;
  s.puPend = [];
  for (const p of s.players) {
    p.state = 'alive';
    p.hp = sim.config.player.hp;
    p.carryFlag = null;
    p.heldBomb = null;
    p.heldPlayer = null;
    p.heldBy = null;
    p.knockT = 0;
    p.gearSpd = 0;
    p.heldT = 9;
    p.throwT = 0; p.punchCd = 0; p.punchT = 0; p.hurtT = 0; p.punchedT = 0;
    p.jumpCd = 0; p.impactCd = 0;
    p.lastHitBy = null; p.lastHitByT = 0;
    p.invuln = sim.config.player.invulnTime;
    clearPowerups(sim, p);
    placeAtSpawn(sim, p);
  }
  sim.mode.init(sim);
  emit(sim, { t: 'newRound' });
  emit(sim, { t: 'tick', n: Math.ceil(s.countdown) });
}