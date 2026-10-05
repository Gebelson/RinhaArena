import assert from 'node:assert/strict';
import test from 'node:test';
import { createSim, addPlayer, damagePlayer, resetRound, step } from './src/game/sim.js';
import { CONFIG } from './src/core/config.js';
import { LEVELS } from './src/content/levels/index.js';
import { CtfMode } from './src/game/modes/ctf.js';
import { DeathMatchMode } from './src/game/modes/deathmatch.js';
import { FfaMode } from './src/game/modes/ffa.js';
import { packState } from './src/net/protocol.js';
import { GameHost } from './src/game/host.js';

const zeroStats = { eliminations: 0, deaths: 0, captures: 0, returns: 0 };
function fixture(mode = CtfMode) {
  const config = structuredClone(CONFIG);
  Object.assign(config.rules, { captureLimit: 99, killsToWin: 99, ffaKillsToWin: 99 });
  const sim = createSim({ level: structuredClone(LEVELS.skyhaven), mode: { ...mode }, config });
  addPlayer(sim, { name: 'Red', team: 'red' });
  addPlayer(sim, { name: 'Blue', team: mode.id === 'ffa' ? 'free' : 'blue' });
  addPlayer(sim, { name: 'Ally', team: 'red' });
  sim.state.phase = 'play';
  for (const p of sim.state.players) p.invuln = 0;
  return { sim, red: sim.state.players[0], blue: sim.state.players[1], ally: sim.state.players[2] };
}

test('KO stats credit enemy eliminations once, survive respawn and packing, reset each round', () => {
  for (const mode of [CtfMode, DeathMatchMode, FfaMode]) {
    const { sim, red, blue, ally } = fixture(mode);
    damagePlayer(sim, blue, 40, 0, 0, 0, 'punch', red.id);
    assert.deepEqual(blue.stats, zeroStats, 'nonlethal knockdown is not a death');
    damagePlayer(sim, blue, 999, 0, 0, 0, 'bomb', red.id);
    damagePlayer(sim, blue, 999, 0, 0, 0, 'bomb', red.id);
    assert.equal(red.stats.eliminations, 1);
    assert.equal(blue.stats.deaths, 1);
    const packed = packState(sim.state);
    assert.deepEqual(packed.players[0].stats, red.stats);
    assert.equal(packed.mapId, sim.level.id);
    assert.equal(packed.rules.captureLimit, 99);
    blue.respawn = 0;
    step(sim, new Map(), 1 / 60);
    assert.equal(blue.state, 'alive');
    assert.equal(blue.stats.deaths, 1);
    damagePlayer(sim, ally, 999, 0, 0, 0, 'bomb', red.id);
    assert.equal(red.stats.eliminations, mode.id === 'ffa' ? 2 : 1, 'friendly kill only counts in FFA');
    assert.equal(ally.stats.deaths, 1);
    damagePlayer(sim, red, 999, 0, 0, 0, 'bomb', red.id);
    assert.equal(red.stats.deaths, 1);
    assert.equal(red.stats.eliminations, mode.id === 'ffa' ? 2 : 1, 'self elimination gives no credit');
    assert.equal(packed.players[0].stats.eliminations, 1, 'packed stats are detached from live stats');
    resetRound(sim);
    for (const p of sim.state.players) assert.deepEqual(p.stats, zeroStats);
  }
});

test('environment deaths use recent hit credit; completed rounds do not add stats', () => {
  const { sim, red, blue, ally } = fixture();
  damagePlayer(sim, blue, 1, 0, 0, 0, 'punch', red.id);
  blue.x = sim.level.bounds.w;
  blue.y = sim.config.world.fallY - 1;
  step(sim, new Map(), 1 / 60);
  assert.equal(red.stats.eliminations, 1, 'shove into void credits the attacker');
  assert.equal(blue.stats.deaths, 1);
  ally.lastHitBy = red.id;
  ally.lastHitByT = 0;
  damagePlayer(sim, ally, 999, 0, 0, 0, 'impact');
  assert.equal(ally.stats.deaths, 1);
  assert.equal(red.stats.eliminations, 1);
  sim.state.phase = 'over';
  damagePlayer(sim, red, 999, 0, 0, 0, 'bomb');
  assert.equal(red.stats.deaths, 0);
});

test('CTF captures include thrown relays; only player touch returns receive credit', () => {
  const { sim, red } = fixture();
  const blueFlag = sim.state.flags.blue;
  Object.assign(red, { x: blueFlag.x, z: blueFlag.z });
  assert.equal(sim.mode.tryGrab(sim, red), true);
  Object.assign(red, sim.level.bases.red);
  sim.mode.tickFlag(sim, blueFlag, 1 / 60);
  assert.equal(red.stats.captures, 1);
  assert.equal(sim.state.scores.red, 1);
  Object.assign(red, { x: blueFlag.x, z: blueFlag.z });
  assert.equal(sim.mode.tryGrab(sim, red), true);
  sim.mode.throwCarried(sim, red, { x: 0, z: 1 }, { vx: 0, vz: 0, vy: 0 });
  Object.assign(blueFlag, { x: sim.level.bases.red.x, z: sim.level.bases.red.z, y: 0, vx: 0, vz: 0, vy: 0 });
  sim.mode.tickFlag(sim, blueFlag, 1 / 60);
  assert.equal(red.stats.captures, 2);
  assert.equal(sim.state.scores.red, 2);
  const redFlag = sim.state.flags.red;
  Object.assign(red, { x: 0, z: 0 });
  Object.assign(redFlag, { st: 'drop', x: 0, z: 0, idle: 0 });
  sim.mode.tickFlag(sim, redFlag, 1 / 60);
  assert.equal(redFlag.st, 'home');
  assert.equal(red.stats.returns, 1);
  sim.mode.tickFlag(sim, redFlag, 1 / 60);
  assert.equal(red.stats.returns, 1);
  Object.assign(redFlag, { st: 'drop', idle: sim.config.flag.idleReturn });
  sim.mode.tickFlag(sim, redFlag, 1 / 60);
  assert.equal(red.stats.returns, 1, 'automatic return earns no player credit');
  const packed = packState(sim.state);
  assert.equal(packed.players[0].stats.captures, 2);
  assert.equal(packed.players[0].stats.returns, 1);
  resetRound(sim);
  assert.deepEqual(red.stats, zeroStats);
});

test('authority restore upgrades legacy saves and retains current scoreboard stats', () => {
  const { sim } = fixture();
  const saved = { state: structuredClone(sim.state) };
  delete saved.state.mapId;
  delete saved.state.rules;
  for (const p of saved.state.players) delete p.stats;
  const host = new GameHost({ levelId: 'skyhaven', modeId: 'ctf', config: sim.config });
  assert.equal(host.restoreAuthorityState(saved), true);
  assert.equal(host.sim.state.mapId, sim.level.id);
  assert.deepEqual(host.sim.state.rules, sim.state.rules);
  for (const p of host.sim.state.players) assert.deepEqual(p.stats, zeroStats);
  const [red, blue] = host.sim.state.players;
  damagePlayer(host.sim, blue, 999, 0, 0, 0, 'bomb', red.id);
  assert.equal(red.stats.eliminations, 1);
  assert.equal(blue.stats.deaths, 1);
  assert.equal(saved.state.players[0].stats, undefined, 'restore leaves saved snapshot untouched');
  red.stats.captures = 2;
  red.stats.returns = 3;
  host.sim.state.rules.captureLimit = 15;
  const current = host.exportAuthorityState();
  const restored = new GameHost({ levelId: 'skyhaven', modeId: 'ctf' });
  assert.equal(restored.restoreAuthorityState(current), true);
  assert.deepEqual(restored.sim.state.players[0].stats, red.stats);
  assert.deepEqual(restored.sim.state.players[1].stats, blue.stats);
  assert.equal(restored.sim.state.rules.captureLimit, 15);
  restored.sim.state.players[0].stats.eliminations++;
  assert.equal(current.state.players[0].stats.eliminations, 1, 'restored counters are detached');
});
