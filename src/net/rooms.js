import { SUPABASE_KEY, SUPABASE_URL } from './supabase.js';
import { clampTeamSize, clampPlayerCount, assertRoomCapacity, isRoomWithinCapacity } from '../game/capacity.js';

function checkedRoom(room) {
  const limits = room?.teamLimits;
  const result = { ...room, maxPlayers: room?.maxPlayers ?? (room?.modeId === 'ffa' ? limits?.ffa : limits?.red + limits?.blue) };
  assertRoomCapacity(result);
  return result;
}

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
  return (await rpc('list_game_rooms')).filter(isRoomWithinCapacity);
}

export async function createRoom(options) {
  const result = await rpc('create_game_room', {
    p_code: options.code,
    p_name: options.name,
    p_password: options.password || '',
    p_mode_id: options.modeId,
    p_level_id: options.levelId,
    p_red_size: clampTeamSize(options.redSize),
    p_blue_size: clampTeamSize(options.blueSize),
    p_ffa_size: clampPlayerCount(options.ffaSize),
    p_respawn_time: options.respawnTime,
    p_friendly_fire: options.friendlyFire,
  });
  if (result?.ok) result.room = checkedRoom(result.room);
  return result;
}

export async function joinRoom(code, password = '') {
  const result = await rpc('join_game_room', {
    p_code: code,
    p_password: password || '',
  });
  return result?.ok ? checkedRoom(result) : result;
}

export async function touchRoom(code, hostToken, playersCount) {
  if (!hostToken) return false;
  return rpc('touch_game_room', {
    p_code: code,
    p_host_token: hostToken,
    p_players_count: playersCount,
  }).catch(() => false);
}
