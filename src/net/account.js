import { SUPABASE_KEY, SUPABASE_URL } from './supabase.js';

const SESSION_KEY = 'rinha.auth.session';
let activeSession = null;

async function request(path, { method = 'GET', body, token, headers = {} } = {}) {
  const response = await fetch(`${SUPABASE_URL}${path}`, {
    method,
    headers: {
      apikey: SUPABASE_KEY,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const result = response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok) throw new Error(result?.msg || result?.message || result?.error_description || `Erro ${response.status}`);
  return result;
}

function rememberSession(session) {
  activeSession = session;
  if (session) localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  else localStorage.removeItem(SESSION_KEY);
  return session;
}

async function refreshSession(session) {
  if (!session?.refresh_token) return null;
  const fresh = await request('/auth/v1/token?grant_type=refresh_token', {
    method: 'POST', body: { refresh_token: session.refresh_token },
  });
  return rememberSession(fresh);
}

export async function restoreSession() {
  let saved;
  try { saved = JSON.parse(localStorage.getItem(SESSION_KEY)); } catch { return null; }
  if (!saved?.access_token) return null;
  const expiresAt = Number(saved.expires_at) || 0;
  const session = expiresAt > Date.now() / 1000 + 60 ? rememberSession(saved) : await refreshSession(saved).catch(() => null);
  if (!session) return null;
  try {
    const user = await request('/auth/v1/user', { token: session.access_token });
    return loadAccount(user, session);
  } catch {
    rememberSession(null);
    return null;
  }
}

export async function signIn(email, password) {
  const session = await request('/auth/v1/token?grant_type=password', {
    method: 'POST', body: { email: email.trim(), password },
  });
  rememberSession(session);
  return loadAccount(session.user, session);
}

export async function signUp({ nickname, email, password }) {
  const result = await request('/auth/v1/signup', {
    method: 'POST',
    body: { email: email.trim(), password, data: { nickname: nickname.trim() } },
  });
  if (!result.access_token) return { confirmationRequired: true };
  rememberSession(result);
  return loadAccount(result.user, result);
}

export function requestPasswordReset(email) {
  return request('/auth/v1/recover', { method: 'POST', body: { email: email.trim() } });
}

async function loadAccount(user, session) {
  const rows = await request(`/rest/v1/player_profiles?id=eq.${encodeURIComponent(user.id)}&select=*`, {
    token: session.access_token,
  });
  let playerProfile = rows?.[0];
  if (!playerProfile) {
    const nickname = String(user.user_metadata?.nickname || user.email?.split('@')[0] || 'Jogador').slice(0, 12);
    const created = await request('/rest/v1/player_profiles', {
      method: 'POST', token: session.access_token,
      headers: { Prefer: 'return=representation' },
      body: { id: user.id, nickname, avatar: 'avatar-1.webp' },
    });
    playerProfile = created?.[0];
  }
  return { user, session, profile: playerProfile };
}

export async function saveAccountProfile(profile) {
  if (!activeSession?.access_token || !profile?.playerId) return;
  return request(`/rest/v1/player_profiles?id=eq.${encodeURIComponent(profile.playerId)}`, {
    method: 'PATCH', token: activeSession.access_token,
    body: {
      nickname: String(profile.name || 'Jogador').slice(0, 12),
      gold: Math.max(0, Math.floor(Number(profile.gold) || 0)),
      rank_points: Math.max(0, Math.floor(Number(profile.rankXp) || 0)),
      matches: Math.max(0, Math.floor(Number(profile.rankStats?.matches) || 0)),
      wins: Math.max(0, Math.floor(Number(profile.rankStats?.wins) || 0)),
      losses: Math.max(0, Math.floor(Number(profile.rankStats?.losses) || 0)),
      avatar: profile.cos?.avatar || 'avatar-1.webp',
      hat: profile.hat || profile.cos?.hat || 'crown',
      skin: profile.skin || profile.cos?.skin || '#bdaee6',
      friendly_fire: Boolean(profile.friendlyFire),
      updated_at: new Date().toISOString(),
    },
  });
}
