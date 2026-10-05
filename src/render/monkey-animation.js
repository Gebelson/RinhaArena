import * as THREE from 'three';
import { clamp, lerp } from '../core/math.js';

const TAU = Math.PI * 2;
const smooth = (x) => { x = clamp(x, 0, 1); return x * x * (3 - 2 * x); };
const damp = (from, to, rate, dt) => lerp(from, to, 1 - Math.exp(-rate * dt));
const supportCache = new WeakMap();

// This rig has different rest axes on the head, hands and mirrored limbs.
// Work in the character's anatomical frame, never add angles to FBX Eulers.
export class MonkeyAnimator {
  constructor(model, pose, bones) {
    this.model = model;
    this.pose = pose;
    this.bones = bones;
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
        position: bone.position.clone(), scale: bone.scale.clone(), angles: new Float32Array(3) };
      this.entries.push(entry);
      this.byName[bone.name] = entry;
    });
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
      } else this.getUp = 0.65;
    }
    this.wasKO = ko;
    this.getUp = Math.max(0, this.getUp - dt);
    this.time += dt;
    const desiredSpeed = ko || held ? 0 : clamp(p.spd ?? Math.hypot(p.vx ?? 0, p.vz ?? 0), 0, 10);
    this.speed = damp(this.speed, desiredSpeed, 12, dt);
    const moving = smooth(this.speed / 0.8);
    const run = smooth((this.speed - 2.5) / 4.3);
    if (!airborne && !held && !ko) this.phase += TAU * lerp(1.35, 2.6, run) * moving * dt;
    if (this.wasAirborne && !airborne && !held && !ko) this.land = 1;
    this.wasAirborne = airborne;
    this.land = Math.max(0, this.land - dt * 5.5);
    const landing = Math.sin(this.land * Math.PI) * 0.16;
    let turnTarget = 0;
    const face = Number.isFinite(p.face) ? p.face : 0;
    if (this.lastFace !== null && dt > 0) {
      const delta = Math.atan2(Math.sin(face - this.lastFace), Math.cos(face - this.lastFace));
      turnTarget = clamp(delta / dt, -3, 3) * moving;
    }
    this.lastFace = face;
    this.turn = damp(this.turn, turnTarget, 9, dt);
    for (const e of this.entries) e.angles.fill(0);

    const stride = Math.sin(this.phase);
    const breath = Math.sin(this.time * 2.2);
    const lean = 0.11 + run * 0.20 + landing;
    this.joint('Hip', lean * 0.12, stride * moving * 0.035, -this.turn * 0.018);
    this.joint('Waist', lean * 0.35, -stride * moving * 0.022);
    this.joint('Spine01', lean * 0.35, stride * moving * 0.025);
    this.joint('Spine02', lean * 0.20 + breath * 0.008, -stride * moving * 0.018);
    this.joint('Head', -lean * 0.65, Math.sin(this.time * 0.7) * 0.018 * (1 - moving));
    for (const side of ['L', 'R']) {
      const wave = side === 'L' ? stride : -stride;
      const recovery = Math.max(0, wave);
      const amplitude = lerp(0.23, 0.46, run) * moving;
      const crouch = 0.10 + 0.09 * run + landing;
      this.leg(side, -crouch - wave * amplitude,
        crouch * 1.7 + recovery * lerp(0.28, 0.62, run) * moving,
        wave * amplitude * 0.40 - crouch * 0.55);
      // Opposite arm/leg timing, relaxed elbows and delayed wrist follow-through.
      this.arm(side, -0.14 + wave * lerp(0.24, 0.48, run) * moving,
        1.13 - run * 0.04, -0.22 - Math.max(0, -wave) * 0.20 * moving,
        Math.sin(this.phase - 0.4) * 0.035 * moving);
    }

    const holding = !!(p.carryFlag || p.heldBomb || p.heldPlayer);
    const throwT = p.throwT ?? 0;
    const punchT = p.punchT ?? 0;
    const hit = clamp(reaction.hitFlinch ?? 0, 0, 1);
    let rootPitch = 0, rootRoll = -this.turn * 0.025, rootY = 0, rootZ = 0;
    let response = 15;
    if ((p.dashT ?? 0) > 0 && !airborne) {
      this.joint('Waist', 0.10);
      this.joint('Spine01', 0.12);
      this.joint('Head', -0.15);
      this.arm('L', 0.25, 1.12, -0.18);
      this.arm('R', 0.25, 1.12, -0.18);
      rootPitch = 0.08;
      response = 24;
    }
    if (airborne) {
      const tuck = smooth(((p.vy ?? 0) + 1.5) / 6);
      this.leg('L', -0.23 - tuck * 0.24, 0.44 + tuck * 0.35, -0.16);
      this.leg('R', -0.14 - tuck * 0.24, 0.40 + tuck * 0.30, -0.12);
      this.arm('L', -0.24, 0.83, -0.37);
      this.arm('R', -0.24, 0.83, -0.37);
      rootPitch = clamp(-(p.vy ?? 0) * 0.025, -0.17, 0.20);
      this.joint('Head', -0.08 - rootPitch * 0.45);
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
        shoulder = lerp(-0.20, 1.20, a); elbow = lerp(-0.30, 0.10, a); chest = lerp(-0.08, 0.14, a); open = -1.08;
      } else {
        const a = smooth((t - 0.62) / 0.38);
        shoulder = lerp(1.20, -0.14, a); elbow = lerp(0.10, -0.22, a); chest = lerp(0.14, 0.035, a); open = lerp(-1.08, 1.13, a);
      }
      this.arm('L', shoulder, open, elbow, -0.06);
      this.arm('R', shoulder, open, elbow, -0.06);
      this.joint('Spine01', chest);
      this.joint('Head', -chest * 0.5);
      response = 28;
    } else if (punchT > 0 && !holding) {
      // A grounded alternating jab, driven by torso rotation rather than a mesh lunge.
      const t = clamp(1 - punchT / 0.3, 0, 1);
      const reach = t < 0.18 ? -0.18 * smooth(t / 0.18)
        : t < 0.48 ? lerp(-0.18, 1, smooth((t - 0.18) / 0.30))
          : 1 - smooth((t - 0.48) / 0.52);
      const active = p.punchArm ? 'L' : 'R';
      const guard = p.punchArm ? 'R' : 'L';
      const sign = p.punchArm ? 1 : -1;
      this.arm(active, -0.36 - Math.max(0, reach) * 1.00, 1.05,
        lerp(-0.55, -0.05, Math.max(0, reach)), 0);
      this.arm(guard, -0.36, 1.10, -0.48);
      this.joint('Spine01', 0.05 + Math.max(0, reach) * 0.08, sign * reach * 0.11);
      this.joint('Head', -0.07, -sign * reach * 0.05);
      response = 30;
    }
    if (hit > 0 && !held && !ko) {
      const direction = reaction.hitDir || 1;
      this.joint('Spine01', -0.12 * hit, direction * 0.08 * hit);
      this.joint('Head', -0.07 * hit, -direction * 0.06 * hit);
      this.arm('L', 0.16 * hit, 1.0, -0.35);
      this.arm('R', 0.16 * hit, 1.0, -0.35);
      rootPitch = -0.10 * hit; rootRoll += direction * 0.06 * hit;
      rootZ = -0.04 * hit;
      response = 24;
    }
    if (held) {
      const struggle = Math.sin(this.time * 8);
      this.leg('L', -0.15 - struggle * 0.19, 0.40 + Math.max(0, struggle) * 0.24, -0.12);
      this.leg('R', -0.15 + struggle * 0.19, 0.40 + Math.max(0, -struggle) * 0.24, -0.12);
      this.arm('L', -0.30 + struggle * 0.14, 0.9, -0.42);
      this.arm('R', -0.30 - struggle * 0.14, 0.9, -0.42);
      this.joint('Spine01', 0.03, struggle * 0.03);
      this.joint('Head', -0.025, Math.sin(this.time * 5) * 0.045);
      rootPitch = -Math.PI / 2 + 0.16;
      rootRoll = struggle * 0.035;
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
      this.target.copy(e.rest);
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
      e.current.slerp(this.target, alpha).normalize();
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
