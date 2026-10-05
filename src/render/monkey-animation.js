import * as THREE from 'three';
import { clamp, lerp } from '../core/math.js';

const TAU = Math.PI * 2;
const smooth = (x) => { x = clamp(x, 0, 1); return x * x * (3 - 2 * x); };
const damp = (from, to, rate, dt) => lerp(from, to, 1 - Math.exp(-rate * dt));
function spring(state, target, frequency, dt) {
  // Exact critically damped response: stable at any accepted frame time,
  // with inertia but no endless oscillation or frame-rate-dependent whip.
  const offset = state.value - target;
  const change = state.velocity + frequency * offset;
  const decay = Math.exp(-frequency * dt);
  state.value = target + (offset + change * dt) * decay;
  state.velocity = (state.velocity - frequency * change * dt) * decay;
  return state.value;
}
const supportCache = new WeakMap();

// This rig has different rest axes on the head, hands and mirrored limbs.
// Work in the character's anatomical frame, never add angles to FBX Eulers.
export class MonkeyAnimator {
  constructor(model, pose, bones, motionData = null) {
    this.model = model;
    this.pose = pose;
    this.bones = bones;
    this.motions = motionData?.motions || null;
    this.airTime = 0;
    this.entries = [];
    this.byName = {};
    this.speed = 0;
    this.phase = 0;
    this.time = 0;
    this.initialized = false;
    this.wasAirborne = false;
    this.land = 0;
    this.turn = 0;
    this.lastFace = null;
    this.wasKO = false;
    this.getUp = 0;
    this.acceleration = 0;
    this.restRoot = model.position.clone();
    this.v = new THREE.Vector3();
    this.q = new THREE.Quaternion();
    this.parentInverse = new THREE.Quaternion();
    this.modelQ = new THREE.Quaternion();
    this.target = new THREE.Quaternion();
    this.delta = new THREE.Quaternion();
    this.axes = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
    this.scratchPosition = new THREE.Vector3();
    this.scratchScale = new THREE.Vector3();
    this.rigInverse = new THREE.Matrix4();
    this.contactMatrix = new THREE.Matrix4();
    model.updateWorldMatrix(true, true);
    model.traverse((bone) => {
      if (!bone.isBone) return;
      const entry = { bone, rest: bone.quaternion.clone(), current: bone.quaternion.clone(),
        position: bone.position.clone(), scale: bone.scale.clone(), angles: new Float32Array(3),
        motion: bone.quaternion.clone(), hasMotion: false };
      this.entries.push(entry);
      this.byName[bone.name] = entry;
    });
    this.tail = this.entries.filter(entry => /^Tail\d{2}$/.test(entry.bone.name))
      .sort((a, b) => a.bone.name.localeCompare(b.bone.name));
    for (const entry of this.tail) {
      entry.tail = true;
      entry.pitch = { value: 0, velocity: 0 };
      entry.yaw = { value: 0, velocity: 0 };
    }
    this.legs = {};
    this.rigInverse.copy(model.matrixWorld).invert();
    for (const side of ['L', 'R']) {
      const points = ['Thigh', 'Calf', 'Foot'].map(part =>
        bones[`${side}_${part}`]?.getWorldPosition(new THREE.Vector3()).applyMatrix4(this.rigInverse));
      if (points.some(point => !point)) continue;
      const upper = points[1].clone().sub(points[0]);
      const lower = points[2].clone().sub(points[1]);
      this.legs[side] = {
        upper: Math.hypot(upper.y, upper.z), lower: Math.hypot(lower.y, lower.z),
        upperAngle: Math.atan2(upper.z, -upper.y), lowerAngle: Math.atan2(lower.z, -lower.y),
        ankleY: points[2].y - points[0].y, ankleZ: points[2].z - points[0].z,
      };
    }
    // A small set of skinned support vertices keeps feet, hands and the crown
    // above the floor in crouches and falls without scanning the mesh per frame.
    this.support = [];
    const directions = [];
    for (let x = -1; x <= 1; x++) for (let y = -1; y <= 1; y++) for (let z = -1; z <= 1; z++) {
      if (x || y || z) directions.push([x, y, z]);
    }
    model.traverse((mesh) => {
      if (!mesh.isSkinnedMesh) return;
      mesh.frustumCulled = false;
      if (supportCache.has(mesh.geometry)) {
        this.addSupport(mesh, supportCache.get(mesh.geometry));
        return;
      }
      const position = mesh.geometry.attributes.position;
      const joints = mesh.geometry.attributes.skinIndex;
      const weights = mesh.geometry.attributes.skinWeight;
      const groups = new Map();
      for (let i = 0; i < position.count; i++) {
        let channel = 0;
        for (let c = 1; c < 4; c++) if (weights.getComponent(i, c) > weights.getComponent(i, channel)) channel = c;
        const joint = joints.getComponent(i, channel);
        const p = [position.getX(i), position.getY(i), position.getZ(i)];
        if (!groups.has(joint)) groups.set(joint, directions.map(() => ({ value: -Infinity, index: i })));
        const extrema = groups.get(joint);
        for (let d = 0; d < directions.length; d++) {
          const direction = directions[d];
          const value = p[0] * direction[0] + p[1] * direction[1] + p[2] * direction[2];
          const best = extrema[d];
          if (value > best.value) { best.value = value; best.index = i; }
        }
      }
      const indices = new Set();
      for (const extrema of groups.values()) for (const best of extrema) indices.add(best.index);
      const cached = [...indices];
      supportCache.set(mesh.geometry, cached);
      this.addSupport(mesh, cached);
      // Animated skinned bounds must not use the imported T-pose box.
    });
  }

  addSupport(mesh, indices) {
    const attributes = mesh.geometry.attributes;
    const samples = new Float32Array(indices.length * 11);
    for (let s = 0; s < indices.length; s++) {
      const index = indices[s], offset = s * 11;
      this.v.fromBufferAttribute(attributes.position, index).applyMatrix4(mesh.bindMatrix);
      samples.set([this.v.x, this.v.y, this.v.z], offset);
      for (let c = 0; c < 4; c++) {
        samples[offset + 3 + c] = attributes.skinWeight.getComponent(index, c);
        samples[offset + 7 + c] = attributes.skinIndex.getComponent(index, c) * 16;
      }
    }
    this.support.push({ mesh, samples });
  }

  joint(name, pitch = 0, yaw = 0, roll = 0) {
    const entry = this.byName[name];
    if (!entry) return;
    if (!entry.tail) entry.hasMotion = false;
    entry.angles[0] = pitch;
    entry.angles[1] = yaw;
    entry.angles[2] = roll;
  }

  arm(side, pitch, open = 1.13, elbow = -0.24, wrist = 0) {
    const sign = side === 'L' ? -1 : 1;
    this.joint(`${side}_Clavicle`, 0, sign * 0.025, sign * open * 0.07);
    this.joint(`${side}_Upperarm`, clamp(pitch, -1.65, 1.30), 0, sign * open);
    this.joint(`${side}_Forearm`, clamp(elbow, -1.15, 0.55));
    this.joint(`${side}_Hand`, clamp(wrist, -0.25, 0.25));
  }

  leg(side, thigh, knee, foot) {
    this.joint(`${side}_Thigh`, clamp(thigh, -0.85, 0.55));
    this.joint(`${side}_Calf`, clamp(knee, 0.04, 1.12));
    this.joint(`${side}_Foot`, clamp(foot, -0.42, 0.38));
    this.joint(`${side}_ToeBase`, clamp(-foot * 0.22, -0.08, 0.08));
  }

  gaitLeg(side, phase, moving, run, hipPitch, landing) {
    const limb = this.legs[side];
    if (!limb) return;
    const cycle = ((phase / TAU) % 1 + 1) % 1;
    const contact = lerp(0.64, 0.54, run);
    const swing = cycle > contact;
    const t = swing ? (cycle - contact) / (1 - contact) : cycle / contact;
    const step = (limb.upper + limb.lower) * lerp(0.18, 0.28, run) * moving;
    // During support the ankle moves steadily backwards; during swing it
    // clears the ground and returns. A sinusoid has neither a planted phase
    // nor a distinct heel contact, which made the previous gait look rubbery.
    let forward = swing ? lerp(-1, 1, smooth(t)) : 1 - 2 * t;
    let lift = swing ? Math.sin(Math.PI * t) ** 1.5 : 0;
    if (this.motions?.walk.feet) {
      // Use the reference's actual foot trajectory, adapted to this leg's
      // length. IK retains the flat contact and avoids imported ankle twists.
      const cycle = ((this.phase / TAU) % 1 + 1) % 1;
      let walkZ = 0, walkY = 0;
      for (const name of ['walk', 'run']) {
        const clip = this.motions[name], values = clip.feet[side];
        const frame = cycle * (clip.count - 1), first = Math.floor(frame), second = Math.min(first + 1, clip.count - 1);
        const z = lerp(values[first * 2], values[second * 2], frame - first);
        const y = lerp(values[first * 2 + 1], values[second * 2 + 1], frame - first);
        if (name === 'walk') { walkZ = z; walkY = y; }
        else { forward = lerp(walkZ, z, run); lift = lerp(walkY, y, run); }
      }
    }
    const z = limb.ankleZ + step * forward;
    const clearance = lift * limb.lower * lerp(0.24, 0.38, run) * moving;
    const compression = (limb.upper + limb.lower) * (0.035 + run * 0.025 + landing * 0.45);
    const y = limb.ankleY + compression + clearance;
    const distance = clamp(Math.hypot(y, z), Math.abs(limb.upper - limb.lower) + 0.001,
      (limb.upper + limb.lower) * 0.995);
    const knee = Math.acos(clamp((distance * distance - limb.upper ** 2 - limb.lower ** 2)
      / (2 * limb.upper * limb.lower), -1, 1));
    const upperAngle = Math.atan2(z, -y)
      + Math.atan2(limb.lower * Math.sin(knee), limb.upper + limb.lower * Math.cos(knee));
    const thigh = limb.upperAngle - upperAngle - hipPitch;
    const calf = limb.lowerAngle - limb.upperAngle + knee;
    const toeOff = !swing ? smooth((t - 0.78) / 0.22) * moving * 0.12 : -0.035 * moving;
    this.leg(side, thigh, calf, -(hipPitch + thigh + calf) + toeOff);
  }

  updateTail(dt, moving, run, airborne, ko, held) {
    // The curled rest shape remains intact. Small bends counterbalance the
    // pelvis, turn opposite steering, and reach the tip with increasing lag.
    let pitch = ko ? 0 : clamp(-this.acceleration * 0.003 + (airborne ? 0.025 : 0)
      + Math.sin(this.phase * 2 - 0.5) * 0.006 * moving, -0.045, 0.045);
    let yaw = ko ? 0 : clamp(-this.turn * 0.035
      + Math.sin(this.phase - 0.7) * lerp(0.014, 0.028, run) * moving
      + Math.sin(this.time * 1.25) * 0.012 * (1 - moving), -0.12, 0.12);
    if (held) { pitch *= 0.4; yaw *= 0.35; }
    for (let i = 0; i < this.tail.length; i++) {
      const entry = this.tail[i];
      const rate = 10 - i * 0.8;
      pitch = spring(entry.pitch, pitch, rate, dt);
      yaw = spring(entry.yaw, yaw, rate, dt);
      this.joint(entry.bone.name, pitch, yaw);
      pitch *= 0.82; yaw *= 0.82;
    }
  }

  sampleMotion(name, time, loop = false, weight = 1) {
    const clip = this.motions?.[name];
    if (!clip || weight <= 0) return;
    const groundedFeet = ['idle', 'walk', 'run', 'land'].includes(name);
    const normalized = loop ? ((time / clip.duration) % 1 + 1) % 1 : clamp(time / clip.duration, 0, 1);
    const frame = normalized * (clip.count - 1), first = Math.floor(frame);
    const second = Math.min(clip.count - 1, first + 1), blend = frame - first;
    for (const [name, values] of Object.entries(clip.rotations)) {
      if (groundedFeet && /Thigh|Calf|Foot|ToeBase/.test(name)) continue;
      const entry = this.byName[name];
      if (!entry) continue;
      this.q.fromArray(values, first * 4).normalize();
      this.target.fromArray(values, second * 4).normalize();
      this.q.slerp(this.target, blend);
      if (!entry.hasMotion) entry.motion.copy(entry.rest);
      entry.motion.slerp(this.q, weight).normalize();
      entry.hasMotion = true;
      entry.angles.fill(0);
    }
  }

  update(p, dt, reaction = {}) {
    // Bound frame time after tab suspension; animation state stays finite.
    dt = clamp(Number.isFinite(dt) ? dt : 0, 0, 0.05);
    const ko = p.state === 'ko' || (p.knockT ?? 0) > 0;
    const held = !!p.heldBy && p.heldPlayer !== p.heldBy;
    const frozen = (p.frozenT ?? 0) > 0;
    const airborne = Math.abs(p.y ?? 0) > 0.05 && !held;
    if (frozen && this.initialized) return;
    if (this.wasKO && !ko && !held) {
      if ((p.invuln ?? 0) > 0) {
        this.initialized = false;
        this.pose.rotation.set(0, 0, 0);
        this.speed = 0;
        this.acceleration = 0;
        for (const entry of this.tail) {
          entry.pitch.value = entry.pitch.velocity = 0;
          entry.yaw.value = entry.yaw.velocity = 0;
        }
      } else this.getUp = 0.65;
    }
    this.wasKO = ko;
    this.getUp = Math.max(0, this.getUp - dt);
    this.time += dt;
    const desiredSpeed = ko || held ? 0 : clamp(p.spd ?? Math.hypot(p.vx ?? 0, p.vz ?? 0), 0, 10);
    const previousSpeed = this.speed;
    this.speed = damp(this.speed, desiredSpeed, 12, dt);
    this.acceleration = damp(this.acceleration, dt > 0 ? clamp((this.speed - previousSpeed) / dt, -12, 12) : 0, 6, dt);
    const moving = smooth(this.speed / 0.8);
    const run = smooth((this.speed - 2.5) / 4.3);
    if (!airborne && !held && !ko) this.phase += TAU * lerp(0.85, 1.85, run)
      * clamp(this.speed / 2.5, 0, 1) * moving * dt;
    if (this.wasAirborne && !airborne && !held && !ko) this.land = 1;
    this.wasAirborne = airborne;
    this.land = Math.max(0, this.land - dt * 3.2);
    this.airTime = airborne ? this.airTime + dt : 0;
    const landing = Math.sin(this.land * Math.PI) * 0.09;
    let turnTarget = 0;
    const face = Number.isFinite(p.face) ? p.face : 0;
    if (this.lastFace !== null && dt > 0) {
      const delta = Math.atan2(Math.sin(face - this.lastFace), Math.cos(face - this.lastFace));
      turnTarget = clamp(delta / dt, -3, 3) * moving;
    }
    this.lastFace = face;
    this.turn = damp(this.turn, turnTarget, 9, dt);
    for (const e of this.entries) { e.angles.fill(0); e.hasMotion = false; }

    const stride = Math.sin(this.phase);
    const breath = Math.sin(this.time * 2.2);
    const lean = 0.07 + run * 0.09 + this.acceleration * 0.0025 + landing;
    const hipPitch = lean * 0.15;
    this.joint('Hip', hipPitch, stride * moving * 0.018, -this.turn * 0.008);
    this.joint('Waist', lean * 0.30, -stride * moving * 0.012);
    this.joint('Spine01', lean * 0.35, stride * moving * 0.014);
    this.joint('Spine02', lean * 0.20 + breath * 0.004, -stride * moving * 0.01);
    this.joint('Head', -lean * 0.70, Math.sin(this.time * 0.7) * 0.009 * (1 - moving));
    for (const side of ['L', 'R']) {
      const wave = side === 'L' ? stride : -stride;
      this.gaitLeg(side, this.phase + (side === 'R' ? Math.PI : 0), moving, run, hipPitch, landing);
      // Relaxed elbows; the shoulder counterbalances the supporting leg.
      this.arm(side, -0.10 + wave * lerp(0.10, 0.22, run) * moving,
        1.16 - run * 0.02, -0.18 - Math.max(0, -wave) * 0.09 * moving,
        Math.sin(this.phase - 0.5) * 0.016 * moving);
    }
    if (this.motions && !ko && !held) {
      this.sampleMotion('idle', this.time, true);
      const cycle = this.phase / TAU;
      this.sampleMotion('walk', cycle * this.motions.walk.duration, true, moving);
      this.sampleMotion('run', cycle * this.motions.run.duration, true, run);
      if (airborne) {
        const clip = (p.vy ?? 0) >= 0 ? 'jump' : 'fall';
        const time = clip === 'jump' ? Math.min(this.airTime * 1.5, this.motions.jump.duration)
          : clamp(-(p.vy ?? 0) / 6.5, 0, 1) * this.motions.fall.duration;
        this.sampleMotion(clip, time);
      } else if (this.land > 0) {
        this.sampleMotion('land', (1 - this.land) * this.motions.land.duration, false, smooth(this.land) * 0.65);
      }
    }

    const holding = !!(p.carryFlag || p.heldBomb || p.heldPlayer);
    const throwT = p.throwT ?? 0;
    const punchT = p.punchT ?? 0;
    const hit = clamp(reaction.hitFlinch ?? 0, 0, 1);
    let rootPitch = 0, rootRoll = -this.turn * 0.012, rootY = 0, rootZ = 0;
    let response = 15;
    if ((p.dashT ?? 0) > 0 && !airborne) {
      this.joint('Waist', 0.10);
      this.joint('Spine01', 0.12);
      this.joint('Head', -0.15);
      this.arm('L', 0.25, 1.12, -0.18);
      this.arm('R', 0.25, 1.12, -0.18);
      rootPitch = 0.05;
      response = 20;
    }
    if (airborne) {
      const tuck = smooth(((p.vy ?? 0) + 1.5) / 6);
      if (!this.motions) {
        this.leg('L', -0.20 - tuck * 0.16, 0.38 + tuck * 0.25, -0.14);
        this.leg('R', -0.15 - tuck * 0.16, 0.36 + tuck * 0.22, -0.12);
        this.arm('L', -0.16, 1.02, -0.28);
        this.arm('R', -0.16, 1.02, -0.28);
      }
      rootPitch = clamp(-(p.vy ?? 0) * 0.014, -0.09, 0.11);
      if (!this.motions) this.joint('Head', -0.08 - rootPitch * 0.45);
    }
    if (holding) {
      // Open shoulders, then reach forward/up. The arms clear the head and jacket.
      this.arm('L', 0.22, -1.28, 0.28, 0.05);
      this.arm('R', 0.22, -1.28, 0.28, 0.05);
      this.joint('Spine01', -0.045, 0, 0);
      this.joint('Head', 0.02);
    }
    if (throwT > 0) {
      // Two-hand windup, release and follow-through; same .35s gameplay timer.
      const t = clamp(1 - throwT / 0.35, 0, 1);
      let shoulder, elbow, chest, open;
      if (t < 0.28) {
        const a = smooth(t / 0.28);
        shoulder = lerp(0.22, -0.20, a); elbow = lerp(0.28, -0.30, a); chest = -0.08 * a; open = -1.08;
      } else if (t < 0.62) {
        const a = smooth((t - 0.28) / 0.34);
        shoulder = lerp(-0.20, 1.02, a); elbow = lerp(-0.30, 0.10, a); chest = lerp(-0.08, 0.10, a); open = -1.08;
      } else {
        const a = smooth((t - 0.62) / 0.38);
        shoulder = lerp(1.02, -0.10, a); elbow = lerp(0.10, -0.18, a); chest = lerp(0.10, 0.025, a); open = lerp(-1.08, 1.16, a);
      }
      this.arm('L', shoulder, open, elbow, -0.06);
      this.arm('R', shoulder, open, elbow, -0.06);
      this.joint('Spine01', chest);
      this.joint('Head', -chest * 0.5);
      response = 24;
    } else if (punchT > 0 && !holding) {
      // A grounded alternating jab, driven by torso rotation rather than a mesh lunge.
      const t = clamp(1 - punchT / 0.3, 0, 1);
      const reach = t < 0.18 ? -0.18 * smooth(t / 0.18)
        : t < 0.48 ? lerp(-0.18, 1, smooth((t - 0.18) / 0.30))
          : 1 - smooth((t - 0.48) / 0.52);
      const active = p.punchArm ? 'L' : 'R';
      const guard = p.punchArm ? 'R' : 'L';
      const sign = p.punchArm ? 1 : -1;
      this.arm(active, -0.25 - Math.max(0, reach) * 0.78, 1.10,
        lerp(-0.42, -0.05, Math.max(0, reach)), 0);
      this.arm(guard, -0.22, 1.14, -0.32);
      this.joint('Spine01', 0.035 + Math.max(0, reach) * 0.05, sign * reach * 0.14);
      this.joint('Head', -0.07, -sign * reach * 0.05);
      response = 24;
    }
    if (hit > 0 && !held && !ko) {
      const direction = reaction.hitDir || 1;
      this.joint('Spine01', -0.12 * hit, direction * 0.08 * hit);
      this.joint('Head', -0.07 * hit, -direction * 0.06 * hit);
      this.arm('L', 0.16 * hit, 1.0, -0.35);
      this.arm('R', 0.16 * hit, 1.0, -0.35);
      rootPitch = -0.06 * hit; rootRoll += direction * 0.035 * hit;
      rootZ = -0.02 * hit;
      response = 20;
    }
    if (held) {
      const struggle = Math.sin(this.time * 3.2);
      this.leg('L', -0.15 - struggle * 0.07, 0.40 + Math.max(0, struggle) * 0.08, -0.12);
      this.leg('R', -0.15 + struggle * 0.07, 0.40 + Math.max(0, -struggle) * 0.08, -0.12);
      this.arm('L', -0.26 + struggle * 0.05, 1.02, -0.32);
      this.arm('R', -0.26 - struggle * 0.05, 1.02, -0.32);
      this.joint('Spine01', 0.025, struggle * 0.012);
      this.joint('Head', -0.025, Math.sin(this.time * 2.3) * 0.018);
      rootPitch = -Math.PI / 2 + 0.16;
      rootRoll = struggle * 0.015;
      rootY = 0.25;
    } else if (ko) {
      this.leg('L', -0.10, 0.28, -0.10);
      this.leg('R', -0.18, 0.34, -0.14);
      this.arm('L', 0.10, 0.78, -0.20);
      this.arm('R', 0.18, 0.84, -0.25);
      this.joint('Spine01', 0.03);
      this.joint('Head', -0.03, 0.04);
      rootPitch = -Math.PI / 2 + 0.08;
      rootRoll = 0.08;
      response = 9;
    } else if (this.getUp > 0 && !airborne && !holding && !punchT && !throwT) {
      const weight = smooth(this.getUp / 0.65);
      this.leg('L', -0.10 - weight * 0.30, 0.22 + weight * 0.55, -0.14);
      this.leg('R', -0.15 - weight * 0.35, 0.28 + weight * 0.50, -0.16);
      this.arm('L', -0.18, 0.96, -0.22 - weight * 0.12);
      this.arm('R', -0.24, 1.02, -0.22 - weight * 0.14);
      this.joint('Spine01', 0.14 * weight);
      this.joint('Head', -0.08 * weight);
      rootPitch = (-Math.PI / 2 + 0.08) * weight;
      rootRoll = 0.08 * weight;
    }

    this.updateTail(dt, moving, run, airborne, ko, held);
    const alpha = this.initialized ? 1 - Math.exp(-response * dt) : 1;
    this.pose.rotation.x = damp(this.pose.rotation.x, rootPitch, ko ? 8 : 14, dt);
    this.pose.rotation.y = damp(this.pose.rotation.y, 0, 14, dt);
    this.pose.rotation.z = damp(this.pose.rotation.z, rootRoll, 14, dt);
    this.pose.position.set(0, rootY, 0);
    this.model.position.copy(this.restRoot); this.model.position.z += rootZ;
    this.model.quaternion.identity();
    this.pose.updateWorldMatrix(true, false);
    this.model.updateMatrixWorld(true);
    this.model.matrixWorld.decompose(this.scratchPosition, this.modelQ, this.scratchScale);
    for (const e of this.entries) {
      e.bone.position.copy(e.position); e.bone.scale.copy(e.scale);
      this.target.copy(e.hasMotion ? e.motion : e.rest);
      if (e.angles[0] || e.angles[1] || e.angles[2]) {
        // Entries follow hierarchy order, so their parent matrices are current.
        e.bone.parent.matrixWorld.decompose(this.scratchPosition, this.parentInverse, this.scratchScale);
        this.parentInverse.invert().multiply(this.modelQ);
        this.delta.identity();
        for (let a = 0; a < 3; a++) {
          if (!e.angles[a]) continue;
          this.axes[a].set(a === 0 ? 1 : 0, a === 1 ? 1 : 0, a === 2 ? 1 : 0).applyQuaternion(this.parentInverse);
          this.q.setFromAxisAngle(this.axes[a], e.angles[a]);
          this.delta.multiply(this.q);
        }
        this.target.premultiply(this.delta).normalize();
      }
      e.current.slerp(this.target, e.tail ? 1 : alpha).normalize();
      e.bone.quaternion.copy(e.current);
      e.bone.updateWorldMatrix(false, false);
    }
    this.initialized = true;
    // SkinnedMesh refreshes bindMatrixInverse in updateMatrixWorld, not in
    // Object3D.updateWorldMatrix. Refresh it before CPU skin/floor queries.
    this.pose.updateWorldMatrix(true, false);
    this.model.updateMatrixWorld(true);
    if (!held && (p.y ?? 0) >= -0.05) {
      let lowest = Infinity;
      this.rigInverse.copy(this.pose.parent.matrixWorld).invert();
      for (const { mesh, samples } of this.support) {
        mesh.skeleton.update();
        const matrices = mesh.skeleton.boneMatrices;
        this.contactMatrix.multiplyMatrices(mesh.matrixWorld, mesh.bindMatrixInverse).premultiply(this.rigInverse);
        for (let s = 0; s < samples.length; s += 11) {
          const bx = samples[s], by = samples[s + 1], bz = samples[s + 2];
          let x = 0, y = 0, z = 0;
          for (let c = 0; c < 4; c++) {
            const weight = samples[s + 3 + c];
            if (!weight) continue;
            const m = samples[s + 7 + c];
            x += weight * (matrices[m] * bx + matrices[m + 4] * by + matrices[m + 8] * bz + matrices[m + 12]);
            y += weight * (matrices[m + 1] * bx + matrices[m + 5] * by + matrices[m + 9] * bz + matrices[m + 13]);
            z += weight * (matrices[m + 2] * bx + matrices[m + 6] * by + matrices[m + 10] * bz + matrices[m + 14]);
          }
          this.v.set(x, y, z).applyMatrix4(this.contactMatrix);
          lowest = Math.min(lowest, this.v.y);
        }
      }
      if (Number.isFinite(lowest)) {
        const correction = 0.05 - lowest;
        if (!airborne) this.pose.position.y += correction;
        else if (lowest + (p.y ?? 0) < 0.05) this.pose.position.y += 0.05 - lowest - (p.y ?? 0);
      }
    }
  }
}
