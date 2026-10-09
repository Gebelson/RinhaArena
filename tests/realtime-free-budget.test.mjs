import test from 'node:test';
import assert from 'node:assert/strict';
import { connectOnline, REALTIME_BUDGET } from '../src/net/ws.js';

// Exercise the actual Phoenix channel implementation, authoritative GameHost,
// and CSP without contacting Supabase or creating accounts/rooms.
test('six-human transport respects fanout budget and preserves controls', async t => {
  const originals = Object.fromEntries(['WebSocket', 'performance', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'].map(key => [key, globalThis[key]]));
  const realDateNow = Date.now;
  let now = 0, nextTimer = 0;
  const timers = new Map(), sockets = new Set(), broadcasts = [];
  const baseDate = 1_800_000_000_000;
  const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
  const schedule = (fn, delay, repeat = false) => {
    const id = ++nextTimer;
    timers.set(id, { fn, due: now + delay, repeat: repeat ? delay : 0 });
    return id;
  };
  class FakeWebSocket {
    static OPEN = 1;
    constructor() {
      this.readyState = 1;
      this.topics = new Set();
      sockets.add(this);
      queueMicrotask(() => this.onopen?.());
    }
    send(raw) {
      const message = JSON.parse(raw);
      if (message.event === 'phx_join') {
        this.topics.add(message.topic);
        queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ event: 'phx_reply', ref: message.ref, payload: { status: 'ok' } }) }));
      } else if (message.event === 'phx_leave') this.topics.delete(message.topic);
      else if (message.event === 'broadcast') {
        const recipients = [...sockets].filter(socket => socket !== this && socket.readyState === 1 && socket.topics.has(message.topic));
        broadcasts.push({ at: now, topic: message.topic, event: message.payload.event, payload: structuredClone(message.payload.payload), recipients: recipients.length, cost: 1 + recipients.length });
        for (const receiver of recipients) queueMicrotask(() => receiver.onmessage?.({ data: raw }));
      }
    }
    close() { this.readyState = 3; this.topics.clear(); sockets.delete(this); this.onclose?.(); }
    drop() { this.close(); }
  }
  globalThis.WebSocket = FakeWebSocket;
  globalThis.performance = { now: () => now };
  globalThis.setTimeout = (fn, delay) => schedule(fn, delay);
  globalThis.setInterval = (fn, delay) => schedule(fn, delay, true);
  globalThis.clearTimeout = globalThis.clearInterval = id => timers.delete(id);
  Date.now = () => baseDate + now;
  const advance = async milliseconds => {
    now += milliseconds;
    for (const [id, timer] of [...timers]) if (timer.due <= now) {
      if (timer.repeat) timer.due = now + timer.repeat; else timers.delete(id);
      timer.fn();
    }
    await flush();
  };
  const transports = [];
  let fixtureNumber = 0;
  async function fixture(count = 6) {
    const room = `mock${++fixtureNumber}`;
    const config = { ok: true, levelId: 'foundry', modeId: 'ctf', teamLimits: { red: 3, blue: 3, ffa: 6 }, respawnTime: 5, friendlyFire: false, config: { rules: { countdown: 0, powerups: false } } };
    const profiles = Array.from({ length: count }, (_, index) => ({ playerId: `user-${fixtureNumber}-${index}`, name: `Capy${index}`, cos: { hat: 'none', skin: '#ffd29c', ownedEmotes: [] } }));
    const host = await connectOnline({ room, profile: profiles[0], host: true, roomConfig: structuredClone(config) });
    const clients = [host];
    transports.push(host);
    for (let i = 1; i < count; i++) {
      const guest = await connectOnline({ room, profile: profiles[i], roomConfig: structuredClone(config) });
      clients.push(guest); transports.push(guest);
    }
    host.finalizeMatchmaking({ botsEnabled: false });
    await flush();
    const ready = clients.map(client => client.clientReadyAndWaitForStart());
    await flush(); await Promise.all(ready);
    await advance(600);
    host.update(1 / 60); await flush();
    return { room, host, clients, guest: clients[1], profiles };
  }
  const disposeFixture = value => { for (const client of value.clients) client.dispose(); };
  try {
    await t.test('5Hz input/snapshot with six recipients stays below 100 aggregate messages per second', async () => {
      const value = await fixture();
      const start = now, first = broadcasts.length;
      for (let frame = 0; frame < 240; frame++) {
        await advance(1000 / 60);
        for (let i = 1; i < value.clients.length; i++) value.clients[i].setInput({ mx: Math.sin(frame / 2 + i), mz: Math.cos(frame / 2 + i), run: 1 });
        value.host.update(1 / 60); await flush();
        for (let i = 1; i < value.clients.length; i++) value.clients[i].update(1 / 60);
      }
      const traffic = broadcasts.slice(first);
      assert(traffic.some(message => message.event === 'input'));
      assert(traffic.some(message => message.event === 'snap'));
      for (const message of traffic) {
        if (message.event === 'input' || message.event === 'presence-ping') { assert.match(message.topic, /arena-control:/); assert.equal(message.recipients, 1); }
        if (message.event === 'snap') assert.equal(message.recipients, 5);
      }
      const worstSecond = Math.max(...traffic.map(message => traffic.filter(other => other.at >= message.at && other.at < message.at + 1000).reduce((total, other) => total + other.cost, 0)));
      assert(worstSecond <= 90, `actual sender + receiver fanout: ${worstSecond}/s`);
      const oldBudget = (5 * 40 + 30) * 6 + 5 / 2 * 6;
      assert.equal(oldBudget, 1395);
      assert.equal(5 * REALTIME_BUDGET.inputHz * 2 + REALTIME_BUDGET.snapshotHz * 6 + 5 / (REALTIME_BUDGET.presenceMs / 1000) * 2, 85);
      assert(now - start >= 3900);
      assert.equal(sockets.size, 16);
      disposeFixture(value); await flush(); assert.equal(sockets.size, 0);
    });
    await t.test('idle frames do not broadcast redundant inputs and presence remains host-only', async () => {
      const value = await fixture();
      for (const client of value.clients.slice(1)) client.setInput({ mx: 0, mz: 0, run: 0 });
      await flush();
      const first = broadcasts.length;
      for (let frame = 0; frame < 150; frame++) {
        await advance(1000 / 60);
        for (const client of value.clients.slice(1)) client.setInput({ mx: 0, mz: 0, run: 0 });
        value.host.update(1 / 60); await flush();
      }
      const traffic = broadcasts.slice(first);
      assert.equal(traffic.filter(message => message.event === 'input').length, 0);
      assert(traffic.filter(message => message.event === 'presence-ping').length >= 5);
      assert(traffic.filter(message => message.event === 'presence-ping').every(message => message.recipients === 1));
      disposeFixture(value); await flush();
    });
    await t.test('prediction moves/jumps immediately while the network is throttled', async () => {
      const value = await fixture(2), guest = value.guest;
      guest.setInput({ mx: .1, mz: 0 }); await flush();
      const first = broadcasts.length, before = guest.view().players.find(player => player.id === guest.myId);
      await advance(16);
      guest.setInput({ mx: 1, mz: 0, run: 1, jump: true, dash: true });
      guest.update(1 / 60);
      const after = guest.view().players.find(player => player.id === guest.myId);
      assert(after.x > before.x); assert(after.y > before.y); assert(after.vx > 10);
      assert.equal(broadcasts.slice(first).filter(message => message.event === 'input').length, 0);
      await advance(200); guest.setInput({ mx: 0, mz: 0 }); await flush();
      const sent = broadcasts.slice(first).find(message => message.event === 'input');
      assert.equal(sent.payload.actions[0].jump, true); assert.equal(sent.payload.actions[0].dash, true);
      disposeFixture(value); await flush();
    });
    await t.test('two fast taps are queued, holding does not repeat, and a failed send retains edges', async () => {
      const value = await fixture(2), guest = value.guest;
      guest.setInput({ mx: .1 }); await flush();
      const control = [...sockets].filter(socket => [...socket.topics].some(topic => topic.includes('arena-control:')))[0];
      const first = broadcasts.length;
      await advance(20); guest.setInput({ mx: 0, grab: true, ax: 1 });
      guest.setInput({ mx: 0, grab: false });
      await advance(20); guest.setInput({ mx: 0, grab: true, ax: -1 });
      await advance(200); control.readyState = 3;
      guest.setInput({ mx: 0, grab: true, ax: -1 });
      assert.equal(broadcasts.slice(first).filter(message => message.event === 'input').length, 0);
      control.readyState = 1;
      guest.setInput({ mx: 0, grab: true, ax: -1 }); await flush();
      const packet = broadcasts.slice(first).find(message => message.event === 'input');
      assert.equal(packet.payload.actions.length, 2);
      assert.deepEqual(packet.payload.actions.map(action => action.ax), [1, -1]);
      value.host.update(1 / 60); await flush();
      value.host.update(1 / 60); await flush();
      for (let frame = 0; frame < 90; frame++) {
        await advance(1000 / 60);
        guest.setInput({ mx: 0, grab: true, ax: -1 });
        value.host.update(1 / 60); await flush();
      }
      assert.equal(broadcasts.slice(first).filter(message => message.event === 'input').flatMap(message => message.payload.actions).length, 2);
      disposeFixture(value); await flush();
    });
    await t.test('control socket reconnect recovers host subscription and pending presses', async () => {
      const value = await fixture(2), guest = value.guest;
      guest.setInput({ mx: .1 }); await flush();
      const controls = [...sockets].filter(socket => [...socket.topics].some(topic => topic.includes('arena-control:')));
      controls[0].drop();
      guest.setInput({ mx: 0, jump: true });
      await advance(300); await flush();
      await advance(200); guest.setInput({ mx: 0 }); await flush();
      assert(broadcasts.some(message => message.event === 'input' && message.topic.includes(value.room) && message.payload.actions.some(action => action.jump)));
      assert.equal(sockets.size, 4);
      disposeFixture(value); await flush(); assert.equal(sockets.size, 0);
    });
    await t.test('host transfer subscribes remaining guests and retains authoritative roster', async () => {
      const value = await fixture(3);
      const [oldHost, successor, guest] = value.clients;
      const ids = oldHost.view().players.map(player => player.id);
      oldHost.dispose(); await flush();
      await advance(250); await flush();
      successor.update(1 / 60); await flush();
      guest.setInput({ mx: 1, mz: 0, jump: true }); await flush();
      successor.update(1 / 60); await flush();
      assert.deepEqual(successor.view().players.map(player => player.id), ids);
      const input = broadcasts.filter(message => message.event === 'input' && message.topic.includes(value.room)).at(-1);
      assert(input); assert.equal(input.recipients, 1);
      assert.equal(sockets.size, 4);
      successor.dispose(); guest.dispose(); await flush(); assert.equal(sockets.size, 0);
    });
  } finally {
    for (const transport of transports) transport.dispose();
    for (const [key, value] of Object.entries(originals)) globalThis[key] = value;
    Date.now = realDateNow;
  }
});
