import { fetchPlayerProfile, fetchPlayerHistory, savePlayerPresentation, uploadProfileAvatar, flushPlayerMatchHistory } from '../net/profile.js';
import { applyAccountProfile } from '../net/account.js';
import { AVATARS, getAvatarUrl, isAvatarId } from '../content/avatars.js';
import { EMOTES } from '../content/emotes.js';
import { getRankProgress } from '../content/ranks.js';
import { getLevelProgress, getLevelBadgeAsset } from '../content/levels.js';
import { LEVELS } from '../content/levels/index.js';
import { validDisplayName } from '../game/matchmaking.js';
import { PROFILE_CHARACTERS, safeCount, normalizeHistoryRow, playerProfileFromRow, profileTotals, summarizeHistory, filterHistory, prepareAvatarImage } from './profileModel.js';

const escape = value => String(value ?? '').replace(/[&<>'"]/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' }[c]));
const number = value => safeCount(value).toLocaleString('pt-BR');
const outcomes = { win:'VITÓRIA', loss:'DERROTA', draw:'EMPATE' };
const modeName = mode => ({ ctf:'Pega Bandeira', deathmatch:'Mata-mata', dm:'Mata-mata', ffa:'Todos contra todos' }[mode] || mode);
const character = id => PROFILE_CHARACTERS.find(c => c.id === id) || PROFILE_CHARACTERS[0];
const stat = (label,value) => `<div class="profile-stat"><dt>${escape(label)}</dt><dd>${escape(value)}</dd></div>`;
const progress = (value,label) => `<progress class="profile-progress" max="1" value="${value}" aria-label="${escape(label)}"></progress>`;

export function openPlayerProfile(root, profile, {
  playerId = profile.playerId, initialTab = 'overview', loadProfile = fetchPlayerProfile,
  loadHistory = fetchPlayerHistory, savePresentation = savePlayerPresentation, uploadAvatar = uploadProfileAvatar,
  onChange = () => {}, onOpenShop, onOpenRank,
} = {}) {
  root.querySelector('.profile-overlay')?.querySelector('.modal-close')?.click();
  const own = playerId === profile.playerId;
  let view = own ? { ...profile, cos:{ ...profile.cos } } : null;
  let rows = [], historyPrivate = false, historyUnavailable = false, loading = true, error = '', tab = own ? initialTab : 'overview';
  let filters = { mode:'all', outcome:'all', queue:'all' }, selectedMatch = null, busy = false, draft = null, dirty = false;
  let pendingImage = null, imageUrl = null, generation = 0;
  const overlay = document.createElement('div'); overlay.className = 'modal-overlay profile-overlay';
  overlay.innerHTML = `<section class="modal-window profile-window" role="dialog" aria-modal="true" aria-label="Perfil do jogador">
    <header class="modal-header"><h1 class="modal-title">PERFIL DO JOGADOR</h1><button type="button" class="modal-close" aria-label="Fechar perfil">✕</button></header>
    <div class="profile-hero"></div><nav class="profile-tabs" role="tablist" aria-label="Seções do perfil"></nav>
    <div class="profile-body" id="player-profile-panel" role="tabpanel" tabindex="0"></div></section>`;
  const hero = overlay.querySelector('.profile-hero'), tabs = overlay.querySelector('.profile-tabs'), body = overlay.querySelector('.profile-body');
  const cleanup = () => { generation++; if (imageUrl) URL.revokeObjectURL(imageUrl); imageUrl = null; window.removeEventListener('blast:account-sync',onAccountSync); };
  const previousFocus = document.activeElement;
  const close = () => { if (!busy) { cleanup(); overlay.remove(); if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true }); } };
  overlay.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return; }
    if (event.key !== 'Tab') return;
    const controls = [...overlay.querySelectorAll('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex="0"]')].filter(node => node.getClientRects().length);
    const first=controls[0], last=controls.at(-1);
    if (!first) { event.preventDefault(); return; }
    if (event.shiftKey && document.activeElement===first) { event.preventDefault();last.focus(); }
    else if (!event.shiftKey && document.activeElement===last) { event.preventDefault();first.focus(); }
  });
  overlay.querySelector('.modal-close').onclick = close;
  overlay.addEventListener('arena:modal-closed', cleanup, { once:true });
  overlay.onclick = event => { if (event.target === overlay) close(); };
  overlay.addEventListener('error', event => {
    const image = event.target;
    if (image.tagName === 'IMG' && image.dataset.avatar !== undefined && !image.dataset.fallback) {
      image.dataset.fallback = '1'; image.src = getAvatarUrl(AVATARS[0]);
    }
  }, true);
  root.append(overlay);

  function renderHero() {
    if (!view) { hero.innerHTML = '<p class="profile-notice">Carregando jogador…</p>'; return; }
    const rank = getRankProgress(view.rankXp), level = getLevelProgress({ ...view.rankStats, experienceXp:view.experienceXp });
    hero.dataset.banner = ['ocean','sunset','forest'].includes(view.banner) ? view.banner : 'character';
    hero.innerHTML = `<img class="profile-hero-art" src="${character(view.cos?.characterId).image}" alt="">
      <button class="profile-avatar-button" type="button" ${own ? '' : 'disabled'} aria-label="${own ? 'Editar foto do perfil' : 'Foto do jogador'}"><img data-avatar src="${getAvatarUrl(view.cos?.avatar)}" alt=""><span class="profile-avatar-caption">${own ? 'EDITAR FOTO' : 'PERFIL'}</span></button>
      <div class="profile-identity"><h2>${escape(view.name || 'Jogador')}</h2><p>${escape(view.bio || 'Pronto para a próxima rinha.')}</p><div class="profile-character-summary"><span class="profile-level"><span class="profile-level-icon"><img src="./assets/ui/levels/${getLevelBadgeAsset(level.level)}" alt=""><b>${level.level}</b></span> NÍVEL</span><span class="profile-rank-tag">${escape(rank.rank.name.toUpperCase())} · ${number(rank.xp)} PR</span></div></div>
      ${own ? '<button class="modal-btn modal-btn-secondary profile-edit-button" type="button">EDITAR PERFIL</button>' : ''}`;
    hero.querySelector('.profile-avatar-button').onclick = () => selectTab('edit');
    hero.querySelector('.profile-edit-button')?.addEventListener('click', () => selectTab('edit'));
  }
  function renderTabs() {
    const entries = [['overview','VISÃO GERAL'],['history','HISTÓRICO'],['stats','ESTATÍSTICAS'],['collection','COLEÇÃO'], ...(own ? [['edit','EDITAR PERFIL']] : [])];
    tabs.innerHTML = entries.map(([id,label]) => `<button type="button" role="tab" id="profile-tab-${id}" aria-controls="player-profile-panel" aria-selected="${tab === id}" tabindex="${tab === id ? 0 : -1}" data-tab="${id}" class="${tab === id ? 'active' : ''}">${label}</button>`).join('');
    body.setAttribute('aria-labelledby', `profile-tab-${tab}`);
    tabs.querySelectorAll('button').forEach(button => button.onclick = () => selectTab(button.dataset.tab));
  }
  tabs.addEventListener('keydown', event => {
    const buttons = [...tabs.querySelectorAll('button')], index = buttons.indexOf(document.activeElement);
    if (index < 0) return;
    const next = event.key === 'ArrowRight' ? (index+1)%buttons.length : event.key === 'ArrowLeft' ? (index+buttons.length-1)%buttons.length : event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length-1 : -1;
    if (next < 0) return; event.preventDefault(); selectTab(buttons[next].dataset.tab); tabs.querySelectorAll('button')[next].focus();
  });
  function selectTab(value) {
    if (busy || (!own && value === 'edit')) return;
    const restoreFocus = tabs.contains(document.activeElement);
    tab = value; selectedMatch = null; renderTabs(); renderBody(); body.scrollTop = 0;
    if (restoreFocus) tabs.querySelector('[aria-selected="true"]')?.focus();
  }
  const emptyHistory = () => loading ? 'Carregando partidas…' : historyPrivate ? 'Este jogador mantém o histórico privado.' : historyUnavailable ? 'Os registros detalhados ainda não estão disponíveis para este perfil.' : 'Ainda não há partidas registradas neste perfil.';
  function matchCards(list) {
    return list.map(raw => {
      const row = normalizeHistoryRow(raw), date = row.date ? row.date.toLocaleString('pt-BR', { dateStyle:'short', timeStyle:'short' }) : '—';
      return `<button type="button" class="profile-match" data-outcome="${row.outcome}" data-match="${rows.indexOf(raw)}" aria-label="Ver detalhes de ${outcomes[row.outcome]} em ${escape(modeName(row.mode_id))}">
        <span class="profile-match-result">${outcomes[row.outcome]}</span><span class="profile-match-main"><strong>${escape(modeName(row.mode_id))} · ${escape(LEVELS[row.map_id]?.name || row.map_id)}</strong><small>${date} · ${row.ranked ? 'RANQUEADA' : 'NORMAL'}</small></span>
        <span class="profile-match-stats"><b>${row.statKnown[0] ? row.stats[0] : '—'} / ${row.statKnown[1] ? row.stats[1] : '—'}</b><small>Eliminações / mortes</small><small>${row.statKnown[2] ? row.stats[2] : '—'} capturas · ${row.statKnown[3] ? row.stats[3] : '—'} retornos</small></span>
        ${own && row.rewardKnown.some(Boolean) ? `<span class="profile-reward">${row.rewardKnown[2] ? (row.rank_delta > 0 ? '+' : '')+row.rank_delta : '—'} PR<small>${row.rewardKnown[0] ? '+'+row.gold : '—'} Gold · ${row.rewardKnown[1] ? '+'+row.xp : '—'} XP</small></span>` : ''}</button>`;
    }).join('');
  }
  function bindMatchCards() {
    body.querySelectorAll('[data-match]').forEach(button => button.onclick = () => {
      selectedMatch = rows[Number(button.dataset.match)];
      renderBody(); body.scrollTop = 0;
    });
  }
  function renderDetails() {
    const row = normalizeHistoryRow(selectedMatch), summary = row.summary || {}, scores = summary.scores || {};
    body.innerHTML = `<section class="profile-card profile-match-detail"><button class="modal-btn modal-btn-secondary profile-detail-back">← VOLTAR</button>
      <h2>${outcomes[row.outcome]} · ${escape(modeName(row.mode_id))}</h2><p>${escape(LEVELS[row.map_id]?.name || row.map_id)} · ${row.ranked ? 'Ranqueada' : 'Normal'} · ${row.date?.toLocaleString('pt-BR') || 'Data indisponível'}</p>
      ${Number.isFinite(scores.red) && Number.isFinite(scores.blue) ? `<h3>PLACAR FINAL · VERMELHO ${scores.red} × ${scores.blue} AZUL</h3>` : ''}
      <dl class="profile-stat-grid">${['Eliminações','Mortes','Capturas','Retornos'].map((label,index) => stat(label,row.statKnown[index] ? number(row.stats[index]) : '—')).join('')}</dl>
      ${own && row.rewardKnown.some(Boolean) ? `<h3>RECOMPENSAS REGISTRADAS</h3><dl class="profile-stat-grid">${stat('Gold',row.rewardKnown[0] ? '+'+row.gold : '—')}${stat('Experiência',row.rewardKnown[1] ? '+'+row.xp : '—')}${stat('Pontos de rank',row.rewardKnown[2] ? (row.rank_delta>0?'+':'')+row.rank_delta : '—')}</dl>` : ''}
      <p class="profile-notice">Resultado registrado da partida. Capturas e retornos usam o sistema de Pega Bandeira do Rinha Arena.</p></section>`;
    body.querySelector('.profile-detail-back').onclick = () => { selectedMatch = null; renderBody(); };
  }
  function renderOverview() {
    const totals = profileTotals(view), rank = getRankProgress(view.rankXp), level = getLevelProgress({ ...view.rankStats, experienceXp:view.experienceXp });
    body.innerHTML += `<div class="profile-overview-grid"><section class="profile-card"><h3>CARREIRA NA ARENA</h3><dl class="profile-stat-grid">${stat('Partidas', number(totals.matches))}${stat('Vitórias',number(totals.wins))}${stat('Derrotas',number(totals.losses))}${stat('Taxa de vitória',totals.winRate+'%')}</dl><p class="profile-notice">${totals.draws} empates · Totais registrados na conta.</p></section>
      <section class="profile-card"><h3>RANK COMPETITIVO</h3><div class="profile-rank"><img src="./assets/ui/ranks/${rank.rank.asset}" alt=""><div><strong>${escape(rank.rank.name)}</strong><p>${number(rank.xp)} pontos</p></div></div>${progress(rank.progress,'Progresso no rank')}<p>${rank.next ? `${number(rank.next.xp-rank.xp)} pontos até ${escape(rank.next.name)}` : 'Maior rank alcançado'}</p>${own && onOpenRank ? '<button class="modal-btn modal-btn-secondary profile-open-rank">VER RANKING</button>' : ''}</section>
      <section class="profile-card"><h3>PROGRESSÃO</h3><strong>NÍVEL ${level.level}</strong>${progress(level.progress,'Progresso do nível')}<p>${level.isMax ? 'Nível máximo' : `${number(level.xp)} / ${number(level.required)} XP`}</p><p class="profile-notice">Experiência e pontos competitivos evoluem separadamente.</p></section>
      <section class="profile-card profile-featured"><h3>PERSONAGEM EM DESTAQUE</h3><img src="${character(view.cos?.characterId).image}" alt=""><strong>${escape(character(view.cos?.characterId).name)}</strong><p>${(view.cos?.ownedCharacters || []).length} personagens · ${(view.cos?.ownedEmotes || []).length} emotes adquiridos</p></section></div>
      <section class="profile-card"><h3>ÚLTIMAS PARTIDAS</h3><div class="profile-history-list">${rows.length ? matchCards(rows.slice(0,3)) : `<p class="profile-empty">${emptyHistory()}</p>`}</div><button class="modal-btn modal-btn-secondary profile-all-history">VER HISTÓRICO</button></section>`;
    body.querySelector('.profile-all-history').onclick = () => selectTab('history');
    body.querySelector('.profile-open-rank')?.addEventListener('click', () => { close(); onOpenRank(); });
    bindMatchCards();
  }
  function renderHistory() {
    const options = [['mode','Modo',[['all','Todos os modos'],['ctf','Pega Bandeira'],['deathmatch','Mata-mata'],['ffa','Todos contra todos']]],
      ['outcome','Resultado',[['all','Todos os resultados'],['win','Vitórias'],['loss','Derrotas'],['draw','Empates']]],
      ['queue','Fila',[['all','Todas as filas'],['ranked','Ranqueada'],['normal','Normal']]]];
    body.innerHTML += `<div class="profile-history-tools">${options.map(([key,label,values]) => `<label>${label}<select aria-label="${label}" data-filter="${key}">${values.map(([value,text]) => `<option value="${value}" ${filters[key]===value?'selected':''}>${text}</option>`).join('')}</select></label>`).join('')}<button class="modal-btn modal-btn-secondary profile-refresh" ${loading ? 'disabled' : ''}>ATUALIZAR</button></div>
      <p class="profile-notice">Até 50 partidas mais recentes. E / M: eliminações e mortes. Resultados registrados pelo fluxo atual do jogo.</p><div class="profile-history-list">${filterHistory(rows,filters).length ? matchCards(filterHistory(rows,filters)) : `<p class="profile-empty">${rows.length ? 'Nenhuma partida corresponde aos filtros.' : emptyHistory()}</p>`}</div>`;
    body.querySelectorAll('[data-filter]').forEach(select => select.onchange = () => { filters[select.dataset.filter] = select.value; renderBody(); });
    body.querySelector('.profile-refresh').onclick = loadData;
    bindMatchCards();
  }
  function renderStats() {
    if (historyPrivate || historyUnavailable || loading) {
      body.innerHTML += `<section class="profile-card"><h3>DESEMPENHO RECENTE</h3><p class="profile-empty">${emptyHistory()}</p></section>`;
      return;
    }
    const totals = summarizeHistory(rows);
    const complete = key => rows.length > 0 && rows.every(row => Number.isFinite(Number(row.stats?.[key])) && row.stats?.[key] !== null && row.stats?.[key] !== undefined);
    const available = key => complete(key) ? number(totals[key]) : '—';
    body.innerHTML += `<section class="profile-card"><h3>DESEMPENHO RECENTE</h3><p class="profile-notice">Estatísticas das ${rows.length} partidas registradas carregadas. Campos sem registro aparecem como —. ${historyPrivate ? emptyHistory() : ''}</p>
      <dl class="profile-stat-grid">${stat('Eliminações',available('eliminations'))}${stat('Mortes',available('deaths'))}${stat('E / M',complete('eliminations') && complete('deaths') ? totals.kd : '—')}${stat('Vitórias',totals.winRate+'%')}${stat('Capturas',available('captures'))}${stat('Retornos',available('returns'))}</dl></section>
      <section class="profile-card"><h3>RESULTADOS POR MODO</h3><div class="profile-stat-bars">${totals.modes.map(mode => `<div class="profile-stat-bar"><strong>${escape(modeName(mode.mode))}</strong><span>${mode.wins} vitórias / ${mode.matches} partidas</span><progress max="100" value="${Math.round(mode.wins/mode.matches*100)}" aria-label="Vitórias em ${escape(modeName(mode.mode))}"></progress></div>`).join('') || `<p class="profile-empty">${emptyHistory()}</p>`}</div></section>`;
  }
  function renderCollection() {
    const owned = new Set(view.cos?.ownedCharacters || []), emotes = new Set(view.cos?.ownedEmotes || []);
    body.innerHTML += `<p class="profile-collection-status profile-notice" role="status"></p><section class="profile-card"><h3>PERSONAGENS · ${PROFILE_CHARACTERS.filter(c=>owned.has(c.id)).length} / ${PROFILE_CHARACTERS.length}</h3><div class="profile-collection-grid">${PROFILE_CHARACTERS.map(c => `<article class="profile-collect-card" data-owned="${owned.has(c.id)}"><img src="${c.image}" alt="${escape(c.name)}"><strong>${escape(c.name)}</strong><small>${owned.has(c.id) ? (view.cos.characterId===c.id ? 'EM DESTAQUE' : 'ADQUIRIDO') : 'NÃO ADQUIRIDO'}</small>${own ? `<button class="modal-btn modal-btn-secondary" data-character="${c.id}" ${!owned.has(c.id)||view.cos.characterId===c.id||loading?'disabled':''}>DESTACAR / USAR</button>` : ''}</article>`).join('')}</div></section>
      <section class="profile-card"><h3>EMOTES · ${EMOTES.filter(e=>emotes.has(e.id)).length} / ${EMOTES.length}</h3><div class="profile-collection-grid">${EMOTES.map(e => `<article class="profile-collect-card" data-owned="${emotes.has(e.id)}"><img src="${e.image}" alt="${escape(e.name)}"><strong>${escape(e.name)}</strong><small>${emotes.has(e.id)?'ADQUIRIDO':'NÃO ADQUIRIDO'}</small></article>`).join('')}</div></section>
      ${own && onOpenShop ? '<div class="profile-actions"><button class="modal-btn modal-btn-primary profile-open-shop">ABRIR LOJA</button></div>' : ''}`;
    body.querySelector('.profile-open-shop')?.addEventListener('click', () => { close(); onOpenShop(); });
    body.querySelectorAll('[data-character]').forEach(button => button.onclick = async () => {
      if (dirty) {
        body.querySelector('.profile-collection-status').textContent = 'Salve ou cancele as alterações na aba Editar perfil antes de mudar o personagem.';
        return;
      }
      draft = makeDraft(); draft.characterId = button.dataset.character; await saveDraft();
    });
  }
  function makeDraft() { return { nickname:view.name, avatar:view.cos?.avatar || AVATARS[0], bio:view.bio || '', banner:view.banner || 'character', characterId:view.cos?.characterId || 'capivara', historyPublic:view.historyPublic === true }; }
  function renderEdit() {
    draft ||= makeDraft();
    body.innerHTML += `<form class="profile-form"><section class="profile-card"><h3>IDENTIDADE DO JOGADOR</h3><div class="profile-form-row"><label>Nome<input name="nickname" aria-label="Nome" value="${escape(draft.nickname)}" minlength="2" maxlength="12" autocomplete="nickname" required></label><label>Plano de fundo<select name="banner" aria-label="Plano de fundo">${[['character','Personagem'],['ocean','Azul arena'],['sunset','Pôr do sol'],['forest','Floresta']].map(([id,name])=>`<option value="${id}" ${draft.banner===id?'selected':''}>${name}</option>`).join('')}</select></label></div>
      <label>Sobre você<textarea name="bio" aria-label="Sobre você" maxlength="160" rows="2" placeholder="Uma frase para o seu perfil">${escape(draft.bio)}</textarea></label>
      <label>Personagem em destaque<select name="characterId" aria-label="Personagem em destaque">${PROFILE_CHARACTERS.filter(c=>(view.cos?.ownedCharacters || []).includes(c.id)).map(c=>`<option value="${c.id}" ${draft.characterId===c.id?'selected':''}>${escape(c.name)}</option>`).join('')}</select></label>
      <label><input type="checkbox" name="historyPublic" aria-label="Permitir que outros jogadores vejam meu histórico" ${draft.historyPublic?'checked':''}> Permitir que outros jogadores vejam meu histórico</label></section>
      <section class="profile-card"><h3>FOTO DO PERFIL</h3><div class="profile-edit-preview"><img data-avatar src="${imageUrl || getAvatarUrl(draft.avatar)}" alt="Prévia da foto do perfil"><label>Enviar foto<input type="file" name="photo" aria-label="Enviar foto" accept="image/png,image/jpeg,image/webp"></label></div><p class="profile-notice">PNG, JPG ou WebP até 5 MB. A imagem será recortada ao centro em formato quadrado. A foto do perfil é pública.</p>
      <div class="profile-avatar-grid">${AVATARS.map((avatar,i)=>`<button class="profile-avatar-option" type="button" data-avatar="${avatar}" aria-pressed="${!pendingImage && draft.avatar===avatar}" aria-label="Escolher ícone ${i+1}"><img src="${getAvatarUrl(avatar)}" alt=""></button>`).join('')}</div></section>
      <p class="profile-edit-status" role="status" aria-live="polite"></p><div class="profile-actions"><button class="modal-btn modal-btn-secondary profile-discard" type="button">CANCELAR</button><button class="modal-btn modal-btn-primary" type="submit" ${loading ? 'disabled' : ''}>SALVAR ALTERAÇÕES</button></div></form>`;
    const form = body.querySelector('form');
    form.oninput = event => {
      if (event.target.name === 'photo') return;
      dirty = true; draft[event.target.name] = event.target.type === 'checkbox' ? event.target.checked : event.target.value;
    };
    form.onsubmit = event => { event.preventDefault(); if (form.reportValidity()) saveDraft(); };
    form.querySelector('.profile-discard').onclick = () => { dirty=false; draft=null; pendingImage=null; if(imageUrl)URL.revokeObjectURL(imageUrl);imageUrl=null; selectTab('overview'); };
    form.querySelectorAll('.profile-avatar-option').forEach(button => button.onclick = () => {
      draft.avatar=button.dataset.avatar; pendingImage=null; dirty=true; if(imageUrl)URL.revokeObjectURL(imageUrl);imageUrl=null; renderBody();
    });
    form.elements.photo.onchange = async event => {
      const file=event.target.files?.[0]; if(!file) return;
      const status=form.querySelector('.profile-edit-status'); status.textContent='Préparando foto…';
      setBusy(true);
      try { const blob=await prepareAvatarImage(file); if(!overlay.isConnected) return; pendingImage=blob; dirty=true; if(imageUrl)URL.revokeObjectURL(imageUrl);imageUrl=URL.createObjectURL(blob); renderBody(); }
      catch(failure) { status.textContent=failure.message; status.classList.add('profile-error'); }
      finally { setBusy(false); }
    };
  }
  function setBusy(value) {
    busy=value; overlay.dataset.dismissible=String(!value);
    overlay.querySelectorAll('input,textarea,select,button').forEach(control => { if(value) { control.dataset.previousDisabled=String(control.disabled);control.disabled=true; } else if(control.dataset.previousDisabled!==undefined) {control.disabled=control.dataset.previousDisabled==='true';delete control.dataset.previousDisabled;} });
  }
  async function saveDraft() {
    if(busy || !draft) return;
    const name=String(draft.nickname).trim();
    if(name.length<2 || name.length>12 || !validDisplayName(name)) { const status=body.querySelector('.profile-edit-status'); if(status)status.textContent='Use um nome válido entre 2 e 12 caracteres.'; return; }
    setBusy(true);
    const status=body.querySelector('.profile-edit-status');
    if(status)status.textContent='Salvando perfil…';
    try {
      if(pendingImage) { draft.avatar=await uploadAvatar(pendingImage,profile.playerId); pendingImage=null; }
      if(!isAvatarId(draft.avatar)) throw new Error('Foto de perfil inválida.');
      const row=await savePresentation({ ...draft, nickname:name });
      if(!row || row.id!==profile.playerId) throw new Error('Não foi possível confirmar a alteração.');
      applyAccountProfile(profile,row); view=playerProfileFromRow(row); profile.save?.(); onChange();
      dirty=false; draft=null; error=''; if(imageUrl)URL.revokeObjectURL(imageUrl);imageUrl=null; renderHero(); tab='overview'; renderTabs(); renderBody();
    } catch(failure) {
      if(status?.isConnected) { status.textContent=failure.message;status.classList.add('profile-error'); }
      else { error=failure.message; renderBody(); }
    } finally { setBusy(false); }
  }
  function renderBody() {
    body.innerHTML=error ? `<p class="profile-error" role="alert">${escape(error)} <button type="button" class="profile-retry modal-btn modal-btn-secondary">TENTAR NOVAMENTE</button></p>` : '';
    if(!view) { if(!error)body.innerHTML='<p class="profile-empty">Carregando perfil…</p>';body.querySelector('.profile-retry')?.addEventListener('click',loadData);return; }
    if(selectedMatch)renderDetails();
    else if(tab==='overview')renderOverview();
    else if(tab==='history')renderHistory();
    else if(tab==='stats')renderStats();
    else if(tab==='collection')renderCollection();
    else if(tab==='edit' && own)renderEdit();
    body.querySelector('.profile-retry')?.addEventListener('click',loadData);
  }
  async function loadData() {
    if(busy) return;
    const request=++generation;loading=true;error='';renderBody();
    try {
      const row=await loadProfile(playerId);
      if(request!==generation || !overlay.isConnected)return;
      if(!row || row.id!==playerId)throw new Error('Perfil não encontrado ou indisponível.');
      view=playerProfileFromRow(row);if(!dirty)draft=null;renderHero();
      if (own && loadHistory === fetchPlayerHistory) {
        await flushPlayerMatchHistory(profile.playerId).catch(failure => console.warn('[history] pending sync failed:',failure.message));
      }
      const history=await loadHistory(playerId,50);
      if(request!==generation || !overlay.isConnected)return;
      historyPrivate=history===null && !own && view.historyPublic!==true;historyUnavailable=history===null && !historyPrivate;rows=Array.isArray(history)?history:[];
    } catch(failure) { if(request!==generation || !overlay.isConnected)return;error=failure.message; }
    finally { if(request===generation && overlay.isConnected) { loading=false;renderBody(); } }
  }
  const onAccountSync = () => {
    if(!own || busy || dirty || !overlay.isConnected)return;
    view={...profile,cos:{...profile.cos}};draft=null;renderHero();renderBody();
  };
  window.addEventListener('blast:account-sync',onAccountSync);
  overlay.addEventListener('arena:modal-closed',()=>window.removeEventListener('blast:account-sync',onAccountSync),{once:true});
  const oldClose=close;
  overlay.querySelector('.modal-close').onclick=()=>{ if(!busy)window.removeEventListener('blast:account-sync',onAccountSync);oldClose(); };
  renderHero();renderTabs();renderBody();overlay.querySelector('.modal-close').focus({ preventScroll:true });loadData();
  return { close:()=>{window.removeEventListener('blast:account-sync',onAccountSync);close();}, refresh:loadData };
}
