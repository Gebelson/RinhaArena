import { authenticatedRpc, ensureAccessToken } from './account.js';
import { SUPABASE_KEY, SUPABASE_URL } from './supabase.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/;
const RETRY_DELAYS = [1_000, 2_000, 4_000, 8_000, 15_000, 30_000];
export const FRIEND_CHAT_MAX_LENGTH = 1000;

function uuid(value) {
  if (typeof value !== 'string' || !UUID.test(value)) throw new Error('Conta ou conversa inválida.');
  return value.toLowerCase();
}
const validTimestamp = value => typeof value === 'string' && TIMESTAMP.test(value) && Number.isFinite(Date.parse(value));
function participants(owner, friend) {
  const pair = [uuid(owner), uuid(friend)];
  if (pair[0] === pair[1]) throw new Error('Escolha um amigo para conversar.');
  return pair;
}
function messageRow(row, owner, friend = null) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
  if (![row.id, row.sender_id, row.recipient_id, row.client_nonce].every(value => typeof value === 'string' && UUID.test(value))) return null;
  const sender = row.sender_id.toLowerCase(), recipient = row.recipient_id.toLowerCase();
  if (sender === recipient || (sender !== owner && recipient !== owner)) return null;
  if (friend && (sender === owner ? recipient : sender) !== friend) return null;
  if (typeof row.body !== 'string' || !row.body.trim() || [...row.body].length > FRIEND_CHAT_MAX_LENGTH) return null;
  if (!validTimestamp(row.created_at) || !(row.read_at === null || validTimestamp(row.read_at))) return null;
  return { id: row.id.toLowerCase(), sender_id: sender, recipient_id: recipient, body: row.body,
    client_nonce: row.client_nonce.toLowerCase(), created_at: row.created_at, read_at: row.read_at };
}
function chronological(a, b) {
  const milliseconds = Date.parse(a.created_at) - Date.parse(b.created_at);
  if (milliseconds) return milliseconds;
  const fraction = timestamp => (timestamp.match(/\.(\d+)/)?.[1] || '').padEnd(6, '0');
  return fraction(a.created_at).localeCompare(fraction(b.created_at)) || a.id.localeCompare(b.id);
}

// Inject dependencies for deterministic tests; production always uses account.js credentials.
export function createFriendChatService(options = {}) {
  const rpc = options.rpc || authenticatedRpc;
  const tokenProvider = options.tokenProvider || ensureAccessToken;
  const timers = options.timers || globalThis;
  const now = options.now || Date.now;

  async function getFriendMessages(owner, friend, cursor = null, limit = 40) {
    [owner, friend] = participants(owner, friend);
    if (cursor && (!validTimestamp(cursor.created_at) || typeof cursor.id !== 'string' || !UUID.test(cursor.id))) throw new Error('Página de conversa inválida.');
    const pageSize = Math.max(1, Math.min(100, Math.floor(Number(limit) || 40)));
    const rows = await rpc('get_friend_messages', { p_friend: friend, p_before: cursor?.created_at || null,
      p_before_id: cursor ? uuid(cursor.id) : null, p_limit: pageSize }, owner);
    return (Array.isArray(rows) ? rows : []).map(row => messageRow(row, owner, friend)).filter(Boolean).sort(chronological).slice(-pageSize);
  }
  async function sendFriendMessage(owner, friend, body, nonce) {
    [owner, friend] = participants(owner, friend);
    if (typeof body !== 'string' || !body.trim() || [...body.trim()].length > FRIEND_CHAT_MAX_LENGTH) throw new Error('Escreva uma mensagem de até 1000 caracteres.');
    nonce = uuid(nonce);
    const result = await rpc('send_friend_message', { p_friend: friend, p_body: body.trim(), p_client_nonce: nonce }, owner);
    const row = messageRow(Array.isArray(result) ? result[0] : result, owner, friend);
    if (!row || row.sender_id !== owner || row.client_nonce !== nonce || row.body !== body.trim()) throw new Error('Não foi possível confirmar a mensagem.');
    return row;
  }
  async function markFriendMessagesRead(owner, friend) {
    [owner, friend] = participants(owner, friend);
    return rpc('mark_friend_messages_read', { p_friend: friend }, owner);
  }
  async function listFriendChatUnread(owner) {
    owner = uuid(owner);
    const rows = await rpc('list_friend_chat_unread', {}, owner);
    return (Array.isArray(rows) ? rows : []).filter(row => row && typeof row.friend_id === 'string' && UUID.test(row.friend_id)
      && row.friend_id.toLowerCase() !== owner && Number.isSafeInteger(Number(row.unread_count)) && Number(row.unread_count) > 0)
      .map(row => ({ friend_id: row.friend_id.toLowerCase(), unread_count: Number(row.unread_count) }));
  }

  function subscribeFriendMessages(owner, { onMessage, onStatus } = {}) {
    owner = uuid(owner);
    const Socket = options.WebSocket || globalThis.WebSocket;
    const lifecycle = options.eventTarget ?? globalThis.window;
    const topic = `realtime:friend-messages:${owner}`;
    const subscriptions = ['INSERT', 'UPDATE'].flatMap(event => ['sender_id', 'recipient_id'].map(column => ({
      event, schema: 'public', table: 'friend_messages', filter: `${column}=eq.${owner}`,
    })));
    let closed = false, generation = 0, ref = 0, failures = 0, socket = null, status = null, terminalOffline = false;
    let retryTimer = null, connectTimer = null, heartbeatTimer = null, refreshTimer = null;
    let joinRef = null, heartbeatRef = null, bindings = new Map(), joined = false;
    const emitStatus = (next, error) => {
      if (closed || status === next) return;
      status = next;
      try { onStatus?.(next, error); } catch { /* UI callbacks cannot interrupt cleanup. */ }
    };
    const clearTimers = () => {
      timers.clearTimeout(retryTimer); timers.clearTimeout(connectTimer);
      timers.clearInterval(heartbeatTimer); timers.clearInterval(refreshTimer);
      retryTimer = connectTimer = heartbeatTimer = refreshTimer = null;
    };
    const detach = () => {
      const oldSocket = socket;
      socket = null; joined = false; bindings.clear(); heartbeatRef = null;
      if (oldSocket) {
        oldSocket.onopen = oldSocket.onmessage = oldSocket.onclose = oldSocket.onerror = null;
        try { oldSocket.close(); } catch { /* Already closed. */ }
      }
    };
    const fail = (error, terminal = false) => {
      if (closed) return;
      generation++; clearTimers(); detach();
      terminalOffline = terminal;
      if (terminal) { emitStatus('offline', error); return; }
      emitStatus(failures >= RETRY_DELAYS.length ? 'offline' : 'reconnecting', error);
      const delay = RETRY_DELAYS[Math.min(failures, RETRY_DELAYS.length - 1)];
      failures = Math.min(failures + 1, RETRY_DELAYS.length);
      retryTimer = timers.setTimeout(() => { retryTimer = null; void connect(); }, delay);
    };
    const push = (event, payload, pushTopic = topic, pushJoinRef = joinRef) => {
      if (!socket || socket.readyState !== (Socket?.OPEN ?? 1)) return null;
      const nextRef = String(++ref);
      socket.send(JSON.stringify({ topic: pushTopic, event, payload, ref: nextRef, join_ref: pushJoinRef }));
      return nextRef;
    };
    const ownedToken = async () => {
      const token = await tokenProvider(owner);
      let claims;
      try {
        if (typeof token !== 'string' || token.split('.').length !== 3) throw new Error();
        const encoded = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
        claims = JSON.parse(globalThis.atob(encoded.padEnd(Math.ceil(encoded.length / 4) * 4, '=')));
      } catch { throw Object.assign(new Error('Sua sessão expirou. Entre novamente.'), { terminal: true }); }
      if (typeof claims.sub !== 'string' || claims.sub.toLowerCase() !== owner
        || !Number.isFinite(claims.exp) || claims.exp * 1000 <= now()) {
        throw Object.assign(new Error('Entre na conta correspondente para conversar.'), { terminal: true });
      }
      return token;
    };
    const refreshToken = async version => {
      try {
        const token = await ownedToken();
        if (closed || version !== generation || !joined) return;
        if (!push('access_token', { access_token: token })) fail(new Error('Conexão interrompida.'));
      } catch (error) { if (!closed && version === generation) fail(error, error.terminal); }
    };
    async function connect() {
      if (closed) return;
      if (!Socket) { emitStatus('offline', new Error('Conexão em tempo real indisponível.')); return; }
      const version = ++generation;
      emitStatus('reconnecting');
      connectTimer = timers.setTimeout(() => { if (version === generation) fail(new Error('A conexão demorou demais.')); }, 12_000);
      try {
        const token = await ownedToken();
        if (closed || version !== generation) return;
        const ws = new Socket(SUPABASE_URL.replace(/^http/, 'ws')
          + `/realtime/v1/websocket?apikey=${encodeURIComponent(SUPABASE_KEY)}&vsn=1.0.0`);
        socket = ws;
        const current = () => !closed && generation === version && socket === ws;
        ws.onopen = () => {
          if (!current()) return;
          try {
            joinRef = String(++ref);
            // Postgres Changes authorization comes from the JWT and table RLS.
            // No message body is ever sent through the public broadcast transport.
            ws.send(JSON.stringify({ topic, event: 'phx_join', ref: joinRef, join_ref: joinRef,
              payload: { access_token: token, config: { postgres_changes: subscriptions, presence: { enabled: false } } } }));
          } catch (error) { fail(error); }
        };
        ws.onmessage = event => {
          if (!current()) return;
          let packet;
          try { packet = JSON.parse(event.data); } catch { return; }
          if (!packet || typeof packet !== 'object') return;
          if (packet.topic === 'phoenix' && packet.event === 'phx_reply' && packet.ref === heartbeatRef) {
            if (packet.payload?.status === 'ok') heartbeatRef = null;
            else fail(new Error('Conexão interrompida.'));
            return;
          }
          if (packet.topic !== topic || (packet.join_ref && packet.join_ref !== joinRef)) return;
          if (packet.event === 'phx_reply' && packet.ref === joinRef && !joined) {
            const confirmed = packet.payload?.response?.postgres_changes;
            const nextBindings = new Map();
            if (packet.payload?.status === 'ok' && Array.isArray(confirmed) && confirmed.length === subscriptions.length) {
              for (const wanted of subscriptions) {
                const match = confirmed.find(binding => binding && ['event', 'schema', 'table', 'filter'].every(key => binding[key] === wanted[key]));
                if (match && ((typeof match.id === 'number' && Number.isFinite(match.id)) || (typeof match.id === 'string' && match.id))) {
                  nextBindings.set(String(match.id), wanted);
                }
              }
            }
            if (nextBindings.size !== subscriptions.length) { fail(new Error('Canal de conversa recusado.')); return; }
            bindings = nextBindings; joined = true; failures = 0;
            timers.clearTimeout(connectTimer); connectTimer = null;
            heartbeatTimer = timers.setInterval(() => {
              if (!current()) return;
              if (heartbeatRef) { fail(new Error('Conexão interrompida.')); return; }
              try {
                heartbeatRef = push('heartbeat', {}, 'phoenix', null);
                if (!heartbeatRef) fail(new Error('Conexão interrompida.'));
              }
              catch (error) { fail(error); }
            }, 25_000);
            refreshTimer = timers.setInterval(() => { void refreshToken(version); }, 10 * 60_000);
            emitStatus('connected');
          } else if (packet.event === 'postgres_changes' && joined) {
            const data = packet.payload?.data, ids = packet.payload?.ids;
            if (!Array.isArray(ids) || data?.schema !== 'public' || data?.table !== 'friend_messages'
              || !['INSERT', 'UPDATE'].includes(data.type) || (data.errors && (!Array.isArray(data.errors) || data.errors.length))) return;
            const row = messageRow(data.record, owner);
            if (!row || !ids.some(id => {
              const binding = bindings.get(String(id));
              return binding?.event === data.type && row[binding.filter.split('=')[0]] === owner;
            })) return;
            try { onMessage?.(row, data.type); } catch { /* The channel stays usable if a UI callback fails. */ }
          } else if (packet.event === 'phx_error' || packet.event === 'phx_close'
            || (packet.event === 'system' && packet.payload?.status === 'error')) {
            fail(new Error('Canal de conversa interrompido.'));
          }
        };
        ws.onerror = () => { if (current()) fail(new Error('Não foi possível conectar.')); };
        ws.onclose = () => { if (current()) fail(new Error('Conexão encerrada.')); };
      } catch (error) { if (!closed && version === generation) fail(error, error.terminal); }
    }
    const resumeOnline = () => {
      if (closed || terminalOffline || status !== 'offline') return;
      timers.clearTimeout(retryTimer); retryTimer = null;
      failures = 0;
      void connect();
    };
    lifecycle?.addEventListener?.('online', resumeOnline);
    void connect();
    return { close() {
      if (closed) return;
      closed = true; generation++; clearTimers();
      lifecycle?.removeEventListener?.('online', resumeOnline);
      try { if (joined) push('phx_leave', {}); } catch { /* Already closed. */ }
      detach();
    } };
  }
  return { getFriendMessages, sendFriendMessage, markFriendMessagesRead, listFriendChatUnread, subscribeFriendMessages };
}

const service = createFriendChatService();
export const getFriendMessages = (...args) => service.getFriendMessages(...args);
export const sendFriendMessage = (...args) => service.sendFriendMessage(...args);
export const markFriendMessagesRead = (...args) => service.markFriendMessagesRead(...args);
export const listFriendChatUnread = (...args) => service.listFriendChatUnread(...args);
export const subscribeFriendMessages = (...args) => service.subscribeFriendMessages(...args);
