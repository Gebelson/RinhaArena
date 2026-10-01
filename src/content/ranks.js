export const RANKS = [
  ['Unranked', 0, 'unranked.png'],
  ['Novato I', 100, 'novato-1.png'], ['Novato II', 250, 'novato-2.png'], ['Novato III', 450, 'novato-3.png'],
  ['Valente I', 700, 'valente-1.png'], ['Valente II', 1000, 'valente-2.png'], ['Valente III', 1350, 'valente-3.png'],
  ['Brutal I', 1750, 'brutal-1.png'], ['Brutal II', 2200, 'brutal-2.png'], ['Brutal III', 2700, 'brutal-3.png'],
  ['Temido I', 3250, 'temido-1.png'], ['Temido II', 3850, 'temido-2.png'], ['Temido III', 4500, 'temido-3.png'],
  ['Implacável I', 5200, 'implacavel-1.png'], ['Implacável II', 5950, 'implacavel-2.png'], ['Implacável III', 6750, 'implacavel-3.png'],
  ['Lendário I', 7600, 'lendario-1.png'], ['Lendário II', 8500, 'lendario-2.png'], ['Lendário III', 9500, 'lendario-3.png'],
].map(([name, xp, asset], index) => ({ name, xp, asset, index }));

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
  return `--rank-image:url('./assets/ui/ranks/${rank.asset}')`;
}
