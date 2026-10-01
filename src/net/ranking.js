import { SUPABASE_KEY, SUPABASE_URL } from './supabase.js';
import { getAccessToken } from './account.js';

async function rpc(name, body = {}) {
  const token = getAccessToken();
  const response = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_KEY,
      authorization: `Bearer ${token || SUPABASE_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const result = await response.json().catch(() => null);
  if (!response.ok) throw new Error(result?.message || `Supabase respondeu ${response.status}`);
  return result;
}

export function submitPlayerRanking(profile) {
  return rpc('submit_player_ranking', {
    p_player_id: profile.playerId,
    p_name: profile.name,
    p_avatar: profile.cos?.avatar || 'avatar-1.webp',
    p_points: profile.rankXp,
    p_wins: profile.rankStats.wins,
    p_matches: profile.rankStats.matches,
  });
}

export function listPlayerRankings(limit = 100) {
  return rpc('list_player_rankings', { p_limit: limit });
}
