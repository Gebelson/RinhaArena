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
import { saveAccountProfile } from '../net/account.js';
import { openAuthGate } from './auth.js';

const escapeHtml = (value) => String(value ?? '').replace(/[&<>'"]/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
}[char]));
const AVATARS = Array.from({ length: 6 }, (_, index) => `avatar-${index + 1}.webp`);

export function createMenu(uiRoot, profile, { onPlayLocal, onPlayOnline, onPlayLab, onClickSound }) {
  const el = document.createElement('div');
  el.className = 'menu';

  // Mobile browsers only allow fullscreen after a user gesture. Entering it on
  // the first touch hides the address/search bar and preserves the landscape UI.
  const enterMobileFullscreen = async () => {
    if (!matchMedia('(pointer: coarse)').matches || document.fullscreenElement) return;
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
    procedural: {
      id: 'procedural',
      name: 'Procedural',
      img: './assets/maps/procedural.png',
      desc: 'Arena cósmica gerada dinamicamente com geometria imprevisível.',
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
  if (!AVATARS.includes(profile.cos.avatar)) profile.cos.avatar = AVATARS[0];

  let selectedMode = 'ctf';
  let selectedLevel = DEFAULT_LEVEL in MAP_DATA ? DEFAULT_LEVEL : 'foundry';
  const initialRank = getRankProgress(profile.rankXp);
  const initialLevel = getLevelProgress(profile.rankStats);

  el.innerHTML = `
    <video class="lobby-bg-video" autoplay muted loop playsinline preload="auto" poster="./assets/background-main.png" aria-hidden="true">
      <source src="./assets/media/lobby-background.mp4" type="video/mp4" />
    </video>
    <div class="home-lobby">
      <section class="player-card" aria-label="Perfil do jogador">
        <button class="player-avatar" type="button" aria-label="Trocar ícone do perfil"><img src="./assets/ui/avatars/${profile.cos.avatar}" alt="Ícone do perfil" /></button>
        <div class="player-summary">
          <input class="name-input player-name" maxlength="12" aria-label="Nome do jogador" value="${profile.name || 'Player'}" />
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
        <button class="image-icon-btn btn-lobby" aria-label="Amigos e salas"><img src="./assets/ui/menu-friends.png" alt="" /></button>
        <button class="image-icon-btn btn-settings" aria-label="Configurações"><img src="./assets/ui/menu-config.png" alt="" /></button>
        <button class="image-icon-btn btn-audio" aria-label="Áudio"><img src="./assets/ui/menu-audio.png" alt="" /></button>
      </nav>

      <button class="art-button shop-button btn-shop" aria-label="Loja de personagens"><img src="./assets/ui/menu-shop.png" alt="Loja de personagens" /></button>
      <button class="art-button ranking-button btn-ranking" aria-label="Ranking"><img src="./assets/ui/menu-ranking.png" alt="Ranking" /></button>
      <button class="art-button missions-button btn-missions" aria-label="Missões"><img src="./assets/ui/menu-missions.png" alt="Missões" /></button>

      <button class="map-selector" aria-label="Selecionar arena">
        <img class="map-selector-thumb" src="./assets/maps/mini_foundry.png" alt="" />
        <span class="map-selector-copy"><strong class="big-map-name">Foundry Court</strong><small><b>⌖</b> <span class="big-map-sub">Capture a Bandeira</span></small></span>
        <span class="map-chevron">›</span>
      </button>

      <button class="art-button play-button play-btn-huge" aria-label="Jogar"><img src="./assets/ui/menu-play.png" alt="Jogar" /></button>

      <div class="quick-config hidden" aria-label="Configurações da partida">
        <div class="quick-config-head"><strong>CONFIGURAÇÕES</strong><button class="quick-config-close" aria-label="Fechar">✕</button></div>
        <label>NOME DO JOGADOR</label>
        <div class="config-name-mirror">${profile.name || 'Player'}</div>
        <label>CHAPÉU</label>
        <div class="hat-row">${HATS.map((h, i) => `<button class="hat-btn ${profile.hat === h.id ? 'sel' : ''}" data-hat="${h.id}" title="${h.name}"><img src="./assets/ui/hat_${i}.png" alt="${h.name}" class="hat-img" /></button>`).join('')}</div>
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
              <input class="name-input" maxlength="12" placeholder="Player" value="${profile.name || 'Player'}" />
            </div>
          </div>

          <!-- HAT -->
          <div class="field-block">
            <label class="field-label">HAT</label>
            <div class="hat-row">
              ${HATS.map((h, i) => `
                <button class="hat-btn ${profile.hat === h.id ? 'sel' : ''}" data-hat="${h.id}" title="${h.name}">
                  <img src="./assets/ui/hat_${i}.png" alt="${h.name}" class="hat-img" />
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
            <img src="./assets/logo.png" alt="RINHA ARENA — PEGA BANDEIRA" class="lobby-logo-img" />
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
                <img src="./assets/ui/icon_ver_salas.png" class="btn-icon-img" alt="Salas" />
                <span>VER SALAS ONLINE</span>
              </button>
              <button class="btn-action-gold btn-custom-create">
                <img src="./assets/ui/icon_criar_sala.png" class="btn-icon-img" alt="Criar" />
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
                <img src="./assets/ui/icon_live_bot.png" class="btn-icon-img" alt="Live Bot" />
                <span>live bot</span>
              </button>
              <button class="lab-btn btn-doll">
                <img src="./assets/ui/icon_training_doll.png" class="btn-icon-img" alt="Training Doll" />
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
  const lobbyMusic = new Audio('./audio/lobby-theme.m4a');
  lobbyMusic.loop = true;
  lobbyMusic.preload = 'auto';
  lobbyMusic.volume = Math.min(1, Math.max(0, Number(localStorage.getItem('blast.musicVolume') ?? .38)));
  btnAudio.classList.toggle('muted', localStorage.getItem('blast.muted') === '1');

  const playLobbyMedia = () => {
    lobbyVideo.play().catch(() => {});
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
    const meta = MAP_DATA[selectedLevel] || MAP_DATA.foundry;
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
    bigMapName.textContent = meta.name;
    if (bigMapDesc) bigMapDesc.textContent = meta.desc;
    bigMapSub.textContent = selectedMode === 'ctf' ? 'Capture a Bandeira' : mode.label.replace(/^\S+\s/, '');

    const rankProgress = getRankProgress(profile.rankXp);
    const levelProgress = getLevelProgress(profile.rankStats);
    levelText.textContent = levelProgress.level;
    levelBadge.src = `./assets/ui/levels/${getLevelBadgeAsset(levelProgress.level)}`;
    levelBadge.alt = `Nível ${levelProgress.level}`;
    xpFill.style.width = `${levelProgress.progress * 100}%`;
    xpText.textContent = levelProgress.isMax ? 'NÍVEL MÁXIMO' : `${levelProgress.xp} / ${levelProgress.required} XP`;
    rankShield.src = `./assets/ui/ranks/${rankProgress.rank.asset}`;
    rankShield.alt = rankProgress.rank.name;
    playerAvatar.src = `./assets/ui/avatars/${profile.cos.avatar}`;
    coinText.textContent = Math.max(0, Number(profile.gold) || 0).toLocaleString('pt-BR');
  }

  // ------------------------------------------------------------ Event listeners
  // Name input
  nameInput.value = profile.name || 'Player';
  nameInput.addEventListener('input', () => {
    profile.name = nameInput.value.trim() || 'Player';
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

  // Huge Play vs Bots CTA
  btnPlayBots.addEventListener('click', () => {
    onClickSound?.();
    let lvlId = selectedLevel;
    if (selectedLevel === 'procedural') {
      lvlId = LEVELS.procedural.seedId;
      newProceduralSeed();
    }
    onPlayLocal(selectedMode, lvlId);
  });

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
  btnLobby.addEventListener('click', () => openLobbyModal());
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
  mapSelector.addEventListener('click', () => {
    const ids = Object.keys(MAP_DATA);
    selectedLevel = ids[(ids.indexOf(selectedLevel) + 1) % ids.length];
    onClickSound?.();
    syncUI();
  });
  el.querySelector('.btn-shop').addEventListener('click', () => {
    onClickSound?.();
    configPanel.classList.remove('hidden');
  });
  el.querySelector('.player-avatar').addEventListener('click', () => openAvatarModal());
  el.querySelector('.rank-badge-wrap').addEventListener('click', () => openRankProgressModal());
  el.querySelector('.btn-ranking').addEventListener('click', () => openLeaderboardModal());
  el.querySelector('.btn-missions').addEventListener('click', () => openHowToPlayModal());

  // Initial Sync
  syncUI();
  el.classList.add('auth-pending');

  openAuthGate(uiRoot, {
    async onAuthenticated(account) {
      const saved = account.profile;
      profile.playerId = account.user.id;
      profile.name = saved.nickname;
      profile.gold = saved.gold;
      profile.rankXp = saved.rank_points;
      profile.rankStats = { matches: saved.matches, wins: saved.wins, losses: saved.losses };
      profile.hat = saved.hat || 'crown';
      profile.skin = saved.skin || REFERENCE_SKINS[6];
      profile.friendlyFire = Boolean(saved.friendly_fire);
      profile.cos = {
        ...profile.cos,
        avatar: AVATARS.includes(saved.avatar) ? saved.avatar : AVATARS[0],
        hat: profile.hat,
        skin: profile.skin,
      };

      let saveTimer = 0;
      profile.save = function saveAuthenticatedProfile() {
        localStorage.setItem('blast.profile', JSON.stringify({
          playerId: this.playerId, name: this.name, gold: this.gold, cos: this.cos,
          friendlyFire: this.friendlyFire, rankXp: this.rankXp, rankStats: this.rankStats,
        }));
        clearTimeout(saveTimer);
        saveTimer = window.setTimeout(() => saveAccountProfile(this).catch((error) => console.warn('[profile] sync failed:', error.message)), 350);
      };

      nameInput.value = profile.name;
      const mirror = el.querySelector('.config-name-mirror');
      if (mirror) mirror.textContent = profile.name;
      syncUI();
      el.classList.remove('auth-pending');
      await submitPlayerRanking(profile).catch(() => {});
    },
  });

  // ------------------------------------------------------------ Modals
  function openSettingsModal() {
    const muted = localStorage.getItem('blast.muted') === '1';
    const modal = document.createElement('div');
    modal.className = 'modal-overlay settings-modal-overlay';
    modal.innerHTML = `
      <div class="modal-window settings-modal-window" role="dialog" aria-modal="true" aria-label="Configurações">
        <div class="modal-header"><div class="modal-title">CONFIGURAÇÕES</div><button class="modal-close" aria-label="Fechar">✕</button></div>
        <div class="settings-body">
          <section class="settings-section">
            <h3>ÁUDIO</h3>
            <label class="settings-row"><span><b>Som do jogo</b><small>Ativa músicas e efeitos sonoros</small></span><input class="settings-toggle-input settings-sound" type="checkbox" ${muted ? '' : 'checked'}><i class="settings-toggle"></i></label>
            <label class="settings-volume"><span><b>Volume da música</b><output>${Math.round(lobbyMusic.volume * 100)}%</output></span><input type="range" min="0" max="100" value="${Math.round(lobbyMusic.volume * 100)}" aria-label="Volume da música"></label>
          </section>
          <section class="settings-section">
            <h3>PARTIDA</h3>
            <label class="settings-row"><span><b>Fogo amigo</b><small>Permite atingir jogadores da sua equipe</small></span><input class="settings-toggle-input settings-friendly-fire" type="checkbox" ${profile.friendlyFire ? 'checked' : ''}><i class="settings-toggle"></i></label>
          </section>
          <section class="settings-section">
            <h3>TELA</h3>
            <button class="settings-fullscreen" type="button">${document.fullscreenElement ? 'SAIR DA TELA CHEIA' : 'ATIVAR TELA CHEIA'}</button>
          </section>
        </div>
      </div>`;
    uiRoot.appendChild(modal);

    const close = () => modal.remove();
    modal.querySelector('.modal-close').addEventListener('click', close);
    modal.addEventListener('click', (event) => { if (event.target === modal) close(); });

    modal.querySelector('.settings-sound').addEventListener('change', (event) => {
      const nextMuted = !event.currentTarget.checked;
      localStorage.setItem('blast.muted', nextMuted ? '1' : '0');
      window.dispatchEvent(new CustomEvent('blast:mute-change', { detail: { muted: nextMuted } }));
      lobbyMusic.muted = nextMuted;
      btnAudio.classList.toggle('muted', nextMuted);
      btnAudio.setAttribute('aria-label', nextMuted ? 'Ativar áudio' : 'Desativar áudio');
      if (!nextMuted) playLobbyMedia();
    });

    const volume = modal.querySelector('.settings-volume input');
    const volumeOutput = modal.querySelector('.settings-volume output');
    volume.addEventListener('input', () => {
      lobbyMusic.volume = Number(volume.value) / 100;
      localStorage.setItem('blast.musicVolume', String(lobbyMusic.volume));
      volumeOutput.value = `${volume.value}%`;
    });

    modal.querySelector('.settings-friendly-fire').addEventListener('change', (event) => {
      profile.friendlyFire = event.currentTarget.checked;
      profile.save();
      ffBtns.forEach((button) => button.classList.toggle('sel', (button.dataset.ff === 'true') === profile.friendlyFire));
    });

    modal.querySelector('.settings-fullscreen').addEventListener('click', async (event) => {
      try {
        if (document.fullscreenElement) await document.exitFullscreen();
        else await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
        event.currentTarget.textContent = document.fullscreenElement ? 'SAIR DA TELA CHEIA' : 'ATIVAR TELA CHEIA';
      } catch {
        event.currentTarget.textContent = 'TELA CHEIA INDISPONÍVEL';
      }
    });
  }

  function openAvatarModal() {
    onClickSound?.();
    const modal = document.createElement('div');
    modal.className = 'modal-overlay avatar-modal-overlay';
    modal.innerHTML = `
      <div class="modal-window avatar-modal-window">
        <div class="modal-header"><div class="modal-title">ESCOLHA SEU ÍCONE</div><button class="modal-close">✕</button></div>
        <div class="avatar-grid">
          ${AVATARS.map((avatar, index) => `<button class="avatar-option ${avatar === profile.cos.avatar ? 'selected' : ''}" data-avatar="${avatar}" aria-label="Selecionar ícone ${index + 1}"><img src="./assets/ui/avatars/${avatar}" alt="Ícone ${index + 1}" /></button>`).join('')}
        </div>
      </div>`;
    uiRoot.appendChild(modal);
    const close = () => modal.remove();
    modal.querySelector('.modal-close').addEventListener('click', close);
    modal.addEventListener('click', (event) => { if (event.target === modal) close(); });
    modal.querySelectorAll('.avatar-option').forEach((button) => {
      button.addEventListener('click', () => {
        profile.cos.avatar = button.dataset.avatar;
        profile.save();
        playerAvatar.src = `./assets/ui/avatars/${profile.cos.avatar}`;
        onClickSound?.();
        close();
      });
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
          ${RANKS.map((rank) => `<div class="rank-entry ${rank.index === progress.rank.index ? 'current' : ''} ${rank.xp > progress.xp ? 'locked' : 'unlocked'}"><div class="rank-entry-icon rank-sprite" style="${rankSpriteStyle(rank)}"></div><strong>${rank.name}</strong><small>${rank.index === RANKS.length - 1 ? 'SEM LIMITE' : '0–100 PTS'}</small></div>`).join('')}
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
    modal.innerHTML = `
      <div class="modal-window leaderboard-window">
        <div class="modal-header"><div class="modal-title">RANKING DE JOGADORES</div><button class="modal-close">✕</button></div>
        <div class="leaderboard-head"><span>POSIÇÃO</span><span>RANK</span><span>JOGADOR</span><span>VITÓRIAS</span><span>PONTOS</span></div>
        <div class="leaderboard-list"><div class="leaderboard-loading">Carregando ranking…</div></div>
      </div>`;
    uiRoot.appendChild(modal);
    const close = () => modal.remove();
    modal.querySelector('.modal-close').addEventListener('click', close);
    modal.addEventListener('click', (event) => { if (event.target === modal) close(); });

    const list = modal.querySelector('.leaderboard-list');
    try {
      await submitPlayerRanking(profile);
      const players = await listPlayerRankings(100);
      list.innerHTML = players.length ? players.map((player, index) => {
        const rank = getRankProgress(player.points).rank;
        const place = index + 1;
        return `<div class="leaderboard-row ${place <= 3 ? `leaderboard-top leaderboard-top-${place}` : ''} ${player.playerId === profile.playerId ? 'is-me' : ''}">
          <div class="leaderboard-place"><b>${place}</b>${place <= 3 ? '<span>★</span>' : ''}</div>
          <div class="leaderboard-rank"><img src="./assets/ui/ranks/${rank.asset}" alt="${rank.name}"><span>${rank.name}</span></div>
          <strong class="leaderboard-name">${escapeHtml(player.name)}</strong>
          <b class="leaderboard-wins">${Number(player.wins).toLocaleString('pt-BR')}</b>
          <b class="leaderboard-points">${Number(player.points).toLocaleString('pt-BR')}</b>
        </div>`;
      }).join('') : '<div class="leaderboard-loading">Nenhum jogador classificado ainda.</div>';
    } catch (error) {
      list.innerHTML = `<div class="leaderboard-loading leaderboard-error">Não foi possível carregar o ranking agora.<small>${escapeHtml(error.message)}</small></div>`;
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

  function openSettingsModal() {
    onClickSound?.();
    const isMuted = localStorage.getItem('blast.muted') === '1';
    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.innerHTML = `
      <div class="modal-window">
        <div class="modal-header">
          <div class="modal-title">⚙️ CONFIGURAÇÕES & ÁUDIO</div>
          <button class="modal-close">✕</button>
        </div>
        <div class="modal-body">
          <div style="display:flex; justify-content:space-between; align-items:center; background:rgba(255,255,255,0.04); padding:14px; border-radius:12px;">
            <div>
              <div style="font-weight:700; color:#fff;">Sons e Efeitos Sonoros</div>
              <div style="font-size:12px; color:#8ea6d8;">Ativar ou silenciar áudio do jogo</div>
            </div>
            <button class="modal-btn btn-mute-toggle" style="background:${isMuted ? 'rgba(255,83,71,0.2)' : 'rgba(74,222,128,0.2)'}; color:${isMuted ? '#ff8a6e' : '#4ade80'}; border:1px solid currentColor;">
              ${isMuted ? '🔇 Silenciado' : '🔊 Áudio Ativado'}
            </button>
          </div>
          <div style="font-size:12px; color:#8ea6d8; line-height:1.5; padding:8px 4px;">
            💡 <i>Dica:</i> Você pode pressionar <b>M</b> a qualquer momento durante a batalha para alternar o som instantaneamente.
          </div>
        </div>
        <div class="modal-footer">
          <button class="modal-btn modal-btn-secondary modal-close-btn">Fechar</button>
        </div>
      </div>
    `;
    uiRoot.appendChild(modal);
    const close = () => modal.remove();
    modal.querySelector('.modal-close').addEventListener('click', close);
    modal.querySelector('.modal-close-btn').addEventListener('click', close);
    const toggleBtn = modal.querySelector('.btn-mute-toggle');
    toggleBtn.addEventListener('click', () => {
      const nowMuted = localStorage.getItem('blast.muted') === '1';
      localStorage.setItem('blast.muted', nowMuted ? '0' : '1');
      const nextMuted = !nowMuted;
      lobbyMusic.muted = nextMuted;
      btnAudio.classList.toggle('muted', nextMuted);
      toggleBtn.style.background = nextMuted ? 'rgba(255,83,71,0.2)' : 'rgba(74,222,128,0.2)';
      toggleBtn.style.color = nextMuted ? '#ff8a6e' : '#4ade80';
      toggleBtn.textContent = nextMuted ? '🔇 Silenciado' : '🔊 Áudio Ativado';
      onClickSound?.();
    });
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

  async function openLobbyModal() {
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
        const list = await listRooms();
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
              password = prompt(`A sala "${r.name}" é protegida por senha. Digite a senha:`);
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
              <button class="chip chip-create-level" data-level="procedural" style="width:auto; height:auto; padding:8px 12px; font-size:12px;">🎲 Procedural</button>
            </div>
          </div>

          <!-- Teams Config (1 to 5 per team, asymmetric support) -->
          <div class="field team-limits-section">
            <span style="font-size:12px; color:#bcd0f7; font-weight:700;">Jogadores por Equipe (até 5 em cada lado)</span>
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
            <div class="hint-text" style="margin-top:4px;">Suporta equipes assimétricas (ex: 3 vs 1, 5 vs 2).</div>
          </div>

          <!-- FFA Max Players (2 to 10) -->
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
      if (redCount < 5) { redCount++; valRed.textContent = redCount; }
    });
    modal.querySelector('.btn-blue-minus').addEventListener('click', () => {
      if (blueCount > 1) { blueCount--; valBlue.textContent = blueCount; }
    });
    modal.querySelector('.btn-blue-plus').addEventListener('click', () => {
      if (blueCount < 5) { blueCount++; valBlue.textContent = blueCount; }
    });
    modal.querySelector('.btn-ffa-minus').addEventListener('click', () => {
      if (ffaCount > 2) { ffaCount--; valFfa.textContent = ffaCount; }
    });
    modal.querySelector('.btn-ffa-plus').addEventListener('click', () => {
      if (ffaCount < 10) { ffaCount++; valFfa.textContent = ffaCount; }
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
        alert('Erro ao criar sala: ' + err.message);
        submitBtn.disabled = false;
        submitBtn.textContent = '🚀 CRIAR E JOGAR';
      }
    });
  }

  return {
    show() {
      syncUI();
      el.classList.remove('hidden');
      playLobbyMedia();
    },
    hide() {
      pauseLobbyMedia();
      el.classList.add('hidden');
    },
  };
}
