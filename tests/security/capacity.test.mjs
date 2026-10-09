import assert from 'node:assert/strict';
import test from 'node:test';
import { GameHost } from '../../src/game/host.js';
import { createMatchmakingSession, finalizeMatchmakingSession, assertParticipants } from '../../src/game/matchmaking.js';
import { MAX_TEAM_SIZE, MAX_PLAYERS, clampTeamSize, clampPlayerCount, assertRoomCapacity, isRoomWithinCapacity } from '../../src/game/capacity.js';
import * as rooms from '../../src/net/rooms.js';

const validRoom = { ok: true, code: 'capacity', modeId: 'ctf', maxPlayers: 6, teamLimits: { red: 3, blue: 3 } };
const invalidRooms = [
  { modeId: 'ctf', maxPlayers: 20, teamLimits: { red: 10, blue: 10 } },
  { modeId: 'ctf', maxPlayers: 6, teamLimits: { red: 4, blue: 2 } },
  { modeId: 'ffa', maxPlayers: 7, teamLimits: { ffa: 7 } },
  { modeId: 'ctf', maxPlayers: 7, teamLimits: { red: 3, blue: 3 } },
  { modeId: 'ctf', maxPlayers: 4, teamLimits: { red: 1.5, blue: 2.5 } },
  { modeId: 'ffa', maxPlayers: 1, teamLimits: { ffa: 1 } },
  {}, null,
];

test('capacity clamps values and invalid fallbacks to 3 per team and 6 total', () => {
  assert.equal(MAX_TEAM_SIZE, 3); assert.equal(MAX_PLAYERS, 6);
  assert.equal(clampTeamSize(10), 3); assert.equal(clampPlayerCount(20), 6);
  assert.equal(clampTeamSize(NaN, 99), 3); assert.equal(clampPlayerCount(Infinity, 99), 6);
  assert.equal(clampTeamSize(-1), 1); assert.equal(clampPlayerCount(-1), 2);
  assert.equal(clampTeamSize(2.9), 2); assert.equal(clampPlayerCount(5.9), 5);
});

test('legacy oversized local selections cap at 3v3, including bot and human admissions', () => {
  const host = new GameHost({ teamSize: 10, teamLimits: { red: 10, blue: 10 } });
  host.fillBots();
  assert.equal(host.sim.state.players.length, 6);
  assert.equal(host.teamCount('red'), 3); assert.equal(host.teamCount('blue'), 3);
  assert.throws(() => host.addBot('red'), /full/);
  for (let i = 0; i < 6; i++) host.addHuman({ name: `Human${i}`, userId: `user-${i}`, team: i < 3 ? 'red' : 'blue' });
  assert.equal(host.sim.state.players.length, 6);
  assert.equal(host.brains.size, 0);
  assert.throws(() => host.addHuman({ name: 'Extra', team: 'red' }), /full/);
  assert.throws(() => host.addHuman({ name: 'Extra' }), /full/);
  assert.equal(host.sim.state.players.length, 6);
});

test('asymmetric teams preserve smaller limits and free-for-all caps at six', () => {
  const host = new GameHost({ teamLimits: { red: 2, blue: 8 } });
  host.fillBots();
  assert.equal(host.teamCount('red'), 2); assert.equal(host.teamCount('blue'), 3);
  const ffa = new GameHost({ modeId: 'ffa', teamLimits: { ffa: 20 } });
  ffa.fillBots(); assert.equal(ffa.sim.state.players.length, 6);
  assert.throws(() => ffa.addBot('free'), /full/);
  for (let i = 0; i < 6; i++) ffa.addHuman({ name: `Solo${i}` });
  assert.throws(() => ffa.addHuman({ name: 'Extra' }), /full/);
  assert.equal(ffa.sim.state.players.length, 6);
});

test('matchmaking rejects extra humans and roster imports cannot bypass the team cap', () => {
  const session = createMatchmakingSession({ maxPlayers: 20 });
  assert.equal(session.maxPlayers, 6);
  for (let i = 0; i < 7; i++) session.players.set(i, { userId: `u${i}`, displayName: `Human${i}` });
  assert.throws(() => finalizeMatchmakingSession(session, { modeId: 'ctf', levelId: 'dojo' }), /capacity/);
  const valid = finalizeMatchmakingSession(createMatchmakingSession({ maxPlayers: 20 }), { modeId: 'ctf', levelId: 'dojo' });
  assert.equal(valid.participants.length, 6);
  const unbalanced = valid.participants.map((p, i) => ({ ...p, team: i < 4 ? 'red' : 'blue' }));
  assert.throws(() => assertParticipants(unbalanced, 20), /team capacity/);
  assert.throws(() => new GameHost({ teamSize: 5, participants: unbalanced }), /team capacity/);
  const host = new GameHost({ teamSize: 5, participants: valid.participants });
  const checkpoint = host.exportAuthorityState();
  checkpoint.state.players.forEach((p, i) => { p.team = i < 4 ? 'red' : 'blue'; });
  assert.throws(() => host.restoreAuthorityState(checkpoint), /team capacity/);
  assert.equal(host.teamCount('red'), 3); assert.equal(host.teamCount('blue'), 3);
  checkpoint.state.players.forEach(player => { player.team = 'toString'; });
  assert.throws(() => host.restoreAuthorityState(checkpoint), /invalid participant team/);
  checkpoint.state.players.push({ team: 'toString' });
  assert.throws(() => host.restoreAuthorityState(checkpoint), /roster capacity/);
});

test('remote room capacity must be bounded, integral and consistent with its team limits', () => {
  assert.equal(isRoomWithinCapacity(validRoom), true);
  assert.equal(isRoomWithinCapacity({ modeId: 'ffa', maxPlayers: 6, teamLimits: { ffa: 6 } }), true);
  for (const room of invalidRooms) {
    assert.equal(isRoomWithinCapacity(room), false);
    assert.throws(() => assertRoomCapacity(room), /Capacidade inválida/);
  }
});

test('room RPC clients cap requests, hide invalid rooms and refuse oversized create or join responses', async t => {
  const previousStorage = globalThis.localStorage;
  globalThis.localStorage = { getItem: () => JSON.stringify({ access_token: 'fixture-only', expires_at: Date.now() / 1000 + 3600 }) };
  let response = { ok: true, code: validRoom.code, room: validRoom };
  let request;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    request = { url, body: JSON.parse(options.body) };
    return { ok: true, status: 200, json: async () => structuredClone(response) };
  });
  try {
    await rooms.createRoom({ modeId: 'ctf', redSize: 100, blueSize: 100, ffaSize: 100 });
    assert.equal(request.body.p_red_size, 3); assert.equal(request.body.p_blue_size, 3); assert.equal(request.body.p_ffa_size, 6);
    response = [validRoom, ...invalidRooms];
    assert.deepEqual(await rooms.listRooms(), [validRoom]);
    response = { ok: true, room: invalidRooms[1] };
    await assert.rejects(rooms.createRoom({ modeId: 'ctf' }), /Capacidade inválida/);
    response = { ...invalidRooms[1], ok: true };
    await assert.rejects(rooms.joinRoom('oversized'), /Capacidade inválida/);
    if (rooms.claimQueue) {
      response = { ok: true, code: validRoom.code, room: validRoom };
      await rooms.claimQueue({ redSize: 100, blueSize: 100, ffaSize: 100 });
      assert.deepEqual(request.body.p_options, { redSize: 3, blueSize: 3, ffaSize: 6 });
    } else {
      response = { ...validRoom }; delete response.maxPlayers;
      assert.equal((await rooms.joinRoom('legacy-shape')).maxPlayers, 6);
    }
  } finally { globalThis.localStorage = previousStorage; }
});
