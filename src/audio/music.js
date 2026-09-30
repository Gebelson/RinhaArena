// Background battle music manager for Blast Arena.
// Handles looping, smooth volume fading (fade in / fade out), and mute sync.

export function createBgm() {
  let audio = null;
  let targetVolume = 0.35; // balanced to sit nicely under sfx
  let currentVolume = 0.35;
  let fadeTimer = null;
  let isPlaying = false;

  function ensure() {
    if (!audio && typeof Audio !== 'undefined') {
      audio = new Audio('./audio/battle.mp3');
      audio.loop = true;
      audio.preload = 'auto';
      const isMuted = localStorage.getItem('blast.muted') === '1';
      audio.muted = isMuted;
      audio.volume = isMuted ? 0 : targetVolume;
    }
    return audio;
  }

  function clearFade() {
    if (fadeTimer) {
      clearInterval(fadeTimer);
      fadeTimer = null;
    }
  }

  function fadeTo(target, durationMs = 600, onDone) {
    if (!audio) return;
    clearFade();
    const start = audio.volume;
    const diff = target - start;
    if (Math.abs(diff) < 0.01) {
      audio.volume = target;
      onDone?.();
      return;
    }
    const steps = 15;
    const interval = Math.max(20, Math.floor(durationMs / steps));
    let step = 0;
    fadeTimer = setInterval(() => {
      step++;
      const progress = step / steps;
      audio.volume = Math.max(0, Math.min(1, start + diff * progress));
      if (step >= steps) {
        clearFade();
        audio.volume = target;
        onDone?.();
      }
    }, interval);
  }

  return {
    get isPlaying() {
      return isPlaying;
    },

    get muted() {
      return audio ? audio.muted : localStorage.getItem('blast.muted') === '1';
    },

    play({ fade = true, reset = false } = {}) {
      try {
        const a = ensure();
        if (!a) return;
        if (reset) a.currentTime = 0;
        const isMuted = localStorage.getItem('blast.muted') === '1';
        a.muted = isMuted;

        if (fade && !isMuted) {
          a.volume = 0.02;
          const promise = a.play();
          if (promise) {
            promise.then(() => {
              isPlaying = true;
              fadeTo(targetVolume, 700);
            }).catch(() => {
              // Browser autoplay policy might block before interaction
            });
          } else {
            isPlaying = true;
            fadeTo(targetVolume, 700);
          }
        } else {
          a.volume = isMuted ? 0 : targetVolume;
          a.play().then(() => { isPlaying = true; }).catch(() => {});
        }
      } catch (err) {
        console.warn('[BGM] play error:', err);
      }
    },

    pause({ fade = true } = {}) {
      if (!audio || !isPlaying) return;
      if (fade && !audio.muted) {
        fadeTo(0, 500, () => {
          audio.pause();
          isPlaying = false;
        });
      } else {
        clearFade();
        audio.pause();
        isPlaying = false;
      }
    },

    stop() {
      if (!audio) return;
      clearFade();
      audio.pause();
      audio.currentTime = 0;
      isPlaying = false;
    },

    setMuted(muted) {
      if (!audio) ensure();
      if (!audio) return;
      audio.muted = !!muted;
      if (!muted) {
        audio.volume = targetVolume;
      }
    },

    toggleMute() {
      const next = !this.muted;
      this.setMuted(next);
      return next;
    },

    setVolume(vol) {
      targetVolume = Math.max(0, Math.min(1, vol));
      if (audio && !audio.muted) {
        audio.volume = targetVolume;
      }
    },

    duck(durationMs = 1200) {
      if (!audio || !isPlaying || audio.muted) return;
      fadeTo(targetVolume * 0.35, 200, () => {
        setTimeout(() => {
          if (isPlaying && !audio.muted) {
            fadeTo(targetVolume, 500);
          }
        }, durationMs);
      });
    },
  };
}
