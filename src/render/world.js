// World: keeps the visual scene in sync with a view-state (either the local
// sim's state or an interpolated network snapshot — same shape either way),
// and turns sim events into effects. The renderer never reaches into game
// logic; this is the only bridge.

import * as THREE from 'three';
import { buildLevel } from './level.js';
import { CharacterView } from './characters.js';
import { BombView } from './bombs.js';
import { PowerupView } from './powerups.js';
import { FlagView } from './flag.js';
import { Effects } from './effects.js';
import { TEAMS } from '../core/config.js';

export class World {
  constructor(scene, level, { touch }) {
    this.scene = scene;
    this.level = level;
    this.levelGroup = buildLevel(scene, level, { touch });
    this.effects = new Effects(scene);
    this.chars = new Map();
    this.bombViews = new Map();
    this.powerupViews = new Map();
    this.flagViews = {
      red: new FlagView(scene, level, 'red'),
      blue: new FlagView(scene, level, 'blue'),
    };
    this.time = 0;
    this.trailAcc = 0;

    // aim reticle for the local player
    this.reticle = new THREE.Group();
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.34, 0.46, 24),
      new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.65, depthWrite: false }),
    );
    ring.rotation.x = -Math.PI / 2;
    const dot = new THREE.Mesh(
      new THREE.CircleGeometry(0.08, 12),
      new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.65, depthWrite: false }),
    );
    dot.rotation.x = -Math.PI / 2;
    dot.position.y = 0.005;
    this.reticle.add(ring, dot);
    this.reticle.position.y = 0.05;
    this.reticle.visible = false;
    scene.add(this.reticle);
  }

  setAim(point, visible) {
    this.reticle.visible = visible;
    if (point) this.reticle.position.set(point.x, 0.05, point.z);
  }

  sync(view, dt, myId) {
    this.time += dt;

    const seen = new Set();
    for (const p of view.players) {
      if (!p?.participantId || !p?.displayName) {
        console.error('[SPAWN] rejected entity without participant identity', p);
        continue;
      }
      if (seen.has(p.participantId)) {
        console.error(`[SPAWN] duplicate participant entity ${p.participantId}`);
        continue;
      }
      if (p.id !== p.participantId) {
        console.error(`[SPAWN] entity id mismatch id=${p.id} participant=${p.participantId}`);
        continue;
      }
      seen.add(p.participantId);
      let cv = this.chars.get(p.participantId);
      if (!cv) {
        cv = new CharacterView(this.scene, p, p.id === myId);
        this.chars.set(p.participantId, cv);
      }
      cv.update(p, dt);
    }
    if (this.chars.size !== seen.size) console.error(`[SPAWN] entity invariant failed rendered=${this.chars.size} participants=${seen.size}`);
    for (const [id, cv] of this.chars) {
      if (!seen.has(id)) {
        cv.dispose();
        this.chars.delete(id);
      }
    }

    const seenB = new Set();
    for (const b of view.bombs) {
      seenB.add(b.id);
      let bv = this.bombViews.get(b.id);
      if (!bv) {
        bv = new BombView(this.scene, b);
        this.bombViews.set(b.id, bv);
      }
      bv.update(b, dt, this.time);
    }
    for (const [id, bv] of this.bombViews) {
      if (!seenB.has(id)) {
        bv.dispose();
        this.bombViews.delete(id);
      }
    }

    const seenU = new Set();
    for (const u of view.powerups ?? []) {
      seenU.add(u.id);
      let uv = this.powerupViews.get(u.id);
      if (!uv) {
        uv = new PowerupView(this.scene, u);
        this.powerupViews.set(u.id, uv);
      }
      uv.update(u, dt, this.time);
    }
    for (const [id, uv] of this.powerupViews) {
      if (!seenU.has(id)) {
        uv.dispose();
        this.powerupViews.delete(id);
      }
    }

    if (view.flags) {
      this.flagViews.red.setVisible(true);
      this.flagViews.blue.setVisible(true);
      this.trailAcc += dt;
      const spark = this.trailAcc > 0.09;
      if (spark) this.trailAcc = 0;
      for (const team of ['red', 'blue']) {
        const f = view.flags[team];
        this.flagViews[team].update(f, dt, this.time);
        if (spark && f && (f.st === 'carry' || (f.st === 'drop' && f.y > 0.3))) {
          this.effects.sparkle(f.x, f.y, f.z);
        }
      }
    } else {
      this.flagViews.red.setVisible(false);
      this.flagViews.blue.setVisible(false);
    }

    this.effects.update(dt);
  }

  // Turn sim events into visuals. myPos scales the camera shake by distance.
  handleEvents(events, myPos) {
    for (const ev of events) {
      switch (ev.t) {
        case 'explode': {
          this.effects.explosion(ev.x, ev.y, ev.z);
          if (myPos) {
            const d = Math.hypot(ev.x - myPos.x, ev.z - myPos.z);
            this.effects.addShake(Math.max(0, 0.55 - d * 0.02));
          }
          break;
        }
        case 'score': {
          const base = this.level.bases[ev.team];
          this.effects.confetti(base.x, base.z, TEAMS[ev.team].color);
          break;
        }
        case 'flagReturn': {
          const stand = this.level.flags[ev.team];
          if (stand) this.effects.poof(stand.x, stand.z, TEAMS[ev.team].glow);
          break;
        }
        case 'punchHit': {
          this.effects.punchSparks(ev.x, 1.15, ev.z);
          if (ev.instaKO) {
            this.effects.poof(ev.x, ev.z, '#ff473a');
            this.effects.confetti(ev.x, ev.z, '#ff3b30', '#ffcc00');
          }
          if (ev.target) {
            const victim = this.chars.get(ev.target);
            if (victim) victim.onPunched?.(ev);
          }
          if (myPos) {
            const d = Math.hypot(ev.x - myPos.x, ev.z - myPos.z);
            const intensity = ev.instaKO ? 0.75 : 0.35;
            this.effects.addShake(Math.max(0, intensity - d * 0.03));
          }
          break;
        }
        case 'spawn':
          this.effects.poof(ev.x, ev.z);
          break;
        case 'dash':
          this.effects.poof(ev.x, ev.z, '#ffffff');
          break;
        case 'ko':
          if (ev.cause !== 'fall') this.effects.poof(ev.x, ev.z, '#ff9d8a');
          break;
        case 'powerupSpawn':
          this.effects.poof(ev.x, ev.z, '#ffe9a8');
          break;
        case 'powerup':
          this.effects.poof(ev.x, ev.z, ev.kind === 'curse' ? '#a24dd6' : '#b8ffb0');
          break;
        case 'powerupBoom':
        case 'powerupExpire':
          this.effects.poof(ev.x, ev.z, '#d8cfa8');
          break;
        case 'shieldHit':
          this.effects.poof(ev.x, ev.z, '#9a86ff');
          break;
        case 'shieldDown':
          this.effects.poof(ev.x, ev.z, '#6f52e0');
          break;
        case 'freeze':
          this.effects.poof(ev.x, ev.z, '#aee4ff');
          break;
        case 'shatter': {
          this.effects.poof(ev.x, ev.z, '#dff4ff');
          if (myPos) {
            const d = Math.hypot(ev.x - myPos.x, ev.z - myPos.z);
            this.effects.addShake(Math.max(0, 0.25 - d * 0.02));
          }
          break;
        }
        case 'curse':
          this.effects.poof(ev.x, ev.z, '#5b2a6e');
          break;
      }
    }
  }

  get shake() {
    return this.effects.shakeAmp;
  }

  showEmote(participantId, emote) {
    this.chars.get(participantId)?.showEmote(emote);
  }

  dispose() {
    for (const view of this.chars.values()) view.dispose();
    for (const view of this.bombViews.values()) view.dispose();
    for (const view of this.powerupViews.values()) view.dispose();
    for (const view of Object.values(this.flagViews)) view.dispose?.();
    this.chars.clear();
    this.bombViews.clear();
    this.powerupViews.clear();
    this.scene.remove(this.reticle);
    this.scene.remove(this.levelGroup);
  }
}
