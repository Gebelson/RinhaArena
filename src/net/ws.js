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
import {
  createMatchmakingSession, finalizeMatchmakingSession, MatchmakingStatus,
  replaceHumanParticipantWithBot, validDisplayName,
} from '../game/matchmaking.js';
import { EMOTE_IDS } from '../content/emotes.js';

const TICK_RATE = CONFIG.tickRate || 60;
const SNAPSHOT_INTERVAL = 1 / 30; // 30 Hz broadcasts from host
const INPUT_INTERVAL_MS = 25; // 40 Hz periodic input updates for steady movement
const MIN_INPUT_SEND_INTERVAL_MS = 10; // minimum interval for immediate edge-trigger sends
const TARGET_BUFFER_TICKS = 6; // ~100ms keeps remote players smooth under normal Realtime jitter

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
      vy: lerp(a.vy ?? 0, b.vy ?? 0, t),
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
    let presenceTimer = null;
    let renderTick = null;
    const snaps = [];
    const eventQ = [];
    const hostEventQ = [];
    const chatMessages = [];
    const controlEvents = [];
    const abandonWaiters = [];
    const abandonedUsers = new Set();
    const surrenderVotes = new Map();
    const surrenderCooldowns = new Map();
    const clientPlayers = new Map();
    let lobbyPlayers = [];
    let remoteQueueEndsAt = Number(config.queueEndsAt) || null;
    let matchInfo = null;
    let session = null;
    const matchWaiters = [];
    const readyUsers = new Set();
    const startWaiters = [];
    let matchStart = null;
    let readyTimer = null;
    let isHost = requestedHost;
    let hostTransferReceived = false;
    let authorityTransferred = false;

    const predictionLevel = (id) => {
      const copy = JSON.parse(JSON.stringify(LEVELS[id] || LEVELS[DEFAULT_LEVEL]));
      for (const item of copy.interactives ?? []) {
        if (item.type === 'rotator') {
          for (let n = 0; n < 4; n++) copy.solids.push({ x: item.x, z: item.z, w: 1.25, d: 1.25, h: 1.65, kind: 'pillar', interactiveId: item.id, orbit: n });
        } else copy.solids.push({ x: item.type === 'bridge' ? 9999 : item.x, z: item.z, w: item.w, d: item.d, h: item.type === 'bridge' ? 0.01 : item.h, kind: 'mechanical', interactiveId: item.id });
      }
      return copy;
    };
    let level = predictionLevel(config.levelId);
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
    const officialName = validDisplayName(profile.name);
    if (!profile.playerId || !officialName) {
      fail(new Error('Seu perfil precisa de uma identificação e nickname válidos para jogar online'));
      return;
    }
    const sendJoin = () => channel.send('join', {
      clientId, userId: profile.playerId, displayName: officialName, cos: profile.cos, team,
    });
    const resolveMatch = (payload) => {
      if (!payload?.id || !Array.isArray(payload.participants)) return;
      matchInfo = payload;
      config.levelId = payload.mapId;
      config.modeId = payload.mode;
      level = predictionLevel(payload.mapId);
      const mine = payload.participants.find((participant) => participant.type === 'HUMAN' && participant.userId === profile.playerId);
      if (!mine) {
        fail(new Error('MATCH_FOUND não contém o participante deste usuário'));
        return;
      }
      myId = mine.participantId;
      while (matchWaiters.length) matchWaiters.shift()(payload);
    };

    channel.on('disconnect', () => {
      if (settled && !closed) onDropped?.();
      else fail(new Error('Conexão multiplayer interrompida'));
    });
    channel.on('host-left', () => {
      if (isHost || closed) return;
      setTimeout(() => {
        if (!hostTransferReceived && !closed) onDropped?.();
      }, 750);
    });
    channel.on('host-transfer', (message) => {
      if (isHost || closed || !message?.match || !message?.successorUserId) return;
      hostTransferReceived = true;
      resolveMatch(message.match);
      if (message.successorUserId !== profile.playerId) return;
      isHost = true;
      clientPlayers.clear();
      for (const record of message.players || []) {
        if (record?.clientId && record?.userId) clientPlayers.set(record.clientId, { ...record, connected: true });
      }
      matchInfo = message.match;
      hostGame = new GameHost({ ...roomOptions(config), participants: matchInfo.participants });
      hostGame.restoreAuthorityState(message.authorityState);
      if (message.departedUserId) hostGame.disconnectHuman(`human:${message.departedUserId}`);
      matchStart = message.matchStart || matchStart;
      for (const participant of matchInfo.participants) {
        if (participant.type === 'HUMAN') readyUsers.add(participant.userId);
      }
      channel.send('match-found', { match: matchInfo });
      if (!matchStart) maybeStartMatch(true);
      console.info(`[MATCH] authority transferred match=${matchInfo.id} successor=${profile.playerId}`);
    });
    channel.on('welcome', (message) => {
      if (isHost || message?.target !== clientId || settled) return;
      myId = message.playerId;
      lobbyPlayers = Array.isArray(message.players) ? message.players : [];
      remoteQueueEndsAt = Number(message.queueEndsAt) || remoteQueueEndsAt;
      clearInterval(welcomeTimer);
      settled = true;
      resolve(transport);
    });
    channel.on('queue-update', (message) => {
      if (Array.isArray(message?.players)) lobbyPlayers = message.players;
      remoteQueueEndsAt = Number(message?.deadlineAt) || remoteQueueEndsAt;
    });
    channel.on('match-found', (message) => resolveMatch(message?.match));
    channel.on('match-client-ready', (message) => {
      if (!isHost || !matchInfo || !message?.userId) return;
      if (matchInfo.participants.some((participant) => participant.type === 'HUMAN' && participant.userId === message.userId)) {
        readyUsers.add(message.userId);
        maybeStartMatch();
      }
    });
    channel.on('match-start', (message) => {
      if (!message?.matchId) return;
      if (matchInfo && message.matchId !== matchInfo.id) return;
      matchStart = message;
      if (matchInfo) {
        matchInfo.status = 'PLAYING';
        matchInfo.startedAt = message.startAt;
      }
      while (startWaiters.length) startWaiters.shift()(message);
    });
    channel.on('presence-ping', (message) => {
      if (!isHost) return;
      const player = clientPlayers.get(message?.clientId);
      if (player) player.lastSeenAt = Date.now();
    });
    const broadcastSurrender = (vote) => {
      const payload = {
        team: vote.team,
        startedAt: vote.startedAt,
        deadlineAt: vote.deadlineAt,
        votes: [...vote.votes.entries()],
      };
      channel.send('surrender-update', payload);
      const mine = matchInfo?.participants.find((p) => p.userId === profile.playerId);
      if (isHost && mine?.team === vote.team) controlEvents.push({ type: 'surrender-update', ...payload });
    };
    const finishSurrender = (team) => {
      const vote = surrenderVotes.get(team);
      if (!vote) return;
      clearTimeout(vote.timer);
      surrenderVotes.delete(team);
      const humans = matchInfo.participants.filter((p) => p.type === 'HUMAN' && p.team === team && !abandonedUsers.has(p.userId));
      const yes = [...vote.votes.values()].filter(Boolean).length;
      const approved = humans.length > 0 && yes / humans.length >= (config.config?.rules?.surrenderApprovalRatio ?? CONFIG.rules.surrenderApprovalRatio);
      channel.send('surrender-result', { team, approved, yes, total: humans.length });
      const mine = matchInfo?.participants.find((p) => p.userId === profile.playerId);
      if (isHost && mine?.team === team) controlEvents.push({ type: 'surrender-result', team, approved, yes, total: humans.length });
      if (approved) hostGame?.forfeitTeam(team);
    };
    channel.on('surrender-start', (message) => {
      if (!isHost || !matchInfo || matchStart == null) return;
      const sender = clientPlayers.get(message?.clientId);
      const participant = matchInfo.participants.find((p) => p.userId === sender?.userId && p.type === 'HUMAN');
      if (!participant || surrenderVotes.has(participant.team) || Date.now() < (surrenderCooldowns.get(participant.team) || 0)) return;
      const duration = config.config?.rules?.surrenderVoteDurationMs ?? CONFIG.rules.surrenderVoteDurationMs;
      const vote = { team: participant.team, startedAt: Date.now(), deadlineAt: Date.now() + duration, votes: new Map([[participant.userId, true]]), timer: null };
      vote.timer = setTimeout(() => finishSurrender(participant.team), duration);
      surrenderVotes.set(participant.team, vote);
      surrenderCooldowns.set(participant.team, vote.deadlineAt + (config.config?.rules?.surrenderVoteCooldownMs ?? CONFIG.rules.surrenderVoteCooldownMs));
      broadcastSurrender(vote);
    });
    channel.on('surrender-vote', (message) => {
      if (!isHost) return;
      const sender = clientPlayers.get(message?.clientId);
      const vote = surrenderVotes.get(message?.team);
      const participant = matchInfo?.participants.find((p) => p.userId === sender?.userId && p.type === 'HUMAN' && p.team === message.team);
      if (!vote || !participant || vote.votes.has(participant.userId) || Date.now() >= vote.deadlineAt) return;
      vote.votes.set(participant.userId, Boolean(message.yes));
      broadcastSurrender(vote);
      const humans = matchInfo.participants.filter((p) => p.type === 'HUMAN' && p.team === vote.team && !abandonedUsers.has(p.userId));
      if (vote.votes.size >= humans.length) finishSurrender(vote.team);
    });
    channel.on('surrender-update', (message) => {
      const mine = matchInfo?.participants.find((p) => p.userId === profile.playerId);
      if (mine?.team === message?.team) controlEvents.push({ type: 'surrender-update', ...message });
    });
    channel.on('surrender-result', (message) => {
      const mine = matchInfo?.participants.find((p) => p.userId === profile.playerId);
      if (mine?.team === message?.team) controlEvents.push({ type: 'surrender-result', ...message });
    });
    const processAbandon = (userId) => {
      if (!matchInfo || abandonedUsers.has(userId)) return null;
      const participant = matchInfo.participants.find((p) => p.type === 'HUMAN' && p.userId === userId);
      if (!participant) return null;
      abandonedUsers.add(userId);
      const remaining = matchInfo.participants.filter((p) => p.type === 'HUMAN' && p.userId !== userId && !abandonedUsers.has(p.userId));
      if (remaining.length) {
        hostGame?.replaceHumanWithBotInPlace(participant.participantId, userId);
        participant.type = 'BOT'; participant.botId = `replacement:${userId}`;
        participant.participantId = `bot:replacement:${userId}`; participant.userId = undefined;
        participant.replacementForPlayerId = userId;
      } else {
        matchInfo.status = 'FINISHED';
        for (const vote of surrenderVotes.values()) clearTimeout(vote.timer);
        surrenderVotes.clear();
        hostGame = null;
        channel.send('match-ended', { matchId: matchInfo.id, reason: 'no-humans' });
      }
      return {
        matchId: matchInfo.id, mode: config.matchType || (matchInfo.ranked ? 'ranked' : 'normal'), ranked: matchInfo.ranked,
        ended: remaining.length === 0,
        rankPenalty: matchInfo.ranked ? Math.round((config.config?.rules?.normalRankLoss ?? CONFIG.rules.normalRankLoss) * 4 / 3) : 0,
      };
    };
    channel.on('abandon-request', (message) => {
      if (!isHost || !message?.userId) return;
      const sender = clientPlayers.get(message.clientId);
      if (sender?.userId !== message.userId) return;
      const result = processAbandon(message.userId);
      channel.send('abandon-result', { target: message.clientId, ...(result || { duplicate: true }) });
    });
    channel.on('abandon-result', (message) => {
      if (message?.target !== clientId) return;
      while (abandonWaiters.length) abandonWaiters.shift()(message);
    });
    channel.on('error', (message) => {
      if (message?.target === clientId) fail(new Error(message.reason || 'Não foi possível entrar na sala'));
    });
    channel.on('snap', (message) => {
      if (isHost || !message?.state) return;
      const lastSnapshot = snaps[snaps.length - 1];
      if (lastSnapshot && Number(message.state.tick) <= Number(lastSnapshot.tick)) return;
      for (const state of message.state.interactives ?? []) {
        const cfg = level.interactives?.find((item) => item.id === state.id);
        if (!cfg) continue;
        for (const solid of level.solids.filter((item) => item.interactiveId === state.id)) {
          if (cfg.type === 'rotator') {
            const angle = state.angle + solid.orbit * Math.PI / 2;
            solid.x = cfg.x + Math.cos(angle) * 3.25;
            solid.z = cfg.z + Math.sin(angle) * 3.25;
          } else {
            solid.x = cfg.type === 'bridge' && state.active ? 9999 : state.x;
            solid.z = state.z;
            if (cfg.type === 'bridge') solid.h = state.active ? 0.01 : 1.45;
          }
        }
      }
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
              if (errDist > 4.0) {
                // Only teleport for a truly large divergence (spawn, blast or recovery).
                pred.x = authP.x;
                pred.z = authP.z;
                pred.vx = authP.vx;
                pred.vz = authP.vz;
              } else if (errDist > 0.15) {
                // The host snapshot is naturally behind the predicted client.
                // Correct only meaningful drift and do it gently to avoid rubber-banding.
                pred.x += errX * 0.08;
                pred.z += errZ * 0.08;
                pred.vx = lerp(pred.vx, authP.vx, 0.08);
                pred.vz = lerp(pred.vz, authP.vz, 0.08);
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
    channel.on('chat-send', (message) => {
      if (!isHost || !matchInfo || message?.matchId !== matchInfo.id) return;
      const sender = clientPlayers.get(message?.clientId);
      const text = String(message?.text || '').trim().slice(0, 100);
      if (!sender?.participantId || !text) return;
      const payload = {
        matchId: matchInfo.id,
        participantId: sender.participantId,
        displayName: sender.displayName,
        text,
      };
      chatMessages.push(payload);
      channel.send('chat-message', payload);
    });
    channel.on('chat-message', (message) => {
      if (isHost || !matchInfo || message?.matchId !== matchInfo.id) return;
      const participant = matchInfo.participants.find((entry) => entry.participantId === message?.participantId);
      const text = String(message?.text || '').trim().slice(0, 100);
      if (!participant || participant.type !== 'HUMAN' || participant.displayName !== message.displayName || !text) return;
      chatMessages.push({ ...message, text, own: participant.userId === profile.playerId });
    });
    channel.on('emote-send', (message) => {
      if (!isHost || !matchInfo || message?.matchId !== matchInfo.id || !EMOTE_IDS.has(message?.emote)) return;
      const sender = clientPlayers.get(message?.clientId);
      const participant = matchInfo.participants.find((entry) => entry.participantId === sender?.participantId && entry.type === 'HUMAN');
      if (!participant || !(sender.cos?.ownedEmotes || []).includes(message.emote)) return;
      const payload = { matchId: matchInfo.id, participantId: participant.participantId, emote: message.emote };
      controlEvents.push({ type: 'emote', ...payload });
      channel.send('emote-show', payload);
    });
    channel.on('emote-show', (message) => {
      if (isHost || !matchInfo || message?.matchId !== matchInfo.id || !EMOTE_IDS.has(message?.emote)) return;
      const participant = matchInfo.participants.find((entry) => entry.participantId === message?.participantId);
      if (participant) controlEvents.push({ type: 'emote', participantId: participant.participantId, emote: message.emote });
    });
    const broadcastQueue = () => channel.send('queue-update', {
      players: [...clientPlayers.values()].map(({ userId, displayName, cos, team }) => ({ userId, name: displayName, displayName, cos, team })),
      deadlineAt: remoteQueueEndsAt,
    });
    const maybeStartMatch = (force = false) => {
      if (!isHost || !matchInfo || matchStart) return;
      const humanIds = matchInfo.participants.filter((participant) => participant.type === 'HUMAN').map((participant) => participant.userId);
      if (!force && !humanIds.every((userId) => readyUsers.has(userId))) return;
      clearTimeout(readyTimer);
      matchInfo.status = 'STARTING';
      matchStart = { matchId: matchInfo.id, startAt: Date.now() + 500 };
      matchInfo.startedAt = matchStart.startAt;
      channel.send('match-start', matchStart);
      while (startWaiters.length) startWaiters.shift()(matchStart);
    };
    channel.on('join', (message) => {
      if (!isHost || !message?.clientId || message.clientId === clientId) return;
      const displayName = validDisplayName(message.displayName);
      if (!message.userId || !displayName) {
        channel.send('error', { target: message.clientId, reason: 'Perfil multiplayer inválido' });
        return;
      }
      const existing = clientPlayers.get(message.clientId);
      if (existing) {
        channel.send('welcome', {
          target: message.clientId, playerId: existing.participantId ?? null,
          players: [...clientPlayers.values()].map((entry) => ({ userId: entry.userId, name: entry.displayName, displayName: entry.displayName, cos: entry.cos })),
          queueEndsAt: remoteQueueEndsAt,
        });
        if (matchInfo) channel.send('match-found', { target: message.clientId, match: matchInfo });
        if (matchStart) channel.send('match-start', { ...matchStart, target: message.clientId });
        return;
      }
      const reconnect = [...clientPlayers.values()].find((entry) => entry.userId === message.userId);
      if (reconnect) {
        clientPlayers.delete(reconnect.clientId);
        reconnect.clientId = message.clientId;
        reconnect.connected = true;
        reconnect.lastSeenAt = Date.now();
        clientPlayers.set(message.clientId, reconnect);
        if (hostGame && reconnect.participantId) {
          const player = hostGame.sim.state.players.find((candidate) => candidate.participantId === reconnect.participantId);
          if (player) hostGame.reconnectHuman(reconnect.participantId);
        }
        channel.send('welcome', { target: message.clientId, playerId: reconnect.participantId ?? null, players: lobbyPlayers, queueEndsAt: remoteQueueEndsAt });
        if (matchInfo) channel.send('match-found', { target: message.clientId, match: matchInfo });
        if (matchStart) channel.send('match-start', { ...matchStart, target: message.clientId });
        broadcastQueue();
        return;
      }
      const returningParticipant = matchInfo?.participants.find((participant) => participant.type === 'HUMAN' && participant.userId === message.userId);
      if (returningParticipant && matchStart) {
        const record = {
          clientId: message.clientId, userId: message.userId, displayName,
          characterId: returningParticipant.characterId, cos: returningParticipant.cos,
          team: returningParticipant.team, connected: true,
          participantId: returningParticipant.participantId, lastSeenAt: Date.now(),
        };
        clientPlayers.set(message.clientId, record);
        hostGame?.reconnectHuman(returningParticipant.participantId);
        channel.send('welcome', { target: message.clientId, playerId: returningParticipant.participantId, players: lobbyPlayers, queueEndsAt: remoteQueueEndsAt });
        channel.send('match-found', { target: message.clientId, match: matchInfo });
        channel.send('match-start', { ...matchStart, target: message.clientId });
        return;
      }
      if (clientPlayers.size >= maxPlayers(config)) {
        channel.send('error', { target: message.clientId, reason: 'A sala está cheia!' });
        return;
      }
      if (session?.status !== MatchmakingStatus.WAITING) {
        channel.send('error', { target: message.clientId, reason: 'A partida já está iniciando' });
        return;
      }
      const record = {
        clientId: message.clientId, userId: message.userId, displayName,
        characterId: ['crocodilo', 'porco', 'pato', 'gato', 'cachorro', 'macaco'].includes(message.cos?.characterId) ? message.cos.characterId : 'capivara', cos: message.cos, team: message.team, connected: true, participantId: null,
        lastSeenAt: Date.now(),
      };
      clientPlayers.set(message.clientId, record);
      session.players.set(record.userId, record);
      channel.send('welcome', {
        target: message.clientId,
        playerId: null,
        players: [...clientPlayers.values()].map((entry) => ({ userId: entry.userId, name: entry.displayName, displayName: entry.displayName, cos: entry.cos })),
        queueEndsAt: remoteQueueEndsAt,
      });
      broadcastQueue();
      touchRoom(roomCode, hostToken, clientPlayers.size);
    });
    channel.on('input', (message) => {
      if (!isHost || !hostGame) return;
      const player = clientPlayers.get(message?.clientId);
      if (player?.participantId && hostGame) hostGame.setInput(player.participantId, message.input ?? {});
    });
    channel.on('leave', (message) => {
      if (!isHost) return;
      const player = clientPlayers.get(message?.clientId);
      if (!player) return;
      if (session?.status === MatchmakingStatus.WAITING) {
        clientPlayers.delete(message.clientId);
        session.players.delete(player.userId);
      } else if (player.participantId && matchInfo && !matchStart) {
        clientPlayers.delete(message.clientId);
        const index = matchInfo.participants.findIndex((participant) => participant.type === 'HUMAN' && participant.userId === player.userId);
        if (index >= 0) {
          replaceHumanParticipantWithBot(matchInfo, player.userId);
          hostGame = new GameHost({ ...roomOptions(config), participants: matchInfo.participants });
          channel.send('match-found', { match: matchInfo });
          maybeStartMatch();
        }
      } else if (player.participantId) {
        player.connected = false;
        hostGame?.disconnectHuman(player.participantId);
      }
      broadcastQueue();
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
            dashT: pred.dashT,
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
      lobbyPlayers() {
        if (isHost) return [...clientPlayers.values()].map((entry) => ({
          userId: entry.userId, name: entry.displayName, displayName: entry.displayName, cos: entry.cos,
        }));
        return lobbyPlayers;
      },
      matchmakingEndsAt() { return remoteQueueEndsAt; },
      isMatchReady() { return !!matchInfo; },
      match() { return matchInfo; },
      waitForMatch() {
        if (matchInfo) return Promise.resolve(matchInfo);
        return new Promise((resolve) => matchWaiters.push(resolve));
      },
      clientReadyAndWaitForStart() {
        if (!matchInfo) return Promise.reject(new Error('MATCH_CLIENT_READY antes de MATCH_FOUND'));
        if (isHost) {
          readyUsers.add(profile.playerId);
          maybeStartMatch();
        } else {
          channel.send('match-client-ready', { matchId: matchInfo.id, userId: profile.playerId });
        }
        if (matchStart) return Promise.resolve(matchStart);
        return new Promise((resolve) => startWaiters.push(resolve));
      },
      finalizeMatchmaking(options = {}) {
        if (!isHost) return matchInfo;
        if (matchInfo) return matchInfo;
        const match = finalizeMatchmakingSession(session, config, options);
        hostGame = new GameHost({ ...roomOptions(config), participants: match.participants });
        matchInfo = match;
        for (const record of clientPlayers.values()) {
          record.participantId = `human:${record.userId}`;
        }
        myId = `human:${profile.playerId}`;
        console.info(`[MATCH] creating match=${match.id} session=${session.id} map=${match.mapId} seed=${match.mapSeed} humans=${session.players.size} bots=${match.participants.filter((p) => p.type === 'BOT').length} participants=${match.participants.length}`);
        for (const participant of match.participants) {
          console.info(`[MATCH PARTICIPANT] id=${participant.participantId} type=${participant.type} userId=${participant.userId ?? '-'} botId=${participant.botId ?? '-'} name=${participant.displayName} spawn=${participant.spawnIndex}`);
        }
        channel.send('match-found', { match });
        readyTimer = setTimeout(() => maybeStartMatch(true), 10_000);
        while (matchWaiters.length) matchWaiters.shift()(match);
        return match;
      },
      setInput(input) {
        if (isHost && hostGame) {
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
        if (isHost && hostGame) {
          const now = Date.now();
          for (const record of clientPlayers.values()) {
            if (record.clientId !== clientId && record.connected !== false && now - (record.lastSeenAt || now) > 6_000) {
              record.connected = false;
              if (record.participantId) hostGame.disconnectHuman(record.participantId);
            }
          }
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
        if (isHost) return hostGame?.view() ?? null;
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
            const clampedT = clamp(t, 0, 1);
            result = interpState(secondLatest, latest, clampedT);
          } else {
            result = latest;
          }
        } else {
          const span = b.tick - a.tick || 1;
          const t = clamp((target - a.tick) / span, 0, 1);
          result = interpState(a, b, t);
        }

        return patchWithPrediction(result);
      },
      drainEvents() {
        if (isHost) return hostEventQ.splice(0, hostEventQ.length);
        return eventQ.splice(0, eventQ.length);
      },
      sendChat(text) {
        if (!matchInfo) return;
        const message = String(text || '').trim().slice(0, 100);
        if (!message) return;
        if (isHost) {
          const participant = matchInfo.participants.find((entry) => entry.type === 'HUMAN' && entry.userId === profile.playerId);
          if (!participant) return;
          const payload = {
            matchId: matchInfo.id,
            participantId: participant.participantId,
            displayName: participant.displayName,
            text: message,
            own: true,
          };
          chatMessages.push(payload);
          channel.send('chat-message', { ...payload, own: undefined });
        } else {
          channel.send('chat-send', { clientId, matchId: matchInfo.id, text: message });
        }
      },
      drainChatMessages() { return chatMessages.splice(0, chatMessages.length); },
      drainControlEvents() { return controlEvents.splice(0, controlEvents.length); },
      sendEmote(emote) {
        if (!matchInfo || !EMOTE_IDS.has(emote) || !(profile.cos?.ownedEmotes || []).includes(emote)) return false;
        if (isHost) channel.emit('emote-send', { clientId, matchId: matchInfo.id, emote });
        else channel.send('emote-send', { clientId, matchId: matchInfo.id, emote });
        return true;
      },
      requestSurrender() {
        if (!matchInfo) return false;
        if (isHost) channel.emit('surrender-start', { clientId });
        else channel.send('surrender-start', { clientId });
        return true;
      },
      voteSurrender(team, yes) {
        if (isHost) channel.emit('surrender-vote', { clientId, team, yes });
        else channel.send('surrender-vote', { clientId, team, yes });
      },
      abandonMatch() {
        if (!matchInfo) return Promise.reject(new Error('Partida indisponível'));
        if (abandonedUsers.has(profile.playerId)) return Promise.resolve({ duplicate: true });
        if (isHost) return Promise.resolve(processAbandon(profile.playerId));
        channel.send('abandon-request', { clientId, userId: profile.playerId, matchId: matchInfo.id });
        return new Promise((resolve) => abandonWaiters.push(resolve));
      },
      resumeInfo() {
        if (!matchInfo || matchInfo.status === 'FINISHED') return null;
        return {
          room: roomCode, matchId: matchInfo.id, expiresAt: Date.now() + 30 * 60_000,
          ...(isHost ? {
            host: true, hostToken, roomConfig: config, match: matchInfo, matchStart,
            authorityState: hostGame?.exportAuthorityState?.() ?? null,
          } : {}),
        };
      },
      restoreHostedMatch(saved) {
        if (!isHost || !saved?.match || saved.match.id !== saved.matchId) return false;
        matchInfo = saved.match;
        config.levelId = matchInfo.mapId;
        config.modeId = matchInfo.mode;
        level = predictionLevel(config.levelId);
        hostGame = new GameHost({ ...roomOptions(config), participants: matchInfo.participants });
        hostGame.restoreAuthorityState(saved.authorityState);
        matchStart = saved.matchStart || { matchId: matchInfo.id, startAt: Date.now() };
        myId = `human:${profile.playerId}`;
        const hostRecord = clientPlayers.get(clientId);
        if (hostRecord) hostRecord.participantId = myId;
        hostGame.reconnectHuman(myId);
        channel.send('match-found', { match: matchInfo });
        channel.send('match-start', matchStart);
        return true;
      },
      notifyDisconnect() {
        if (isHost) return transferAuthority();
        channel.send('leave', { clientId, temporary: true });
        return false;
      },
      dispose() {
        closed = true;
        clearInterval(welcomeTimer);
        clearInterval(touchTimer);
        clearInterval(presenceTimer);
        clearTimeout(readyTimer);
        for (const vote of surrenderVotes.values()) clearTimeout(vote.timer);
        surrenderVotes.clear();
        if (isHost) {
          transferAuthority();
          channel.send('host-left', { clientId, userId: profile.playerId });
          if (hostToken) touchRoom(roomCode, hostToken, 0);
        } else channel.send('leave', { clientId });
        channel.close();
      },
    };

    function transferAuthority() {
      if (!isHost || authorityTransferred || !matchInfo) return false;
      const remaining = [...clientPlayers.values()].filter((entry) => entry.userId !== profile.playerId && entry.connected !== false && !abandonedUsers.has(entry.userId));
      if (!remaining.length) return false;
      authorityTransferred = true;
      const successorUserId = remaining.map((entry) => entry.userId).sort()[0];
      channel.send('host-transfer', {
        successorUserId, players: remaining, match: matchInfo,
        matchStart, departedUserId: profile.playerId,
        authorityState: hostGame?.exportAuthorityState?.() ?? null,
      });
      return true;
    }

    if (requestedHost) {
      const capacity = maxPlayers(config);
      session = createMatchmakingSession({
        id: `queue:${roomCode}`,
        queueKey: config.config?.rules?.ranked ? `${config.modeId}:ranked` : `${config.modeId}:normal`,
        mode: config.modeId,
        ranked: !!config.config?.rules?.ranked,
        maxPlayers: capacity,
        createdAt: remoteQueueEndsAt ? remoteQueueEndsAt - 30_000 : Date.now(),
      });
      remoteQueueEndsAt = session.deadlineAt;
      const hostRecord = {
        clientId, userId: profile.playerId, displayName: officialName,
        characterId: ['crocodilo', 'porco', 'pato', 'gato', 'cachorro', 'macaco'].includes(profile.cos?.characterId) ? profile.cos.characterId : 'capivara', cos: { ...profile.cos }, team, connected: true, participantId: null, lastSeenAt: Date.now(),
      };
      clientPlayers.set(clientId, hostRecord);
      session.players.set(hostRecord.userId, hostRecord);
      console.info(`[QUEUE] created session=${session.id}`);
      console.info(`[QUEUE] user=${hostRecord.userId} joined session=${session.id}`);
      touchRoom(roomCode, hostToken, 1);
      touchTimer = setInterval(() => touchRoom(roomCode, hostToken, clientPlayers.size), 30_000);
      settled = true;
      resolve(transport);
    } else {
      sendJoin();
      welcomeTimer = setInterval(sendJoin, 1000);
      presenceTimer = setInterval(() => channel.send('presence-ping', { clientId }), 2_000);
      setTimeout(() => fail(new Error('O criador da sala não está conectado')), 10_000);
    }
  });
}
