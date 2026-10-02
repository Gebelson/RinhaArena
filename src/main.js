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
import { createSfx } from './audio/sfx.js';
import { createBgm } from './audio/music.js';
import { makeLabConfig } from './game/modes/sandbox.js';
import { getRankProgress } from './content/ranks.js';
import { submitPlayerRanking } from './net/ranking.js';
import { applySettings, getSettings } from './settings.js';

const isTouch = navigator.maxTouchPoints > 0
  || matchMedia('(pointer: coarse)').matches
  || new URLSearchParams(location.search).has('touch'); // force for testing
const canvas = document.getElementById('game');
const uiRoot = document.getElementById('ui');
const sfx = createSfx();
const bgm = createBgm();

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
    save() {
      localStorage.setItem('blast.profile', JSON.stringify({ playerId: this.playerId, name: this.name, gold: this.gold, cos: this.cos, friendlyFire: this.friendlyFire, rankXp: this.rankXp, rankStats: this.rankStats }));
    },
  };
})();
profile.save();

let match = null;

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
  const labPanel = transport.modeId?.startsWith('sandbox')
    ? createLabPanel(uiRoot, transport)
    : null;

  const onKey = (e) => {
    if (e.code === 'Escape' && !/INPUT|TEXTAREA/.test(e.target?.tagName)) exit();
  };
  window.addEventListener('keydown', onKey);

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
    transport.setInput(sampled.input);
    world.setAim(
      sampled.aimPoint,
      !!sampled.aimPoint && me?.state === 'alive' && (!isTouch || sampled.aiming),
    );

    const events = transport.drainEvents();
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
      profile.save();
      submitPlayerRanking(profile).catch((error) => console.warn('[rank] sync failed:', error.message));
      const { rank } = getRankProgress(profile.rankXp);
      if (event.ranked) console.info(`[rank] ${gainedPoints >= 0 ? '+' : ''}${gainedPoints} PTS · ${rank.name}`);
      clearTimeout(roundExitTimer);
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
    window.removeEventListener('keydown', onKey);
    bgm.pause({ fade: true });
    transport.dispose?.();
    input.dispose();
    labPanel?.dispose();
    hud.dispose();
    world.dispose();
    renderer.dispose();
    canvas.classList.add('hidden');
    match = null;
    window.__blast = null;
    menu.show();
    if (reason) console.warn('[blast] left match:', reason);
  }

  match = { exit };
  window.__blast = { transport, input, world, step, renderer }; // dev/debug hook
}

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
