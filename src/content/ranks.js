export const RANKS = [
  ['Novato I', 0, 'novato-1.png'], ['Novato II', 100, 'novato-2.png'], ['Novato III', 250, 'novato-3.png'],
  ['Valente I', 450, 'valente-1.png'], ['Valente II', 700, 'valente-2.png'], ['Valente III', 1000, 'valente-3.png'],
  ['Brutal I', 1350, 'brutal-1.png'], ['Brutal II', 1750, 'brutal-2.png'], ['Brutal III', 2200, 'brutal-3.png'],
  ['Temido I', 2700, 'temido-1.png'], ['Temido II', 3250, 'temido-2.png'], ['Temido III', 3850, 'temido-3.png'],
  ['Implacável I', 4500, 'implacavel-1.png'], ['Implacável II', 5200, 'implacavel-2.png'], ['Implacável III', 5950, 'implacavel-3.png'],
  ['Lendário I', 6750, 'lendario-1.png'], ['Lendário II', 7600, 'lendario-2.png'], ['Lendário III', 8500, 'lendario-3.png'],
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
