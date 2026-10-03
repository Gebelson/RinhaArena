const EMOTES = ['👍', '😂', '❤️', '😡', '👋', '😎', '💥', '❓'];
const DEAD_ZONE = 54;

export function createEmoteWheel(uiRoot, { onSelect } = {}) {
  const root = document.createElement('div');
  root.className = 'emote-wheel-overlay';
  root.innerHTML = `<div class="emote-wheel" role="menu" aria-label="Emotes">
    <div class="emote-wheel-center"><b>T</b><span>ARRASTE</span></div>
    ${EMOTES.map((emote, index) => `<button type="button" class="emote-wheel-item" data-index="${index}" aria-label="Emote ${emote}"><span>${emote}</span></button>`).join('')}
  </div>`;
  uiRoot.appendChild(root);

  const wheel = root.querySelector('.emote-wheel');
  const items = [...root.querySelectorAll('.emote-wheel-item')];
  let open = false;
  let selected = -1;
  let lastSentAt = 0;

  const layout = () => {
    const radius = wheel.clientWidth * 0.36;
    items.forEach((item, index) => {
      const angle = index * Math.PI * 2 / items.length - Math.PI / 2;
      item.style.transform = `translate(calc(-50% + ${Math.cos(angle) * radius}px), calc(-50% + ${Math.sin(angle) * radius}px))`;
    });
  };
  const choose = (event) => {
    if (!open) return;
    const rect = wheel.getBoundingClientRect();
    const dx = event.clientX - (rect.left + rect.width / 2);
    const dy = event.clientY - (rect.top + rect.height / 2);
    const distance = Math.hypot(dx, dy);
    selected = distance < DEAD_ZONE ? -1 : Math.round((Math.atan2(dy, dx) + Math.PI / 2) / (Math.PI * 2 / items.length));
    selected = selected < 0 ? selected + items.length : selected % items.length;
    if (distance < DEAD_ZONE) selected = -1;
    items.forEach((item, index) => item.classList.toggle('selected', index === selected));
  };
  const show = (event) => {
    if (open || /INPUT|TEXTAREA|SELECT/.test(event.target?.tagName)) return;
    open = true;
    selected = -1;
    root.classList.add('open');
    document.body.classList.add('emote-wheel-open');
    layout();
    choose(event);
    event.preventDefault();
  };
  const hide = (submit) => {
    if (!open) return;
    const emote = selected >= 0 ? EMOTES[selected] : null;
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
