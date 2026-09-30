// Procedural sound effects via WebAudio — no audio files, works offline.
// Each effect is synthesized from oscillators + filtered noise. Spatial
// falloff comes from a simple distance gain passed by the caller.

export function createSfx() {
  let ctx = null;
  let master = null;
  let muted = typeof localStorage !== 'undefined' && localStorage.getItem('blast.muted') === '1';
  let yeetBuffer = null;
  let yeetLoading = false;

  function loadYeet() {
    if (yeetBuffer || yeetLoading || !ctx) return;
    yeetLoading = true;
    fetch('./audio/yeet_scream.mp3')
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.arrayBuffer();
      })
      .then((buf) => ctx.decodeAudioData(buf))
      .then((decoded) => {
        yeetBuffer = decoded;
      })
      .catch(() => {
        yeetLoading = false;
      });
  }

  function ensure() {
    if (!ctx) {
      const AudioCtx = typeof window !== 'undefined' ? (window.AudioContext || window.webkitAudioContext) : null;
      if (AudioCtx) {
        ctx = new AudioCtx();
        master = ctx.createGain();
        master.gain.value = muted ? 0 : 0.5;
        master.connect(ctx.destination);
      }
    }
    if (ctx && ctx.state === 'suspended') ctx.resume();
    if (ctx) loadYeet();
    return ctx;
  }

  function env(node, t0, peak, dur) {
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(Math.max(peak, 0.001), t0 + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    node.connect(g);
    g.connect(master);
    return g;
  }

  function osc(type, f0, f1, dur, peak, delay = 0) {
    const t0 = ctx.currentTime + delay;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, t0);
    o.frequency.exponentialRampToValueAtTime(Math.max(f1, 1), t0 + dur);
    env(o, t0, peak, dur);
    o.start(t0);
    o.stop(t0 + dur + 0.05);
  }

  function noise(dur, type, f0, f1, peak, delay = 0) {
    const t0 = ctx.currentTime + delay;
    const len = Math.ceil(ctx.sampleRate * dur);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const filter = ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.setValueAtTime(f0, t0);
    filter.frequency.exponentialRampToValueAtTime(Math.max(f1, 10), t0 + dur);
    src.connect(filter);
    env(filter, t0, peak, dur);
    src.start(t0);
  }

  const fx = {
    explode(v = 1) {
      noise(0.65, 'lowpass', 1100, 90, 0.9 * v);
      osc('sine', 75, 26, 0.5, 0.8 * v);
      noise(0.08, 'highpass', 2000, 4000, 0.25 * v);
    },
    throw(v = 1) { noise(0.2, 'bandpass', 500, 2600, 0.22 * v); },
    bounce(v = 1) { noise(0.06, 'lowpass', 700, 250, 0.12 * v); },
    grab() { osc('triangle', 500, 780, 0.1, 0.25); },
    flagTaken() {
      [523, 659, 784].forEach((f, i) => osc('triangle', f, f, 0.13, 0.22, i * 0.07));
    },
    flagDrop() { osc('triangle', 392, 300, 0.2, 0.22); },
    flagReturn() {
      [330, 523].forEach((f, i) => osc('triangle', f, f, 0.12, 0.2, i * 0.08));
    },
    score() {
      [523, 659, 784, 1046].forEach((f, i) => osc('square', f, f, 0.14, 0.12, i * 0.09));
      noise(0.5, 'highpass', 3000, 6000, 0.08, 0.1);
    },
    ko() { osc('sawtooth', 260, 68, 0.42, 0.32); },
    hurt() { osc('sine', 160, 90, 0.12, 0.3); noise(0.06, 'lowpass', 500, 200, 0.2); },
    punch(v = 1) { noise(0.09, 'bandpass', 900, 2800, 0.16 * v); }, // whoosh
    punchHit(v = 1) {
      noise(0.08, 'lowpass', 780, 180, 0.38 * v); // thwack
      osc('sine', 160, 70, 0.12, 0.35 * v); // heavy body impact
      osc('triangle', 340, 130, 0.08, 0.22 * v); // slap/crack
    },
    jump() { osc('triangle', 320, 520, 0.09, 0.1); },
    dash(v = 1) {
      noise(0.16, 'bandpass', 700, 3200, 0.28 * v);
      osc('sine', 360, 140, 0.14, 0.22 * v);
    },
    grabPlayer() { osc('triangle', 420, 300, 0.12, 0.22); },
    playerThrow(v = 1) {
      noise(0.28, 'bandpass', 350, 2400, 0.35 * v);
      osc('triangle', 340, 160, 0.22, 0.28 * v);

      if (!ctx || !yeetBuffer) return;
      try {
        const src = ctx.createBufferSource();
        src.buffer = yeetBuffer;
        // Subtle pitch variance around the custom cartoon pitch
        src.playbackRate.value = 1.0 + (Math.random() - 0.5) * 0.06;

        const g = ctx.createGain();
        const t0 = ctx.currentTime;
        const dur = yeetBuffer.duration || 2.6;

        // "mais baixo" - comfortable, balanced cartoon scream level
        const initialGain = Math.max(0.015, Math.min(0.4, 0.35 * v));

        // "que vá diminuindo com a distância":
        // Volume fades smoothly as the character flies through the air into the distance
        g.gain.setValueAtTime(initialGain, t0);
        g.gain.setValueAtTime(initialGain, t0 + 0.3); // sustain opening yell
        g.gain.exponentialRampToValueAtTime(Math.max(0.0005, initialGain * 0.07), t0 + dur - 0.25);
        g.gain.linearRampToValueAtTime(0.00001, t0 + dur);

        src.connect(g);
        g.connect(master);
        src.start(t0);
        src.stop(t0 + dur + 0.1);
      } catch {
        /* audio failsafe */
      }
    },
    spawn() { osc('triangle', 600, 900, 0.1, 0.12); },
    tick() { osc('square', 700, 700, 0.07, 0.14); },
    go() { osc('square', 1040, 1040, 0.18, 0.16); },
    denied() { osc('square', 180, 150, 0.12, 0.18); },
    win() {
      [523, 659, 784, 1046, 784, 1046].forEach((f, i) => osc('triangle', f, f, 0.16, 0.16, i * 0.11));
    },
    lose() { [392, 330, 262].forEach((f, i) => osc('triangle', f, f, 0.22, 0.16, i * 0.16)); },
    click() { osc('square', 1500, 1200, 0.04, 0.08); },
    powerup() { [660, 880].forEach((f, i) => osc('triangle', f, f * 1.2, 0.09, 0.2, i * 0.06)); },
    wearOff() { osc('triangle', 700, 420, 0.16, 0.14); },
    shieldHit(v = 1) { osc('sine', 900, 500, 0.12, 0.2 * v); noise(0.05, 'highpass', 2500, 4500, 0.1 * v); },
    shieldDown(v = 1) { osc('sawtooth', 500, 120, 0.3, 0.25 * v); noise(0.2, 'highpass', 1800, 4000, 0.15 * v); },
    freeze(v = 1) { [1320, 1760].forEach((f, i) => osc('sine', f, f * 0.8, 0.14, 0.14 * v, i * 0.05)); },
    shatter(v = 1) { noise(0.3, 'highpass', 3000, 7000, 0.35 * v); osc('sine', 1500, 400, 0.12, 0.12 * v); },
    curse() { osc('sawtooth', 130, 65, 0.6, 0.3); osc('sine', 98, 60, 0.6, 0.2); },
    mineArm(v = 1) { osc('square', 950, 950, 0.05, 0.12 * v); },
    stick(v = 1) { noise(0.09, 'lowpass', 900, 300, 0.2 * v); },
  };

  return {
    get muted() { return muted; },
    unlock() { ensure(); },
    toggle() {
      muted = !muted;
      localStorage.setItem('blast.muted', muted ? '1' : '0');
      if (master) master.gain.value = muted ? 0 : 0.5;
      return muted;
    },
    play(name, vol = 1) {
      if (muted) return;
      try {
        ensure();
        fx[name]?.(vol);
      } catch { /* audio is never worth crashing over */ }
    },
  };
}
