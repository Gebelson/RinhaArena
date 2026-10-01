export const RANKS = [
  ['Unranked', 0, 'unranked.png'],
  ['Novato I', 100, 'novato-1.png'], ['Novato II', 200, 'novato-2.png'], ['Novato III', 300, 'novato-3.png'],
  ['Valente I', 400, 'valente-1.png'], ['Valente II', 500, 'valente-2.png'], ['Valente III', 600, 'valente-3.png'],
  ['Brutal I', 700, 'brutal-1.png'], ['Brutal II', 800, 'brutal-2.png'], ['Brutal III', 900, 'brutal-3.png'],
  ['Temido I', 1000, 'temido-1.png'], ['Temido II', 1100, 'temido-2.png'], ['Temido III', 1200, 'temido-3.png'],
  ['Implacável I', 1300, 'implacavel-1.png'], ['Implacável II', 1400, 'implacavel-2.png'], ['Implacável III', 1500, 'implacavel-3.png'],
  ['Lendário I', 1600, 'lendario-1.png'], ['Lendário II', 1700, 'lendario-2.png'], ['Lendário III', 1800, 'lendario-3.png'],
].map(([name, xp, asset], index) => ({ name, xp, asset, index }));

export function getRankProgress(xp = 0) {
  const safeXp = Math.max(0, Number(xp) || 0);
  let rank = RANKS[0];
  for (const candidate of RANKS) {
    if (safeXp < candidate.xp) break;
    rank = candidate;
  }
  const next = RANKS[rank.index + 1] || null;
  const points = safeXp - rank.xp;
  const progress = next ? Math.min(1, points / 100) : 1;
  return { rank, next, xp: safeXp, points, progress };
}

export function rankSpriteStyle(rank) {
  return `--rank-image:url('./assets/ui/ranks/${rank.asset}')`;
}
