// Cloud multiplayer transport. Supabase Realtime relays inputs and snapshots;
// the room creator runs the authoritative GameHost in their browser.
// Includes Client-Side Prediction (CSP) for zero input lag and smooth continuous
// time-based entity interpolation for buttery 60+ FPS visuals.

import { clamp, lerp, angleLerp, norm2 } from '../core/math.js';
import { CONFIG } from '../core/config.js';
import { GameHost } from '../game/host.js';
import { packState } from './protocol.js';
import { joinRoom, touchRoom } from './rooms.js';
import { SupabaseRealtimeChannel } from './supabase.js';
import { integrateBody, overFloor } from '../game/physics.js';
import { LEVELS, DEFAULT_LEVEL } from '../content/levels/index.js';

const TICK_RATE = CONFIG.tickRate || 60;
const SNAPSHOT_INTERVAL = 1 / 30; // 30 Hz broadcasts from host
const INPUT_INTERVAL_MS = 25; // 40 Hz periodic input updates for steady movement
const MIN_INPUT_SEND_INTERVAL_MS = 10; // minimum interval for immediate edge-trigger sends
const TARGET_BUFFER_TICKS = 3; // ~50ms buffer at 60 ticks/s for smooth time-based interpolation

function interpPlayers(aList, bList, t) {
  const byIdA = new Map(aList.map((p) => [p.id, p]));
  return bList.map((b) => {
    const a = byIdA.get(b.id);
    if (!a || a.state !== b.state) return { ...b };
    if (Math.hypot(b.x - a.x, b.z - a.z) > 4.0) return { ...b };
    return {
      ...b,
      x: lerp(a.x, b.x, t),
      z: lerp(a.z, b.z, t),
      y: lerp(a.y, b.y, t),
      spd: lerp(a.spd, b.spd, t),
      face: angleLerp(a.face, b.face, t),
    };
  });
}

function interpState(a, b, t) {
  const out = { ...b, players: interpPlayers(a.players, b.players, t) };
  const bombA = new Map(a.bombs.map((x) => [x.id, x]));
  out.bombs = b.bombs.map((next) => {
    const prev = bombA.get(next.id);
    if (!prev || Math.hypot(next.x - prev.x, next.z - prev.z) > 5.0) return { ...next };
    return {
      ...next,
      x: lerp(prev.x, next.x, t),
      z: lerp(prev.z, next.z, t),
      y: lerp(prev.y, next.y, t),
    };
  });
  if (a.powerups && b.powerups) {
    const previous = new Map(a.powerups.map((x) => [x.id, x]));
    out.powerups = b.powerups.map((next) => {
      const prev = previous.get(next.id);
      return prev ? { ...next, x: lerp(prev.x, next.x, t), z: lerp(prev.z, next.z, t), y: lerp(prev.y, next.y, t) } : { ...next };
    });
  }
  if (a.flags && b.flags) {
    out.flags = {};
    for (const team of Object.keys(b.flags)) {
      const prev = a.flags[team];
      const next = b.flags[team];
      out.flags[team] = prev && prev.st === next.st && Math.hypot(next.x - prev.x, next.z - prev.z) < 5.0
        ? { ...next, x: lerp(prev.x, next.x, t), z: lerp(prev.z, next.z, t), y: lerp(prev.y, next.y, t) }
        : { ...next };
    }
  }
  return out;
}

function roomOptions(room) {
  const roomRules = room.config?.rules || {};
  const roomPowerups = room.config?.powerups || {};
  return {
    levelId: room.levelId,
    modeId: room.modeId,
    teamLimits: room.teamLimits,
    respawnTime: room.respawnTime,
    friendlyFire: room.friendlyFire,
    config: {
      ...CONFIG,
      ...(room.config || {}),
      player: { ...CONFIG.player, respawnTime: room.respawnTime },
      powerups: { ...CONFIG.powerups, ...roomPowerups },
      rules: { ...CONFIG.rules, ...roomRules, friendlyFire: room.friendlyFire },
    },
  };
}

function maxPlayers(room) {
  return room.modeId === 'ffa' ? room.teamLimits.ffa : room.teamLimits.red + room.teamLimits.blue;
}

export async function connectOnline({ room, password, team, profile, host: requestedHost = false, hostToken = null, roomConfig = null, onDropped }) {
  const roomCode = String(room || 'main').trim().toLowerCase();
  const config = roomConfig ?? await joinRoom(roomCode, password);
  if (!config?.ok) throw new Error(config?.error || 'Sala não encontrada');

  const clientId = crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
  const channel = new SupabaseRealtimeChannel(`arena:${roomCode}`);
  await channel.connect();

  return new Promise((resolve, reject) => {
    let settled = false;
    let closed = false;
    let myId = null;
    let hostGame = null;
    let snapAccumulator = 0;
    let lastSent = 0;
    let welcomeTimer = null;
    let touchTimer = null;
    let renderTick = null;
    const snaps = [];
    const eventQ = [];
    const hostEventQ = [];
    const clientPlayers = new Map();

    const level = LEVELS[config.levelId] || LEVELS[DEFAULT_LEVEL];
    const playerCfg = config.config?.player || CONFIG.player;
    const worldCfg = config.config?.world || CONFIG.world;
    const matPlayer = CONFIG.physics.materials.player;

    const pred = {
      initialized: false,
      x: 0, y: 0, z: 0,
      vx: 0, vy: 0, vz: 0,
      face: 0,
      gearSpd: 0,
      spd: 0,
      jumpCd: 0,
      dashCd: 0,
      dashT: 0,
      punchT: 0,
      punchCd: 0,
    };

    let currentInput = { mx: 0, mz: 0, ax: 0, az: 0, run: 0, punch: false, jump: false, throw: false, dash: false, grab: false };
    const latchedInput = { jump: false, punch: false, throw: false, dash: false, grab: false };
    let prevSentInput = { mx: 0, mz: 0, run: 0, punch: false, jump: false, throw: false, dash: false, grab: false };

    const fail = (error) => {
      if (!settled) {
        settled = true;
        channel.close();
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    };
    const sendJoin = () => channel.send('join', { clientId, name: profile.name, cos: profile.cos, team });

    channel.on('disconnect', () => {
      if (settled && !closed) onDropped?.();
      else fail(new Error('Conexão multiplayer interrompida'));
    });
    channel.on('host-left', () => {
      if (!requestedHost && !closed) onDropped?.();
    });
    channel.on('welcome', (message) => {
      if (requestedHost || message?.target !== clientId || settled) return;
      myId = message.playerId;
      clearInterval(welcomeTimer);
      settled = true;
      resolve(transport);
    });
    channel.on('error', (message) => {
      if (message?.target === clientId) fail(new Error(message.reason || 'Não foi possível entrar na sala'));
    });
    channel.on('snap', (message) => {
      if (requestedHost || !message?.state) return;
      snaps.push(message.state);
      if (snaps.length > 40) snaps.shift();
      if (message.events?.length) eventQ.push(...message.events);

      if (renderTick === null) {
        renderTick = message.state.tick - TARGET_BUFFER_TICKS;
      }

      if (myId) {
        const authP = message.state.players?.find((p) => p.id === myId);
        if (authP) {
          if (!pred.initialized) {
            pred.x = authP.x;
            pred.y = authP.y;
            pred.z = authP.z;
            pred.vx = authP.vx;
            pred.vy = authP.vy ?? 0;
            pred.vz = authP.vz;
            pred.face = authP.face;
            pred.gearSpd = authP.spd;
            pred.spd = authP.spd;
            pred.initialized = true;
          } else {
            const notControllable = authP.state !== 'alive'
              || authP.knockT > 0
              || (authP.blastedT && authP.blastedT > 0)
              || authP.heldBy
              || authP.frozenT > 0;

            if (notControllable) {
              pred.x = authP.x;
              pred.y = authP.y;
              pred.z = authP.z;
              pred.vx = authP.vx;
              pred.vy = authP.vy ?? 0;
              pred.vz = authP.vz;
              pred.face = authP.face;
              pred.spd = authP.spd;
              pred.gearSpd = 0;
              pred.dashT = 0;
            } else {
              // Smooth reconciliation with host authoritative state
              const errX = authP.x - pred.x;
              const errZ = authP.z - pred.z;
              const errDist = Math.hypot(errX, errZ);
              if (errDist > 2.5) {
                // Large snap (e.g. explosive impulse)
                pred.x = authP.x;
                pred.z = authP.z;
                pred.vx = authP.vx;
                pred.vz = authP.vz;
              } else if (errDist > 0.01) {
                // Smooth error decay
                pred.x += errX * 0.25;
                pred.z += errZ * 0.25;
                pred.vx = lerp(pred.vx, authP.vx, 0.2);
                pred.vz = lerp(pred.vz, authP.vz, 0.2);
              }
              if (Math.abs(authP.y - pred.y) > 0.4) {
                pred.y = authP.y;
                pred.vy = authP.vy ?? 0;
              }
            }
          }
        }
      }
    });
    channel.on('join', (message) => {
      if (!requestedHost || !hostGame || !message?.clientId || message.clientId === clientId) return;
      const existing = clientPlayers.get(message.clientId);
      if (existing) {
        channel.send('welcome', { target: message.clientId, playerId: existing });
        return;
      }
      if (clientPlayers.size >= maxPlayers(config)) {
        channel.send('error', { target: message.clientId, reason: 'A sala está cheia!' });
        return;
      }
      const playerId = hostGame.addHuman({ name: String(message.name || 'Player').slice(0, 12), team: message.team, cos: message.cos });
      clientPlayers.set(message.clientId, playerId);
      channel.send('welcome', { target: message.clientId, playerId });
      touchRoom(roomCode, hostToken, clientPlayers.size);
    });
    channel.on('input', (message) => {
      if (!requestedHost || !hostGame) return;
      const playerId = clientPlayers.get(message?.clientId);
      if (playerId) hostGame.setInput(playerId, message.input ?? {});
    });
    channel.on('leave', (message) => {
      if (!requestedHost || !hostGame) return;
      const playerId = clientPlayers.get(message?.clientId);
      if (!playerId) return;
      clientPlayers.delete(message.clientId);
      hostGame.replaceWithBot(playerId);
      touchRoom(roomCode, hostToken, clientPlayers.size);
    });

    function patchWithPrediction(st) {
      if (!st || !pred.initialized || !myId) return st;
      const players = st.players.map((p) => {
        if (p.id !== myId) return p;
        if (p.state === 'alive' && p.knockT <= 0 && (!p.blastedT || p.blastedT <= 0) && !p.heldBy && p.frozenT <= 0) {
          return {
            ...p,
            x: pred.x,
            y: pred.y,
            z: pred.z,
            vx: pred.vx,
            vy: pred.vy,
            vz: pred.vz,
            face: pred.face,
            spd: pred.spd,
            punchT: pred.punchT > 0 ? pred.punchT : p.punchT,
          };
        }
        return p;
      });
      return { ...st, players };
    }

    const transport = {
      kind: 'online-supabase',
      get myId() { return myId; },
      get levelId() { return config.levelId; },
      get modeId() { return config.modeId; },
      setInput(input) {
        if (requestedHost && hostGame) {
          hostGame.setInput(myId, input);
          return;
        }
        currentInput = { ...input };

        // Latched edge triggers
        if (input.jump) latchedInput.jump = true;
        if (input.punch) latchedInput.punch = true;
        if (input.throw) latchedInput.throw = true;
        if (input.dash) latchedInput.dash = true;
        if (input.grab) latchedInput.grab = true;

        const now = performance.now();
        const timeSince = now - lastSent;

        const hasTrigger = latchedInput.jump || latchedInput.punch || latchedInput.throw || latchedInput.dash || latchedInput.grab;
        const dirChanged = Math.hypot(
          (input.mx || 0) - (prevSentInput.mx || 0),
          (input.mz || 0) - (prevSentInput.mz || 0),
        ) > 0.15;

        const shouldSend =
          (hasTrigger && timeSince >= MIN_INPUT_SEND_INTERVAL_MS) ||
          (dirChanged && timeSince >= 15) ||
          (timeSince >= INPUT_INTERVAL_MS);

        if (shouldSend) {
          lastSent = now;
          const toSend = {
            ...input,
            jump: input.jump || latchedInput.jump,
            punch: input.punch || latchedInput.punch,
            throw: input.throw || latchedInput.throw,
            dash: input.dash || latchedInput.dash,
            grab: input.grab || latchedInput.grab,
          };
          latchedInput.jump = false;
          latchedInput.punch = false;
          latchedInput.throw = false;
          latchedInput.dash = false;
          latchedInput.grab = false;
          prevSentInput = { ...toSend };
          channel.send('input', { clientId, input: toSend });
        }
      },
      update(dt) {
        if (requestedHost && hostGame) {
          hostGame.step(dt);
          snapAccumulator += dt;
          if (snapAccumulator >= SNAPSHOT_INTERVAL) {
            snapAccumulator %= SNAPSHOT_INTERVAL;
            const events = hostGame.drainEvents();
            if (events.length) hostEventQ.push(...events);
            channel.send('snap', { state: packState(hostGame.sim.state), events });
          }
          return;
        }

        // --- Client-side execution ---
        if (renderTick !== null) {
          renderTick += dt * TICK_RATE;
          if (snaps.length > 0) {
            const latestTick = snaps[snaps.length - 1].tick;
            const idealTick = latestTick - TARGET_BUFFER_TICKS;
            const diff = idealTick - renderTick;
            if (Math.abs(diff) > 12) {
              renderTick = idealTick;
            } else {
              renderTick += diff * 0.1;
            }
          }
        }

        // Local player movement prediction
        if (pred.initialized && myId) {
          pred.jumpCd = Math.max(0, pred.jumpCd - dt);
          pred.dashCd = Math.max(0, pred.dashCd - dt);
          pred.dashT = Math.max(0, pred.dashT - dt);
          pred.punchCd = Math.max(0, pred.punchCd - dt);
          pred.punchT = Math.max(0, pred.punchT - dt);

          const latestSnap = snaps[snaps.length - 1];
          const me = latestSnap?.players?.find((p) => p.id === myId);
          const isAlive = me
            ? (me.state === 'alive' && me.knockT <= 0 && (!me.blastedT || me.blastedT <= 0) && !me.heldBy && me.frozenT <= 0)
            : true;

          if (isAlive) {
            const onFloor = overFloor(level, pred.x, pred.z);
            const onGround = onFloor && pred.y >= -0.05 && pred.y <= 0.05;

            const m = norm2(currentInput.mx || 0, currentInput.mz || 0);
            const mlen = Math.min(1, Math.hypot(currentInput.mx || 0, currentInput.mz || 0));
            const run = clamp(currentInput.run ?? 1, 0, 1);

            const spd2 = Math.hypot(pred.vx, pred.vz);
            const sm = spd2 > pred.gearSpd ? playerCfg.gearUp : playerCfg.gearDown;
            pred.gearSpd = sm * pred.gearSpd + (1 - sm) * spd2;
            const gear = Math.min(1, pred.gearSpd / playerCfg.gearSpeed);

            let ctrl = onGround ? 1 : (onFloor ? playerCfg.airControl : 0);

            // Dash prediction
            if (currentInput.dash && pred.dashCd <= 0) {
              let ddirX = mlen > 0.05 ? m.x : Math.sin(pred.face);
              let ddirZ = mlen > 0.05 ? m.z : Math.cos(pred.face);
              const dlen = Math.hypot(ddirX, ddirZ);
              if (dlen > 0.001) {
                ddirX /= dlen;
                ddirZ /= dlen;
              }
              const dspeed = playerCfg.dashSpeed ?? 16.5;
              pred.vx = ddirX * dspeed;
              pred.vz = ddirZ * dspeed;
              pred.dashCd = playerCfg.dashCooldown ?? 1.6;
              pred.dashT = playerCfg.dashDuration ?? 0.18;
            }

            // Jump prediction
            if (currentInput.jump && onGround && pred.jumpCd <= 0) {
              pred.jumpCd = playerCfg.jumpCooldown;
              pred.vy = playerCfg.jumpVel;
              pred.y = 0.02;
            }

            // Punch prediction
            if (currentInput.punch && pred.punchCd <= 0) {
              pred.punchCd = playerCfg.punch?.cooldown ?? 0.4;
              pred.punchT = playerCfg.punch?.swingTime ?? 0.3;
            }

            if (mlen > 0.01 && ctrl > 0 && pred.dashT <= 0) {
              const targetSpd = mlen * (playerCfg.walkSpeed + gear * run * (playerCfg.runSpeed - playerCfg.walkSpeed));
              const a = playerCfg.accel * ctrl * dt;
              pred.vx += clamp(m.x * targetSpd - pred.vx, -a, a);
              pred.vz += clamp(m.z * targetSpd - pred.vz, -a, a);
            } else if (ctrl > 0 && pred.dashT <= 0) {
              const a = playerCfg.brakeDecel * ctrl * dt;
              pred.vx += clamp(-pred.vx, -a, a);
              pred.vz += clamp(-pred.vz, -a, a);
            }

            // Facing direction
            if (currentInput.ax !== 0 || currentInput.az !== 0) {
              pred.face = Math.atan2(currentInput.ax, currentInput.az);
            } else if (mlen > 0.01) {
              pred.face = Math.atan2(currentInput.mx, currentInput.mz);
            }

            // Integrate player body
            integrateBody(level, worldCfg, pred, matPlayer, dt, {
              wallE: 0,
              noGroundFriction: ctrl > 0.5 || pred.dashT > 0,
            });
            pred.spd = Math.hypot(pred.vx, pred.vz);
          }
        }
      },
      view() {
        if (requestedHost) return hostGame?.view() ?? null;
        if (snaps.length === 0) return null;
        if (snaps.length === 1) return patchWithPrediction(snaps[0]);

        const latest = snaps[snaps.length - 1];
        const target = renderTick ?? (latest.tick - TARGET_BUFFER_TICKS);

        let a = null;
        let b = null;
        for (let i = snaps.length - 1; i >= 0; i -= 1) {
          if (snaps[i].tick <= target) {
            a = snaps[i];
            b = snaps[i + 1] ?? null;
            break;
          }
        }

        if (!a) {
          a = snaps[0];
          b = snaps[1] ?? a;
        }

        let result;
        if (!b) {
          const secondLatest = snaps[snaps.length - 2];
          if (secondLatest && latest && latest.tick > secondLatest.tick) {
            const span = latest.tick - secondLatest.tick;
            const t = (target - secondLatest.tick) / span;
            const clampedT = clamp(t, 1, 2.0);
            result = interpState(secondLatest, latest, clampedT);
          } else {
            result = latest;
          }
        } else {
          const span = b.tick - a.tick || 1;
          const t = clamp((target - a.tick) / span, 0, 1.5);
          result = interpState(a, b, t);
        }

        return patchWithPrediction(result);
      },
      drainEvents() {
        if (requestedHost) return hostEventQ.splice(0, hostEventQ.length);
        return eventQ.splice(0, eventQ.length);
      },
      dispose() {
        closed = true;
        clearInterval(welcomeTimer);
        clearInterval(touchTimer);
        if (requestedHost) {
          channel.send('host-left', { clientId });
          touchRoom(roomCode, hostToken, 0);
        } else channel.send('leave', { clientId });
        channel.close();
      },
    };

    if (requestedHost) {
      hostGame = new GameHost(roomOptions(config));
      myId = hostGame.addHuman({ name: profile.name, team, cos: { ...profile.cos } });
      clientPlayers.set(clientId, myId);
      hostGame.fillBots();
      touchRoom(roomCode, hostToken, 1);
      touchTimer = setInterval(() => touchRoom(roomCode, hostToken, clientPlayers.size), 30_000);
      settled = true;
      resolve(transport);
    } else {
      sendJoin();
      welcomeTimer = setInterval(sendJoin, 1000);
      setTimeout(() => fail(new Error('O criador da sala não está conectado')), 10_000);
    }
  });
}
