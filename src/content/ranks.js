export const RANKS = [
  ['Novato I', 0], ['Novato II', 100], ['Novato III', 250],
  ['Valente I', 450], ['Valente II', 700], ['Valente III', 1000],
  ['Brutal I', 1350], ['Brutal II', 1750], ['Brutal III', 2200],
  ['Temido I', 2700], ['Temido II', 3250], ['Temido III', 3850],
  ['Implacável I', 4500], ['Implacável II', 5200], ['Implacável III', 5950],
  ['Lendário I', 6750], ['Lendário II', 7600], ['Lendário III', 8500],
].map(([name, xp], index) => ({ name, xp, index, row: Math.floor(index / 3), column: index % 3 }));

export function getRankProgress(xp = 0) {
  const safeXp = Math.max(0, Number(xp) || 0);
  let rank = RANKS[0];
  for (const candidate of RANKS) {
    if (safeXp < candidate.xp) break;
    rank = candidate;
  }
  const next = RANKS[rank.index + 1] || null;
  const span = next ? next.xp - rank.xp : 1;
  const progress = next ? Math.min(1, (safeXp - rank.xp) / span) : 1;
  return { rank, next, xp: safeXp, progress };
}

export function rankSpriteStyle(rank) {
  return `--rank-column:${rank.column};--rank-row:${rank.row}`;
}
