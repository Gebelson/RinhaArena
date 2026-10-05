// Retarget the supplied Monkey.fbx; only animation data enters the game.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as THREE from 'three';
import { loadMacacoRig } from './macaco-rig-utils.mjs';
import { MonkeyAnimator } from '../src/render/monkey-animation.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const input = path.resolve(process.argv.slice(2).find(value => !value.startsWith('--')) || path.join(root, '../monkey-reference/Monkey.fbx'));
// This exporter names curve nodes "Lcl Rotation", etc. FBXLoader expects
// R/T/S. Normalize those names in a temporary loader without editing Three.js.
const loaderPath = path.join(root, 'node_modules/three/examples/jsm/loaders/FBXLoader.js');
const temporaryLoader = loaderPath.replace('.js', 'Reference.js');
fs.writeFileSync(temporaryLoader, fs.readFileSync(loaderPath, 'utf8').replace(
  'attr: rawCurveNode.attrName,',
  "attr: ({ 'Lcl Translation': 'T', 'Lcl Rotation': 'R', 'Lcl Scaling': 'S' })[rawCurveNode.attrName] || rawCurveNode.attrName,"));
globalThis.window = { URL, innerWidth: 1280, innerHeight: 720 };
THREE.TextureLoader.prototype.load = () => new THREE.Texture();
const { FBXLoader } = await import(pathToFileURL(temporaryLoader).href);
const buffer = fs.readFileSync(input);
const source = new FBXLoader().parse(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength), path.dirname(input));
const sourceBones = {};
source.traverse(object => { if (object.isBone) sourceBones[object.name] = object; });
if (process.argv.includes('--inspect')) {
  console.log(JSON.stringify(source.animations.map(clip => ({ name: clip.name, duration: clip.duration, tracks: clip.tracks.length })), null, 2));
  source.updateMatrixWorld(true);
  for (const name of ['Monkey_Pelvis_02', 'Monkey_Head_06', 'Monkey_L_Thigh_042', 'Monkey_L_Calf_043', 'Monkey_L_Foot_044', 'Monkey_L_UpperArm_031', 'Monkey_Tail_050']) {
    console.log(name, sourceBones[name].getWorldPosition(new THREE.Vector3()).toArray().map(value => +value.toFixed(3)));
  }
  process.exit(0);
}

const target = loadMacacoRig(path.join(root, 'models/macaco.glb'));
const targetBox = new target.THREE.Box3().setFromObject(target.root);
const targetSize = targetBox.getSize(new target.THREE.Vector3()), targetCenter = targetBox.getCenter(new target.THREE.Vector3());
target.root.position.set(-targetCenter.x, -targetBox.min.y + 0.05, -targetCenter.z);
const inner = new target.THREE.Group(), model = new target.THREE.Group(), pose = new target.THREE.Group(), group = new target.THREE.Group();
inner.add(target.root); inner.rotation.y = -Math.PI / 2; model.add(inner); model.scale.setScalar(2.2 / targetSize.y);
pose.add(model); group.add(pose);
const neutral = new MonkeyAnimator(model, pose, target.bones);
for (let i = 0; i < 60; i++) neutral.update({state:'alive',y:0,face:0,spd:0}, 1 / 60);
for (const entry of neutral.tail) entry.bone.quaternion.copy(entry.rest);
group.updateMatrixWorld(true);
// The reference's exported static pose differs from its animation neutral.
// Calibrate against the actual Idle clip and transfer its motion onto the
// mascot's relaxed stance, rather than copying an incompatible T-pose offset.
const mixer = new THREE.AnimationMixer(source), fps = 30;
const idleAction = mixer.clipAction(source.animations.find(clip => clip.name === 'Idle'));
idleAction.play(); mixer.setTime(0); source.updateMatrixWorld(true);
target.root.updateMatrixWorld(true);
const mapping = {
  Hip: 'Monkey_Pelvis_02', Waist: 'Monkey_Spine_03', Spine01: 'Monkey_Spine1_00',
  Spine02: 'Monkey_Spine2_04', Head: 'Monkey_Head_06',
};
for (const side of ['L', 'R']) {
  const suffix = side === 'L' ? ['030','031','032','033','042','043','044','045'] : ['036','037','038','039','046','047','048','049'];
  const parts = ['Clavicle', 'Upperarm', 'Forearm', 'Hand', 'Thigh', 'Calf', 'Foot', 'ToeBase'];
  const sourceParts = ['Clavicle', 'UpperArm', 'Forearm', 'Hand', 'Thigh', 'Calf', 'Foot', 'Toe0'];
  parts.forEach((part, i) => mapping[`${side}_${part}`] = `Monkey_${side}_${sourceParts[i]}_${suffix[i]}`);
}
const tailSource = ['Monkey_Tail_050','Monkey_Tail02_051','Monkey_Tail03_052','Monkey_Tail04_053','Monkey_Tail05_054','Monkey_Tail06_055','Monkey_Tail07_056','Monkey_Tail08_057'];
for (let i = 0; i < 6; i++) mapping[`Tail0${i + 1}`] = tailSource[Math.round(i * 7 / 5)];
for (const [name, original] of Object.entries(mapping)) if (!target.bones[name] || !sourceBones[original]) throw new Error(`Missing retarget joint: ${name}/${original}`);
function frame(bones, left, right) {
  const x = bones[left].getWorldPosition(new THREE.Vector3()).sub(bones[right].getWorldPosition(new THREE.Vector3()));
  x.y = 0; x.normalize();
  const y = new THREE.Vector3(0, 1, 0), z = x.clone().cross(y).normalize();
  return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
}
const alignment = frame(target.bones, 'L_Thigh', 'R_Thigh')
  .multiply(frame(sourceBones, 'Monkey_L_Thigh_042', 'Monkey_R_Thigh_046').invert());
const sourceFrameInverse = frame(sourceBones, 'Monkey_L_Thigh_042', 'Monkey_R_Thigh_046').invert();
const sourceRest = Object.fromEntries(Object.entries(sourceBones).map(([name, bone]) =>
  [name, bone.quaternion.clone().invert()]));
const sourceParent = Object.fromEntries(Object.entries(sourceBones).map(([name, bone]) =>
  [name, bone.parent.getWorldQuaternion(new THREE.Quaternion())]));
mixer.stopAllAction();
const entries = [];
target.root.traverse(bone => {
  if (bone.isBone) {
    const originalBone = sourceBones[mapping[bone.name]];
    const basis = new THREE.Quaternion().fromArray(bone.parent.getWorldQuaternion(new target.THREE.Quaternion()).toArray()).invert();
    if (originalBone) basis.multiply(alignment).multiply(sourceParent[originalBone.name]);
    entries.push({ bone, local: new THREE.Quaternion().fromArray(bone.quaternion.toArray()), basis, inverseBasis: basis.clone().invert() });
  }
});
const selected = { idle: 'Idle', walk: 'Walk_In_Place', run: 'Run_In_Place', jump: 'Jump_Up', land: 'Land', fall: 'Fall' };
const motions = {};
const scratch = new THREE.Quaternion(), local = new THREE.Quaternion();
for (const [name, original] of Object.entries(selected)) {
  const clip = source.animations.find(clip => clip.name === original);
  if (!clip?.tracks.length) throw new Error(`Reference clip is empty: ${original}`);
  const action = mixer.clipAction(clip); action.setLoop(THREE.LoopOnce, 1); action.clampWhenFinished = true; action.play();
  const count = Math.ceil(clip.duration * fps) + 1, rotations = Object.fromEntries(Object.keys(mapping).map(name => [name, []]));
  const feet = { L: [], R: [] };
  for (let index = 0; index < count; index++) {
    action.reset().play(); mixer.setTime(index / (count - 1) * clip.duration);
    source.updateMatrixWorld(true);
    for (const side of ['L', 'R']) {
      const foot = sourceBones[side === 'L' ? 'Monkey_L_Foot_044' : 'Monkey_R_Foot_048'].getWorldPosition(new THREE.Vector3());
      foot.sub(sourceBones.Monkey_Pelvis_02.getWorldPosition(new THREE.Vector3())).applyQuaternion(sourceFrameInverse);
      feet[side].push(foot.z, foot.y);
    }
    for (const entry of entries) {
      const originalBone = sourceBones[mapping[entry.bone.name]];
      local.copy(entry.local);
      if (originalBone) {
        // Transport the local rotational delta through the two rest frames.
        // Clamping a parent must not make its child counter-rotate to restore
        // the source's world pose: that folds short knees and stretches cuffs.
        scratch.copy(originalBone.quaternion).multiply(sourceRest[originalBone.name]);
        scratch.premultiply(entry.basis).multiply(entry.inverseBasis);
        local.copy(scratch).multiply(entry.local).normalize();
        // Preserve the mascot's short limbs, rigid crown and curled tail.
        const limit = entry.bone.name.startsWith('Tail') ? 0.10
          : /Upperarm/.test(entry.bone.name) ? 0.50 : /Clavicle/.test(entry.bone.name) ? 0.07
            : /Forearm/.test(entry.bone.name) ? 0.25 : /Calf/.test(entry.bone.name) ? 0.45 : /Thigh/.test(entry.bone.name) ? 0.42
              : /Hand/.test(entry.bone.name) ? 0.14 : /Foot/.test(entry.bone.name) ? 0.24 : /Toe/.test(entry.bone.name) ? 0.10
                : entry.bone.name === 'Head' ? 0.18 : entry.bone.name === 'Hip' ? 0.06 : 0.085;
        const angle = entry.local.angleTo(local);
        if (angle > limit) { scratch.copy(local); local.copy(entry.local).slerp(scratch, limit / angle); }
        rotations[entry.bone.name].push(...local.toArray().map(value => +value.toFixed(6)));
      }
      entry.bone.quaternion.fromArray(local.toArray());
      entry.bone.updateWorldMatrix(false, false);
    }
  }
  if (['idle', 'walk', 'run'].includes(name)) for (const values of Object.values(rotations)) values.splice(-4, 4, ...values.slice(0, 4));
  for (const values of Object.values(feet)) {
    const z = values.filter((_, i) => i % 2 === 0), y = values.filter((_, i) => i % 2 === 1);
    const minZ = Math.min(...z), maxZ = Math.max(...z), minY = Math.min(...y), maxY = Math.max(...y);
    for (let i = 0; i < count; i++) {
      values[i * 2] = +((z[i] - minZ) / (maxZ - minZ || 1) * 2 - 1).toFixed(6);
      values[i * 2 + 1] = +Math.max(0, Math.min(1, ((y[i] - minY) / (maxY - minY || 1) - 0.15) / 0.85)).toFixed(6);
    }
    if (['idle', 'walk', 'run'].includes(name)) values.splice(-2, 2, ...values.slice(0, 2));
  }
  motions[name] = { duration: +clip.duration.toFixed(6), count, rotations, feet };
  mixer.stopAllAction();
}
const output = path.join(root, 'assets/animations/macaco-reference.json');
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, JSON.stringify({ version: 1, source: 'Monkey.fbx supplied by user', fps, motions }));
console.log(`Retargeted ${Object.keys(motions).length} clips, ${fs.statSync(output).size} bytes.`);
