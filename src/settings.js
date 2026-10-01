export const DEFAULT_SETTINGS = Object.freeze({
  musicVolume: 38,
  sfxVolume: 50,
  graphicsQuality: 'high',
  fps: 60,
  language: 'pt-BR',
  notifications: true,
  autoFullscreen: true,
  brightness: 100,
  colorblind: 'none',
  chat: true,
  animations: true,
  gameCursor: true,
  controls: {
    up: 'KeyW', down: 'KeyS', left: 'KeyA', right: 'KeyD',
    jump: 'Space', grab: 'KeyE', punch: 'KeyF', dash: 'ShiftLeft',
  },
});

const STORAGE_KEY = 'rinha.settings';

export function getSettings() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(STORAGE_KEY)) || {}; } catch { saved = {}; }
  return { ...DEFAULT_SETTINGS, ...saved, controls: { ...DEFAULT_SETTINGS.controls, ...saved.controls } };
}

export function saveSettings(next) {
  const settings = { ...getSettings(), ...next, controls: { ...getSettings().controls, ...(next.controls || {}) } };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  applySettings(settings);
  window.dispatchEvent(new CustomEvent('rinha:settings-change', { detail: settings }));
  return settings;
}

export function applySettings(settings = getSettings()) {
  const root = document.documentElement;
  root.lang = settings.language;
  root.style.setProperty('--game-brightness', `${Math.max(50, Math.min(150, settings.brightness))}%`);
  document.body?.classList.toggle('reduce-game-animations', !settings.animations);
  document.body?.classList.toggle('hide-game-cursor', !settings.gameCursor);
  document.body?.setAttribute('data-colorblind', settings.colorblind);
  document.body?.setAttribute('data-graphics', settings.graphicsQuality);
  document.body?.setAttribute('data-chat', settings.chat ? 'on' : 'off');
}

export function keyLabel(code) {
  return ({ Space: 'ESPAÇO', ShiftLeft: 'SHIFT', ShiftRight: 'SHIFT', ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→' })[code]
    || code.replace(/^Key/, '').replace(/^Digit/, '');
}
