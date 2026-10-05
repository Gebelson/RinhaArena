// Targeted, repeatable repair of the monkey's remote skin influences.
// Usage: node scripts/repair-macaco-skin.mjs [input.glb] [output.glb]
// Only WEIGHTS_0 and JOINTS_0 bytes change; the asset records the repair version.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from '../vendor/three.module.js';

const VERSION = 'neck-and-remote-influences-v1';
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const input = path.resolve(process.argv[2] || path.join(repository, 'models/macaco.glb'));
const output = path.resolve(process.argv[3] || input);
const original = fs.readFileSync(input);
let json;
let binary;
for (let offset = 12; offset < original.length;) {
  const length = original.readUInt32LE(offset);
  const type = original.readUInt32LE(offset + 4);
  if (type === 0x4e4f534a) json = JSON.parse(original.subarray(offset + 8, offset + 8 + length));
  if (type === 0x004e4942) binary = Buffer.from(original.subarray(offset + 8, offset + 8 + length));
  offset += length + 8;
}
if (json.asset.extras?.macacoSkinRepair === VERSION) {
  if (output !== input) fs.writeFileSync(output, original);
  console.log(`Skin repair ${VERSION} already applied.`);
  process.exit(0);
}
if (!json || !binary || json.skins.length !== 1 || json.meshes.length !== 1) {
  throw new Error('Expected the original monkey GLB with one mesh and one skin.');
}

const primitive = json.meshes[0].primitives[0];
const components = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };
function accessor(index) {
  const item = json.accessors[index];
  const view = json.bufferViews[item.bufferView];
  const width = item.componentType === 5126 ? 4 : item.componentType === 5123 ? 2 : 0;
  if (!width || item.sparse) throw new Error('Unsupported accessor storage.');
  const size = components[item.type];
  const start = (view.byteOffset || 0) + (item.byteOffset || 0);
  const stride = view.byteStride || size * width;
  const values = Array.from({ length: item.count * size }, (_, k) => {
    const offset = start + Math.floor(k / size) * stride + k % size * width;
    return width === 4 ? binary.readFloatLE(offset) : binary.readUInt16LE(offset);
  });
  return { item, values, start, stride, size, width };
}
const positions = accessor(primitive.attributes.POSITION);
const joints = accessor(primitive.attributes.JOINTS_0);
const weights = accessor(primitive.attributes.WEIGHTS_0);
const inverseBinds = accessor(json.skins[0].inverseBindMatrices).values;
const names = json.skins[0].joints.map(index => json.nodes[index].name);
const joint = Object.fromEntries(names.map((name, index) => [name, index]));
const head = joint.Head;
const thighs = [joint.L_Thigh, joint.R_Thigh];
const clavicles = [joint.L_Clavicle, joint.R_Clavicle];
const vertices = [];
const vertexOfCorner = [];
const lookup = new Map();
const smoothstep = (a, b, value) => {
  const t = Math.max(0, Math.min(1, (value - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
for (let corner = 0; corner < positions.item.count; corner++) {
  const position = positions.values.slice(corner * 3, corner * 3 + 3);
  const key = position.map(value => Math.round(value * 1e6)).join(',');
  let index = lookup.get(key);
  if (index === undefined) {
    index = vertices.length;
    lookup.set(key, index);
    vertices.push({ position, neighbors: new Set(), corners: [], original: new Float64Array(names.length) });
  }
  const vertex = vertices[index];
  vertex.corners.push(corner);
  vertexOfCorner.push(index);
  for (let k = 0; k < 4; k++) vertex.original[joints.values[corner * 4 + k]] += weights.values[corner * 4 + k];
}
for (const vertex of vertices) {
  for (let j = 0; j < names.length; j++) vertex.original[j] /= vertex.corners.length;
  vertex.repaired = vertex.original.slice();
}
const triangleIndices = primitive.indices === undefined
  ? Array.from({ length: positions.item.count }, (_, index) => index)
  : accessor(primitive.indices).values;
for (let corner = 0; corner < triangleIndices.length; corner += 3) {
  const indices = triangleIndices.slice(corner, corner + 3).map(index => vertexOfCorner[index]);
  for (let k = 0; k < 3; k++) {
    const a = indices[k];
    const b = indices[(k + 1) % 3];
    if (a !== b) { vertices[a].neighbors.add(b); vertices[b].neighbors.add(a); }
  }
}

// A head/neck boundary contained adjacent vertices with 0% and 83% Head.
// Smooth that scalar over the actual welded surface, anchored below the neck
// and above the lower face. Rigid upper head keeps crown and glasses together.
let headWeights = vertices.map(vertex => {
  const y = vertex.position[1];
  return y >= 0.70 ? 1 : y <= 0.51 ? 0 : vertex.original[head];
});
for (let iteration = 0; iteration < 20; iteration++) {
  headWeights = vertices.map((vertex, index) => {
    const y = vertex.position[1];
    if (y >= 0.70 || y <= 0.51 || !vertex.neighbors.size) return headWeights[index];
    let sum = 0;
    let total = 0;
    for (const neighbor of vertex.neighbors) {
      const other = vertices[neighbor].position;
      const length = Math.hypot(...vertex.position.map((value, axis) => value - other[axis]));
      const influence = 1 / Math.max(length, 0.004);
      sum += headWeights[neighbor] * influence;
      total += influence;
    }
    return headWeights[index] * 0.35 + sum / total * 0.65;
  });
}

function addTorso(vertex, amount) {
  if (!amount) return;
  const y = vertex.position[1];
  const upper = smoothstep(0.34, 0.57, y);
  const lower = 1 - upper;
  vertex.repaired[joint.Waist] += amount * lower;
  vertex.repaired[joint.Spine01] += amount * upper * (1 - smoothstep(0.47, 0.64, y));
  vertex.repaired[joint.Spine02] += amount * upper * smoothstep(0.47, 0.64, y);
}
for (let index = 0; index < vertices.length; index++) {
  const vertex = vertices[index];
  const [x, y, z] = vertex.position;
  const repaired = vertex.repaired;
  if (y > 0.51 && headWeights[index] > 0.0001) {
    const h = headWeights[index];
    // Neck and lower face connect to chest, rather than the two shoulders.
    // Keep only the supported torso weights beneath the rigid head.
    const remainder = 1 - h;
    repaired.fill(0);
    repaired[head] = h;
    repaired[joint.Spine02] = remainder;
  }
  // Hip is y=.286; thigh and knee joints are below y=.220. Influence on
  // the jacket above .40 is remote. Fade the repair through the hip region.
  if (y > 0.28) {
    let amount = 0;
    const removal = smoothstep(0.28, 0.40, y);
    for (const index of thighs) {
      const removed = repaired[index] * removal;
      repaired[index] -= removed;
      amount += removed;
    }
    addTorso(vertex, amount);
  }
  // Clavicle leakage reached y=.245. Its lower central jacket influence is
  // removed while the lateral sleeve remains attached to its arm.
  if (y < 0.48 && Math.abs(z) < 0.24) {
    let amount = 0;
    const removal = (1 - smoothstep(0.32, 0.48, y)) * (1 - smoothstep(0.17, 0.24, Math.abs(z)));
    for (const index of clavicles) {
      const removed = repaired[index] * removal;
      repaired[index] -= removed;
      amount += removed;
    }
    addTorso(vertex, amount);
  }
  // The front of the central jacket is far from the shoulder pivots. Its
  // shoulder/arm weights caused collar edges to grow 6x in a carrying pose.
  if (y > 0.38 && y < 0.65 && Math.abs(z) < 0.20 && x > 0.05) {
    const removal = (1 - smoothstep(0.08, 0.20, Math.abs(z)))
      * (1 - smoothstep(0.56, 0.65, y)) * smoothstep(0.05, 0.12, x);
    let amount = 0;
    for (const name of ['L_Clavicle', 'R_Clavicle', 'L_Upperarm', 'R_Upperarm', 'L_Forearm', 'R_Forearm']) {
      const index = joint[name], removed = repaired[index] * removal;
      repaired[index] -= removed;
      amount += removed;
    }
    addTorso(vertex, amount);
  }
  // Adjacent toe/ankle vertices had 88% Toe versus 57% Thigh. In the
  // forward lower foot volume, blend smoothly between ankle and toe.
  if (y < 0.24 && x > 0.015 && Math.abs(z) > 0.05) {
    const side = z < 0 ? 'L' : 'R';
    const strength = smoothstep(0.015, 0.075, x) * (1 - smoothstep(0.16, 0.24, y));
    const thigh = smoothstep(0.105, 0.195, y);
    const calf = (1 - thigh) * smoothstep(0.045, 0.11, y);
    const toe = (1 - calf - thigh) * (1 - smoothstep(0.02, 0.055, y)) * smoothstep(0.02, 0.10, x);
    for (let k = 0; k < names.length; k++) repaired[k] *= 1 - strength;
    repaired[joint[`${side}_Thigh`]] += strength * thigh;
    repaired[joint[`${side}_Calf`]] += strength * calf;
    repaired[joint[`${side}_Foot`]] += strength * (1 - calf - thigh - toe);
    repaired[joint[`${side}_ToeBase`]] += strength * toe;
  }
  // At the outer sleeve near the wrist, Waist accounted for 65.5% of one
  // vertex and 8.5% of its neighbor. Keep the supported local arm distribution
  // and fade out remote torso weights as the sleeve leaves the shoulder.
  if (Math.abs(z) > 0.18 && y > 0.38 && y < 0.68) {
    const side = z < 0 ? 'L' : 'R';
    const local = ['Clavicle', 'Upperarm', 'Forearm', 'Hand'].map(name => joint[`${side}_${name}`]);
    const sum = local.reduce((sum, index) => sum + repaired[index], 0);
    if (sum > 0.05) {
      const strength = smoothstep(0.18, 0.27, Math.abs(z)) * smoothstep(0.38, 0.43, y)
        * (1 - smoothstep(0.62, 0.68, y));
      const prior = repaired.slice();
      for (let k = 0; k < names.length; k++) repaired[k] *= 1 - strength;
      for (const index of local) repaired[index] += strength * prior[index] / sum;
    }
  }
}

// Collar and jacket seams also had abrupt weight jumps over edges shorter
// than 1cm. Smooth only those discontinuities and their immediate surface
// neighbors, keeping a tether to each corrected original distribution.
const jacketDomain = vertex => (vertex.position[1] > 0.27 && vertex.position[1] < 0.67 && Math.abs(vertex.position[2]) < 0.40)
  || (vertex.position[1] < 0.27 && vertex.position[0] > 0.015 && Math.abs(vertex.position[2]) > 0.05 && Math.abs(vertex.position[2]) < 0.27);
const smoothing = new Set();
for (let index = 0; index < vertices.length; index++) {
  const vertex = vertices[index];
  if (!jacketDomain(vertex)) continue;
  for (const neighbor of vertex.neighbors) {
    const other = vertices[neighbor];
    if (!jacketDomain(other)) continue;
    const length = Math.hypot(...vertex.position.map((value, axis) => value - other.position[axis]));
    let difference = 0;
    for (let k = 0; k < names.length; k++) difference += Math.abs(vertex.repaired[k] - other.repaired[k]);
    if (length < 0.05 && difference > Math.max(0.20, length * 12)) { smoothing.add(index); smoothing.add(neighbor); }
  }
}
for (let expansion = 0; expansion < 2; expansion++) {
  for (const index of [...smoothing]) for (const neighbor of vertices[index].neighbors) {
    if (jacketDomain(vertices[neighbor])) smoothing.add(neighbor);
  }
}
const corrected = vertices.map(vertex => vertex.repaired.slice());
for (let iteration = 0; iteration < 20; iteration++) {
  const next = vertices.map(vertex => vertex.repaired.slice());
  for (const index of smoothing) {
    const vertex = vertices[index];
    const average = new Float64Array(names.length);
    let total = 0;
    for (const neighbor of vertex.neighbors) {
      if (!jacketDomain(vertices[neighbor])) continue;
      const length = Math.hypot(...vertex.position.map((value, axis) => value - vertices[neighbor].position[axis]));
      const influence = 1 / Math.max(length, 0.004);
      total += influence;
      for (let k = 0; k < names.length; k++) average[k] += vertices[neighbor].repaired[k] * influence;
    }
    if (total) for (let k = 0; k < names.length; k++) {
      next[index][k] = vertex.repaired[k] * 0.27 + average[k] / total * 0.65 + corrected[index][k] * 0.08;
    }
  }
  vertices.forEach((vertex, index) => { vertex.repaired = next[index]; });
}

for (const vertex of vertices) {
  // Limit to glTF's original four influences and normalize deterministically.
  const repaired = vertex.repaired;
  const sorted = Array.from(repaired, (weight, index) => [index, weight])
    .filter(([, weight]) => weight > 1e-8).sort((a, b) => b[1] - a[1] || a[0] - b[0]);
  // Subtract the fifth weight before reducing to four channels. At a rank
  // exchange both disappearing influences approach zero, avoiding cracks.
  const threshold = sorted[4]?.[1] || 0;
  let influences = sorted.slice(0, 4).map(([index, weight]) => [index, Math.max(0, weight - threshold)]).filter(([, weight]) => weight > 1e-8);
  if (!influences.length) influences = [sorted[0]];
  const sum = influences.reduce((sum, [, weight]) => sum + weight, 0);
  repaired.fill(0);
  for (const [index, weight] of influences) repaired[index] = weight / sum;
  vertex.influences = influences.map(([index]) => [index, repaired[index]]);
}

// Numerical audit uses the asset's unchanged bind matrices and hierarchy.
const objects = json.nodes.map(node => {
  const object = new THREE.Object3D();
  object.name = node.name;
  if (node.matrix) new THREE.Matrix4().fromArray(node.matrix).decompose(object.position, object.quaternion, object.scale);
  else {
    if (node.translation) object.position.fromArray(node.translation);
    if (node.rotation) object.quaternion.fromArray(node.rotation);
    if (node.scale) object.scale.fromArray(node.scale);
  }
  return object;
});
json.nodes.forEach((node, index) => node.children?.forEach(child => objects[index].add(objects[child])));
const roots = objects.filter(object => !object.parent);
const bones = json.skins[0].joints.map(index => objects[index]);
const restQuaternions = bones.map(bone => bone.quaternion.clone());
const inverses = bones.map((_, index) => new THREE.Matrix4().fromArray(inverseBinds, index * 16));
const updateWorld = () => roots.forEach(root => root.updateMatrixWorld(true));
function deform(field) {
  updateWorld();
  const transforms = bones.map((bone, index) => new THREE.Matrix4().multiplyMatrices(bone.matrixWorld, inverses[index]));
  return vertices.map(vertex => {
    const rest = new THREE.Vector3().fromArray(vertex.position);
    const deformed = new THREE.Vector3();
    for (let index = 0; index < names.length; index++) {
      const weight = vertex[field][index];
      if (weight) deformed.addScaledVector(rest.clone().applyMatrix4(transforms[index]), weight);
    }
    return deformed;
  });
}
const originalRest = deform('original');
const repairedRest = deform('repaired');
let bindPoseDelta = 0;
for (let index = 0; index < vertices.length; index++) bindPoseDelta = Math.max(bindPoseDelta, originalRest[index].distanceTo(repairedRest[index]));
function edgeRatios(deformed, rest, region = () => true) {
  const ratios = [];
  for (let index = 0; index < vertices.length; index++) {
    if (!region(vertices[index].position)) continue;
    for (const neighbor of vertices[index].neighbors) {
      if (neighbor <= index || !region(vertices[neighbor].position)) continue;
      const length = rest[index].distanceTo(rest[neighbor]);
      if (length > 0.003) ratios.push(deformed[index].distanceTo(deformed[neighbor]) / length);
    }
  }
  ratios.sort((a, b) => a - b);
  const rounded = value => Number(value.toFixed(3));
  return { min: rounded(ratios[0]), p99: rounded(ratios[Math.floor(ratios.length * 0.99)]), max: rounded(ratios.at(-1)) };
}
const poses = [
  ['headPitch', 'Head', [0, 0, -1], 0.35],
  ['headYaw', 'Head', [0, 1, 0], 0.35],
  ['headRoll', 'Head', [1, 0, 0], 0.20],
  ['shoulderPitch', 'L_Clavicle', [0, 0, -1], 0.20],
  ['upperArmPitch', 'L_Upperarm', [0, 0, -1], 0.70],
  ['hipPitch', 'L_Thigh', [0, 0, -1], 0.50],
];
const audit = { version: VERSION, weldedVertices: vertices.length, smoothedTransitionVertices: smoothing.size, bindPoseDelta, poses: {} };
for (const [label, name, modelAxis, angle] of poses) {
  bones.forEach((bone, index) => bone.quaternion.copy(restQuaternions[index]));
  updateWorld();
  const bone = bones[joint[name]];
  const axis = new THREE.Vector3().fromArray(modelAxis).applyQuaternion(bone.parent.getWorldQuaternion(new THREE.Quaternion()).invert());
  bone.quaternion.premultiply(new THREE.Quaternion().setFromAxisAngle(axis, angle));
  const before = deform('original');
  const after = deform('repaired');
  audit.poses[label] = { angle, before: edgeRatios(before, originalRest), after: edgeRatios(after, repairedRest) };
  if (name === 'Head') audit.poses[label].upperHead = edgeRatios(after, repairedRest, position => position[1] > 0.70);
}
if (bindPoseDelta > 1e-5) throw new Error(`Repair changed the bind pose by ${bindPoseDelta}.`);
for (const vertex of vertices) {
  for (const corner of vertex.corners) {
    for (let k = 0; k < 4; k++) {
      const [index, weight] = vertex.influences[k] || [0, 0];
      binary.writeUInt16LE(index, joints.start + corner * joints.stride + k * 2);
      binary.writeFloatLE(weight, weights.start + corner * weights.stride + k * 4);
    }
  }
}
for (const attribute of [joints, weights]) {
  attribute.item.min = Array.from({ length: 4 }, () => Infinity);
  attribute.item.max = Array.from({ length: 4 }, () => -Infinity);
  for (let corner = 0; corner < positions.item.count; corner++) for (let k = 0; k < 4; k++) {
    const offset = attribute.start + corner * attribute.stride + k * attribute.width;
    const value = attribute.width === 2 ? binary.readUInt16LE(offset) : binary.readFloatLE(offset);
    attribute.item.min[k] = Math.min(attribute.item.min[k], value);
    attribute.item.max[k] = Math.max(attribute.item.max[k], value);
  }
}
json.asset.extras = { ...json.asset.extras, macacoSkinRepair: VERSION };
const jsonText = Buffer.from(JSON.stringify(json));
const jsonChunk = Buffer.alloc(Math.ceil(jsonText.length / 4) * 4, 0x20);
jsonText.copy(jsonChunk);
const header = Buffer.alloc(20);
header.writeUInt32LE(0x46546c67, 0);
header.writeUInt32LE(2, 4);
header.writeUInt32LE(28 + jsonChunk.length + binary.length, 8);
header.writeUInt32LE(jsonChunk.length, 12);
header.writeUInt32LE(0x4e4f534a, 16);
const binaryHeader = Buffer.alloc(8);
binaryHeader.writeUInt32LE(binary.length, 0);
binaryHeader.writeUInt32LE(0x004e4942, 4);
fs.writeFileSync(output, Buffer.concat([header, jsonChunk, binaryHeader, binary]));
console.log(JSON.stringify(audit, null, 2));
