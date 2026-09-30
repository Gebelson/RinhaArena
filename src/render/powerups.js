// Powerup box visuals: BombSquad-style pickup crates. Each kind gets its
// own shell color plus a floating icon sprite, the whole box slowly spins
// and bobs, and it strobes for its final moments before expiring (the sim's
// `life` drives it, so what you see is exactly when it vanishes).

import * as THREE from 'three';
import { toonGradient } from './characters.js';
import { CONFIG } from '../core/config.js';

// per-kind styling: shell color + icon glyph (drawn to a canvas sprite)
const KINDS = {
  bomb: { color: '#e0a83c', icon: '💣' },
  triple: { color: '#e0a83c', icon: '💣' },
  ice: { color: '#7fd4f2', icon: '❄️' },
  gloves: { color: '#e04f3f', icon: '🥊' },
  impact: { color: '#e08a2e', icon: '💥' },
  mines: { color: '#97a24d', icon: '☢️' },
  sticky: { color: '#63c15c', icon: '🎯' },
  shield: { color: '#8f7ff2', icon: '🛡️' },
  health: { color: '#f2f2f4', icon: '➕' },
  curse: { color: '#7a30a0', icon: '💀' },
};

const iconTex = new Map();
function getIconTex(kind) {
  if (!iconTex.has(kind)) {
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const g = c.getContext('2d');
    g.font = '96px system-ui, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(KINDS[kind]?.icon ?? '❔', 64, 72);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    iconTex.set(kind, tex);
  }
  return iconTex.get(kind);
}

export class PowerupView {
  constructor(scene, u) {
    this.scene = scene;
    this.group = new THREE.Group();
    this.spin = Math.random() * Math.PI * 2;

    const style = KINDS[u.kind] ?? KINDS.triple;
    const r = CONFIG.physics.materials.box.radius;
    this.mat = new THREE.MeshToonMaterial({
      color: style.color,
      gradientMap: toonGradient(),
      emissive: style.color,
      emissiveIntensity: 0,
    });
    this.shell = new THREE.Mesh(new THREE.BoxGeometry(r * 1.6, r * 1.6, r * 1.6), this.mat);
    this.shell.castShadow = true;
    this.shell.position.y = -(r - r * 0.8); // physics sphere center -> box bottom on the floor

    this.icon = new THREE.Sprite(new THREE.SpriteMaterial({
      map: getIconTex(u.kind),
      transparent: true,
      depthWrite: false,
    }));
    this.icon.scale.set(0.62, 0.62, 1);
    this.icon.position.y = r + 0.55;

    this.group.add(this.shell, this.icon);
    scene.add(this.group);
  }

  update(u, dt, time) {
    this.spin += dt * 1.6;
    this.group.position.set(u.x, u.y, u.z);
    this.shell.rotation.y = this.spin;
    this.icon.position.y = CONFIG.physics.materials.box.radius + 0.55 + Math.sin(time * 2.4 + this.spin) * 0.05;
    // about to expire: strobe (powerupbox.py flashes for its last 1.5s)
    const flashing = u.life < CONFIG.powerups.boxLife - CONFIG.powerups.boxFlash;
    this.mat.emissiveIntensity = flashing ? (Math.sin(time * 22) > 0 ? 0.55 : 0) : 0;
  }

  dispose() {
    this.mat.dispose();
    this.icon.material.dispose();
    this.scene.remove(this.group);
  }
}
