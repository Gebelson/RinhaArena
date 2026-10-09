import { SUPABASE_KEY, SUPABASE_URL } from './supabase.js';

const SESSION_KEY = 'rinha.auth.session';
const AUTH_RETURN_URL = 'https://rinhaarena.vercel.app/';
let activeSession = null;
let refreshPromise = null;

const normalizeEmail = (value) => String(value || '').trim().toLowerCase();

function authError(result, status) {
  const raw = result?.msg || result?.message || result?.error_description || `Erro ${status}`;
  const text = String(raw).toLowerCase();
  if (text.includes('invalid login')) return 'E-mail ou senha incorretos.';
  if ((result?.error_code || result?.code) === 'email_not_confirmed' || text.includes('email not confirmed')) return 'Seu cadastro ainda está pendente. Conclua o cadastro para ativar sua conta.';
  if (text.includes('user already registered')) return 'Este e-mail já está cadastrado.';
  if (text.includes('rate limit')) return 'Muitas tentativas. Aguarde alguns minutos e tente novamente.';
  if (text.includes('password') && text.includes('characters')) return 'A senha precisa ter pelo menos 6 caracteres.';
  return raw;
}

async function request(path, { method = 'GET', body, token, headers = {} } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  let response;
  try { response = await fetch(`${SUPABASE_URL}${path}`, {
    method,
    headers: {
      apikey: SUPABASE_KEY,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: controller.signal,
  }); } catch (error) {
    throw new Error(error?.name === 'AbortError' ? 'A conexão demorou demais. Tente novamente.' : 'Não foi possível conectar. Verifique sua internet.');
  } finally { clearTimeout(timeout); }
  const result = response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(authError(result, response.status));
    error.code = result?.error_code || result?.code || (/email not confirmed/i.test(String(result?.msg || result?.message || result?.error_description || '')) ? 'email_not_confirmed' : '');
    error.status = response.status;
    throw error;
  }
  return result;
}

function rememberSession(session) {
  activeSession = session ? {
    ...session,
    expires_at: Number(session.expires_at) || Date.now() / 1000 + (Number(session.expires_in) || 3600),
  } : null;
  if (activeSession) localStorage.setItem(SESSION_KEY, JSON.stringify(activeSession));
  else localStorage.removeItem(SESSION_KEY);
  return activeSession;
}

async function refreshSession(session) {
  if (!session?.refresh_token) return null;
  if (refreshPromise) return refreshPromise;
  refreshPromise = request('/auth/v1/token?grant_type=refresh_token', {
    method: 'POST', body: { refresh_token: session.refresh_token },
  }).then((next) => rememberSession({ ...next, recoveryRequired: session.recoveryRequired === true })).finally(() => { refreshPromise = null; });
  return refreshPromise;
}

export async function restoreSession() {
  if (globalThis.location) {
    const params = new URLSearchParams(location.hash.slice(1));
    if (params.get('error_description')) {
      const description = params.get('error_description');
      const code = params.get('error_code') || params.get('error') || '';
      history.replaceState(history.state, '', location.pathname + location.search);
      const error = new Error(code === 'otp_expired' || /expired|invalid/i.test(description)
        ? 'Este link é inválido ou expirou. Solicite um novo e-mail.' : description);
      error.code = code;
      throw error;
    }
    if (params.get('access_token')) {
      const session = rememberSession({
        access_token: params.get('access_token'),
        refresh_token: params.get('refresh_token'),
        expires_in: Number(params.get('expires_in')) || 3600,
        recoveryRequired: params.get('type') === 'recovery',
      });
      history.replaceState(history.state, '', location.pathname + location.search);
      const user = await request('/auth/v1/user', { token: session.access_token });
      rememberSession({ ...session, user });
      return { ...await loadAccount(user, activeSession), recoveryRequired: activeSession.recoveryRequired === true };
    }
  }
  let saved;
  try { saved = JSON.parse(localStorage.getItem(SESSION_KEY)); } catch { return null; }
  if (!saved?.access_token) return null;
  const expiresAt = Number(saved.expires_at) || 0;
  const session = expiresAt > Date.now() / 1000 + 60 ? rememberSession(saved) : await refreshSession(saved).catch(() => null);
  if (!session) return null;
  try {
    const user = await request('/auth/v1/user', { token: session.access_token });
    return { ...await loadAccount(user, session), recoveryRequired: session.recoveryRequired === true };
  } catch {
    rememberSession(null);
    return null;
  }
}

export async function signIn(email, password) {
  const session = await request('/auth/v1/token?grant_type=password', {
    method: 'POST', body: { email: normalizeEmail(email), password },
  });
  rememberSession(session);
  return loadAccount(session.user, session);
}

export async function signUp({ nickname, email, password }) {
  const result = await request('/auth/v1/signup', {
    method: 'POST',
    body: { email: normalizeEmail(email), password, data: { nickname: nickname.trim().slice(0, 12) }, email_redirect_to: AUTH_RETURN_URL },
  });
  if (result?.user && Array.isArray(result.user.identities) && result.user.identities.length === 0) {
    throw new Error('Este e-mail já está cadastrado. Entre com sua senha ou recupere o acesso.');
  }
  if (!result.access_token) return { confirmationRequired: true };
  rememberSession(result);
  return loadAccount(result.user, result);
}

export function requestPasswordReset(email) {
  return request('/auth/v1/recover', { method: 'POST', body: { email: normalizeEmail(email), redirect_to: AUTH_RETURN_URL } });
}

export function resendConfirmation(email) {
  return request('/auth/v1/resend', {
    method: 'POST', body: { type: 'signup', email: normalizeEmail(email), email_redirect_to: AUTH_RETURN_URL },
  });
}

export async function updatePassword(password) {
  if (String(password).length < 8) throw new Error('Use uma senha com pelo menos 8 caracteres.');
  if (!activeSession?.access_token) throw new Error('Sua sessão expirou. Entre novamente.');
  if (Number(activeSession.expires_at) <= Date.now() / 1000 + 60) await refreshSession(activeSession);
  const user = await request('/auth/v1/user', {
    method: 'PUT', token: activeSession.access_token, body: { password },
  });
  rememberSession({ ...activeSession, user, recoveryRequired: false });
  return user;
}

export async function signOut() {
  const token = activeSession?.access_token;
  if (token) await request('/auth/v1/logout', { method: 'POST', token }).catch(() => {});
  rememberSession(null);
}

export function getAccessToken() {
  return activeSession?.access_token || null;
}

async function loadAccount(user, session) {
  const rows = await request(`/rest/v1/player_profiles?id=eq.${encodeURIComponent(user.id)}&select=*`, {
    token: session.access_token,
  });
  let playerProfile = rows?.[0];
  if (!playerProfile) {
    const nickname = String(user.user_metadata?.nickname || user.email?.split('@')[0] || '').trim().slice(0, 12);
    const created = await request('/rest/v1/player_profiles', {
      method: 'POST', token: session.access_token,
      headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
      body: { id: user.id, nickname, avatar: 'avatar-1.webp' },
    });
    playerProfile = created?.[0];
  }
  return { user, session, profile: playerProfile };
}


export async function fetchAccountProfile(playerId) {
  if (!activeSession?.access_token || !playerId) return null;
  const rows = await request(`/rest/v1/player_profiles?id=eq.${encodeURIComponent(playerId)}&select=*`, {
    token: activeSession.access_token,
    headers: { 'cache-control': 'no-cache' },
  });
  return rows?.[0] || null;
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
      owned_characters: [...new Set(['capivara', ...(profile.cos?.ownedCharacters || [])])],
      owned_emotes: [...new Set(profile.cos?.ownedEmotes || [])],
      selected_character: profile.cos?.characterId || 'capivara',
      friendly_fire: Boolean(profile.friendlyFire),
      updated_at: new Date().toISOString(),
    },
  });
}

// Profile RPCs refresh bearer credentials without changing legacy game persistence.
export async function ensureAccessToken() {
  if (!activeSession?.access_token) throw new Error('Entre na sua conta para continuar.');
  if (Number(activeSession.expires_at) <= Date.now() / 1000 + 60) await refreshSession(activeSession);
  if (!activeSession?.access_token) throw new Error('Sua sessão expirou. Entre novamente.');
  return activeSession.access_token;
}
export async function authenticatedRpc(name, body = {}, expectedPlayerId = null) {
  const path = '/rest/v1/rpc/' + name;
  const ownerToken = async () => {
    const token = await ensureAccessToken();
    if (expectedPlayerId && activeSession?.user?.id?.toLowerCase() !== expectedPlayerId.toLowerCase()) {
      throw new Error('Entre na conta correspondente para sincronizar este histórico.');
    }
    return token;
  };
  try { return await request(path, { method:'POST',body,token:await ownerToken() }); }
  catch (error) {
    if (error.status !== 401 || !activeSession?.refresh_token) throw error;
    await refreshSession(activeSession);
    return request(path, { method:'POST',body,token:await ownerToken() });
  }
}
export function applyAccountProfile(profile, row) {
  if (!row) return profile;
  const owns = key => Object.prototype.hasOwnProperty.call(row,key);
  if (owns('id')) profile.playerId=row.id;
  if (owns('nickname')) profile.name=row.nickname;
  for (const [column,key] of [['gold','gold'],['rank_points','rankXp'],['experience_points','experienceXp']]) {
    if (owns(column)) profile[key]=Math.max(0,Number(row[column])||0);
  }
  if (['matches','wins','losses'].some(owns)) {
    profile.rankStats={...profile.rankStats};
    for (const key of ['matches','wins','losses']) if (owns(key)) profile.rankStats[key]=Math.max(0,Number(row[key])||0);
  }
  if (owns('mission_stats')) profile.missionStats=row.mission_stats||{};
  if (owns('missions')) profile.missions=Array.isArray(row.missions)?row.missions:[];
  if (owns('friendly_fire')) profile.friendlyFire=Boolean(row.friendly_fire);
  if (owns('hat')) profile.hat=row.hat||'crown';
  if (owns('skin')) profile.skin=row.skin||'#bdaee6';
  if (owns('profile_bio')) profile.bio=row.profile_bio||'';
  if (owns('profile_banner')) profile.banner=row.profile_banner||'character';
  if (owns('history_public')) profile.historyPublic=row.history_public===true;
  profile.cos={...profile.cos};
  if (owns('avatar')) profile.cos.avatar=row.avatar||'avatar-1.webp';
  if (owns('hat')) profile.cos.hat=profile.hat;
  if (owns('skin')) profile.cos.skin=profile.skin;
  if (owns('selected_character')) profile.cos.characterId=row.selected_character||'capivara';
  if (owns('owned_characters')) profile.cos.ownedCharacters=[...new Set(['capivara',...(row.owned_characters||[])])];
  if (owns('owned_emotes')) profile.cos.ownedEmotes=[...new Set(row.owned_emotes||[])];
  return profile;
}
