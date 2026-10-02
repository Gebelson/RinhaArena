// Unified input. Produces one input object per frame regardless of device:
//   { mx, mz, ax, az, ad, throw, grab, punch, jump, aiming }
//
// Keyboard/mouse: WASD/arrows move, mouse aims (ray to ground),
//   LMB throw (bomb — or the flag/player/bomb you're holding),
//   RMB punch, E grab/release, Space jump.
// Touch: virtual joystick (left half) + BombSquad-style button diamond
//   (bomb with drag-to-aim, punch, grab, jump), built in touch.js.
//
// Button presses are held as short pulses (not per-frame latches) so a tap
// is never lost between fixed sim ticks or 30Hz network input sends.

import { clamp, norm2 } from '../core/math.js';
import { CONFIG } from '../core/config.js';
import { createTouchControls } from './touch.js';
import { getSettings } from '../settings.js';

const PULSE = 0.12; // seconds a tap stays visible to the sim

export function createInput({ uiRoot, isTouch }) {
  const keys = new Set();
  const mouse = { x: innerWidth / 2, y: innerHeight / 2, seen: false };
  let throwPulse = 0;
  let grabPulse = 0;
  let punchPulse = 0;
  let jumpPulse = 0;
  let dashPulse = 0;

  const now = () => performance.now() / 1000;

  const onKeyDown = (e) => {
    if (e.repeat) return;
    if (e.target && /INPUT|TEXTAREA/.test(e.target.tagName)) return;
    keys.add(e.code);
    const controls = getSettings().controls;
    if (e.code === controls.jump) {
      jumpPulse = now() + PULSE;
      e.preventDefault();
    }
    if (e.code === controls.grab) grabPulse = now() + PULSE;
    if (e.code === controls.punch) punchPulse = now() + PULSE;
    if (e.code === controls.dash) {
      dashPulse = now() + PULSE;
    }
  };
  const onKeyUp = (e) => keys.delete(e.code);
  const onMouseMove = (e) => {
    mouse.x = e.clientX;
    mouse.y = e.clientY;
    mouse.seen = true;
  };
  const onMouseDown = (e) => {
    if (e.target.closest?.('.hud-btn, .game-chat, .menu, .touch')) return;
    if (e.button === 0) { // LMB: bater / socar (e arremessar o que estiver segurando)
      punchPulse = now() + PULSE;
      throwPulse = now() + PULSE;
    }
    if (e.button === 2) { // RMB: agarrar adversário ou bandeira
      grabPulse = now() + PULSE;
    }
  };
  const onCtx = (e) => e.preventDefault();

  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('mousemove', onMouseMove);
  window.addEventListener('mousedown', onMouseDown);
  window.addEventListener('contextmenu', onCtx);

  const touch = isTouch ? createTouchControls(uiRoot) : null;

  const key = (c) => (keys.has(c) ? 1 : 0);

  return {
    touch,

    sample({ myPos, screenToGround }) {
      // movement (screen up = world -z with our fixed camera)
      const controls = getSettings().controls;
      let mx = key(controls.right) - key(controls.left);
      let mz = key(controls.down) - key(controls.up);
      const keyboardMove = mx !== 0 || mz !== 0;
      if (touch?.joy.active) {
        mx += touch.joy.x;
        mz += touch.joy.z;
      }
      const m = Math.hypot(mx, mz);
      if (m > 1) { mx /= m; mz /= m; }

      // run value: keys always run (Shift is now dash);
      // the touch stick walks on small deflection, runs pushed to the rim
      let run = 0;
      if (keyboardMove) run = 1;
      else if (touch?.joy.active) run = clamp((m - 0.5) / 0.4, 0, 1);

      // aim: direction + distance. The distance maps to THROW POWER in the
      // sim (BombSquad throws are power-based, not land-exactly-here).
      const AIM_MIN = CONFIG.bomb.aimRangeMin;
      const AIM_MAX = CONFIG.bomb.aimRangeMax;
      let ax = 0, az = 0, ad = 7, aiming = false, aimPoint = null;
      if (touch) {
        const t = touch.consumeThrow(); // {aimX, aimZ, len} or null
        if (t) {
          throwPulse = now() + PULSE;
          if (t.len > 0.01) {
            const n = norm2(t.aimX, t.aimZ);
            ax = n.x; az = n.z;
            ad = clamp(3 + t.len * (AIM_MAX - 3), AIM_MIN, AIM_MAX);
          }
        } else if (touch.aim.active && (touch.aim.x || touch.aim.z)) {
          const n = norm2(touch.aim.x, touch.aim.z);
          ax = n.x; az = n.z;
          ad = clamp(3 + touch.aim.len * (AIM_MAX - 3), AIM_MIN, AIM_MAX);
          aiming = true;
        }
        if (touch.consumeGrab()) grabPulse = now() + PULSE;
        if (touch.consumePunch()) punchPulse = now() + PULSE;
        if (touch.consumeJump()) jumpPulse = now() + PULSE;
        if (aiming && myPos) aimPoint = { x: myPos.x + ax * ad, z: myPos.z + az * ad };
      } else if (myPos && screenToGround && mouse.seen) {
        const gp = screenToGround(mouse.x, mouse.y);
        if (gp) {
          const dx = gp.x - myPos.x;
          const dz = gp.z - myPos.z;
          const len = Math.hypot(dx, dz);
          if (len > 0.2) {
            ax = dx / len;
            az = dz / len;
            ad = clamp(len, AIM_MIN, AIM_MAX);
          }
          aimPoint = { x: myPos.x + ax * ad, z: myPos.z + az * ad };
        }
      }

      const t = now();
      return {
        input: {
          mx, mz, ax, az, ad, run,
          throw: t < throwPulse,
          grab: t < grabPulse,
          punch: t < punchPulse,
          jump: t < jumpPulse,
          dash: t < dashPulse,
          aiming,
        },
        aimPoint,
        aiming,
      };
    },

    dispose() {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('contextmenu', onCtx);
      touch?.dispose();
    },
  };
}
