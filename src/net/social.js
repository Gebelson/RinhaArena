import { getAccessToken } from './account.js';
import { SUPABASE_KEY, SUPABASE_URL } from './supabase.js';

async function rpc(name, body = {}) {
  const token = getAccessToken();
  if (!token) throw new Error('Entre na conta para usar a lista de amigos.');
  const response = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, { method: 'POST', headers: { apikey: SUPABASE_KEY, authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const result = await response.json().catch(() => null);
  if (!response.ok) throw new Error(result?.message || 'Não foi possível concluir a ação.');
  return result;
}
export const searchPlayers = (query) => rpc('search_social_players', { p_query: query });
export const sendFriendRequest = (id) => rpc('send_friend_request', { p_receiver: id });
export const listFriends = () => rpc('list_social_friends');
export const listFriendRequests = () => rpc('list_friend_requests');
export const respondFriendRequest = (id, accept) => rpc('respond_friend_request', { p_request: id, p_accept: accept });
export const giftFriendResource = (id, kind, amount) => rpc('gift_friend_resource', { p_friend: id, p_kind: kind, p_amount: amount });
export const createCharacterTrade = (id, offer, request) => rpc('create_character_trade', { p_friend: id, p_offer: offer, p_request: request });
export const listCharacterTrades = () => rpc('list_character_trades');
export const respondCharacterTrade = (id, accept) => rpc('respond_character_trade', { p_trade: id, p_accept: accept });
