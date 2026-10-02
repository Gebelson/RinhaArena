import assert from 'node:assert/strict';
import { GameHost } from './src/game/host.js';
import {
  createMatchmakingSession, finalizeMatchmakingSession, MatchmakingStatus,
  ParticipantType, assertParticipants, replaceHumanParticipantWithBot, validDisplayName,
} from './src/game/matchmaking.js';

const room = {
  levelId: 'procedural:238472', modeId: 'ctf', teamLimits: { red: 10, blue: 10 },
  config: { rules: { ranked: true, botDifficulty: 'medium' } },
};
const human = (id, name) => ({
  userId: id, displayName: name, characterId: 'capivara', cos: { hat: 'none', skin: '#ffd29c' }, connected: true,
});
const session = (count, maxPlayers = 20) => {
  const value = createMatchmakingSession({ id: 'session-a', queueKey: 'ctf:ranked', mode: 'ctf', ranked: true, maxPlayers, createdAt: 0 });
  for (let index = 0; index < count; index += 1) value.players.set(`u${index}`, human(`u${index}`, `Capy${index}`));
  return value;
};

// 1, 3, 4: exact human + bot total, no placeholders or extra entities.
for (const humans of [1, 2, 3]) {
  const queued = session(humans);
  assert.equal(queued.deadlineAt, 30_000);
  const match = finalizeMatchmakingSession(queued, room, { now: 30_000 });
  assert.equal(match.participants.length, 20);
  assert.equal(match.participants.filter((p) => p.type === ParticipantType.HUMAN).length, humans);
  assert.equal(match.participants.filter((p) => p.type === ParticipantType.BOT).length, 20 - humans);
  assert.equal(new Set(match.participants.map((p) => p.participantId)).size, 20);
  assert(!match.participants.some((p) => /^player(?:\s*\d+)?$/i.test(p.displayName)));
  const host = new GameHost({ levelId: match.mapId, modeId: match.mode, teamLimits: room.teamLimits, participants: match.participants });
  assert.equal(host.sim.state.players.length, match.participants.length);
  assert.equal(host.brains.size, 20 - humans);
  assert(host.sim.state.players.every((entity) => entity.participantId && entity.matchId === match.id));
}

// A human who leaves after MATCH_FOUND is replaced in the same spawn slot by a valid AI participant.
{
  const match = finalizeMatchmakingSession(session(2), room, { now: 30_000 });
  const departed = match.participants.find((participant) => participant.userId === 'u1');
  const replacement = replaceHumanParticipantWithBot(match, 'u1');
  assert.equal(replacement.type, ParticipantType.BOT);
  assert.equal(replacement.spawnIndex, departed.spawnIndex);
  assert.equal(match.participants.length, 20);
  assert.equal(match.participants.filter((participant) => participant.type === ParticipantType.HUMAN).length, 1);
  const host = new GameHost({ levelId: match.mapId, modeId: match.mode, teamLimits: room.teamLimits, participants: match.participants });
  assert.equal(host.sim.state.players.length, 20);
  assert.equal(host.brains.size, 19);
}

// 2, 14, 15: one finalized payload is idempotent and carries one map/seed/list.
const shared = session(2);
const first = finalizeMatchmakingSession(shared, room, { now: 30_000 });
const second = finalizeMatchmakingSession(shared, room, { now: 30_001 });
assert.strictEqual(first, second);
assert.equal(shared.status, MatchmakingStatus.STARTED);
assert.equal(first.mapId, 'procedural:238472');
assert.equal(first.mapSeed, '238472');
assert.deepEqual(structuredClone(first.participants), structuredClone(second.participants));

// 5, 6: invalid human identities are rejected instead of becoming characters.
assert.equal(validDisplayName('Player'), null);
assert.equal(validDisplayName(' Player 2 '), null);
assert.throws(() => {
  const invalid = session(0);
  invalid.players.set('bad', human('bad', 'Player'));
  finalizeMatchmakingSession(invalid, room);
}, /invalid queued human/);

// 7, 8: bots have identity + controllers; with bots disabled only humans spawn.
const humansOnlySession = session(2);
const humansOnly = finalizeMatchmakingSession(humansOnlySession, room, { botsEnabled: false });
assert.equal(humansOnly.participants.length, 2);
assert(humansOnly.participants.every((p) => p.type === ParticipantType.HUMAN));
const humansOnlyHost = new GameHost({ levelId: humansOnly.mapId, modeId: humansOnly.mode, teamLimits: room.teamLimits, participants: humansOnly.participants });
assert.equal(humansOnlyHost.sim.state.players.length, 2);
assert.equal(humansOnlyHost.brains.size, 0);

// Inactive/disconnected humans keep their identity while AI controls them temporarily.
{
  const host = new GameHost({ levelId: humansOnly.mapId, modeId: humansOnly.mode, teamLimits: room.teamLimits, participants: humansOnly.participants });
  const id = humansOnly.participants[0].participantId;
  host.humanLastActive.set(id, Date.now() - 30_001);
  host.step(1 / 60);
  assert(host.temporaryBrains.has(id));
  assert.equal(host.sim.state.players.find((player) => player.id === id).type, ParticipantType.HUMAN);
  host.setInput(id, { mx: 1, mz: 0 });
  assert(!host.temporaryBrains.has(id));
  host.disconnectHuman(id);
  assert(host.temporaryBrains.has(id));
  host.reconnectHuman(id);
  assert(!host.temporaryBrains.has(id));
}

// Permanent abandonment replaces exactly one entity in place and is idempotent.
{
  const host = new GameHost({ levelId: humansOnly.mapId, modeId: humansOnly.mode, teamLimits: room.teamLimits, participants: humansOnly.participants });
  const id = humansOnly.participants[0].participantId;
  const before = host.sim.state.players.length;
  const replacement = host.replaceHumanWithBotInPlace(id, 'u0');
  assert.equal(host.sim.state.players.length, before);
  assert.equal(replacement.type, ParticipantType.BOT);
  assert.equal(replacement.replacementForPlayerId, 'u0');
  assert(host.brains.has(id));
  assert.equal(host.replaceHumanWithBotInPlace(id, 'u0'), null);
  assert.equal(host.sim.state.players.length, before);
}

// Invariant failures.
assert.throws(() => assertParticipants([{ participantId: 'x' }, { participantId: 'x' }]), /spawnIndex|displayName|duplicate/);

console.log('MATCHMAKING INVARIANTS OK');
