// Numerical pose/skin audit; render-style matrix updates expose stale binds.
// Usage: node scripts/audit-macaco-animation.mjs [model.glb]
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { registerHooks } from 'node:module';
import { loadMacacoRig } from './macaco-rig-utils.mjs';
import { packState } from '../src/net/protocol.js';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
registerHooks({ resolve(specifier, context, nextResolve) {
  return nextResolve(specifier === 'three' ? pathToFileURL(path.join(repository, 'vendor/three.module.js')).href : specifier, context);
} });
const { MonkeyAnimator } = await import('../src/render/monkey-animation.js');
const filename = path.resolve(process.argv[2] || path.join(repository, 'models/macaco.glb'));
const motionData = JSON.parse(fs.readFileSync(path.join(repository, 'assets/animations/macaco-reference.json'), 'utf8'));
function createAnimator() {
  const rig = loadMacacoRig(filename), THREE = rig.THREE;
  const box = new THREE.Box3().setFromObject(rig.root);
  const size = box.getSize(new THREE.Vector3()), center = box.getCenter(new THREE.Vector3());
  rig.root.position.set(-center.x, -box.min.y + 0.05, -center.z);
  const inner = new THREE.Group(), model = new THREE.Group(), pose = new THREE.Group(), group = new THREE.Group();
  inner.add(rig.root); inner.rotation.y = -Math.PI / 2;
  model.add(inner); model.scale.setScalar(2.2 / size.y);
  pose.add(model); group.add(pose); group.updateMatrixWorld(true);
  const baseline = rig.deform();
  return { rig, model, pose, group, baseline, animator: new MonkeyAnimator(model, pose, rig.bones, motionData) };
}
const cases = {
  idle: {}, walk: { spd: 2.5, vx: 2.5 }, run: { spd: 7, vx: 7 },
  jump: { spd: 5, y: 1, vy: 5 }, fall: { spd: 4, y: 1, vy: -6 },
  carryBomb: { heldBomb: 1 }, carryFlag: { carryFlag: 1 }, carryPlayer: { heldPlayer: 'other' },
  dash: { dashT: 0.20, spd: 9 }, landing: { transition: 'landing' },
  recovery: { transition: 'recovery' }, respawn: { transition: 'respawn' },
  runCarry: { spd: 7, vx: 7, heldBomb: 1 }, runThrow: { spd: 7, vx: 7, throwT: 0.27 },
  runPunchL: { spd: 7, vx: 7, punchT: 0.16, punchArm: 1 },
  runPunchR: { spd: 7, vx: 7, punchT: 0.16, punchArm: 0 },
  airborneCarry: { spd: 5, y: 1, vy: 5, heldBomb: 1 },
  turn: { spd: 7, transition: 'turn' }, freezeUnfreeze: { spd: 7, transition: 'freeze' },
  held: { heldBy: 'another', y: 1.6 }, ko: { state: 'ko' }, knocked: { knockT: 1 },
  hit: { reaction: { hitFlinch: 1, hitDir: 1 } }, frozen: { frozenT: 1 },
};
for (const timer of [0.30, 0.26, 0.20, 0.16, 0.08, 0.01]) {
  for (const side of ['L', 'R']) cases[`punch${side}-${timer}`] = { punchT: timer, punchArm: side === 'L' ? 1 : 0 };
}
for (const timer of [0.35, 0.27, 0.18, 0.12, 0.06]) cases[`throw-${timer}`] = { throwT: timer };
const report = {};
const failures = [];
for (const name of ['idle', 'walk', 'run', 'jump', 'land', 'fall']) {
  const clip = motionData.motions[name];
  if (!clip || clip.duration <= 0 || clip.count < 2) { failures.push(`${name}: empty reference clip`); continue; }
  for (const values of Object.values(clip.rotations)) {
    if (values.length !== clip.count * 4 || values.some(value => !Number.isFinite(value))) failures.push(`${name}: invalid reference rotations`);
  }
}
// The added tail must skin actual vertices, preserve the bind pose, and bend
// smoothly without pulling the jacket, face or legs along with it.
const tailRig = loadMacacoRig(filename);
const tailIndices = new Set(Object.entries(tailRig.bones).filter(([name]) => /^Tail\d{2}$/.test(name))
  .map(([, bone]) => tailRig.mesh.skeleton.bones.indexOf(bone)));
if (tailIndices.size !== 6) failures.push('tail: six joints required');
let tailWeightError = 0;
const tailVertices = new Set();
const joints = tailRig.geometry.attributes.skinIndex, weights = tailRig.geometry.attributes.skinWeight;
for (let index = 0; index < weights.count; index++) {
  let sum = 0;
  for (let c = 0; c < 4; c++) {
    sum += weights.getComponent(index, c);
    if (tailIndices.has(joints.getComponent(index, c)) && weights.getComponent(index, c) > 0) tailVertices.add(index);
  }
  tailWeightError = Math.max(tailWeightError, Math.abs(1 - sum));
}
if (tailVertices.size < 100 || tailWeightError > 1e-6) failures.push('tail: invalid skin influences');
for (const name of Object.keys(tailRig.bones).filter(name => /^Tail\d{2}$/.test(name))) {
  tailRig.bones[name].quaternion.multiply(new tailRig.THREE.Quaternion().setFromAxisAngle(new tailRig.THREE.Vector3(0, 0, 1), 0.055));
}
const tailDeformed = tailRig.deform();
let bodyDelta = 0, tailDelta = 0;
for (let index = 0; index < tailDeformed.length; index++) {
  const delta = tailDeformed[index].distanceTo(tailRig.rest[index]);
  if (tailVertices.has(index)) tailDelta = Math.max(tailDelta, delta);
  else bodyDelta = Math.max(bodyDelta, delta);
}
const tailEdges = tailRig.edgeRatios(tailDeformed, index => tailVertices.has(index));
if (bodyDelta > 1e-7 || tailDelta < 0.002 || tailEdges.max > 1.65) failures.push('tail: mesh bend/attachment failed');
const tailMotion = createAnimator();
tailMotion.animator.update({state:'alive',y:0,face:0,spd:0}, 1 / 60);
const initialTail = tailMotion.rig.bones.Tail06.quaternion.clone();
for (let frame = 0; frame < 90; frame++) tailMotion.animator.update({state:'alive',y:0,face:0,spd:6.8}, 1 / 60);
if (tailMotion.rig.bones.Tail06.quaternion.angleTo(initialTail) < 0.002) failures.push('tail: no running motion');
const instances = [];
for (const [label, data] of Object.entries(cases)) {
  const { rig, pose, group, baseline, animator } = createAnimator();
  instances.push({ animator, group });
  const player = { state: 'alive', face: 0, y: 0, vy: 0, ...data };
  const boneRest = Object.values(rig.bones).map(bone => ({ bone, position: bone.position.clone(), scale: bone.scale.clone() }));
  let boneError = 0, floorMin = Infinity, rootMax = 0;
  let freezeSnapshot;
  let maxRatio = 0, minRatio = Infinity, p99 = 0, minY = Infinity, poseY = 0, finite = true, headError = 0;
  for (let frame = 0; frame < 90; frame++) {
    if (['landing', 'recovery', 'respawn'].includes(data.transition)) {
      player.state = frame < 20 && data.transition !== 'landing' ? 'ko' : 'alive';
      player.y = frame < 20 && data.transition === 'landing' ? 1 : 0;
      player.vy = player.y ? -3 : 0;
      player.invuln = frame >= 20 && data.transition === 'respawn' ? 1 : 0;
    }
    if (data.transition === 'turn') {
      const angle = Math.max(0, frame - 20) * 0.18;
      player.face = Math.atan2(Math.sin(angle), Math.cos(angle));
    }
    if (data.transition === 'freeze') {
      player.frozenT = frame >= 20 && frame < 50 ? 1 : 0;
      player.spd = player.frozenT ? 0 : 7;
      if (frame === 20) freezeSnapshot = boneRest.map(({ bone }) => bone.quaternion.clone());
    }
    group.position.y = player.y;
    group.rotation.y = player.face;
    group.updateMatrixWorld(true);
    animator.update(player, 1 / 60, data.reaction || {});
    group.updateMatrixWorld(true);
    if (data.transition === 'freeze' && player.frozenT) {
      for (let index = 0; index < boneRest.length; index++) {
        if (!boneRest[index].bone.quaternion.equals(freezeSnapshot[index])) failures.push(`${label}: frozen bone moved`);
      }
    }
    rootMax = Math.max(rootMax, Math.abs(pose.position.y));
    for (const { bone, position, scale } of boneRest) boneError = Math.max(boneError, bone.position.distanceTo(position), bone.scale.distanceTo(scale));
    if (frame % 5 !== 0 && frame !== 89 && frame !== 20 && frame !== 21) continue;
    const vertices = rig.deform();
    finite &&= vertices.every(vertex => Number.isFinite(vertex.x + vertex.y + vertex.z));
    const edges = rig.edgeRatios(vertices, undefined, baseline);
    const head = rig.edgeRatios(vertices, index => rig.geometry.attributes.position.getY(index) > 0.70, baseline);
    headError = Math.max(headError, Math.abs(1 - head.min), Math.abs(1 - head.max));
    maxRatio = Math.max(maxRatio, edges.max); minRatio = Math.min(minRatio, edges.min); p99 = Math.max(p99, edges.p99);
    minY = Math.min(minY, ...vertices.map(vertex => vertex.y));
    if (!player.heldBy) floorMin = Math.min(floorMin, ...vertices.map(vertex => vertex.y));
    poseY = pose.position.y;
  }
  if (!finite) failures.push(`${label}: nonfinite skinned vertex`);
  if (headError > 0.002) failures.push(`${label}: upper head deforms`);
  if (rootMax > 4) failures.push(`${label}: root drift (${rootMax})`);
  if (boneError > 1e-8) failures.push(`${label}: translated/scaled bone`);
  if (floorMin < -0.003) failures.push(`${label}: floor penetration (${floorMin})`);
  if (maxRatio > 4 || p99 > 1.75) failures.push(`${label}: excessive skin deformation (${maxRatio}/${p99})`);
  report[label] = { minY: +minY.toFixed(4), poseY: +poseY.toFixed(4), maxEdge: maxRatio, p99,
    minEdge: minRatio, headError, boneError, rootMax: +rootMax.toFixed(4) };
}
// Replicate the real network packet rather than manually selecting fields.
// Losing vy or dashT changes the remote pose and causes this comparison to fail.
const remoteParity = {};
for (const label of ['jump', 'fall', 'dash']) {
  const host = createAnimator(), remote = createAnimator();
  const player = { id: 7, characterId: 'macaco', hp: 100, x: 0, z: 0, vx: 0, vz: 0,
    state: 'alive', face: 0, y: 0, vy: 0, ...cases[label] };
  const packed = packState({ players: [player], bombs: [], scores: {}, tick: 1, phase: 'playing' }).players[0];
  for (let frame = 0; frame < 60; frame++) for (const [instance, p] of [[host, player], [remote, packed]]) {
    instance.group.position.y = p.y;
    instance.group.updateMatrixWorld(true);
    instance.animator.update(p, 1 / 60);
    instance.group.updateMatrixWorld(true);
  }
  let difference = host.pose.position.distanceTo(remote.pose.position);
  difference = Math.max(difference, host.pose.quaternion.angleTo(remote.pose.quaternion));
  for (const [name, bone] of Object.entries(host.rig.bones)) difference = Math.max(difference, bone.quaternion.angleTo(remote.rig.bones[name].quaternion));
  remoteParity[label] = +difference.toFixed(8);
  if (difference > 1e-6) failures.push(`${label}: packed remote animation differs (${difference})`);
}
const updateCosts = [];
const benchmark = instances.slice(0, 20);
for (let frame = 0; frame < 30; frame++) {
  const start = performance.now();
  for (const { animator, group } of benchmark) {
    animator.update({ state: 'alive', face: 0, y: 0, spd: 7 }, 1 / 60);
    group.updateMatrixWorld(true);
  }
  updateCosts.push(performance.now() - start);
}
updateCosts.sort((a, b) => a - b);
const cpu = { characters: benchmark.length, medianMs: +updateCosts[15].toFixed(2), p95Ms: +updateCosts[28].toFixed(2) };
console.log(JSON.stringify({ model: path.relative(repository, filename), failures, cpu, remoteParity,
  tail: { joints: tailIndices.size, vertices: tailVertices.size, bodyDelta, tailDelta, edges: tailEdges } }));
console.table(Object.entries(report).map(([state, row]) => ({ state, minY: row.minY, poseY: row.poseY, maxEdge: row.maxEdge, p99: row.p99 })));
if (failures.length) process.exitCode = 1;
