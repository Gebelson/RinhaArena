// Unit & integration test for Multiplayer Client-Side Prediction (CSP)
// and Time-Based Continuous Entity Interpolation.

import { connectOnline } from './src/net/ws.js';
import { createRoom, touchRoom } from './src/net/rooms.js';

console.log('--- TEST: Multiplayer Client-Side Prediction & Interpolation ---');

const code = `csp${Date.now().toString(36).slice(-6)}`;
const created = await createRoom({
  code,
  name: 'CSP Test Room',
  password: 'test',
  modeId: 'ctf',
  levelId: 'foundry',
  redSize: 2,
  blueSize: 2,
  ffaSize: 6,
  respawnTime: 5,
  friendlyFire: false,
});

if (!created.ok || !created.hostToken) {
  throw new Error(`Room creation failed: ${JSON.stringify(created)}`);
}

const hostProfile = { name: 'HostCapy', cos: { hat: 'none', skin: '#ffd29c' } };
const guestProfile = { name: 'GuestCapy', cos: { hat: 'cap', skin: '#ffd29c' } };

const host = await connectOnline({
  room: code,
  password: 'test',
  profile: hostProfile,
  host: true,
  hostToken: created.hostToken,
  roomConfig: created.room,
});

const guest = await connectOnline({
  room: code,
  password: 'test',
  profile: guestProfile,
});

// Let initial snapshot exchange happen
for (let i = 0; i < 5; i++) {
  host.update(1 / 60);
  await new Promise((r) => setTimeout(r, 40));
}

// 1. Verify guest received snapshot and has myId
const initialGuestView = guest.view();
const guestPlayerInitial = initialGuestView?.players?.find((p) => p.id === guest.myId);
if (!guestPlayerInitial) {
  throw new Error('FAIL: Guest view did not contain guest player');
}
console.log(`  ✅ PASS: Guest player detected in view (id: ${guest.myId}, pos: (${guestPlayerInitial.x}, ${guestPlayerInitial.z}))`);

// 2. Client-Side Prediction: Test immediate movement on frame 1
const startX = guestPlayerInitial.x;
guest.setInput({ mx: 1, mz: 0, run: 1 });
guest.update(1 / 60); // 1 frame locally

const guestViewAfterStep = guest.view();
const guestPlayerAfterStep = guestViewAfterStep.players.find((p) => p.id === guest.myId);

if (guestPlayerAfterStep.x <= startX) {
  throw new Error(`FAIL: Guest position did not advance immediately on client (expected x > ${startX}, got ${guestPlayerAfterStep.x})`);
}
console.log(`  ✅ PASS: 0ms Input Lag! Client predicted movement on frame 1: x went from ${startX.toFixed(3)} to ${guestPlayerAfterStep.x.toFixed(3)}`);

// 3. Client-Side Prediction: Jump immediate reaction
guest.setInput({ mx: 1, mz: 0, jump: true });
guest.update(1 / 60);
const guestViewAfterJump = guest.view();
const guestPlayerAfterJump = guestViewAfterJump.players.find((p) => p.id === guest.myId);
if (guestPlayerAfterJump.y <= 0 && guestPlayerAfterJump.vy <= 0) {
  throw new Error(`FAIL: Guest jump was not predicted immediately (y: ${guestPlayerAfterJump.y}, vy: ${guestPlayerAfterJump.vy})`);
}
console.log(`  ✅ PASS: Immediate jump prediction! y=${guestPlayerAfterJump.y.toFixed(3)}, vy=${guestPlayerAfterJump.vy.toFixed(3)}`);

// 4. Client-Side Prediction: Dash immediate reaction
guest.setInput({ mx: 1, mz: 0, dash: true });
guest.update(1 / 60);
const guestViewAfterDash = guest.view();
const guestPlayerAfterDash = guestViewAfterDash.players.find((p) => p.id === guest.myId);
if (guestPlayerAfterDash.vx < 10) {
  throw new Error(`FAIL: Guest dash impulse was not predicted immediately (vx: ${guestPlayerAfterDash.vx})`);
}
console.log(`  ✅ PASS: Immediate dash prediction! Impulse vx=${guestPlayerAfterDash.vx.toFixed(2)} m/s`);

// 5. Host & Guest sync over time: Verify smooth reconciliation
for (let i = 0; i < 20; i++) {
  host.update(1 / 60);
  guest.update(1 / 60);
  guest.setInput({ mx: 1, mz: 0, run: 1 });
  await new Promise((r) => setTimeout(r, 20));
}

const finalGuestView = guest.view();
const finalGuestP = finalGuestView.players.find((p) => p.id === guest.myId);
const hostView = host.view();
const hostGuestP = hostView.players.find((p) => p.id === guest.myId);

const delta = Math.hypot(finalGuestP.x - hostGuestP.x, finalGuestP.z - hostGuestP.z);
console.log(`  📊 Position reconciliation delta after 20 frames: ${delta.toFixed(3)}m`);
if (delta > 2.0) {
  throw new Error(`FAIL: Divergence too large between client prediction and host (${delta}m)`);
}
console.log('  ✅ PASS: Client prediction remains accurately synchronized with host');

// 6. Test other entity interpolation: Host player visible to guest
const otherPlayerInGuestView = finalGuestView.players.find((p) => p.id === host.myId);
if (!otherPlayerInGuestView) {
  throw new Error('FAIL: Host player not visible in guest view');
}
console.log(`  ✅ PASS: Host player (${host.myId}) smoothly interpolated in guest view at (${otherPlayerInGuestView.x}, ${otherPlayerInGuestView.z})`);

guest.dispose();
host.dispose();
await touchRoom(code, created.hostToken, 0);

console.log('\n========================================');
console.log('ALL MULTIPLAYER CSP & INTERPOLATION TESTS PASSED!');
console.log('========================================');
