import { createRoom, joinRoom, listRooms, touchRoom } from '../src/net/rooms.js';
import { SupabaseRealtimeChannel } from '../src/net/supabase.js';
import { connectOnline } from '../src/net/ws.js';

const code = `test${Date.now().toString(36).slice(-6)}`;
const created = await createRoom({
  code,
  name: 'Cloud smoke test',
  password: 'test-only',
  modeId: 'ctf',
  levelId: 'foundry',
  redSize: 2,
  blueSize: 2,
  ffaSize: 6,
  respawnTime: 5,
  friendlyFire: false,
});
if (!created.ok || !created.hostToken) throw new Error(`create failed: ${JSON.stringify(created)}`);

const rooms = await listRooms();
if (!rooms.some((room) => room.code === code)) throw new Error('created room missing from list');
const wrong = await joinRoom(code, 'wrong');
if (wrong.ok) throw new Error('password validation accepted a wrong password');
const joined = await joinRoom(code, 'test-only');
if (!joined.ok || joined.levelId !== 'foundry') throw new Error(`join failed: ${JSON.stringify(joined)}`);

const sender = new SupabaseRealtimeChannel(`smoke:${code}`);
const receiver = new SupabaseRealtimeChannel(`smoke:${code}`);
await Promise.all([sender.connect(), receiver.connect()]);
await new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error('Realtime broadcast timeout')), 5000);
  receiver.on('ping', (payload) => {
    if (payload?.code !== code) return;
    clearTimeout(timeout);
    resolve();
  });
  sender.send('ping', { code });
});
sender.close();
receiver.close();

const profile = { name: 'Host', cos: { hat: 'none', skin: '#ffd29c' } };
const host = await connectOnline({
  room: code,
  password: 'test-only',
  profile,
  host: true,
  hostToken: created.hostToken,
  roomConfig: created.room,
});
const guest = await connectOnline({
  room: code,
  password: 'test-only',
  profile: { ...profile, name: 'Guest' },
});
for (let frame = 0; frame < 30; frame += 1) {
  host.update(1 / 60);
  guest.setInput({ mx: 1, mz: 0, ax: 1, az: 0, ad: 1 });
  await new Promise((resolve) => setTimeout(resolve, 18));
}
const guestView = guest.view();
if (!guestView?.players.some((player) => player.id === guest.myId)) {
  throw new Error('guest did not receive an authoritative snapshot containing its player');
}
guest.dispose();
host.dispose();
await touchRoom(code, created.hostToken, 0);
console.log('Supabase rooms, password validation and full host/guest multiplayer flow: OK');
