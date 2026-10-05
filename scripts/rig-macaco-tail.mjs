// Add a curved six-joint tail without changing geometry, UVs or texture bytes.
// Usage: node scripts/rig-macaco-tail.mjs [input.glb] [output.glb]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadMacacoRig } from './macaco-rig-utils.mjs';

const VERSION = 'curved-tail-v1';
const directory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const input = path.resolve(process.argv[2] || path.join(directory, 'models/macaco.glb'));
const output = path.resolve(process.argv[3] || input);
const original = fs.readFileSync(input);
let json, binary;
for (let offset = 12; offset < original.length;) {
  const length = original.readUInt32LE(offset), kind = original.readUInt32LE(offset + 4);
  if (kind === 0x4e4f534a) json = JSON.parse(original.subarray(offset + 8, offset + 8 + length));
  if (kind === 0x004e4942) binary = Buffer.from(original.subarray(offset + 8, offset + 8 + length));
  offset += length + 8;
}
if (json.asset.extras?.macacoTailRig?.version === VERSION) {
  if (output !== input) fs.writeFileSync(output, original);
  console.log(`${VERSION} already applied.`);
  process.exit(0);
}
if (json.skins.length !== 1 || json.meshes.length !== 1 || !json.asset.extras?.macacoSkinRepair) {
  throw new Error('Expected the monkey model with its existing body skin repair.');
}
const rig = loadMacacoRig(input), THREE = rig.THREE;
const geometry = rig.geometry, positions = geometry.attributes.position;
const skinIndices = geometry.attributes.skinIndex, skinWeights = geometry.attributes.skinWeight;
const skin = json.skins[0], oldJointCount = skin.joints.length;
const primitive = json.meshes[0].primitives[0];
const groups = [], corners = [], lookup = new Map();
for (let index = 0; index < positions.count; index++) {
  const position = new THREE.Vector3().fromBufferAttribute(positions, index);
  const key = position.toArray().map(value => Math.round(value * 1e6)).join(',');
  let group = lookup.get(key);
  if (group === undefined) {
    group = groups.length; lookup.set(key, group);
    groups.push({ position, corners: [], neighbors: new Set() });
  }
  groups[group].corners.push(index); corners.push(group);
}
const triangles = geometry.index?.array || Array.from({ length: positions.count }, (_, index) => index);
for (let index = 0; index < triangles.length; index += 3) for (let k = 0; k < 3; k++) {
  const a = corners[triangles[index + k]], b = corners[triangles[index + (k + 1) % 3]];
  if (a !== b) { groups[a].neighbors.add(b); groups[b].neighbors.add(a); }
}
// The tail is the connected extrusion behind the lower trunk. These bounds
// cut its narrow attachment; the back of the jacket is higher than this band.
const candidate = group => group.position.x < -0.095 && group.position.y > 0.16
  && group.position.y < 0.39 && group.position.z > 0.035;
const seed = groups.reduce((best, group, index) => candidate(group)
  && (best < 0 || group.position.x < groups[best].position.x) ? index : best, -1);
if (seed < 0) throw new Error('Tail geometry was not found.');
const membership = new Set([seed]), flood = [seed];
for (let cursor = 0; cursor < flood.length; cursor++) for (const neighbor of groups[flood[cursor]].neighbors) {
  if (!membership.has(neighbor) && candidate(groups[neighbor])) { membership.add(neighbor); flood.push(neighbor); }
}
const boundary = flood.filter(index => [...groups[index].neighbors].some(neighbor => !membership.has(neighbor)));
if (membership.size < 100 || membership.size > 500 || boundary.length < 3) throw new Error('Unexpected tail membership.');
const distance = new Float64Array(groups.length).fill(Infinity), queue = [];
for (const index of boundary) { distance[index] = 0; queue.push([0, index]); }
while (queue.length) {
  queue.sort((a, b) => b[0] - a[0]);
  const [value, index] = queue.pop();
  if (value !== distance[index]) continue;
  for (const neighbor of groups[index].neighbors) {
    if (!membership.has(neighbor)) continue;
    const next = value + groups[index].position.distanceTo(groups[neighbor].position);
    if (next < distance[neighbor]) { distance[neighbor] = next; queue.push([next, neighbor]); }
  }
}
const length = Math.max(...flood.map(index => distance[index]));
function center(progress) {
  const target = progress * length, span = length * 0.065, center = new THREE.Vector3();
  let sum = 0;
  for (const index of flood) {
    const influence = Math.exp(-Math.pow((distance[index] - target) / span, 2));
    center.addScaledVector(groups[index].position, influence); sum += influence;
  }
  return center.multiplyScalar(1 / sum);
}
const centers = Array.from({ length: 6 }, (_, index) => center(index / 5));
const hip = rig.bones.Hip;
const hipNode = json.nodes.findIndex(node => node.name === 'Hip');
const jointNames = centers.map((_, index) => `Tail${String(index + 1).padStart(2, '0')}`);
const frames = [], matrices = [], nodeIndices = [];
let previousX;
for (let index = 0; index < centers.length; index++) {
  const y = index < 5 ? centers[index + 1].clone().sub(centers[index]).normalize()
    : centers[index].clone().sub(centers[index - 1]).normalize();
  const x = previousX ? previousX.clone().addScaledVector(y, -previousX.dot(y)).normalize()
    : new THREE.Vector3(0, 1, 0).cross(y).normalize();
  const z = x.clone().cross(y).normalize();
  const world = new THREE.Matrix4().makeBasis(x, y, z).setPosition(centers[index]);
  const parent = index ? matrices[index - 1] : hip.matrixWorld;
  const local = parent.clone().invert().multiply(world);
  const translation = new THREE.Vector3(), rotation = new THREE.Quaternion(), scale = new THREE.Vector3();
  local.decompose(translation, rotation, scale);
  const nodeIndex = json.nodes.length;
  json.nodes.push({ name: jointNames[index], translation: translation.toArray(), rotation: rotation.toArray(),
    extras: { macacoTailSegment: index } });
  if (index) json.nodes[nodeIndices[index - 1]].children = [nodeIndex];
  else json.nodes[hipNode].children = [...json.nodes[hipNode].children, nodeIndex];
  skin.joints.push(nodeIndex);
  nodeIndices.push(nodeIndex); matrices.push(world); previousX = x;
  frames.push({ name: jointNames[index], position: centers[index].toArray(), localPosition: translation.toArray(),
    localRotation: rotation.toArray(), worldX: x.toArray(), worldY: y.toArray(), worldZ: z.toArray() });
}
const smooth = value => { const t = Math.max(0, Math.min(1, value)); return t * t * (3 - 2 * t); };
let influencedCorners = 0, coreCorners = 0;
for (const index of flood) {
  const group = groups[index], progress = distance[index] / length;
  const strength = smooth(progress / 0.18);
  if (strength < 1e-8) continue;
  const distribution = new Float64Array(skin.joints.length);
  const corner = group.corners[0];
  for (let k = 0; k < 4; k++) distribution[skinIndices.getComponent(corner, k)] += skinWeights.getComponent(corner, k) * (1 - strength);
  const longitudinal = Math.min(5, progress * 5), first = Math.min(4, Math.floor(longitudinal));
  const blend = smooth(longitudinal - first);
  distribution[oldJointCount + first] += strength * (1 - blend);
  distribution[oldJointCount + first + 1] += strength * blend;
  const sorted = Array.from(distribution, (weight, joint) => [joint, weight])
    .filter(([, weight]) => weight > 1e-8).sort((a, b) => b[1] - a[1] || a[0] - b[0]);
  const threshold = sorted[4]?.[1] || 0;
  const weights = sorted.slice(0, 4).map(([joint, weight]) => [joint, weight - threshold]).filter(([, weight]) => weight > 1e-8);
  const sum = weights.reduce((sum, [, weight]) => sum + weight, 0);
  for (const corner of group.corners) for (let k = 0; k < 4; k++) {
    const [joint, weight] = weights[k] || [0, 0];
    skinIndices.setComponent(corner, k, joint); skinWeights.setComponent(corner, k, weight / sum);
  }
  influencedCorners += group.corners.length;
  if (strength > 0.999) coreCorners += group.corners.length;
}
for (const [name, attribute] of [['JOINTS_0', skinIndices], ['WEIGHTS_0', skinWeights]]) {
  const accessor = json.accessors[primitive.attributes[name]], view = json.bufferViews[accessor.bufferView];
  const width = name === 'JOINTS_0' ? 2 : 4, stride = view.byteStride || width * 4;
  accessor.min = [Infinity, Infinity, Infinity, Infinity]; accessor.max = [-Infinity, -Infinity, -Infinity, -Infinity];
  for (let corner = 0; corner < positions.count; corner++) for (let k = 0; k < 4; k++) {
    const value = attribute.getComponent(corner, k), offset = (view.byteOffset || 0) + (accessor.byteOffset || 0) + corner * stride + k * width;
    if (width === 2) binary.writeUInt16LE(value, offset); else binary.writeFloatLE(value, offset);
    accessor.min[k] = Math.min(accessor.min[k], value); accessor.max[k] = Math.max(accessor.max[k], value);
  }
}
const inverseAccessor = json.accessors[skin.inverseBindMatrices], inverseView = json.bufferViews[inverseAccessor.bufferView];
const inverseBlock = Buffer.alloc(skin.joints.length * 64);
binary.copy(inverseBlock, 0, (inverseView.byteOffset || 0) + (inverseAccessor.byteOffset || 0),
  (inverseView.byteOffset || 0) + (inverseAccessor.byteOffset || 0) + oldJointCount * 64);
matrices.forEach((matrix, index) => matrix.clone().invert().elements.forEach((value, channel) => inverseBlock.writeFloatLE(value, (oldJointCount + index) * 64 + channel * 4)));
const offset = Math.ceil(binary.length / 4) * 4;
binary = Buffer.concat([binary, Buffer.alloc(offset - binary.length), inverseBlock]);
const bufferView = json.bufferViews.length;
json.bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: inverseBlock.length });
json.accessors[skin.inverseBindMatrices] = { bufferView, componentType: 5126, count: skin.joints.length, type: 'MAT4' };
json.buffers[0].byteLength = binary.length;
json.asset.extras.macacoTailRig = { version: VERSION, parent: 'Hip', joints: jointNames, tangentAxis: '+Y',
  influencedCorners, coreCorners, weldedVertices: membership.size, geodesicLength: length };
const jsonText = Buffer.from(JSON.stringify(json)), jsonChunk = Buffer.alloc(Math.ceil(jsonText.length / 4) * 4, 0x20);
jsonText.copy(jsonChunk);
const header = Buffer.alloc(20), binaryHeader = Buffer.alloc(8);
header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4); header.writeUInt32LE(28 + jsonChunk.length + binary.length, 8);
header.writeUInt32LE(jsonChunk.length, 12); header.writeUInt32LE(0x4e4f534a, 16);
binaryHeader.writeUInt32LE(binary.length, 0); binaryHeader.writeUInt32LE(0x004e4942, 4);
if (input === output) {
  const backup = path.join(process.env.TEMP, 'rinha-macaco-before-tail-rig.glb');
  if (!fs.existsSync(backup)) fs.writeFileSync(backup, original);
}
fs.writeFileSync(output, Buffer.concat([header, jsonChunk, binaryHeader, binary]));
const after = loadMacacoRig(output);
const restDelta = Math.max(...rig.rest.map((position, index) => position.distanceTo(after.rest[index])));
if (restDelta > 1e-5) throw new Error(`Tail changed the bind pose by ${restDelta}`);
console.log(JSON.stringify({ ...json.asset.extras.macacoTailRig, restDelta, frames }, null, 2));
