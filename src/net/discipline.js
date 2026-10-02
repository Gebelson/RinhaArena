import { SUPABASE_KEY, SUPABASE_URL } from './supabase.js';
import { getAccessToken } from './account.js';

async function rpc(name, body = {}) {
  const token = getAccessToken();
  if (!token) throw new Error('Sessão necessária');
  const response = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: { apikey: SUPABASE_KEY, authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const result = await response.json().catch(() => null);
  if (!response.ok) throw new Error(result?.message || `Supabase respondeu ${response.status}`);
  return result;
}

export const getPlayerDiscipline = () => rpc('get_player_discipline');
export const registerPlayerAbandon = (matchId, mode, rankPenalty = 0) => rpc('register_player_abandon', {
  p_match_id: matchId, p_mode: mode, p_rank_penalty: rankPenalty,
});
