// Common physics core — impulse-based rigid-body dynamics on the XZ plane
// with height (Y). Every dynamic thing in the game (players, bombs, flags)
// moves through here with a per-kind MATERIAL, so tuning lives in one place.
//
// The model follows the BombSquad physics research (deep-research-report.md):
//   - Collision impulse with restitution:
//       j = -(1 + e) * v_rel·n / (1/m_A + 1/m_B)
//       v_A' = v_A + (j/m_A)n ;  v_B' = v_B - (j/m_B)n
//   - Coulomb friction: tangential impulse clamped to μ * normal impulse
//       (|F_T| <= μ|F_N|, the "friction cone")
//   - Per-step velocity damping: v <- v * (1 - damp)  (ODE-style)
//   - Spring-damper constraints: F = -k_p*x - k_d*ẋ  (grab joints)
//   - Radial blast impulses: Δv = J/m, so lighter bodies fling farther
//   - Stability: max-speed clamp, sleep threshold, and substep CCD so fast
//     bodies can't tunnel through thin walls in one fixed step.
//
// Bodies are plain state objects { x, z, y, vx, vz, vy } — the same objects
// that serialize into network snapshots. Mass/material is NOT stored on the
// body; callers pass the material for the body's kind.

import { clamp, norm2, circlePushOut } from '../core/math.js';

// --------------------------------------------------------------- materials

export const invMass = (mat) => 1 / mat.mass;

// engines usually combine restitution with max(); friction with sqrt-product
const combineE = (a, b) => Math.max(a.restitution, b.restitution);

// ------------------------------------------------------------- integration

export const overFloor = (level, x, z) =>
  Math.abs(x) <= level.bounds.w / 2 && Math.abs(z) <= level.bounds.d / 2;

// One fixed step for a free body: gravity, solid collisions (impulse +
// Coulomb friction), floor bounce/rest, ground friction, damping, sleep.
// Fast bodies are integrated in substeps (poor-man's CCD).
// Returns { bounced, impact } for sound/fx triggers.
export function integrateBody(level, world, body, mat, dt, opts = {}) {
  const out = { bounced: false, impact: 0, wallImpact: 0, floorImpact: 0 };
  // restY: height of the body's y-origin when resting on the floor
  // (players measure y at the feet -> 0; bombs at the center -> radius)
  const restY = opts.restY ?? 0;
  const speed = Math.hypot(body.vx, body.vz, body.vy);

  // stability: clamp runaway velocities (report: "max speeds" / instability)
  if (speed > world.maxSpeed) {
    const s = world.maxSpeed / speed;
    body.vx *= s; body.vz *= s; body.vy *= s;
  }

  // CCD: never move more than ~one radius per (sub)step
  const steps = Math.min(4, Math.max(1, Math.ceil((speed * dt) / (mat.radius * 0.9))));
  const h = dt / steps;

  for (let i = 0; i < steps; i++) {
    body.x += body.vx * h;
    body.z += body.vz * h;

    // walls / crates / rails: impulse with restitution + tangential friction
    for (const box of level.solids) {
      if (body.y - restY > box.h - 0.05 || body.y - restY < -0.6) continue; // flies over or dropped below floor
      const push = circlePushOut(body.x, body.z, mat.radius, box);
      if (!push) continue;
      body.x += push.x;
      body.z += push.z;
      const vn = body.vx * push.nx + body.vz * push.nz;
      if (vn < 0) {
        const e = opts.wallE ?? mat.restitution;
        // normal impulse (static wall => infinite mass): Δv_n = -(1+e)v_n
        const dvn = -(1 + e) * vn;
        body.vx += dvn * push.nx;
        body.vz += dvn * push.nz;
        // Coulomb friction on the tangential component: |Δv_t| <= μ|Δv_n|
        let tx = body.vx - (body.vx * push.nx + body.vz * push.nz) * push.nx;
        let tz = body.vz - (body.vx * push.nx + body.vz * push.nz) * push.nz;
        const tlen = Math.hypot(tx, tz);
        if (tlen > 1e-4) {
          const drop = Math.min(mat.wallFriction * Math.abs(dvn), tlen);
          body.vx -= (tx / tlen) * drop;
          body.vz -= (tz / tlen) * drop;
        }
        out.impact = Math.max(out.impact, Math.abs(vn));
        out.wallImpact = Math.max(out.wallImpact, Math.abs(vn));
      }
    }

    // vertical: gravity while airborne, rising (fresh bounce/launch), or
    // off the platform
    const onFloor = overFloor(level, body.x, body.z);
    if (onFloor && body.y < restY) {
      body.y = restY;
      if (body.vy < 0) {
        out.floorImpact = Math.max(out.floorImpact, -body.vy);
        body.vy = 0;
      }
    }
    if (body.y > restY || body.vy > 0 || !onFloor) {
      body.vy += world.gravity * h;
      body.y += body.vy * h;
      if (onFloor && body.y <= restY && body.vy <= 0) {
        // floor contact: bounce if falling fast enough, else come to rest
        const vin = -body.vy;
        body.y = restY;
        out.floorImpact = Math.max(out.floorImpact, vin);
        if (vin > mat.bounceMin) {
          body.vy = vin * mat.restitution;
          out.bounced = true;
          out.impact = Math.max(out.impact, vin);
          // landing friction eats tangential speed (μ * normal impulse)
          const jn = (1 + mat.restitution) * vin;
          const tlen = Math.hypot(body.vx, body.vz);
          if (tlen > 1e-4) {
            const drop = Math.min(mat.friction * jn, tlen);
            body.vx -= (body.vx / tlen) * drop;
            body.vz -= (body.vz / tlen) * drop;
          }
        } else {
          body.vy = 0;
        }
      }
    }
  }

  if (overFloor(level, body.x, body.z) && body.y < restY) {
    body.y = restY;
    if (body.vy < 0) body.vy = 0;
  }

  // resting ground friction: constant deceleration μ·g (Coulomb, N = m·g)
  if (body.y <= restY + 0.001 && overFloor(level, body.x, body.z) && !opts.noGroundFriction) {
    const g = -world.gravity;
    const declamp = mat.friction * g * dt;
    const tlen = Math.hypot(body.vx, body.vz);
    if (tlen > 1e-4) {
      const drop = Math.min(declamp, tlen);
      body.vx -= (body.vx / tlen) * drop;
      body.vz -= (body.vz / tlen) * drop;
    }
  }

  // ODE-style per-step damping: v <- v * (1 - scale)
  const damp = 1 - mat.linDamp;
  body.vx *= damp; body.vz *= damp;
  if (body.y > 0) body.vy *= damp;

  // sleep: kill sub-threshold jitter on resting bodies
  if (body.y <= restY + 0.001 && Math.hypot(body.vx, body.vz) < world.sleepSpeed && body.vy === 0) {
    body.vx = 0; body.vz = 0;
  }
  return out;
}

// -------------------------------------------------------- pairwise impulse

// Circle-vs-circle impulse collision between two dynamic bodies.
// Resolves penetration split by inverse mass, then applies the report's
// impulse formula along the contact normal. Returns the impulse magnitude j
// (0 if no contact), which callers use for bonk sounds / stumble thresholds.
export function collideBodies(a, matA, b, matB, opts = {}) {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const rr = matA.radius + matB.radius;
  const d = Math.hypot(dx, dz);
  if (d >= rr || d < 1e-6) return 0;
  if (Math.abs((a.y ?? 0) - (b.y ?? 0)) > (opts.maxYGap ?? 1.2)) return 0;

  const nx = dx / d;
  const nz = dz / d;
  const ia = invMass(matA);
  const ib = invMass(matB);

  // positional correction, heavier body moves less
  const pen = rr - d;
  const total = ia + ib;
  a.x -= nx * pen * (ia / total);
  a.z -= nz * pen * (ia / total);
  b.x += nx * pen * (ib / total);
  b.z += nz * pen * (ib / total);

  // impulse: j = -(1+e) * v_rel·n / (1/m_A + 1/m_B)
  const rvx = a.vx - b.vx;
  const rvz = a.vz - b.vz;
  const vrel = rvx * nx + rvz * nz; // approach speed along n (B->A dir is -n)
  if (vrel <= 0) return 0; // separating
  const e = opts.e ?? combineE(matA, matB);
  const j = ((1 + e) * vrel) / total;
  a.vx -= j * ia * nx;
  a.vz -= j * ia * nz;
  b.vx += j * ib * nx;
  b.vz += j * ib * nz;
  return j;
}

// Apply a raw impulse J to a body: Δv = J / m (lighter bodies fly farther)
export function applyImpulse(body, mat, jx, jz, jy = 0) {
  const im = invMass(mat);
  body.vx += jx * im;
  body.vz += jz * im;
  if (jy) {
    body.vy = Math.max(body.vy, 0) + jy * im;
    body.y = Math.max(body.y, 0.02);
  }
}

// Radial blast: outward velocity kick with linear falloff from the center.
// BombSquad (rigid_body.cc) scales blast force by the target's mass so a
// given blast affects every body EQUALLY — dvXZ/dvY are Δv at the epicenter
// (the vertical component is exaggerated: blasts pop things up and out).
// Returns the applied Δv magnitude (0 outside the radius).
export function blastKick(body, cx, cz, radius, dvXZ, dvY) {
  const dx = body.x - cx;
  const dz = body.z - cz;
  const d = Math.hypot(dx, dz);
  if (d >= radius) return 0;
  const t = 1 - d / radius;
  const push = 0.45 + 0.55 * t;
  let nx, nz;
  if (d < 0.01) {
    const a = Math.random() * Math.PI * 2;
    nx = Math.sin(a); nz = Math.cos(a);
  } else {
    nx = dx / d; nz = dz / d;
  }
  body.vx += nx * dvXZ * push;
  body.vz += nz * dvXZ * push;
  body.vy = Math.max(body.vy, 0) + dvY * (0.35 + 0.65 * t);
  body.y = Math.max(body.y, 0.02);
  return Math.hypot(dvXZ * push, dvY * push);
}

// -------------------------------------------------------------- constraints

// Spring-damper joint (the grab constraint): F = -k_p*x - k_d*ẋ, clamped to
// maxF, applied to the target as acceleration F/m. The damping term is what
// keeps a held body from orbiting the hand forever (report: ERP/CFM express
// exactly this implicit spring).
export function springDamper(target, matT, anchorX, anchorZ, anchorVx, anchorVz, k, dt) {
  const dx = anchorX - target.x;
  const dz = anchorZ - target.z;
  const rvx = anchorVx - target.vx;
  const rvz = anchorVz - target.vz;
  let fx = k.kp * dx + k.kd * rvx;
  let fz = k.kp * dz + k.kd * rvz;
  const f = Math.hypot(fx, fz);
  if (f > k.maxF) {
    fx *= k.maxF / f;
    fz *= k.maxF / f;
  }
  const im = invMass(matT);
  target.vx += fx * im * dt;
  target.vz += fz * im * dt;
}

// Ballistic launch speed for a throw that should land ~range away at the
// given elevation pitch: R = s²·sin(2θ)/g  =>  s = sqrt(R·g / sin 2θ)
export function launchSpeed(range, pitch, g) {
  const s = Math.sqrt((range * g) / Math.sin(2 * pitch));
  return { sh: s * Math.cos(pitch), sv: s * Math.sin(pitch) };
}
