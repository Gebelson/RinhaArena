const BASE_LEVEL_XP = 100;
const XP_GROWTH_PER_LEVEL = 35;
export const MAX_LEVEL = 100;

export function getLevelBadgeAsset(level = 1) {
  const safeLevel = Math.min(MAX_LEVEL, Math.max(1, Math.floor(Number(level) || 1)));
  if (safeLevel === MAX_LEVEL) return 'level-100.png';
  const start = safeLevel < 10 ? 1 : Math.floor(safeLevel / 10) * 10;
  const end = start === 1 ? 9 : start + 9;
  return `level-${start}-${end}.png`;
}

export function xpRequiredForLevel(level = 1) {
  const safeLevel = Math.max(1, Math.floor(Number(level) || 1));
  return BASE_LEVEL_XP + (safeLevel - 1) * XP_GROWTH_PER_LEVEL;
}

export function getEarnedLevelXp(stats = {}) {
  const matches = Math.max(0, Number(stats.matches) || 0);
  const wins = Math.min(matches, Math.max(0, Number(stats.wins) || 0));
  const losses = Math.min(matches - wins, Math.max(0, Number(stats.losses) || 0));
  const draws = Math.max(0, matches - wins - losses);
  return wins * 100 + draws * 60 + losses * 40;
}

export function getLevelProgress(stats = {}) {
  const totalXp = getEarnedLevelXp(stats);
  let level = 1;
  let xpIntoLevel = totalXp;
  let xpRequired = xpRequiredForLevel(level);

  while (level < MAX_LEVEL && xpIntoLevel >= xpRequired) {
    xpIntoLevel -= xpRequired;
    level += 1;
    xpRequired = xpRequiredForLevel(level);
  }

  const isMax = level === MAX_LEVEL;
  if (isMax) xpIntoLevel = Math.min(xpIntoLevel, xpRequired);

  return {
    level,
    totalXp,
    xp: xpIntoLevel,
    required: xpRequired,
    progress: isMax ? 1 : xpIntoLevel / xpRequired,
    isMax,
  };
}
