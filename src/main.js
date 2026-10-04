// Entry point: menu <-> match orchestration and the render loop.
// A "match" wires together: transport (local sim or server connection),
// renderer + world (visuals), input, HUD and sound. Everything a match
// creates is disposed when you exit, so menu <-> game cycles are clean.

import { CONFIG } from './core/config.js';
import { LEVELS, DEFAULT_LEVEL } from './content/levels/index.js';
import { DEFAULT_COS } from './content/cosmetics.js';
import { createLocalGame } from './net/local.js';
import { connectOnline } from './net/ws.js';
import { createRenderer } from './render/renderer.js';
import { World } from './render/world.js';
import { createInput } from './input/input.js';
import { createHud } from './ui/hud.js';
import { createMenu } from './ui/menu.js';
import { createLabPanel } from './ui/labPanel.js';
import { createEmoteWheel } from './ui/emoteWheel.js';
import { createSfx } from './audio/sfx.js';
import { createBgm } from './audio/music.js';
import { makeLabConfig } from './game/modes/sandbox.js';
import { getRankProgress } from './content/ranks.js';
import { submitPlayerRanking } from './net/ranking.js';
import { registerPlayerAbandon } from './net/discipline.js';
import { applySettings, getSettings } from './settings.js';
import { recordMissionMatch } from './game/missions.js';
import { startAutoUpdate } from './autoUpdate.js';

const isTouch = navigator.maxTouchPoints > 0
  || matchMedia('(pointer: coarse)').matches
  || new URLSearchParams(location.search).has('touch'); // force for testing
const canvas = document.getElementById('game');
const uiRoot = document.getElementById('ui');
const sfx = createSfx();
const bgm = createBgm();
applySettings();
startAutoUpdate();

// Unlock audio context on initial user interaction so audio assets load early
window.addEventListener('pointerdown', () => sfx.unlock(), { once: true });
window.addEventListener('keydown', () => sfx.unlock(), { once: true });

// --- profile (name + cosmetics), persisted locally
const profile = (() => {
  let data;
  try { data = JSON.parse(localStorage.getItem('blast.profile')) ?? {}; } catch { data = {}; }
  return {
    playerId: data.playerId || crypto.randomUUID(),
    name: data.name || '',
    gold: Math.max(0, Number(data.gold) || 0),
    cos: { ...DEFAULT_COS, ...data.cos },
    friendlyFire: data.friendlyFire ?? false,
    rankXp: Math.max(0, Number(data.rankXp) || 0),
    rankStats: {
      matches: Math.max(0, Number(data.rankStats?.matches) || 0),
      wins: Math.max(0, Number(data.rankStats?.wins) || 0),
      losses: Math.max(0, Number(data.rankStats?.losses) || 0),
    },
    missionStats: data.missionStats || {},
    missions: Array.isArray(data.missions) ? data.missions : [],
    save() {
      localStorage.setItem('blast.profile', JSON.stringify({ playerId: this.playerId, name: this.name, gold: this.gold, cos: this.cos, friendlyFire: this.friendlyFire, rankXp: this.rankXp, rankStats: this.rankStats, missionStats: this.missionStats, missions: this.missions }));
    },
  };
})();
profile.save();

let match = null;
const ACTIVE_MATCH_KEY = 'blast.activeMatch';

const prepareOnlineMatch = (opts) => {
  const room = typeof opts === 'string' ? opts : opts?.room || 'main';
  const password = typeof opts === 'object' ? opts?.password : null;
  const team = typeof opts === 'object' ? opts?.team : null;
  return connectOnline({
    room,
    password,
    team,
    host: typeof opts === 'object' && !!opts?.host,
    hostToken: typeof opts === 'object' ? opts?.hostToken : null,
    roomConfig: typeof opts === 'object' ? opts?.roomConfig : null,
    profile,
    onDropped: () => match?.exit('Connection lost'),
  });
};

const menu = createMenu(uiRoot, profile, {
  onClickSound: () => { sfx.unlock(); sfx.play('click'); },
  onPlayLocal: (modeId, levelId, matchOptions = {}) => startMatch(createLocalGame({
    profile,
    modeId,
    levelId,
    config: matchOptions.config || {
      ...CONFIG,
      rules: {
        ...CONFIG.rules,
        friendlyFire: profile.friendlyFire ?? false,
      },
    },
    teamLimits: matchOptions.teamLimits,
    respawnTime: matchOptions.respawnTime,
  })),
  onPlayLab: (variant) => startMatch(createLocalGame({
    profile,
    levelId: 'dojo',
    modeId: `sandbox-${variant}`,
    config: makeLabConfig(),
    teamSize: 1,
  })),
  onPrepareOnline: prepareOnlineMatch,
  onStartPrepared: (transport) => startMatch(transport),
  onPlayOnline: async (opts) => startMatch(await prepareOnlineMatch(opts)),
});
function playSfx(events, myId, myPos) {
  const spatial = (ev) => Math.max(0.15, 1 - Math.hypot(ev.x - myPos.x, ev.z - myPos.z) / 30);
  for (const ev of events) {
    switch (ev.t) {
      case 'explode': sfx.play('explode', spatial(ev)); break;
      case 'throw': sfx.play('throw', spatial(ev) * 0.9); break;
      case 'bounce': sfx.play('bounce', spatial(ev) * 0.7); break;
      case 'punch': sfx.play('punch', spatial(ev)); break;
      case 'punchHit':
        sfx.play('punchHit', spatial(ev));
        if (ev.instaKO) sfx.play('playerThrow', spatial(ev) * 0.9);
        break;
      case 'impact': sfx.play('bounce', spatial(ev)); break;
      case 'knockout': sfx.play('punchHit', spatial(ev) * 0.6); break;
      case 'jump': if (ev.id === myId) sfx.play('jump'); break;
      case 'dash': sfx.play('dash', spatial(ev)); break;
      case 'grabBomb': case 'bombOut': sfx.play('grab'); break;
      case 'grabPlayer': sfx.play('grabPlayer'); break;
      case 'playerThrow':
        sfx.play('playerThrow', spatial(ev));
        fx.poof(ev.x, ev.z, '#e2ecfa');
        break;
      case 'flagSteal': sfx.play('flagTaken'); break;
      case 'flagThrow': sfx.play('throw', spatial(ev)); break;
      case 'flagDrop': sfx.play('flagDrop'); break;
      case 'flagReturn': case 'flagVoid': sfx.play('flagReturn'); break;
      case 'score': sfx.play('score'); break;
      case 'scoreBlocked': if (ev.id === myId) sfx.play('denied'); break;
      case 'ko': sfx.play('ko'); break;
      case 'hurt': if (ev.id === myId) sfx.play('hurt'); break;
      case 'spawn': if (ev.id === myId) sfx.play('spawn'); break;
      case 'tick': sfx.play('tick'); break;
      case 'go':
        sfx.play('go');
        bgm.play({ fade: true });
        break;
      case 'newRound':
        bgm.play({ fade: true });
        break;
      case 'roundOver':
        sfx.play(ev.winner !== 'draw' ? 'win' : 'lose');
        bgm.duck(3500);
        break;
      case 'powerup': sfx.play(ev.kind === 'curse' ? 'curse' : 'powerup', spatial(ev)); break;
      case 'wearOff': if (ev.id === myId) sfx.play('wearOff'); break;
      case 'shieldHit': sfx.play('shieldHit', spatial(ev)); break;
      case 'shieldDown': sfx.play('shieldDown', spatial(ev)); break;
      case 'freeze': sfx.play('freeze', spatial(ev)); break;
      case 'shatter': sfx.play('shatter', spatial(ev)); break;
      case 'mineArm': sfx.play('mineArm', spatial(ev) * 0.8); break;
      case 'stick': sfx.play('stick', spatial(ev)); break;
      case 'powerupBoom': sfx.play('bounce', spatial(ev)); break;
    }
  }
}

function startMatch(transport) {
  menu.hide();
  sfx.unlock();
  bgm.play({ fade: true, reset: true });
  canvas.classList.remove('hidden');

  const level = LEVELS[transport.levelId ?? DEFAULT_LEVEL];
  const renderer = createRenderer(canvas, { touch: isTouch, theme: level.theme });
  const world = new World(renderer.scene, level, { touch: isTouch });
  const hud = createHud(uiRoot, {
    onExit: () => exit(),
    onSendChat: (message) => transport.sendChat?.(message),
    onMute: () => {
      const isMuted = sfx.toggle();
      bgm.setMuted(isMuted);
      return isMuted;
    },
    muted: sfx.muted,
  });
  const input = createInput({ uiRoot, isTouch });
  const emoteWheel = createEmoteWheel(uiRoot, {
    onSelect: (emote) => transport.sendEmote?.(emote),
    getOwnedEmotes: () => profile.cos.ownedEmotes || [],
  });
  const labPanel = transport.modeId?.startsWith('sandbox')
    ? createLabPanel(uiRoot, transport)
    : null;
  let settingsPanel = null;
  let actionDialog = null;
  let abandoning = false;
  const closeActionDialog = () => { actionDialog?.remove(); actionDialog = null; };
  const showMessage = (title, text) => {
    closeActionDialog();
    const node = document.createElement('div'); node.className = 'modal-overlay match-confirm-overlay';
    node.innerHTML = `<section class="match-action-dialog"><h2>${title}</h2><p>${text}</p><div class="match-action-buttons"><button type="button">OK</button></div></section>`;
    uiRoot.appendChild(node); actionDialog = node;
    node.querySelector('button').onclick = closeActionDialog;
  };
  const confirmLeave = () => {
    closeActionDialog();
    const node = document.createElement('div'); node.className = 'modal-overlay match-confirm-overlay';
    node.innerHTML = '<section class="match-action-dialog"><h2>DEIXAR PARTIDA</h2><p>Essa ação não tem mais volta. Tem certeza que deseja sair da partida? Você pode prejudicar sua equipe.</p><div class="match-action-buttons"><button data-no>NÃO</button><button data-yes>SIM</button></div></section>';
    uiRoot.appendChild(node); actionDialog = node;
    node.querySelector('[data-no]').onclick = closeActionDialog;
    node.querySelector('[data-yes]').onclick = async (event) => {
      if (abandoning) return; abandoning = true; event.currentTarget.disabled = true;
      try {
        const result = await transport.abandonMatch();
        let discipline = null;
        if (!result?.duplicate) {
          discipline = await registerPlayerAbandon(result.matchId, result.mode, result.rankPenalty || 0);
          if (discipline?.rankPenalty) profile.rankXp = Math.max(0, profile.rankXp - discipline.rankPenalty);
          profile.save();
        }
        const warnings = Number(discipline?.abandonWarnings) || 0;
        const feedback = result.ranked && discipline?.rankPenalty
          ? `Você perdeu ${discipline.rankPenalty} pontos de rank por abandonar. Aviso de abandono: ${warnings}/2.`
          : result.mode === 'custom' ? 'Você deixou a partida.' : `Você deixou a partida. Aviso de abandono: ${warnings}/2.`;
        localStorage.removeItem(ACTIVE_MATCH_KEY);
        closeActionDialog();
        exit('abandoned');
        showMessage('PARTIDA ENCERRADA', feedback + (warnings >= 2 ? ' Penalidade de matchmaking: 5 minutos.' : ''));
      } catch (error) { abandoning = false; event.currentTarget.disabled = false; showMessage('ERRO', error.message); }
    };
  };
  const openInGameSettings = () => {
    settingsPanel = menu.openInGameSettings({
      onSurrender: () => {
        transport.requestSurrender?.();
        settingsPanel?.close();
        settingsPanel = null;
      },
      onLeave: confirmLeave,
    });
  };
  const onKey = (event) => {
    if (event.code !== 'Escape' || /INPUT|TEXTAREA|SELECT/.test(event.target?.tagName)) return;
    event.preventDefault();
    if (hud.isChatOpen()) { hud.closeChat(); return; }
    if (emoteWheel.isOpen()) { emoteWheel.close(); return; }
    if (actionDialog) { closeActionDialog(); return; }
    if (settingsPanel?.modal?.isConnected) { settingsPanel.close(); settingsPanel = null; }
    else openInGameSettings();
  };
  window.addEventListener('keydown', onKey);

  const resumeInfo = transport.resumeInfo?.();
  if (resumeInfo) localStorage.setItem(ACTIVE_MATCH_KEY, JSON.stringify(resumeInfo));
  const persistTimer = window.setInterval(() => {
    const current = transport.resumeInfo?.();
    if (current) localStorage.setItem(ACTIVE_MATCH_KEY, JSON.stringify(current));
  }, 1_000);
  const onPageHide = () => {
    const transferred = transport.notifyDisconnect?.();
    if (transferred) {
      const current = transport.resumeInfo?.();
      if (current) {
        delete current.host;
        delete current.hostToken;
        delete current.roomConfig;
        delete current.match;
        delete current.matchStart;
        delete current.authorityState;
        localStorage.setItem(ACTIVE_MATCH_KEY, JSON.stringify(current));
      }
    }
  };
  window.addEventListener('pagehide', onPageHide);

  let raf = 0;
  let roundExitTimer = 0;
  let last = performance.now();
  let lastRendered = 0;
  let firstFrame = true;

  function frame(now) {
    raf = requestAnimationFrame(frame);
    const frameInterval = 1000 / getSettings().fps;
    if (now - lastRendered < frameInterval) return;
    lastRendered = now;
    step(now);
  }

  // One full frame: sim, input, world sync, HUD, render. Separated from the
  // rAF callback so tests (and the debug hook) can pump frames manually.
  function step(now) {
    const dt = Math.min((now - last) / 1000, 0.05);
    last = now;

    transport.update(dt * (labPanel?.timeScale ?? 1)); // lab slow-mo
    const view = transport.view();
    if (!view) {
      hud.setConnecting(true);
      renderer.render(0);
      return;
    }
    hud.setConnecting(false);

    const myId = transport.myId;
    const me = view.players.find((p) => p.id === myId);
    const myPos = me ? { x: me.x, z: me.z } : { x: 0, z: 0 };

    const sampled = input.sample({ myPos, screenToGround: renderer.screenToGround });
    const controlsBlocked = Boolean(emoteWheel.isOpen() || settingsPanel?.modal?.isConnected || actionDialog || document.querySelector('.surrender-vote-overlay'));
    transport.setInput(controlsBlocked
      ? { mx: 0, mz: 0, ax: 0, az: 0, run: 0, jump: false, punch: false, throw: false, grab: false, dash: false }
      : sampled.input);
    world.setAim(
      sampled.aimPoint,
      !!sampled.aimPoint && me?.state === 'alive' && (!isTouch || sampled.aiming),
    );

    const events = transport.drainEvents();
    for (const control of transport.drainControlEvents?.() || []) {
      if (control.type === 'emote') world.showEmote(control.participantId, control.emote);
      if (control.type === 'surrender-update') showSurrenderVote(control);
      if (control.type === 'surrender-result') {
        const voteOverlay = document.querySelector('.surrender-vote-overlay');
        if (voteOverlay) { clearInterval(voteOverlay._timer); voteOverlay.remove(); }
        showMessage('VOTAÇÃO ENCERRADA', control.approved ? 'A desistência foi aprovada.' : 'A desistência não foi aprovada. A partida continua.');
      }
    }
    hud.pushChatMessages(transport.drainChatMessages?.() ?? []);
    for (const event of events) {
      if (event.t !== 'roundOver' || view.lab) continue;
      if (event.matchComplete === false) continue;
      const draw = event.winner === 'draw';
      const won = !draw && (view.modeId === 'ffa' ? event.winner === myId : event.winner === me?.team);
      const gainedPoints = event.ranked ? (draw ? 10 : won ? 25 : -20) : 0;
      const gainedGold = draw ? 40 : won ? 100 : 20;
      profile.rankXp = Math.max(0, profile.rankXp + gainedPoints);
      profile.gold = Math.max(0, (Number(profile.gold) || 0) + gainedGold);
      profile.rankStats.matches += 1;
      if (won) profile.rankStats.wins += 1;
      else if (!draw) profile.rankStats.losses += 1;
      recordMissionMatch(profile, { won, draw, ranked: event.ranked, modeId: view.modeId, gold: gainedGold });
      profile.save();
      submitPlayerRanking(profile).catch((error) => console.warn('[rank] sync failed:', error.message));
      const { rank } = getRankProgress(profile.rankXp);
      if (event.ranked) console.info(`[rank] ${gainedPoints >= 0 ? '+' : ''}${gainedPoints} PTS · ${rank.name}`);
      clearTimeout(roundExitTimer);
      localStorage.removeItem(ACTIVE_MATCH_KEY);
      roundExitTimer = window.setTimeout(exit, Math.max(0, CONFIG.rules.overTime * 1000 - 150));
    }
    world.handleEvents(events, myPos);
    hud.pushEvents(events, view, myId);
    labPanel?.update(view, events, myId, dt);
    playSfx(events, myId, myPos);

    world.sync(view, dt, myId);
    hud.update(view, myId);

    if (me) renderer.follow(me.x, me.z, me.vx * 0.22, me.vz * 0.22, dt, firstFrame);
    firstFrame = false;
    renderer.render(world.shake);
  }
  raf = requestAnimationFrame(frame);

  function exit(reason) {
    cancelAnimationFrame(raf);
    clearTimeout(roundExitTimer);
    clearInterval(persistTimer);
    window.removeEventListener('keydown', onKey);
    window.removeEventListener('pagehide', onPageHide);
    bgm.pause({ fade: true });
    transport.dispose?.();
    input.dispose();
    emoteWheel.dispose();
    labPanel?.dispose();
    hud.dispose();
    world.dispose();
    renderer.dispose();
    settingsPanel?.close();
    closeActionDialog();
    const voteOverlay = document.querySelector('.surrender-vote-overlay');
    if (voteOverlay) { clearInterval(voteOverlay._timer); voteOverlay.remove(); }
    canvas.classList.add('hidden');
    match = null;
    window.__blast = null;
    menu.show();
    if (!reason) localStorage.removeItem(ACTIVE_MATCH_KEY);
    if (reason) console.warn('[blast] left match:', reason);
  }

  match = { exit };
  window.__blast = { transport, input, world, step, renderer }; // dev/debug hook

  function showSurrenderVote(vote) {
    let overlay = document.querySelector('.surrender-vote-overlay');
    if (!overlay) {
      overlay = document.createElement('div'); overlay.className = 'modal-overlay surrender-vote-overlay';
      overlay.innerHTML = '<section class="match-action-dialog"><h2>DESISTIR DA PARTIDA?</h2><p class="vote-count"></p><strong class="vote-time"></strong><div class="match-action-buttons"><button data-vote="1">SIM</button><button data-vote="0">NÃO</button></div></section>';
      uiRoot.appendChild(overlay);
      overlay.querySelectorAll('[data-vote]').forEach((button) => button.onclick = () => {
        transport.voteSurrender?.(vote.team, button.dataset.vote === '1');
        overlay.querySelectorAll('button').forEach((item) => { item.disabled = true; });
      });
      overlay._timer = setInterval(() => {
        const deadline = Number(overlay.dataset.deadline) || 0;
        overlay.querySelector('.vote-time').textContent = `${Math.max(0, Math.ceil((deadline - Date.now()) / 1000))}s`;
      }, 250);
    }
    overlay.dataset.deadline = vote.deadlineAt;
    const votes = vote.votes || [];
    overlay.querySelector('.vote-count').textContent = `${votes.filter(([,yes]) => yes).length} voto(s) SIM • ${votes.filter(([,yes]) => !yes).length} NÃO`;
    overlay.querySelector('.vote-time').textContent = `${Math.max(0, Math.ceil((vote.deadlineAt - Date.now()) / 1000))}s`;
  }
}

async function resumeActiveMatch() {
  let saved;
  try { saved = JSON.parse(localStorage.getItem(ACTIVE_MATCH_KEY)); } catch { saved = null; }
  if (!saved?.room || !saved?.matchId || Number(saved.expiresAt) <= Date.now()) {
    localStorage.removeItem(ACTIVE_MATCH_KEY);
    return;
  }
  try {
    const transport = await prepareOnlineMatch({
      room: saved.room, password: saved.password,
      host: !!saved.host, hostToken: saved.hostToken,
      roomConfig: saved.host ? saved.roomConfig : null,
    });
    if (saved.host) transport.restoreHostedMatch?.(saved);
    const active = await transport.waitForMatch();
    if (active?.id !== saved.matchId || active.status === 'FINISHED') throw new Error('A partida já terminou');
    await transport.clientReadyAndWaitForStart();
    await startMatch(transport, { title: 'VOLTANDO À PARTIDA...' });
  } catch (error) {
    localStorage.removeItem(ACTIVE_MATCH_KEY);
    console.warn('[MATCH] não foi possível retomar:', error?.message || error);
  }
}

setTimeout(resumeActiveMatch, 0);

window.addEventListener('keydown', (e) => {
  if (!/INPUT|TEXTAREA/.test(e.target?.tagName)) {
    if (e.code === 'KeyM') {
      const isMuted = sfx.toggle();
      bgm.setMuted(isMuted);
      const muteBtn = document.querySelector('.btn-mute');
      if (muteBtn) muteBtn.textContent = isMuted ? '🔇' : '🔊';
    } else if (e.code === 'KeyC' && window.toggleCapivara) {
      window.toggleCapivara();
    } else if (e.code === 'KeyV' && window.rotateCapivara) {
      window.rotateCapivara();
    } else if (e.code === 'KeyB' && window.toggleCapivaraRing) {
      window.toggleCapivaraRing();
    } else if ((e.code === 'BracketRight' || e.code === 'Equal') && window.setCapivaraScale) {
      window.setCapivaraScale((window.capivaraHeight || 2.2) + 0.2);
    } else if ((e.code === 'BracketLeft' || e.code === 'Minus') && window.setCapivaraScale) {
      window.setCapivaraScale(Math.max(0.6, (window.capivaraHeight || 2.2) - 0.2));
    }
  }
});
