// Character models + animation. Bombsquad-style bobbleheads: big round head,
// stubby body, expressive eyes. Everything is built from primitives at
// runtime — no asset downloads — and styled with a 3-step toon ramp.
//
// Cosmetics: buildHat() is the extension point — each hat id from
// content/cosmetics.js gets a small mesh group mounted on the head. Skins
// tint head + hands. Team is communicated by jersey, headband and feet.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { TEAMS } from '../core/config.js';
import { clamp, lerp } from '../core/math.js';

let gradTex = null;
export function toonGradient() {
  if (!gradTex) {
    gradTex = new THREE.DataTexture(
      new Uint8Array([90, 90, 90, 255, 170, 170, 170, 255, 255, 255, 255, 255]),
      3, 1, THREE.RGBAFormat,
    );
    gradTex.needsUpdate = true;
    gradTex.magFilter = THREE.NearestFilter;
    gradTex.minFilter = THREE.NearestFilter;
  }
  return gradTex;
}

const matCache = new Map();
export function toonMat(color, extra = {}) {
  const key = color + JSON.stringify(extra);
  if (!matCache.has(key)) {
    matCache.set(key, new THREE.MeshToonMaterial({ color, gradientMap: toonGradient(), ...extra }));
  }
  return matCache.get(key);
}

function makeNameSprite(name, colorHex) {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 64;
  const g = c.getContext('2d');
  g.font = '700 34px system-ui, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.lineWidth = 7;
  g.strokeStyle = 'rgba(10,12,18,0.9)';
  g.strokeText(name, 128, 34);
  g.fillStyle = colorHex;
  g.fillText(name, 128, 34);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
  sprite.scale.set(2.1, 0.52, 1);
  return sprite;
}

// --- cosmetic hats -----------------------------------------------------
export function buildHat(id) {
  const h = new THREE.Group();
  const gold = toonMat('#ffcf4d', { emissive: '#4d3200' });
  switch (id) {
    case 'cap': {
      const m = toonMat('#2e6b4f');
      const dome = new THREE.Mesh(new THREE.SphereGeometry(0.34, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2), m);
      dome.scale.y = 0.62;
      const brim = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.05, 0.3), m);
      brim.position.set(0, 0.0, 0.36);
      h.add(dome, brim);
      break;
    }
    case 'tophat': {
      const m = toonMat('#191922');
      const tube = new THREE.Mesh(new THREE.CylinderGeometry(0.26, 0.26, 0.44, 14), m);
      tube.position.y = 0.24;
      const brim = new THREE.Mesh(new THREE.CylinderGeometry(0.44, 0.44, 0.05, 18), m);
      const band = new THREE.Mesh(new THREE.CylinderGeometry(0.27, 0.27, 0.09, 14), toonMat('#c0392b'));
      band.position.y = 0.08;
      h.add(tube, brim, band);
      break;
    }
    case 'crown': {
      const ring = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.33, 0.18, 12), gold);
      ring.position.y = 0.06;
      h.add(ring);
      for (let i = 0; i < 5; i++) {
        const spike = new THREE.Mesh(new THREE.ConeGeometry(0.06, 0.16, 6), gold);
        const a = (i / 5) * Math.PI * 2;
        spike.position.set(Math.sin(a) * 0.28, 0.2, Math.cos(a) * 0.28);
        h.add(spike);
      }
      break;
    }
    case 'halo': {
      const halo = new THREE.Mesh(
        new THREE.TorusGeometry(0.3, 0.045, 10, 24),
        new THREE.MeshBasicMaterial({ color: '#ffe27a' }),
      );
      halo.rotation.x = Math.PI / 2;
      halo.position.y = 0.34;
      halo.userData.float = true; // bobbed in update()
      h.add(halo);
      break;
    }
    case 'horns': {
      const m = toonMat('#d63b2f');
      for (const s of [-1, 1]) {
        const horn = new THREE.Mesh(new THREE.ConeGeometry(0.09, 0.3, 8), m);
        horn.position.set(0.26 * s, 0.1, 0);
        horn.rotation.z = -0.5 * s;
        h.add(horn);
      }
      break;
    }
    case 'chef': {
      const m = toonMat('#f4f2ec');
      const base = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.3, 0.24, 14), m);
      base.position.y = 0.08;
      const puff = new THREE.Mesh(new THREE.SphereGeometry(0.32, 14, 10), m);
      puff.scale.set(1, 0.7, 1);
      puff.position.y = 0.28;
      h.add(base, puff);
      break;
    }
    default:
      return null;
  }
  h.traverse((o) => { if (o.isMesh) o.castShadow = true; });
  return h;
}

const _tempVec = new THREE.Vector3();
let starGeo = null;
let starMat = null;

function getStarGeometry() {
  if (!starGeo) {
    const shape = new THREE.Shape();
    const points = 5;
    const outerRadius = 0.13;
    const innerRadius = 0.055;
    for (let i = 0; i < points * 2; i++) {
      const r = i % 2 === 0 ? outerRadius : innerRadius;
      const a = (i / (points * 2)) * Math.PI * 2 - Math.PI / 2;
      const x = Math.cos(a) * r;
      const y = Math.sin(a) * r;
      if (i === 0) shape.moveTo(x, y);
      else shape.lineTo(x, y);
    }
    shape.closePath();
    const extrudeSettings = {
      depth: 0.035,
      bevelEnabled: true,
      bevelSegments: 2,
      steps: 1,
      bevelSize: 0.015,
      bevelThickness: 0.015,
    };
    starGeo = new THREE.ExtrudeGeometry(shape, extrudeSettings);
    starGeo.center();
  }
  return starGeo;
}

function getStarMaterial() {
  if (!starMat) {
    starMat = new THREE.MeshStandardMaterial({
      color: '#ffea00',
      emissive: '#ffaa00',
      emissiveIntensity: 0.75,
      roughness: 0.2,
      metalness: 0.8,
    });
  }
  return starMat;
}

// --- capivara 3d model loader & team textures --------------------------
let capivaraTemplate = null;
let capivaraPromise = null;
let blueCapivaraTex = null;
let blueCapivaraMat = null;
let redCapivaraMat = null;

export function getBlueCapivaraTexture() {
  if (!blueCapivaraTex) {
    const loader = new THREE.TextureLoader();
    blueCapivaraTex = loader.load('./models/Color_blue_v3.jpg');
    blueCapivaraTex.flipY = false;
    blueCapivaraTex.colorSpace = THREE.SRGBColorSpace;
  }
  return blueCapivaraTex;
}

export function getBlueCapivaraMaterial(baseMat) {
  if (!blueCapivaraMat && baseMat) {
    blueCapivaraMat = baseMat.clone();
    blueCapivaraMat.map = getBlueCapivaraTexture();
    blueCapivaraMat.needsUpdate = true;
  }
  return blueCapivaraMat;
}

export function getCapivaraModel() {
  if (capivaraTemplate) return Promise.resolve(capivaraTemplate);
  if (!capivaraPromise) {
    const loader = new GLTFLoader();
    capivaraPromise = new Promise((resolve) => {
      loader.load(
        './models/capivara_2_color_v2.glb',
        (gltf) => {
          const root = gltf.scene;

          // Compute bounding box
          const box = new THREE.Box3().setFromObject(root);
          const size = box.getSize(new THREE.Vector3());
          const center = box.getCenter(new THREE.Vector3());

          // Center on X and Z, set bottom to Y = 0 with a safe ground cushion
          root.position.x -= center.x;
          root.position.z -= center.z;
          root.position.y -= box.min.y - 0.05;

          const inner = new THREE.Group();
          inner.name = 'capivara_inner';
          inner.add(root);
          // Model geometry's snout points towards +X (90° to the right).
          // Rotating by -90° (-Math.PI / 2) aligns the snout forward (+Z) so WASD directions match!
          inner.rotation.y = window.capivaraRotationOffset ?? (-Math.PI / 2);

          const wrapper = new THREE.Group();
          wrapper.name = 'capivara_wrapper';
          wrapper.add(inner);

          // Target height ~2.2 units (substantially bigger and prominent, matching game scale)
          const currentHeight = size.y || 1;
          const targetHeight = 2.2;
          const s = targetHeight / currentHeight;
          wrapper.scale.set(s, s, s);

          wrapper.traverse((o) => {
            if (o.isMesh) {
              o.castShadow = true;
              o.receiveShadow = false; // Disable self-shadow on deforming skinned mesh to eliminate shadow acne & stippling flicker!
              if (o.material) {
                o.material.roughness = 0.85;
                o.material.metalness = 0.05;
                if (!redCapivaraMat) redCapivaraMat = o.material;
              }
            }
          });

          capivaraTemplate = wrapper;
          resolve(wrapper);
        },
        undefined,
        (err) => {
          console.error('Failed to load capivara model:', err);
          resolve(null);
        }
      );
    });
  }
  return capivaraPromise;
}

function makeCapivaraGlove(isLeft = false) {
  const g = new THREE.Group();
  const redMat = toonMat('#e0372a', { emissive: '#440a08' });
  const whiteMat = toonMat('#f4f4f6');
  const fist = new THREE.Mesh(new THREE.SphereGeometry(0.12, 12, 10), redMat);
  fist.scale.set(1.2, 1.25, 1.35);
  const thumb = new THREE.Mesh(new THREE.SphereGeometry(0.06, 8, 6), redMat);
  thumb.position.set(isLeft ? -0.09 : 0.09, 0.02, 0.05);
  const cuff = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.10, 0.06, 12), whiteMat);
  cuff.rotation.x = Math.PI / 2;
  cuff.position.set(0, 0, -0.06);
  g.add(fist, thumb, cuff);
  g.traverse((o) => { if (o.isMesh) o.castShadow = true; });
  g.visible = false;
  return g;
}

// --- the character ------------------------------------------------------
export class CharacterView {
  constructor(scene, p, isMe) {
    const team = TEAMS[p.team];
    this.team = p.team;
    this.scene = scene;
    this.phase = Math.random() * 10;
    this.blinkAt = 2 + Math.random() * 3;
    this.blinkT = 0;
    this.lie = 0; // 0 upright .. 1 flat on back (KO)
    this.grabLie = 0; // 0 normal .. 1 lying down struggling when grabbed
    this.time = 0;
    this.isMe = isMe;
    this.punchedT = 0;
    this.punchHitDir = 1;

    const jersey = toonMat(team.color);
    const jerseyDark = toonMat(team.dark);
    const skin = toonMat(p.cos?.skin || '#ffd29c');
    const white = toonMat('#ffffff');
    const black = new THREE.MeshBasicMaterial({ color: '#14161c' });

    this.group = new THREE.Group();
    this.rig = new THREE.Group(); // yaw (facing)
    this.pose = new THREE.Group(); // pitch/tumble (running lean, KO flop)
    this.group.add(this.rig);
    this.rig.add(this.pose);

    this.humanoidGroup = new THREE.Group();
    this.humanoidGroup.position.y = 0.19;
    // NEVER show legacy characters by default — keep hidden while 3D model loads
    this.humanoidGroup.visible = false;
    this.pose.add(this.humanoidGroup);

    // torso
    const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.34, 0.34, 6, 14), jersey);
    torso.position.y = 0.62;
    // head
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.42, 20, 16), skin);
    head.position.y = 1.3;
    head.scale.y = 0.95;
    // team headband
    const band = new THREE.Mesh(new THREE.TorusGeometry(0.4, 0.075, 8, 22), jersey);
    band.rotation.x = Math.PI / 2 - 0.18;
    band.position.y = 1.42;
    this.humanoidGroup.add(torso, head, band);

    // face
    this.eyes = [];
    this.pupils = [];
    this.xeyes = [];
    for (const s of [-1, 1]) {
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.105, 12, 10), white);
      eye.position.set(0.15 * s, 1.36, 0.34);
      const pupil = new THREE.Mesh(new THREE.SphereGeometry(0.048, 8, 8), black);
      pupil.position.set(0.15 * s, 1.36, 0.43);
      // knocked-out X eyes
      const xg = new THREE.Group();
      for (const r of [0.8, -0.8]) {
        const bar = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.035, 0.02), black);
        bar.rotation.z = r;
        xg.add(bar);
      }
      xg.position.set(0.15 * s, 1.36, 0.42);
      xg.visible = false;
      this.humanoidGroup.add(eye, pupil, xg);
      this.eyes.push(eye);
      this.pupils.push(pupil);
      this.xeyes.push(xg);
    }
    const brow = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.045, 0.03), black);
    brow.position.set(0, 1.52, 0.36);
    const mouth = new THREE.Mesh(new THREE.SphereGeometry(0.06, 8, 6), black);
    mouth.scale.set(1.4, 0.55, 0.5);
    mouth.position.set(0, 1.16, 0.4);
    this.humanoidGroup.add(brow, mouth);

    // limbs (group pivots at joint, mesh hangs below)
    const limb = (r, len, mat, handMat, handR) => {
      const g = new THREE.Group();
      const seg = new THREE.Mesh(new THREE.CapsuleGeometry(r, len, 4, 10), mat);
      seg.position.y = -(len / 2 + r);
      const tip = new THREE.Mesh(new THREE.SphereGeometry(handR, 10, 8), handMat);
      tip.position.y = -(len + r * 2);
      g.add(seg, tip);
      g.userData.tip = tip;
      return g;
    };
    this.armL = limb(0.105, 0.3, jersey, skin, 0.13);
    this.armR = limb(0.105, 0.3, jersey, skin, 0.13);
    this.armL.position.set(-0.42, 0.95, 0);
    this.armR.position.set(0.42, 0.95, 0);
    this.legL = limb(0.12, 0.22, jerseyDark, jerseyDark, 0.15);
    this.legR = limb(0.12, 0.22, jerseyDark, jerseyDark, 0.15);
    this.legL.position.set(-0.17, 0.42, 0);
    this.legR.position.set(0.17, 0.42, 0);
    this.humanoidGroup.add(this.armL, this.armR, this.legL, this.legR);
    // fists swell into red boxing gloves while the powerup is live
    this.hands = [this.armL.userData.tip, this.armR.userData.tip];
    this.skinMat = skin;
    this.gloveMat = toonMat('#e0372a');

    // --- powerup add-ons (driven by sim state each frame) ---
    // energy shield: a translucent bubble that dims as it takes hits
    this.shieldMat = new THREE.MeshBasicMaterial({
      color: '#7a5cff', transparent: true, opacity: 0.3,
      depthWrite: false, side: THREE.DoubleSide,
    });
    this.shield = new THREE.Mesh(new THREE.SphereGeometry(1.05, 18, 12), this.shieldMat);
    this.shield.position.y = 0.95;
    this.shield.visible = false;
    this.group.add(this.shield);
    // frozen solid: an ice casing around the body
    this.iceMat = new THREE.MeshToonMaterial({
      color: '#bfe8ff', gradientMap: toonGradient(),
      transparent: true, opacity: 0.55,
    });
    this.ice = new THREE.Mesh(new THREE.BoxGeometry(1.15, 1.95, 1.0), this.iceMat);
    this.ice.position.y = 0.95;
    this.ice.visible = false;
    this.pose.add(this.ice);
    // cursed: a dark aura that pulses faster as the countdown runs out
    this.curseMat = new THREE.MeshBasicMaterial({
      color: '#3d1450', transparent: true, opacity: 0.4, depthWrite: false,
    });
    this.curse = new THREE.Mesh(new THREE.SphereGeometry(0.95, 16, 12), this.curseMat);
    this.curse.position.y = 0.95;
    this.curse.visible = false;
    this.group.add(this.curse);

    // cosmetic hat (hidden by default since 3D capivaras don't need human hats)
    const hat = buildHat(p.cos?.hat);
    if (hat) {
      hat.position.y = 1.62;
      hat.visible = false;
      this.hat = hat;
      this.pose.add(hat);
    }

    // --- Capivara 3D Model integration ---
    const attachCapivara = (template) => {
      if (!template || this.capivara) return;
      const capivara = cloneSkinned ? cloneSkinned(template) : template.clone(true);
      this.capivara = capivara;

      // Team colors: Blue team capivaras wear the stylish Blue jacket!
      if (this.team === 'blue') {
        capivara.traverse((o) => {
          if (o.isMesh && o.material) {
            o.material = getBlueCapivaraMaterial(o.material);
          }
        });
      }

      // Cache bones, rest rotations, and rest positions for procedural skeletal animation
      this.capBones = {};
      this.capRestRot = {};
      this.capRestPos = {};
      capivara.traverse((o) => {
        if (o.isBone) {
          this.capBones[o.name] = o;
          this.capRestRot[o.name] = o.rotation.clone();
          this.capRestPos[o.name] = o.position.clone();
        }
      });

      this.pose.add(capivara);

      if (this.capBones.L_Hand) {
        this.capGloveL = makeCapivaraGlove(true);
        this.capBones.L_Hand.add(this.capGloveL);
      }
      if (this.capBones.R_Hand) {
        this.capGloveR = makeCapivaraGlove(false);
        this.capBones.R_Hand.add(this.capGloveR);
      }

      // Default: ALL characters in the game are Capivaras!
      const show = window.capivaraMode !== 'classic';
      if (show) {
        this.humanoidGroup.visible = false;
        if (this.hat) this.hat.visible = false;
        capivara.visible = true;
      } else {
        capivara.visible = false;
        this.humanoidGroup.visible = true;
        if (this.hat) this.hat.visible = true;
      }
    };

    if (capivaraTemplate) {
      // Synchronously attach immediately with ZERO latency / no flash!
      attachCapivara(capivaraTemplate);
    } else {
      getCapivaraModel().then(attachCapivara);
    }

    if (typeof window !== 'undefined') {
      window.characterViews = window.characterViews || new Set();
      window.characterViews.add(this);

      if (!window.toggleCapivara) {
        window.capivaraMode = 'all'; // Default: 'all' -> 'player' -> 'classic'
        window.toggleCapivara = () => {
          if (window.capivaraMode === 'all') window.capivaraMode = 'player';
          else if (window.capivaraMode === 'player') window.capivaraMode = 'classic';
          else window.capivaraMode = 'all';

          for (const cv of window.characterViews || []) {
            if (cv.capivara) {
              const show = window.capivaraMode === 'all' || (window.capivaraMode === 'player' && cv.isMe);
              cv.capivara.visible = show;
              cv.humanoidGroup.visible = !show;
              if (cv.hat) cv.hat.visible = !show;
            }
          }
          console.log('[Capivara Mode]:', window.capivaraMode);
        };
      }

      if (!window.toggleCapivaraRing) {
        window.capivaraRingVisible = false;
        window.toggleCapivaraRing = () => {};
      }

      if (!window.rotateCapivara) {
        window.capivaraRotationOffset = -Math.PI / 2; // -90° (aligns snout forward with +Z)
        window.rotateCapivara = (delta = Math.PI / 2) => {
          let next = window.capivaraRotationOffset + delta;
          while (next < 0) next += Math.PI * 2;
          window.capivaraRotationOffset = next % (Math.PI * 2);
          for (const cv of window.characterViews || []) {
            if (cv.capivara) {
              const inner = cv.capivara.getObjectByName('capivara_inner');
              if (inner) inner.rotation.y = window.capivaraRotationOffset;
            }
          }
          const deg = Math.round((window.capivaraRotationOffset * 180) / Math.PI);
          console.log('[Capivara Rotation]:', deg + '°');
        };
      }

      if (!window.setCapivaraScale) {
        window.capivaraHeight = 2.2;
        window.setCapivaraScale = (height) => {
          window.capivaraHeight = height;
          for (const cv of window.characterViews || []) {
            if (cv.capivara) {
              const s = height / 0.978998;
              cv.capivara.scale.set(s, s, s);
            }
            if (cv.capivaraRing) {
              cv.capivaraRing.position.y = height + 0.03;
            }
          }
          console.log('[Capivara Height]:', height);
        };
      }
    }

    // name tag + local-player ground marker
    if (!p.participantId || !p.displayName) {
      throw new Error(`[RENDER] refusing character without participant identity id=${p.id ?? '(missing)'}`);
    }
    this.participantId = p.participantId;
    this.matchId = p.matchId ?? null;
    this.participantType = p.type;
    this.name = makeNameSprite(p.displayName, team.color);
    this.name.position.y = 2.45;
    this.group.add(this.name);
    if (isMe) {
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(0.62, 0.78, 28),
        new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.5, depthWrite: false }),
      );
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = 0.03;
      this.groundRing = ring;
      this.group.add(ring);
    }

    // Knockout dizzy stars circling above head
    this.dizzyGroup = new THREE.Group();
    this.dizzyStars = [];
    const numStars = 4;
    const starG = getStarGeometry();
    const starM = getStarMaterial();
    for (let i = 0; i < numStars; i++) {
      const s = new THREE.Mesh(starG, starM);
      this.dizzyGroup.add(s);
      this.dizzyStars.push(s);
    }
    this.dizzyGroup.visible = false;
    this.dizzyScale = 0;
    this.group.add(this.dizzyGroup);

    this.pose.traverse((o) => { if (o.isMesh) o.castShadow = true; });
    scene.add(this.group);
  }

  onPunched(ev) {
    this.punchedT = 0.45;
    this.punchHitDir = Math.random() < 0.5 ? -1 : 1;
    this.blinkT = 0.28;
  }

  update(p, dt) {
    this.time += dt;

    if ((p.punchedT ?? 0) > this.punchedT) {
      this.punchedT = p.punchedT;
      if (!this.punchHitDir) this.punchHitDir = Math.random() < 0.5 ? -1 : 1;
    }
    this.punchedT = Math.max(0, this.punchedT - dt);

    if (p.team && p.team !== this.team) {
      this.team = p.team;
      const tInfo = TEAMS[this.team];
      if (this.capivaraRing && tInfo) {
        this.capivaraRing.material = toonMat(tInfo.color);
      }
      if (this.capivara) {
        const isBlue = this.team === 'blue';
        this.capivara.traverse((o) => {
          if (o.isMesh && o.material) {
            o.material = isBlue ? getBlueCapivaraMaterial(o.material) : (redCapivaraMat || o.material);
          }
        });
      }
    }

    const g = this.group;
    g.position.set(p.x, p.y, p.z);
    this.rig.rotation.y = p.face;

    if (this.groundRing) {
      this.groundRing.visible = p.y >= -0.15 && p.state === 'alive';
    }
    if (this.name) {
      this.name.visible = p.state !== 'ko' && p.y >= -6;
    }

    const ko = p.state === 'ko';
    // knocked out cold (alive, unconscious): tumbles mid-air, lies flat on
    // the ground until it wears off — BombSquad's knockout ragdoll
    const knocked = !ko && (p.knockT ?? 0) > 0;
    const isHeld = !!p.heldBy && p.heldPlayer !== p.heldBy;

    // Punch hit reaction envelope: snappy recoil peaking in ~90ms, springy settling wobble
    const flinchDur = 0.45;
    let hitFlinch = 0;
    let hitWobble = 0;
    if (this.punchedT > 0 && !ko && !knocked) {
      const tNorm = clamp(1 - this.punchedT / flinchDur, 0, 1);
      if (tNorm < 0.20) {
        hitFlinch = Math.sin((tNorm / 0.20) * (Math.PI / 2));
      } else {
        const dec = (tNorm - 0.20) / 0.80;
        hitFlinch = Math.exp(-3.8 * dec);
        hitWobble = Math.sin(dec * Math.PI * 3.5) * Math.exp(-2.8 * dec);
      }
    }

    this.lie = clamp(this.lie + (ko || (knocked && p.y <= 0.05) ? 5 : -8) * dt, 0, 1);
    this.grabLie = clamp(this.grabLie + (isHeld ? 14 : -10) * dt, 0, 1);
    for (const x of this.xeyes) x.visible = ko;
    for (const e of this.eyes) e.visible = !ko;
    for (const pu of this.pupils) pu.visible = !ko;

    if ((ko || knocked) && (p.y > 0.05 || p.y < -0.05)) {
      this.pose.rotation.x -= 8 * dt; // tumbling through the air
      // Anti-floor-clipping during mid-air tumble: ONLY when on or above the floor!
      if (p.y >= -0.05) {
        const rx = this.pose.rotation.x;
        const cosX = Math.cos(rx);
        const sinX = Math.sin(rx);
        const H = 2.35, D = 1.95;
        const minLocalY = (cosX < 0 ? H * cosX : 0) - Math.abs(sinX) * (D / 2);
        const downReach = -minLocalY;
        const floorY = Math.max(0, p.y);
        if (floorY + (this.pose.position.y || 0) - downReach < 0.04) {
          this.pose.position.y = downReach - floorY + 0.04;
        }
      }
    } else {
      const run = knocked ? 0 : clamp(p.spd / 6.8, 0, 1.2);
      this.phase += dt * (3.6 + p.spd * 1.9);
      const airborne = p.y > 0.05 || p.y < -0.05;
      const sw = Math.sin(this.phase) * 0.95 * run;
      // legs tuck mid-jump instead of cycling
      this.legL.rotation.x = airborne ? 0.55 : sw;
      this.legR.rotation.x = airborne ? -0.25 : -sw;
      const armSw = -sw * 0.8;
      this.armL.rotation.x = armSw;
      this.armR.rotation.x = -armSw;
      // anything grabbed — flag, bomb, or a whole player — is hoisted
      // overhead with BOTH hands (BombSquad carry)
      const holding = p.carryFlag || p.heldBomb || p.heldPlayer;
      if (holding) {
        this.armL.rotation.x = -2.75;
        this.armR.rotation.x = -2.75;
      }
      if (p.throwT > 0) {
        // big hurl: windup -> release over 0.35s (both arms if carrying)
        const t = 1 - p.throwT / 0.35;
        const swing = t < 0.4 ? lerp(0, -2.6, t / 0.4) : lerp(-2.6, 0.9, (t - 0.4) / 0.6);
        this.armR.rotation.x = swing;
        if (holding) this.armL.rotation.x = swing;
      }
      if ((p.punchT ?? 0) > 0) {
        // alternating jabs: right, left, right, left...
        const arm = p.punchArm ? this.armL : this.armR;
        const t = 1 - p.punchT / 0.3;
        arm.rotation.x = t < 0.3 ? lerp(0, -1.9, t / 0.3) : lerp(-1.9, 0.7, (t - 0.3) / 0.7);
      }
      // hoisted in someone's grip: lie flat overhead and struggle frantically
      if (isHeld) {
        const struggleSpeed = 24;
        this.legL.rotation.x = Math.sin(this.time * struggleSpeed) * 1.1;
        this.legR.rotation.x = -Math.sin(this.time * struggleSpeed) * 1.1;
        this.legL.rotation.z = Math.cos(this.time * (struggleSpeed * 0.75)) * 0.35;
        this.legR.rotation.z = -Math.cos(this.time * (struggleSpeed * 0.75)) * 0.35;
        if (!(p.punchT > 0)) {
          this.armL.rotation.x = -1.2 + Math.sin(this.time * (struggleSpeed * 1.05)) * 0.85;
          this.armR.rotation.x = -1.2 - Math.sin(this.time * (struggleSpeed * 1.05)) * 0.85;
          this.armL.rotation.z = Math.cos(this.time * (struggleSpeed * 0.8)) * 0.45;
          this.armR.rotation.z = -Math.cos(this.time * (struggleSpeed * 0.8)) * 0.45;
        }
      }
      // upright <-> flat-on-back blend + running lean, jump-arc pitch & bob
      const airPitch = airborne ? clamp(-p.vy * 0.045, -0.4, 0.5) : 0;
      const normalPitch = this.capivara?.visible ? airPitch : (0.16 * run + airPitch);
      const koPitch = -Math.PI / 2 + 0.22;
      const struggleSpeed = 24;
      const struggleWiggle = isHeld ? Math.sin(this.time * struggleSpeed * 0.7) * 0.15 : 0;
      const heldPitch = -Math.PI / 2 + 0.15 + struggleWiggle;

      const pitch = lerp(normalPitch, koPitch, this.lie);
      this.pose.rotation.x = lerp(pitch, heldPitch, this.grabLie) - (isHeld ? 0 : 0.42 * hitFlinch);

      // Roll and Yaw struggling wriggles when grabbed + punch hit flinch
      const struggleRoll = isHeld ? Math.sin(this.time * struggleSpeed) * 0.22 : 0;
      const struggleYaw = isHeld ? Math.cos(this.time * struggleSpeed * 0.8) * 0.18 : 0;
      const punchRoll = isHeld ? 0 : this.punchHitDir * (0.28 * hitFlinch + 0.12 * hitWobble);
      const punchYaw = isHeld ? 0 : -this.punchHitDir * 0.18 * hitFlinch;
      this.pose.rotation.z = (knocked && p.y <= 0.05 ? Math.sin(this.time * 20) * 0.12 : 0) + struggleRoll * this.grabLie + punchRoll;
      this.pose.rotation.y = struggleYaw * this.grabLie + punchYaw;

      if (hitFlinch > 0.01 && !isHeld) {
        this.armL.rotation.x -= 0.65 * hitFlinch;
        this.armR.rotation.x -= 0.65 * hitFlinch;
        this.armL.rotation.z -= 0.45 * hitFlinch;
        this.armR.rotation.z += 0.45 * hitFlinch;
      }

      // Position struggling heave and jitter
      const struggleHeave = isHeld ? Math.abs(Math.sin(this.time * struggleSpeed)) * 0.08 : 0;
      const struggleJitterX = isHeld ? Math.sin(this.time * struggleSpeed * 1.2) * 0.06 : 0;
      const struggleJitterZ = isHeld ? Math.cos(this.time * struggleSpeed * 1.1) * 0.06 : 0;

      // For humanoid, pose.position.y bounced because it lacked skeleton bones.
      // For capivara, bounce is handled smoothly and naturally on the skeleton pelvis!
      const normalPosY = this.capivara?.visible ? 0 : Math.abs(Math.sin(this.phase)) * 0.09 * run;
      const koPosY = this.capivara?.visible ? 0.85 : 0.42;
      const heldPosY = (this.capivara?.visible ? 0.40 : 0.20) + struggleHeave;
      const posY = lerp(normalPosY, koPosY, this.lie);
      this.pose.position.y = lerp(posY, heldPosY, this.grabLie);
      this.pose.position.x = struggleJitterX * this.grabLie;
      this.pose.position.z = struggleJitterZ * this.grabLie;

      // Absolute floor penetration guard for any pitch, roll or flinch orientation (ONLY when on or above the floor):
      if (this.capivara?.visible && p.y >= -0.05) {
        const rx = this.pose.rotation.x;
        const rz = this.pose.rotation.z;
        const cosX = Math.cos(rx);
        const sinX = Math.sin(rx);
        const sinZ = Math.sin(rz);
        const H = 2.35, D = 1.95, W = 1.35;
        const minLocalY = (cosX < 0 ? H * cosX : 0) - Math.abs(sinX) * (D / 2) - Math.abs(sinZ) * (W / 2);
        const downReach = -minLocalY;
        const floorY = Math.max(0, p.y);
        const minAllowed = 0.04;
        if (floorY + this.pose.position.y - downReach < minAllowed) {
          this.pose.position.y = downReach - floorY + minAllowed;
        }
      }
    }

    if (this.capivara && this.capivara.visible) {
      const run = knocked ? 0 : clamp(p.spd / 6.8, 0, 1.2);
      const b = this.capBones;
      const r = this.capRestRot;
      const pos = this.capRestPos;

      if (b && r) {
        const breathe = Math.sin(this.time * 2.5);
        const airborne = (p.y > 0.05 || p.y < -0.05) && !isHeld;
        const holding = p.carryFlag || p.heldBomb || p.heldPlayer;
        const punching = (p.punchT ?? 0) > 0;
        const throwing = (p.throwT ?? 0) > 0;

        // Superman Punch Jump & Lunge Mechanics:
        // Explosive leap off ground, forward lunge surge, and Superman flight strike!
        let punchHopY = 0;
        let punchLungeZ = 0;
        let supermanProg = 0;
        let supermanLegProg = 0;

        if (punching) {
          const t = clamp(1 - (p.punchT ?? 0) / 0.3, 0, 1);
          // Parabolic hop: launches into the air (up to +0.38), smoothly lands
          const hopU = clamp(t / 0.88, 0, 1);
          punchHopY = Math.sin(hopU * Math.PI) * 0.38;

          // Forward Superman lunge: gentle visual lunge that stays safely inside collision bounds
          punchLungeZ = Math.sin(hopU * Math.PI * 0.95) * 0.15;

          // Strike progression: explosive punch thrust at apex of leap
          if (t < 0.28) {
            supermanProg = Math.sin((t / 0.28) * Math.PI * 0.5);
          } else if (t < 0.62) {
            supermanProg = 1.0; // hold full heroic Superman extension during mid-air flight!
          } else {
            const rec = (t - 0.62) / 0.38;
            supermanProg = 1.0 - rec * rec; // smooth recoil upon landing
          }
          supermanLegProg = Math.sin(hopU * Math.PI);
        }

        // Stagger translation and rotation from punch impact (never dips below ground)
        const punchStaggerZ = -0.10 * hitFlinch;
        const punchStaggerY = 0;
        const punchStaggerRotX = -0.15 * hitFlinch;
        const punchStaggerRotZ = this.punchHitDir * (0.15 * hitFlinch + 0.06 * hitWobble);
        const punchStaggerRotY = -this.punchHitDir * 0.10 * hitFlinch;

        // Apply Superman leap translation + Punch stagger recoil to the capivara root
        this.capivara.position.y = punchHopY + (isHeld ? 0 : punchStaggerY);
        this.capivara.position.z = punchLungeZ + (isHeld ? 0 : punchStaggerZ);
        this.capivara.rotation.x = isHeld ? 0 : punchStaggerRotX;
        this.capivara.rotation.y = isHeld ? 0 : punchStaggerRotY;

        // Overall waddle: smooth, gentle mascot waddle
        const waddleAmp = holding ? 0.055 : 0.032;
        this.capivara.rotation.z = isHeld ? 0 : (Math.sin(this.phase) * waddleAmp * run + punchStaggerRotZ);

        // --- 1. PELVIS / HIPS & ROOT BOUNCE ---
        if (b.Pelvis && pos?.Pelvis) {
          if (isHeld) {
            const struggleSpeed = 24;
            b.Pelvis.position.y = pos.Pelvis.y + Math.abs(Math.sin(this.time * struggleSpeed)) * 0.04;
          } else if (hitFlinch > 0.01) {
            b.Pelvis.position.y = pos.Pelvis.y - 0.05 * hitFlinch;
            b.Pelvis.position.z = (pos.Pelvis.z || 0) - 0.08 * hitFlinch;
          } else if (airborne) {
            b.Pelvis.position.y = pos.Pelvis.y + 0.03;
          } else if (run > 0.05) {
            // Smooth sinusoidal bounce: continuous velocity, zero jerk / no sharp bounce!
            const bounce = (0.5 - 0.5 * Math.cos(this.phase * 2)) * 0.032 * run;
            b.Pelvis.position.y = pos.Pelvis.y + bounce;
          } else {
            // Idle breathing rise and fall
            b.Pelvis.position.y = pos.Pelvis.y + breathe * 0.006;
          }
        }

        // Hips yaw and roll: swivel into each step smoothly
        const sw = Math.sin(this.phase) * run;
        const cw = Math.cos(this.phase) * run;
        if (b.Pelvis && r.Pelvis) {
          if (isHeld) {
            const struggleSpeed = 24;
            b.Pelvis.rotation.y = r.Pelvis.y - Math.cos(this.time * struggleSpeed) * 0.25;
            b.Pelvis.rotation.z = r.Pelvis.z + Math.sin(this.time * struggleSpeed) * 0.18;
          } else if (hitFlinch > 0.01) {
            b.Pelvis.rotation.z = r.Pelvis.z + 0.14 * hitFlinch;
            b.Pelvis.rotation.y = r.Pelvis.y + this.punchHitDir * 0.18 * hitFlinch;
          } else if (ko || knocked) {
            b.Pelvis.rotation.z = r.Pelvis.z + (knocked ? Math.sin(this.time * 16) * 0.08 : 0);
          } else if (run > 0.05 && !airborne) {
            b.Pelvis.rotation.y = r.Pelvis.y + sw * 0.06; // smooth hip swivel
            b.Pelvis.rotation.z = r.Pelvis.z + cw * 0.025; // subtle weight transfer
          } else {
            b.Pelvis.rotation.y = r.Pelvis.y;
            b.Pelvis.rotation.z = r.Pelvis.z;
          }
        }

        // --- 2. SPINE & TORSO (COUNTER-ROTATION & FORWARD LEAN) ---
        // On this rig, rotation around Z controls forward lean (-) / back arch (+)
        if (b.Spine01 && r.Spine01) {
          if (isHeld) {
            const struggleSpeed = 24;
            b.Spine01.rotation.z = r.Spine01.z + 0.30 + Math.sin(this.time * struggleSpeed) * 0.28;
            b.Spine01.rotation.y = r.Spine01.y + Math.cos(this.time * struggleSpeed) * 0.32;
          } else if (hitFlinch > 0.01) {
            // Chest / torso thrown backwards by punch force + lateral recoil twist
            b.Spine01.rotation.z = r.Spine01.z + 0.44 * hitFlinch;
            b.Spine01.rotation.y = r.Spine01.y + this.punchHitDir * 0.24 * hitFlinch;
          } else if (ko || knocked) {
            b.Spine01.rotation.z = r.Spine01.z + 0.20;
            b.Spine01.rotation.y = r.Spine01.y;
          } else if (holding) {
            // Arch back under heavy bomb weight
            b.Spine01.rotation.z = r.Spine01.z + 0.14;
            b.Spine01.rotation.y = r.Spine01.y;
          } else if (throwing) {
            // Windup into explosive crunch
            const t = 1 - p.throwT / 0.35;
            const crunch = t < 0.35 ? lerp(0, 0.15, t / 0.35) : lerp(0.15, -0.22, (t - 0.35) / 0.65);
            b.Spine01.rotation.z = r.Spine01.z + crunch;
            b.Spine01.rotation.y = r.Spine01.y;
          } else if (punching) {
            // Superman dive: torso angles aggressively forward in flight
            const punchSwing = p.punchArm ? 0.20 : -0.20;
            b.Spine01.rotation.y = r.Spine01.y + punchSwing * supermanProg;
            b.Spine01.rotation.z = r.Spine01.z - 0.42 * supermanProg;
          } else if (airborne) {
            b.Spine01.rotation.z = r.Spine01.z - 0.10;
            b.Spine01.rotation.y = r.Spine01.y;
          } else if (run > 0.05) {
            // Lean forward into the sprint + counter-twist shoulders against hips
            b.Spine01.rotation.z = r.Spine01.z - 0.10 * run;
            b.Spine01.rotation.y = r.Spine01.y - sw * 0.04;
          } else {
            // Idle breathing chest expansion
            b.Spine01.rotation.z = r.Spine01.z - breathe * 0.025;
            b.Spine01.rotation.y = r.Spine01.y;
          }
        }

        // --- 3. LEGS, KNEES & FEET (BIOMECHANICS) ---
        // On this rig, rotation around Z controls forward (-) and backward (+) swing
        if (ko || knocked) {
          if (b.L_Thigh && r.L_Thigh) b.L_Thigh.rotation.z = r.L_Thigh.z + 0.2;
          if (b.R_Thigh && r.R_Thigh) b.R_Thigh.rotation.z = r.R_Thigh.z + 0.2;
          if (b.L_Calf && r.L_Calf) b.L_Calf.rotation.z = r.L_Calf.z + 0.3;
          if (b.R_Calf && r.R_Calf) b.R_Calf.rotation.z = r.R_Calf.z + 0.3;
          if (b.L_Foot && r.L_Foot) b.L_Foot.rotation.z = r.L_Foot.z;
          if (b.R_Foot && r.R_Foot) b.R_Foot.rotation.z = r.R_Foot.z;
        } else if (isHeld) {
          // Rapid bicycle kicking and thrashing in mid-air
          const struggleSpeed = 24;
          const kickL = Math.sin(this.time * struggleSpeed * 1.05);
          const kickR = -kickL;

          if (b.L_Thigh && r.L_Thigh) {
            b.L_Thigh.rotation.z = r.L_Thigh.z + kickL * 0.75;
            b.L_Thigh.rotation.x = r.L_Thigh.x + Math.sin(this.time * struggleSpeed * 0.5) * 0.25;
          }
          if (b.R_Thigh && r.R_Thigh) {
            b.R_Thigh.rotation.z = r.R_Thigh.z + kickR * 0.75;
            b.R_Thigh.rotation.x = r.R_Thigh.x - Math.sin(this.time * struggleSpeed * 0.5) * 0.25;
          }

          if (b.L_Calf && r.L_Calf) b.L_Calf.rotation.z = r.L_Calf.z + 0.65 + Math.max(0, kickL) * 0.70;
          if (b.R_Calf && r.R_Calf) b.R_Calf.rotation.z = r.R_Calf.z + 0.65 + Math.max(0, kickR) * 0.70;

          if (b.L_Foot && r.L_Foot) b.L_Foot.rotation.z = r.L_Foot.z - kickL * 0.40;
          if (b.R_Foot && r.R_Foot) b.R_Foot.rotation.z = r.R_Foot.z - kickR * 0.40;
        } else if (hitFlinch > 0.01) {
          // Staggered knees buckling on impact
          if (b.L_Thigh && r.L_Thigh) b.L_Thigh.rotation.z = r.L_Thigh.z + 0.20 * hitFlinch;
          if (b.R_Thigh && r.R_Thigh) b.R_Thigh.rotation.z = r.R_Thigh.z + 0.20 * hitFlinch;
          if (b.L_Calf && r.L_Calf) b.L_Calf.rotation.z = r.L_Calf.z + 0.35 * hitFlinch;
          if (b.R_Calf && r.R_Calf) b.R_Calf.rotation.z = r.R_Calf.z + 0.35 * hitFlinch;
          if (b.L_Foot && r.L_Foot) b.L_Foot.rotation.z = r.L_Foot.z - 0.15 * hitFlinch;
          if (b.R_Foot && r.R_Foot) b.R_Foot.rotation.z = r.R_Foot.z - 0.15 * hitFlinch;
        } else if (punching) {
          // Superman flying kick legs: punch-side leg kicks back in mid-air, lead leg tucks up
          const isLeft = !!p.punchArm;
          if (isLeft) {
            // Left punch: Left leg trails straight back into the flight stream
            if (b.L_Thigh && r.L_Thigh) b.L_Thigh.rotation.z = r.L_Thigh.z + 0.70 * supermanLegProg;
            if (b.L_Calf && r.L_Calf) b.L_Calf.rotation.z = r.L_Calf.z - 0.20 * supermanLegProg;
            if (b.L_Foot && r.L_Foot) b.L_Foot.rotation.z = r.L_Foot.z - 0.25 * supermanLegProg;
            // Right leg tucks forward under the body
            if (b.R_Thigh && r.R_Thigh) b.R_Thigh.rotation.z = r.R_Thigh.z - 0.55 * supermanLegProg;
            if (b.R_Calf && r.R_Calf) b.R_Calf.rotation.z = r.R_Calf.z + 0.90 * supermanLegProg;
            if (b.R_Foot && r.R_Foot) b.R_Foot.rotation.z = r.R_Foot.z - 0.20 * supermanLegProg;
          } else {
            // Right punch: Right leg trails straight back into the flight stream
            if (b.R_Thigh && r.R_Thigh) b.R_Thigh.rotation.z = r.R_Thigh.z + 0.70 * supermanLegProg;
            if (b.R_Calf && r.R_Calf) b.R_Calf.rotation.z = r.R_Calf.z - 0.20 * supermanLegProg;
            if (b.R_Foot && r.R_Foot) b.R_Foot.rotation.z = r.R_Foot.z - 0.25 * supermanLegProg;
            // Left leg tucks forward under the body
            if (b.L_Thigh && r.L_Thigh) b.L_Thigh.rotation.z = r.L_Thigh.z - 0.55 * supermanLegProg;
            if (b.L_Calf && r.L_Calf) b.L_Calf.rotation.z = r.L_Calf.z + 0.90 * supermanLegProg;
            if (b.L_Foot && r.L_Foot) b.L_Foot.rotation.z = r.L_Foot.z - 0.20 * supermanLegProg;
          }
        } else if (airborne) {
          // Legs tuck up in the air
          if (b.L_Thigh && r.L_Thigh) b.L_Thigh.rotation.z = r.L_Thigh.z - 0.35;
          if (b.R_Thigh && r.R_Thigh) b.R_Thigh.rotation.z = r.R_Thigh.z - 0.20;
          if (b.L_Calf && r.L_Calf) b.L_Calf.rotation.z = r.L_Calf.z + 0.65;
          if (b.R_Calf && r.R_Calf) b.R_Calf.rotation.z = r.R_Calf.z + 0.50;
          if (b.L_Foot && r.L_Foot) b.L_Foot.rotation.z = r.L_Foot.z - 0.25;
          if (b.R_Foot && r.R_Foot) b.R_Foot.rotation.z = r.R_Foot.z - 0.25;
        } else if (run > 0.05) {
          // Full stride cycle: Thigh swings forward/back, Knee flexes on forward recovery, Foot pushes off
          const legAmp = 0.65 * run;
          const lsw = Math.sin(this.phase) * legAmp;
          const rsw = -lsw;

          // Thighs: negative Z swings forward (+X), positive Z swings backward (-X)
          if (b.L_Thigh && r.L_Thigh) b.L_Thigh.rotation.z = r.L_Thigh.z - lsw;
          if (b.R_Thigh && r.R_Thigh) b.R_Thigh.rotation.z = r.R_Thigh.z + lsw;

          // Knees (Calves): positive Z flexes knee backward to clear ground on forward swing
          if (b.L_Calf && r.L_Calf) b.L_Calf.rotation.z = r.L_Calf.z + Math.max(0, lsw * 1.05) + 0.08 * run;
          if (b.R_Calf && r.R_Calf) b.R_Calf.rotation.z = r.R_Calf.z + Math.max(0, -lsw * 1.05) + 0.08 * run;

          // Feet / Ankles: roll through the stride
          if (b.L_Foot && r.L_Foot) b.L_Foot.rotation.z = r.L_Foot.z - lsw * 0.35;
          if (b.R_Foot && r.R_Foot) b.R_Foot.rotation.z = r.R_Foot.z + lsw * 0.35;
        } else {
          // Idle settled stance
          if (b.L_Thigh && r.L_Thigh) b.L_Thigh.rotation.z = r.L_Thigh.z;
          if (b.R_Thigh && r.R_Thigh) b.R_Thigh.rotation.z = r.R_Thigh.z;
          if (b.L_Calf && r.L_Calf) b.L_Calf.rotation.z = r.L_Calf.z;
          if (b.R_Calf && r.R_Calf) b.R_Calf.rotation.z = r.R_Calf.z;
          if (b.L_Foot && r.L_Foot) b.L_Foot.rotation.z = r.L_Foot.z;
          if (b.R_Foot && r.R_Foot) b.R_Foot.rotation.z = r.R_Foot.z;
        }

        // --- 4. ARMS, ELBOWS & HANDS (DYNAMIC MASCOT POSTURE) ---
        // Natural mascot stance: arms are angled down-forward (not glued to sides),
        // with elbows bent ~65° so cute paws are held in front of chest/belly.
        const armDrop = 0.45; // keep the bulkier model's shoulders open
        const armFwd = -0.28; // ~16° forward angle
        const elbowBend = -0.55; // avoid folding the forearms into the torso

        if (ko || knocked) {
          // Splayed limp ragdoll arms
          if (b.L_Upperarm && r.L_Upperarm) {
            b.L_Upperarm.rotation.x = r.L_Upperarm.x - 0.35;
            b.L_Upperarm.rotation.y = r.L_Upperarm.y;
            b.L_Upperarm.rotation.z = r.L_Upperarm.z;
          }
          if (b.R_Upperarm && r.R_Upperarm) {
            b.R_Upperarm.rotation.x = r.R_Upperarm.x + 0.35;
            b.R_Upperarm.rotation.y = r.R_Upperarm.y;
            b.R_Upperarm.rotation.z = r.R_Upperarm.z;
          }
          if (b.L_Forearm && r.L_Forearm) b.L_Forearm.rotation.z = r.L_Forearm.z - 0.20;
          if (b.R_Forearm && r.R_Forearm) b.R_Forearm.rotation.z = r.R_Forearm.z - 0.20;
        } else if (isHeld) {
          // Frantic asynchronous paddling and clawing in the air
          const struggleSpeed = 24;
          const flailPhase = this.time * struggleSpeed * 1.15;
          const flailL = Math.sin(flailPhase);
          const flailR = Math.sin(flailPhase + Math.PI);

          if (b.L_Upperarm && r.L_Upperarm) {
            b.L_Upperarm.rotation.x = r.L_Upperarm.x - 0.45 + flailL * 0.45;
            b.L_Upperarm.rotation.y = r.L_Upperarm.y + Math.cos(flailPhase) * 0.25;
            b.L_Upperarm.rotation.z = r.L_Upperarm.z - 0.65 + flailL * 0.55;
          }
          if (b.R_Upperarm && r.R_Upperarm) {
            b.R_Upperarm.rotation.x = r.R_Upperarm.x + 0.45 - flailR * 0.45;
            b.R_Upperarm.rotation.y = r.R_Upperarm.y - Math.cos(flailPhase) * 0.25;
            b.R_Upperarm.rotation.z = r.R_Upperarm.z - 0.65 + flailR * 0.55;
          }

          if (b.L_Forearm && r.L_Forearm) {
            b.L_Forearm.rotation.z = r.L_Forearm.z - 0.85 + Math.cos(flailPhase) * 0.65;
          }
          if (b.R_Forearm && r.R_Forearm) {
            b.R_Forearm.rotation.z = r.R_Forearm.z - 0.85 - Math.cos(flailPhase) * 0.65;
          }

          if (b.L_Hand && r.L_Hand) b.L_Hand.rotation.x = r.L_Hand.x + Math.sin(flailPhase * 1.3) * 0.45;
          if (b.R_Hand && r.R_Hand) b.R_Hand.rotation.x = r.R_Hand.x - Math.sin(flailPhase * 1.3) * 0.45;
        } else if (hitFlinch > 0.01) {
          // Arms jerk back & splay outward in shock
          if (b.L_Upperarm && r.L_Upperarm) {
            b.L_Upperarm.rotation.x = r.L_Upperarm.x - 0.65 * hitFlinch;
            b.L_Upperarm.rotation.y = r.L_Upperarm.y;
            b.L_Upperarm.rotation.z = r.L_Upperarm.z + 0.45 * hitFlinch;
          }
          if (b.R_Upperarm && r.R_Upperarm) {
            b.R_Upperarm.rotation.x = r.R_Upperarm.x + 0.65 * hitFlinch;
            b.R_Upperarm.rotation.y = r.R_Upperarm.y;
            b.R_Upperarm.rotation.z = r.R_Upperarm.z + 0.45 * hitFlinch;
          }
          if (b.L_Forearm && r.L_Forearm) {
            b.L_Forearm.rotation.z = r.L_Forearm.z - 0.42 * hitFlinch;
          }
          if (b.R_Forearm && r.R_Forearm) {
            b.R_Forearm.rotation.z = r.R_Forearm.z - 0.42 * hitFlinch;
          }
        } else if (holding) {
          // Hoist high overhead with bent elbows holding object
          if (b.L_Upperarm && r.L_Upperarm) {
            b.L_Upperarm.rotation.x = r.L_Upperarm.x + 1.55;
            b.L_Upperarm.rotation.y = r.L_Upperarm.y;
            b.L_Upperarm.rotation.z = r.L_Upperarm.z;
          }
          if (b.R_Upperarm && r.R_Upperarm) {
            b.R_Upperarm.rotation.x = r.R_Upperarm.x - 1.55;
            b.R_Upperarm.rotation.y = r.R_Upperarm.y;
            b.R_Upperarm.rotation.z = r.R_Upperarm.z;
          }
          if (b.L_Forearm && r.L_Forearm) b.L_Forearm.rotation.z = r.L_Forearm.z - 0.55;
          if (b.R_Forearm && r.R_Forearm) b.R_Forearm.rotation.z = r.R_Forearm.z - 0.55;
        } else if (throwing) {
          // Big hurl windup -> release
          const t = 1 - p.throwT / 0.35;
          const throwSwing = t < 0.4 ? lerp(-armDrop, 1.2, t / 0.4) : lerp(1.2, -armDrop - 0.2, (t - 0.4) / 0.6);
          if (b.R_Upperarm && r.R_Upperarm) {
            b.R_Upperarm.rotation.x = r.R_Upperarm.x - throwSwing;
            b.R_Upperarm.rotation.y = r.R_Upperarm.y;
            b.R_Upperarm.rotation.z = r.R_Upperarm.z - (t < 0.4 ? -0.3 : 0.8);
          }
          if (b.L_Upperarm && r.L_Upperarm) {
            b.L_Upperarm.rotation.x = r.L_Upperarm.x + throwSwing * 0.4;
            b.L_Upperarm.rotation.y = r.L_Upperarm.y;
            b.L_Upperarm.rotation.z = r.L_Upperarm.z;
          }
          if (b.R_Forearm && r.R_Forearm) b.R_Forearm.rotation.z = r.R_Forearm.z - (t < 0.4 ? 1.4 : 0.3);
          if (b.L_Forearm && r.L_Forearm) b.L_Forearm.rotation.z = r.L_Forearm.z - 0.8;
        } else if (punching) {
          // Superman Flying Punch:
          // Active arm rockets straight forward locked into an iron fist; trailing arm sweeps back for aerodynamic balance
          const isLeft = !!p.punchArm;

          const actArm = isLeft ? b.L_Upperarm : b.R_Upperarm;
          const actRest = isLeft ? r.L_Upperarm : r.R_Upperarm;
          const actFore = isLeft ? b.L_Forearm : b.R_Forearm;
          const actForeRest = isLeft ? r.L_Forearm : r.R_Forearm;

          const grdArm = isLeft ? b.R_Upperarm : b.L_Upperarm;
          const grdRest = isLeft ? r.R_Upperarm : r.L_Upperarm;
          const grdFore = isLeft ? b.R_Forearm : b.L_Forearm;
          const grdForeRest = isLeft ? r.R_Forearm : r.L_Forearm;

          // Superman Active Fist: shoots directly forward in line with body flight
          if (actArm && actRest) {
            actArm.rotation.x = lerp(actRest.x + (isLeft ? -armDrop : armDrop), actRest.x + (isLeft ? -0.06 : 0.06), supermanProg);
            actArm.rotation.y = actRest.y + (isLeft ? 0.08 : -0.08) * supermanProg;
            actArm.rotation.z = actRest.z + lerp(armFwd, -1.65, supermanProg);
          }
          if (actFore && actForeRest) {
            // Forearm locks straight forward with upper arm into the flight vector
            actFore.rotation.z = actForeRest.z + lerp(elbowBend, -0.05, supermanProg);
          }

          // Trailing arm sweeps back along torso for aerodynamic Superman balance
          if (grdArm && grdRest) {
            grdArm.rotation.x = grdRest.x + (isLeft ? armDrop * 0.7 : -armDrop * 0.7);
            grdArm.rotation.y = grdRest.y;
            grdArm.rotation.z = grdRest.z + lerp(armFwd, 0.45, supermanProg);
          }
          if (grdFore && grdForeRest) {
            grdFore.rotation.z = grdForeRest.z + lerp(-1.45, -0.70, supermanProg);
          }
          if (b.L_Hand && r.L_Hand) b.L_Hand.rotation.x = r.L_Hand.x;
          if (b.R_Hand && r.R_Hand) b.R_Hand.rotation.x = r.R_Hand.x;
        } else if (airborne) {
          // Arms raised in balance and excitement
          if (b.L_Upperarm && r.L_Upperarm) {
            b.L_Upperarm.rotation.x = r.L_Upperarm.x - 0.48;
            b.L_Upperarm.rotation.y = r.L_Upperarm.y;
            b.L_Upperarm.rotation.z = r.L_Upperarm.z - 0.50;
          }
          if (b.R_Upperarm && r.R_Upperarm) {
            b.R_Upperarm.rotation.x = r.R_Upperarm.x + 0.48;
            b.R_Upperarm.rotation.y = r.R_Upperarm.y;
            b.R_Upperarm.rotation.z = r.R_Upperarm.z - 0.50;
          }
          if (b.L_Forearm && r.L_Forearm) b.L_Forearm.rotation.z = r.L_Forearm.z - 0.85;
          if (b.R_Forearm && r.R_Forearm) b.R_Forearm.rotation.z = r.R_Forearm.z - 0.85;
        } else if (run > 0.05) {
          // Dynamic running arm swing:
          // Arms pump forward and backward vigorously!
          const armSw = Math.sin(this.phase) * 0.65 * run;
          const dynamicDrop = armDrop - 0.08 * run;

          if (b.L_Upperarm && r.L_Upperarm) {
            b.L_Upperarm.rotation.x = r.L_Upperarm.x - dynamicDrop;
            b.L_Upperarm.rotation.y = r.L_Upperarm.y;
            b.L_Upperarm.rotation.z = r.L_Upperarm.z + armFwd - armSw;
          }
          if (b.R_Upperarm && r.R_Upperarm) {
            b.R_Upperarm.rotation.x = r.R_Upperarm.x + dynamicDrop;
            b.R_Upperarm.rotation.y = r.R_Upperarm.y;
            b.R_Upperarm.rotation.z = r.R_Upperarm.z + armFwd + armSw;
          }

          // Elbows flex on forward pump, relax slightly on backswing
          if (b.L_Forearm && r.L_Forearm) {
            b.L_Forearm.rotation.z = r.L_Forearm.z + elbowBend - armSw * 0.40;
          }
          if (b.R_Forearm && r.R_Forearm) {
            b.R_Forearm.rotation.z = r.R_Forearm.z + elbowBend + armSw * 0.40;
          }
        } else {
          // Idle mascot posture: cute paws held in front of chest with breathing sway
          if (b.L_Upperarm && r.L_Upperarm) {
            b.L_Upperarm.rotation.x = r.L_Upperarm.x - armDrop;
            b.L_Upperarm.rotation.y = r.L_Upperarm.y;
            b.L_Upperarm.rotation.z = r.L_Upperarm.z + armFwd + breathe * 0.035;
          }
          if (b.R_Upperarm && r.R_Upperarm) {
            b.R_Upperarm.rotation.x = r.R_Upperarm.x + armDrop;
            b.R_Upperarm.rotation.y = r.R_Upperarm.y;
            b.R_Upperarm.rotation.z = r.R_Upperarm.z + armFwd + breathe * 0.035;
          }
          if (b.L_Forearm && r.L_Forearm) {
            b.L_Forearm.rotation.z = r.L_Forearm.z + elbowBend + breathe * 0.035;
          }
          if (b.R_Forearm && r.R_Forearm) {
            b.R_Forearm.rotation.z = r.R_Forearm.z + elbowBend + breathe * 0.035;
          }
          if (b.L_Hand && r.L_Hand) b.L_Hand.rotation.x = r.L_Hand.x;
          if (b.R_Hand && r.R_Hand) b.R_Hand.rotation.x = r.R_Hand.x;
        }

        // --- 5. HEAD & SNOUT DYNAMICS ---
        if (b.Head && r.Head) {
          if (isHeld) {
            // Head thrashing back and forth, crying out in panic
            const struggleSpeed = 24;
            b.Head.rotation.x = r.Head.x + Math.sin(this.time * struggleSpeed * 0.7) * 0.35;
            b.Head.rotation.z = r.Head.z + Math.cos(this.time * struggleSpeed * 0.9) * 0.35;
            b.Head.rotation.y = (r.Head.y || 0) + Math.sin(this.time * struggleSpeed * 0.8) * 0.30;
          } else if (hitFlinch > 0.01) {
            // Punch hit reaction: chin & snout snap violently back and tilt sideways with a dazed shake
            b.Head.rotation.x = r.Head.x - 0.72 * hitFlinch; // Snap snout and head back/up!
            b.Head.rotation.z = r.Head.z + this.punchHitDir * (0.42 * hitFlinch + 0.18 * hitWobble);
            b.Head.rotation.y = (r.Head.y || 0) - this.punchHitDir * (0.32 * hitFlinch);
          } else if (ko || knocked) {
            b.Head.rotation.x = r.Head.x - 0.35;
            b.Head.rotation.z = r.Head.z;
          } else if (punching) {
            // Gaze stabilization during Superman dive: tilt head up to maintain forward gaze
            b.Head.rotation.x = r.Head.x + 0.38 * supermanProg;
            b.Head.rotation.z = r.Head.z;
          } else if (run > 0.05) {
            // Forward gaze stabilization + subtle smooth bob
            b.Head.rotation.x = r.Head.x + Math.sin(this.phase * 2) * 0.018 * run;
            b.Head.rotation.z = r.Head.z + Math.sin(this.phase) * 0.015 * run;
          } else {
            // Idle ambient sniffing / head tilt
            b.Head.rotation.x = r.Head.x + Math.sin(this.time * 1.5) * 0.03;
            b.Head.rotation.z = r.Head.z + Math.sin(this.time * 0.9) * 0.035;
          }
        }
      }
    }
    // Knockout dizzy stars orbiting above head
    const isDizzy = (ko || knocked) && !isHeld;
    const targetDizzyScale = isDizzy ? 1 : 0;
    this.dizzyScale += (targetDizzyScale - this.dizzyScale) * Math.min(1, 14 * dt);
    this.dizzyGroup.visible = this.dizzyScale > 0.02;

    if (this.dizzyGroup.visible) {
      if (this.capBones?.Head) {
        this.capBones.Head.getWorldPosition(_tempVec);
        this.group.worldToLocal(_tempVec);
        this.dizzyGroup.position.set(_tempVec.x, _tempVec.y + 0.38, _tempVec.z);
      } else {
        const headY = lerp(1.75, 0.42, this.lie);
        const headZ = lerp(0, -1.15, this.lie);
        this.dizzyGroup.position.set(0, headY + 0.35, headZ);
      }

      const orbitR = 0.40;
      const spinSpeed = 5.5;
      for (let i = 0; i < this.dizzyStars.length; i++) {
        const star = this.dizzyStars[i];
        const baseAngle = (i / this.dizzyStars.length) * Math.PI * 2;
        const a = this.time * spinSpeed + baseAngle;
        const wave = Math.sin(this.time * 7 + i * 1.5) * 0.05;

        // Orbit in a tilted ellipse above head
        star.position.set(
          Math.cos(a) * orbitR,
          wave,
          Math.sin(a) * orbitR * 0.72
        );

        // Spin on its own axes
        star.rotation.z = this.time * 6 + i;
        star.rotation.y = a + Math.PI / 2;
        star.rotation.x = 0.35;

        const s = this.dizzyScale * (1 + Math.sin(this.time * 9 + i * 2) * 0.12);
        star.scale.set(s, s, s);
      }
    }

    // blink (eyes stay shut while knocked out or taking a hard punch)
    this.blinkT -= dt;
    this.blinkAt -= dt;
    if (this.blinkAt <= 0) {
      this.blinkAt = 1.8 + Math.random() * 3;
      this.blinkT = 0.12;
    }
    const eyeY = knocked || this.blinkT > 0 || hitFlinch > 0.18 ? 0.15 : 1;
    for (const e of this.eyes) e.scale.y = eyeY;

    // hat flourishes (halo floats)
    if (this.hat) {
      for (const c of this.hat.children) {
        if (c.userData.float) c.position.y = 0.34 + Math.sin(this.time * 3) * 0.04;
      }
    }

    // --- powerup add-ons ---
    // boxing gloves: fists swell and go red; strobe for the last 2s
    const glovesT = p.glovesT ?? 0;
    const gloved = glovesT > 0 && !(glovesT < 2 && Math.floor(this.time * 8) % 2);
    if (this.capGloveL) this.capGloveL.visible = gloved && !!this.capivara?.visible;
    if (this.capGloveR) this.capGloveR.visible = gloved && !!this.capivara?.visible;
    for (const h of this.hands) {
      h.material = gloved ? this.gloveMat : this.skinMat;
      const hs = gloved ? 1.7 : 1;
      h.scale.set(hs, hs, hs);
    }
    // shield bubble: opacity tracks remaining shield hp, with a slow shimmer
    const shieldHp = p.shieldHp ?? 0;
    this.shield.visible = shieldHp > 0;
    if (this.shield.visible) {
      this.shieldMat.opacity = 0.14 + 0.3 * Math.min(1, shieldHp / 65) + Math.sin(this.time * 5) * 0.04;
      this.shield.rotation.y += dt * 0.7;
    }
    // frozen: encased in ice (and rigid — the sim zeroes control anyway)
    this.ice.visible = (p.frozenT ?? 0) > 0;
    // cursed: dark pulse, frantic near zero
    const curseT = p.curseT ?? 0;
    this.curse.visible = curseT > 0;
    if (this.curse.visible) {
      const s = 1 + 0.12 * Math.sin(this.time * (4 + (5 - curseT) * 5));
      this.curse.scale.set(s, s, s);
    }

    // Deep void cull + spawn-protection flicker
    const isFallenDeep = p.y < -12 || (ko && p.y < -8);
    if (isFallenDeep) {
      g.visible = false;
    } else {
      g.visible = p.invuln > 0.05 ? Math.floor(this.time * 12) % 2 === 0 : true;
    }
  }

  dispose() {
    if (typeof window !== 'undefined') {
      window.characterViews?.delete(this);
    }
    this.name.material.map?.dispose();
    this.name.material.dispose();
    this.shieldMat.dispose();
    this.iceMat.dispose();
    this.curseMat.dispose();
    this.scene.remove(this.group);
  }
}
