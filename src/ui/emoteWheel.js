import { EMOTES, getEmote } from '../content/emotes.js';

const DEAD_ZONE = 54;

export function createEmoteWheel(uiRoot, { onSelect, getOwnedEmotes } = {}) {
  const root = document.createElement('div');
  root.className = 'emote-wheel-overlay';
  root.innerHTML = `<div class="emote-wheel" role="menu" aria-label="Emotes">
    <div class="emote-wheel-center"><b>T</b><span>ARRASTE</span></div>
    <p class="emote-wheel-empty">COMPRE EMOTES NA LOJA</p>
    ${EMOTES.map((emote, index) => `<button type="button" class="emote-wheel-item" data-id="${emote.id}" data-index="${index}" aria-label="${emote.name}"><img src="${emote.image}" alt=""></button>`).join('')}
  </div>`;
  uiRoot.appendChild(root);

  const wheel = root.querySelector('.emote-wheel');
  const items = [...root.querySelectorAll('.emote-wheel-item')];
  let open = false;
  let selected = -1;
  let lastSentAt = 0;
  let activeEmotes = [];

  const layout = () => {
    const radius = wheel.clientWidth * 0.36;
    items.forEach((item) => { item.hidden = !activeEmotes.includes(item.dataset.id); });
    const activeItems = items.filter((item) => !item.hidden);
    activeItems.forEach((item, index) => {
      const angle = index * Math.PI * 2 / activeItems.length - Math.PI / 2;
      item.style.transform = `translate(calc(-50% + ${Math.cos(angle) * radius}px), calc(-50% + ${Math.sin(angle) * radius}px))`;
    });
  };
  const choose = (event) => {
    if (!open) return;
    const rect = wheel.getBoundingClientRect();
    const dx = event.clientX - (rect.left + rect.width / 2);
    const dy = event.clientY - (rect.top + rect.height / 2);
    const distance = Math.hypot(dx, dy);
    const count = activeEmotes.length;
    selected = !count || distance < DEAD_ZONE ? -1 : Math.round((Math.atan2(dy, dx) + Math.PI / 2) / (Math.PI * 2 / count));
    selected = selected < 0 && count ? selected + count : count ? selected % count : -1;
    if (distance < DEAD_ZONE) selected = -1;
    items.forEach((item) => item.classList.toggle('selected', item.dataset.id === activeEmotes[selected]));
  };
  const show = (event) => {
    if (open || /INPUT|TEXTAREA|SELECT/.test(event.target?.tagName)) return;
    open = true;
    selected = -1;
    activeEmotes = [...new Set((getOwnedEmotes?.() || []).filter((id) => getEmote(id)))].slice(0, 8);
    root.classList.toggle('empty', activeEmotes.length === 0);
    root.classList.add('open');
    document.body.classList.add('emote-wheel-open');
    layout();
    choose(event);
    event.preventDefault();
  };
  const hide = (submit) => {
    if (!open) return;
    const emote = selected >= 0 ? activeEmotes[selected] : null;
    open = false;
    selected = -1;
    root.classList.remove('open');
    document.body.classList.remove('emote-wheel-open');
    items.forEach((item) => item.classList.remove('selected'));
    if (submit && emote && performance.now() - lastSentAt >= 1500) {
      lastSentAt = performance.now();
      onSelect?.(emote);
    }
  };
  const onKeyDown = (event) => { if (event.code === 'KeyT' && !event.repeat) show(event); };
  const onKeyUp = (event) => { if (event.code === 'KeyT') { event.preventDefault(); hide(true); } };
  const onBlur = () => hide(false);

  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('mousemove', choose);
  window.addEventListener('blur', onBlur);

  return {
    isOpen: () => open,
    close: () => hide(false),
    dispose() {
      hide(false);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('mousemove', choose);
      window.removeEventListener('blur', onBlur);
      root.remove();
    },
  };
}
