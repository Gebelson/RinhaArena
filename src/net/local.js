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
  const controlEvents = [];

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
    drainControlEvents() { return controlEvents.splice(0, controlEvents.length); },
    sendEmote(emote) {
      const value = String(emote || '').slice(0, 40);
      if (value && (profile.cos?.ownedEmotes || []).includes(value)) controlEvents.push({ type: 'emote', participantId: myId, emote: value });
    },
    requestSurrender() {
      const me = host.sim.state.players.find((player) => player.id === myId);
      if (!me || host.modeId === 'ffa') return false;
      controlEvents.push({ type: 'surrender-update', team: me.team, deadlineAt: Date.now() + 20_000, votes: [[profile.playerId, true]] });
      host.forfeitTeam(me.team);
      queueMicrotask(() => controlEvents.push({ type: 'surrender-result', team: me.team, approved: true, yes: 1, total: 1 }));
      return true;
    },
    voteSurrender() {},
    abandonMatch() {
      return Promise.resolve({ matchId: `local:${Date.now()}`, mode: 'bots', ranked: false, ended: true, rankPenalty: 0 });
    },
    // local-only debug surface (the physics-lab panel drives resets etc.)
    debug: { host, sim: host.sim },
    dispose() {},
  };
}
