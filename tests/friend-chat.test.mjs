import test from 'node:test';
import assert from 'node:assert/strict';
import { createFriendChatService, getFriendMessages } from '../src/net/friendChat.js';
import { signIn, signOut } from '../src/net/account.js';
import { SUPABASE_KEY, SUPABASE_URL } from '../src/net/supabase.js';

const OWNER = '11111111-1111-4111-8111-111111111111';
const FRIEND = '22222222-2222-4222-8222-222222222222';
const OUTSIDER = '33333333-3333-4333-8333-333333333333';
const NONCE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const MESSAGE_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const BASE_TIME = 1_800_000_000_000;
const row = overrides => ({ id: MESSAGE_ID, sender_id: FRIEND, recipient_id: OWNER, body: 'Oi! 🐾',
  client_nonce: NONCE, created_at: '2026-10-09T12:00:00.123456+00:00', read_at: null, ...overrides });
const jwt = (owner = OWNER, expires = BASE_TIME / 1000 + 36_000) => ['e30', Buffer.from(JSON.stringify({ sub: owner, exp: expires })).toString('base64url'), 'signature'].join('.');
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

function harness({ autoJoin = true, heartbeatReplies = true, tokenProvider, rpc } = {}) {
  let time = 0, nextTimer = 0;
  const timers = new Map(), sockets = [], statuses = [], messages = [], tokenCalls = [];
  const lifecycle = new EventTarget(), onlineListeners = new Set();
  const addListener = lifecycle.addEventListener.bind(lifecycle), removeListener = lifecycle.removeEventListener.bind(lifecycle);
  lifecycle.addEventListener = (type, callback) => { if (type === 'online') onlineListeners.add(callback); addListener(type, callback); };
  lifecycle.removeEventListener = (type, callback) => { if (type === 'online') onlineListeners.delete(callback); removeListener(type, callback); };
  const schedule = (fn, delay, repeat = false) => {
    const id = ++nextTimer; timers.set(id, { fn, due: time + delay, repeat: repeat ? delay : 0 }); return id;
  };
  class FakeWebSocket {
    static OPEN = 1;
    constructor(url) {
      this.url = url; this.readyState = 0; this.sent = []; sockets.push(this);
      queueMicrotask(() => { if (this.readyState === 0) { this.readyState = 1; this.onopen?.(); } });
    }
    send(raw) {
      assert.equal(this.readyState, 1);
      const packet = JSON.parse(raw); this.sent.push(packet);
      if (packet.event === 'phx_join' && autoJoin) queueMicrotask(() => this.joinReply());
      if (packet.event === 'heartbeat' && heartbeatReplies) queueMicrotask(() => this.receive({ topic: 'phoenix', event: 'phx_reply', ref: packet.ref, payload: { status: 'ok' } }));
    }
    receive(packet) { this.onmessage?.({ data: typeof packet === 'string' ? packet : JSON.stringify(packet) }); }
    joinReply(overrides = {}) {
      const join = this.sent.find(packet => packet.event === 'phx_join');
      this.receive({ topic: join.topic, event: 'phx_reply', ref: join.ref, join_ref: join.join_ref,
        payload: { status: 'ok', response: { postgres_changes: join.payload.config.postgres_changes.map((binding, i) => ({ ...binding, id: i + 41 })) } }, ...overrides });
    }
    change(record, { type = 'INSERT', ids = [42], ...overrides } = {}) {
      const join = this.sent.find(packet => packet.event === 'phx_join');
      this.receive({ topic: join.topic, event: 'postgres_changes', join_ref: join.join_ref,
        payload: { ids, data: { schema: 'public', table: 'friend_messages', type, record, errors: null } }, ...overrides });
    }
    close() { this.readyState = 3; this.onclose?.(); }
    drop() { this.close(); }
  }
  const service = createFriendChatService({ WebSocket: FakeWebSocket, eventTarget: lifecycle, now: () => BASE_TIME + time,
    rpc: rpc || (async () => { throw new Error('Unexpected RPC during Realtime.'); }),
    tokenProvider: async owner => { tokenCalls.push(owner); return tokenProvider ? tokenProvider(owner) : jwt(); },
    timers: { setTimeout: (fn, delay) => schedule(fn, delay), setInterval: (fn, delay) => schedule(fn, delay, true),
      clearTimeout: id => timers.delete(id), clearInterval: id => timers.delete(id) } });
  const advance = async milliseconds => {
    const until = time + milliseconds;
    await flush();
    for (;;) {
      const next = [...timers].filter(([, timer]) => timer.due <= until).sort((a, b) => a[1].due - b[1].due)[0];
      if (!next) break;
      const [id, timer] = next; time = timer.due;
      if (timer.repeat) timer.due += timer.repeat; else timers.delete(id);
      timer.fn(); await flush();
    }
    time = until; await flush();
  };
  const subscribe = () => service.subscribeFriendMessages(OWNER, {
    onMessage: (message, event) => messages.push({ message, event }), onStatus: status => statuses.push(status),
  });
  return { service, subscribe, advance, sockets, timers, statuses, messages, tokenCalls, lifecycle, onlineListeners, elapsed: () => time };
}

test('RPCs send only friend parameters and guard every operation with the owner', async () => {
  const calls = [], outgoing = row({ sender_id: OWNER, recipient_id: FRIEND, body: 'Olá' });
  const older = row({ id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', created_at: '2026-10-09T12:00:00.123455+00:00' });
  const service = createFriendChatService({ rpc: async (...args) => {
    calls.push(args);
    if (args[0] === 'get_friend_messages') return [row(), older, row({ sender_id: OUTSIDER, recipient_id: FRIEND })];
    if (args[0] === 'send_friend_message') return [outgoing];
    if (args[0] === 'mark_friend_messages_read') return 2;
    return [{ friend_id: FRIEND, unread_count: '3' }, { friend_id: OWNER, unread_count: 7 }, { friend_id: 'broken', unread_count: 1 }];
  } });
  const cursor = { created_at: '2026-10-09T14:00:00Z', id: MESSAGE_ID };
  assert.deepEqual((await service.getFriendMessages(OWNER.toUpperCase(), FRIEND, cursor, 40)).map(message => message.id), [older.id, MESSAGE_ID]);
  assert.deepEqual(await service.sendFriendMessage(OWNER, FRIEND, '  Olá  ', NONCE), outgoing);
  assert.equal(await service.markFriendMessagesRead(OWNER, FRIEND), 2);
  assert.deepEqual(await service.listFriendChatUnread(OWNER), [{ friend_id: FRIEND, unread_count: 3 }]);
  assert.deepEqual(calls, [
    ['get_friend_messages', { p_friend: FRIEND, p_before: cursor.created_at, p_before_id: MESSAGE_ID, p_limit: 40 }, OWNER],
    ['send_friend_message', { p_friend: FRIEND, p_body: 'Olá', p_client_nonce: NONCE }, OWNER],
    ['mark_friend_messages_read', { p_friend: FRIEND }, OWNER], ['list_friend_chat_unread', {}, OWNER],
  ]);
});

test('invalid IDs, cursor and messages fail before an RPC; sends must confirm the same nonce and text', async () => {
  let count = 0;
  const service = createFriendChatService({ rpc: async () => { count++; return [row({ sender_id: OWNER, recipient_id: FRIEND, body: 'different' })]; } });
  await assert.rejects(service.getFriendMessages('broken', FRIEND));
  await assert.rejects(service.getFriendMessages(OWNER, OWNER));
  await assert.rejects(service.getFriendMessages(OWNER, FRIEND, { created_at: 'bad', id: MESSAGE_ID }));
  await assert.rejects(service.sendFriendMessage(OWNER, FRIEND, ' ', NONCE));
  await assert.rejects(service.sendFriendMessage(OWNER, FRIEND, 'a'.repeat(1001), NONCE));
  await assert.rejects(service.sendFriendMessage(OWNER, FRIEND, 'text', 'invalid-nonce'));
  await assert.rejects(service.markFriendMessagesRead(OWNER, 'invalid-friend'));
  await assert.rejects(service.listFriendChatUnread('invalid-owner'));
  assert.equal(count, 0);
  await assert.rejects(service.sendFriendMessage(OWNER, FRIEND, 'text', NONCE), /confirmar/);
  assert.equal(count, 1);
});

test('the production RPC uses the session bearer and rejects a switched account before fetching history', async () => {
  const originals = new Map(['fetch', 'localStorage'].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const requests = [];
  globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  globalThis.fetch = async (url, options) => {
    requests.push({ url, options });
    if (url.endsWith('/auth/v1/token?grant_type=password')) return Response.json({ access_token: jwt(), refresh_token: 'fake-refresh', expires_in: 3600, user: { id: OWNER } });
    if (url.includes('/rest/v1/player_profiles?')) return Response.json([{ id: OWNER, nickname: 'Fake' }]);
    if (url.endsWith('/rest/v1/rpc/get_friend_messages')) return Response.json([row()]);
    if (url.endsWith('/auth/v1/logout')) return Response.json({});
    throw new Error('Unexpected request: ' + url);
  };
  try {
    await signOut(); await signIn('fake@example.test', 'fake-password');
    assert.equal((await getFriendMessages(OWNER, FRIEND)).length, 1);
    const request = requests.at(-1);
    assert.equal(request.url, `${SUPABASE_URL}/rest/v1/rpc/get_friend_messages`);
    assert.equal(request.options.headers.authorization, `Bearer ${jwt()}`);
    const before = requests.length;
    await assert.rejects(getFriendMessages(OUTSIDER, FRIEND), /conta correspondente/);
    assert.equal(requests.length, before);
  } finally {
    await signOut();
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name];
    }
  }
});

test('Realtime joins with the owner JWT and four participant filters, and refreshes credentials without sending bodies', async () => {
  let tokenNumber = 0;
  const f = harness({ tokenProvider: () => jwt(OWNER, BASE_TIME / 1000 + 36_000 + tokenNumber++) });
  const subscription = f.subscribe(); await flush();
  assert.deepEqual(f.statuses, ['reconnecting', 'connected']);
  assert.equal(f.sockets.length, 1);
  const socket = f.sockets[0], join = socket.sent[0];
  assert.equal(new URL(socket.url).searchParams.get('apikey'), SUPABASE_KEY);
  assert.equal(join.event, 'phx_join');
  assert.equal(join.payload.access_token, jwt());
  assert.equal(join.payload.config.broadcast, undefined);
  assert.deepEqual(join.payload.config.postgres_changes.map(binding => [binding.event, binding.filter]), [
    ['INSERT', `sender_id=eq.${OWNER}`], ['INSERT', `recipient_id=eq.${OWNER}`],
    ['UPDATE', `sender_id=eq.${OWNER}`], ['UPDATE', `recipient_id=eq.${OWNER}`],
  ]);
  await f.advance(10 * 60_000);
  assert.equal(socket.sent.filter(packet => packet.event === 'heartbeat').length, 24);
  assert.equal(socket.sent.filter(packet => packet.event === 'access_token').length, 1);
  assert.deepEqual(f.tokenCalls, [OWNER, OWNER]);
  assert(socket.sent.every(packet => !['broadcast', 'postgres_changes'].includes(packet.event) && !JSON.stringify(packet).includes('Oi!')));
  subscription.close(); subscription.close();
  assert.equal(socket.sent.at(-1).event, 'phx_leave'); assert.equal(socket.readyState, 3); assert.equal(f.timers.size, 0);
  const count = socket.sent.length; await f.advance(120_000); assert.equal(socket.sent.length, count);
});

test('only joined friend_messages changes with matching subscription IDs and valid participant rows reach callbacks', async () => {
  const f = harness({ autoJoin: false }); const subscription = f.subscribe(); await flush();
  const socket = f.sockets[0]; socket.change(row()); assert.equal(f.messages.length, 0);
  socket.joinReply();
  socket.change(row());
  socket.change(row({ sender_id: OWNER, recipient_id: FRIEND }), { ids: [41] });
  socket.change(row({ read_at: '2026-10-09T12:05:00Z' }), { type: 'UPDATE', ids: [44] });
  assert.deepEqual(f.messages.map(value => value.event), ['INSERT', 'INSERT', 'UPDATE']);
  socket.receive('invalid-json'); socket.receive(null);
  socket.change(row(), { ids: [999] });
  socket.change(row(), { ids: [41] }); // A recipient row cannot use the sender subscription.
  socket.change(row(), { ids: [44] }); // UPDATE IDs cannot authorize INSERT.
  socket.change(row(), { topic: 'realtime:public-chat' });
  socket.change(row(), { join_ref: 'old-connection' });
  socket.change(row(), { type: 'DELETE' });
  socket.change(row(), { payload: { ids: [42], data: { schema: 'public', table: 'other_table', type: 'INSERT', record: row() } } });
  socket.change(row(), { payload: { ids: [42], data: { schema: 'public', table: 'friend_messages', type: 'INSERT', record: row(), errors: ['denied'] } } });
  for (const bad of [row({ sender_id: OUTSIDER, recipient_id: FRIEND }), row({ recipient_id: FRIEND }),
    row({ id: 'broken' }), row({ body: '' }), row({ body: {} }), row({ body: 'a'.repeat(1001) }),
    row({ created_at: 'invalid' }), row({ read_at: false }), row({ client_nonce: undefined })]) socket.change(bad);
  socket.receive({ topic: socket.sent[0].topic, event: 'broadcast', payload: { event: 'message', payload: row() } });
  assert.equal(f.messages.length, 3);
  subscription.close(); socket.change(row()); assert.equal(f.messages.length, 3); assert.equal(f.timers.size, 0);
});

test('join replies must confirm every table, filter and unique subscription ID', async () => {
  const f = harness({ autoJoin: false }); const subscription = f.subscribe(); await flush();
  const socket = f.sockets[0], join = socket.sent[0];
  socket.joinReply({ payload: { status: 'ok', response: { postgres_changes: join.payload.config.postgres_changes.map((binding, i) => ({ ...binding, id: i + 41, table: i ? binding.table : 'other_table' })) } } });
  assert(!f.statuses.includes('connected')); assert.equal(socket.readyState, 3); assert.equal(f.timers.size, 1);
  subscription.close(); assert.equal(f.timers.size, 0);
});

test('reconnect obtains a fresh JWT; stale socket events and a late token after close are ignored', async () => {
  let nextToken = 0;
  const f = harness({ tokenProvider: () => jwt(OWNER, BASE_TIME / 1000 + 36_000 + nextToken++) });
  const subscription = f.subscribe(); await flush();
  const old = f.sockets[0], staleHandler = old.onmessage;
  old.drop(); assert.deepEqual(f.statuses, ['reconnecting', 'connected', 'reconnecting']);
  await f.advance(999); assert.equal(f.sockets.length, 1);
  await f.advance(1); assert.equal(f.sockets.length, 2);
  assert.equal(f.sockets[1].sent[0].payload.access_token, jwt(OWNER, BASE_TIME / 1000 + 36_001));
  assert.equal(f.tokenCalls.length, 2); assert.equal(f.statuses.at(-1), 'connected');
  staleHandler({ data: JSON.stringify({ topic: old.sent[0].topic, event: 'phx_error' }) });
  assert.equal(f.statuses.at(-1), 'connected');
  subscription.close(); assert.equal(f.timers.size, 0);
  let resolveToken;
  const waiting = harness({ tokenProvider: () => new Promise(resolve => { resolveToken = resolve; }) });
  const pending = waiting.subscribe(); await flush(); pending.close(); resolveToken(jwt()); await flush();
  assert.equal(waiting.sockets.length, 0); assert.equal(waiting.timers.size, 0);
});

test('missing heartbeat acknowledgements and join timeouts reconnect with capped backoff', async () => {
  const live = harness({ heartbeatReplies: false }); const liveSubscription = live.subscribe(); await flush();
  await live.advance(25_000); assert.equal(live.statuses.at(-1), 'connected');
  await live.advance(25_000); assert.equal(live.statuses.at(-1), 'reconnecting');
  liveSubscription.close(); assert.equal(live.timers.size, 0);
  const f = harness({ autoJoin: false }); const subscription = f.subscribe(); await flush();
  await f.advance(144_000);
  assert.equal(f.sockets.length, 7); // Initial connection plus six retries.
  assert.equal(f.statuses.at(-1), 'offline'); assert.equal(f.timers.size, 1);
  await f.advance(29_999); assert.equal(f.sockets.length, 7);
  await f.advance(1); assert.equal(f.sockets.length, 8);
  subscription.close(); assert.equal(f.timers.size, 0);
});

test('wrong-account, absent and expired JWTs never create a socket or fall back to the publishable key', async () => {
  for (const token of [jwt(OUTSIDER), '', SUPABASE_KEY, jwt(OWNER, BASE_TIME / 1000 - 1)]) {
    const f = harness({ tokenProvider: () => token }); const subscription = f.subscribe(); await flush();
    assert.equal(f.sockets.length, 0); assert.equal(f.statuses.at(-1), 'offline'); assert.equal(f.timers.size, 0);
    f.lifecycle.dispatchEvent(new Event('online')); await flush();
    assert.equal(f.sockets.length, 0); assert.equal(f.tokenCalls.length, 1);
    subscription.close(); assert.equal(f.onlineListeners.size, 0);
  }
});

test('a long server outage recovers automatically at 30-second intervals without an online event', async () => {
  let available = false;
  const attempts = [];
  const f = harness({ tokenProvider: () => {
    attempts.push(f.elapsed());
    if (!available) throw new Error('Network unavailable');
    return jwt();
  } });
  const subscription = f.subscribe(); await flush();
  await f.advance(170_000);
  assert.equal(f.statuses.at(-1), 'offline'); assert.equal(f.timers.size, 1); assert.equal(f.tokenCalls.length, 10);
  assert.deepEqual(attempts, [0, 1000, 3000, 7000, 15000, 30000, 60000, 90000, 120000, 150000]);
  assert.equal(f.onlineListeners.size, 1);
  available = true; await f.advance(9_999); assert.equal(f.sockets.length, 0);
  await f.advance(1);
  assert.equal(f.statuses.at(-1), 'connected'); assert.equal(f.sockets.length, 1); assert.equal(f.tokenCalls.length, 11);
  f.lifecycle.dispatchEvent(new Event('online')); await flush();
  assert.equal(f.sockets.length, 1); assert.equal(f.tokenCalls.length, 11);
  subscription.close(); assert.equal(f.onlineListeners.size, 0); assert.equal(f.timers.size, 0);
  f.lifecycle.dispatchEvent(new Event('online')); await flush();
  assert.equal(f.tokenCalls.length, 11);
});

test('browser online resumes an offline subscription immediately and replaces its scheduled retry', async () => {
  let available = false;
  const f = harness({ tokenProvider: () => {
    if (!available) throw new Error('Network unavailable');
    return jwt();
  } });
  const subscription = f.subscribe(); await flush(); await f.advance(70_000);
  assert.equal(f.statuses.at(-1), 'offline'); assert.equal(f.timers.size, 1); assert.equal(f.tokenCalls.length, 7);
  available = true; f.lifecycle.dispatchEvent(new Event('online')); await flush();
  assert.equal(f.statuses.at(-1), 'connected'); assert.equal(f.sockets.length, 1); assert.equal(f.tokenCalls.length, 8);
  await f.advance(30_000); assert.equal(f.sockets.length, 1); assert.equal(f.tokenCalls.length, 8);
  subscription.close(); assert.equal(f.onlineListeners.size, 0); assert.equal(f.timers.size, 0);
});
