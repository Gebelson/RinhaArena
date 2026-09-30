// Transient visual effects: explosions (flash, fireball, shockwave ring,
// sparks, smoke, scorch decal), score confetti, spawn poofs, flag sparkle
// trail, and camera shake. Every effect is a tiny object with
// update(dt) -> alive?, pooled in one list.

import * as THREE from 'three';

let blobTex = null;
function getBlobTex() {
  if (!blobTex) {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d');
    const grad = g.createRadialGradient(32, 32, 4, 32, 32, 30);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 64);
    blobTex = new THREE.CanvasTexture(c);
  }
  return blobTex;
}

function burstPoints(scene, { x, y, z, count, color, size, speed, lift, life, gravity }) {
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array(count * 3);
  const vel = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    pos[i * 3] = x; pos[i * 3 + 1] = y; pos[i * 3 + 2] = z;
    const a = Math.random() * Math.PI * 2;
    const up = Math.random();
    const s = speed * (0.4 + Math.random() * 0.6);
    vel[i * 3] = Math.cos(a) * s * (1 - up * 0.6);
    vel[i * 3 + 1] = lift * (0.3 + up);
    vel[i * 3 + 2] = Math.sin(a) * s * (1 - up * 0.6);
  }
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const mat = new THREE.PointsMaterial({
    color, size, map: getBlobTex(), transparent: true, depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const points = new THREE.Points(geo, mat);
  scene.add(points);
  let t = 0;
  return {
    update(dt) {
      t += dt;
      const p = geo.attributes.position.array;
      for (let i = 0; i < count; i++) {
        vel[i * 3 + 1] -= gravity * dt;
        p[i * 3] += vel[i * 3] * dt;
        p[i * 3 + 1] += vel[i * 3 + 1] * dt;
        p[i * 3 + 2] += vel[i * 3 + 2] * dt;
        if (p[i * 3 + 1] < 0.05) p[i * 3 + 1] = 0.05;
      }
      geo.attributes.position.needsUpdate = true;
      mat.opacity = Math.max(0, 1 - t / life);
      if (t >= life) {
        scene.remove(points);
        geo.dispose();
        mat.dispose();
        return false;
      }
      return true;
    },
  };
}

function scaleFade(scene, mesh, { from, to, life, delay = 0 }) {
  mesh.scale.setScalar(from);
  scene.add(mesh);
  let t = -delay;
  return {
    update(dt) {
      t += dt;
      if (t < 0) return true;
      const k = Math.min(t / life, 1);
      mesh.scale.setScalar(from + (to - from) * Math.pow(k, 0.6));
      mesh.material.opacity = (1 - k) * (mesh.userData.op ?? 1);
      if (k >= 1) {
        scene.remove(mesh);
        mesh.geometry.dispose();
        mesh.material.dispose();
        return false;
      }
      return true;
    },
  };
}

export class Effects {
  constructor(scene) {
    this.scene = scene;
    this.list = [];
    this.scorches = [];
    this.shakeAmp = 0;
  }

  addShake(amp) {
    this.shakeAmp = Math.min(0.9, this.shakeAmp + amp);
  }

  explosion(x, y, z) {
    const s = this.scene;
    const yy = Math.max(y, 0.3);

    const light = new THREE.PointLight('#ffb36b', 42, 16, 2);
    light.position.set(x, yy + 0.8, z);
    s.add(light);
    let lt = 0;
    this.list.push({
      update: (dt) => {
        lt += dt;
        light.intensity = 42 * Math.max(0, 1 - lt / 0.18);
        if (lt >= 0.18) { s.remove(light); return false; }
        return true;
      },
    });

    const core = new THREE.Mesh(
      new THREE.SphereGeometry(0.5, 16, 12),
      new THREE.MeshBasicMaterial({ color: '#fff3c4', transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }),
    );
    core.position.set(x, yy, z);
    this.list.push(scaleFade(s, core, { from: 0.4, to: 3.4, life: 0.22 }));

    const fire = new THREE.Mesh(
      new THREE.SphereGeometry(0.5, 16, 12),
      new THREE.MeshBasicMaterial({ color: '#ff8a3c', transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }),
    );
    fire.position.set(x, yy, z);
    fire.userData.op = 0.85;
    this.list.push(scaleFade(s, fire, { from: 0.6, to: 4.6, life: 0.32, delay: 0.03 }));

    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.7, 0.92, 40),
      new THREE.MeshBasicMaterial({ color: '#ffd9a0', transparent: true, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, depthWrite: false }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(x, 0.12, z);
    ring.userData.op = 0.9;
    this.list.push(scaleFade(s, ring, { from: 0.8, to: 6.5, life: 0.45 }));

    this.list.push(burstPoints(s, {
      x, y: yy, z, count: 46, color: '#ffcf7a', size: 0.22,
      speed: 9, lift: 8, life: 0.85, gravity: 16,
    }));

    // smoke puffs
    for (let i = 0; i < 6; i++) {
      const puff = new THREE.Sprite(new THREE.SpriteMaterial({
        map: getBlobTex(), color: '#5b6069', transparent: true, opacity: 0.55, depthWrite: false,
      }));
      const a = Math.random() * Math.PI * 2;
      puff.position.set(x + Math.cos(a) * 0.7, yy + Math.random() * 0.6, z + Math.sin(a) * 0.7);
      this.scene.add(puff);
      let t = 0;
      const drift = { x: Math.cos(a) * 0.7, z: Math.sin(a) * 0.7 };
      this.list.push({
        update: (dt) => {
          t += dt;
          const k = t / 1.0;
          puff.position.y += dt * 1.3;
          puff.position.x += drift.x * dt;
          puff.position.z += drift.z * dt;
          const sc = 1 + k * 2.2;
          puff.scale.set(sc, sc, 1);
          puff.material.opacity = 0.55 * Math.max(0, 1 - k);
          if (k >= 1) { this.scene.remove(puff); puff.material.dispose(); return false; }
          return true;
        },
      });
    }

    // scorch decal (fades out slowly; capped so the floor doesn't clutter)
    const scorch = new THREE.Mesh(
      new THREE.CircleGeometry(1.5 + Math.random() * 0.3, 22),
      new THREE.MeshBasicMaterial({ color: '#15161c', transparent: true, opacity: 0.34, depthWrite: false }),
    );
    scorch.rotation.x = -Math.PI / 2;
    scorch.rotation.z = Math.random() * 6;
    scorch.position.set(x, 0.011 + this.scorches.length * 0.0005, z);
    this.scene.add(scorch);
    this.scorches.push(scorch);
    if (this.scorches.length > 12) {
      const old = this.scorches.shift();
      this.scene.remove(old);
      old.geometry.dispose();
      old.material.dispose();
    }
    let st = 0;
    this.list.push({
      update: (dt) => {
        st += dt;
        scorch.material.opacity = 0.34 * Math.max(0, 1 - st / 16);
        if (st >= 16) {
          const i = this.scorches.indexOf(scorch);
          if (i >= 0) this.scorches.splice(i, 1);
          this.scene.remove(scorch);
          scorch.geometry.dispose();
          scorch.material.dispose();
          return false;
        }
        return true;
      },
    });
  }

  confetti(x, z, colorA, colorB = '#ffd460') {
    for (const color of [colorA, colorB]) {
      this.list.push(burstPoints(this.scene, {
        x, y: 0.5, z, count: 36, color, size: 0.2,
        speed: 4.5, lift: 10, life: 1.4, gravity: 11,
      }));
    }
  }

  poof(x, z, color = '#cfd8e6') {
    this.list.push(burstPoints(this.scene, {
      x, y: 0.6, z, count: 14, color, size: 0.16,
      speed: 2.6, lift: 2.4, life: 0.5, gravity: 3,
    }));
  }

  punchSparks(x, y, z) {
    this.list.push(burstPoints(this.scene, {
      x, y: y || 1.15, z, count: 18, color: '#ffe66d', size: 0.22,
      speed: 4.8, lift: 2.5, life: 0.35, gravity: 5,
    }));
    this.list.push(burstPoints(this.scene, {
      x, y: y || 1.15, z, count: 10, color: '#ff5436', size: 0.18,
      speed: 3.4, lift: 1.8, life: 0.28, gravity: 4,
    }));
  }

  sparkle(x, y, z) {
    this.list.push(burstPoints(this.scene, {
      x, y: y + 1.4, z, count: 3, color: '#ffe27a', size: 0.13,
      speed: 0.7, lift: 0.4, life: 0.45, gravity: -0.5,
    }));
  }

  update(dt) {
    this.shakeAmp = Math.max(0, this.shakeAmp - dt * 2.4);
    for (let i = this.list.length - 1; i >= 0; i--) {
      if (!this.list[i].update(dt)) this.list.splice(i, 1);
    }
  }
}
