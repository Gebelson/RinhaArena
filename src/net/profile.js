import { authenticatedRpc, ensureAccessToken } from './account.js';
import { SUPABASE_KEY, SUPABASE_URL } from './supabase.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const AVATAR = /^(?:avatar-([1-9]|10)[.]webp|uploaded:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}[.]webp)$/;
const MAX_AVATAR_BYTES = 256 * 1024;
const HISTORY_QUEUE_PREFIX = 'rinha.profile.history.pending.';
const MAX_PENDING_HISTORY = 50;
const MATCH_ID = /^[A-Za-z0-9._:-]{1,160}$/;
const historyFlushes = new Map();

function verifyUUID(value) {
  if (typeof value !== 'string' || !UUID.test(value)) throw new Error('Jogador inválido.');
  return value.toLowerCase();
}

function historyKey(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)
    || typeof payload.p_match_id !== 'string' || !MATCH_ID.test(payload.p_match_id)
    || !Number.isInteger(payload.p_round) || payload.p_round < 1 || payload.p_round > 1000) {
    throw new Error('Partida inválida para o histórico.');
  }
  return `${payload.p_match_id}:round:${payload.p_round}`;
}

function historyStorage() {
  if (!globalThis.localStorage) throw new Error('Não foi possível salvar o histórico neste dispositivo.');
  return globalThis.localStorage;
}

function readPendingHistory(owner) {
  const raw = historyStorage().getItem(HISTORY_QUEUE_PREFIX + owner);
  if (raw === null) return [];
  let queue;
  try { queue = JSON.parse(raw); } catch {
    throw new Error('O histórico pendente deste jogador está inválido.');
  }
  if (!queue || queue.owner !== owner || !Array.isArray(queue.entries) || queue.entries.length > MAX_PENDING_HISTORY) {
    throw new Error('O histórico pendente deste jogador está inválido.');
  }
  const keys = new Set();
  for (const entry of queue.entries) {
    if (!entry || entry.key !== historyKey(entry.payload) || keys.has(entry.key)) {
      throw new Error('O histórico pendente deste jogador está inválido.');
    }
    keys.add(entry.key);
  }
  return queue.entries;
}

function savePendingHistory(owner, entries) {
  const storage = historyStorage();
  const key = HISTORY_QUEUE_PREFIX + owner;
  if (entries.length) storage.setItem(key, JSON.stringify({ owner, entries }));
  else storage.removeItem(key);
}

async function sendPendingHistory(owner) {
  let sent = 0;
  while (true) {
    const entry = readPendingHistory(owner)[0];
    if (!entry) return { sent, pending: 0 };
    const record = await authenticatedRpc('record_player_match_history', entry.payload, owner);
    if (record?.recorded !== true || record.match_id !== entry.key || record.round !== entry.payload.p_round) {
      throw new Error('O servidor ainda não confirmou o registro da partida.');
    }
    // Re-read after the request so a match enqueued while it was in flight survives.
    const entries = readPendingHistory(owner);
    savePendingHistory(owner, entries.filter(pending => pending.key !== entry.key));
    sent += 1;
  }
}

// The caller supplies the authenticated player's UUID; each owner has separate storage.
export function flushPlayerMatchHistory(playerId) {
  let owner;
  try { owner = verifyUUID(playerId); } catch (error) { return Promise.reject(error); }
  if (historyFlushes.has(owner)) return historyFlushes.get(owner);
  const promise = Promise.resolve().then(() => sendPendingHistory(owner)).finally(() => historyFlushes.delete(owner));
  historyFlushes.set(owner, promise);
  return promise;
}

export async function recordPlayerMatchHistory(payload, playerId) {
  const owner = verifyUUID(playerId);
  const key = historyKey(payload);
  const entries = readPendingHistory(owner);
  if (!entries.some(entry => entry.key === key)) {
    if (entries.length >= MAX_PENDING_HISTORY) {
      throw new Error('O histórico já tem 50 partidas pendentes. Sincronize antes de registrar outra.');
    }
    // Snapshot before sending: caller mutations and failed requests cannot lose the match.
    const savedPayload = JSON.parse(JSON.stringify(payload));
    historyKey(savedPayload);
    savePendingHistory(owner, [...entries, { key, payload: savedPayload }]);
  }
  return flushPlayerMatchHistory(owner);
}

export const fetchPlayerProfile = playerId => authenticatedRpc('get_player_profile', { p_player_id: verifyUUID(playerId) });

// null means that this player's history is private or unavailable; [] means no matches.
export const fetchPlayerHistory = (playerId, limit = 50) => authenticatedRpc('get_player_match_history', {
  p_player_id: verifyUUID(playerId), p_limit: Math.max(1, Math.min(50, Math.trunc(Number(limit) || 50))),
});

export async function savePlayerPresentation({ nickname, avatar, bio = '', banner = 'character', characterId, historyPublic = false }) {
  nickname = String(nickname ?? '').trim();
  bio = String(bio ?? '').trim();
  if ([...nickname].length < 2 || [...nickname].length > 12 || /^player(?:\s*\d+)?$/i.test(nickname) || /^(unknown|guest)$/i.test(nickname)) {
    throw new Error('Use um nome válido com 2 a 12 caracteres.');
  }
  if (!AVATAR.test(String(avatar ?? ''))) throw new Error('Avatar inválido.');
  if ([...bio].length > 160) throw new Error('A biografia pode ter até 160 caracteres.');
  if (!['character', 'ocean', 'sunset', 'forest'].includes(banner)) throw new Error('Capa inválida.');
  return authenticatedRpc('update_player_presentation', {
    p_nickname: nickname, p_avatar: avatar, p_bio: bio, p_banner: banner,
    p_character_id: characterId, p_history_public: Boolean(historyPublic),
  });
}

// The editor converts/crops images before this boundary. Storage also enforces
// MIME and size limits, and RLS binds the immutable path to the authenticated user.
export async function uploadProfileAvatar(blob, playerId) {
  const owner = verifyUUID(playerId);
  if (!(blob instanceof Blob) || blob.type !== 'image/webp' || blob.size < 12 || blob.size > MAX_AVATAR_BYTES) {
    throw new Error('A foto deve ser WebP e ter no máximo 256 KB.');
  }
  const signature = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
  if (String.fromCharCode(...signature.slice(0, 4)) !== 'RIFF' || String.fromCharCode(...signature.slice(8, 12)) !== 'WEBP') {
    throw new Error('A foto WebP é inválida. Escolha a imagem novamente.');
  }
  const path = `${owner}/${crypto.randomUUID()}.webp`;
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await ensureAccessToken();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    let response, value;
    try {
      response = await fetch(`${SUPABASE_URL}/storage/v1/object/profile-avatars/${path}`, {
        method: 'POST', body: blob, signal: controller.signal,
        headers: { apikey: SUPABASE_KEY, authorization: `Bearer ${token}`,
          'content-type': 'image/webp', 'x-upsert': 'false', 'cache-control': '31536000' },
      });
      value = await response.json().catch(() => null);
    } catch (error) {
      throw new Error(error.name === 'AbortError'
        ? 'O envio da foto demorou demais. Tente novamente.'
        : 'Não foi possível enviar a foto. Verifique sua internet.');
    } finally { clearTimeout(timer); }
    if (response.status === 401 && attempt === 0) {
      // Shared account RPC requests refresh an expired/rejected bearer once.
      await fetchPlayerProfile(owner);
      continue;
    }
    if (!response.ok) {
      if (response.status === 401) throw new Error('Sua sessão expirou. Entre novamente para enviar a foto.');
      if (response.status === 413) throw new Error('A foto deve ter no máximo 256 KB.');
      if (response.status === 403) throw new Error('Não foi possível enviar esta foto para o seu perfil.');
      throw new Error(String(value?.message || value?.error || 'Não foi possível enviar a foto. Tente novamente.'));
    }
    return `uploaded:${path}`;
  }
}
