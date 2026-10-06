const imageCache = new Map();
const POSTER = './assets/media/lobby-background-poster.webp';
const LOGIN_IMAGES = ['./assets/ui/login-arena.webp', './assets/ui/logo-rinha-arena.webp'];

function loadImage(url) {
  const key = new URL(url, document.baseURI).href;
  if (imageCache.has(key)) return imageCache.get(key);
  const image = new Image();
  image.fetchPriority = 'high';
  const promise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => fail(), 20_000);
    const fail = () => {
      clearTimeout(timer);
      image.onload = image.onerror = null;
      imageCache.delete(key);
      reject(new Error('Não foi possível carregar as imagens. Verifique sua conexão.'));
    };
    image.onerror = fail;
    image.onload = async () => {
      try {
        await image.decode();
        clearTimeout(timer);
        resolve();
      } catch { fail(); }
    };
    image.src = key;
  });
  imageCache.set(key, promise);
  return promise;
}

async function loadFonts() {
  // Keep external font services from blocking the usable lobby indefinitely.
  let timer;
  await Promise.race([
    Promise.all([
      document.fonts?.load('900 16px "Barlow Condensed"'),
      document.fonts?.load('700 16px "Rajdhani"'),
    ]).catch(() => {}),
    new Promise((resolve) => { timer = setTimeout(resolve, 2500); }),
  ]);
  clearTimeout(timer);
}

export function createLobbyLoading(root) {
  let overlay = document.getElementById('app-loading');
  if (!overlay) {
    overlay = document.createElement('section');
    overlay.id = 'app-loading';
    overlay.className = 'app-loading';
    overlay.innerHTML = '<div class="app-loading-card"><strong>RINHA ARENA</strong><p class="app-loading-label" role="status">Preparando lobby…</p><div class="app-loading-track" role="progressbar" aria-label="Carregamento do lobby" aria-valuemin="0" aria-valuemax="100"><i></i></div><button class="app-loading-retry" hidden>TENTAR NOVAMENTE</button></div>';
    root.appendChild(overlay);
  }
  const label = overlay.querySelector('.app-loading-label');
  const track = overlay.querySelector('.app-loading-track');
  const retry = overlay.querySelector('.app-loading-retry');
  const progress = (value) => {
    track.setAttribute('aria-valuenow', String(value));
    track.querySelector('i').style.width = `${value}%`;
  };
  return {
    show() {
      overlay.hidden = false;
      label.textContent = 'Preparando lobby…';
      retry.hidden = true;
      progress(0);
    },
    hide() { progress(100); overlay.hidden = true; },
    async prepare(menu, { includeLogin = true } = {}) {
      const urls = [...new Set([
        POSTER, ...(includeLogin ? LOGIN_IMAGES : []),
        ...[...menu.querySelectorAll('.home-lobby img')]
          .filter((image) => !image.closest('.quick-config'))
          .map((image) => image.getAttribute('src')).filter(Boolean),
      ])];
      for (;;) {
        let done = 0;
        const tasks = [...urls.map(loadImage), loadFonts()];
        try {
          await Promise.all(tasks.map((task) => task.then(() => {
            progress(Math.round(++done / tasks.length * 100));
          })));
          // Decode the actual DOM images as well before revealing their controls.
          let decodeTimer;
          try {
            await Promise.race([
              Promise.all([...menu.querySelectorAll('.home-lobby img')]
                .filter((image) => !image.closest('.quick-config'))
                .map((image) => image.decode())),
              new Promise((_, reject) => { decodeTimer = setTimeout(() => reject(new Error('Image decode timed out')), 20_000); }),
            ]);
          } finally { clearTimeout(decodeTimer); }
          return;
        } catch {
          await Promise.allSettled(tasks);
          label.textContent = 'Não foi possível carregar o lobby. Verifique sua conexão.';
          retry.hidden = false;
          await new Promise((resolve) => { retry.onclick = resolve; });
          retry.onclick = null;
          retry.hidden = true;
          label.textContent = 'Preparando lobby…';
          progress(0);
          // Restart failed DOM requests without reloading successful assets.
          for (const image of menu.querySelectorAll('.home-lobby img')) {
            if (!image.closest('.quick-config') && !image.naturalWidth) image.src = image.getAttribute('src');
          }
        }
      }
    },
  };
}
