import { SUPABASE_KEY, SUPABASE_URL } from './supabase.js';

async function rpc(name, body = {}) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_KEY,
      authorization: `Bearer ${SUPABASE_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const result = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(result?.message || result?.error || `Supabase respondeu ${response.status}`);
  }
  return result;
}

export async function listRooms() {
  return rpc('list_game_rooms');
}

export async function createRoom(options) {
  return rpc('create_game_room', {
    p_code: options.code,
    p_name: options.name,
    p_password: options.password || '',
    p_mode_id: options.modeId,
    p_level_id: options.levelId,
    p_red_size: options.redSize,
    p_blue_size: options.blueSize,
    p_ffa_size: options.ffaSize,
    p_respawn_time: options.respawnTime,
    p_friendly_fire: options.friendlyFire,
  });
}

export async function joinRoom(code, password = '') {
  return rpc('join_game_room', {
    p_code: code,
    p_password: password || '',
  });
}

export async function touchRoom(code, hostToken, playersCount) {
  if (!hostToken) return false;
  return rpc('touch_game_room', {
    p_code: code,
    p_host_token: hostToken,
    p_players_count: playersCount,
  }).catch(() => false);
}
