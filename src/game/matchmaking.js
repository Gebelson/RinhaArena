import { BOT_NAMES, randomCos } from '../content/cosmetics.js';
import { MAX_PLAYERS, MAX_TEAM_SIZE } from './capacity.js';
export { MAX_PLAYERS } from './capacity.js';

export const MATCHMAKING_TIMEOUT = 30_000;
export const MATCH_READY_TIMEOUT = 10_000;

export const ParticipantType = Object.freeze({ HUMAN: 'HUMAN', BOT: 'BOT' });
export const MatchmakingStatus = Object.freeze({
  WAITING: 'WAITING', STARTING: 'STARTING', STARTED: 'STARTED', CANCELLED: 'CANCELLED',
});

const makeId = (prefix) => `${prefix}:${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;

export function validDisplayName(value) {
  const name = String(value ?? '').trim().slice(0, 12);
  if (!name || /^player(?:\s*\d+)?$/i.test(name) || /^(unknown|guest)$/i.test(name)) return null;
  return name;
}

export function replaceHumanParticipantWithBot(match, userId) {
  if (!match?.id || !Array.isArray(match.participants)) return null;
  const index = match.participants.findIndex((participant) => participant.type === ParticipantType.HUMAN && participant.userId === userId);
  if (index < 0) return null;
  const previous = match.participants[index];
  const botId = `replacement:${match.id}:${previous.spawnIndex}`;
  const replacement = {
    ...previous,
    participantId: `bot:${botId}`,
    type: ParticipantType.BOT,
    botId,
    userId: undefined,
    displayName: BOT_NAMES[previous.spawnIndex % BOT_NAMES.length],
    cos: randomCos(),
  };
  match.participants[index] = replacement;
  assertParticipants(match.participants, match.participants.length);
  return replacement;
}

export function assertParticipants(participants, maxPlayers = MAX_PLAYERS) {
  if (!Array.isArray(participants)) throw new Error('[MATCH] participants must be an array');
  maxPlayers = Number.isFinite(maxPlayers) ? Math.min(MAX_PLAYERS, Math.floor(maxPlayers)) : MAX_PLAYERS;
  if (participants.length > maxPlayers) throw new Error(`[MATCH] ${participants.length} participants exceeds ${maxPlayers}`);
  for (const team of ['red', 'blue']) {
    if (participants.filter(p => p?.team === team).length > MAX_TEAM_SIZE) throw new Error('[MATCH] team capacity exceeded');
  }
  const ids = new Set();
  const users = new Set();
  for (const participant of participants) {
    if (!participant?.participantId || ids.has(participant.participantId)) throw new Error('[MATCH] duplicate or missing participantId');
    ids.add(participant.participantId);
    if (!Number.isInteger(participant.spawnIndex) || participant.spawnIndex < 0) throw new Error(`[MATCH] invalid spawnIndex for ${participant.participantId}`);
    if (!validDisplayName(participant.displayName)) throw new Error(`[MATCH] invalid displayName for ${participant.participantId}`);
    if (!participant.characterId) throw new Error(`[MATCH] missing characterId for ${participant.participantId}`);
    if (participant.type === ParticipantType.HUMAN) {
      if (!participant.userId || users.has(participant.userId)) throw new Error('[MATCH] HUMAN requires a unique userId');
      users.add(participant.userId);
      if (participant.botId) throw new Error('[MATCH] HUMAN cannot have botId');
    } else if (participant.type === ParticipantType.BOT) {
      if (!participant.botId) throw new Error('[MATCH] BOT requires botId');
    } else {
      throw new Error(`[MATCH] invalid participant type ${participant.type}`);
    }
  }
  return true;
}

function assignTeam(index, modeId) {
  if (modeId === 'ffa') return 'free';
  return index % 2 === 0 ? 'red' : 'blue';
}

export function finalizeMatchmakingSession(session, roomConfig, { now = Date.now(), botsEnabled = true, botTeams = null } = {}) {
  if (session.status !== MatchmakingStatus.WAITING) return session.match ?? null;
  session.status = MatchmakingStatus.STARTING;
  if (session.timer) clearTimeout(session.timer);

  const maxPlayers = Math.min(MAX_PLAYERS, Math.max(1, Number(session.maxPlayers) || 1));
  const humans = [...session.players.values()];
  if (humans.length > maxPlayers) throw new Error('[MATCH] human count exceeds capacity');
  const matchId = makeId('match');
  const participants = humans.map((human, index) => {
    const displayName = validDisplayName(human.displayName);
    if (!human.userId || !displayName) throw new Error(`[MATCH] invalid queued human ${human.userId || '(missing userId)'}`);
    return {
      participantId: `human:${human.userId}`,
      type: ParticipantType.HUMAN,
      userId: human.userId,
      displayName,
      characterId: human.characterId || 'capivara',
      spawnIndex: index,
      connected: true,
      team: human.team || assignTeam(index, roomConfig.modeId),
      cos: { ...(human.cos || {}) },
    };
  });

  if (botsEnabled) {
    const requestedTeams = Array.isArray(botTeams)
      ? botTeams.slice(0, Math.max(0, maxPlayers - participants.length))
      : Array.from({ length: maxPlayers - participants.length }, (_, offset) => assignTeam(participants.length + offset, roomConfig.modeId));
    for (const requestedTeam of requestedTeams) {
      const index = participants.length;
      const botId = `${matchId}:${index}`;
      participants.push({
        participantId: `bot:${botId}`,
        type: ParticipantType.BOT,
        botId,
        displayName: BOT_NAMES[index % BOT_NAMES.length],
        characterId: 'capivara',
        spawnIndex: index,
        connected: true,
        team: roomConfig.modeId === 'ffa' ? 'free' : (requestedTeam === 'blue' ? 'blue' : 'red'),
        cos: randomCos(),
      });
    }
  }

  for (const participant of participants) participant.matchId = matchId;

  assertParticipants(participants, maxPlayers);
  const mapId = roomConfig.levelId;
  const mapSeed = String(mapId).startsWith('procedural:') ? String(mapId).split(':')[1] : null;
  const match = {
    id: matchId,
    roomId: `match:${matchId}`,
    status: 'LOADING',
    mode: roomConfig.modeId,
    ranked: !!roomConfig.config?.rules?.ranked,
    mapId,
    mapSeed,
    participants,
    createdAt: now,
  };
  session.match = match;
  session.status = MatchmakingStatus.STARTED;
  return match;
}

export function createMatchmakingSession({ id, queueKey, mode, ranked, maxPlayers, createdAt = Date.now() }) {
  return {
    id, queueKey, mode, ranked, status: MatchmakingStatus.WAITING,
    createdAt, deadlineAt: createdAt + MATCHMAKING_TIMEOUT,
    players: new Map(), maxPlayers: Number.isFinite(maxPlayers) ? Math.min(MAX_PLAYERS, Math.max(1, Math.floor(maxPlayers))) : MAX_PLAYERS, timer: null, match: null,
  };
}
