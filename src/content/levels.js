const BASE_LEVEL_XP = 100;
const XP_GROWTH_PER_LEVEL = 35;

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

  while (xpIntoLevel >= xpRequired) {
    xpIntoLevel -= xpRequired;
    level += 1;
    xpRequired = xpRequiredForLevel(level);
  }

  return {
    level,
    totalXp,
    xp: xpIntoLevel,
    required: xpRequired,
    progress: xpIntoLevel / xpRequired,
  };
}
