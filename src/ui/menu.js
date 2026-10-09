// Blast Arena — Arcade Game Lobby & Selection Menu.
// Faithful reproduction of the competitive arcade video game UI reference:
// - Left Panel: Personalização (Name, Modes, 2x2 Arena Grid, Friendly Fire)
// - Center: Floating Hero Logo + Large Interactive Map Showcase Card with mini-thumbnails
// - Right Panel: Giant Play vs Bots CTA, Online Play (Lobby & Create), Physics Lab, How to Play
// - Top-Right: Quick utility buttons (Settings/Audio, Stats, Lobby)

import { LEVELS, DEFAULT_LEVEL, newProceduralSeed } from '../content/levels/index.js';
import { createRoom, listRooms } from '../net/rooms.js';
import { HATS, SKINS } from '../content/cosmetics.js';
import { RANKS, getRankProgress, rankSpriteStyle } from '../content/ranks.js';
import { getLevelBadgeAsset, getLevelProgress } from '../content/levels.js';
import { listPlayerRankings, submitPlayerRanking } from '../net/ranking.js';
import { fetchAccountProfile, saveAccountProfile, signOut, applyAccountProfile } from '../net/account.js';
import { getPlayerDiscipline } from '../net/discipline.js';
import { openAuthGate } from './auth.js';
import { applySettings, getSettings, keyLabel, saveSettings } from '../settings.js';
import { CONFIG } from '../core/config.js';
import { MAX_TEAM_SIZE, MAX_PLAYERS, clampTeamSize, clampPlayerCount, isRoomWithinCapacity as roomWithinCapacity } from '../game/capacity.js';
import { flushPlayerMatchHistory } from '../net/profile.js';
import { claimMission, ensureMissions, missionProgress } from '../game/missions.js';
import { createCharacterTrade, giftFriendResource, listCharacterTrades, listFriendRequests, listFriends, respondCharacterTrade, respondFriendRequest, searchPlayers, sendFriendRequest } from '../net/social.js';
import { EMOTES, EMOTE_PRICE } from '../content/emotes.js';
import { SupabaseRealtimeChannel } from '../net/supabase.js';
import { promptRoomPassword, showMessageDialog } from './dialog.js';
import { leaderboardMarkup, leaderboardRowsMarkup } from './leaderboard.js';
import { createLobbyLoading } from './lobbyLoading.js';
import { openPlayerProfile } from './playerProfile.js';
import { AVATARS, isAvatarId, getAvatarUrl } from '../content/avatars.js';

const escapeHtml = (value) => String(value ?? '').replace(/[&<>'"]/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
}[char]));
const SHOP_CHARACTERS = [
  ['capivara', 'Capivara'], ['cachorro', 'Cachorro'], ['coala', 'Coala'], ['coelho', 'Coelho'],
  ['crocodilo', 'Crocodilo'], ['furao', 'Furão'], ['gato', 'Gato'], ['jacare', 'Jacaré'],
  ['macaco', 'Macaco'], ['pato', 'Pato'], ['pavao', 'Pavão'], ['porco', 'Porco'],
  ['tartaruga', 'Tartaruga'], ['tubarao', 'Tubarão'],
].map(([id, name]) => ({ id, name, acquired: id === 'capivara' }));
const CHARACTER_PRICE = 900;


export function createMenu(uiRoot, profile, { onPlayLocal, onPlayOnline, onPrepareOnline, onStartPrepared, onPlayLab, onClickSound }) {
  const el = document.createElement('div');
  el.className = 'menu lobby-loading';
  const loading = createLobbyLoading(uiRoot);
  loading.show();
  let visibilityRequest = 0;
  let notifyAuthenticated;
  const authenticatedReady = new Promise((resolve) => { notifyAuthenticated = resolve; });
  let accountSyncTimer = 0;
  let accountSyncBusy = false;
  let lastLocalSaveAt = 0;
  let lastRemoteSnapshot = '';
  const accountSnapshot = (row) => JSON.stringify([row?.nickname, row?.gold, row?.rank_points, row?.matches, row?.wins, row?.losses, row?.avatar, row?.selected_character, row?.owned_characters, row?.owned_emotes, row?.friendly_fire, row?.profile_bio, row?.profile_banner, row?.history_public]);
  applySettings();

  // Mobile browsers only allow fullscreen after a user gesture. Entering it on
  // the first touch hides the address/search bar and preserves the landscape UI.
  let fullscreenRequested = false;
  const enterMobileFullscreen = async () => {
    const isMobile = navigator.maxTouchPoints > 0 || matchMedia('(pointer: coarse)').matches;
    if (!isMobile || fullscreenRequested || !getSettings().autoFullscreen || document.fullscreenElement) return;
    fullscreenRequested = true;
    window.removeEventListener('pointerup', enterMobileFullscreen);
    const root = document.documentElement;
    const requestFullscreen = root.requestFullscreen || root.webkitRequestFullscreen;
    if (!requestFullscreen) return;
    try {
      await requestFullscreen.call(root, { navigationUI: 'hide' });
      const orientationLock = screen.orientation?.lock?.('landscape');
      if (orientationLock) await orientationLock.catch(() => {});
    } catch {
      // Some browsers only expose fullscreen for installed web apps or video.
    }
  };
  window.addEventListener('pointerup', enterMobileFullscreen);

  const MAP_DATA = {
    foundry: {
      id: 'foundry',
      name: 'Foundry Court',
      img: './assets/maps/foundry.png',
      desc: 'A floating forge platform. Three lanes, one flag, long falls.',
    },
    dojo: {
      id: 'dojo',
      name: 'The Dojo',
      img: './assets/maps/dojo.png',
      desc: 'A tranquil temple arena with cherry blossoms and walled perimeter.',
    },
    skyhaven: {
      id: 'skyhaven',
      name: 'Skyhaven',
      img: './assets/maps/skyhaven.png',
      desc: 'Floating islands connected by bridges high in the clouds.',
    },
    feira_suspensa: {
      id: 'feira_suspensa',
      name: 'Feira Suspensa',
      img: './assets/maps/feira-suspensa.png',
      desc: 'Feira brasileira flutuante para batalhas 3v3 com cenário interativo.',
    },
    procedural: {
      id: 'procedural',
      name: 'Aleatório',
      img: './assets/maps/random-arena-cover.webp',
      desc: 'Uma arena diferente é escolhida ou gerada a cada partida.',
    },
  };

  const MODES = [
    { id: 'ctf', label: '🚩 Capture the Flag', sub: 'Equipes - vence quem capturar 5 bandeiras.' },
    { id: 'deathmatch', label: '💀 Death Match', sub: 'Equipes - eliminações vencem a partida.' },
    { id: 'ffa', label: '⚔️ Todos contra Todos', sub: 'Cada um por si - 10 eliminações para vencer.' },
  ];

  const REFERENCE_SKINS = [
    '#f6cbb2', // 1: peach
    '#e2aa6c', // 2: tan
    '#be7a44', // 3: caramel
    '#8a4e23', // 4: brown
    '#fbe6cb', // 5: cream
    '#a6e8cb', // 6: mint
    '#bdaee6', // 7: lavender
  ];

  if (!profile.hat) profile.hat = 'crown';
  if (!profile.skin) profile.skin = REFERENCE_SKINS[6];
  if (!isAvatarId(profile.cos.avatar)) profile.cos.avatar = AVATARS[0];
  profile.cos.characterId = ['crocodilo', 'porco', 'pato', 'gato', 'cachorro', 'macaco'].includes(profile.cos.characterId) ? profile.cos.characterId : 'capivara';
  profile.cos.ownedCharacters = [...new Set(['capivara', ...(profile.cos.ownedCharacters || [])])];
  profile.cos.ownedEmotes = [...new Set(profile.cos.ownedEmotes || [])];

  let selectedMode = 'ctf';
  let selectedLevel = DEFAULT_LEVEL in MAP_DATA ? DEFAULT_LEVEL : 'foundry';
  let confirmedGame = {
    matchType: 'ranked', chosenMap: 'procedural', modeId: 'ctf',
    teamSize: MAX_TEAM_SIZE, ffaSize: MAX_PLAYERS, respawnTime: 5, botType: 'match',
    matchConfig: null, name: '', code: '', password: undefined,
  };
  const initialRank = getRankProgress(profile.rankXp);
  const initialLevel = getLevelProgress(profile.rankStats);

  el.innerHTML = `
    <video class="lobby-bg-video" muted loop playsinline preload="none" poster="./assets/media/lobby-background-poster.webp" data-src="./assets/media/lobby-background.mp4" aria-hidden="true"></video>
    <div class="home-lobby">
      <section class="player-card" aria-label="Perfil do jogador">
        <button class="player-avatar" type="button" aria-label="Abrir meu perfil"><img src="${getAvatarUrl(profile.cos.avatar)}" alt="Ícone do perfil" /></button>
        <div class="player-summary">
          <input class="name-input player-name" maxlength="12" aria-label="Nome do jogador" value="${profile.name || ''}" />
          <div class="player-progress-row">
            <div class="level-badge"><img src="./assets/ui/levels/${getLevelBadgeAsset(initialLevel.level)}" alt="Nível ${initialLevel.level}" /><b>${initialLevel.level}</b></div>
            <div class="xp-wrap"><div class="xp-track"><i style="width:${initialLevel.progress * 100}%"></i><strong>${initialLevel.isMax ? 'NÍVEL MÁXIMO' : `${initialLevel.xp} / ${initialLevel.required} XP`}</strong></div></div>
          </div>
        </div>
        <div class="rank-divider"></div>
        <button class="rank-badge-wrap" type="button" aria-label="Ver progressão de ranks"><img class="rank-shield" src="./assets/ui/ranks/${initialRank.rank.asset}" alt="${initialRank.rank.name}" /></button>
      </section>

      <nav class="top-actions" aria-label="Ações rápidas">
        <div class="coin-card"><img class="coin-crown" src="./assets/ui/capicoin.png" alt="Capicoin" /><strong>${Math.max(0, Number(profile.gold) || 0).toLocaleString('pt-BR')}</strong><button class="coin-plus" aria-label="Adicionar moedas">+</button></div>
        <button class="image-icon-btn btn-lobby" aria-label="Amigos e salas"><img src="./assets/ui/menu-friends.webp" alt="" /></button>
        <button class="image-icon-btn btn-settings" aria-label="Configurações"><img src="./assets/ui/menu-config.webp" alt="" /></button>
        <button class="image-icon-btn btn-audio" aria-label="Áudio"><img src="./assets/ui/menu-audio.webp" alt="" /></button>
      </nav>

      <button class="art-button shop-button btn-shop" aria-label="Loja de personagens"><img src="./assets/ui/menu-shop.webp" alt="Loja de personagens" /></button>
      <button class="art-button ranking-button btn-ranking" aria-label="Ranking"><img src="./assets/ui/menu-ranking.webp" alt="Ranking" /></button>
      <button class="art-button missions-button btn-missions" aria-label="Missões"><img src="./assets/ui/menu-missions.webp" alt="Missões" /></button>

      <button class="map-selector" aria-label="Selecionar arena">
        <img class="map-selector-thumb" src="./assets/maps/random-arena-cover.webp" alt="" />
        <span class="map-selector-copy"><strong class="big-map-name">RANQUEADA</strong><small><span class="big-map-sub">Aleatório</span></small></span>
        <span class="map-chevron">›</span>
      </button>

      <button class="art-button play-button play-btn-huge" aria-label="Jogar"><img src="./assets/ui/menu-play.webp" alt="Jogar" /></button>

      <div class="quick-config hidden" aria-label="Configurações da partida">
        <div class="quick-config-head"><strong>CONFIGURAÇÕES</strong><button class="quick-config-close" aria-label="Fechar">✕</button></div>
        <label>NOME DO JOGADOR</label>
        <div class="config-name-mirror">${profile.name || 'SEM NICK'}</div>
        <label>CHAPÉU</label>
        <div class="hat-row">${HATS.map((h, i) => `<button class="hat-btn ${profile.hat === h.id ? 'sel' : ''}" data-hat="${h.id}" title="${h.name}"><img loading="lazy" src="./assets/ui/hat_${i}.png" alt="${h.name}" class="hat-img" /></button>`).join('')}</div>
        <label>PELE</label>
        <div class="skin-row">${REFERENCE_SKINS.map((c) => `<button class="skin-btn ${profile.skin === c ? 'sel' : ''}" data-skin="${c}" style="background-color:${c}" title="Pele"></button>`).join('')}</div>
        <label>MODO</label>
        <div class="mode-grid">
          <button class="mode-btn sel" data-mode="ctf">🚩 Capture a Bandeira</button>
          <button class="mode-btn" data-mode="deathmatch">💀 Death Match</button>
          <button class="mode-btn mode-btn-full" data-mode="ffa">⚔️ Todos contra Todos</button>
        </div>
        <label>ARENA</label>
        <div class="arena-grid">
          ${Object.values(MAP_DATA).map((m) => `<button class="arena-card ${m.id === selectedLevel ? 'sel' : ''}" data-level="${m.id}"><span class="arena-thumb" style="background-image:url('${m.img}')"></span><span class="arena-label">${m.name}</span></button>`).join('')}
        </div>
        <label>FOGO AMIGO</label>
        <div class="ff-grid"><button class="ff-btn ${profile.friendlyFire ? '' : 'sel'}" data-ff="false">🛡️ Desativado</button><button class="ff-btn ${profile.friendlyFire ? 'sel' : ''}" data-ff="true">🔥 Ativado</button></div>
        <div class="config-extra-actions"><button class="btn-custom-create">CRIAR SALA</button><button class="btn-duel">LIVE BOT</button><button class="btn-doll">TREINO</button><button class="btn-how-to-play">COMO JOGAR</button></div>
      </div>
      <div class="menu-err hidden"></div>
    </div>
    <!-- Legacy layout removed; its game and multiplayer actions remain wired to the new home screen. -->
    <div class="legacy-menu-template" hidden>
      <div class="lobby-root"><div class="lobby-grid">
        <!-- 1. PAINEL LATERAL ESQUERDO: PERSONALIZAÇÃO -->
        <aside class="lobby-left-panel">
          <!-- Top Header -->
          <div class="panel-header">
            <div class="header-crown">
              <svg width="34" height="28" viewBox="0 0 24 24" fill="url(#crownGold)">
                <defs>
                  <linearGradient id="crownGold" x1="0%" y1="0%" x2="100%" y2="100%">
                    <stop offset="0%" stop-color="#ffd54f" />
                    <stop offset="100%" stop-color="#ff8f00" />
                  </linearGradient>
                </defs>
                <path d="M5 16L3 5l5.5 5L12 4l3.5 6L21 5l-2 11H5z"/>
              </svg>
            </div>
            <div class="header-text">
              <h2 class="panel-title">PERSONALIZAÇÃO</h2>
              <span class="panel-subtitle">DEIXE SEU PERSONAGEM COM A SUA CARA</span>
            </div>
          </div>

          <!-- Player Name -->
          <div class="field-block">
            <label class="field-label">NOME DO JOGADOR</label>
            <div class="name-input-wrapper">
              <svg class="input-user-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#7e92b3" stroke-width="2">
                <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>
                <circle cx="12" cy="7" r="4"/>
              </svg>
              <input class="name-input" maxlength="12" placeholder="Digite seu nick" value="${profile.name || ''}" />
            </div>
          </div>

          <!-- HAT -->
          <div class="field-block">
            <label class="field-label">HAT</label>
            <div class="hat-row">
              ${HATS.map((h, i) => `
                <button class="hat-btn ${profile.hat === h.id ? 'sel' : ''}" data-hat="${h.id}" title="${h.name}">
                  <img loading="lazy" src="./assets/ui/hat_${i}.png" alt="${h.name}" class="hat-img" />
                </button>
              `).join('')}
            </div>
          </div>

          <!-- SKIN -->
          <div class="field-block">
            <label class="field-label">SKIN</label>
            <div class="skin-row">
              ${REFERENCE_SKINS.map((c) => `
                <button class="skin-btn ${profile.skin === c ? 'sel' : ''}" data-skin="${c}" style="background-color: ${c};" title="Skin"></button>
              `).join('')}
            </div>
          </div>

          <!-- Modo de Jogo -->
          <div class="field-block">
            <label class="field-label">
              <span class="field-icon">🎮</span> MODO DE JOGO
            </label>
            <div class="mode-grid">
              <button class="mode-btn mode-ctf sel" data-mode="ctf">
                <span class="mode-icon">🚩</span>
                <span class="mode-text">Capture the Flag</span>
              </button>
              <button class="mode-btn mode-dm" data-mode="deathmatch">
                <span class="mode-icon">💀</span>
                <span class="mode-text">Death Match</span>
              </button>
              <button class="mode-btn mode-ffa mode-btn-full" data-mode="ffa">
                <span class="mode-icon">⚔️</span>
                <span class="mode-text">Todos contra Todos</span>
              </button>
            </div>
          </div>

          <!-- Arena 2x2 Grid -->
          <div class="field-block">
            <label class="field-label">
              <span class="field-icon">📍</span> ARENA
            </label>
            <div class="arena-grid">
              <!-- Foundry Court -->
              <div class="arena-card sel" data-level="foundry">
                <div class="arena-thumb" style="background-image: url('./assets/maps/card_foundry.png');"></div>
                <div class="arena-label">
                  <span class="arena-pin">📍</span>
                  <span class="arena-name">Foundry Court</span>
                </div>
              </div>
              <!-- The Dojo -->
              <div class="arena-card" data-level="dojo">
                <div class="arena-thumb" style="background-image: url('./assets/maps/card_dojo.png');"></div>
                <div class="arena-label">
                  <span class="arena-pin">📍</span>
                  <span class="arena-name">The Dojo</span>
                </div>
              </div>
              <!-- Skyhaven -->
              <div class="arena-card" data-level="skyhaven">
                <div class="arena-thumb" style="background-image: url('./assets/maps/card_skyhaven.png');"></div>
                <div class="arena-label">
                  <span class="arena-pin">📍</span>
                  <span class="arena-name">Skyhaven</span>
                </div>
              </div>
              <!-- Procedural -->
              <div class="arena-card" data-level="feira_suspensa">
                <div class="arena-thumb" style="background-image: url('./assets/maps/card_feira_suspensa.png');"></div>
                <div class="arena-label"><span class="arena-pin">📍</span><span class="arena-name">Feira Suspensa</span></div>
              </div>
              <!-- Procedural -->
              <div class="arena-card" data-level="procedural">
                <div class="arena-thumb" style="background-image: url('./assets/maps/card_procedural.png');"></div>
                <div class="arena-label">
                  <span class="arena-pin">🎲</span>
                  <span class="arena-name">Procedural</span>
                </div>
              </div>
            </div>
          </div>

          <!-- Fogo Amigo -->
          <div class="field-block">
            <label class="field-label">
              <span class="field-icon">🛡️</span> FOGO AMIGO
            </label>
            <div class="ff-grid">
              <button class="ff-btn ff-off ${profile.friendlyFire ? '' : 'sel'}" data-ff="false">
                <span class="ff-icon">🛡️</span>
                <span>Desativado</span>
              </button>
              <button class="ff-btn ff-on ${profile.friendlyFire ? 'sel' : ''}" data-ff="true">
                <span class="ff-icon">🔥</span>
                <span>Ativado</span>
              </button>
            </div>
          </div>
        </aside>

        <!-- 2. ÁREA CENTRAL: LOGO SUPERIOR + GRANDE CARD DE MAPA INFERIOR -->
        <main class="lobby-center-col">
          <!-- Hero Logo (Floating directly over background) -->
          <div class="lobby-logo-container">
            <img loading="lazy" src="./assets/logo.png" alt="RINHA ARENA — PEGA BANDEIRA" class="lobby-logo-img" />
          </div>

          <!-- Big Map Showcase Card -->
          <div class="big-map-card">
            <div class="big-map-preview">
              <div class="big-map-img" style="background-image: url('./assets/maps/foundry.png');"></div>
            </div>
            <div class="big-map-footer">
              <div class="big-map-info">
                <div class="big-map-title">
                  <span class="big-pin">📍</span>
                  <span class="big-map-name">Foundry Court</span>
                </div>
                <div class="big-map-desc">A floating forge platform. Three lanes, one flag, long falls.</div>
                <div class="big-map-sub">Equipes - vence quem capturar 5 bandeiras.</div>
              </div>
              <div class="big-map-thumbs-col">
                <div class="map-mini-thumb sel" data-level="foundry" title="Foundry Court" style="background-image: url('./assets/maps/mini_foundry.png');"></div>
                <div class="map-mini-thumb" data-level="dojo" title="The Dojo" style="background-image: url('./assets/maps/mini_dojo.png');"></div>
                <div class="map-mini-thumb" data-level="skyhaven" title="Skyhaven" style="background-image: url('./assets/maps/mini_skyhaven.png');"></div>
                <div class="map-mini-thumb" data-level="feira_suspensa" title="Feira Suspensa" style="background-image: url('./assets/maps/mini_feira_suspensa.png');"></div>
                <div class="map-mini-thumb" data-level="procedural" title="Procedural" style="background-image: url('./assets/maps/mini_procedural.png');"></div>
              </div>
            </div>
          </div>
        </main>

        <!-- 3. PAINEL DE AÇÕES À DIREITA -->
        <aside class="lobby-right-col">
          <!-- ENORME BOTÃO PLAY VS BOTS -->
          <button class="play-btn-huge">
            <span class="play-arrow">▶</span>
            <span class="play-text">PLAY VS BOTS</span>
            <span class="play-chevrons">»</span>
          </button>

          <!-- JOGAR ONLINE -->
          <div class="action-card action-card-online">
            <div class="action-card-header">
              <span class="online-globe">🌐</span>
              <span>JOGAR ONLINE</span>
            </div>
            <div class="online-btn-row">
              <button class="btn-action-blue btn-lobby">
                <img loading="lazy" src="./assets/ui/icon_ver_salas.png" class="btn-icon-img" alt="Salas" />
                <span>VER SALAS ONLINE</span>
              </button>
              <button class="btn-action-gold btn-custom-create">
                <img loading="lazy" src="./assets/ui/icon_criar_sala.png" class="btn-icon-img" alt="Criar" />
                <span>CRIAR SALA</span>
              </button>
            </div>
          </div>

          <!-- PHYSICS LAB -->
          <div class="action-card action-card-lab">
            <div class="action-card-header lab-header">
              <span class="lab-beaker">🧪</span>
              <span>PHYSICS LAB</span>
            </div>
            <div class="lab-btn-row">
              <button class="lab-btn btn-duel">
                <img loading="lazy" src="./assets/ui/icon_live_bot.png" class="btn-icon-img" alt="Live Bot" />
                <span>live bot</span>
              </button>
              <button class="lab-btn btn-doll">
                <img loading="lazy" src="./assets/ui/icon_training_doll.png" class="btn-icon-img" alt="Training Doll" />
                <span>training doll</span>
              </button>
            </div>
          </div>

          <!-- COMO JOGAR -->
          <button class="btn-how-to-play">
            <div class="htp-left">
              <span class="htp-icon">?</span>
              <span class="htp-text">Como Jogar / How to play</span>
            </div>
            <span class="htp-arrow">›</span>
          </button>

          <!-- Error Feedback Container -->
          <div class="menu-err hidden"></div>
        </aside>
      </div>
    </div></div></div>
  `;
  el.querySelectorAll('.legacy-menu-template img, .quick-config img').forEach((image) => { image.loading = 'lazy'; });
  uiRoot.appendChild(el);

  // ------------------------------------------------------------ Element queries
  const nameInput = el.querySelector('.name-input');
  const hatBtns = el.querySelectorAll('.hat-btn');
  const skinBtns = el.querySelectorAll('.skin-btn');
  const modeBtns = el.querySelectorAll('.mode-btn');
  const arenaCards = el.querySelectorAll('.arena-card');
  const ffBtns = el.querySelectorAll('.ff-btn');
  const miniThumbs = el.querySelectorAll('.map-mini-thumb');

  const bigMapImg = el.querySelector('.big-map-img');
  const bigMapName = el.querySelector('.big-map-name');
  const bigMapDesc = el.querySelector('.big-map-desc');
  const bigMapSub = el.querySelector('.big-map-sub');

  const btnPlayBots = el.querySelector('.play-btn-huge');
  const btnLobby = el.querySelector('.btn-lobby');
  const btnCustomCreate = el.querySelector('.btn-custom-create');
  const btnDuel = el.querySelector('.btn-duel');
  const btnDoll = el.querySelector('.btn-doll');
  const btnHowToPlay = el.querySelector('.btn-how-to-play');
  const errBox = el.querySelector('.menu-err');
  const btnSettings = el.querySelector('.btn-settings');
  const btnAudio = el.querySelector('.btn-audio');
  const configPanel = el.querySelector('.quick-config');
  const mapSelector = el.querySelector('.map-selector');
  const mapSelectorThumb = el.querySelector('.map-selector-thumb');
  const xpFill = el.querySelector('.xp-track i');
  const xpText = el.querySelector('.xp-track strong');
  const levelText = el.querySelector('.level-badge b');
  const levelBadge = el.querySelector('.level-badge img');
  const coinText = el.querySelector('.coin-card strong');
  const rankShield = el.querySelector('.rank-shield');
  const playerAvatar = el.querySelector('.player-avatar img');
  const lobbyVideo = el.querySelector('.lobby-bg-video');
  let authenticated = false;
  const lobbyMusic = new Audio();
  lobbyMusic.loop = true;
  lobbyMusic.preload = 'none';
  lobbyMusic.volume = getSettings().musicVolume / 100;
  btnAudio.classList.toggle('muted', localStorage.getItem('blast.muted') === '1');

  const playLobbyMedia = () => {
    if (!authenticated || el.classList.contains('lobby-loading') || el.classList.contains('hidden')) return;
    if (!lobbyVideo.getAttribute('src')) lobbyVideo.src = lobbyVideo.dataset.src;
    lobbyVideo.play().catch(() => {});
    if (!lobbyMusic.getAttribute('src')) lobbyMusic.src = './audio/lobby-theme.m4a';
    lobbyMusic.muted = localStorage.getItem('blast.muted') === '1';
    lobbyMusic.play().catch(() => {});
  };
  const pauseLobbyMedia = () => {
    lobbyVideo.pause();
    lobbyMusic.pause();
  };
  window.addEventListener('pointerdown', () => {
    if (!el.classList.contains('hidden')) playLobbyMedia();
  }, { once: true });
  playLobbyMedia();

  // ------------------------------------------------------------ Reactive State
  function syncUI() {
    const meta = MAP_DATA[confirmedGame.chosenMap] || MAP_DATA.procedural;
    const mode = MODES.find((m) => m.id === selectedMode) || MODES[0];

    // 1. Hat and Skin selection active class
    hatBtns.forEach((btn) => {
      btn.classList.toggle('sel', btn.dataset.hat === profile.hat);
    });
    skinBtns.forEach((btn) => {
      btn.classList.toggle('sel', btn.dataset.skin === profile.skin);
    });

    // 2. Left arena cards active class
    arenaCards.forEach((card) => {
      card.classList.toggle('sel', card.dataset.level === selectedLevel);
    });

    // 3. Mini thumbnails active class
    miniThumbs.forEach((thumb) => {
      thumb.classList.toggle('sel', thumb.dataset.level === selectedLevel);
    });

    // 4. Mode buttons active class
    modeBtns.forEach((btn) => {
      btn.classList.toggle('sel', btn.dataset.mode === selectedMode);
    });

    // 5. Update Big Map Card
    if (bigMapImg) bigMapImg.style.backgroundImage = `url('${meta.img}')`;
    if (mapSelectorThumb) mapSelectorThumb.src = meta.img;
    const gameTypeNames = { ranked: 'RANQUEADA', normal: 'NORMAL GAME', bots: 'CONTRA BOT', custom: 'PERSONALIZADA' };
    bigMapName.textContent = gameTypeNames[confirmedGame.matchType] || 'RANQUEADA';
    if (bigMapDesc) bigMapDesc.textContent = meta.desc;
    bigMapSub.textContent = meta.name;

    const rankProgress = getRankProgress(profile.rankXp);
    const levelProgress = getLevelProgress(profile.rankStats);
    levelText.textContent = levelProgress.level;
    const levelBadgeAsset = getLevelBadgeAsset(levelProgress.level);
    const levelBadgeUrl = `./assets/ui/levels/${levelBadgeAsset}?level=${levelProgress.level}`;
    if (!levelBadge.src.endsWith(levelBadgeUrl.replace('./', '/'))) levelBadge.src = levelBadgeUrl;
    levelBadge.alt = `Emblema do nível ${levelProgress.level}`;
    levelBadge.closest('.level-badge')?.setAttribute('data-level', String(levelProgress.level));
    xpFill.style.width = `${levelProgress.progress * 100}%`;
    xpText.textContent = levelProgress.isMax ? 'NÍVEL MÁXIMO' : `${levelProgress.xp} / ${levelProgress.required} XP`;
    rankShield.src = `./assets/ui/ranks/${rankProgress.rank.asset}`;
    rankShield.alt = rankProgress.rank.name;
    playerAvatar.src = getAvatarUrl(profile.cos.avatar);
    coinText.textContent = Math.max(0, Number(profile.gold) || 0).toLocaleString('pt-BR');
  }

  // ------------------------------------------------------------ Event listeners
  // Name input
  nameInput.value = profile.name || '';
  nameInput.addEventListener('input', () => {
    profile.name = nameInput.value.trim();
    profile.save();
    const mirror = el.querySelector('.config-name-mirror');
    if (mirror) mirror.textContent = profile.name;
  });
  nameInput.addEventListener('change', () => submitPlayerRanking(profile).catch(() => {}));

  // Hat Selection
  hatBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      profile.hat = btn.dataset.hat;
      profile.cos.hat = profile.hat;
      profile.save();
      onClickSound?.();
      syncUI();
    });
  });

  // Skin Selection
  skinBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      profile.skin = btn.dataset.skin;
      profile.cos.skin = profile.skin;
      profile.save();
      onClickSound?.();
      syncUI();
    });
  });

  // Mode Selection
  modeBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      const mode = btn.dataset.mode;
      if (selectedMode === mode) return;
      selectedMode = mode;
      onClickSound?.();
      syncUI();
    });
  });

  // Arena Grid Selection
  arenaCards.forEach((card) => {
    card.addEventListener('click', () => {
      const lvl = card.dataset.level;
      if (selectedLevel === lvl) return;
      selectedLevel = lvl;
      onClickSound?.();
      syncUI();
    });
  });

  // Mini-thumbnail Selection
  miniThumbs.forEach((thumb) => {
    thumb.addEventListener('click', () => {
      const lvl = thumb.dataset.level;
      if (selectedLevel === lvl) return;
      selectedLevel = lvl;
      onClickSound?.();
      syncUI();
    });
  });

  // Friendly Fire Buttons
  ffBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      const val = btn.dataset.ff === 'true';
      if ((profile.friendlyFire ?? false) === val) return;
      profile.friendlyFire = val;
      profile.save();
      onClickSound?.();
      ffBtns.forEach((b) => b.classList.toggle('sel', (b.dataset.ff === 'true') === val));
    });
  });

  // The lobby play button starts the configuration previously confirmed.
  btnPlayBots.addEventListener('click', () => launchConfirmedGame(confirmedGame));

  // Physics Lab
  btnDuel.addEventListener('click', () => {
    onClickSound?.();
    onPlayLab('duel');
  });
  btnDoll.addEventListener('click', () => {
    onClickSound?.();
    onPlayLab('doll');
  });

  // Online Multiplayer Modals
  btnLobby.addEventListener('click', () => {
    onClickSound?.();
    openLobbyModal();
  });
  btnCustomCreate.addEventListener('click', () => openCustomCreateModal());

  // How to play modal
  btnHowToPlay.addEventListener('click', () => openHowToPlayModal());
  btnSettings.addEventListener('click', () => {
    onClickSound?.();
    openSettingsModal();
  });
  el.querySelector('.quick-config-close').addEventListener('click', () => configPanel.classList.add('hidden'));
  btnAudio.addEventListener('click', () => {
    onClickSound?.();
    const nextMuted = localStorage.getItem('blast.muted') !== '1';
    localStorage.setItem('blast.muted', nextMuted ? '1' : '0');
    window.dispatchEvent(new CustomEvent('blast:mute-change', { detail: { muted: nextMuted } }));
    lobbyMusic.muted = nextMuted;
    btnAudio.classList.toggle('muted', nextMuted);
    btnAudio.setAttribute('aria-label', nextMuted ? 'Ativar áudio' : 'Desativar áudio');
  });
  mapSelector.addEventListener('click', () => openGameOptionsModal('create'));
  el.querySelector('.btn-shop').addEventListener('click', () => {
    onClickSound?.();
    openShopModal();
  });
  el.querySelector('.player-avatar').addEventListener('click', () => openProfilePage());
  el.querySelector('.rank-badge-wrap').addEventListener('click', () => openRankProgressModal());
  el.querySelector('.btn-ranking').addEventListener('click', () => openLeaderboardModal());
  el.querySelector('.btn-missions').addEventListener('click', () => openMissionsModal());

  // Initial Sync
  syncUI();
  el.classList.add('auth-pending');
  const initialAssetsReady = loading.prepare(el);

  const auth = openAuthGate(uiRoot, {
    async onAuthenticated(account) {
      loading.show();
      el.classList.add('lobby-loading');
      await initialAssetsReady;
      const saved = account.profile;
      applyAccountProfile(profile, {profile_bio:saved.profile_bio||'',profile_banner:saved.profile_banner||'character',history_public:saved.history_public===true});
      profile.playerId = account.user.id;
      flushPlayerMatchHistory(profile.playerId).catch(error => console.warn('[history] pending sync failed:', error.message));
      profile.name = saved.nickname;
      profile.gold = saved.gold;
      profile.rankXp = saved.rank_points;
      profile.rankStats = { matches: saved.matches, wins: saved.wins, losses: saved.losses };
      profile.hat = saved.hat || 'crown';
      profile.skin = saved.skin || REFERENCE_SKINS[6];
      profile.friendlyFire = Boolean(saved.friendly_fire);
      profile.cos = {
        ...profile.cos,
        avatar: isAvatarId(saved.avatar) ? saved.avatar : AVATARS[0],
        hat: profile.hat,
        skin: profile.skin,
        characterId: saved.selected_character || profile.cos.characterId || 'capivara',
        ownedCharacters: [...new Set(['capivara', ...(saved.owned_characters || []), ...(profile.cos.ownedCharacters || [])])],
        ownedEmotes: [...new Set([...(saved.owned_emotes || []), ...(profile.cos.ownedEmotes || [])])],
      };

      let saveTimer = 0;
      profile.save = function saveAuthenticatedProfile() {
        lastLocalSaveAt = Date.now();
        localStorage.setItem('blast.profile', JSON.stringify({
          playerId: this.playerId, name: this.name, gold: this.gold, cos: this.cos,
          friendlyFire: this.friendlyFire, rankXp: this.rankXp, rankStats: this.rankStats,
          missionStats: this.missionStats, missions: this.missions, bio: this.bio, banner: this.banner, historyPublic: this.historyPublic,
        }));
        clearTimeout(saveTimer);
        saveTimer = window.setTimeout(() => saveAccountProfile(this).catch((error) => console.warn('[profile] sync failed:', error.message)), 350);
      };

      nameInput.value = profile.name;
      const mirror = el.querySelector('.config-name-mirror');
      if (mirror) mirror.textContent = profile.name;
      profile.save();
      lastRemoteSnapshot = accountSnapshot(saved);
      syncUI();
      await loading.prepare(el, { includeLogin: false });
      el.classList.remove('auth-pending');
      el.classList.remove('lobby-loading');
      loading.hide();
      authenticated = true;
      playLobbyMedia();
      clearInterval(accountSyncTimer);
      const syncAccountFromCloud = async () => {
        if (accountSyncBusy || Date.now() - lastLocalSaveAt < 2500) return;
        accountSyncBusy = true;
        try {
          const remote = await fetchAccountProfile(profile.playerId);
          if (!remote) return;
          const snapshot = accountSnapshot(remote);
          if (snapshot === lastRemoteSnapshot) return;
          lastRemoteSnapshot = snapshot;
          applyAccountProfile(profile, {profile_bio:remote.profile_bio||'',profile_banner:remote.profile_banner||'character',history_public:remote.history_public===true});
          profile.name = remote.nickname || profile.name;
          profile.gold = Math.max(0, Number(remote.gold) || 0);
          profile.rankXp = Math.max(0, Number(remote.rank_points) || 0);
          profile.rankStats = { matches: Number(remote.matches) || 0, wins: Number(remote.wins) || 0, losses: Number(remote.losses) || 0 };
          profile.friendlyFire = Boolean(remote.friendly_fire);
          profile.cos.avatar = isAvatarId(remote.avatar) ? remote.avatar : profile.cos.avatar;
          profile.cos.characterId = remote.selected_character || profile.cos.characterId;
          profile.cos.ownedCharacters = [...new Set(['capivara', ...(remote.owned_characters || [])])];
          profile.cos.ownedEmotes = [...new Set(remote.owned_emotes || [])];
          localStorage.setItem('blast.profile', JSON.stringify({ playerId: profile.playerId, name: profile.name, gold: profile.gold, cos: profile.cos, friendlyFire: profile.friendlyFire, rankXp: profile.rankXp, rankStats: profile.rankStats, missionStats: profile.missionStats, missions: profile.missions, bio: profile.bio, banner: profile.banner, historyPublic: profile.historyPublic }));
          syncUI();
          window.dispatchEvent(new CustomEvent('blast:account-sync'));
        } catch (error) { console.warn('[profile] realtime sync failed:', error.message); }
        finally { accountSyncBusy = false; }
      };
      accountSyncTimer = window.setInterval(syncAccountFromCloud, 1500);
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') syncAccountFromCloud(); });
      submitPlayerRanking(profile).catch(() => {});
      notifyAuthenticated();
    },
  });
  const ready = Promise.all([initialAssetsReady, auth.ready]).then(() => {
    el.classList.remove('lobby-loading');
    loading.hide();
  });

  // ------------------------------------------------------------ Modals
  function openShopModal() {
    const modal = document.createElement('div');
    modal.className = 'modal-overlay shop-modal-overlay';
    modal.innerHTML = `
      <div class="modal-window shop-modal-window" role="dialog" aria-modal="true" aria-label="Loja de personagens">
        <div class="modal-header">
          <div class="modal-title">LOJA</div>
          <div class="shop-balance"><img src="./assets/ui/capicoin.png" alt=""><strong>${Math.max(0, Number(profile.gold) || 0).toLocaleString('pt-BR')}</strong></div>
          <button class="modal-close" aria-label="Fechar">✕</button>
        </div>
        <div class="shop-tabs"><button class="active" data-shop-tab="characters">PERSONAGENS</button><button data-shop-tab="emotes">EMOTES</button></div>
        <div class="shop-character-grid"></div>
      </div>`;
    uiRoot.appendChild(modal);

    const grid = modal.querySelector('.shop-character-grid');
    let shopTab = 'characters';
    const renderCharacters = () => {
      const owned = new Set(profile.cos.ownedCharacters || ['capivara']);
      grid.innerHTML = SHOP_CHARACTERS.map((character) => {
        const available = ['capivara', 'crocodilo', 'porco', 'pato', 'gato', 'cachorro', 'macaco'].includes(character.id);
        const acquired = owned.has(character.id);
        const selected = profile.cos.characterId === character.id;
        const canAfford = Number(profile.gold) >= CHARACTER_PRICE;
        const label = selected ? 'SELECIONADO' : acquired ? 'USAR' : available ? (canAfford ? 'COMPRAR' : 'SALDO INSUFICIENTE') : 'INDISPONÍVEL';
        return `
            <article class="shop-character-card ${acquired ? 'acquired' : available ? 'available' : 'locked'} ${selected ? 'selected' : ''}">
              <div class="shop-character-art">
                <img src="./assets/ui/shop/${character.id}.webp?v=3" alt="${available ? character.name : 'Personagem oculto'}">
                ${available ? '' : '<span class="shop-lock" aria-hidden="true">🔒</span>'}
              </div>
              <div class="shop-character-info">
                <strong>${available ? character.name : '???'}</strong>
                <span class="shop-price"><img src="./assets/ui/capicoin.png" alt="Capycoins">${CHARACTER_PRICE}</span>
              </div>
              <button class="shop-character-action" type="button" data-character="${character.id}" ${(!available || selected || (!acquired && !canAfford)) ? 'disabled' : ''}>${label}</button>
            </article>`;
      }).join('');
    };
    const renderEmotes = () => {
      const owned = new Set(profile.cos.ownedEmotes || []);
      grid.innerHTML = EMOTES.map((emote) => {
        const acquired = owned.has(emote.id);
        const canAfford = Number(profile.gold) >= EMOTE_PRICE;
        return `<article class="shop-character-card shop-emote-card ${acquired ? 'acquired' : 'available'}">
          <div class="shop-character-art"><img src="${emote.image}" alt="${emote.name}"></div>
          <div class="shop-character-info"><strong>${emote.name}</strong><span class="shop-price"><img src="./assets/ui/capicoin.png" alt="Gold">${EMOTE_PRICE}</span></div>
          <button class="shop-character-action" type="button" data-emote="${emote.id}" ${(acquired || !canAfford) ? 'disabled' : ''}>${acquired ? 'ADQUIRIDO' : canAfford ? 'COMPRAR' : 'SALDO INSUFICIENTE'}</button>
        </article>`;
      }).join('');
    };
    const renderShop = () => shopTab === 'emotes' ? renderEmotes() : renderCharacters();
    const refreshShopFromCloud = () => {
      modal.querySelector('.shop-balance strong').textContent = Number(profile.gold).toLocaleString('pt-BR');
      renderShop();
    };
    window.addEventListener('blast:account-sync', refreshShopFromCloud);
    renderShop();

    const close = () => { window.removeEventListener('blast:account-sync', refreshShopFromCloud); modal.remove(); };
    const closeButton = modal.querySelector('.modal-close');
    closeButton.addEventListener('click', close);
    modal.addEventListener('click', (event) => { if (event.target === modal) close(); });
    modal.querySelector('.shop-tabs').addEventListener('click', (event) => {
      const tab = event.target.closest('[data-shop-tab]');
      if (!tab) return;
      shopTab = tab.dataset.shopTab;
      modal.querySelectorAll('[data-shop-tab]').forEach((button) => button.classList.toggle('active', button === tab));
      renderShop();
    });
    grid.addEventListener('click', (event) => {
      const emoteButton = event.target.closest('[data-emote]');
      if (emoteButton && !emoteButton.disabled) {
        const ownedEmotes = new Set(profile.cos.ownedEmotes || []);
        if (!ownedEmotes.has(emoteButton.dataset.emote) && Number(profile.gold) >= EMOTE_PRICE) {
          profile.gold = Math.max(0, Number(profile.gold) - EMOTE_PRICE);
          ownedEmotes.add(emoteButton.dataset.emote);
          profile.cos.ownedEmotes = [...ownedEmotes];
          profile.save(); onClickSound?.(); syncUI();
          modal.querySelector('.shop-balance strong').textContent = Number(profile.gold).toLocaleString('pt-BR');
          renderEmotes();
        }
        return;
      }
      const button = event.target.closest('[data-character]');
      if (!button || button.disabled) return;
      const characterId = button.dataset.character;
      const owned = new Set(profile.cos.ownedCharacters || ['capivara']);
      if (!owned.has(characterId)) {
        if (!['crocodilo', 'porco', 'pato', 'gato', 'cachorro', 'macaco'].includes(characterId) || Number(profile.gold) < CHARACTER_PRICE) return;
        profile.gold = Math.max(0, Number(profile.gold) - CHARACTER_PRICE);
        owned.add(characterId);
        profile.cos.ownedCharacters = [...owned];
      }
      profile.cos.characterId = characterId;
      profile.save();
      onClickSound?.();
      modal.querySelector('.shop-balance strong').textContent = Number(profile.gold).toLocaleString('pt-BR');
      syncUI();
      renderCharacters();
    });
    closeButton.focus({ preventScroll: true });
    grid.scrollTop = 0;
    requestAnimationFrame(() => { grid.scrollTop = 0; });
  }

  function openSettingsModal({ inGame = false, onSurrender, onLeave } = {}) {
    let settings = getSettings();
    const controlNames = { up: 'Mover para cima', down: 'Mover para baixo', left: 'Mover para esquerda', right: 'Mover para direita', jump: 'Pular', grab: 'Agarrar', punch: 'Socar', dash: 'Correr' };
    const modal = document.createElement('div');
    modal.className = 'modal-overlay settings-modal-overlay';
    modal.innerHTML = `
      <div class="modal-window settings-modal-window" role="dialog" aria-modal="true" aria-label="Configurações">
        <div class="modal-header"><div class="modal-title">CONFIGURAÇÕES</div><button class="modal-close" aria-label="Fechar">✕</button></div>
        <nav class="settings-tabs" aria-label="Categorias de configurações">
          <button class="active" data-page="audio">ÁUDIO</button><button data-page="video">VÍDEO</button><button data-page="interface">INTERFACE</button><button data-page="controls">CONTROLES</button>${inGame ? '' : '<button data-page="account">CONTA</button>'}
        </nav>
        <div class="settings-body">
          <div class="settings-page active" data-page="audio"><section class="settings-section">
            <h3>ÁUDIO</h3>
            <label class="settings-volume"><span><b>Volume da música</b><output>${settings.musicVolume}%</output></span><input data-setting="musicVolume" type="range" min="0" max="100" value="${settings.musicVolume}"></label>
            <label class="settings-volume"><span><b>Volume dos efeitos</b><output>${settings.sfxVolume}%</output></span><input data-setting="sfxVolume" type="range" min="0" max="100" value="${settings.sfxVolume}"></label>
          </section></div>
          <div class="settings-page" data-page="video"><section class="settings-section">
            <h3>VÍDEO</h3>
            <label class="settings-select"><span>Qualidade gráfica</span><select data-setting="graphicsQuality"><option value="low">Baixa</option><option value="medium">Média</option><option value="high">Alta</option><option value="ultra">Ultra</option></select></label>
            <label class="settings-select"><span>Limite de FPS</span><select data-setting="fps"><option value="30">30 FPS</option><option value="60">60 FPS</option><option value="90">90 FPS</option><option value="120">120 FPS</option></select></label>
            <label class="settings-volume"><span><b>Brilho</b><output>${settings.brightness}%</output></span><input data-setting="brightness" type="range" min="50" max="150" value="${settings.brightness}"></label>
            <label class="settings-select"><span>Filtro para daltônicos</span><select data-setting="colorblind"><option value="none">Desativado</option><option value="protanopia">Protanopia</option><option value="deuteranopia">Deuteranopia</option><option value="tritanopia">Tritanopia</option></select></label>
            <label class="settings-row"><span><b>Tela cheia automática</b><small>Ativada por padrão</small></span><input data-setting="autoFullscreen" class="settings-toggle-input" type="checkbox" ${settings.autoFullscreen ? 'checked' : ''}><i class="settings-toggle"></i></label>
            <button class="settings-fullscreen" type="button">${document.fullscreenElement ? 'SAIR DA TELA CHEIA' : 'ATIVAR TELA CHEIA AGORA'}</button>
          </section></div>
          <div class="settings-page" data-page="interface"><section class="settings-section">
            <h3>INTERFACE</h3>
            <label class="settings-select"><span>Idioma</span><select data-setting="language"><option value="pt-BR">Português</option><option value="en">English</option><option value="es">Español</option></select></label>
            ${[['notifications','Notificações'],['chat','Chat'],['animations','Animações'],['gameCursor','Cursor durante a partida']].map(([key,label]) => `<label class="settings-row"><span><b>${label}</b></span><input data-setting="${key}" class="settings-toggle-input" type="checkbox" ${settings[key] ? 'checked' : ''}><i class="settings-toggle"></i></label>`).join('')}
          </section></div>
          <div class="settings-page" data-page="controls"><section class="settings-section">
            <h3>CONTROLES E TECLAS</h3>
            <div class="settings-keys">${Object.entries(controlNames).map(([action,label]) => `<button class="settings-key" data-action="${action}"><span>${label}</span><kbd>${keyLabel(settings.controls[action])}</kbd></button>`).join('')}</div>
            <button class="settings-reset-keys" type="button">RESTAURAR TECLAS PADRÃO</button>
          </section></div>
          ${inGame ? '' : '<div class="settings-page" data-page="account"><section class="settings-section settings-account-section"><h3>CONTA</h3><p>Encerre sua sessão neste dispositivo.</p><div class="profile-actions"><button class="settings-profile modal-btn modal-btn-secondary" type="button">MEU PERFIL</button><button class="settings-history modal-btn modal-btn-secondary" type="button">HISTÓRICO</button></div><button class="settings-disconnect" type="button">DESCONECTAR</button></section></div>'}
        </div>
        ${inGame ? '<footer class="in-game-settings-footer"><button class="settings-surrender" type="button">DESISTIR</button><button class="settings-leave-match" type="button">DEIXAR PARTIDA</button></footer>' : ''}
      </div>`;
    uiRoot.appendChild(modal);
    const translateSettings = (language) => {
      const copies = {
        'pt-BR': {
          title: 'CONFIGURAÇÕES', tabs: ['ÁUDIO', 'VÍDEO', 'INTERFACE', 'CONTROLES', 'CONTA'],
          sections: ['ÁUDIO', 'VÍDEO', 'INTERFACE', 'CONTROLES E TECLAS', 'CONTA'],
          volumes: ['Volume da música', 'Volume dos efeitos', 'Brilho'],
          selects: ['Qualidade gráfica', 'Limite de FPS', 'Filtro para daltônicos', 'Idioma'],
          toggles: ['Tela cheia automática', 'Notificações', 'Chat', 'Animações', 'Cursor durante a partida'],
          controls: ['Mover para cima', 'Mover para baixo', 'Mover para esquerda', 'Mover para direita', 'Pular', 'Agarrar', 'Socar', 'Correr'],
          reset: 'RESTAURAR TECLAS PADRÃO', disconnect: 'DESCONECTAR', account: 'Encerre sua sessão neste dispositivo.',
          fullscreen: document.fullscreenElement ? 'SAIR DA TELA CHEIA' : 'ATIVAR TELA CHEIA AGORA', send: 'ENVIAR', placeholder: 'Digite uma mensagem…',
        },
        en: {
          title: 'SETTINGS', tabs: ['AUDIO', 'VIDEO', 'INTERFACE', 'CONTROLS', 'ACCOUNT'],
          sections: ['AUDIO', 'VIDEO', 'INTERFACE', 'CONTROLS & KEYS', 'ACCOUNT'],
          volumes: ['Music volume', 'Sound effects volume', 'Brightness'],
          selects: ['Graphics quality', 'FPS limit', 'Colorblind filter', 'Language'],
          toggles: ['Automatic fullscreen', 'Notifications', 'Chat', 'Animations', 'In-game cursor'],
          controls: ['Move up', 'Move down', 'Move left', 'Move right', 'Jump', 'Grab', 'Punch', 'Dash'],
          reset: 'RESET DEFAULT KEYS', disconnect: 'SIGN OUT', account: 'End your session on this device.',
          fullscreen: document.fullscreenElement ? 'EXIT FULLSCREEN' : 'ENTER FULLSCREEN NOW', send: 'SEND', placeholder: 'Type a message…',
        },
        es: {
          title: 'CONFIGURACIÓN', tabs: ['AUDIO', 'VÍDEO', 'INTERFAZ', 'CONTROLES', 'CUENTA'],
          sections: ['AUDIO', 'VÍDEO', 'INTERFAZ', 'CONTROLES Y TECLAS', 'CUENTA'],
          volumes: ['Volumen de música', 'Volumen de efectos', 'Brillo'],
          selects: ['Calidad gráfica', 'Límite de FPS', 'Filtro para daltónicos', 'Idioma'],
          toggles: ['Pantalla completa automática', 'Notificaciones', 'Chat', 'Animaciones', 'Cursor durante la partida'],
          controls: ['Mover arriba', 'Mover abajo', 'Mover a la izquierda', 'Mover a la derecha', 'Saltar', 'Agarrar', 'Golpear', 'Correr'],
          reset: 'RESTAURAR TECLAS', disconnect: 'DESCONECTAR', account: 'Cierra tu sesión en este dispositivo.',
          fullscreen: document.fullscreenElement ? 'SALIR DE PANTALLA COMPLETA' : 'ACTIVAR PANTALLA COMPLETA', send: 'ENVIAR', placeholder: 'Escribe un mensaje…',
        },
      };
      const copy = copies[language];
      if (!copy) return;
      modal.querySelector('.modal-title').textContent = copy.title;
      modal.querySelectorAll('.settings-tabs button').forEach((node, index) => { node.textContent = copy.tabs[index]; });
      modal.querySelectorAll('.settings-section h3').forEach((node, index) => { node.textContent = copy.sections[index]; });
      modal.querySelectorAll('.settings-volume b').forEach((node, index) => { node.textContent = copy.volumes[index]; });
      modal.querySelectorAll('.settings-select > span').forEach((node, index) => { node.textContent = copy.selects[index]; });
      modal.querySelectorAll('.settings-row b').forEach((node, index) => { node.textContent = copy.toggles[index]; });
      modal.querySelectorAll('.settings-key > span').forEach((node, index) => { node.textContent = copy.controls[index]; });
      modal.querySelector('.settings-reset-keys').textContent = copy.reset;
      if (!inGame) {
        modal.querySelector('.settings-disconnect').textContent = copy.disconnect;
        modal.querySelector('.settings-account-section p').textContent = copy.account;
      }
      modal.querySelector('.settings-fullscreen').textContent = copy.fullscreen;
    };
    translateSettings(settings.language);

    const close = () => modal.remove();
    modal.querySelector('.modal-close').addEventListener('click', close);
    modal.addEventListener('click', (event) => { if (event.target === modal) close(); });
    modal.querySelectorAll('.settings-tabs button').forEach((tab) => {
      tab.addEventListener('click', () => {
        modal.querySelectorAll('.settings-tabs button').forEach((button) => button.classList.toggle('active', button === tab));
        modal.querySelectorAll('.settings-page').forEach((page) => page.classList.toggle('active', page.dataset.page === tab.dataset.page));
      });
    });

    modal.querySelectorAll('select[data-setting]').forEach((select) => {
      select.value = String(settings[select.dataset.setting]);
      select.addEventListener('change', () => {
        const key = select.dataset.setting;
        settings = saveSettings({ [key]: key === 'fps' ? Number(select.value) : select.value });
        if (key === 'language') translateSettings(settings.language);
      });
    });
    modal.querySelectorAll('.settings-toggle-input[data-setting]').forEach((toggle) => {
      toggle.addEventListener('change', async () => {
        const key = toggle.dataset.setting;
        if (key === 'notifications' && toggle.checked) {
          if (!('Notification' in window)) toggle.checked = false;
          else if (Notification.permission !== 'granted') toggle.checked = (await Notification.requestPermission()) === 'granted';
        }
        settings = saveSettings({ [key]: toggle.checked });
      });
    });
    modal.querySelectorAll('.settings-volume input').forEach((range) => {
      range.addEventListener('input', () => {
        const key = range.dataset.setting;
        const value = Number(range.value);
        range.closest('.settings-volume').querySelector('output').value = `${value}%`;
        settings = saveSettings({ [key]: value });
        if (key === 'musicVolume') {
          lobbyMusic.volume = value / 100;
          localStorage.setItem('rinha.musicVolume', String(value / 100));
        } else if (key === 'sfxVolume') {
          window.dispatchEvent(new CustomEvent('rinha:sfx-volume', { detail: { volume: value / 100 } }));
        }
      });
    });

    modal.querySelector('.settings-fullscreen').addEventListener('click', async (event) => {
      try {
        if (document.fullscreenElement) await document.exitFullscreen();
        else await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
        event.currentTarget.textContent = document.fullscreenElement ? 'SAIR DA TELA CHEIA' : 'ATIVAR TELA CHEIA AGORA';
      } catch {
        event.currentTarget.textContent = 'TELA CHEIA INDISPONÍVEL';
      }
    });
    modal.querySelectorAll('.settings-key').forEach((button) => {
      button.addEventListener('click', () => {
        modal.querySelectorAll('.settings-key').forEach((item) => item.classList.remove('listening'));
        button.classList.add('listening');
        button.querySelector('kbd').textContent = 'PRESSIONE...';
        const capture = (event) => {
          event.preventDefault();
          settings = saveSettings({ controls: { ...settings.controls, [button.dataset.action]: event.code } });
          button.querySelector('kbd').textContent = keyLabel(event.code);
          button.classList.remove('listening');
        };
        window.addEventListener('keydown', capture, { once: true, capture: true });
      });
    });
    modal.querySelector('.settings-reset-keys').addEventListener('click', () => {
      localStorage.removeItem('rinha.settings');
      const defaults = getSettings();
      settings = saveSettings({ ...settings, controls: defaults.controls });
      modal.querySelectorAll('.settings-key').forEach((button) => { button.querySelector('kbd').textContent = keyLabel(settings.controls[button.dataset.action]); });
    });
    modal.querySelector('.settings-profile')?.addEventListener('click', () => { close(); openProfilePage(); });
    modal.querySelector('.settings-history')?.addEventListener('click', () => { close(); openProfilePage(profile.playerId, 'history'); });
    if (!inGame) modal.querySelector('.settings-disconnect').addEventListener('click', async () => {
      const button = modal.querySelector('.settings-disconnect');
      button.disabled = true;
      button.textContent = 'DESCONECTANDO...';
      await signOut();
      location.reload();
    });
    if (inGame) {
      modal.classList.add('in-game-settings-overlay');
      modal.querySelector('.settings-surrender').addEventListener('click', () => onSurrender?.());
      modal.querySelector('.settings-leave-match').addEventListener('click', () => onLeave?.());
    }
    return { modal, close };
  }

  function openProfilePage(playerId = profile.playerId, initialTab = 'overview') {
    onClickSound?.();
    return openPlayerProfile(uiRoot, profile, { playerId, initialTab,
      onChange: () => {
        nameInput.value=profile.name;
        const mirror=el.querySelector('.config-name-mirror'); if(mirror)mirror.textContent=profile.name;
        syncUI(); window.dispatchEvent(new Event('blast:account-sync'));
      }, onOpenShop:openShopModal, onOpenRank:openLeaderboardModal,
    });
  }

  function openRankProgressModal() {
    onClickSound?.();
    const progress = getRankProgress(profile.rankXp);
    const stats = profile.rankStats || { matches: 0, wins: 0, losses: 0 };
    const modal = document.createElement('div');
    modal.className = 'modal-overlay rank-modal-overlay';
    modal.innerHTML = `
      <div class="modal-window rank-modal-window">
        <div class="modal-header"><div class="modal-title">PROGRESSÃO DE RANKS</div><button class="modal-close">✕</button></div>
        <div class="rank-hero">
          <div class="rank-hero-icon rank-sprite" style="${rankSpriteStyle(progress.rank)}"></div>
          <div class="rank-hero-copy"><span>RANK ATUAL</span><strong>${progress.rank.name}</strong><small>${progress.points.toLocaleString('pt-BR')} PTS</small></div>
          <div class="rank-stats"><div><b>${stats.matches}</b><span>PARTIDAS</span></div><div><b>${stats.wins}</b><span>VITÓRIAS</span></div><div><b>${stats.losses}</b><span>DERROTAS</span></div></div>
        </div>
        <div class="rank-progress-line"><i style="width:${progress.progress * 100}%"></i></div>
        <div class="rank-progress-label"><span>${progress.rank.name} · ${progress.points} PTS</span><span>${progress.next ? `${progress.next.name} · 100 PTS` : 'PONTUAÇÃO SEM LIMITE'}</span></div>
        <div class="rank-grid">
          ${RANKS.filter((rank) => rank.index > 0).map((rank) => `<div class="rank-entry ${rank.index === progress.rank.index ? 'current' : ''} ${rank.xp > progress.xp ? 'locked' : 'unlocked'}"><div class="rank-entry-icon rank-sprite" style="${rankSpriteStyle(rank)}"></div><strong>${rank.name}</strong></div>`).join('')}
        </div>
        <div class="rank-rules">Vitória: <b>+25 PTS</b> · Empate: <b>+10 PTS</b> · Derrota: <b>−20 PTS</b></div>
      </div>`;
    uiRoot.appendChild(modal);
    const close = () => modal.remove();
    modal.querySelector('.modal-close').addEventListener('click', close);
    modal.addEventListener('click', (event) => { if (event.target === modal) close(); });
  }

  async function openLeaderboardModal() {
    onClickSound?.();
    const modal = document.createElement('div');
    modal.className = 'modal-overlay leaderboard-modal-overlay';
    modal.innerHTML = leaderboardMarkup();
    uiRoot.appendChild(modal);
    const previousFocus = document.activeElement;
    const close = () => {
      modal.remove();
      if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    };
    modal.querySelector('.modal-close').addEventListener('click', close);
    modal.addEventListener('click', (event) => { if (event.target === modal) close(); });
    modal.addEventListener('keydown', (event) => {
      if (event.key === 'Tab') {
        const closeButton = modal.querySelector('.modal-close');
        const table = modal.querySelector('.leaderboard-table');
        if (event.shiftKey && document.activeElement === closeButton) {
          event.preventDefault();
          table.focus();
        } else if (!event.shiftKey && document.activeElement === table) {
          event.preventDefault();
          closeButton.focus();
        }
        return;
      }
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      close();
    });
    modal.querySelector('.modal-close').focus({ preventScroll: true });

    const list = modal.querySelector('.leaderboard-list');
    list.addEventListener('click', event => { const cell=event.target.closest('[data-profile-id]'); if(cell)openProfilePage(cell.dataset.profileId); });
    list.addEventListener('keydown', event => { if(event.key!=='Enter' && event.key!==' ')return; const cell=event.target.closest('[data-profile-id]'); if(cell) {event.preventDefault();openProfilePage(cell.dataset.profileId);} });
    try {
      await submitPlayerRanking(profile);
      const players = await listPlayerRankings(100);
      list.innerHTML = leaderboardRowsMarkup(players, profile.playerId);
    } catch (error) {
      list.innerHTML = `<div class="leaderboard-loading leaderboard-error">Não foi possível carregar o ranking agora.<small>${escapeHtml(error.message)}</small></div>`;
    } finally {
      list.setAttribute('aria-busy', 'false');
    }
  }

  function openHowToPlayModal() {
    onClickSound?.();
    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.innerHTML = `
      <div class="modal-window">
        <div class="modal-header">
          <div class="modal-title">📖 COMO JOGAR / HOW TO PLAY</div>
          <button class="modal-close">✕</button>
        </div>
        <div class="modal-body">
          <div class="help-cols" style="display:flex; gap:16px;">
            <div style="flex:1; background:rgba(255,255,255,0.03); padding:14px; border-radius:12px; border:1px solid rgba(140,170,255,0.15);">
              <div style="font-weight:800; font-size:15px; color:#ffd460; margin-bottom:8px;">⌨️ Teclado & Mouse</div>
              <div style="font-size:13px; line-height:1.6; color:#bcd0f7;">
                <b>WASD / Setas:</b> Mover capivara<br>
                <b>Mouse:</b> Mirar / Direção<br>
                <b>Botão Esquerdo (LMB):</b> Bater / Socar (ou arremessar objeto/jogador segurado)<br>
                <b>Botão Direito (RMB) / E:</b> Agarrar adversário ou bandeira (press novamente p/ lançar)<br>
                <b>Shift:</b> Dash rápido (arrancada com cooldown)<br>
                <b>Espaço:</b> Pular<br>
                <div style="margin-top:6px; color:#ffd460;">📦 <i>Bombas: passe por cima das caixas amarelas de itens na arena!</i></div>
              </div>
            </div>
            <div style="flex:1; background:rgba(255,255,255,0.03); padding:14px; border-radius:12px; border:1px solid rgba(140,170,255,0.15);">
              <div style="font-weight:800; font-size:15px; color:#ffd460; margin-bottom:8px;">📱 Controles Touch</div>
              <div style="font-size:13px; line-height:1.6; color:#bcd0f7;">
                <b>Lado Esquerdo:</b> Joystick virtual analógico<br>
                <b>👊 Botão Soco:</b> Bater / Socar / Lançar<br>
                <b>✋ Botão Agarrar:</b> Agarrar jogador ou bandeira<br>
                <b>⚡ Botão Dash:</b> Arrancada rápida<br>
                <b>⬆️ Botão Pulo:</b> Pular no ar
              </div>
            </div>
          </div>
          <div style="background:rgba(255,212,96,0.08); border:1px solid rgba(255,212,96,0.3); border-radius:12px; padding:12px 16px; font-size:13px; color:#ffe8a3; line-height:1.5;">
            🚩 <b>Objetivo Capture the Flag:</b> Pegue a bandeira inimiga e leve para sua base!<br>
            💀 <b>Objetivo Death Match:</b> Elimine os adversários para pontuar para sua equipe!<br>
            ⚔️ <b>Todos contra Todos:</b> Cada capivara por si — primeira a 10 frags vence!<br>
            🛡️ <b>Fogo Amigo:</b> Quando desativado, aliados não se machucam nem se agarram.
          </div>
        </div>
        <div class="modal-footer">
          <button class="modal-btn modal-btn-primary modal-close-btn">Entendi, Vamos Jogar!</button>
        </div>
      </div>
    `;
    uiRoot.appendChild(modal);
    const close = () => modal.remove();
    modal.querySelector('.modal-close').addEventListener('click', close);
    modal.querySelector('.modal-close-btn').addEventListener('click', close);
  }

  function openStatsModal() {
    onClickSound?.();
    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.innerHTML = `
      <div class="modal-window">
        <div class="modal-header">
          <div class="modal-title">📊 ESTATÍSTICAS & STATUS</div>
          <button class="modal-close">✕</button>
        </div>
        <div class="modal-body" style="text-align:center; padding:30px;">
          <div style="font-size:40px; margin-bottom:12px;">🏆</div>
          <div style="font-weight:800; font-size:18px; color:#ffd460; margin-bottom:6px;">LOBBY COMPETITIVO ATIVO</div>
          <div style="font-size:13px; color:#bcd0f7; max-width:380px; margin:0 auto; line-height:1.6;">
            Bem-vindo ao <b>Blast Arena</b>! Jogue partidas locais contra bots de inteligência artificial ou dispute partidas multiplayer em tempo real criando sua própria sala.
          </div>
        </div>
        <div class="modal-footer">
          <button class="modal-btn modal-btn-primary modal-close-btn">Fechar</button>
        </div>
      </div>
    `;
    uiRoot.appendChild(modal);
    const close = () => modal.remove();
    modal.querySelector('.modal-close').addEventListener('click', close);
    modal.querySelector('.modal-close-btn').addEventListener('click', close);
  }

  function queueCodeFor(selection, levelId) {
    const key = [selection.matchType, selection.modeId, levelId, selection.teamSize, selection.ffaSize].join('|');
    let hash = 2166136261;
    for (let index = 0; index < key.length; index += 1) {
      hash ^= key.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return `q${(hash >>> 0).toString(36)}`.slice(0, 12);
  }

  function openMissionsModal() {
    onClickSound?.();
    ensureMissions(profile);
    const modal = document.createElement('div');
    modal.className = 'modal-overlay missions-modal-overlay';
    modal.innerHTML = `
      <div class="modal-window missions-modal-window" role="dialog" aria-modal="true" aria-label="Missões">
        <div class="modal-header missions-header">
          <div><span class="missions-kicker">ARENA ONLINE</span><div class="modal-title">MISSÕES</div></div>
          <div class="missions-count">10 MISSÕES ATIVAS</div>
          <button class="modal-close" aria-label="Fechar">✕</button>
        </div>
        <div class="missions-list"></div>
      </div>`;
    uiRoot.appendChild(modal);
    const list = modal.querySelector('.missions-list');
    const render = () => {
      list.innerHTML = profile.missions.map((mission, index) => {
        const progress = missionProgress(profile, mission);
        const complete = progress >= mission.target;
        const percent = Math.round((progress / mission.target) * 100);
        return `<article class="mission-card ${complete ? 'complete' : ''}">
          <div class="mission-number">${String(index + 1).padStart(2, '0')}</div>
          <div class="mission-main"><strong>${escapeHtml(mission.title)}</strong><div class="mission-progress"><i style="width:${percent}%"></i><span>${progress}/${mission.target}</span></div></div>
          <div class="mission-rewards"><span><img src="./assets/ui/capicoin.png" alt="Gold">+${mission.gold}</span><span class="mission-xp">XP +${mission.xp}</span></div>
          <button class="mission-claim" data-mission="${mission.id}" ${complete ? '' : 'disabled'}>${complete ? 'RESGATAR' : 'EM PROGRESSO'}</button>
        </article>`;
      }).join('');
    };
    render();
    const close = () => modal.remove();
    modal.querySelector('.modal-close').addEventListener('click', close);
    modal.addEventListener('click', (event) => { if (event.target === modal) close(); });
    list.addEventListener('click', (event) => {
      const button = event.target.closest('[data-mission]');
      if (!button || button.disabled) return;
      const reward = claimMission(profile, button.dataset.mission);
      if (!reward) return;
      profile.save();
      syncUI();
      onClickSound?.();
      render();
    });
    profile.save();
  }

  function queueCapacity(selection) {
    return selection.modeId === 'ffa'
      ? clampPlayerCount(selection.ffaSize, 2)
      : clampTeamSize(selection.teamSize, 1) * 2;
  }

  function createMatchmakingOverlay(selection) {
    const capacity = queueCapacity(selection);
    const modeLabel = selection.matchType === 'ranked' ? 'RANQUEADA' : 'NORMAL GAME';
    const ownAvatar = isAvatarId(profile.cos?.avatar) ? profile.cos.avatar : AVATARS[0];
    const overlay = document.createElement('div');
    overlay.className = 'matchmaking-overlay';
    overlay.innerHTML = `
      <section class="matchmaking-window" role="dialog" aria-modal="true" aria-label="Buscando jogadores">
        <div class="matchmaking-scanlines" aria-hidden="true"></div>
        <div class="matchmaking-kicker">BUSCANDO JOGADORES</div>
        <div class="matchmaking-heading">
          <h2>${modeLabel}</h2>
          <strong class="matchmaking-timer">00:00</strong>
        </div>
        <div class="matchmaking-slots" aria-label="Jogadores aceitos">
          ${Array.from({ length: capacity }, (_, index) => `
            <div class="matchmaking-slot${index === 0 ? ' is-accepted' : ''}" aria-label="${index === 0 ? 'Jogador aceito' : 'Aguardando jogador'}">
              ${index === 0
                ? `<img src="${getAvatarUrl(ownAvatar)}" alt="${escapeHtml(profile.name || 'Jogador')}" />`
                : '<span>?</span>'}
            </div>
          `).join('')}
        </div>
        <div class="matchmaking-summary"><b class="matchmaking-count">1 / ${capacity} ACEITOS</b></div>
        <p class="matchmaking-status">Procurando adversários...</p>
        <button class="matchmaking-cancel" type="button">CANCELAR</button>
      </section>
    `;
    uiRoot.appendChild(overlay);
    return overlay;
  }

  async function enterMatchmakingQueue(selection, matchConfig, levelId) {
    const overlay = createMatchmakingOverlay(selection);
    const timerEl = overlay.querySelector('.matchmaking-timer');
    const statusEl = overlay.querySelector('.matchmaking-status');
    const countEl = overlay.querySelector('.matchmaking-count');
    const slots = [...overlay.querySelectorAll('.matchmaking-slot')];
    const cancelButton = overlay.querySelector('.matchmaking-cancel');
    const capacity = queueCapacity(selection);
    let startedAt = Date.now();
    let deadline = startedAt + 30_000;
    let transport = null;
    let pollTimer = null;
    let finished = false;
    let cancelled = false;

    const updateAccepted = (playersOrCount) => {
      const players = Array.isArray(playersOrCount) ? playersOrCount : [];
      const accepted = Math.max(1, Math.min(capacity, players.length || Number(playersOrCount) || 1));
      countEl.textContent = `${accepted} / ${capacity} ACEITOS`;
      slots.forEach((slot, index) => {
        slot.classList.toggle('is-accepted', index < accepted);
        const player = players[index];
        const avatar = isAvatarId(player?.cos?.avatar) ? player.cos.avatar : (index === 0 ? (isAvatarId(profile.cos?.avatar) ? profile.cos.avatar : AVATARS[0]) : null);
        slot.innerHTML = index < accepted && avatar
          ? `<img src="${getAvatarUrl(avatar)}" alt="${escapeHtml(player?.name || (index === 0 ? profile.name : 'Jogador'))}" />`
          : '<span>?</span>';
      });
    };
    const humanPlayers = () => {
      const lobby = transport?.lobbyPlayers?.();
      if (Array.isArray(lobby) && lobby.length) return lobby;
      const players = transport?.view?.()?.players || [];
      return players.filter((player) => !player.bot);
    };
    const syncQueueDeadline = () => {
      const sharedDeadline = Number(transport?.matchmakingEndsAt?.());
      if (!Number.isFinite(sharedDeadline) || sharedDeadline <= 0) return;
      deadline = sharedDeadline;
      startedAt = deadline - 30_000;
    };
    const cleanup = () => {
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = null;
      overlay.remove();
      btnPlayBots.disabled = false;
    };
    const startPrepared = async () => {
      if (finished || cancelled || !transport) return;
      finished = true;
      statusEl.textContent = 'Partida encontrada! Preparando arena...';
      overlay.classList.add('is-found');
      try {
        transport.finalizeMatchmaking?.();
        await transport.waitForMatch?.();
        await transport.clientReadyAndWaitForStart?.();
        if (cancelled) return;
        await new Promise((resolve) => setTimeout(resolve, 500));
        cleanup();
        onStartPrepared(transport);
      } catch (cause) {
        cleanup();
        errBox.textContent = cause.message || 'Não foi possível criar a partida.';
        errBox.classList.remove('hidden');
      }
    };
    const cancel = () => {
      if (finished || cancelled) return;
      cancelled = true;
      transport?.dispose?.();
      cleanup();
    };
    cancelButton.addEventListener('click', cancel);

    pollTimer = setInterval(() => {
      if (cancelled || finished) return;
      const elapsed = Math.min(30, Math.max(0, Math.floor((Date.now() - startedAt) / 1000)));
      timerEl.textContent = `00:${String(elapsed).padStart(2, '0')}`;
      const players = humanPlayers();
      updateAccepted(players);
      if (players.length >= 2 && Date.now() < deadline) {
        statusEl.textContent = 'Jogadores encontrados. Aguardando o fim da fila...';
      }
      if ((players.length >= capacity || Date.now() >= deadline || transport?.isMatchReady?.()) && transport) {
        statusEl.textContent = players.length >= 2
          ? 'Jogadores encontrados! Preparando arena...'
          : 'Completando a partida com bots...';
        startPrepared();
      }
    }, 250);

    try {
      const prefix = selection.matchType === 'ranked' ? '[RANQUEADA]' : '[NORMAL]';
      const rooms = (await listRooms().catch(() => [])).filter(roomWithinCapacity);
      const compatible = rooms.find((room) => room.name?.startsWith(prefix)
        && room.modeId === selection.modeId
        && (levelId === 'procedural' ? String(room.levelId).startsWith('procedural') : room.levelId === levelId)
        && room.playersCount < room.maxPlayers
        && (selection.modeId === 'ffa' ? room.teamLimits?.ffa === selection.ffaSize : room.teamLimits?.red === selection.teamSize));

      if (cancelled) return;
      if (compatible) {
        statusEl.textContent = 'Jogador encontrado. Entrando na partida...';
        transport = await onPrepareOnline({ room: compatible.code });
        if (cancelled) {
          transport?.dispose?.();
          return;
        }
        syncQueueDeadline();
        updateAccepted(transport.lobbyPlayers?.() || 2);
        statusEl.textContent = 'Jogador encontrado. Aguardando o fim da fila...';
        return;
      }

      const code = queueCodeFor(selection, levelId);
      const name = `${prefix} Partida automática`;
      const roomLevelId = levelId === 'procedural'
        ? `procedural:${Math.floor(10000 + Math.random() * 89999)}`
        : levelId;
      let data;
      try {
        data = await createRoom({
          name, code, modeId: selection.modeId, levelId: roomLevelId,
          redSize: selection.teamSize, blueSize: selection.teamSize, ffaSize: selection.ffaSize,
          respawnTime: selection.respawnTime, friendlyFire: matchConfig.rules.friendlyFire,
        });
        if (!data?.ok) throw new Error(data?.error || 'Não foi possível criar a fila.');
      } catch {
        if (cancelled) return;
        statusEl.textContent = 'Fila encontrada. Conectando...';
        transport = await onPrepareOnline({ room: code });
        if (cancelled) transport?.dispose?.();
        else {
          syncQueueDeadline();
          updateAccepted(transport.lobbyPlayers?.() || 2);
          statusEl.textContent = 'Jogador encontrado. Aguardando o fim da fila...';
        }
        return;
      }

      data.room.config = matchConfig;
      data.room.matchType = selection.matchType;
      data.room.queueEndsAt = deadline;
      data.room.levelId = roomLevelId;
      transport = await onPrepareOnline({ room: data.code, host: true, hostToken: data.hostToken, roomConfig: data.room });
      if (cancelled) {
        transport?.dispose?.();
        return;
      }
      statusEl.textContent = 'Aguardando outro jogador...';
    } catch (cause) {
      if (cancelled) return;
      cleanup();
      transport?.dispose?.();
      errBox.textContent = cause.message || 'Não foi possível entrar na fila.';
      errBox.classList.remove('hidden');
    }
  }

  let inviteChannelPromise = null;
  const ensureInviteChannel = () => {
    if (inviteChannelPromise) return inviteChannelPromise;
    inviteChannelPromise = (async () => {
      const channel = new SupabaseRealtimeChannel(`player:${profile.playerId}`);
      channel.on('room-invite', (invite) => {
        if (!invite?.room || invite.fromId === profile.playerId) return;
        const popup = document.createElement('div');
        popup.className = 'room-invite-popup';
        popup.innerHTML = `<strong>CONVITE PARA SALA</strong><span>${escapeHtml(invite.fromName)} convidou você para “${escapeHtml(invite.name)}”.</span><div><button data-decline>RECUSAR</button><button data-accept>ENTRAR</button></div>`;
        uiRoot.appendChild(popup);
        popup.querySelector('[data-decline]').onclick = () => popup.remove();
        popup.querySelector('[data-accept]').onclick = async (event) => {
          event.currentTarget.disabled = true;
          try {
            const transport = await onPrepareOnline({ room: invite.room, password: invite.password });
            popup.remove();
            openRoomStaging({ selection: invite.selection, data: { code: invite.room, room: invite.roomConfig }, transport, isHost: false });
          } catch (error) {
            popup.querySelector('span').textContent = error.message || 'Não foi possível entrar na sala.';
            event.currentTarget.disabled = false;
          }
        };
        setTimeout(() => popup.remove(), 30_000);
      });
      await channel.connect();
      return channel;
    })().catch((error) => { inviteChannelPromise = null; console.warn('[invite]', error.message); return null; });
    return inviteChannelPromise;
  };
  ensureInviteChannel();

  async function sendRoomInvite(friend, payload) {
    const channel = new SupabaseRealtimeChannel(`player:${friend.id}`);
    await channel.connect();
    channel.send('room-invite', { ...payload, fromId: profile.playerId, fromName: profile.name });
    await new Promise((resolve) => setTimeout(resolve, 250));
    channel.close();
  }

  function openRoomStaging({ selection, data, transport, isHost }) {
    const previous = document.querySelector('.custom-room-lobby-overlay');
    previous?.remove();
    const modal = document.createElement('div');
    modal.className = 'modal-overlay custom-room-lobby-overlay';
    const modeId = selection.modeId;
    const teamSize = clampTeamSize(selection.teamSize, 1);
    const totalSlots = modeId === 'ffa' ? clampPlayerCount(selection.ffaSize, 2) : teamSize * 2;
    const botTeams = [];
    let starting = false;
    modal.innerHTML = `<section class="custom-room-lobby">
      <header><div><small>RINHA ARENA · SALA ${escapeHtml(data.code)}</small><h2>${escapeHtml(selection.name || 'SALA PERSONALIZADA')}</h2></div><button class="lobby-invite" ${isHost ? '' : 'disabled'}>CONVIDAR AMIGO</button><button class="lobby-close">✕</button></header>
      <div class="custom-room-columns"></div>
      <footer><span class="lobby-status">${isHost ? 'Configure as vagas e inicie quando estiver pronto.' : 'Aguardando o dono iniciar a partida.'}</span>${isHost ? '<button class="lobby-start">INICIAR PARTIDA</button>' : ''}</footer>
    </section>`;
    uiRoot.appendChild(modal);
    const columns = modal.querySelector('.custom-room-columns');
    const status = modal.querySelector('.lobby-status');
    const playerTeam = (player, index) => modeId === 'ffa' ? 'free' : (player.team === 'blue' ? 'blue' : player.team === 'red' ? 'red' : (index % 2 ? 'blue' : 'red'));
    const render = () => {
      const players = transport.lobbyPlayers?.() || [];
      const teams = modeId === 'ffa' ? [['free', 'JOGADORES', totalSlots]] : [['red', 'EQUIPE VERMELHA', teamSize], ['blue', 'EQUIPE AZUL', teamSize]];
      columns.innerHTML = teams.map(([team, label, count]) => {
        const humans = players.filter((player, index) => playerTeam(player, index) === team);
        const bots = botTeams.filter((value) => value === team).length;
        const slots = Array.from({ length: count }, (_, index) => {
          const human = humans[index];
          if (human) return `<div class="room-slot occupied"><img src="${getAvatarUrl(human.cos?.avatar)}"><span><b>${escapeHtml(human.displayName || human.name)}</b><small>PLAYER</small></span></div>`;
          if (index < humans.length + bots) return `<div class="room-slot bot"><span class="room-slot-bot">🤖</span><span><b>BOT</b><small>ADICIONADO</small></span>${isHost ? `<button data-remove-bot="${team}">REMOVER</button>` : ''}</div>`;
          return `<div class="room-slot empty"><span>VAGA LIVRE</span>${isHost ? `<button data-add-bot="${team}">ADICIONAR BOT</button>` : ''}</div>`;
        }).join('');
        return `<section data-team="${team}"><h3>${label}</h3>${slots}</section>`;
      }).join('');
    };
    columns.addEventListener('click', (event) => {
      const add = event.target.closest('[data-add-bot]');
      const remove = event.target.closest('[data-remove-bot]');
      if (add) botTeams.push(add.dataset.addBot);
      if (remove) {
        const index = botTeams.lastIndexOf(remove.dataset.removeBot);
        if (index >= 0) botTeams.splice(index, 1);
      }
      render();
    });
    const cleanup = () => { clearInterval(poll); modal.remove(); };
    const enterPrepared = async () => {
      if (starting) return;
      starting = true;
      status.textContent = 'Preparando arena...';
      try {
        await transport.waitForMatch?.();
        await transport.clientReadyAndWaitForStart?.();
        cleanup();
        onStartPrepared(transport);
      } catch (error) { starting = false; status.textContent = error.message; }
    };
    modal.querySelector('.lobby-close').onclick = () => { transport.dispose?.(); cleanup(); };
    modal.querySelector('.lobby-start')?.addEventListener('click', () => {
      transport.finalizeMatchmaking?.({ botsEnabled: botTeams.length > 0, botTeams: [...botTeams] });
      enterPrepared();
    });
    modal.querySelector('.lobby-invite')?.addEventListener('click', async () => {
      let panel = modal.querySelector('.lobby-friends-panel');
      if (panel) { panel.remove(); return; }
      panel = document.createElement('aside'); panel.className = 'lobby-friends-panel'; panel.innerHTML = '<b>AMIGOS</b><span>Carregando...</span>'; modal.querySelector('.custom-room-lobby').appendChild(panel);
      try {
        const friends = await listFriends();
        panel.innerHTML = `<b>CONVIDAR AMIGO</b>${friends.length ? friends.map((friend) => `<button data-friend="${friend.id}"><img src="${getAvatarUrl(friend.avatar)}"><span>${escapeHtml(friend.nickname)}</span><em>CONVIDAR</em></button>`).join('') : '<span>Nenhum amigo encontrado.</span>'}`;
        panel.onclick = async (event) => {
          const button = event.target.closest('[data-friend]'); if (!button) return;
          const friend = friends.find((item) => item.id === button.dataset.friend); button.disabled = true;
          try { await sendRoomInvite(friend, { room: data.code, password: selection.password, name: selection.name, selection, roomConfig: data.room }); button.querySelector('em').textContent = 'ENVIADO'; }
          catch (error) { button.disabled = false; button.querySelector('em').textContent = 'ERRO'; }
        };
      } catch (error) { panel.innerHTML = `<b>AMIGOS</b><span>${escapeHtml(error.message)}</span>`; }
    });
    const poll = setInterval(() => {
      render();
      if (!isHost && transport.isMatchReady?.()) enterPrepared();
    }, 300);
    render();
  }

  async function launchConfirmedGame(selection) {
    selection={...selection,teamSize:clampTeamSize(selection.teamSize),ffaSize:clampPlayerCount(selection.ffaSize)};
    onClickSound?.();
    errBox.classList.add('hidden');
    btnPlayBots.disabled = true;
    const localMatch = selection.matchType === 'bots';
    let levelId = selection.chosenMap;
    if (levelId === 'procedural' && localMatch) {
      newProceduralSeed();
      levelId = LEVELS.procedural.seedId;
    }
    const matchConfig = selection.matchConfig || {
      ...CONFIG,
      rules: {
        ...CONFIG.rules,
        ranked: selection.matchType === 'ranked',
        bestOf: selection.matchType === 'ranked' ? 3 : 1,
        captureLimit: selection.matchType === 'ranked' ? 3 : CONFIG.rules.captureLimit,
        botDifficulty: 'medium',
      },
    };
    try {
      if (selection.matchType === 'ranked' || selection.matchType === 'normal') {
        const discipline = await getPlayerDiscipline();
        const blockedUntil = Date.parse(discipline?.matchmakingBlockedUntil || '') || 0;
        const serverNow = Date.parse(discipline?.serverTime || '') || Date.now();
        if (blockedUntil > serverNow) {
          openPenaltyModal(blockedUntil - serverNow);
          return;
        }
      }
      if (selection.matchType === 'bots') {
        if (selection.botType === 'training') onPlayLab('doll');
        else onPlayLocal(selection.modeId, levelId, {
          config: matchConfig,
          teamLimits: selection.modeId === 'ffa' ? { ffa: selection.ffaSize } : { red: selection.teamSize, blue: selection.teamSize },
          respawnTime: selection.respawnTime,
        });
        return;
      }

      if (selection.matchType === 'ranked' || selection.matchType === 'normal') {
        await enterMatchmakingQueue(selection, matchConfig, levelId);
        return;
      }

      const name = selection.name;
      const code = selection.code;
      const data = await createRoom({
        name, code, password: selection.password, modeId: selection.modeId, levelId,
        redSize: selection.teamSize, blueSize: selection.teamSize, ffaSize: selection.ffaSize,
        respawnTime: selection.respawnTime, friendlyFire: matchConfig.rules.friendlyFire,
      });
      if (!data?.ok) throw new Error(data?.error || 'Não foi possível criar a sala.');
      data.room.config = matchConfig;
      data.room.matchType = selection.matchType;
      const transport = await onPrepareOnline({ room: data.code, password: selection.password, team: selection.modeId === 'ffa' ? 'free' : 'red', host: true, hostToken: data.hostToken, roomConfig: data.room });
      openRoomStaging({ selection, data, transport, isHost: true });
    } catch (cause) {
      errBox.textContent = cause.message || 'Não foi possível iniciar a partida.';
      errBox.classList.remove('hidden');
    } finally {
      btnPlayBots.disabled = false;
    }
  }

  function openPenaltyModal(remainingMs) {
    const modal = document.createElement('div');
    modal.className = 'modal-overlay match-confirm-overlay';
    modal.innerHTML = `<section class="match-action-dialog"><h2>PENALIDADE POR ABANDONO</h2><p>Você abandonou partidas recentemente e precisa aguardar antes de entrar novamente na fila.</p><strong class="penalty-countdown"></strong><div class="match-action-buttons"><button type="button">FECHAR</button></div></section>`;
    uiRoot.appendChild(modal);
    const output = modal.querySelector('.penalty-countdown');
    const deadline = performance.now() + remainingMs;
    const render = () => {
      const seconds = Math.max(0, Math.ceil((deadline - performance.now()) / 1000));
      output.textContent = `${String(Math.floor(seconds / 60)).padStart(2,'0')}:${String(seconds % 60).padStart(2,'0')}`;
      if (!seconds) clearInterval(timer);
    };
    const timer = setInterval(render, 250); render();
    modal.querySelector('button').addEventListener('click', () => { clearInterval(timer); modal.remove(); });
  }

  function openGameOptionsModal(initialPage = 'create') {
    onClickSound?.();
    const modal = document.createElement('div');
    modal.className = 'modal-overlay game-options-overlay';
    modal.innerHTML = `
      <section class="game-options-window" aria-label="Opções de jogo">
        <header class="game-options-header">
          <div><small>RINHA ARENA</small><h2>OPÇÕES DE JOGO</h2></div>
          <button class="modal-close" type="button" aria-label="Fechar">✕</button>
        </header>
        <nav class="game-options-tabs" aria-label="Páginas">
          <button type="button" data-page="create">JOGAR</button>
          <button type="button" data-page="rooms">SALAS CRIADAS</button>
        </nav>
        <div class="game-options-page" data-page-panel="create">
          <div class="match-type-grid">
            <button type="button" class="match-type active" data-type="ranked"><b>RANQUEADA</b><span>MD3 competitivo • 3v3</span></button>
            <button type="button" class="match-type" data-type="normal"><b>NORMAL</b><span>Sem pontos de rank</span></button>
            <button type="button" class="match-type" data-type="bots"><b>CONTRA BOT</b><span>Jogue imediatamente</span></button>
            <button type="button" class="match-type" data-type="custom"><b>PERSONALIZADA</b><span>Controle todas as regras</span></button>
          </div>

          <div class="game-option-scroll">
            <section class="ranked-summary game-type-section" data-for-type="ranked">
              <div class="competitive-mark">★</div>
              <div><h3>CONFIGURAÇÃO COMPETITIVA</h3><p>Melhor de 3 partidas, equipes 3v3, bots completando vagas e mapa à escolha.</p></div>
              <div class="competitive-pills"><span>MD3</span><span>3v3</span><span>CTF</span><span>MAPA GRANDE</span></div>
            </section>

            <section class="game-common-fields">
              <label><span>NOME DA SALA</span><input class="go-name" maxlength="24" value="Sala de ${escapeHtml(profile.name)}" /></label>
              <label><span>CÓDIGO</span><input class="go-code" maxlength="12" placeholder="Gerado automaticamente" /></label>
              <label><span>SENHA <i>OPCIONAL</i></span><input class="go-password" type="password" maxlength="20" placeholder="Sala pública" /></label>
            </section>

            <section class="game-config-block map-block">
              <h3>MAPA</h3>
              <div class="game-map-grid">
                ${Object.values(MAP_DATA).map((map) => `<button type="button" class="game-map-option ${map.id === 'procedural' ? 'active' : ''}" data-map="${map.id}"><img src="${map.img}" alt="" /><span>${map.name}</span></button>`).join('')}
              </div>
            </section>

            <section class="game-config-block standard-options game-type-section" data-for-type="normal bots custom">
              <h3>MODO E TAMANHO</h3>
              <div class="option-row">
                <label><span>Modo</span><select class="go-mode"><option value="ctf">Capture the Flag</option><option value="deathmatch">Death Match</option><option value="ffa">Todos contra todos</option></select></label>
                <label class="go-team-size-wrap"><span>Equipes</span><select class="go-team-size">${Array.from({ length: MAX_TEAM_SIZE }, (_, i) => i + 1).map((n) => `<option value="${n}" ${n === 2 ? 'selected' : ''}>${n}v${n}</option>`).join('')}</select></label>
                <label class="go-ffa-size-wrap hidden"><span>Jogadores</span><select class="go-ffa-size">${Array.from({ length: MAX_PLAYERS - 1 }, (_, i) => i + 2).map((n) => `<option value="${n}" ${n === 6 ? 'selected' : ''}>${n} jogadores</option>`).join('')}</select></label>
              </div>
            </section>

            <section class="game-config-block bot-options game-type-section" data-for-type="bots">
              <h3>CONTRA BOT</h3>
              <div class="option-row">
                <label><span>Tipo</span><select class="go-bot-type"><option value="match">Partida contra bots</option><option value="training">Treinamento livre</option></select></label>
                <label><span>Dificuldade</span><select class="go-bot-difficulty"><option value="easy">Fácil</option><option value="medium" selected>Médio</option><option value="hard">Difícil</option></select></label>
              </div>
              <p class="bot-training-hint">No treinamento livre você pode testar movimentação, golpes, bombas e controles sem valer pontos.</p>
            </section>

            <section class="game-config-block custom-options game-type-section" data-for-type="custom">
              <h3>REGRAS PERSONALIZADAS</h3>
              <div class="custom-rule-grid">
                <label><span>Tempo da partida</span><select class="go-time"><option value="120">2 minutos</option><option value="180" selected>3 minutos</option><option value="300">5 minutos</option><option value="600">10 minutos</option></select></label>
                <label class="go-capture-wrap"><span>Limite de capturas</span><select class="go-captures">${[1,2,3,4,5,7,10].map((n) => `<option value="${n}" ${n === 5 ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
                <label class="go-kills-wrap hidden"><span>Limite de eliminações</span><select class="go-kills"><option value="5">5</option><option value="10" selected>10</option><option value="15">15</option><option value="20">20</option><option value="30">30</option></select></label>
                <label><span>Respawn</span><select class="go-respawn"><option value="1">1 segundo</option><option value="3">3 segundos</option><option value="5" selected>5 segundos</option><option value="8">8 segundos</option></select></label>
                <label><span>Fogo amigo</span><select class="go-friendly"><option value="0">Desativado</option><option value="1">Ativado</option></select></label>
              </div>
              <h4>BUFFS E DEBUFFS DISPONÍVEIS</h4>
              <div class="powerup-toggle-grid">
                ${[
                  ['bomb','Bomba normal','buff'], ['triple','Bomba tripla','buff'], ['gloves','Luvas','buff'], ['shield','Escudo','buff'],
                  ['health','Cura','buff'], ['sticky','Bomba adesiva','buff'], ['impact','Bomba de impacto','buff'], ['mines','Minas','buff'],
                  ['ice','Congelamento','debuff'], ['curse','Maldição','debuff'],
                ].map(([id, label, kind]) => `<label class="powerup-toggle ${kind}"><input type="checkbox" value="${id}" checked /><span>${label}</span></label>`).join('')}
              </div>
            </section>
          </div>
          <footer class="game-options-footer"><p class="game-options-error" role="alert"></p><button class="game-create-button" type="button">CONFIRMAR</button></footer>
        </div>

        <div class="game-options-page" data-page-panel="rooms">
          <div class="rooms-toolbar"><div><h3>SALAS ABERTAS</h3><span>Escolha uma sala e entre na partida</span></div><button class="game-refresh-rooms" type="button">↻ ATUALIZAR</button></div>
          <div class="game-room-list"><div class="game-room-empty">Carregando salas…</div></div>
        </div>
      </section>`;
    uiRoot.appendChild(modal);

    const close = () => modal.remove();
    modal.querySelector('.modal-close').addEventListener('click', close);
    const pages = [...modal.querySelectorAll('.game-options-page')];
    const tabs = [...modal.querySelectorAll('.game-options-tabs button')];
    let roomsLoaded = false;
    const showPage = (page) => {
      tabs.forEach((tab) => tab.classList.toggle('active', tab.dataset.page === page));
      pages.forEach((panel) => panel.classList.toggle('active', panel.dataset.pagePanel === page));
      if (page === 'rooms' && !roomsLoaded) loadGameRooms();
    };
    tabs.forEach((tab) => tab.addEventListener('click', () => showPage(tab.dataset.page)));

    let matchType = confirmedGame.matchType;
    let chosenMap = confirmedGame.chosenMap;
    const typeButtons = [...modal.querySelectorAll('.match-type')];
    const mapButtons = [...modal.querySelectorAll('.game-map-option')];
    const modeSelect = modal.querySelector('.go-mode');
    modeSelect.value = confirmedGame.modeId;
    modal.querySelector('.go-team-size').value = String(clampTeamSize(confirmedGame.teamSize));
    modal.querySelector('.go-ffa-size').value = String(clampPlayerCount(confirmedGame.ffaSize));
    modal.querySelector('.go-bot-type').value = confirmedGame.botType;
    modal.querySelector('.go-bot-difficulty').value = confirmedGame.matchConfig?.rules?.botDifficulty || 'medium';
    const syncCreateForm = () => {
      typeButtons.forEach((button) => button.classList.toggle('active', button.dataset.type === matchType));
      modal.querySelectorAll('.game-type-section').forEach((section) => {
        section.classList.toggle('visible', section.dataset.forType.split(' ').includes(matchType));
      });
      const ranked = matchType === 'ranked';
      const custom = matchType === 'custom';
      modal.querySelector('.game-common-fields').classList.toggle('hidden', !custom);
      modal.querySelector('.map-block').classList.remove('hidden');
      mapButtons.forEach((button) => {
        const allowed = !ranked || ['foundry', 'skyhaven', 'feira_suspensa', 'procedural'].includes(button.dataset.map);
        button.classList.toggle('disabled', !allowed);
        if (!allowed && chosenMap === button.dataset.map) chosenMap = 'procedural';
        button.classList.toggle('active', button.dataset.map === chosenMap);
      });
      const isFfa = modeSelect.value === 'ffa';
      modal.querySelector('.go-team-size-wrap').classList.toggle('hidden', isFfa);
      modal.querySelector('.go-ffa-size-wrap').classList.toggle('hidden', !isFfa);
      modal.querySelector('.go-capture-wrap').classList.toggle('hidden', modeSelect.value !== 'ctf');
      modal.querySelector('.go-kills-wrap').classList.toggle('hidden', modeSelect.value === 'ctf');
      modal.querySelector('.game-create-button').textContent = 'CONFIRMAR';
    };
    typeButtons.forEach((button) => button.addEventListener('click', () => { matchType = button.dataset.type; syncCreateForm(); }));
    mapButtons.forEach((button) => button.addEventListener('click', () => {
      if (button.classList.contains('disabled')) return;
      chosenMap = button.dataset.map;
      mapButtons.forEach((item) => item.classList.toggle('active', item === button));
    }));
    modeSelect.addEventListener('change', syncCreateForm);
    modal.querySelector('.go-bot-type').addEventListener('change', syncCreateForm);
    syncCreateForm();

    modal.querySelector('.game-create-button').addEventListener('click', () => {
      const ranked = matchType === 'ranked';
      const modeId = ranked ? 'ctf' : modeSelect.value;
      const teamSize = ranked ? MAX_TEAM_SIZE : clampTeamSize(modal.querySelector('.go-team-size').value);
      const ffaSize = clampPlayerCount(modal.querySelector('.go-ffa-size').value);
      const enabledPowerups = [...modal.querySelectorAll('.powerup-toggle input:checked')].map((input) => input.value);
      const baseDistribution = CONFIG.powerups?.distribution || [];
      const matchConfig = {
        ...CONFIG,
        rules: {
          ...CONFIG.rules,
          roundTime: matchType === 'custom' ? Number(modal.querySelector('.go-time').value) : CONFIG.rules.roundTime,
          captureLimit: ranked ? 3 : (matchType === 'custom' ? Number(modal.querySelector('.go-captures').value) : CONFIG.rules.captureLimit),
          killsToWin: matchType === 'custom' ? Number(modal.querySelector('.go-kills').value) : CONFIG.rules.killsToWin,
          ffaKillsToWin: matchType === 'custom' ? Number(modal.querySelector('.go-kills').value) : CONFIG.rules.ffaKillsToWin,
          friendlyFire: matchType === 'custom' && modal.querySelector('.go-friendly').value === '1',
          bestOf: ranked ? 3 : 1,
          ranked,
          botDifficulty: modal.querySelector('.go-bot-difficulty').value,
        },
        powerups: {
          ...CONFIG.powerups,
          distribution: matchType === 'custom' ? baseDistribution.filter(([id]) => enabledPowerups.includes(id)) : baseDistribution,
        },
      };
      const respawnTime = matchType === 'custom' ? Number(modal.querySelector('.go-respawn').value) : 5;
      confirmedGame = {
        matchType,
        chosenMap,
        modeId,
        teamSize,
        ffaSize,
        respawnTime,
        botType: modal.querySelector('.go-bot-type').value,
        matchConfig,
        name: modal.querySelector('.go-name').value.trim() || `Sala de ${profile.name}`,
        code: modal.querySelector('.go-code').value.trim().toLowerCase() || Math.random().toString(36).slice(2, 8),
        password: modal.querySelector('.go-password').value || undefined,
      };
      selectedMode = modeId;
      selectedLevel = confirmedGame.chosenMap;
      close();
      if (matchType === 'custom') launchConfirmedGame(confirmedGame);
      else syncUI();
    });

    async function loadGameRooms() {
      const listNode = modal.querySelector('.game-room-list');
      const refresh = modal.querySelector('.game-refresh-rooms');
      roomsLoaded = true;
      refresh.disabled = true;
      listNode.innerHTML = '<div class="game-room-empty">Carregando salas…</div>';
      try {
        const rooms = (await listRooms()).filter(roomWithinCapacity).filter((room) => !/^\[(RANQUEADA|NORMAL)\]/.test(room.name || ''));
        if (!rooms.length) {
          listNode.innerHTML = '<div class="game-room-empty"><b>NENHUMA SALA ABERTA</b><span>Crie uma sala e convide seus amigos.</span></div>';
          return;
        }
        listNode.innerHTML = '';
        rooms.forEach((room) => {
          const card = document.createElement('article');
          card.className = 'game-room-card';
          const modeLabel = room.modeId === 'ctf' ? 'CAPTURE THE FLAG' : room.modeId === 'ffa' ? 'TODOS CONTRA TODOS' : 'DEATH MATCH';
          const capacity = room.modeId === 'ffa' ? room.teamLimits?.ffa : `${room.teamLimits?.red}v${room.teamLimits?.blue}`;
          card.innerHTML = `<div class="game-room-map" style="background-image:url('${MAP_DATA[room.levelId]?.img || MAP_DATA.procedural.img}')"></div><div class="game-room-copy"><div><h4>${escapeHtml(room.name)}</h4><code>${escapeHtml(room.code)}</code></div><p><span>${modeLabel}</span><span>${escapeHtml(MAP_DATA[room.levelId]?.name || 'Aleatório')}</span><span>${capacity}</span><span>${room.playersCount}/${room.maxPlayers} jogadores</span></p></div><button type="button">ENTRAR</button>`;
          card.querySelector('button').addEventListener('click', async () => {
            let password;
            if (room.isPrivate) {
              password = await promptRoomPassword(uiRoot, room.name);
              if (password === null) return;
            }
            close();
            const selection = {
              matchType: 'custom', name: room.name, code: room.code, password,
              modeId: room.modeId, chosenMap: room.levelId,
              teamSize: Number(room.teamLimits?.red) || 1,
              ffaSize: Number(room.teamLimits?.ffa) || Number(room.maxPlayers) || 2,
              respawnTime: room.respawnTime || 5,
              matchConfig: room.config || CONFIG,
            };
            const transport = await onPrepareOnline({ room: room.code, password });
            openRoomStaging({ selection, data: { code: room.code, room }, transport, isHost: false });
          });
          listNode.appendChild(card);
        });
      } catch (cause) {
        listNode.innerHTML = `<div class="game-room-empty error">${escapeHtml(cause.message || 'Não foi possível carregar as salas.')}</div>`;
      } finally {
        refresh.disabled = false;
      }
    }
    modal.querySelector('.game-refresh-rooms').addEventListener('click', loadGameRooms);
    showPage(initialPage);
  }

  async function openLobbyModal() {
    onClickSound?.();
    const modal = document.createElement('div');
    modal.className = 'modal-overlay social-modal-overlay';
    modal.innerHTML = `<div class="modal-window social-modal-window" role="dialog" aria-modal="true" aria-label="Amigos">
      <div class="modal-header social-header"><div><span>RINHA ARENA</span><div class="modal-title">AMIGOS</div></div><button class="modal-close" aria-label="Fechar">✕</button></div>
      <div class="social-layout">
        <aside class="social-add"><h3>ADICIONAR AMIGO</h3><small>SEU ID</small><code>${escapeHtml(profile.playerId)}</code><div class="social-search"><input maxlength="40" placeholder="ID ou nickname"><button>BUSCAR</button></div><div class="social-search-results"></div></aside>
        <section class="social-content"><nav class="social-tabs"><button class="active" data-tab="friends">AMIGOS</button><button data-tab="requests">SOLICITAÇÕES</button><button data-tab="trades">TROCAS</button></nav><div class="social-status"></div><div class="social-list"></div></section>
      </div>
      <div class="social-action-panel hidden"><div class="social-action-title"></div><div class="social-action-fields"></div><button class="social-action-confirm">CONFIRMAR</button><button class="social-action-cancel">CANCELAR</button></div>
    </div>`;
    uiRoot.appendChild(modal);
    const list = modal.querySelector('.social-list');
    const status = modal.querySelector('.social-status');
    const panel = modal.querySelector('.social-action-panel');
    let friends = [];
    const names = Object.fromEntries(SHOP_CHARACTERS.map((item) => [item.id, item.name]));
    const setStatus = (text, error = false) => { status.textContent = text; status.classList.toggle('error', error); };
    const closePanel = () => panel.classList.add('hidden');
    const friendCard = (friend) => `<article class="social-friend-card"><img src="${getAvatarUrl(friend.avatar)}" alt=""><div><strong>${escapeHtml(friend.nickname)}</strong><small>${friend.rank_points} PONTOS DE RANK</small></div><div class="social-friend-actions"><button data-profile-id="${friend.id}">VER PERFIL</button><button data-gift="gold" data-id="${friend.id}" data-name="${escapeHtml(friend.nickname)}">DAR GOLD</button><button data-gift="rank" data-id="${friend.id}" data-name="${escapeHtml(friend.nickname)}">DAR RANK</button><button data-trade="${friend.id}" data-name="${escapeHtml(friend.nickname)}">TROCAR</button></div></article>`;
    const loadTab = async (tab) => {
      closePanel(); list.innerHTML = '<div class="social-empty">CARREGANDO...</div>'; setStatus('');
      try {
        if (tab === 'friends') { friends = await listFriends(); list.innerHTML = friends.length ? friends.map(friendCard).join('') : '<div class="social-empty">ADICIONE AMIGOS PELO ID OU NICKNAME.</div>'; }
        if (tab === 'requests') { const rows = await listFriendRequests(); list.innerHTML = rows.length ? rows.map((row) => `<article class="social-friend-card"><img src="${getAvatarUrl(row.avatar)}" alt=""><div><strong>${escapeHtml(row.nickname)}</strong><small>QUER SER SEU AMIGO</small></div><div class="social-friend-actions"><button data-request="${row.id}" data-accept="1">ACEITAR</button><button class="danger" data-request="${row.id}" data-accept="0">RECUSAR</button></div></article>`).join('') : '<div class="social-empty">NENHUMA SOLICITAÇÃO PENDENTE.</div>'; }
        if (tab === 'trades') { const rows = await listCharacterTrades(); list.innerHTML = rows.length ? rows.map((row) => `<article class="social-friend-card"><div class="social-trade-icon">⇄</div><div><strong>${escapeHtml(row.nickname)}</strong><small>OFERECE ${escapeHtml(names[row.offered_character] || row.offered_character)} POR ${escapeHtml(names[row.requested_character] || row.requested_character)}</small></div><div class="social-friend-actions"><button data-trade-request="${row.id}" data-accept="1">ACEITAR</button><button class="danger" data-trade-request="${row.id}" data-accept="0">RECUSAR</button></div></article>`).join('') : '<div class="social-empty">NENHUMA PROPOSTA DE TROCA.</div>'; }
      } catch (error) { list.innerHTML = ''; setStatus(error.message, true); }
    };
    modal.querySelectorAll('.social-tabs button').forEach((button) => button.addEventListener('click', () => { modal.querySelectorAll('.social-tabs button').forEach((item) => item.classList.toggle('active', item === button)); loadTab(button.dataset.tab); }));
    modal.querySelector('.social-search button').addEventListener('click', async () => {
      const query = modal.querySelector('.social-search input').value.trim(); if (!query) return;
      const output = modal.querySelector('.social-search-results'); output.innerHTML = 'BUSCANDO...';
      try { const rows = await searchPlayers(query); output.innerHTML = rows.length ? rows.map((row) => `<div><span>${escapeHtml(row.nickname)}</span><button data-add="${row.id}">ADICIONAR</button></div>`).join('') : 'NENHUM JOGADOR ENCONTRADO'; } catch (error) { output.textContent = error.message; }
    });
    modal.querySelector('.social-search-results').addEventListener('click', async (event) => { const button = event.target.closest('[data-add]'); if (!button) return; button.disabled = true; try { await sendFriendRequest(button.dataset.add); button.textContent = 'ENVIADO'; } catch (error) { setStatus(error.message, true); button.disabled = false; } });
    list.addEventListener('click', async (event) => {
      const player=event.target.closest('[data-profile-id]'); if(player) {openProfilePage(player.dataset.profileId);return;}
      const request = event.target.closest('[data-request]'); const tradeRequest = event.target.closest('[data-trade-request]');
      if (request) { await respondFriendRequest(request.dataset.request, request.dataset.accept === '1').catch((error) => setStatus(error.message, true)); return loadTab('requests'); }
      if (tradeRequest) { await respondCharacterTrade(tradeRequest.dataset.tradeRequest, tradeRequest.dataset.accept === '1').catch((error) => setStatus(error.message, true)); return loadTab('trades'); }
      const gift = event.target.closest('[data-gift]'); const trade = event.target.closest('[data-trade]');
      if (gift) {
        panel.classList.remove('hidden'); panel.dataset.action = 'gift'; panel.dataset.id = gift.dataset.id; panel.dataset.kind = gift.dataset.gift;
        panel.querySelector('.social-action-title').textContent = `${gift.dataset.gift === 'gold' ? 'DAR GOLD' : 'DAR PONTOS DE RANK'} PARA ${gift.dataset.name}`;
        panel.querySelector('.social-action-fields').innerHTML = '<input class="social-amount" type="number" min="1" step="1" placeholder="Quantidade">';
      } else if (trade) {
        const friend = friends.find((item) => item.id === trade.dataset.trade); const mine = (profile.cos.ownedCharacters || []).filter((id) => id !== 'capivara'); const theirs = (friend?.owned_characters || []).filter((id) => id !== 'capivara');
        panel.classList.remove('hidden'); panel.dataset.action = 'trade'; panel.dataset.id = trade.dataset.trade;
        panel.querySelector('.social-action-title').textContent = `PROPOR TROCA COM ${trade.dataset.name}`;
        panel.querySelector('.social-action-fields').innerHTML = `<label>VOCÊ OFERECE<select class="social-offer">${mine.map((id) => `<option value="${id}">${escapeHtml(names[id] || id)}</option>`).join('')}</select></label><label>VOCÊ QUER<select class="social-request">${theirs.map((id) => `<option value="${id}">${escapeHtml(names[id] || id)}</option>`).join('')}</select></label>`;
        panel.querySelector('.social-action-confirm').disabled = !mine.length || !theirs.length;
      }
    });
    panel.querySelector('.social-action-cancel').addEventListener('click', closePanel);
    panel.querySelector('.social-action-confirm').addEventListener('click', async (event) => {
      event.currentTarget.disabled = true;
      try {
        if (panel.dataset.action === 'gift') { const amount = Math.floor(Number(panel.querySelector('.social-amount').value)); await giftFriendResource(panel.dataset.id, panel.dataset.kind, amount); if (panel.dataset.kind === 'gold') profile.gold -= amount; else profile.rankXp -= amount; profile.save(); syncUI(); }
        else await createCharacterTrade(panel.dataset.id, panel.querySelector('.social-offer').value, panel.querySelector('.social-request').value);
        setStatus(panel.dataset.action === 'gift' ? 'PRESENTE ENVIADO!' : 'PROPOSTA DE TROCA ENVIADA!'); closePanel();
      } catch (error) { setStatus(error.message, true); event.currentTarget.disabled = false; }
    });
    const close = () => modal.remove(); modal.querySelector('.modal-close').addEventListener('click', close); modal.addEventListener('click', (event) => { if (event.target === modal) close(); });
    loadTab('friends');
  }

  async function openRoomsLegacyModal() {
    onClickSound?.();
    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.innerHTML = `
      <div class="modal-window">
        <div class="modal-header">
          <div class="modal-title">🌐 SALAS MULTIPLAYER</div>
          <button class="modal-close">✕</button>
        </div>
        <div class="modal-body">
          <!-- Quick Code Join Bar -->
          <div style="display:flex; gap:8px; background:rgba(255,255,255,0.03); padding:10px 12px; border-radius:10px; border:1px solid rgba(140,170,255,0.2);">
            <input class="direct-room-input" maxlength="12" placeholder="Código da sala (ex: main)" style="flex:1; background:rgba(0,0,0,0.4); border:1px solid rgba(140,170,255,0.3); border-radius:8px; padding:8px 12px; color:#fff; font-size:14px; outline:none;" />
            <button class="modal-btn modal-btn-primary btn-direct-join" style="padding:8px 16px; font-size:13px; white-space:nowrap;">Entrar</button>
          </div>

          <div style="display:flex; justify-content:space-between; align-items:center; margin-top:4px;">
            <span style="font-size:13px; color:#8ea6d8;">Salas ativas no servidor:</span>
            <button class="modal-btn modal-btn-secondary btn-refresh-rooms" style="padding:6px 12px; font-size:12px;">🔄 Atualizar</button>
          </div>
          <div class="rooms-list">
            <div style="text-align:center; padding:30px; color:#7d90b8;">Carregando salas…</div>
          </div>
        </div>
        <div class="modal-footer">
          <button class="modal-btn modal-btn-secondary modal-close-btn">Fechar</button>
          <button class="modal-btn modal-btn-primary btn-lobby-create">➕ Criar Partida</button>
        </div>
      </div>
    `;
    uiRoot.appendChild(modal);

    const close = () => { modal.remove(); };
    modal.querySelector('.modal-close').addEventListener('click', close);
    modal.querySelector('.modal-close-btn').addEventListener('click', close);
    modal.querySelector('.btn-lobby-create').addEventListener('click', () => {
      close();
      openCustomCreateModal();
    });

    const directInput = modal.querySelector('.direct-room-input');
    const directJoinBtn = modal.querySelector('.btn-direct-join');
    directJoinBtn.addEventListener('click', async () => {
      const code = directInput.value.trim();
      if (!code) return;
      close();
      try {
        await onPlayOnline(code);
      } catch (e) {
        errBox.textContent = '⚠️ Could not reach the game server. Online play needs the server running on port 8090/8095.';
        errBox.classList.remove('hidden');
      }
    });

    const roomsList = modal.querySelector('.rooms-list');
    const refreshBtn = modal.querySelector('.btn-refresh-rooms');

    async function loadRooms() {
      refreshBtn.disabled = true;
      refreshBtn.textContent = '⏳ Carregando…';
      try {
        const list = (await listRooms()).filter(roomWithinCapacity);
        roomsList.innerHTML = '';
        if (list.length === 0) {
          roomsList.innerHTML = `
            <div style="text-align:center; padding:40px 20px; background:rgba(255,255,255,0.02); border-radius:12px; border:1px dashed rgba(140,170,255,0.2);">
              <div style="font-size:32px; margin-bottom:8px;">🏜️</div>
              <div style="font-weight:700; margin-bottom:4px;">Nenhuma sala aberta</div>
              <div style="font-size:12px; color:#8ea6d8;">Crie uma partida personalizada e convide seus amigos!</div>
            </div>
          `;
          return;
        }

        for (const r of list) {
          const card = document.createElement('div');
          card.className = 'room-card';
          const modeName = r.modeId === 'ffa' ? '⚔️ Todos contra Todos' : (r.modeId === 'deathmatch' ? '💀 Death Match' : '🚩 Capture the Flag');
          const lvlObj = LEVELS[r.levelId];
          const lvlName = lvlObj?.name ?? r.levelId;
          const teamsDesc = r.modeId === 'ffa'
            ? `Capacidade: ${r.maxPlayers} players`
            : `Times: 🔴 ${r.teamLimits?.red ?? 2} vs 🔵 ${r.teamLimits?.blue ?? 2}`;

          card.innerHTML = `
            <div class="room-card-head">
              <div class="room-card-title">
                <span>${r.name}</span>
                ${r.isPrivate ? '<span class="badge badge-lock">🔒 Senha</span>' : '<span class="badge" style="color:#62e89d; border-color:rgba(98,232,157,0.3)">🔓 Pública</span>'}
              </div>
              <span class="room-card-code">${r.code}</span>
            </div>
            <div class="room-badges">
              <span class="badge badge-gold">${modeName}</span>
              <span class="badge">📍 ${lvlName}</span>
              <span class="badge">👥 ${r.playersCount}/${r.maxPlayers} Jogadores</span>
              <span class="badge">${teamsDesc}</span>
              <span class="badge">⏱️ Respawn ${r.respawnTime}s</span>
              <span class="badge">${r.friendlyFire ? '🔥 Fogo Amigo ON' : '🛡️ Fogo Amigo OFF'}</span>
            </div>
            <div style="display:flex; justify-content:space-between; align-items:center; margin-top:4px;">
              <div class="team-join-select" style="display:${r.modeId === 'ffa' ? 'none' : 'flex'}; gap:6px;">
                <label style="font-size:12px; display:flex; align-items:center; gap:3px; cursor:pointer;">
                  <input type="radio" name="team_${r.code}" value="" checked /> 🎲 Auto
                </label>
                <label style="font-size:12px; display:flex; align-items:center; gap:3px; cursor:pointer; color:#ff8a6e;">
                  <input type="radio" name="team_${r.code}" value="red" /> 🔴 Red
                </label>
                <label style="font-size:12px; display:flex; align-items:center; gap:3px; cursor:pointer; color:#7ab6ff;">
                  <input type="radio" name="team_${r.code}" value="blue" /> 🔵 Blue
                </label>
              </div>
              <button class="modal-btn modal-btn-primary btn-join-room" style="padding:6px 14px; font-size:12px; margin-left:auto;">
                Entrar na Partida ➔
              </button>
            </div>
          `;

          const joinBtn = card.querySelector('.btn-join-room');
          joinBtn.addEventListener('click', async () => {
            let password = undefined;
            if (r.isPrivate) {
              password = await promptRoomPassword(uiRoot, r.name);
              if (password === null) return;
            }
            const checkedTeam = card.querySelector(`input[name="team_${r.code}"]:checked`)?.value || undefined;
            close();
            try {
              await onPlayOnline({ room: r.code, password, team: checkedTeam });
            } catch (err) {
              errBox.textContent = 'Erro ao conectar na sala: ' + err.message;
              errBox.classList.remove('hidden');
            }
          });

          roomsList.appendChild(card);
        }
      } catch (err) {
        roomsList.innerHTML = `<div style="text-align:center; padding:20px; color:#ff8a6e;">⚠️ Falha ao carregar salas: ${err.message}</div>`;
      } finally {
        refreshBtn.disabled = false;
        refreshBtn.textContent = '🔄 Atualizar';
      }
    }

    refreshBtn.addEventListener('click', loadRooms);
    loadRooms();
  }

  function openCustomCreateModal() {
    onClickSound?.();
    const modal = document.createElement('div');
    modal.className = 'modal-overlay';

    modal.innerHTML = `
      <div class="modal-window">
        <div class="modal-header">
          <div class="modal-title">➕ CRIAR PARTIDA PERSONALIZADA</div>
          <button class="modal-close">✕</button>
        </div>
        <div class="modal-body">
          <div class="field">
            <span style="font-size:12px; color:#bcd0f7; font-weight:700;">Nome da Sala</span>
            <input class="custom-name-input" maxlength="24" placeholder="Minha Sala Épica" value="${profile.name}'s Arena" style="width:100%; padding:10px; background:rgba(0,0,0,0.3); border:1px solid rgba(140,170,255,0.3); border-radius:8px; color:#fff;" />
          </div>

          <div style="display:flex; gap:12px;">
            <div class="field" style="flex:1;">
              <span style="font-size:12px; color:#bcd0f7; font-weight:700;">Código da Sala (URL)</span>
              <input class="custom-code-input" maxlength="12" placeholder="ex: rinha" style="width:100%; padding:10px; background:rgba(0,0,0,0.3); border:1px solid rgba(140,170,255,0.3); border-radius:8px; color:#fff;" />
            </div>
            <div class="field" style="flex:1;">
              <span style="font-size:12px; color:#bcd0f7; font-weight:700;">Senha (Opcional)</span>
              <input type="password" class="custom-pass-input" maxlength="20" placeholder="Sem senha (pública)" style="width:100%; padding:10px; background:rgba(0,0,0,0.3); border:1px solid rgba(140,170,255,0.3); border-radius:8px; color:#fff;" />
            </div>
          </div>

          <div class="field">
            <span style="font-size:12px; color:#bcd0f7; font-weight:700;">Modo de Jogo</span>
            <div class="create-mode-chips" style="display:flex; gap:8px; margin-top:6px;">
              <button class="chip sel chip-create-mode" data-mode="ctf" style="width:auto; height:auto; padding:8px 12px; font-size:12px;">🚩 Capture the Flag</button>
              <button class="chip chip-create-mode" data-mode="deathmatch" style="width:auto; height:auto; padding:8px 12px; font-size:12px;">💀 Death Match</button>
              <button class="chip chip-create-mode" data-mode="ffa" style="width:auto; height:auto; padding:8px 12px; font-size:12px;">⚔️ Todos contra Todos</button>
            </div>
          </div>

          <div class="field">
            <span style="font-size:12px; color:#bcd0f7; font-weight:700;">Mapa / Arena</span>
            <div class="create-level-chips" style="display:flex; gap:8px; margin-top:6px; flex-wrap:wrap;">
              <button class="chip sel chip-create-level" data-level="foundry" style="width:auto; height:auto; padding:8px 12px; font-size:12px;">📍 Foundry Court</button>
              <button class="chip chip-create-level" data-level="dojo" style="width:auto; height:auto; padding:8px 12px; font-size:12px;">📍 The Dojo</button>
              <button class="chip chip-create-level" data-level="skyhaven" style="width:auto; height:auto; padding:8px 12px; font-size:12px;">📍 Skyhaven</button>
              <button class="chip chip-create-level" data-level="feira_suspensa" style="width:auto; height:auto; padding:8px 12px; font-size:12px;">📍 Feira Suspensa</button>
              <button class="chip chip-create-level" data-level="procedural" style="width:auto; height:auto; padding:8px 12px; font-size:12px;">🎲 Procedural</button>
            </div>
          </div>

          <!-- Teams Config (1 to 3 per team, asymmetric support) -->
          <div class="field team-limits-section">
            <span style="font-size:12px; color:#bcd0f7; font-weight:700;">Jogadores por Equipe (até 3 em cada lado)</span>
            <div class="teams-config-box" style="margin-top:6px;">
              <div class="team-stepper-col">
                <span style="color:#ff8a6e; font-weight:700; font-size:12px;">🔴 Time Vermelho</span>
                <div class="stepper">
                  <button class="stepper-btn btn-red-minus">-</button>
                  <span class="stepper-val val-red">2</span>
                  <button class="stepper-btn btn-red-plus">+</button>
                </div>
              </div>
              <div class="team-stepper-col">
                <span style="color:#7ab6ff; font-weight:700; font-size:12px;">🔵 Time Azul</span>
                <div class="stepper">
                  <button class="stepper-btn btn-blue-minus">-</button>
                  <span class="stepper-val val-blue">2</span>
                  <button class="stepper-btn btn-blue-plus">+</button>
                </div>
              </div>
            </div>
            <div class="hint-text" style="margin-top:4px;">Suporta equipes assimétricas (ex: 3 vs 1, 3 vs 2).</div>
          </div>

          <!-- FFA Max Players (2 to 6) -->
          <div class="field ffa-limits-section" style="display:none;">
            <span style="font-size:12px; color:#bcd0f7; font-weight:700;">Total de Capivaras no Todos contra Todos</span>
            <div class="stepper" style="margin-top:6px;">
              <button class="stepper-btn btn-ffa-minus">-</button>
              <span class="stepper-val val-ffa">6</span>
              <button class="stepper-btn btn-ffa-plus">+</button>
            </div>
          </div>

          <div style="display:flex; gap:16px;">
            <div class="field" style="flex:1;">
              <span style="font-size:12px; color:#bcd0f7; font-weight:700;">Tempo de Respawn</span>
              <select class="custom-respawn-select" style="width:100%; margin-top:6px; padding:8px; background:rgba(0,0,0,0.3); border:1px solid rgba(140,170,255,0.3); border-radius:8px; color:#fff;">
                <option value="1">1 segundo (Rápido)</option>
                <option value="2">2 segundos</option>
                <option value="3">3 segundos</option>
                <option value="5" selected>5 segundos (Padrão)</option>
                <option value="8">8 segundos (Tático)</option>
              </select>
            </div>
            <div class="field" style="flex:1;">
              <span style="font-size:12px; color:#bcd0f7; font-weight:700;">Fogo Amigo</span>
              <select class="custom-ff-select" style="width:100%; margin-top:6px; padding:8px; background:rgba(0,0,0,0.3); border:1px solid rgba(140,170,255,0.3); border-radius:8px; color:#fff;">
                <option value="0" ${profile.friendlyFire ? '' : 'selected'}>Desativado</option>
                <option value="1" ${profile.friendlyFire ? 'selected' : ''}>Ativado</option>
              </select>
            </div>
          </div>
        </div>
        <div class="modal-footer">
          <button class="modal-btn modal-btn-secondary modal-close-btn">Cancelar</button>
          <button class="modal-btn modal-btn-primary btn-submit-create">🚀 CRIAR E JOGAR</button>
        </div>
      </div>
    `;

    uiRoot.appendChild(modal);

    const close = () => modal.remove();
    modal.querySelector('.modal-close').addEventListener('click', close);
    modal.querySelector('.modal-close-btn').addEventListener('click', close);

    let cMode = 'ctf';
    let cLevel = selectedLevel || 'foundry';
    let redCount = 2;
    let blueCount = 2;
    let ffaCount = 6;

    const teamSection = modal.querySelector('.team-limits-section');
    const ffaSection = modal.querySelector('.ffa-limits-section');

    modal.querySelectorAll('.chip-create-mode').forEach((b) => {
      b.addEventListener('click', () => {
        modal.querySelectorAll('.chip-create-mode').forEach((x) => x.classList.remove('sel'));
        b.classList.add('sel');
        cMode = b.dataset.mode;
        if (cMode === 'ffa') {
          teamSection.style.display = 'none';
          ffaSection.style.display = 'block';
        } else {
          teamSection.style.display = 'block';
          ffaSection.style.display = 'none';
        }
      });
    });

    modal.querySelectorAll('.chip-create-level').forEach((b) => {
      b.addEventListener('click', () => {
        modal.querySelectorAll('.chip-create-level').forEach((x) => x.classList.remove('sel'));
        b.classList.add('sel');
        cLevel = b.dataset.level;
      });
    });

    const valRed = modal.querySelector('.val-red');
    const valBlue = modal.querySelector('.val-blue');
    const valFfa = modal.querySelector('.val-ffa');

    modal.querySelector('.btn-red-minus').addEventListener('click', () => {
      if (redCount > 1) { redCount--; valRed.textContent = redCount; }
    });
    modal.querySelector('.btn-red-plus').addEventListener('click', () => {
      if (redCount < MAX_TEAM_SIZE) { redCount++; valRed.textContent = redCount; }
    });
    modal.querySelector('.btn-blue-minus').addEventListener('click', () => {
      if (blueCount > 1) { blueCount--; valBlue.textContent = blueCount; }
    });
    modal.querySelector('.btn-blue-plus').addEventListener('click', () => {
      if (blueCount < MAX_TEAM_SIZE) { blueCount++; valBlue.textContent = blueCount; }
    });
    modal.querySelector('.btn-ffa-minus').addEventListener('click', () => {
      if (ffaCount > 2) { ffaCount--; valFfa.textContent = ffaCount; }
    });
    modal.querySelector('.btn-ffa-plus').addEventListener('click', () => {
      if (ffaCount < MAX_PLAYERS) { ffaCount++; valFfa.textContent = ffaCount; }
    });

    const submitBtn = modal.querySelector('.btn-submit-create');
    submitBtn.addEventListener('click', async () => {
      submitBtn.disabled = true;
      submitBtn.textContent = '⏳ Criando sala…';
      const name = modal.querySelector('.custom-name-input').value.trim() || `${profile.name}'s Arena`;
      const code = modal.querySelector('.custom-code-input').value.trim().toLowerCase() || Math.random().toString(36).substring(2, 8);
      const password = modal.querySelector('.custom-pass-input').value || undefined;
      const cRespawn = Number(modal.querySelector('.custom-respawn-select').value) || 5;
      const cFriendlyFire = modal.querySelector('.custom-ff-select').value === '1';

      try {
        const data = await createRoom({
          name,
          code,
          password,
          modeId: cMode,
          levelId: cLevel,
          redSize: redCount,
          blueSize: blueCount,
          ffaSize: ffaCount,
          respawnTime: cRespawn,
          friendlyFire: cFriendlyFire,
        });
        if (!data.ok) throw new Error(data.error || 'Erro ao criar sala');
        close();
        await onPlayOnline({ room: data.code, password, host: true, hostToken: data.hostToken, roomConfig: data.room });
      } catch (err) {
        await showMessageDialog(uiRoot, { title: 'ERRO AO CRIAR SALA', message: err.message });
        submitBtn.disabled = false;
        submitBtn.textContent = '🚀 CRIAR E JOGAR';
      }
    });
  }

  return {
    ready,
    authenticatedReady,
    openInGameSettings(options) { return openSettingsModal({ ...options, inGame: true }); },
    async show() {
      const request = ++visibilityRequest;
      loading.show();
      el.classList.add('lobby-loading');
      syncUI();
      el.classList.remove('hidden');
      await loading.prepare(el, { includeLogin: false });
      if (request !== visibilityRequest) return;
      el.classList.remove('lobby-loading');
      loading.hide();
      playLobbyMedia();
    },
    hide() {
      visibilityRequest++;
      pauseLobbyMedia();
      el.classList.add('hidden');
      loading.hide();
    },
  };
}
