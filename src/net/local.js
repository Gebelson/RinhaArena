// Local transport: runs a GameHost right in the page — solo vs bots with
// zero latency and no server. Presents the exact same interface as the
// online transport (net/ws.js), so main.js can't tell them apart.

import { GameHost } from '../game/host.js';

export function createLocalGame({ profile, levelId, modeId, config, teamSize, teamLimits, respawnTime, friendlyFire } = {}) {
  const host = new GameHost({
    levelId,
    modeId,
    ...(config && { config }),
    ...(teamSize && { teamSize }),
    ...(teamLimits && { teamLimits }),
    ...(respawnTime != null && { respawnTime }),
    ...(friendlyFire != null && { friendlyFire }),
  });
  const myId = host.addHuman({ name: profile.name, cos: { ...profile.cos } });
  host.fillBots();
  const chatMessages = [];

  return {
    kind: 'local',
    myId,
    levelId: host.levelId,
    modeId: host.modeId,
    setInput(input) { host.setInput(myId, input); },
    update(dt) { host.step(dt); },
    view() { return host.view(); },
    drainEvents() { return host.drainEvents(); },
    sendChat(text) {
      const message = String(text || '').trim().slice(0, 100);
      if (message) chatMessages.push({ displayName: profile.name, text: message, own: true });
    },
    drainChatMessages() { return chatMessages.splice(0, chatMessages.length); },
    // local-only debug surface (the physics-lab panel drives resets etc.)
    debug: { host, sim: host.sim },
    dispose() {},
  };
}
