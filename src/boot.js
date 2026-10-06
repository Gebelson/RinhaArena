// The HTML loading screen is already visible while the game module graph loads.
import('./main.js').catch(() => {
  const overlay = document.getElementById('app-loading');
  overlay.hidden = false;
  overlay.querySelector('.app-loading-label').textContent = 'Não foi possível iniciar o jogo. Verifique sua conexão.';
  const retry = overlay.querySelector('.app-loading-retry');
  retry.hidden = false;
  retry.onclick = () => location.reload();
});
