export const PROFILE_CHARACTERS = [
  ['capivara','Capivara'], ['cachorro','Cachorro'], ['crocodilo','Crocodilo'], ['gato','Gato'],
  ['macaco','Macaco'], ['pato','Pato'], ['porco','Porco'],
].map(([id,name]) => ({ id, name, image: `./assets/ui/shop/${id}.webp?v=3` }));
export const safeCount = value => Math.max(0, Math.floor(Number.isFinite(Number(value)) ? Number(value) : 0));
export function playerProfileFromRow(row) {
  return {
    playerId: row.id, name: row.nickname, rankXp: safeCount(row.rank_points),
    experienceXp: safeCount(row.experience_points),
    rankStats: { matches: safeCount(row.matches), wins: safeCount(row.wins), losses: safeCount(row.losses) },
    bio: String(row.profile_bio || ''), banner: row.profile_banner || 'character', historyPublic: row.history_public === true,
    cos: { avatar: row.avatar, characterId: row.selected_character || 'capivara',
      ownedCharacters: Array.isArray(row.owned_characters) ? row.owned_characters : [],
      ownedEmotes: Array.isArray(row.owned_emotes) ? row.owned_emotes : [] },
  };
}
export function profileTotals(profile) {
  const matches = safeCount(profile.rankStats?.matches), wins = safeCount(profile.rankStats?.wins), losses = safeCount(profile.rankStats?.losses);
  return { matches, wins, losses, draws: Math.max(0, matches - wins - losses),
    winRate: matches ? Math.round(wins / matches * 100) : 0 };
}
export function summarizeHistory(rows) {
  const totals = { matches: rows.length, wins: 0, losses: 0, draws: 0, eliminations: 0, deaths: 0, captures: 0, returns: 0 };
  const modes = new Map();
  for (const row of rows) {
    totals[{ win: 'wins', loss: 'losses', draw: 'draws' }[row.outcome] || 'draws']++;
    for (const key of ['eliminations','deaths','captures','returns']) totals[key] += safeCount(row.stats?.[key]);
    const entry = modes.get(row.mode_id) || { mode: row.mode_id, matches: 0, wins: 0 };
    entry.matches++; entry.wins += row.outcome === 'win' ? 1 : 0; modes.set(row.mode_id, entry);
  }
  return { ...totals, kd: totals.deaths ? (totals.eliminations / totals.deaths).toFixed(2) : (totals.eliminations ? String(totals.eliminations) : '0.00'),
    winRate: totals.matches ? Math.round(totals.wins / totals.matches * 100) : 0, modes: [...modes.values()] };
}
export function filterHistory(rows, { mode = 'all', outcome = 'all', queue = 'all' } = {}) {
  return rows.filter(row => (mode === 'all' || (row.mode_id === 'dm' ? 'deathmatch' : row.mode_id) === mode)
    && (outcome === 'all' || row.outcome === outcome)
    && (queue === 'all' || Boolean(row.ranked) === (queue === 'ranked')));
}

export async function prepareAvatarImage(file) {
  if (!file || !['image/png','image/jpeg','image/webp'].includes(file.type)) throw new Error('Escolha uma imagem PNG, JPG ou WebP.');
  if (file.size > 5 * 1024 * 1024) throw new Error('A foto deve ter até 5 MB.');
  let bitmap;
  try { bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' }); }
  catch { throw new Error('Não foi possível abrir esta imagem.'); }
  try {
    if (!bitmap.width || !bitmap.height || bitmap.width * bitmap.height > 40_000_000) throw new Error('Escolha uma imagem com até 40 megapixels.');
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 256;
    const context = canvas.getContext('2d');
    const side = Math.min(bitmap.width, bitmap.height);
    context.drawImage(bitmap, (bitmap.width-side)/2, (bitmap.height-side)/2, side, side, 0, 0, 256, 256);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/webp', 0.85));
    if (!blob || blob.type !== 'image/webp' || blob.size > 256 * 1024) throw new Error('Não foi possível preparar a foto.');
    return blob;
  } finally { bitmap.close(); }
}

const knownNumber = value => value !== undefined && value !== null && value !== '' && Number.isFinite(Number(value));
export function normalizeHistoryRow(row) {
  const date = new Date(row.created_at);
  const keys = ['eliminations','deaths','captures','returns'];
  return { ...row, outcome: ['win','loss','draw'].includes(row.outcome) ? row.outcome : 'draw',
    date: Number.isFinite(date.getTime()) ? date : null,
    gold: safeCount(row.gold), xp: safeCount(row.xp),
    rank_delta: Math.trunc(Number.isFinite(Number(row.rank_delta)) ? Number(row.rank_delta) : 0),
    statKnown: keys.map(key => knownNumber(row.stats?.[key])),
    rewardKnown: ['gold','xp','rank_delta'].map(key => knownNumber(row[key])),
    stats: keys.map(key => safeCount(row.stats?.[key])) };
}

// Records describe the browser's completed match; they do not award currency or rank.
export function recordedMatchPayload({ matchId, event, view, myId, mapId }) {
  if (!matchId || event?.t !== 'roundOver' || event.matchComplete === false || view?.lab) return null;
  const me=view?.players?.find(player=>player.id===myId);
  if (!me || !['ctf','deathmatch','dm','ffa'].includes(view.modeId)) return null;
  const draw=event.winner==='draw';
  const won=!draw && (view.modeId==='ffa' ? event.winner===myId : event.winner===me.team);
  const stats={};
  for (const key of ['eliminations','deaths','captures','returns']) {
    if (knownNumber(me.stats?.[key]) && Number(me.stats[key])>=0) stats[key]=safeCount(me.stats[key]);
  }
  const summary={capacity:Math.min(6,view.players.length),team:view.modeId==='ffa'?'free':me.team};
  if (['red','blue','draw'].includes(event.winner)) summary.winner=event.winner;
  const scores={};
  for (const team of ['red','blue']) if (knownNumber(event.scores?.[team]) && Number(event.scores[team])>=0) scores[team]=safeCount(event.scores[team]);
  if (Object.keys(scores).length) summary.scores=scores;
  const series=event.series||view.series||{};
  if ([1,3,5].includes(series.bestOf)) summary.bestOf=series.bestOf;
  const round=Math.max(1,Object.values(series.wins||{}).reduce((sum,value)=>sum+safeCount(value),0)+(draw?1:0));
  return {p_match_id:String(matchId),p_round:round,p_mode_id:view.modeId,p_map_id:String(mapId),
    p_ranked:Boolean(event.ranked),p_outcome:draw?'draw':won?'win':'loss',p_stats:stats,p_summary:summary};
}

export function accumulateRecordedStats(total, stats) {
  for (const key of ['eliminations','deaths','captures','returns']) {
    if (knownNumber(stats?.[key]) && Number(stats[key])>=0) total[key]=safeCount(total[key])+safeCount(stats[key]);
  }
  return total;
}
