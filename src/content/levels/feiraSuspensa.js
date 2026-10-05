// Feira Suspensa — large 10v10 CTF arena. All gameplay geometry lives here;
// the renderer, physics and bots consume the same data.
const box = (x, z, w, d, h = 1.45, kind = 'wall') => ({ x, z, w, d, h, kind });
const pair = (x, z, w, d, h, kind) => [box(x, z, w, d, h, kind), box(-x, -z, w, d, h, kind)];

const marketStalls = [
  { x: -20, z: -14.5, rot: 0, color: '#f15b4f' }, { x: -10, z: -15, rot: 0, color: '#ffc93c' },
  { x: 3, z: -15.2, rot: 0, color: '#32b7a5' }, { x: 16, z: -14.4, rot: 0, color: '#ef6ba8' },
  { x: 25, z: -12.8, rot: 0, color: '#ff8a36' },
];

const restaurants = [
  { x: -22, z: 15.3, color: '#e95d4f' }, { x: -7, z: 16.2, color: '#ffbf36' },
  { x: 9, z: 15.8, color: '#2faeb1' }, { x: 23, z: 14.8, color: '#4d82d8' },
];

export const feiraSuspensa = {
  id: 'feira_suspensa',
  name: 'Feira Suspensa',
  description: 'Feira brasileira flutuante com três rotas e cenário interativo.',
  bounds: { w: 65, d: 42 },
  theme: {
    floor: '#d8b879', floorDark: '#b8905b', line: '#fff1bd', wall: '#397a77',
    wallTop: '#69aaa0', crate: '#a96732', pillar: '#315c66', rail: '#27424d',
    sky: '#86c9e8', horizon: '#d9f0ef', lamp: '#ffe095', wood: '#9b6036',
    foliage: '#4f9b55', stone: '#cfaa72', block: '#b98e5b', column: '#315c66',
  },
  flags: { red: { x: -27.5, z: 0 }, blue: { x: 27.5, z: 0 } },
  bases: { red: { x: -27.5, z: 0, r: 3.3 }, blue: { x: 27.5, z: 0, r: 3.3 } },
  spawns: {
    red: [
      { x: -30, z: -7 }, { x: -27, z: -7 }, { x: -26, z: -4.5 }, { x: -30, z: 7 }, { x: -27, z: 7 },
      { x: -26, z: 4.5 }, { x: -30, z: -3.8 }, { x: -30, z: 3.8 }, { x: -27, z: -2.8 }, { x: -27, z: 2.8 },
    ],
    blue: [
      { x: 30, z: 7 }, { x: 27, z: 7 }, { x: 26, z: 4.5 }, { x: 30, z: -7 }, { x: 27, z: -7 },
      { x: 26, z: -4.5 }, { x: 30, z: 3.8 }, { x: 30, z: -3.8 }, { x: 27, z: 2.8 }, { x: 27, z: -2.8 },
    ],
  },
  powerupSpawns: [
    { x: 0, z: 0 }, { x: -10, z: -15 }, { x: 10, z: 15 }, { x: -17, z: 8 }, { x: 17, z: -8 },
  ],
  jumpPads: [
    { id: 'jr1', x: -19, z: -16.5, tx: -8, tz: -7 }, { id: 'jr2', x: -19, z: 16.5, tx: -8, tz: 7 },
    { id: 'jb1', x: 19, z: 16.5, tx: 8, tz: 7 }, { id: 'jb2', x: 19, z: -16.5, tx: 8, tz: -7 },
  ],
  botRoutes: [
    [{ x: -20, z: -13 }, { x: -10, z: -12 }, { x: 0, z: -11 }, { x: 10, z: -12 }, { x: 20, z: -13 }],
    [{ x: -19, z: 0 }, { x: -10, z: 2.5 }, { x: 0, z: 0 }, { x: 10, z: -2.5 }, { x: 19, z: 0 }],
    [{ x: -20, z: 13 }, { x: -10, z: 12 }, { x: 0, z: 13 }, { x: 10, z: 12 }, { x: 20, z: 13 }],
  ],
  interactives: [
    { id: 'rotunda', type: 'rotator', x: 0, z: 0, radius: 6.2, speed: 0.075 },
    { id: 'wall_n', type: 'slider', x: -3.8, z: -7.5, w: 5.2, d: 0.75, h: 1.8, axis: 'x', travel: 5.8, period: 12, phase: 0 },
    { id: 'wall_s', type: 'slider', x: 3.8, z: 7.5, w: 5.2, d: 0.75, h: 1.8, axis: 'x', travel: 5.8, period: 12, phase: 6 },
    { id: 'food_cart', type: 'cart', x: 0, z: 14.2, w: 3.3, d: 1.8, h: 2.1, axis: 'x', travel: 15, period: 20, phase: 0 },
    { id: 'bridge', type: 'bridge', x: 0, z: -10.2, w: 5.5, d: 2.1, h: 0.35, period: 10, phase: 0 },
  ],
  solids: [
    // Base defense: three open entrances and space around each flag.
    ...pair(-24.2, -5.2, 1.0, 5.0, 1.55, 'tilewall'), ...pair(-24.2, 5.2, 1.0, 5.0, 1.55, 'tilewall'),
    ...pair(-29.2, -9.5, 5.8, 1.0, 1.35, 'wall'), ...pair(-29.2, 9.5, 5.8, 1.0, 1.35, 'wall'),
    // Left/market route (negative z): staggered cover with multiple gaps.
    ...pair(-18, -11.2, 5.2, 1.0, 1.45, 'stall'), ...pair(-8, -16.2, 4.4, 1.1, 1.35, 'stall'),
    ...pair(-12, -9.2, 1.5, 1.5, 1.3, 'crate'), ...pair(-3.5, -14.2, 1.5, 1.5, 1.3, 'crate'),
    ...pair(-20.5, -17.2, 1.4, 1.4, 1.3, 'crate'), ...pair(-7, -10.3, 3.4, 0.9, 1.2, 'counter'),
    // Right/restaurant route (positive z): open, broken sight lines.
    ...pair(-17, 12.2, 3.8, 1.0, 1.25, 'counter'), ...pair(-8, 17.1, 4.8, 1.0, 1.45, 'kiosk'),
    ...pair(-11.5, 9.8, 1.5, 1.5, 1.15, 'crate'), ...pair(-2.5, 16.8, 1.4, 1.4, 1.1, 'crate'),
    ...pair(-21, 17.2, 2.6, 1.0, 1.1, 'bench'),
    // Central plaza: four pillars plus partial cover, with broad entrances.
    box(-4.4, -4.4, 1.45, 1.45, 2.4, 'pillar'), box(4.4, -4.4, 1.45, 1.45, 2.4, 'pillar'),
    box(-4.4, 4.4, 1.45, 1.45, 2.4, 'pillar'), box(4.4, 4.4, 1.45, 1.45, 2.4, 'pillar'),
    box(-8.2, 0, 2.8, 0.85, 1.05, 'bench'), box(8.2, 0, 2.8, 0.85, 1.05, 'bench'),
    // Safe perimeter rails.
    box(-32.15, 0, 0.55, 41.2, 0.75, 'rail'), box(32.15, 0, 0.55, 41.2, 0.75, 'rail'),
    box(0, -20.65, 64.3, 0.55, 0.75, 'rail'), box(0, 20.65, 64.3, 0.55, 0.75, 'rail'),
  ],
  decor: {
    zones: [{ x: 0, z: 0, r: 9.2, tint: '#d39b61', shape: 'circle' }],
    marketStalls, restaurants,
    bushes: [
      { x: -16, z: -18 }, { x: -9, z: -8 }, { x: 9, z: 8 }, { x: 16, z: 18 },
      { x: -21, z: 11 }, { x: 21, z: -11 }, { x: -6.5, z: 7 }, { x: 6.5, z: -7 },
    ],
    lamps: [{ x: -28, z: -18 }, { x: -28, z: 18 }, { x: 28, z: -18 }, { x: 28, z: 18 }],
    banners: [{ x: -31.5, z: -6, team: 'red' }, { x: -31.5, z: 6, team: 'red' }, { x: 31.5, z: -6, team: 'blue' }, { x: 31.5, z: 6, team: 'blue' }],
  },
};
