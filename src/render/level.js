// Builds the arena meshes from a level definition. Purely data-driven: the
// same `solids` list the sim collides against is what gets rendered, styled
// by `kind`, so a new level file automatically renders correctly.

import * as THREE from 'three';
import { TEAMS } from '../core/config.js';
import { toonMat, toonGradient } from './characters.js';
import {
  makeStone, makeBlock, makeColumn, makeBarrel, makeRock, makeLog,
  makeArch, makeTree, makeLantern, makeScaffold, makePowerupPad, makePond,
  makeZone, makeEdge, makeRubble, makeFlowers, makeSteppingStones,
  makeCloudSea, makeFloatingIsland, makePeak, makeWaterfall,
} from './props.js';

// solid `kind`s built by a single props.js function (theme, s) => Object3D
const PROP_SOLIDS = {
  stone: makeStone,
  block: makeBlock,
  column: makeColumn,
  barrel: makeBarrel,
  rock: makeRock,
  log: makeLog,
};

function canvasTex(size, draw, repeat) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  draw(c.getContext('2d'), size);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  if (repeat) {
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(repeat[0], repeat[1]);
  }
  return tex;
}

function floorTexture(theme) {
  return canvasTex(512, (g, s) => {
    g.fillStyle = theme.floor;
    g.fillRect(0, 0, s, s);
    // panel variation
    const tile = s / 4;
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 4; x++) {
        if ((x + y) % 2 === 0) continue;
        g.fillStyle = 'rgba(0,0,0,0.05)';
        g.fillRect(x * tile, y * tile, tile, tile);
      }
    }
    // grime speckle
    for (let i = 0; i < 320; i++) {
      g.fillStyle = `rgba(${Math.random() > 0.5 ? '255,255,255' : '10,15,25'},${0.02 + Math.random() * 0.05})`;
      const r = 1 + Math.random() * 4;
      g.fillRect(Math.random() * s, Math.random() * s, r, r);
    }
    // grout lines
    g.strokeStyle = 'rgba(20,26,36,0.35)';
    g.lineWidth = 3;
    for (let i = 0; i <= 4; i++) {
      g.beginPath(); g.moveTo(i * tile, 0); g.lineTo(i * tile, s); g.stroke();
      g.beginPath(); g.moveTo(0, i * tile); g.lineTo(s, i * tile); g.stroke();
    }
  });
}

function crateTexture(theme) {
  return canvasTex(128, (g, s) => {
    g.fillStyle = theme.crate;
    g.fillRect(0, 0, s, s);
    g.strokeStyle = 'rgba(60,30,5,0.55)';
    g.lineWidth = 5;
    g.strokeRect(4, 4, s - 8, s - 8);
    for (let i = 1; i < 4; i++) { // planks
      g.beginPath(); g.moveTo(0, (i * s) / 4); g.lineTo(s, (i * s) / 4);
      g.lineWidth = 2; g.stroke();
    }
    g.lineWidth = 6; // cross brace
    g.beginPath(); g.moveTo(8, 8); g.lineTo(s - 8, s - 8); g.stroke();
    g.beginPath(); g.moveTo(s - 8, 8); g.lineTo(8, s - 8); g.stroke();
  });
}

export function buildLevel(scene, level, { touch }) {
  const theme = level.theme;
  const group = new THREE.Group();
  group.userData.interactiveMeshes = new Map();
  const { w, d } = level.bounds;

  // floor slab + dark underside skirt (we're floating over a void)
  const floorMat = new THREE.MeshStandardMaterial({
    map: floorTexture(theme),
    roughness: 0.9,
    metalness: 0.05,
  });
  floorMat.map.wrapS = floorMat.map.wrapT = THREE.RepeatWrapping;
  floorMat.map.repeat.set(w / 8, d / 8);
  const floor = new THREE.Mesh(new THREE.BoxGeometry(w, 1.1, d), floorMat);
  floor.position.y = -0.55;
  floor.receiveShadow = true;
  group.add(floor);
  const skirt = new THREE.Mesh(
    new THREE.BoxGeometry(w - 1.6, 6, d - 1.6),
    toonMat('#1b202b'),
  );
  skirt.position.y = -4.1;
  group.add(skirt);

  // tinted zone floor patches — added early (right after the floor) so every
  // other prop below draws over them, and so they read from the top-down cam
  for (const zone of level.decor?.zones ?? []) {
    group.add(makeZone(theme, zone));
  }

  // field markings
  const lineMat = new THREE.MeshBasicMaterial({ color: theme.line, transparent: true, opacity: 0.4, depthWrite: false });
  const midline = new THREE.Mesh(new THREE.PlaneGeometry(0.18, d - 1), lineMat);
  midline.rotation.x = -Math.PI / 2;
  midline.position.y = 0.02;
  const circle = new THREE.Mesh(new THREE.RingGeometry(2.7, 2.92, 48), lineMat);
  circle.rotation.x = -Math.PI / 2;
  circle.position.set(0, 0.02, 0); // center-court marking
  group.add(midline, circle);

  // team base pads (score zones — unmistakable)
  for (const [teamId, base] of Object.entries(level.bases)) {
    const team = TEAMS[teamId];
    const pad = new THREE.Mesh(
      new THREE.CircleGeometry(base.r, 40),
      new THREE.MeshBasicMaterial({ color: team.color, transparent: true, opacity: 0.16, depthWrite: false }),
    );
    pad.rotation.x = -Math.PI / 2;
    pad.position.set(base.x, 0.025, base.z);
    const rim = new THREE.Mesh(
      new THREE.RingGeometry(base.r - 0.18, base.r, 48),
      new THREE.MeshBasicMaterial({ color: team.glow, transparent: true, opacity: 0.85, depthWrite: false }),
    );
    rim.rotation.x = -Math.PI / 2;
    rim.position.set(base.x, 0.03, base.z);
    const chevrons = new THREE.Mesh(
      new THREE.RingGeometry(base.r * 0.35, base.r * 0.5, 3),
      new THREE.MeshBasicMaterial({ color: team.glow, transparent: true, opacity: 0.5, depthWrite: false }),
    );
    chevrons.rotation.x = -Math.PI / 2;
    chevrons.rotation.z = teamId === 'red' ? -Math.PI / 2 : Math.PI / 2; // arrow points inward
    chevrons.position.set(base.x, 0.03, base.z);
    group.add(pad, rim, chevrons);
  }

  // solids — same boxes the sim collides with
  const wallMat = toonMat(theme.wall);
  const wallTopMat = toonMat(theme.wallTop);
  const pillarMat = toonMat(theme.pillar);
  const railMat = toonMat(theme.rail);
  const crateMat = new THREE.MeshStandardMaterial({ map: crateTexture(theme), roughness: 0.85 });
  for (const s of level.solids) {
    let mesh;
    if (PROP_SOLIDS[s.kind]) {
      // multi-part low-poly builders from props.js (stone/block/column/
      // barrel/rock/log) — already positioned and shadow-tagged, just add
      group.add(PROP_SOLIDS[s.kind](theme, s));
      continue;
    }
    if (s.kind === 'rail') {
      // post-and-bar guard rail
      const rail = new THREE.Group();
      const horizontal = s.w > s.d;
      const len = horizontal ? s.w : s.d;
      const bar = new THREE.Mesh(new THREE.BoxGeometry(horizontal ? s.w : 0.14, 0.12, horizontal ? 0.14 : s.d), railMat);
      bar.position.y = s.h - 0.06;
      rail.add(bar);
      const n = Math.max(2, Math.round(len / 2.4));
      for (let i = 0; i <= n; i++) {
        const post = new THREE.Mesh(new THREE.BoxGeometry(0.14, s.h, 0.14), railMat);
        const off = -len / 2 + (i * len) / n;
        post.position.set(horizontal ? off : 0, s.h / 2, horizontal ? 0 : off);
        rail.add(post);
      }
      rail.position.set(s.x, 0, s.z);
      rail.traverse((o) => { if (o.isMesh) o.castShadow = true; });
      group.add(rail);
      continue;
    }
    if (s.kind === 'pillar') {
      mesh = new THREE.Mesh(new THREE.CylinderGeometry(s.w / 2, s.w / 2 + 0.1, s.h, 14), pillarMat);
      mesh.position.set(s.x, s.h / 2, s.z);
      const cap = new THREE.Mesh(
        new THREE.CylinderGeometry(s.w / 2 + 0.12, s.w / 2 + 0.12, 0.12, 14),
        new THREE.MeshBasicMaterial({ color: '#ffcf4d' }),
      );
      cap.position.set(s.x, s.h + 0.06, s.z);
      group.add(cap);
    } else if (s.kind === 'crate') {
      mesh = new THREE.Mesh(new THREE.BoxGeometry(s.w, s.h, s.d), crateMat);
      mesh.position.set(s.x, s.h / 2, s.z);
      mesh.rotation.y = ((s.x * 7 + s.z * 13) % 10) * 0.012; // subtle scatter
    } else {
      mesh = new THREE.Mesh(new THREE.BoxGeometry(s.w, s.h, s.d), wallMat);
      mesh.position.set(s.x, s.h / 2, s.z);
      const cap = new THREE.Mesh(new THREE.BoxGeometry(s.w + 0.08, 0.1, s.d + 0.08), wallTopMat);
      cap.position.set(s.x, s.h + 0.05, s.z);
      cap.castShadow = true;
      group.add(cap);
    }
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  }

  // Feira Suspensa set dressing. These use simple shared primitives so the
  // level remains cheap even during a full 10v10 match.
  for (const stall of level.decor?.marketStalls ?? []) {
    const g = new THREE.Group();
    const counter = new THREE.Mesh(new THREE.BoxGeometry(3.5, 1.05, 1.35), toonMat(theme.wood || theme.crate));
    counter.position.y = 0.53; g.add(counter);
    const roof = new THREE.Mesh(new THREE.BoxGeometry(4.1, 0.18, 2.15), toonMat(stall.color));
    roof.position.y = 2.25; g.add(roof);
    for (const sx of [-1.65, 1.65]) {
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.09, 2.2, 8), toonMat('#664226'));
      post.position.set(sx, 1.1, 0); g.add(post);
    }
    g.position.set(stall.x, 0, stall.z); g.rotation.y = stall.rot || 0;
    g.traverse((o) => { if (o.isMesh) o.castShadow = true; }); group.add(g);
  }
  for (const shop of level.decor?.restaurants ?? []) {
    const g = new THREE.Group();
    const body = new THREE.Mesh(new THREE.BoxGeometry(4.6, 1.8, 1.5), toonMat(shop.color));
    body.position.y = 0.9; g.add(body);
    const awning = new THREE.Mesh(new THREE.BoxGeometry(5, 0.18, 2.2), toonMat('#fff0c7'));
    awning.position.set(0, 1.8, -0.25); g.add(awning);
    g.position.set(shop.x, 0, shop.z); group.add(g);
  }
  for (const b of level.decor?.bushes ?? []) {
    const bush = new THREE.Group();
    for (const [ox, oz, sca] of [[0, 0, 1], [-0.55, 0.15, 0.75], [0.55, 0.1, 0.78]]) {
      const leaf = new THREE.Mesh(new THREE.IcosahedronGeometry(0.85 * sca, 1), toonMat(theme.foliage || '#4f9b55'));
      leaf.position.set(ox, 0.65, oz); bush.add(leaf);
    }
    bush.position.set(b.x, 0, b.z); group.add(bush);
  }
  for (const pad of level.jumpPads ?? []) {
    const g = new THREE.Group();
    const disc = new THREE.Mesh(new THREE.CylinderGeometry(1.25, 1.35, 0.18, 24), toonMat(pad.id.includes('jr') ? '#ef5146' : '#3989ee'));
    disc.position.y = 0.09; g.add(disc);
    const arrow = new THREE.Mesh(new THREE.ConeGeometry(0.42, 1.0, 3), toonMat('#f8e253'));
    arrow.rotation.x = Math.PI / 2; arrow.rotation.z = Math.atan2(pad.tx - pad.x, pad.tz - pad.z); arrow.position.y = 0.23; g.add(arrow);
    g.position.set(pad.x, 0, pad.z); group.add(g);
  }

  for (const cfg of level.interactives ?? []) {
    const g = new THREE.Group();
    if (cfg.type === 'rotator') {
      const disc = new THREE.Mesh(new THREE.CylinderGeometry(cfg.radius, cfg.radius, 0.24, 48), toonMat('#d6914b'));
      disc.position.y = 0.12; g.add(disc);
      const ring = new THREE.Mesh(new THREE.TorusGeometry(cfg.radius - 0.25, 0.13, 8, 48), toonMat('#ffe08a'));
      ring.rotation.x = Math.PI / 2; ring.position.y = 0.26; g.add(ring);
      for (let n = 0; n < 4; n++) {
        const p = new THREE.Mesh(new THREE.CylinderGeometry(0.62, 0.72, 1.65, 12), toonMat(theme.pillar));
        const a = n * Math.PI / 2; p.position.set(Math.cos(a) * 3.25, 0.83, Math.sin(a) * 3.25); p.castShadow = true; g.add(p);
      }
    } else if (cfg.type === 'slider') {
      const wall = new THREE.Mesh(new THREE.BoxGeometry(cfg.w, cfg.h, cfg.d), toonMat('#56717c'));
      wall.position.y = cfg.h / 2; wall.castShadow = true; g.add(wall);
      const beacon = new THREE.Mesh(new THREE.BoxGeometry(cfg.w * 0.7, 0.12, cfg.d + 0.12), toonMat('#f4c542'));
      beacon.position.y = cfg.h + 0.07; beacon.name = 'warning'; g.add(beacon);
    } else if (cfg.type === 'cart') {
      const cart = new THREE.Mesh(new THREE.BoxGeometry(cfg.w, 1.45, cfg.d), toonMat('#ed6c3b'));
      cart.position.y = 0.9; cart.castShadow = true; g.add(cart);
      const roof = new THREE.Mesh(new THREE.BoxGeometry(cfg.w + 0.35, 0.16, cfg.d + 0.4), toonMat('#ffe274'));
      roof.position.y = 1.72; g.add(roof);
      for (const sx of [-1.15, 1.15]) {
        const wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.32, 0.18, 12), toonMat('#29313a'));
        wheel.rotation.x = Math.PI / 2; wheel.position.set(sx, 0.35, cfg.d * 0.5); g.add(wheel);
      }
    } else if (cfg.type === 'bridge') {
      const bridge = new THREE.Mesh(new THREE.BoxGeometry(cfg.w, cfg.h, cfg.d), toonMat('#a96b38'));
      bridge.position.y = cfg.h / 2; bridge.castShadow = true; g.add(bridge);
      g.userData.hingeZ = -cfg.d / 2;
    }
    g.position.set(cfg.x, 0, cfg.z); group.add(g);
    group.userData.interactiveMeshes.set(cfg.id, g);
  }

  // decor: corner lamps + team banners
  for (const lamp of level.decor?.lamps ?? []) {
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.12, 3.4, 8), railMat);
    pole.position.set(lamp.x, 1.7, lamp.z);
    pole.castShadow = true;
    const bulb = new THREE.Mesh(
      new THREE.SphereGeometry(0.26, 12, 10),
      new THREE.MeshBasicMaterial({ color: theme.lamp }),
    );
    bulb.position.set(lamp.x, 3.5, lamp.z);
    group.add(pole, bulb);
    if (!touch) {
      const glow = new THREE.PointLight(theme.lamp, 14, 13, 2);
      glow.position.set(lamp.x, 3.4, lamp.z);
      group.add(glow);
    }
  }
  // measurement rings (physics-lab levels): read distances off the floor
  for (const ring of level.decor?.rings ?? []) {
    const r = new THREE.Mesh(
      new THREE.RingGeometry(ring.r - 0.06, ring.r + 0.06, 56),
      new THREE.MeshBasicMaterial({ color: theme.line, transparent: true, opacity: 0.35, depthWrite: false }),
    );
    r.rotation.x = -Math.PI / 2;
    r.position.set(ring.x, 0.022, ring.z);
    group.add(r);
  }

  for (const b of level.decor?.banners ?? []) {
    const team = TEAMS[b.team];
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.08, 3.0, 8), railMat);
    pole.position.set(b.x, 1.5, b.z);
    const cloth = new THREE.Mesh(
      new THREE.PlaneGeometry(0.95, 1.7),
      new THREE.MeshToonMaterial({ color: team.color, side: THREE.DoubleSide, gradientMap: toonGradient() }),
    );
    const inward = b.x > 0 ? -1 : 1;
    cloth.position.set(b.x + inward * 0.52, 2.1, b.z);
    cloth.rotation.y = inward * 0.35; // angled to read from the fixed camera
    cloth.castShadow = true;
    group.add(pole, cloth);
  }

  // stone archways (ruins)
  for (const a of level.decor?.arches ?? []) group.add(makeArch(theme, a));

  // stylized trees (garden trunks double up on `column` solids where paired)
  for (const t of level.decor?.trees ?? []) group.add(makeTree(theme, t));

  // stone garden lanterns
  for (const l of level.decor?.lanterns ?? []) group.add(makeLantern(theme, l, touch));

  // scattered rubble — one instanced mesh for every rock
  const rubble = makeRubble(theme, level.decor?.rubble ?? []);
  if (rubble) group.add(rubble);

  // flower clusters — one instanced mesh, bright varied colors per instance
  const flowers = makeFlowers(theme, level.decor?.flowers ?? []);
  if (flowers) group.add(flowers);

  // stepping stone discs — one instanced mesh
  const steppingStones = makeSteppingStones(theme, level.decor?.steppingStones ?? []);
  if (steppingStones) group.add(steppingStones);

  // decorative water — visual only, never a solid
  for (const p of level.decor?.ponds ?? []) group.add(makePond(theme, p));

  // wooden scaffolding (watchtower yard)
  for (const sc of level.decor?.scaffold ?? []) group.add(makeScaffold(theme, sc));

  // powerup spawn-pad markers (the powerup system itself isn't built yet)
  for (const pu of level.decor?.powerups ?? []) group.add(makePowerupPad(theme, pu, touch));

  // broken cliff-rim markers along the lethal boundary
  for (const e of level.decor?.edges ?? []) group.add(makeEdge(theme, e));

  if (level.decor?.background) {
    // low-detail distant scenery in a bright sea of clouds — replaces the
    // dark-void starfield, which looks wrong against a bright sky
    const bg = level.decor.background;
    group.add(makeCloudSea(theme, bg));
    for (const isl of bg.islands ?? []) group.add(makeFloatingIsland(theme, isl));
    for (const pk of bg.peaks ?? []) group.add(makePeak(theme, pk));
    for (const wf of bg.waterfalls ?? []) group.add(makeWaterfall(theme, wf));
  } else {
    // starfield void below/around the platform
    const starGeo = new THREE.BufferGeometry();
    const starPos = new Float32Array(260 * 3);
    for (let i = 0; i < 260; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = 45 + Math.random() * 70;
      starPos[i * 3] = Math.cos(a) * r;
      starPos[i * 3 + 1] = -30 + Math.random() * 55;
      starPos[i * 3 + 2] = Math.sin(a) * r;
    }
    starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
    const stars = new THREE.Points(starGeo, new THREE.PointsMaterial({
      color: '#8fb3ff', size: 0.4, transparent: true, opacity: 0.7, fog: false,
    }));
    group.add(stars);
  }

  scene.add(group);
  return group;
}
