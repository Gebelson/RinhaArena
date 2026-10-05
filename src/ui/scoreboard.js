// Live match information. Stats come from the authority, so late joiners
// and reconnecting clients see the same totals as the host.
const CHARACTERS = {
  capivara: 'Capivara', cachorro: 'Cachorro', coala: 'Coala', coelho: 'Coelho',
  crocodilo: 'Crocodilo', furao: 'Furão', gato: 'Gato', jacare: 'Jacaré',
  macaco: 'Macaco', pato: 'Pato', pavao: 'Pavão', porco: 'Porco',
  tartaruga: 'Tartaruga', tubarao: 'Tubarão',
};
const MODES = { ctf: 'Pega Bandeira', deathmatch: 'Combate em Equipe', ffa: 'Todos contra Todos', 'sandbox-duel': 'Treino', 'sandbox-doll': 'Treino' };
const BOMBS = { normal: 'Bomba normal', ice: 'Bomba de gelo', sticky: 'Bomba adesiva', impact: 'Bomba de impacto', tnt: 'TNT', mine: 'Mina' };
const text = (node, value) => { if (node.textContent !== String(value)) node.textContent = value; };
const editing = (target) => target?.closest?.('.game-chat, input, textarea, select, [contenteditable="true"], [role="textbox"]');

export function createScoreboard(root, { levelName = '', modeId = 'ctf', canShow = () => true } = {}) {
  const el = document.createElement('section');
  el.className = 'match-scoreboard hidden';
  el.setAttribute('aria-label', 'Placar da partida');
  el.innerHTML = `
    <div class="match-scoreboard-card">
      <header class="match-scoreboard-header">
        <div><small>RINHA ARENA</small><h2>PLACAR DA PARTIDA</h2><p class="match-scoreboard-meta"></p></div>
        <div class="match-scoreboard-result"><strong class="result-red"></strong><span>×</span><strong class="result-blue"></strong></div>
        <div class="match-scoreboard-clock"><strong></strong><span>TEMPO RESTANTE</span></div>
        <button type="button" class="match-scoreboard-close" aria-label="Fechar placar">✕</button>
      </header>
      <div class="match-scoreboard-teams"></div>
      <footer><span class="match-scoreboard-goal"></span><span><kbd>TAB</kbd> segure para ver • solte para fechar</span></footer>
    </div>`;
  root.appendChild(el);
  const teams = el.querySelector('.match-scoreboard-teams');
  const meta = el.querySelector('.match-scoreboard-meta');
  const redScore = el.querySelector('.result-red');
  const blueScore = el.querySelector('.result-blue');
  const clock = el.querySelector('.match-scoreboard-clock strong');
  const goal = el.querySelector('.match-scoreboard-goal');
  const rows = new Map();
  const bodies = new Map();
  let latest = null, selfId = null, layout = '', lastRender = 0;
  let held = false, pinned = false;

  function render() {
    if (!latest) return;
    const view = latest;
    const mode = view.modeId || modeId;
    const ffa = mode === 'ffa';
    const ctf = mode === 'ctf';
    const groups = ffa ? ['ffa'] : ['red', 'blue'];
    const players = view.players || [];
    if (layout !== mode) {
      layout = mode;
      rows.clear(); bodies.clear(); teams.replaceChildren();
      el.classList.toggle('is-ffa', ffa);
      for (const team of groups) {
        const section = document.createElement('div');
        section.className = `match-scoreboard-team team-${team}`;
        section.innerHTML = `<h3>${ffa ? 'TODOS CONTRA TODOS' : team === 'red' ? 'EQUIPE VERMELHA' : 'EQUIPE AZUL'} <span></span></h3>
          <table><thead><tr><th scope="col">JOGADOR</th><th scope="col" title="Nocautes causados">KOs</th><th scope="col" title="Vezes derrotado">DER.</th>${ctf ? '<th scope="col" title="Bandeiras capturadas">CAP.</th><th scope="col" title="Bandeiras devolvidas">DEV.</th>' : ''}<th scope="col">VIDA</th></tr></thead><tbody></tbody></table>`;
        teams.appendChild(section);
        bodies.set(team, { body: section.querySelector('tbody'), count: section.querySelector('h3 span') });
      }
    }
    const totals = groups.map((team) => players.filter((p) => ffa || p.team === team).length);
    const format = ffa ? `${players.length} jogadores` : `${totals[0]}v${totals[1]}`;
    const series = view.series;
    const rounds = series?.bestOf > 1 ? `MD${series.bestOf} • Rodadas: ${series.wins?.red || 0} × ${series.wins?.blue || 0}` : '';
    text(meta, [levelName || view.mapId, MODES[mode] || mode, format, rounds].filter(Boolean).join(' • '));
    const remaining = Math.max(0, Math.ceil(view.timeLeft || 0));
    text(clock, view.lab ? 'TREINO' : view.phase === 'countdown' ? 'PREPARANDO' : `${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, '0')}`);
    text(redScore, view.scores?.red || 0); text(blueScore, view.scores?.blue || 0);
    el.querySelector('.match-scoreboard-result').classList.toggle('hidden', ffa);
    const limit = ctf ? view.rules?.captureLimit : ffa ? view.rules?.ffaKillsToWin : (view.rules?.killsToWin || 0) * Math.max(...totals);
    text(goal, view.lab ? 'TREINO LIVRE' : view.phase === 'over' ? 'PARTIDA ENCERRADA' : ctf ? `Bandeiras: capture a inimiga e proteja a sua${limit ? ` • Meta: ${limit}` : ''}` : `Nocautes: derrote seus adversários${limit ? ` • Meta: ${limit}` : ''}`);
    const active = new Set();
    groups.forEach((team, index) => {
      const group = players.filter((p) => ffa || p.team === team);
      // Team order stays stable while players fight. FFA is a ranked list.
      if (ffa) group.sort((a, b) => (view.ffaScores?.[b.id] || 0) - (view.ffaScores?.[a.id] || 0) || String(a.id).localeCompare(String(b.id)));
      const { body, count } = bodies.get(team);
      text(count, `${totals[index]} JOGADORES`);
      group.forEach((p, position) => {
        active.add(p.id);
        let row = rows.get(p.id);
        if (!row) {
          const tr = document.createElement('tr');
          tr.innerHTML = `<th scope="row"><div class="scoreboard-player"><img alt=""><div class="scoreboard-player-copy"><div class="scoreboard-player-name"><b></b><span></span></div><small></small><span class="scoreboard-player-status"></span></div></div></th><td class="stat-ko"></td><td class="stat-deaths"></td>${ctf ? '<td class="stat-captures"></td><td class="stat-returns"></td>' : ''}<td class="stat-hp"></td>`;
          row = { tr, image: tr.querySelector('img'), name: tr.querySelector('b'), tag: tr.querySelector('.scoreboard-player-name span'), character: tr.querySelector('small'), status: tr.querySelector('.scoreboard-player-status'), ko: tr.querySelector('.stat-ko'), deaths: tr.querySelector('.stat-deaths'), captures: tr.querySelector('.stat-captures'), returns: tr.querySelector('.stat-returns'), hp: tr.querySelector('.stat-hp') };
          rows.set(p.id, row);
        }
        if (body.children[position] !== row.tr) body.insertBefore(row.tr, body.children[position] || null);
        const character = Object.hasOwn(CHARACTERS, p.characterId || p.cos?.characterId) ? (p.characterId || p.cos.characterId) : 'capivara';
        if (row.image.dataset.character !== character) {
          row.image.src = `./assets/ui/shop/${character}.webp`;
          row.image.dataset.character = character;
        }
        text(row.name, p.displayName || p.name || 'Jogador');
        row.name.title = row.name.textContent;
        text(row.tag, p.id === selfId ? 'VOCÊ' : p.bot || p.type === 'BOT' ? 'BOT' : '');
        text(row.character, CHARACTERS[character]);
        row.tr.classList.toggle('is-self', p.id === selfId);
        row.tr.classList.toggle('is-defeated', p.state === 'ko' || p.connected === false);
        const status = p.connected === false ? 'Reconectando…' : p.state === 'ko' ? `Retorna em ${Math.max(1, Math.ceil(p.respawn || 0))}s` : p.carryFlag ? '⚑ COM A BANDEIRA' : p.invuln > 0 ? 'Proteção de spawn' : p.frozenT > 0 ? 'Congelado' : p.curseT > 0 ? 'Amaldiçoado' : p.glovesT > 0 ? 'Luvas de nocaute' : p.shieldHp > 0 ? 'Escudo ativo' : BOMBS[p.bombKind] || 'Bomba normal';
        text(row.status, status);
        row.status.classList.toggle('has-flag', Boolean(p.carryFlag));
        text(row.ko, ffa ? view.ffaScores?.[p.id] || 0 : p.stats?.eliminations || 0);
        text(row.deaths, p.stats?.deaths || 0);
        if (ctf) { text(row.captures, p.stats?.captures || 0); text(row.returns, p.stats?.returns || 0); }
        text(row.hp, p.state === 'ko' ? '—' : `${Math.max(0, Math.round(p.hp || 0))}%`);
      });
    });
    for (const [id, row] of rows) if (!active.has(id)) { row.tr.remove(); rows.delete(id); }
    lastRender = performance.now();
  }

  function hide() { held = false; pinned = false; el.classList.add('hidden'); }
  el.querySelector('.match-scoreboard-close').addEventListener('click', hide);
  function show() { if (!latest || !canShow()) return; render(); el.classList.remove('hidden'); }
  const onDown = (event) => {
    if (event.code === 'Escape' && !editing(event.target) && !el.classList.contains('hidden')) {
      event.preventDefault(); event.stopImmediatePropagation(); hide(); return;
    }
    if (event.code !== 'Tab' || editing(event.target) || !latest || !canShow()) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (event.repeat) return;
    held = true; show();
  };
  const onUp = (event) => {
    if (event.code !== 'Tab' || !held) return;
    event.preventDefault(); held = false;
    if (!pinned) el.classList.add('hidden');
  };
  const onVisibility = () => { if (document.hidden) hide(); };
  window.addEventListener('keydown', onDown, true);
  window.addEventListener('keyup', onUp, true);
  window.addEventListener('blur', hide);
  document.addEventListener('visibilitychange', onVisibility);
  return {
    update(view, myId) {
      latest = view; selfId = myId;
      if (!el.classList.contains('hidden')) {
        if (!canShow()) hide();
        else if (performance.now() - lastRender >= 150) render();
      }
    },
    toggle() { if (el.classList.contains('hidden')) { pinned = true; show(); } else hide(); },
    hide,
    dispose() {
      window.removeEventListener('keydown', onDown, true);
      window.removeEventListener('keyup', onUp, true);
      window.removeEventListener('blur', hide);
      document.removeEventListener('visibilitychange', onVisibility);
      el.remove();
    },
  };
}
