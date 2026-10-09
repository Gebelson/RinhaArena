import { GameHost } from '../src/game/host.js';
import { packState } from '../src/net/protocol.js';
import { circlePushOut } from '../src/core/math.js';

const assert = (ok, message) => { if (!ok) throw new Error(message); };

const host = new GameHost({ levelId: 'feira_suspensa', modeId: 'ctf', teamSize: 3 });
host.fillBots();
const sim = host.sim;
assert(sim.state.players.length === 6, '3v3 did not create 6 players');
assert(sim.level.spawns.red.length === 10 && sim.level.spawns.blue.length === 10, 'spawn count');
assert(sim.level.jumpPads.length === 4, 'jump-pad count');
assert(sim.state.interactives.length === 5, 'interactive count');
assert(sim.level.botRoutes.length === 3, 'three traversal routes');
for (const team of ['red', 'blue']) for (const spawn of sim.level.spawns[team]) {
  assert(!sim.level.solids.some((solid) => circlePushOut(spawn.x, spawn.z, 0.72, solid)), `${team} spawn intersects collision`);
}

const duo = new GameHost({ levelId: 'feira_suspensa', modeId: 'ctf', teamSize: 1 });
duo.addHuman({ name: 'Human A', team: 'red', cos: {} });
duo.addHuman({ name: 'Human B', team: 'blue', cos: {} });
assert(duo.sim.state.players.filter((p) => !p.bot).length === 2, 'two-human match setup failed');
for (let i = 0; i < 240; i++) duo.step(1 / 60);

sim.state.phase = 'play';
const wall = sim.state.interactives.find((o) => o.id === 'wall_n');
const cart = sim.state.interactives.find((o) => o.id === 'food_cart');
const wallStart = wall.x, cartStart = cart.x;
for (let i = 0; i < 180; i++) host.step(1 / 60);
assert(Math.abs(wall.x - wallStart) > 0.5, 'sliding wall did not move');
assert(Math.abs(cart.x - cartStart) > 0.5, 'food cart did not move');

const jumper = sim.state.players[0];
const pad = sim.level.jumpPads[0];
jumper.x = pad.x; jumper.z = pad.z; jumper.y = 0; jumper.vx = jumper.vz = jumper.vy = 0;
host.step(1 / 60);
assert(jumper.vy > 5 && Math.hypot(jumper.vx, jumper.vz) > 8, 'jump pad did not launch');

// Exercise the existing CTF implementation on this level: steal, score,
// drop and return. This verifies the map uses the shared mode rather than a fork.
const carrier = sim.state.players.find((p) => p.team === 'red');
const blueFlag = sim.state.flags.blue;
carrier.x = blueFlag.x; carrier.z = blueFlag.z; carrier.y = 0;
assert(sim.mode.tryGrab(sim, carrier), 'flag steal failed');
carrier.x = sim.level.bases.red.x; carrier.z = sim.level.bases.red.z;
sim.mode.tick(sim, 1 / 60);
assert(sim.state.scores.red === 1, 'flag score failed');

carrier.x = blueFlag.x; carrier.z = blueFlag.z;
assert(sim.mode.tryGrab(sim, carrier), 'second steal failed');
sim.mode.dropCarried(sim, carrier, 0, 0);
assert(blueFlag.st === 'drop', 'flag drop failed');
const blue = sim.state.players.find((p) => p.team === 'blue');
blue.x = blueFlag.x; blue.z = blueFlag.z;
blueFlag.cd = 0;
sim.mode.tick(sim, 1 / 60);
assert(blueFlag.st === 'home', 'flag return failed');

const wire = packState(sim.state);
assert(wire.interactives.length === 5, 'interactives missing from network snapshot');
assert(JSON.stringify(wire).length < 30000, '3v3 snapshot is unexpectedly large');

// Bot traversal smoke: all three assigned lane groups must move away from base.
const traversalHost = new GameHost({ levelId: 'feira_suspensa', modeId: 'ctf', teamSize: 3 });
traversalHost.fillBots();
traversalHost.sim.state.phase = 'play';
const visited = new Set();
const started = performance.now();
for (let i = 0; i < 60 * 25; i++) {
  traversalHost.step(1 / 60);
  for (const player of traversalHost.sim.state.players) if (Math.abs(player.x) < 23) visited.add(player.id);
}
const elapsed = performance.now() - started;
const advanced = visited.size;
assert(advanced >= Math.ceil(sim.state.players.length * 0.6), 'bots did not traverse the arena');
assert(elapsed < 5000, `3v3 simulation performance regression: ${elapsed.toFixed(0)}ms`);
console.log('FEIRA SUSPENSA OK', { players: sim.state.players.length, humans: 2, advanced, snapshotBytes: JSON.stringify(wire).length, sim25sMs: Math.round(elapsed) });
