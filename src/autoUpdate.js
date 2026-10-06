const WATCHED_FILES = [
  './index.html',
  './styles.css',
  './src/ui/theme.css',
  './src/boot.js',
  './src/ui/lobbyLoading.js',
  './src/main.js',
  './src/ui/menu.js',
  './src/net/ws.js',
  './src/render/characters.js',
  './src/render/renderer.js',
  './src/game/matchmaking.js',
];

async function publishedFingerprint() {
  const chunks = await Promise.all(WATCHED_FILES.map(async (path) => {
    const separator = path.includes('?') ? '&' : '?';
    const response = await fetch(`${path}${separator}update=${Date.now()}`, { cache: 'no-store' });
    if (!response.ok) throw new Error(`Falha ao verificar ${path}`);
    return new Uint8Array(await response.arrayBuffer());
  }));
  const size = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const joined = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.length; }
  const digest = await crypto.subtle.digest('SHA-256', joined);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
}

export async function startAutoUpdate({ intervalMs = 10_000 } = {}) {
  let current;
  try { current = await publishedFingerprint(); } catch { return; }
  let checking = false;
  const check = async () => {
    if (checking || document.visibilityState !== 'visible') return;
    checking = true;
    try {
      const next = await publishedFingerprint();
      if (next !== current) {
        await new Promise((resolve) => setTimeout(resolve, 1500));
        const confirmed = await publishedFingerprint();
        if (confirmed !== current) {
          const url = new URL(location.href);
          url.searchParams.set('app-update', Date.now().toString());
          location.replace(url);
          return;
        }
      }
    } catch { /* retry on the next interval */ }
    finally { checking = false; }
  };
  setInterval(check, intervalMs);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') check(); });
}
