import { getRankProgress } from '../content/ranks.js';

const escapeHtml = (value) => String(value ?? '').replace(/[&<>'"]/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
}[char]));
const number = (value) => Math.max(0, Number(value) || 0).toLocaleString('pt-BR');

function medal(place) {
  return `<svg class="leaderboard-medal" viewBox="0 0 100 100" role="img" aria-label="${place}º lugar">
    <path class="medal-shadow" d="M13 32 6 22 8 58 21 77 36 82H64L79 77 92 58 94 22 87 32 85 54 74 70H26L15 54Z"/>
    <path class="medal-metal" d="M24 66 12 56 9 40 20 48 17 31 31 43 69 43 83 31 80 48 91 40 88 56 76 66 65 76H35Z"/>
    <path class="medal-light" d="m26 35 3-17 13 10 8-21 8 21 13-10 3 17Z"/>
    <path class="medal-shadow" d="m24 37 26-9 26 9-3 37-23 18-23-18Z"/>
    <path class="medal-metal" d="m28 39 22-8 22 8-3 32-19 15-19-15Z"/>
    <path class="medal-face" d="m34 44 16-6 16 6-2 23-14 12-14-12Z"/>
    <path class="medal-glint" d="m28 39 22-8 22 8-4 5-18-6-17 6Z"/>
    <text x="50" y="68" text-anchor="middle" aria-hidden="true">${place}</text>
  </svg>`;
}

export function leaderboardMarkup() {
  return `<div class="modal-window leaderboard-window" role="dialog" aria-modal="true" aria-label="Ranking de jogadores" tabindex="-1">
    <div class="modal-header leaderboard-header">
      <div class="leaderboard-heading">
        <img class="leaderboard-trophy" src="./assets/ui/leaderboard-trophy.svg" alt="">
        <div><h2 class="modal-title">RANKING DE JOGADORES</h2><p class="leaderboard-subtitle"><svg viewBox="0 0 24 22" aria-hidden="true"><path fill="currentColor" d="m2 5 5 4 5-7 5 7 5-4-2 12H4Z M4 19h16v3H4Z"/></svg> Classificação atual</p></div>
      </div>
      <button class="modal-close" aria-label="Fechar ranking">✕</button>
    </div>
    <div class="leaderboard-table" role="table" aria-label="Classificação dos jogadores" tabindex="0">
      <div class="leaderboard-head" role="row"><span role="columnheader">POSIÇÃO</span><span role="columnheader">JOGADOR</span><span role="columnheader">RANK</span><span role="columnheader">VITÓRIAS</span><span role="columnheader">DERROTAS</span><span role="columnheader">PONTOS</span></div>
      <div class="leaderboard-list" role="rowgroup" aria-busy="true"><div class="leaderboard-loading" role="status">Carregando ranking…</div></div>
    </div>
  </div>`;
}

export function leaderboardRowsMarkup(players, localPlayerId) {
  if (!players.length) return '<div class="leaderboard-loading" role="status">Nenhum jogador classificado ainda.</div>';
  return players.map((player, index) => {
    const rank = getRankProgress(player.points).rank;
    const place = index + 1;
    const avatar = /^avatar-(?:[1-9]|10)\.webp$/.test(player.avatar) ? player.avatar : 'avatar-1.webp';
    const isMe = player.playerId === localPlayerId;
    return `<div role="row" class="leaderboard-row ${place <= 3 ? `leaderboard-top leaderboard-top-${place}` : ''} ${isMe ? 'is-me' : ''}">
      <div class="leaderboard-place" role="cell">${place <= 3 ? medal(place) : `<b>${place}</b>`}</div>
      <div class="leaderboard-player" role="cell"><img src="./assets/ui/avatars/${avatar}" alt=""><div class="leaderboard-player-copy"><strong class="leaderboard-name" title="${escapeHtml(player.name)}">${escapeHtml(player.name)}</strong>${isMe ? '<small class="leaderboard-me">VOCÊ</small>' : ''}</div></div>
      <div class="leaderboard-rank" role="cell"><img src="./assets/ui/ranks/${rank.asset}" alt=""><span>${rank.name}</span></div>
      <b class="leaderboard-wins" role="cell">${number(player.wins)}</b>
      <b class="leaderboard-losses" role="cell">${number(player.losses)}</b>
      <b class="leaderboard-points" role="cell">${number(player.points)}</b>
    </div>`;
  }).join('');
}
