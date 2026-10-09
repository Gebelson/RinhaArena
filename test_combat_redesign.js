import fs from 'node:fs';
import path from 'node:path';
import { createSim, addPlayer, grantPowerup, step, damagePlayer } from './src/game/sim.js';
import { CONFIG } from './src/core/config.js';
import { LEVELS } from './src/content/levels/index.js';
import { CtfMode } from './src/game/modes/ctf.js';
import { FfaMode } from './src/game/modes/ffa.js';
import { GameHost } from './src/game/host.js';
import { createSfx } from './src/audio/sfx.js';

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`  ✅ PASS: ${message}`);
    passed++;
  } else {
    console.error(`  ❌ FAIL: ${message}`);
    failed++;
  }
}

console.log('--- TEST 1: Empty-handed throw does NOT spawn bombs ---');
{
  const sim = createSim({ level: LEVELS.skyhaven, mode: CtfMode, config: CONFIG });
  const p1 = addPlayer(sim, { name: 'Capivara 1', team: 'red' });
  sim.state.phase = 'play';
  const player = sim.state.players.find(p => p.id === p1);

  // Send throw input with empty hands
  const inputs = new Map();
  inputs.set(p1, { mx: 0, mz: 0, ax: 1, az: 0, ad: 7, run: 1, throw: true, grab: false, punch: false, jump: false, dash: false });
  step(sim,inputs, 1 / 30);

  assert(player.heldBomb === null, 'Player does not hold any bomb');
  assert(sim.state.bombs.length === 0, 'No bombs exist in simulation state after throw');
}

console.log('\n--- TEST 2: Collecting bomb powerup box equips lit bomb in hands ---');
{
  const sim = createSim({ level: LEVELS.skyhaven, mode: CtfMode, config: CONFIG });
  const p1 = addPlayer(sim, { name: 'Capivara 1', team: 'red' });
  sim.state.phase = 'play';
  const player = sim.state.players.find(p => p.id === p1);

  grantPowerup(sim, player, 'bomb');
  assert(player.heldBomb !== null, 'Player holds bomb after walking over bomb box');
  assert(sim.state.bombs.length === 1, 'Bomb created in sim');
  const b = sim.state.bombs[0];
  assert(b.holder === p1, 'Bomb holder is player');
  assert(b.fuse === 3.0, 'Bomb fuse is lit and burning at 3.0s');
}

console.log('\n--- TEST 3: LMB (punch) throws held bomb when holding a bomb ---');
{
  const sim = createSim({ level: LEVELS.skyhaven, mode: CtfMode, config: CONFIG });
  const p1 = addPlayer(sim, { name: 'Capivara 1', team: 'red' });
  sim.state.phase = 'play';
  const player = sim.state.players.find(p => p.id === p1);

  grantPowerup(sim, player, 'bomb');
  assert(player.heldBomb !== null, 'Player holds bomb');

  // Next frame: user clicks LMB (punch: true)
  const inputs = new Map();
  inputs.set(p1, { mx: 0, mz: 0, ax: 1, az: 0, ad: 7, run: 1, throw: false, grab: false, punch: true, jump: false, dash: false });
  step(sim,inputs, 1 / 30);

  assert(player.heldBomb === null, 'Bomb was thrown and released from hands on LMB punch');
  const b = sim.state.bombs[0];
  assert(b.holder === null, 'Bomb is now airborne with no holder');
  assert(b.vx > 1, `Bomb received forward velocity (vx = ${b.vx.toFixed(2)})`);
}

console.log('\n--- TEST 4: RMB (grab) does NOT pick up loose bombs from ground ---');
{
  const sim = createSim({ level: LEVELS.skyhaven, mode: CtfMode, config: CONFIG });
  const p1 = addPlayer(sim, { name: 'Capivara 1', team: 'red' });
  sim.state.phase = 'play';
  const player = sim.state.players.find(p => p.id === p1);

  // Place a loose bomb right at player feet
  const bombId = 'b_test';
  sim.state.bombs.push({
    id: bombId,
    kind: 'normal',
    x: player.x, z: player.z, y: 0.5,
    vx: 0, vz: 0, vy: 0,
    fuse: 2.5,
    arm: 0,
    holder: null,
    owner: 'someone_else',
    stuckTo: null,
  });

  // Player presses grab (RMB) near the bomb
  const inputs = new Map();
  inputs.set(p1, { mx: 0, mz: 0, ax: 0, az: 0, ad: 7, run: 1, throw: false, grab: true, punch: false, jump: false, dash: false });
  step(sim,inputs, 1 / 30);

  assert(player.heldBomb === null, 'Player did NOT pick up the loose bomb');
  const b = sim.state.bombs.find(b => b.id === bombId);
  assert(b.holder === null, 'Loose bomb remains unheld on the ground');
}

console.log('\n--- TEST 5: RMB (grab) DOES grab nearby players ---');
{
  const sim = createSim({ level: LEVELS.skyhaven, mode: CtfMode, config: CONFIG });
  const p1 = addPlayer(sim, { name: 'Capivara 1', team: 'red' });
  const p2 = addPlayer(sim, { name: 'Capivara 2', team: 'blue' });
  sim.state.phase = 'play';
  const player1 = sim.state.players.find(p => p.id === p1);
  const player2 = sim.state.players.find(p => p.id === p2);

  // Position player 2 right in front of player 1 and remove invulnerability
  player2.x = player1.x + 0.5;
  player2.z = player1.z;
  player2.y = 0;
  player2.invuln = 0;

  const inputs = new Map();
  inputs.set(p1, { mx: 0, mz: 0, ax: 1, az: 0, ad: 7, run: 1, throw: false, grab: true, punch: false, jump: false, dash: false });
  step(sim,inputs, 1 / 30);

  assert(player1.heldPlayer === p2, 'Player 1 grabbed Player 2');
  assert(player2.heldBy === p1, 'Player 2 is held by Player 1');
}

console.log('\n--- TEST 6: Dash mechanic (impulse & cooldown) ---');
{
  const sim = createSim({ level: LEVELS.skyhaven, mode: CtfMode, config: CONFIG });
  const p1 = addPlayer(sim, { name: 'Capivara 1', team: 'red' });
  sim.state.phase = 'play';
  const player = sim.state.players.find(p => p.id === p1);

  assert(player.dashCd === 0, 'Initial dashCd is 0');

  // Trigger dash moving towards +x
  const inputs = new Map();
  inputs.set(p1, { mx: 1, mz: 0, ax: 0, az: 0, ad: 7, run: 1, throw: false, grab: false, punch: false, jump: false, dash: true });
  step(sim,inputs, 1 / 30);

  assert(player.vx >= 15, `Player received high dash impulse: vx=${player.vx.toFixed(2)}`);
  assert(player.dashCd > 1.4, `Player dash cooldown active: dashCd=${player.dashCd.toFixed(2)}`);

  // Try to dash again in next tick - should be blocked by cooldown
  const prevVx = player.vx;
  inputs.set(p1, { mx: -1, mz: 0, ax: 0, az: 0, ad: 7, run: 1, throw: false, grab: false, punch: false, jump: false, dash: true });
  step(sim,inputs, 1 / 30);

  assert(player.dashCd > 1.2, 'Dash cooldown still counting down');
}

console.log('\n--- TEST 7: Bot simulation - no spontaneous bombs ---');
{
  const sim = createSim({ level: LEVELS.skyhaven, mode: CtfMode, config: CONFIG });
  addPlayer(sim, { name: 'Bot Red', team: 'red', bot: true });
  addPlayer(sim, { name: 'Bot Blue', team: 'blue', bot: true });
  sim.state.phase = 'play';

  // Prevent powerup boxes from spawning bombs during this test to verify bot behavior in isolation
  sim.state.puWave = 9999;
  sim.state.powerups = [];

  for (let t = 0; t < 150; t++) {
    const inputs = new Map();
    step(sim, inputs, 1 / 30);
  }

  assert(sim.state.bombs.length === 0, 'Zero bombs spawned spontaneously across 150 ticks');
}

console.log('\n--- TEST 8: Bomb explosion pushes players in range far away ---');
{
  const sim = createSim({ level: LEVELS.skyhaven, mode: CtfMode, config: CONFIG });
  const p1 = addPlayer(sim, { name: 'Capivara 1', team: 'red' });
  sim.state.phase = 'play';
  const player = sim.state.players.find(p => p.id === p1);
  player.x = 0;
  player.z = 0;
  player.y = 0;
  player.vx = 0;
  player.vz = 0;
  player.invuln = 0;

  // Place a bomb at x = 1.5, z = 0, with fuse expiring next tick
  sim.state.bombs.push({
    id: 'b_boom',
    kind: 'normal',
    x: 1.5, z: 0, y: 0.3,
    vx: 0, vz: 0, vy: 0,
    fuse: 0.01,
    arm: 0,
    holder: null,
    owner: 'someone_else',
    stuckTo: null,
  });

  const inputs = new Map();
  // Step 1: detonates the bomb
  step(sim, inputs, 1 / 30);

  assert(player.vx < -8, `Player received massive negative-X knockback velocity: vx=${player.vx.toFixed(2)} m/s`);
  assert(player.vy > 5, `Player received vertical launch velocity: vy=${player.vy.toFixed(2)} m/s`);

  // Simulate 30 ticks (1 second) of flight and landing
  for (let t = 0; t < 30; t++) {
    step(sim, inputs, 1 / 30);
  }

  const dist = Math.abs(player.x);
  console.log(`  📊 Player was launched to x = ${player.x.toFixed(2)}m (total distance: ${dist.toFixed(2)}m)`);
  assert(dist >= 5.0, `Player was pushed far away (distance pushed = ${dist.toFixed(2)}m >= 5m)`);
}

console.log('\n--- TEST 9: Dashing into a wall produces a short stun and capped damage ---');
{
  const sim = createSim({ level: LEVELS.foundry, mode: CtfMode, config: CONFIG });
  const p1 = addPlayer(sim, { name: 'Capivara 1', team: 'red' });
  sim.state.phase = 'play';
  const player = sim.state.players.find(p => p.id === p1);
  // Foundry has bunker wall at x = 14, z = -3.1 (w = 1.1, d = 3.8, h = 1.6)
  player.x = 12.0;
  player.z = -3.1;
  player.y = 0;
  player.invuln = 0;
  player.hp = 100;

  const inputs = new Map();
  // Trigger dash towards the wall (+x direction)
  inputs.set(p1, { mx: 1, mz: 0, ax: 0, az: 0, ad: 7, run: 1, throw: false, grab: false, punch: false, jump: false, dash: true });
  step(sim, inputs, 1 / 30);

  // Next steps: player travels forward and impacts the wall
  inputs.set(p1, { mx: 1, mz: 0, ax: 0, az: 0, ad: 7, run: 1, throw: false, grab: false, punch: false, jump: false, dash: false });
  for (let s = 0; s < 4; s++) {
    step(sim, inputs, 1 / 30);
    if (player.knockT > 0) break;
  }

  console.log(`  📊 After wall impact: hp=${player.hp}, knockT=${player.knockT.toFixed(2)}s, vx=${player.vx.toFixed(2)}`);
  assert(player.hp >= 80, `Damage was reasonably capped (hp=${player.hp} >= 80, lost ${100 - player.hp} HP)`);
  assert(player.knockT > 0, `Player was stunned/knocked out by the wall crash: knockT=${player.knockT.toFixed(2)}s`);
  assert(player.knockT <= 0.46, `Stun duration is short (knockT=${player.knockT.toFixed(2)}s <= 0.46s, much less than normal ~2.7s)`);

  // After 18 ticks (0.6 seconds), player should already be completely recovered
  for (let t = 0; t < 18; t++) {
    step(sim, inputs, 1 / 30);
  }
  assert(player.knockT === 0, `Player quickly recovered from the stun (knockT=${player.knockT})`);
  assert(player.state === 'alive', 'Player is alive and back in action');
}

console.log('\n--- TEST 10: Dashing into another player does NOT stun either character ---');
{
  const sim = createSim({ level: LEVELS.skyhaven, mode: CtfMode, config: CONFIG });
  const p1 = addPlayer(sim, { name: 'Dasher', team: 'red' });
  const p2 = addPlayer(sim, { name: 'Target', team: 'blue' });
  sim.state.phase = 'play';
  const dasher = sim.state.players.find(p => p.id === p1);
  const target = sim.state.players.find(p => p.id === p2);

  dasher.x = 0;
  dasher.z = 0;
  dasher.y = 0;
  dasher.invuln = 0;

  target.x = 1.2;
  target.z = 0;
  target.y = 0;
  target.invuln = 0;

  const initialTargetHp = target.hp;
  const initialDasherHp = dasher.hp;

  const inputs = new Map();
  // Dasher triggers dash straight towards target (+x)
  inputs.set(p1, { mx: 1, mz: 0, ax: 0, az: 0, ad: 7, run: 1, throw: false, grab: false, punch: false, jump: false, dash: true });
  inputs.set(p2, { mx: 0, mz: 0, ax: 0, az: 0, ad: 7, run: 1, throw: false, grab: false, punch: false, jump: false, dash: false });

  // Step across collision
  for (let s = 0; s < 5; s++) {
    step(sim, inputs, 1 / 30);
  }

  console.log(`  📊 After dash collision: dasher pos=(${dasher.x.toFixed(2)}, ${dasher.z.toFixed(2)}), knockT=${dasher.knockT}s, hp=${dasher.hp}`);
  console.log(`  📊 After dash collision: target pos=(${target.x.toFixed(2)}, ${target.z.toFixed(2)}), knockT=${target.knockT}s, hp=${target.hp}`);

  // Contact must have occurred and pushed target forward
  assert(target.x > 1.25, `Target was physically pushed along +x by collision: x=${target.x.toFixed(2)}`);
  // Neither player must be stunned
  assert(dasher.knockT === 0, `Dasher was NOT stunned (knockT=${dasher.knockT})`);
  assert(target.knockT === 0, `Target was NOT stunned (knockT=${target.knockT})`);
  assert(dasher.hp === initialDasherHp, `Dasher suffered 0 self-damage (hp=${dasher.hp})`);
  assert(target.hp === initialTargetHp, `Target suffered 0 impact damage from the dash bump (hp=${target.hp})`);
}

console.log('\n--- TEST 11: Friendly Fire option (grabs, punches, and bombs) ---');
{
  // 11.1: Friendly fire OFF: allies cannot grab each other
  {
    const sim = createSim({ level: LEVELS.skyhaven, mode: CtfMode, config: { ...CONFIG, rules: { ...CONFIG.rules, friendlyFire: false } } });
    const p1 = addPlayer(sim, { name: 'Ally 1', team: 'red' });
    const p2 = addPlayer(sim, { name: 'Ally 2', team: 'red' });
    sim.state.phase = 'play';
    const a1 = sim.state.players.find(p => p.id === p1);
    const a2 = sim.state.players.find(p => p.id === p2);
    a1.x = 0; a1.z = 0; a1.y = 0; a1.invuln = 0;
    a2.x = 0.5; a2.z = 0; a2.y = 0; a2.invuln = 0;

    const inputs = new Map();
    inputs.set(p1, { mx: 0, mz: 0, ax: 1, az: 0, ad: 7, run: 1, throw: false, grab: true, punch: false, jump: false, dash: false });
    step(sim, inputs, 1 / 30);
    assert(a1.heldPlayer === null, 'Allies cannot grab each other (a1.heldPlayer is null)');
    assert(a2.heldBy === null, 'Ally cannot be held by teammate (a2.heldBy is null)');
  }

  // 11.2: Friendly fire OFF: allies cannot punch each other
  {
    const sim = createSim({ level: LEVELS.skyhaven, mode: CtfMode, config: { ...CONFIG, rules: { ...CONFIG.rules, friendlyFire: false } } });
    const p1 = addPlayer(sim, { name: 'Ally 1', team: 'red' });
    const p2 = addPlayer(sim, { name: 'Ally 2', team: 'red' });
    sim.state.phase = 'play';
    const a1 = sim.state.players.find(p => p.id === p1);
    const a2 = sim.state.players.find(p => p.id === p2);
    a1.x = 0; a1.z = 0; a1.y = 0; a1.invuln = 0;
    a2.x = 0.8; a2.z = 0; a2.y = 0; a2.invuln = 0;

    const inputs = new Map();
    inputs.set(p1, { mx: 0, mz: 0, ax: 1, az: 0, ad: 7, run: 1, throw: false, grab: false, punch: true, jump: false, dash: false });
    for (let t = 0; t < 10; t++) {
      step(sim, inputs, 1 / 30);
    }
    assert(a2.hp === 100, `Ally took 0 damage from punch (hp=${a2.hp})`);
    assert(a2.knockT === 0, `Ally was not stunned by friendly punch (knockT=${a2.knockT})`);
  }

  // 11.3: Friendly fire OFF: bombs thrown by allies have no effect on allies, but affect enemies
  {
    const sim = createSim({ level: LEVELS.skyhaven, mode: CtfMode, config: { ...CONFIG, rules: { ...CONFIG.rules, friendlyFire: false } } });
    const p1 = addPlayer(sim, { name: 'Thrower', team: 'red' });
    const p2 = addPlayer(sim, { name: 'Teammate', team: 'red' });
    const p3 = addPlayer(sim, { name: 'Enemy', team: 'blue' });
    sim.state.phase = 'play';
    const thrower = sim.state.players.find(p => p.id === p1);
    const teammate = sim.state.players.find(p => p.id === p2);
    const enemy = sim.state.players.find(p => p.id === p3);

    thrower.x = -5; thrower.z = 0; thrower.invuln = 0;
    teammate.x = 1.0; teammate.z = 0; teammate.invuln = 0; teammate.y = 0;
    enemy.x = -1.0; enemy.z = 0; enemy.invuln = 0; enemy.y = 0;

    // Bomb placed at (0, 0) thrown by player 1 (red)
    sim.state.bombs.push({
      id: 'b_ally',
      kind: 'normal',
      x: 0, z: 0, y: 0.3,
      vx: 0, vz: 0, vy: 0,
      fuse: 0.01,
      arm: 0,
      holder: null,
      owner: p1,
      stuckTo: null,
    });

    const inputs = new Map();
    step(sim, inputs, 1 / 30);

    assert(teammate.hp === 100, `Teammate took 0 damage from friendly bomb (hp=${teammate.hp})`);
    assert(teammate.vx === 0 && teammate.vy === 0, `Teammate received no knockback from friendly bomb (vx=${teammate.vx}, vy=${teammate.vy})`);
    assert(teammate.knockT === 0, `Teammate was not stunned by friendly bomb (knockT=${teammate.knockT})`);

    assert(enemy.hp < 100, `Enemy took damage from the bomb (hp=${enemy.hp.toFixed(1)})`);
    assert(enemy.vx < -5, `Enemy received blast knockback (vx=${enemy.vx.toFixed(2)})`);
  }

  // 11.4: Friendly fire ON: teammates ARE affected by punches, grabs, and bombs
  {
    const sim = createSim({ level: LEVELS.skyhaven, mode: CtfMode, config: { ...CONFIG, rules: { ...CONFIG.rules, friendlyFire: true } } });
    const p1 = addPlayer(sim, { name: 'Player 1', team: 'red' });
    const p2 = addPlayer(sim, { name: 'Player 2', team: 'red' });
    sim.state.phase = 'play';
    const a1 = sim.state.players.find(p => p.id === p1);
    const a2 = sim.state.players.find(p => p.id === p2);
    a1.x = 0; a1.z = 0; a1.y = 0; a1.invuln = 0;
    a2.x = 0.5; a2.z = 0; a2.y = 0; a2.invuln = 0;

    const inputs = new Map();
    inputs.set(p1, { mx: 0, mz: 0, ax: 1, az: 0, ad: 7, run: 1, throw: false, grab: true, punch: false, jump: false, dash: false });
    step(sim, inputs, 1 / 30);
    assert(a1.heldPlayer === p2, 'With friendly fire ON, allies CAN grab each other');
  }
}

console.log('\n--- TEST 12: Flag immunity to punches and bombs ---');
{
  // 12.1: Bomb explodes right next to home flag -> flag does not move
  {
    const sim = createSim({ level: LEVELS.skyhaven, mode: CtfMode, config: CONFIG });
    sim.state.phase = 'play';
    const flag = sim.state.flags.red;
    const startX = flag.x;
    const startZ = flag.z;

    // Detonate bomb right beside the flag
    sim.state.bombs.push({
      id: 'b_flag_test',
      kind: 'normal',
      x: startX + 0.5, z: startZ, y: 0.2,
      vx: 0, vz: 0, vy: 0,
      fuse: 0.01,
      arm: 0,
      holder: null,
      owner: null,
      stuckTo: null,
    });

    const inputs = new Map();
    step(sim, inputs, 1 / 30);

    assert(flag.st === 'home', `Home flag state remains 'home' (st=${flag.st})`);
    assert(flag.x === startX && flag.z === startZ, `Home flag position is unchanged after bomb blast (x=${flag.x}, z=${flag.z})`);
    assert(flag.vx === 0 && flag.vz === 0, `Home flag velocity is 0 (vx=${flag.vx}, vz=${flag.vz})`);
  }

  // 12.2: Punch aimed directly at flag -> flag does not move
  {
    const sim = createSim({ level: LEVELS.skyhaven, mode: CtfMode, config: CONFIG });
    const p1 = addPlayer(sim, { name: 'Puncher', team: 'blue' });
    sim.state.phase = 'play';
    const flag = sim.state.flags.red;
    const puncher = sim.state.players.find(p => p.id === p1);
    puncher.x = flag.x + 0.6;
    puncher.z = flag.z;
    puncher.face = -Math.PI / 2; // facing -x towards flag
    puncher.invuln = 0;

    const startX = flag.x;
    const startZ = flag.z;

    const inputs = new Map();
    inputs.set(p1, { mx: 0, mz: 0, ax: -1, az: 0, ad: 7, run: 1, throw: false, grab: false, punch: true, jump: false, dash: false });
    for (let t = 0; t < 10; t++) {
      step(sim, inputs, 1 / 30);
    }

    assert(flag.st === 'home', `Home flag remains on stand after punch (st=${flag.st})`);
    assert(flag.vx === 0 && flag.vz === 0, `Home flag velocity is 0 after punch (vx=${flag.vx}, vz=${flag.vz})`);
  }

  // 12.3: Bomb explodes next to a dropped flag -> dropped flag does not move
  {
    const sim = createSim({ level: LEVELS.skyhaven, mode: CtfMode, config: CONFIG });
    sim.state.phase = 'play';
    const flag = sim.state.flags.blue;
    flag.st = 'drop';
    flag.x = 0;
    flag.z = 0;
    flag.y = 0;
    flag.vx = 0;
    flag.vz = 0;
    flag.vy = 0;

    sim.state.bombs.push({
      id: 'b_drop_flag_test',
      kind: 'normal',
      x: 0.5, z: 0, y: 0.2,
      vx: 0, vz: 0, vy: 0,
      fuse: 0.01,
      arm: 0,
      holder: null,
      owner: null,
      stuckTo: null,
    });

    const inputs = new Map();
    step(sim, inputs, 1 / 30);

    assert(flag.vx === 0 && flag.vz === 0, `Dropped flag velocity remains 0 after bomb blast (vx=${flag.vx}, vz=${flag.vz})`);
    assert(flag.x === 0 && flag.z === 0, `Dropped flag position remains (0, 0) after bomb blast (x=${flag.x}, z=${flag.z})`);
  }

  // 12.4: Carrier holding flag takes punch damage -> carrier still holds flag
  {
    const sim = createSim({ level: LEVELS.skyhaven, mode: CtfMode, config: CONFIG });
    const p1 = addPlayer(sim, { name: 'Carrier', team: 'red' });
    const p2 = addPlayer(sim, { name: 'Attacker', team: 'blue' });
    sim.state.phase = 'play';
    const carrier = sim.state.players.find(p => p.id === p1);
    const attacker = sim.state.players.find(p => p.id === p2);

    carrier.x = 0; carrier.z = 0; carrier.invuln = 0;
    attacker.x = 0.8; attacker.z = 0; attacker.invuln = 0; attacker.face = -Math.PI / 2;

    // Equip flag
    carrier.carryFlag = 'blue';
    sim.state.flags.blue.st = 'carry';
    sim.state.flags.blue.carrier = carrier.id;

    const inputs = new Map();
    inputs.set(p2, { mx: 0, mz: 0, ax: -1, az: 0, ad: 7, run: 1, throw: false, grab: false, punch: true, jump: false, dash: false });
    for (let t = 0; t < 10; t++) {
      step(sim, inputs, 1 / 30);
    }

    assert(carrier.hp < 100, `Carrier took punch damage (hp=${carrier.hp})`);
    assert(carrier.carryFlag === 'blue', 'Carrier still holds the flag after being punched');
    assert(sim.state.flags.blue.st === 'carry', "Flag state remains 'carry'");
  }

  // 12.5: Carrier holding flag takes non-lethal bomb damage -> carrier still holds flag
  {
    const sim = createSim({ level: LEVELS.skyhaven, mode: CtfMode, config: CONFIG });
    const p1 = addPlayer(sim, { name: 'Carrier', team: 'red' });
    sim.state.phase = 'play';
    const carrier = sim.state.players.find(p => p.id === p1);
    carrier.x = 0; carrier.z = 0; carrier.invuln = 0; carrier.hp = 100;

    carrier.carryFlag = 'blue';
    sim.state.flags.blue.st = 'carry';
    sim.state.flags.blue.carrier = carrier.id;

    // Place bomb 2 meters away (non-lethal blast damage)
    sim.state.bombs.push({
      id: 'b_carrier_blast',
      kind: 'normal',
      x: 2.0, z: 0, y: 0.2,
      vx: 0, vz: 0, vy: 0,
      fuse: 0.01,
      arm: 0,
      holder: null,
      owner: null,
      stuckTo: null,
    });

    const inputs = new Map();
    step(sim, inputs, 1 / 30);

    assert(carrier.hp < 100 && carrier.hp > 0, `Carrier survived bomb with partial damage (hp=${carrier.hp.toFixed(1)})`);
    assert(carrier.carryFlag === 'blue', 'Carrier still holds the flag after surviving bomb blast');
    assert(sim.state.flags.blue.st === 'carry', "Flag state remains 'carry'");
  }

  // 12.6: Carrier dies -> flag is dropped on death
  {
    const sim = createSim({ level: LEVELS.skyhaven, mode: CtfMode, config: CONFIG });
    const p1 = addPlayer(sim, { name: 'Carrier', team: 'red' });
    sim.state.phase = 'play';
    const carrier = sim.state.players.find(p => p.id === p1);
    carrier.x = 0; carrier.z = 0; carrier.invuln = 0; carrier.hp = 10;

    carrier.carryFlag = 'blue';
    sim.state.flags.blue.st = 'carry';
    sim.state.flags.blue.carrier = carrier.id;

    // Fatal bomb point blank
    sim.state.bombs.push({
      id: 'b_fatal',
      kind: 'normal',
      x: 0.2, z: 0, y: 0.2,
      vx: 0, vz: 0, vy: 0,
      fuse: 0.01,
      arm: 0,
      holder: null,
      owner: null,
      stuckTo: null,
    });

    const inputs = new Map();
    step(sim, inputs, 1 / 30);

    assert(carrier.state === 'ko', `Carrier was knocked out / killed (state=${carrier.state})`);
    assert(carrier.carryFlag === null, 'Carrier no longer holds the flag after death');
    assert(sim.state.flags.blue.st === 'drop', "Flag is dropped on carrier death (st='drop')");
  }

  // --- TEST 13: Boxing Gloves powerup ("caixinha de luva") gives INSTA-NOCAUTE ---
  console.log('\n--- TEST 13: Boxing Gloves powerup ("caixinha de luva") gives INSTA-NOCAUTE ---');

  // 13.1: Walking over boxing gloves box grants gloves powerup
  {
    const sim = createSim({ level: LEVELS.skyhaven, mode: CtfMode, config: CONFIG });
    const p1 = addPlayer(sim, { name: 'Boxer', team: 'red' });
    sim.state.phase = 'play';
    const boxer = sim.state.players.find(p => p.id === p1);
    boxer.x = 0; boxer.z = 0; boxer.invuln = 0;

    sim.state.powerups.push({
      id: 'u_gloves_test',
      kind: 'gloves',
      x: 0.1, z: 0, y: 0.2,
      vx: 0, vz: 0, vy: 0,
      life: 5.0,
    });

    const inputs = new Map();
    step(sim, inputs, 1 / 30);

    assert(boxer.glovesT > 0, `Player collected boxing gloves (glovesT=${boxer.glovesT})`);
    assert(sim.state.powerups.length === 0, 'Gloves powerup box was consumed on pickup');
  }

  // 13.2: Punch with boxing gloves immediately knocks out a 100-HP opponent in ONE hit
  {
    const sim = createSim({ level: LEVELS.skyhaven, mode: CtfMode, config: CONFIG });
    const p1 = addPlayer(sim, { name: 'Boxer', team: 'red' });
    const p2 = addPlayer(sim, { name: 'Target', team: 'blue' });
    sim.state.phase = 'play';
    const boxer = sim.state.players.find(p => p.id === p1);
    const target = sim.state.players.find(p => p.id === p2);

    boxer.x = 0; boxer.z = 0; boxer.invuln = 0; boxer.face = 0; // facing +z
    target.x = 0; target.z = 0.95; target.invuln = 0; target.hp = 100; // full HP

    boxer.glovesT = 15.0; // Equipped with boxing gloves

    const inputs = new Map();
    inputs.set(p1, { mx: 0, mz: 0, ax: 0, az: 1, ad: 7, run: 1, throw: false, grab: false, punch: true, jump: false, dash: false });

    // Step 5 ticks to enter punch active window and resolve hit
    for (let t = 0; t < 5; t++) {
      step(sim, inputs, 1 / 30);
    }

    assert(target.hp === 0, `Target HP reduced from 100 to 0 (hp=${target.hp})`);
    assert(target.state === 'ko', `Target is knocked out in one hit (state=${target.state})`);
    assert(target.vz >= 15, `Target received massive launch knockback (vz=${target.vz.toFixed(2)} m/s >= 15 m/s)`);
  }

  // 13.3: Punch with boxing gloves shatters an Energy Shield and STILL knocks out the target
  {
    const sim = createSim({ level: LEVELS.skyhaven, mode: CtfMode, config: CONFIG });
    const p1 = addPlayer(sim, { name: 'Boxer', team: 'red' });
    const p2 = addPlayer(sim, { name: 'ShieldedTarget', team: 'blue' });
    sim.state.phase = 'play';
    const boxer = sim.state.players.find(p => p.id === p1);
    const target = sim.state.players.find(p => p.id === p2);

    boxer.x = 0; boxer.z = 0; boxer.invuln = 0; boxer.face = 0;
    target.x = 0; target.z = 0.95; target.invuln = 0; target.hp = 100;
    target.shieldHp = 65; // Has active shield

    boxer.glovesT = 10.0;

    const inputs = new Map();
    inputs.set(p1, { mx: 0, mz: 0, ax: 0, az: 1, ad: 7, run: 1, throw: false, grab: false, punch: true, jump: false, dash: false });

    for (let t = 0; t < 5; t++) {
      step(sim, inputs, 1 / 30);
    }

    assert(target.shieldHp === 0, 'Shield was shattered by boxing glove punch');
    assert(target.state === 'ko', 'Shielded target was still instantly knocked out');
  }

  // 13.4: Punching while held by grabber with gloves instantly KOs the grabber
  {
    const sim = createSim({ level: LEVELS.skyhaven, mode: CtfMode, config: CONFIG });
    const p1 = addPlayer(sim, { name: 'HeldPlayer', team: 'red' });
    const p2 = addPlayer(sim, { name: 'Grabber', team: 'blue' });
    sim.state.phase = 'play';
    const victim = sim.state.players.find(p => p.id === p1);
    const grabber = sim.state.players.find(p => p.id === p2);

    victim.x = 0; victim.z = 0; victim.invuln = 0; victim.glovesT = 8.0;
    grabber.x = 0; grabber.z = 0; grabber.invuln = 0; grabber.hp = 100;

    grabber.heldPlayer = victim.id;
    victim.heldBy = grabber.id;

    const inputs = new Map();
    inputs.set(p1, { mx: 0, mz: 0, ax: 0, az: 0, ad: 7, run: 1, throw: false, grab: false, punch: true, jump: false, dash: false });

    step(sim, inputs, 1 / 30);

    assert(grabber.state === 'ko', `Grabber was instantly knocked out by held punch (state=${grabber.state})`);
    assert(victim.heldBy === null, 'Victim was freed from grip');
  }

  // 13.5: Regular punch without boxing gloves does NOT instantly KO a full-HP player
  {
    const sim = createSim({ level: LEVELS.skyhaven, mode: CtfMode, config: CONFIG });
    const p1 = addPlayer(sim, { name: 'NormalPuncher', team: 'red' });
    const p2 = addPlayer(sim, { name: 'Target', team: 'blue' });
    sim.state.phase = 'play';
    const puncher = sim.state.players.find(p => p.id === p1);
    const target = sim.state.players.find(p => p.id === p2);

    puncher.x = 0; puncher.z = 0; puncher.invuln = 0; puncher.face = 0;
    target.x = 0; target.z = 0.95; target.invuln = 0; target.hp = 100;
    puncher.glovesT = 0; // NO gloves

    const inputs = new Map();
    inputs.set(p1, { mx: 0, mz: 0, ax: 0, az: 1, ad: 7, run: 1, throw: false, grab: false, punch: true, jump: false, dash: false });

    for (let t = 0; t < 5; t++) {
      step(sim, inputs, 1 / 30);
    }

    assert(target.state === 'alive', `Target without gloves remains alive (state=${target.state})`);
    assert(target.hp > 50, `Target took normal non-lethal damage (hp=${target.hp})`);
  }
}

console.log('\n--- TEST 14: Asymmetric teams with custom teamLimits (up to 3 per team) ---');
{
  // 14.1: 3 Red vs 1 Blue
  const host = new GameHost({
    levelId: 'skyhaven',
    modeId: 'ctf',
    teamLimits: { red: 3, blue: 1 },
    respawnTime: 2.5,
  });
  host.fillBots();
  assert(host.teamCount('red') === 3, 'Red team filled with 3 bots');
  assert(host.teamCount('blue') === 1, 'Blue team filled with 1 bot');
  assert(host.config.player.respawnTime === 2.5, 'Custom respawnTime applied correctly (2.5s)');

  // Human joins red team, kicks a red bot
  const hId = host.addHuman({ name: 'Capivara Red', team: 'red' });
  assert(host.teamCount('red') === 3, 'Red team maintained at 3 players total');
  assert(host.humanCount('red') === 1, 'Red team has 1 human');
  assert(host.sim.state.players.filter(p => p.team === 'red' && p.bot).length === 2, 'Red team now has 2 bots');

  // Human leaves, replaced by bot
  host.replaceWithBot(hId);
  assert(host.teamCount('red') === 3, 'Red team restored to 3 bots');
  assert(host.humanCount('red') === 0, 'Zero humans remain in red team');

  // 14.2: Legacy 5 Red selection clamps to 3 Red vs 2 Blue
  const host2 = new GameHost({
    levelId: 'foundry',
    modeId: 'deathmatch',
    teamLimits: { red: 5, blue: 2 },
  });
  host2.fillBots();
  assert(host2.teamCount('red') === 3, 'Red team clamps to 3 players (maximum)');
  assert(host2.teamCount('blue') === 2, 'Blue team has 2 players');
  assert(host2.sim.state.players.length === 5, 'Total 5 players in asymmetric match');
}

console.log('\n--- TEST 15: Free-For-All (Todos contra Todos) mode ---');
{
  const host = new GameHost({
    levelId: 'skyhaven',
    modeId: 'ffa',
    teamLimits: { ffa: 4 },
    respawnTime: 4,
  });
  assert(host.sim.state.flags === null, 'FFA has no flags');
  assert(host.sim.state.modeId === 'ffa', 'Sim mode is FFA');
  host.fillBots();
  assert(host.sim.state.players.length === 4, 'FFA filled 4 bots');
  assert(host.sim.state.players.every(p => p.team === 'free'), 'All FFA players have free/solo team');

  // Human joins FFA, kicks a bot
  const hId = host.addHuman({ name: 'Solo Winner' });
  assert(host.sim.state.players.length === 4, 'FFA maintains 4 players after human join');
  const human = host.sim.state.players.find(p => p.id === hId);
  assert(!human.bot, 'Human player successfully added to FFA');

  // Simulate frag scoring in FFA
  host.sim.state.phase = 'play';
  const victim = host.sim.state.players.find(p => p.id !== hId);
  victim.invuln = 0;
  victim.lastHitBy = hId;
  victim.lastHitByT = 3;
  victim.hp = 10;

  // Damage victim to 0 to trigger KO in FFA
  const sim = host.sim;
  damagePlayer(sim, victim, 50, 0, 0, 0, 'punch', hId);

  assert(victim.state === 'ko', 'Victim KOed');
  assert(sim.state.ffaScores[hId] === 1, `Killer awarded 1 frag in FFA scores (score=${sim.state.ffaScores[hId]})`);

  // Fast forward to reach win threshold (rules.ffaKillsToWin = 2)
  sim.config.rules.ffaKillsToWin = 2;
  const victim2 = host.sim.state.players.find(p => p.id !== hId && p.id !== victim.id);
  victim2.invuln = 0;
  damagePlayer(sim, victim2, 100, 0, 0, 0, 'punch', hId);

  assert(sim.state.ffaScores[hId] === 2, `Killer reached 2 frags`);
  assert(sim.state.phase === 'over', `FFA match ended upon reaching win threshold`);
  assert(sim.state.winner === hId, `Human ${hId} declared match winner!`);
}

console.log('\n--- TEST 16: Goofy yeet scream sound asset & playerThrow emission ---');
{
  // 16.1: Audio file exists and is valid MP3
  const audioPath = path.join(process.cwd(), 'audio', 'yeet_scream.mp3');
  assert(fs.existsSync(audioPath), 'yeet_scream.mp3 file exists in audio/');
  const stats = fs.statSync(audioPath);
  assert(stats.size > 20000, `yeet_scream.mp3 has valid audio data (size=${stats.size} bytes > 20KB)`);

  // 16.2: Emitting playerThrow when a held player is thrown
  const sim = createSim({ level: LEVELS.skyhaven, mode: CtfMode, config: CONFIG });
  const p1 = addPlayer(sim, { name: 'Thrower', team: 'red' });
  const p2 = addPlayer(sim, { name: 'Victim', team: 'blue' });
  sim.state.phase = 'play';
  const thrower = sim.state.players.find(p => p.id === p1);
  const victim = sim.state.players.find(p => p.id === p2);

  // Set thrower holding victim
  thrower.heldPlayer = p2;
  victim.heldBy = p1;
  thrower.face = 0; // facing +Z

  // Throw player
  const inputs = new Map();
  inputs.set(p1, { mx: 0, mz: 0, ax: 0, az: 1, ad: 7, run: 1, throw: true, grab: false, punch: false, jump: false, dash: false });
  step(sim, inputs, 1 / 30);

  assert(thrower.heldPlayer === null, 'Thrower released victim');
  assert(victim.heldBy === null, 'Victim is no longer held');
  assert(victim.vz > 15, `Victim launched forward with high velocity (vz=${victim.vz.toFixed(2)} > 15 m/s)`);
  assert(victim.vy > 10, `Victim launched into the air with high arc (vy=${victim.vy.toFixed(2)} > 10 m/s)`);

  const events = sim.events;
  const throwEv = events.find(e => e.t === 'playerThrow');
  assert(!!throwEv, 'Simulation emitted playerThrow event on throw');
  assert(throwEv.id === p1, 'playerThrow event has thrower id');
  assert(throwEv.target === p2, 'playerThrow event has victim target id');

  // 16.3: createSfx safe execution
  const sfx = createSfx();
  assert(typeof sfx.play === 'function', 'createSfx exposes play function');
  let err = null;
  try {
    sfx.play('playerThrow', 0.8);
  } catch (e) {
    err = e;
  }
  assert(err === null, 'sfx.play(playerThrow) executes safely without crashing');
}

// ============================================================================
// TEST 17: Void falling physics and elimination
// ============================================================================
{
  console.log('\n--- TEST 17: Void falling physics and elimination ---');

  const sim = createSim({
    level: LEVELS.skyhaven,
    mode: CtfMode,
    config: { ...CONFIG, player: { ...CONFIG.player, respawnTime: 2.0 } },
  });
  sim.state.phase = 'play';

  const p1 = addPlayer(sim, { name: 'Faller', team: 'red' });
  const player = sim.state.players.find(p => p.id === p1);

  // Position player just past the eastern edge of Skyhaven (bounds: w:46, d:46 -> hw:23)
  player.x = 24.5;
  player.z = 0;
  player.y = 0;
  player.vx = 2.0;
  player.vy = 0;

  // 17.1: Over void, onGround must be false and jumping should be disabled
  const jumpInput = new Map();
  jumpInput.set(p1, { mx: 1, mz: 0, ax: 0, az: 0, ad: 7, run: 1, throw: false, grab: false, punch: false, jump: true, dash: false });
  step(sim, jumpInput, 1 / 60);

  assert(player.y < 0, `Player fell below floor level (y=${player.y.toFixed(3)} < 0)`);
  assert(player.vy < 0, `Player has downward fall velocity (vy=${player.vy.toFixed(2)} < 0)`);

  // 17.2: Simulate consecutive fall ticks
  let koTriggered = false;
  let koEvent = null;
  for (let t = 0; t < 60; t++) {
    step(sim, jumpInput, 1 / 60);
    const ev = sim.events.find(e => e.t === 'ko' && e.id === p1 && e.cause === 'fall');
    if (ev && !koTriggered) {
      koTriggered = true;
      koEvent = ev;
    }
  }

  assert(koTriggered, 'Player was knocked out by void fall');
  assert(koEvent?.cause === 'fall', 'KO event has cause: "fall"');
  assert(player.state === 'ko', 'Player state changed to "ko" upon falling below fallY');
  assert(player.y < CONFIG.world.fallY, `Player altitude reached void threshold (y=${player.y.toFixed(2)} < ${CONFIG.world.fallY})`);

  // 17.3: Respawn returns player to arena surface
  for (let t = 0; t < 120; t++) {
    step(sim, new Map(), 1 / 60);
  }
  assert(player.state === 'alive', 'Player successfully respawned after void fall');
  assert(player.y === 0, `Player respawned on arena floor at y=0 (y=${player.y})`);
  assert(Math.abs(player.x) <= sim.level.bounds.w / 2, 'Player respawned inside arena boundaries');
}

console.log(`\n========================================`);
console.log(`TEST RESULTS: ${passed} PASSED, ${failed} FAILED`);
console.log(`========================================`);

if (failed > 0) process.exit(1);
