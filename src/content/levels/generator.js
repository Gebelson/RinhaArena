// Procedural Arena Generator for Blast Arena
//
// Supports 3 Distinct Map Families:
//   1. SKYHAVEN FAMILY: Floating cloud island with natural assets (trees, arches,
//      ponds, stepping stones, flower beds, rubble, scaffolding, boulders, logs,
//      broken columns, cliff edges, cloud sea & distant peaks/waterfalls).
//   2. THE DOJO FAMILY: Martial sparring arena with physics measurement rings,
//      wide open knockback lanes, open rim drops, tatami pillars & training walls.
//   3. FOUNDRY FAMILY: Industrial 3-lane platform with heavy split bunkers,
//      deep void skirts, guard pillars, crate forts & rim breaches.
//
// All families strictly enforce:
//   - Deterministic PRNG with 32-bit seeds (Mulberry32).
//   - 180° Rotational Symmetry for fair Red vs Blue competitive play.
//   - Zero Object Intersections: AABB safety checks prevent overlapping props.

function mulberry32(seed) {
  let s = (seed >>> 0) || 1;
  return function () {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Complete themes providing keys for both standard solids and Skyhaven/Dojo decor props
export const THEMES = {
  // Skyhaven themes
  sanctuary: {
    name: 'Santuário Celeste',
    floor: '#cdbfa2',
    floorDark: '#b3a488',
    line: '#efe7d2',
    wall: '#9a8f7d',
    wallTop: '#c3b7a0',
    crate: '#b8813f',
    pillar: '#8d8474',
    rail: '#6f6656',
    sky: '#7db8e8',
    horizon: '#bfe0f2',
    lamp: '#ffe6b0',
    stone: '#c8b992',
    block: '#b6ab90',
    column: '#8d8474',
    wood: '#8c5d38',
    foliage: '#7cb56a',
    rock: '#7a7060',
    water: '#5baed6',
    cloud: '#eaf4fc',
    lantern: '#ffe19c',
  },
  sunset_island: {
    name: 'Ilha do Poente',
    floor: '#d4a87c',
    floorDark: '#ba8e63',
    line: '#fbe8cd',
    wall: '#996d45',
    wallTop: '#c4966a',
    crate: '#b0652d',
    pillar: '#7a5131',
    rail: '#6b4325',
    sky: '#5c3a6b',
    horizon: '#d47c59',
    lamp: '#ffd175',
    stone: '#b38459',
    block: '#966840',
    column: '#7a5131',
    wood: '#7d4520',
    foliage: '#a88d45',
    rock: '#785b45',
    water: '#c4695a',
    cloud: '#f2c9b8',
    lantern: '#ffcc55',
  },
  zen_island: {
    name: 'Jardim Flutuante',
    floor: '#998e7d',
    floorDark: '#807565',
    line: '#f0e8d5',
    wall: '#5a4d3d',
    wallTop: '#8c7d66',
    crate: '#a3622e',
    pillar: '#453a2c',
    rail: '#b83b3b',
    sky: '#689bb8',
    horizon: '#b5d7e8',
    lamp: '#ffcc66',
    stone: '#7d6d59',
    block: '#5f503f',
    column: '#453a2c',
    wood: '#733e22',
    foliage: '#4e8c46',
    rock: '#63594d',
    water: '#4ca3cc',
    cloud: '#e2f0f7',
    lantern: '#ffd470',
  },

  // Dojo themes
  dojo_classic: {
    name: 'Dojo de Bambu',
    floor: '#a3937f',
    floorDark: '#8a7c6a',
    line: '#f3ead9',
    wall: '#6b5d4e',
    wallTop: '#93836f',
    crate: '#b07a3f',
    pillar: '#55483c',
    rail: '#3a332b',
    sky: '#141210',
    horizon: '#3a2f24',
    lamp: '#ffd9a0',
    stone: '#80705f',
    block: '#695a4c',
    column: '#55483c',
    wood: '#754b28',
    foliage: '#5b824b',
    rock: '#544a40',
    water: '#4a859e',
    cloud: '#2a2624',
    lantern: '#ffd9a0',
  },
  dojo_night: {
    name: 'Dojo das Sombras',
    floor: '#2c2733',
    floorDark: '#201c26',
    line: '#d1b8eb',
    wall: '#3d3447',
    wallTop: '#584b66',
    crate: '#8a3d69',
    pillar: '#2b2333',
    rail: '#b33b72',
    sky: '#100c14',
    horizon: '#2b1b3b',
    lamp: '#ff77aa',
    stone: '#43394f',
    block: '#302838',
    column: '#2b2333',
    wood: '#592942',
    foliage: '#5d3873',
    rock: '#33293d',
    water: '#753b8c',
    cloud: '#1a1324',
    lantern: '#ff66aa',
  },

  // Foundry themes
  foundry_vulcan: {
    name: 'Fundição Vulcânica',
    floor: '#382e2c',
    floorDark: '#2b2322',
    line: '#ff5500',
    wall: '#4d3936',
    wallTop: '#664c48',
    crate: '#8f4b23',
    pillar: '#332725',
    rail: '#ff7733',
    sky: '#140c0a',
    horizon: '#3d160d',
    lamp: '#ffaa33',
    stone: '#523e3a',
    block: '#3d2e2b',
    column: '#332725',
    wood: '#5e2b1b',
    foliage: '#7a3e20',
    rock: '#382724',
    water: '#b83b1d',
    cloud: '#241512',
    lantern: '#ff8822',
  },
  foundry_cyber: {
    name: 'Noite Cyberpunk',
    floor: '#181e2b',
    floorDark: '#10141d',
    line: '#00f0ff',
    wall: '#242b3d',
    wallTop: '#38435f',
    crate: '#ff0077',
    pillar: '#1b2230',
    rail: '#00f0ff',
    sky: '#0a0d14',
    horizon: '#1f1338',
    lamp: '#00f0ff',
    stone: '#2d374d',
    block: '#202636',
    column: '#1b2230',
    wood: '#2d3254',
    foliage: '#00d4aa',
    rock: '#1e2436',
    water: '#00e5ff',
    cloud: '#131b2b',
    lantern: '#00f0ff',
  },
  foundry_glacier: {
    name: 'Geleira Boreal',
    floor: '#b0c8d9',
    floorDark: '#97b0c2',
    line: '#e8f4fc',
    wall: '#6b8a9e',
    wallTop: '#9ac0d9',
    crate: '#4f728c',
    pillar: '#526e80',
    rail: '#3b5463',
    sky: '#16283b',
    horizon: '#32587a',
    lamp: '#a8f0ff',
    stone: '#7d9eb3',
    block: '#638294',
    column: '#526e80',
    wood: '#3a5970',
    foliage: '#5c96b8',
    rock: '#526d80',
    water: '#68bde8',
    cloud: '#d8ecf8',
    lantern: '#a0f0ff',
  },
};

// Overlap detection
function boxesOverlap(a, b, margin = 0.08) {
  const aMinX = a.x - a.w / 2 - margin, aMaxX = a.x + a.w / 2 + margin;
  const aMinZ = a.z - a.d / 2 - margin, aMaxZ = a.z + a.d / 2 + margin;
  const bMinX = b.x - b.w / 2 - margin, bMaxX = b.x + b.w / 2 + margin;
  const bMinZ = b.z - b.d / 2 - margin, bMaxZ = b.z + b.d / 2 + margin;
  return aMinX < bMaxX && aMaxX > bMinX && aMinZ < bMaxZ && aMaxZ > bMinZ;
}

function boxOverlapsPoint(box, px, pz, radius = 0.8) {
  const minX = box.x - box.w / 2 - radius;
  const maxX = box.x + box.w / 2 + radius;
  const minZ = box.z - box.d / 2 - radius;
  const maxZ = box.z + box.d / 2 + radius;
  return px > minX && px < maxX && pz > minZ && pz < maxZ;
}

export function generateProceduralLevel(seedInput) {
  let seed = Number(seedInput);
  if (!Number.isFinite(seed) || seed <= 0) {
    if (typeof seedInput === 'string' && seedInput.includes(':')) {
      const parts = seedInput.split(':');
      seed = Number(parts[parts.length - 1]);
    }
  }
  if (!Number.isFinite(seed) || seed <= 0) {
    seed = Math.floor(10000 + Math.random() * 89999);
  }

  const rand = mulberry32(seed);
  const randInt = (min, max) => Math.floor(rand() * (max - min + 1)) + min;
  const randChoice = (arr) => arr[Math.floor(rand() * arr.length)];

  // Choose Map Family: 0 = Skyhaven Island, 1 = The Dojo, 2 = Foundry Court
  const familyId = randInt(0, 2);

  if (familyId === 0) {
    return generateSkyhavenFamily(seed, rand, randChoice, randInt);
  } else if (familyId === 1) {
    return generateDojoFamily(seed, rand, randChoice, randInt);
  } else {
    return generateFoundryFamily(seed, rand, randChoice, randInt);
  }
}

// =========================================================================
// FAMILY 1: SKYHAVEN FLOATING ISLAND
// =========================================================================
function generateSkyhavenFamily(seed, rand, randChoice, randInt) {
  const biome = randChoice([THEMES.sanctuary, THEMES.sunset_island, THEMES.zen_island]);
  const bounds = { w: 46, d: 46 }; // Square floating island
  const baseX = 19.5;

  const bases = {
    red: { x: -baseX, z: 0, r: 2.9 },
    blue: { x: baseX, z: 0, r: 2.9 },
  };
  const flags = {
    red: { x: -baseX, z: 0 },
    blue: { x: baseX, z: 0 },
  };
  const spawns = {
    red: [
      { x: -20.5, z: 3.0 }, { x: -18.5, z: 5.0 },
      { x: -16.5, z: 3.5 }, { x: -21.0, z: 0.5 },
    ],
    blue: [
      { x: 20.5, z: -3.0 }, { x: 18.5, z: -5.0 },
      { x: 16.5, z: -3.5 }, { x: 21.0, z: -0.5 },
    ],
  };

  const solids = [];

  function isSafe(box) {
    for (const ex of solids) if (boxesOverlap(box, ex, 0.08)) return false;
    for (const team of ['red', 'blue']) {
      if (boxOverlapsPoint(box, bases[team].x, bases[team].z, bases[team].r + 0.35)) return false;
      for (const sp of spawns[team]) if (boxOverlapsPoint(box, sp.x, sp.z, 1.1)) return false;
      if (boxOverlapsPoint(box, flags[team].x, flags[team].z, 1.2)) return false;
    }
    return true;
  }

  function tryPair(x, z, w, d, h, kind) {
    const a = { x, z, w, d, h, kind };
    const b = { x: -x, z: -z, w, d, h, kind };
    if (boxesOverlap(a, b, 0.08)) return false;
    if (isSafe(a) && isSafe(b)) {
      solids.push(a, b);
      return true;
    }
    return false;
  }

  // 1. Central Plaza (rotational broken columns & waist-high stone blocks)
  const plazaCols = randInt(0, 1) === 0 ? 3.6 : 4.0;
  tryPair(plazaCols, -plazaCols, 1.5, 1.5, 2.6, 'column');
  tryPair(-plazaCols, -plazaCols, 1.5, 1.5, 2.6, 'column');
  tryPair(-3.0, -7.5, 1.6, 1.6, 1.1, 'block');
  tryPair(3.0, -7.5, 1.6, 1.6, 1.1, 'block');
  tryPair(7.5, -7.5, 2.4, 1.0, 0.95, 'stone');
  tryPair(-7.5, -7.5, 2.4, 1.0, 0.95, 'stone');

  // 2. North Ruins / South Garden Twins
  tryPair(-5.5, -13.5, 4.2, 1.0, 1.5, 'wall');
  tryPair(5.5, -13.5, 4.2, 1.0, 1.5, 'wall');
  tryPair(-10.0, -16.5, 1.6, 1.6, 2.5, 'column');
  tryPair(10.0, -16.5, 1.6, 1.6, 2.5, 'column');
  tryPair(0.0, -18.5, 1.6, 1.6, 1.3, 'block');

  // 3. East Cliffside / West Watchtower Twins
  tryPair(13.0, -5.0, 2.6, 2.6, 2.1, 'rock');
  tryPair(13.0, 5.0, 2.6, 2.6, 2.1, 'rock');
  tryPair(14.0, 0.0, 2.0, 2.0, 1.6, 'barrel');
  tryPair(11.5, -11.5, 2.0, 2.0, 1.6, 'rock');
  tryPair(-11.5, -11.5, 2.0, 2.0, 1.5, 'crate');
  tryPair(18.0, 11.0, 1.8, 1.8, 2.8, 'column');

  // Decor: full Skyhaven scenery suite
  const decor = {
    background: {
      cloudSeaY: -6,
      islands: [
        { x: -62, z: -32, y: -8, scale: 1.4 },
        { x: 78, z: 18, y: -12, scale: 1.8 },
        { x: 16, z: 72, y: -6, scale: 1.2 },
        { x: -52, z: 60, y: -14, scale: 1.6 },
        { x: 70, z: -58, y: -10, scale: 2.0 },
      ],
      peaks: [
        { x: -82, z: -70, y: -20, scale: 3.0 },
        { x: 96, z: -48, y: -18, scale: 2.6 },
        { x: -30, z: 98, y: -22, scale: 3.2 },
      ],
      waterfalls: [
        { x: -15, z: 20, y: -4, h: 16 },
        { x: 18, z: -18, y: -4, h: 14 },
      ],
    },
    // Cliff edge markers along the lethal drop rim
    edges: [
      { x: -12, z: -21.5, rot: 0, len: 6.5, style: 'ruin' },
      { x: 4, z: -21.5, rot: 0, len: 6.5, style: 'ruin' },
      { x: -12, z: 21.5, rot: 0, len: 6.5, style: 'fence' },
      { x: 4, z: 21.5, rot: 0, len: 6.5, style: 'fence' },
      { x: 21.5, z: -12, rot: 1.5708, len: 6.5, style: 'stone' },
      { x: 21.5, z: 4, rot: 1.5708, len: 6.5, style: 'stone' },
      { x: -21.5, z: -12, rot: 1.5708, len: 6.5, style: 'stone' },
      { x: -21.5, z: 4, rot: 1.5708, len: 6.5, style: 'stone' },
    ],
    arches: [
      { x: -6, z: -11, rot: 0 },
      { x: 6, z: 11, rot: 0 },
      { x: 0, z: -17, rot: 0 },
      { x: 0, z: 17, rot: 0 },
    ],
    rubble: [
      { x: -3, z: -12 }, { x: 3, z: 12 }, { x: -8, z: -14 }, { x: 8, z: 14 },
      { x: 0, z: -15.5 }, { x: 0, z: 15.5 },
    ],
    trees: [
      { x: 10, z: 16.5, scale: 1.3 }, { x: -10, z: -16.5, scale: 1.3 },
      { x: 6, z: 20, scale: 0.8 }, { x: -6, z: -20, scale: 0.8 },
    ],
    lanterns: [
      { x: -3, z: 9 }, { x: 3, z: -9 }, { x: -4, z: 17 }, { x: 4, z: -17 },
    ],
    flowers: [
      { x: -2, z: 10 }, { x: 2, z: -10 }, { x: -6, z: 14 }, { x: 6, z: -14 },
      { x: 0, z: 19 }, { x: 0, z: -19 },
    ],
    ponds: [
      { x: 0, z: 12.5, r: 2.5 },
      { x: 0, z: -12.5, r: 2.5 },
    ],
    steppingStones: [
      { x: 0, z: 10.5 }, { x: 0, z: 12.0 }, { x: 0, z: 13.5 }, { x: 0, z: 14.5 },
      { x: 0, z: -10.5 }, { x: 0, z: -12.0 }, { x: 0, z: -13.5 }, { x: 0, z: -14.5 },
    ],
    scaffold: [
      { x: -16, z: -3, rot: 0, w: 3, h: 3 },
      { x: 16, z: 3, rot: 0, w: 3, h: 3 },
    ],
    lamps: [
      { x: 6.5, z: -6.5 }, { x: -6.5, z: 6.5 },
      { x: -6.5, z: -6.5 }, { x: 6.5, z: 6.5 },
    ],
    banners: [
      { x: -21.0, z: -4.0, team: 'red' }, { x: -21.0, z: 6.0, team: 'red' },
      { x: 21.0, z: 4.0, team: 'blue' }, { x: 21.0, z: -6.0, team: 'blue' },
    ],
    zones: [
      { x: 0, z: 0, r: 8.5, tint: biome.stone, shape: 'circle' },
    ],
  };

  const powerupSpawns = [
    { x: 0, z: 0 },
    { x: 9.5, z: -9.5 }, { x: -9.5, z: 9.5 },
    { x: -9.5, z: -9.5 }, { x: 9.5, z: 9.5 },
  ];

  return {
    id: 'procedural',
    seedId: `procedural:${seed}`,
    name: 'Procedural 🎲',
    title: `Arena Procedural #${seed}`,
    description: `Estilo: Ilha Celestial (Skyhaven) · Bioma: ${biome.name}`,
    family: 'skyhaven',
    seed,
    biomeName: biome.name,
    styleName: 'Ilha Celestial',
    bounds,
    theme: biome,
    flags,
    bases,
    spawns,
    powerupSpawns,
    solids,
    decor,
  };
}

// =========================================================================
// FAMILY 2: THE DOJO SPARRING ARENA
// =========================================================================
function generateDojoFamily(seed, rand, randChoice, randInt) {
  const biome = randChoice([THEMES.dojo_classic, THEMES.dojo_night]);
  const bounds = { w: 32, d: 24 }; // Compact intense dojo
  const baseX = 11.0;

  const bases = {
    red: { x: -baseX, z: 0, r: 2.2 },
    blue: { x: baseX, z: 0, r: 2.2 },
  };
  const flags = {
    red: { x: -baseX, z: 0 },
    blue: { x: baseX, z: 0 },
  };
  const spawns = {
    red: [
      { x: -12.5, z: -2.0 }, { x: -12.5, z: 2.0 },
      { x: -10.0, z: -3.5 }, { x: -10.0, z: 3.5 },
    ],
    blue: [
      { x: 12.5, z: -2.0 }, { x: 12.5, z: 2.0 },
      { x: 10.0, z: -3.5 }, { x: 10.0, z: 3.5 },
    ],
  };

  const solids = [];

  function isSafe(box) {
    for (const ex of solids) if (boxesOverlap(box, ex, 0.08)) return false;
    for (const team of ['red', 'blue']) {
      if (boxOverlapsPoint(box, bases[team].x, bases[team].z, bases[team].r + 0.35)) return false;
      for (const sp of spawns[team]) if (boxOverlapsPoint(box, sp.x, sp.z, 1.1)) return false;
      if (boxOverlapsPoint(box, flags[team].x, flags[team].z, 1.2)) return false;
    }
    return true;
  }

  function tryPair(x, z, w, d, h, kind) {
    const a = { x, z, w, d, h, kind };
    const b = { x: -x, z: -z, w, d, h, kind };
    if (boxesOverlap(a, b, 0.08)) return false;
    if (isSafe(a) && isSafe(b)) {
      solids.push(a, b);
      return true;
    }
    return false;
  }

  function trySolid(box) {
    if (isSafe(box)) { solids.push(box); return true; }
    return false;
  }

  // 1. Rails with authentic open void drop sections
  // North & South rails
  trySolid({ x: 0, z: -11.6, w: 31.2, d: 0.6, h: 0.8, kind: 'rail' });
  trySolid({ x: 0, z: 11.6, w: 31.2, d: 0.6, h: 0.8, kind: 'rail' });
  // West & East rails with open void breach for ring-out throw tests
  tryPair(-15.6, -7.5, 0.6, 7.2, 0.8, 'rail');
  tryPair(-15.6, 7.5, 0.6, 7.2, 0.8, 'rail');
  // East/West middle breach is intentionally left OPEN for void KOs!

  // 2. Training Props & Cover (kept off the central punch lane)
  tryPair(-10.5, -7.2, 1.4, 1.4, 1.4, 'crate');
  tryPair(-9.1, -7.6, 1.4, 1.4, 1.4, 'crate');
  tryPair(-8.0, 7.2, 4.5, 1.1, 1.6, 'wall');
  tryPair(9.5, -7.2, 1.7, 1.7, 2.6, 'pillar');
  tryPair(-4.0, -7.0, 1.5, 1.5, 1.1, 'block');

  // Concentric measurement rings (Dojo hallmark)
  const decor = {
    rings: [
      { x: 0, z: 0, r: 2 },
      { x: 0, z: 0, r: 4 },
      { x: 0, z: 0, r: 6 },
      { x: baseX, z: 0, r: 2 },
      { x: -baseX, z: 0, r: 2 },
    ],
    lamps: [
      { x: -14.0, z: -10.0 }, { x: 14.0, z: 10.0 },
      { x: -14.0, z: 10.0 }, { x: 14.0, z: -10.0 },
    ],
    banners: [
      { x: -14.8, z: -4.5, team: 'red' }, { x: -14.8, z: 4.5, team: 'red' },
      { x: 14.8, z: -4.5, team: 'blue' }, { x: 14.8, z: 4.5, team: 'blue' },
    ],
  };

  const powerupSpawns = [
    { x: 0, z: -4.2 }, { x: 0, z: 4.2 },
    { x: -5.0, z: 0 }, { x: 5.0, z: 0 },
  ];

  return {
    id: 'procedural',
    seedId: `procedural:${seed}`,
    name: 'Procedural 🎲',
    title: `Arena Procedural #${seed}`,
    description: `Estilo: Dojo Sagrado (The Dojo) · Bioma: ${biome.name}`,
    family: 'dojo',
    seed,
    biomeName: biome.name,
    styleName: 'Dojo Sagrado',
    bounds,
    theme: biome,
    flags,
    bases,
    spawns,
    powerupSpawns,
    solids,
    decor,
  };
}

// =========================================================================
// FAMILY 3: FOUNDRY INDUSTRIAL FORTRESS
// =========================================================================
function generateFoundryFamily(seed, rand, randChoice, randInt) {
  const biome = randChoice([THEMES.foundry_vulcan, THEMES.foundry_cyber, THEMES.foundry_glacier]);
  const bounds = { w: 46, d: 30 };
  const baseX = 19.5;

  const bases = {
    red: { x: -baseX, z: 0, r: 2.9 },
    blue: { x: baseX, z: 0, r: 2.9 },
  };
  const flags = {
    red: { x: -baseX, z: 0 },
    blue: { x: baseX, z: 0 },
  };
  const spawns = {
    red: [
      { x: -20.6, z: -2.6 }, { x: -20.6, z: 2.6 },
      { x: -18.2, z: -4.8 }, { x: -18.2, z: 4.8 },
    ],
    blue: [
      { x: 20.6, z: -2.6 }, { x: 20.6, z: 2.6 },
      { x: 18.2, z: -4.8 }, { x: 18.2, z: 4.8 },
    ],
  };

  const solids = [];

  function isSafe(box) {
    for (const ex of solids) if (boxesOverlap(box, ex, 0.08)) return false;
    for (const team of ['red', 'blue']) {
      if (boxOverlapsPoint(box, bases[team].x, bases[team].z, bases[team].r + 0.35)) return false;
      for (const sp of spawns[team]) if (boxOverlapsPoint(box, sp.x, sp.z, 1.1)) return false;
      if (boxOverlapsPoint(box, flags[team].x, flags[team].z, 1.2)) return false;
    }
    return true;
  }

  function tryPair(x, z, w, d, h, kind) {
    const a = { x, z, w, d, h, kind };
    const b = { x: -x, z: -z, w, d, h, kind };
    if (boxesOverlap(a, b, 0.08)) return false;
    if (isSafe(a) && isSafe(b)) {
      solids.push(a, b);
      return true;
    }
    return false;
  }

  function trySolid(box) {
    if (isSafe(box)) { solids.push(box); return true; }
    return false;
  }

  function tryPairCluster(cx, cz, sx = 1, sz = 1) {
    const cluster = [
      { x: cx, z: cz, w: 1.4, d: 1.4, h: 1.4, kind: 'crate' },
      { x: cx + 1.42 * sx, z: cz - 0.35 * sz, w: 1.4, d: 1.4, h: 1.4, kind: 'crate' },
      { x: cx - 0.25 * sx, z: cz + 1.4 * sz, w: 1.1, d: 1.1, h: 1.1, kind: 'crate' },
    ];
    for (const box of cluster) {
      tryPair(box.x, box.z, box.w, box.d, box.h, box.kind);
    }
  }

  // 1. Boundary Rails with open drop gaps
  trySolid({ x: -22.6, z: 0, w: 0.6, d: 24.0, h: 0.85, kind: 'rail' });
  trySolid({ x: 22.6, z: 0, w: 0.6, d: 24.0, h: 0.85, kind: 'rail' });
  tryPair(-13.5, -14.6, 17.5, 0.6, 0.8, 'rail');
  tryPair(-13.5, 14.6, 17.5, 0.6, 0.8, 'rail');

  // 2. Base Bunkers (split walls + chokepoint)
  tryPair(-14.2, -3.2, 1.1, 3.8, 1.6, 'wall');
  tryPair(-14.2, 3.2, 1.1, 3.8, 1.6, 'wall');
  tryPair(-13.5, 0, 1.3, 1.3, 2.2, 'pillar');

  // 3. Mid-walls carving 3 tactical lanes
  tryPair(-7.0, -5.4, 5.5, 1.1, 1.7, 'wall');
  tryPair(-7.0, 5.4, 5.5, 1.1, 1.7, 'wall');
  tryPair(0, -9.0, 1.8, 1.8, 2.6, 'pillar');
  tryPairCluster(-10.5, -8.2, 1, 1);
  tryPairCluster(-10.5, 8.2, 1, -1);

  const decor = {
    lamps: [
      { x: -21.0, z: -12.8 }, { x: 21.0, z: -12.8 },
      { x: -21.0, z: 12.8 }, { x: 21.0, z: 12.8 },
    ],
    banners: [
      { x: -21.8, z: -7.5, team: 'red' }, { x: -21.8, z: 7.5, team: 'red' },
      { x: 21.8, z: -7.5, team: 'blue' }, { x: 21.8, z: 7.5, team: 'blue' },
    ],
    zones: [
      { x: 0, z: 0, r: 6.5, tint: biome.floorDark, shape: 'circle' },
    ],
  };

  const candidatePowerups = [
    { x: 0, z: 0 },
    { x: 0, z: -12.4 }, { x: 0, z: 12.4 },
    { x: -11.5, z: 0 }, { x: 11.5, z: 0 },
    { x: -5.0, z: -7.5 }, { x: 5.0, z: 7.5 },
  ];
  const powerupSpawns = [];
  for (const c of candidatePowerups) {
    let safe = true;
    for (const s of solids) {
      if (boxOverlapsPoint(s, c.x, c.z, 1.15)) { safe = false; break; }
    }
    if (safe) powerupSpawns.push(c);
  }

  return {
    id: 'procedural',
    seedId: `procedural:${seed}`,
    name: 'Procedural 🎲',
    title: `Arena Procedural #${seed}`,
    description: `Estilo: Usina Industrial (Foundry) · Bioma: ${biome.name}`,
    family: 'foundry',
    seed,
    biomeName: biome.name,
    styleName: 'Usina Industrial',
    bounds,
    theme: biome,
    flags,
    bases,
    spawns,
    powerupSpawns,
    solids,
    decor,
  };
}

let activeProceduralLevel = null;

export function getProceduralLevel(seed) {
  if (seed === 'procedural' || seed === undefined || seed === null) {
    if (!activeProceduralLevel) {
      activeProceduralLevel = generateProceduralLevel();
    }
    return activeProceduralLevel;
  }
  let numSeed = Number(seed);
  if (!Number.isFinite(numSeed) && typeof seed === 'string' && seed.includes(':')) {
    numSeed = Number(seed.split(':')[1]);
  }
  if (activeProceduralLevel && activeProceduralLevel.seed === numSeed) {
    return activeProceduralLevel;
  }
  return generateProceduralLevel(numSeed);
}

export function newProceduralSeed() {
  const seed = Math.floor(10000 + Math.random() * 89999);
  activeProceduralLevel = generateProceduralLevel(seed);
  return activeProceduralLevel;
}
