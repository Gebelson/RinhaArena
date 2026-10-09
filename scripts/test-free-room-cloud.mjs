// Explicit cloud smoke: creates one short-lived room, never accounts or results.
import assert from 'node:assert/strict';
import { createRoom, listRooms, touchRoom } from '../src/net/rooms.js';
import { connectOnline } from '../src/net/ws.js';
if (process.env.RINHA_FREE_ROOM_CLOUD !== '1') throw new Error('Set RINHA_FREE_ROOM_CLOUD=1 to run this cloud smoke.');
const active = await listRooms();
if (active.length) { console.log('SKIPPED: existing active rooms; preserve their Free bandwidth.'); process.exit(0); }
const code = `check${Date.now().toString(36).slice(-6)}`;
const created = await createRoom({code,name:'Teste temporário',modeId:'ctf',levelId:'dojo',redSize:3,blueSize:3,ffaSize:6,respawnTime:5,friendlyFire:false});
assert(created.ok && created.hostToken, 'Room creation failed');
const clients = [];
const sleep = ms => new Promise(resolve => setTimeout(resolve,ms));
let timer;
try {
  for(let index=0; index<6; index++) {
    const profile = {playerId:crypto.randomUUID(),name:`Teste${index+1}`,cos:{hat:'none',skin:'#ffd29c',characterId:'capivara'}};
    clients.push(await connectOnline({room:code,profile,host:index===0,hostToken:index===0?created.hostToken:null,roomConfig:structuredClone(created.room)}));
  }
  const host = clients[0];
  host.finalizeMatchmaking({botsEnabled:false});
  await Promise.all(clients.map(client=>client.waitForMatch()));
  await Promise.all(clients.map(client=>client.clientReadyAndWaitForStart()));
  await sleep(650);
  timer = setInterval(()=>{ for(const client of clients) client.update(1/60); },1000/60);
  for(let step=0; step<15; step++) {
    for(let index=1;index<clients.length;index++) clients[index].setInput({mx:Math.sin(step+index)*.5,mz:Math.cos(step+index)*.5,run:0});
    await sleep(200);
  }
  for(const client of clients) {
    const view = client.view();
    assert.equal(view.players.length,6);
    const own = view.players.find(player=>player.id===client.myId);
    assert(own && Number.isFinite(own.x) && Number.isFinite(own.z), 'Missing or invalid player');
    assert(view.tick>60, 'Snapshots did not advance');
  }
  console.log('CLOUD 3v3 OK: six clients started and received advancing real Realtime snapshots. No account, currency or match-result writes.');
} finally {
  clearInterval(timer);
  for(const guest of clients.slice(1)) guest.dispose();
  await sleep(100);
  clients[0]?.dispose();
  await touchRoom(code,created.hostToken,0);
}
