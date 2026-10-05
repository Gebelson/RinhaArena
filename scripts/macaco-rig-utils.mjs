// Headless skinning support for numerical animation audits, using the same
// Three.js version as the browser without fetching textures or a WebGL context.
import fs from 'node:fs';
import * as THREE from '../vendor/three.module.js';

export function loadMacacoRig(filename) {
  const file = fs.readFileSync(filename);
  let json, binary;
  for (let offset = 12; offset < file.length;) {
    const length = file.readUInt32LE(offset);
    const type = file.readUInt32LE(offset + 4);
    if (type === 0x4e4f534a) json = JSON.parse(file.subarray(offset + 8, offset + 8 + length));
    if (type === 0x004e4942) binary = file.subarray(offset + 8, offset + 8 + length);
    offset += length + 8;
  }
  const sizes = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };
  function readAccessor(index) {
    const item = json.accessors[index], view = json.bufferViews[item.bufferView];
    const size = sizes[item.type];
    const width = item.componentType === 5126 ? 4 : item.componentType === 5123 ? 2 : item.componentType === 5125 ? 4 : 1;
    const values = [];
    for (let i = 0; i < item.count; i++) for (let k = 0; k < size; k++) {
      const offset = (view.byteOffset || 0) + (item.byteOffset || 0) + i * (view.byteStride || size * width) + k * width;
      values.push(item.componentType === 5126 ? binary.readFloatLE(offset)
        : item.componentType === 5123 ? binary.readUInt16LE(offset)
          : item.componentType === 5125 ? binary.readUInt32LE(offset) : binary.readUInt8(offset));
    }
    return { values, item, size };
  }
  const skin = json.skins[0], jointNodes = new Set(skin.joints);
  const primitive = json.meshes[0].primitives[0];
  const geometry = new THREE.BufferGeometry();
  const attrs = { POSITION: 'position', NORMAL: 'normal', TEXCOORD_0: 'uv', JOINTS_0: 'skinIndex', WEIGHTS_0: 'skinWeight' };
  for (const [name, index] of Object.entries(primitive.attributes)) {
    if (!attrs[name]) continue;
    const { values, item, size } = readAccessor(index);
    const array = item.componentType === 5126 ? new Float32Array(values) : new Uint16Array(values);
    geometry.setAttribute(attrs[name], new THREE.BufferAttribute(array, size, !!item.normalized));
  }
  if (primitive.indices !== undefined) geometry.setIndex(readAccessor(primitive.indices).values);
  let mesh;
  const objects = json.nodes.map((node, index) => {
    const object = node.mesh !== undefined
      ? (mesh = new THREE.SkinnedMesh(geometry, new THREE.MeshBasicMaterial()))
      : jointNodes.has(index) ? new THREE.Bone() : new THREE.Group();
    object.name = node.name || '';
    if (node.matrix) new THREE.Matrix4().fromArray(node.matrix).decompose(object.position, object.quaternion, object.scale);
    else {
      if (node.translation) object.position.fromArray(node.translation);
      if (node.rotation) object.quaternion.fromArray(node.rotation);
      if (node.scale) object.scale.fromArray(node.scale);
    }
    return object;
  });
  json.nodes.forEach((node, index) => node.children?.forEach(child => objects[index].add(objects[child])));
  const root = new THREE.Group();
  for (const index of json.scenes[json.scene || 0].nodes) root.add(objects[index]);
  root.updateMatrixWorld(true);
  const inverseValues = readAccessor(skin.inverseBindMatrices).values;
  const skeleton = new THREE.Skeleton(skin.joints.map(index => objects[index]),
    skin.joints.map((_, index) => new THREE.Matrix4().fromArray(inverseValues, index * 16)));
  mesh.bind(skeleton, new THREE.Matrix4());
  root.updateMatrixWorld(true);
  const bones = Object.fromEntries(skeleton.bones.map(bone => [bone.name, bone]));
  const positions = geometry.attributes.position;
  function deform() {
    root.updateWorldMatrix(true, false);
    root.updateMatrixWorld(true);
    return Array.from({ length: positions.count }, (_, index) => {
      const position = new THREE.Vector3().fromBufferAttribute(positions, index);
      return mesh.localToWorld(mesh.applyBoneTransform(index, position));
    });
  }
  const rest = deform();
  const indices = geometry.index?.array || Array.from({ length: positions.count }, (_, index) => index);
  function edgeRatios(deformed, region = () => true, baseline = rest) {
    const ratios = [];
    for (let i = 0; i < indices.length; i += 3) for (let k = 0; k < 3; k++) {
      const a = indices[i + k], b = indices[i + (k + 1) % 3];
      if (!region(a) || !region(b)) continue;
      const length = baseline[a].distanceTo(baseline[b]);
      if (length > 0.003) ratios.push(deformed[a].distanceTo(deformed[b]) / length);
    }
    ratios.sort((a, b) => a - b);
    const round = value => Number(value.toFixed(3));
    return { min: round(ratios[0]), p99: round(ratios[Math.floor(ratios.length * 0.99)]), max: round(ratios.at(-1)) };
  }
  return { root, mesh, bones, geometry, json, rest, deform, edgeRatios, THREE };
}
