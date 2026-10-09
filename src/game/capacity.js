export const MAX_TEAM_SIZE = 3;
export const MAX_PLAYERS = MAX_TEAM_SIZE * 2;

const boundedInteger = (value, min, max, fallback) => {
  const candidate = Number(value);
  const number = Number.isFinite(candidate) ? candidate : Number(fallback);
  return Math.min(max, Math.max(min, Math.floor(Number.isFinite(number) ? number : min)));
};

export const clampTeamSize = (value, fallback = 2) => boundedInteger(value, 1, MAX_TEAM_SIZE, fallback);
export const clampPlayerCount = (value, fallback = 6) => boundedInteger(value, 2, MAX_PLAYERS, fallback);

export function assertRoomCapacity(room) {
  const limits = room?.teamLimits;
  const sizes = room?.modeId === 'ffa' ? [limits?.ffa] : [limits?.red, limits?.blue];
  const maximum = room?.modeId === 'ffa' ? MAX_PLAYERS : MAX_TEAM_SIZE;
  const minimum = room?.modeId === 'ffa' ? 2 : 1;
  if (sizes.some(size => !Number.isInteger(size) || size < minimum || size > maximum)
    || room?.maxPlayers !== sizes.reduce((sum, size) => sum + size, 0)) {
    throw new Error('Capacidade inválida: máximo de 3 jogadores por equipe e 6 por partida.');
  }
}

export function isRoomWithinCapacity(room) {
  try { assertRoomCapacity(room); return true; } catch { return false; }
}

export function assertRosterCapacity(players, modeId, limits) {
  if (!Array.isArray(players) || players.length > MAX_PLAYERS) throw new Error('[MATCH] roster capacity exceeded');
  const counts = modeId === 'ffa' ? { free: 0 } : { red: 0, blue: 0 };
  for (const player of players) {
    if (!Object.hasOwn(counts, player?.team)) throw new Error('[MATCH] invalid participant team');
    counts[player.team]++;
  }
  for (const [team, count] of Object.entries(counts)) {
    if (count > (team === 'free' ? limits.ffa : limits[team])) throw new Error('[MATCH] team capacity exceeded');
  }
}
