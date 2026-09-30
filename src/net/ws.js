// Cloud multiplayer transport. Supabase Realtime relays inputs and snapshots;
// the room creator runs the authoritative GameHost in their browser.

import { clamp, lerp, angleLerp } from '../core/math.js';
import { CONFIG } from '../core/config.js';
import { GameHost } from '../game/host.js';
import { packState } from './protocol.js';
import { joinRoom, touchRoom } from './rooms.js';
import { SupabaseRealtimeChannel } from './supabase.js';

const INTERP_DELAY_TICKS = 8;
const SNAPSHOT_INTERVAL = 1 / 15;
const INPUT_INTERVAL_MS = 50;

function interpPlayers(aList, bList, t) {
  const byIdA = new Map(aList.map((p) => [p.id, p]));
  return bList.map((b) => {
    const a = byIdA.get(b.id);
    if (!a || a.state !== b.state) return { ...b };
    return { ...b, x: lerp(a.x, b.x, t), z: lerp(a.z, b.z, t), y: lerp(a.y, b.y, t), spd: lerp(a.spd, b.spd, t), face: angleLerp(a.face, b.face, t) };
  });
}

function interpState(a, b, t) {
  const out = { ...b, players: interpPlayers(a.players, b.players, t) };
  const bombA = new Map(a.bombs.map((x) => [x.id, x]));
  out.bombs = b.bombs.map((next) => {
    const prev = bombA.get(next.id);
    return prev ? { ...next, x: lerp(prev.x, next.x, t), z: lerp(prev.z, next.z, t), y: lerp(prev.y, next.y, t) } : { ...next };
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
      out.flags[team] = prev && prev.st === next.st
        ? { ...next, x: lerp(prev.x, next.x, t), z: lerp(prev.z, next.z, t), y: lerp(prev.y, next.y, t) }
        : { ...next };
    }
  }
  return out;
}

function roomOptions(room) {
  return {
    levelId: room.levelId,
    modeId: room.modeId,
    teamLimits: room.teamLimits,
    respawnTime: room.respawnTime,
    friendlyFire: room.friendlyFire,
    config: {
      ...CONFIG,
      player: { ...CONFIG.player, respawnTime: room.respawnTime },
      rules: { ...CONFIG.rules, friendlyFire: room.friendlyFire },
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
    const snaps = [];
    const eventQ = [];
    const hostEventQ = [];
    const clientPlayers = new Map();

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
        const now = performance.now();
        if (now - lastSent >= INPUT_INTERVAL_MS) {
          lastSent = now;
          channel.send('input', { clientId, input });
        }
      },
      update(dt) {
        if (!requestedHost || !hostGame) return;
        hostGame.step(dt);
        snapAccumulator += dt;
        if (snapAccumulator >= SNAPSHOT_INTERVAL) {
          snapAccumulator %= SNAPSHOT_INTERVAL;
          const events = hostGame.drainEvents();
          if (events.length) hostEventQ.push(...events);
          channel.send('snap', { state: packState(hostGame.sim.state), events });
        }
      },
      view() {
        if (requestedHost) return hostGame?.view() ?? null;
        if (snaps.length === 0) return null;
        if (snaps.length === 1) return snaps[0];
        const latest = snaps[snaps.length - 1];
        const target = latest.tick - INTERP_DELAY_TICKS;
        for (let i = snaps.length - 1; i > 0; i -= 1) {
          if (snaps[i - 1].tick <= target) {
            const a = snaps[i - 1];
            const b = snaps[i];
            return interpState(a, b, clamp((target - a.tick) / (b.tick - a.tick || 1), 0, 1));
          }
        }
        return latest;
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
