import test from 'node:test';
import assert from 'node:assert/strict';
import { signIn, signOut } from '../../net/account.js';

const ALICE = 'a0000000-0000-4000-8000-000000000001';
const BOB = 'b0000000-0000-4000-8000-000000000002';
const PREFIX = 'rinha.profile.history.pending.';
const profileUrl = new URL('../../net/profile.js', import.meta.url);
let importNumber = 0;

const response = (status, value) => ({ ok: status >= 200 && status < 300, status, json: async () => value });
const payload = (match = 'match:stable', round = 1) => ({
  p_match_id: match, p_round: round, p_mode_id: 'ctf', p_map_id: 'dojo',
  p_ranked: true, p_outcome: 'win', p_stats: { eliminations: 4, deaths: 2, captures: 1 },
  p_summary: { capacity: 2, team: 'red', winner: 'red', scores: { red: 3, blue: 1 } },
});
const entry = value => ({ key: `${value.p_match_id}:round:${value.p_round}`, payload: value });
const ack = value => ({ recorded: true, match_id: entry(value).key, round: value.p_round });
const freshProfile = () => import(`${profileUrl.href}?history-queue-test=${++importNumber}`);
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

// Exercise the real account bearer/session path. Every fetch is intercepted;
// these tests never contact the configured Supabase project.
async function withQueue(run) {
  const previousFetch = globalThis.fetch;
  const previousStorage = globalThis.localStorage;
  const saved = new Map();
  const fixture = {
    saved, calls: [],
    rpc: async call => response(200, ack(call.body)),
    raw: owner => saved.get(PREFIX + owner.toLowerCase()) ?? null,
    entries(owner) { return this.raw(owner) === null ? [] : JSON.parse(this.raw(owner)).entries; },
    seed(owner, values) { saved.set(PREFIX + owner, JSON.stringify({ owner, entries: values.map(entry) })); },
    async login(owner) {
      const account = await signIn(owner === ALICE ? 'alice@example.test' : 'bob@example.test', 'password');
      assert.equal(account.user.id, owner);
    },
  };
  globalThis.localStorage = {
    getItem: key => saved.get(key) ?? null,
    setItem: (key, value) => saved.set(key, String(value)),
    removeItem: key => saved.delete(key),
  };
  globalThis.fetch = async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : null;
    if (url.includes('/auth/v1/token?grant_type=password')) {
      const owner = body.email === 'alice@example.test' ? ALICE : BOB;
      return response(200, {
        access_token: `token:${owner}`, refresh_token: `refresh:${owner}`, expires_in: 3600,
        user: { id: owner, email: body.email, user_metadata: { nickname: owner === ALICE ? 'Alice' : 'Bob' } },
      });
    }
    if (url.endsWith('/auth/v1/logout')) return response(204, null);
    if (url.includes('/rest/v1/player_profiles?')) {
      const owner = new URL(url).searchParams.get('id').slice(3);
      return response(200, [{ id: owner, nickname: owner === ALICE ? 'Alice' : 'Bob' }]);
    }
    if (url.endsWith('/rest/v1/rpc/record_player_match_history')) {
      const owner = options.headers.authorization.slice('Bearer token:'.length);
      const call = { body, owner, options, persisted: fixture.raw(owner) };
      fixture.calls.push(call);
      return fixture.rpc(call);
    }
    throw new Error(`Unexpected mocked request: ${url}`);
  };
  try {
    await fixture.login(ALICE);
    await run(await freshProfile(), fixture);
  } finally {
    await signOut();
    globalThis.fetch = previousFetch;
    globalThis.localStorage = previousStorage;
  }
}

test('503 preserves a complete payload before the RPC and a fresh module retries it', async () => {
  await withQueue(async (api, fixture) => {
    const value = payload('match:reload', 3);
    const original = structuredClone(value);
    fixture.rpc = async call => {
      assert.deepEqual(JSON.parse(call.persisted), { owner: ALICE, entries: [entry(original)] });
      assert.deepEqual(call.body, original);
      return response(503, { message: 'Temporarily unavailable' });
    };
    const attempt = api.recordPlayerMatchHistory(value, ALICE.toUpperCase());
    // The queue must own a snapshot even when the caller changes its objects.
    value.p_match_id = 'changed';
    value.p_stats.eliminations = 99;
    await assert.rejects(attempt, error => error.status === 503);
    assert.deepEqual(fixture.entries(ALICE), [entry(original)]);
    assert.equal(fixture.saved.has(PREFIX + ALICE.toUpperCase()), false);
    fixture.rpc = async call => response(200, { ...ack(call.body), source: 'profile_match_history', trusted: false });
    const reloaded = await freshProfile();
    assert.deepEqual(await reloaded.flushPlayerMatchHistory(ALICE), { sent: 1, pending: 0 });
    assert.deepEqual(fixture.calls.map(call => call.body), [original, original]);
    assert.equal(fixture.calls[1].options.headers.authorization, `Bearer token:${ALICE}`);
    assert.deepEqual(fixture.entries(ALICE), []);
  });
});

test('concurrent flushes share a promise, deduplicate rounds and send new entries sequentially', { timeout: 5000 }, async () => {
  await withQueue(async (api, fixture) => {
    const first = payload('match:series', 1), second = payload('match:series', 2);
    fixture.seed(ALICE, [first]);
    const started = deferred(), release = deferred();
    let active = 0, maxActive = 0;
    fixture.rpc = async call => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      try {
        if (call.body.p_round === 1) { started.resolve(); await release.promise; }
        return response(200, ack(call.body));
      } finally { active -= 1; }
    };
    const flush = api.flushPlayerMatchHistory(ALICE);
    const concurrent = api.flushPlayerMatchHistory(ALICE.toUpperCase());
    assert.equal(concurrent, flush);
    await started.promise;
    const repeatedFirst = api.recordPlayerMatchHistory(first, ALICE);
    const addedSecond = api.recordPlayerMatchHistory(second, ALICE);
    const repeatedSecond = api.recordPlayerMatchHistory({ ...second, p_outcome: 'loss' }, ALICE);
    try {
      assert.deepEqual(fixture.entries(ALICE), [entry(first), entry(second)]);
      assert.equal(fixture.calls.length, 1);
    } finally { release.resolve(); }
    const summaries = await Promise.all([flush, concurrent, repeatedFirst, addedSecond, repeatedSecond]);
    for (const summary of summaries) assert.deepEqual(summary, { sent: 2, pending: 0 });
    assert.equal(maxActive, 1);
    assert.deepEqual(fixture.calls.map(call => call.body), [first, second]);
    assert.deepEqual(fixture.entries(ALICE), []);
  });
});

test('a failed batch preserves only unacknowledged entries and retry starts at the pending round', async () => {
  await withQueue(async (api, fixture) => {
    const first = payload('match:batch', 1), second = payload('match:batch', 2);
    fixture.seed(ALICE, [first, second]);
    fixture.rpc = async call => call.body.p_round === 1
      ? response(200, ack(call.body)) : response(503, { message: 'Try again' });
    await assert.rejects(api.flushPlayerMatchHistory(ALICE), error => error.status === 503);
    assert.deepEqual(fixture.entries(ALICE), [entry(second)]);
    fixture.rpc = async call => response(200, ack(call.body));
    assert.deepEqual(await api.flushPlayerMatchHistory(ALICE), { sent: 1, pending: 0 });
    assert.deepEqual(fixture.calls.map(call => call.body.p_round), [1, 2, 2]);
    const calls = fixture.calls.length;
    assert.deepEqual(await api.flushPlayerMatchHistory(ALICE), { sent: 0, pending: 0 });
    assert.equal(fixture.calls.length, calls);
  });
});

test('a successful HTTP response removes nothing without the exact recorded match and numeric round', async t => {
  const value = payload('match:ack', 7);
  const cases = [
    ['missing response', null],
    ['missing recorded flag', { match_id: entry(value).key, round: 7 }],
    ['false recorded flag', { ...ack(value), recorded: false }],
    ['truthy recorded flag', { ...ack(value), recorded: 'true' }],
    ['raw match ID', { ...ack(value), match_id: value.p_match_id }],
    ['another match', { ...ack(value), match_id: 'another:round:7' }],
    ['another round', { ...ack(value), round: 8 }],
    ['string round', { ...ack(value), round: '7' }],
  ];
  for (const [name, result] of cases) await t.test(name, async () => {
    await withQueue(async (api, fixture) => {
      fixture.seed(ALICE, [value]);
      const before = fixture.raw(ALICE);
      fixture.rpc = async () => response(200, result);
      await assert.rejects(api.flushPlayerMatchHistory(ALICE), /confirm/i);
      assert.equal(fixture.raw(ALICE), before);
      assert.equal(fixture.calls.length, 1);
      fixture.rpc = async call => response(200, ack(call.body));
      assert.deepEqual(await api.flushPlayerMatchHistory(ALICE), { sent: 1, pending: 0 });
    });
  });
});

test('malformed local storage is rejected without erasing bytes or calling the RPC', async t => {
  const value = payload('match:corrupt');
  const validEntry = entry(value);
  const cases = [
    ['invalid JSON', '{broken'],
    ['null envelope', 'null'],
    ['missing entries', JSON.stringify({ owner: ALICE })],
    ['non-array entries', JSON.stringify({ owner: ALICE, entries: {} })],
    ['null entry', JSON.stringify({ owner: ALICE, entries: [null] })],
    ['wrong entry key', JSON.stringify({ owner: ALICE, entries: [{ ...validEntry, key: 'wrong' }] })],
    ['invalid entry payload', JSON.stringify({ owner: ALICE, entries: [{ key: 'bad:round:0', payload: payload('bad', 0) }] })],
    ['duplicate entries', JSON.stringify({ owner: ALICE, entries: [validEntry, validEntry] })],
    ['oversized queue', JSON.stringify({ owner: ALICE, entries: Array.from({ length: 51 }, (_, i) => entry(payload(`match:${i}`))) })],
  ];
  for (const [name, raw] of cases) await t.test(name, async () => {
    await withQueue(async (api, fixture) => {
      fixture.saved.set(PREFIX + ALICE, raw);
      await assert.rejects(async () => api.flushPlayerMatchHistory(ALICE));
      assert.equal(fixture.raw(ALICE), raw);
      await assert.rejects(async () => api.recordPlayerMatchHistory(payload('match:new'), ALICE));
      assert.equal(fixture.raw(ALICE), raw);
      assert.equal(fixture.calls.length, 0);
    });
  });
});

test('an envelope belonging to another owner is rejected and preserved', async () => {
  await withQueue(async (api, fixture) => {
    const raw = JSON.stringify({ owner: BOB, entries: [entry(payload('match:bob'))] });
    fixture.saved.set(PREFIX + ALICE, raw);
    await assert.rejects(api.flushPlayerMatchHistory(ALICE));
    await assert.rejects(api.recordPlayerMatchHistory(payload('match:alice'), ALICE));
    assert.equal(fixture.raw(ALICE), raw);
    assert.equal(fixture.raw(BOB), null);
    assert.equal(fixture.calls.length, 0);
  });
});

test('invalid owners and match identities cannot create queues or send requests', async () => {
  await withQueue(async (api, fixture) => {
    const before = [...fixture.saved];
    for (const owner of [undefined, null, '', 'alice', '../other', 123, `${ALICE} `]) {
      await assert.rejects(async () => api.flushPlayerMatchHistory(owner));
      await assert.rejects(async () => api.recordPlayerMatchHistory(payload(), owner));
    }
    const invalidPayloads = [null, [], {}, ...['', 'space id', 'slash/id', 'x'.repeat(161)].map(id => payload(id)),
      ...[0, -1, 1.5, 1001, '1', null, NaN, Infinity].map(round => payload('match:invalid', round))];
    for (const value of invalidPayloads) await assert.rejects(async () => api.recordPlayerMatchHistory(value, ALICE));
    assert.deepEqual([...fixture.saved], before);
    assert.equal(fixture.calls.length, 0);
  });
});

test('valid match ID punctuation and maximum ID/round boundaries are accepted', async () => {
  await withQueue(async (api, fixture) => {
    for (const value of [payload('A0._:-'), payload('x'.repeat(160), 1000)]) {
      assert.deepEqual(await api.recordPlayerMatchHistory(value, ALICE), { sent: 1, pending: 0 });
    }
    assert.equal(fixture.calls.length, 2);
    assert.deepEqual(fixture.entries(ALICE), []);
  });
});

test('50 failed records remain intact and a newer record cannot evict them', async () => {
  await withQueue(async (api, fixture) => {
    fixture.rpc = async () => response(503, { message: 'Offline' });
    const values = Array.from({ length: 50 }, (_, i) => payload(`match:offline:${i}`, i + 1));
    for (const value of values) await assert.rejects(api.recordPlayerMatchHistory(value, ALICE), error => error.status === 503);
    assert.deepEqual(fixture.entries(ALICE), values.map(entry));
    const before = fixture.raw(ALICE), calls = fixture.calls.length;
    await assert.rejects(api.recordPlayerMatchHistory(payload('match:overflow'), ALICE), /50/);
    assert.equal(fixture.raw(ALICE), before);
    assert.equal(fixture.calls.length, calls);
    // Retrying an existing round is permitted even when all slots are occupied.
    await assert.rejects(api.recordPlayerMatchHistory(values[49], ALICE), error => error.status === 503);
    assert.equal(fixture.raw(ALICE), before);
    fixture.rpc = async call => response(200, ack(call.body));
    assert.deepEqual(await api.flushPlayerMatchHistory(ALICE), { sent: 50, pending: 0 });
    assert.deepEqual(fixture.calls.slice(-50).map(call => call.body), values);
    assert.deepEqual(fixture.entries(ALICE), []);
  });
});

test('a storage write failure rejects before sending a match', async () => {
  await withQueue(async (api, fixture) => {
    const setItem = globalThis.localStorage.setItem;
    globalThis.localStorage.setItem = (key, value) => {
      if (key.startsWith(PREFIX)) throw new Error('Storage quota exceeded');
      return setItem(key, value);
    };
    await assert.rejects(api.recordPlayerMatchHistory(payload('match:quota'), ALICE), /quota/);
    assert.equal(fixture.raw(ALICE), null);
    assert.equal(fixture.calls.length, 0);
  });
});

test('an account cannot send another account\'s pending history', async () => {
  await withQueue(async (api, fixture) => {
    fixture.seed(ALICE, [payload('match:alice-private')]);
    const pending = fixture.raw(ALICE);
    await fixture.login(BOB);
    const calls = fixture.calls.length;
    await assert.rejects(api.flushPlayerMatchHistory(ALICE), /conta correspondente/);
    assert.equal(fixture.raw(ALICE), pending);
    assert.equal(fixture.calls.length, calls);
  });
});

test('switching between real mocked account sessions flushes only that owner queue', async () => {
  await withQueue(async (api, fixture) => {
    const aliceMatch = payload('match:alice'), bobMatch = payload('match:bob');
    fixture.rpc = async () => response(503, { message: 'Offline' });
    await assert.rejects(api.recordPlayerMatchHistory(aliceMatch, ALICE), error => error.status === 503);
    const alicePending = fixture.raw(ALICE);
    await fixture.login(BOB);
    const calls = fixture.calls.length;
    assert.deepEqual(await api.flushPlayerMatchHistory(BOB), { sent: 0, pending: 0 });
    assert.equal(fixture.calls.length, calls);
    assert.equal(fixture.raw(ALICE), alicePending);
    await assert.rejects(api.recordPlayerMatchHistory(bobMatch, BOB), error => error.status === 503);
    const bobPending = fixture.raw(BOB);
    assert.equal(fixture.raw(ALICE), alicePending);
    fixture.rpc = async call => response(200, ack(call.body));
    await fixture.login(ALICE);
    assert.deepEqual(await api.flushPlayerMatchHistory(ALICE), { sent: 1, pending: 0 });
    assert.equal(fixture.calls.at(-1).owner, ALICE);
    assert.deepEqual(fixture.calls.at(-1).body, aliceMatch);
    assert.equal(fixture.raw(BOB), bobPending);
    await fixture.login(BOB);
    assert.deepEqual(await api.flushPlayerMatchHistory(BOB), { sent: 1, pending: 0 });
    assert.equal(fixture.calls.at(-1).owner, BOB);
    assert.deepEqual(fixture.calls.at(-1).body, bobMatch);
    assert.deepEqual(fixture.entries(ALICE), []);
    assert.deepEqual(fixture.entries(BOB), []);
  });
});
