// GameHost: one running match. Owns the sim, the bot brains, and the input
// map. The browser wraps a GameHost directly for solo play; the server wraps
// one per room for online play — identical game logic in both.

import { CONFIG } from '../core/config.js';
import { clamp, lerp, angleLerp } from '../core/math.js';
import { LEVELS, DEFAULT_LEVEL } from '../content/levels/index.js';
import { MODES, DEFAULT_MODE } from './modes/index.js';
import { createSim, addPlayer, removePlayer, step } from './sim.js';
import { createBotBrain } from './bots.js';
import { BOT_NAMES, randomCos } from '../content/cosmetics.js';
import { assertParticipants, ParticipantType, validDisplayName } from './matchmaking.js';

function adjustBotDifficulty(brain, difficulty = 'medium') {
  if (difficulty === 'medium') return brain;
  const reactionDelay = difficulty === 'easy' ? 0.22 : 0.025;
  let elapsed = reactionDelay;
  let lastInput = null;
  return {
    think(sim, dt) {
      elapsed += dt;
      if (lastInput && elapsed < reactionDelay) return lastInput;
      elapsed = 0;
      const input = { ...brain.think(sim, dt) };
      if (difficulty === 'easy') {
        if (Math.random() < 0.38) input.punch = false;
        if (Math.random() < 0.45) input.throw = false;
        input.dash = input.dash && Math.random() < 0.35;
        const error = (Math.random() - 0.5) * 0.75;
        const c = Math.cos(error), s = Math.sin(error);
        [input.ax, input.az] = [input.ax * c - input.az * s, input.ax * s + input.az * c];
      } else {
        input.run = 1;
        if (!input.dash && Math.random() < 0.015) input.dash = true;
      }
      lastInput = input;
      return input;
    },
  };
}

export class GameHost {
  constructor({
    levelId = DEFAULT_LEVEL,
    modeId = DEFAULT_MODE,
    config = CONFIG,
    teamSize = CONFIG.teamSize,
    teamLimits = null,
    respawnTime = null,
    friendlyFire = null,
    participants = null,
  } = {}) {
    this.levelId = levelId;
    this.modeId = modeId;
    if (respawnTime != null || friendlyFire != null) {
      this.config = {
        ...config,
        player: {
          ...config.player,
          ...(respawnTime != null ? { respawnTime: Number(respawnTime) } : {}),
        },
        rules: {
          ...config.rules,
          ...(friendlyFire != null ? { friendlyFire: Boolean(friendlyFire) } : {}),
        },
      };
    } else {
      this.config = config;
    }

    this.teamSize = teamSize;
    this.teamLimits = teamLimits || (modeId === 'ffa'
      ? { ffa: teamSize * 2 }
      : { red: teamSize, blue: teamSize });

    this.dt = 1 / this.config.tickRate;
    this.sim = createSim({ level: LEVELS[levelId], mode: MODES[modeId], config: this.config });
    this.inputs = new Map();
    this.brains = new Map();
    this.acc = 0;
    this.botSequence = 0;
    this.botNames = [...BOT_NAMES].sort(() => Math.random() - 0.5);
    if (participants) this.spawnParticipants(participants);
  }

  teamCount(team) {
    return this.sim.state.players.filter((p) => p.team === team).length;
  }

  humanCount(team) {
    return this.sim.state.players.filter((p) => p.team === team && !p.bot).length;
  }

  addHuman({ name, displayName = name, userId, participantId, cos, team: requestedTeam, spawnIndex }) {
    const validName = validDisplayName(displayName);
    if (!validName) throw new Error('[MATCH] refusing HUMAN without a valid profile name');
    if (this.modeId === 'ffa') {
      const maxPlayers = this.teamLimits?.ffa ?? (this.teamSize * 2);
      if (this.sim.state.players.length >= maxPlayers) {
        const bot = this.sim.state.players.find((p) => p.bot);
        if (bot) this.remove(bot.id);
      }
      return addPlayer(this.sim, { participantId, type: ParticipantType.HUMAN, userId, displayName: validName, team: 'free', cos, spawnIndex });
    }

    const maxRed = this.teamLimits?.red ?? this.teamSize;
    const maxBlue = this.teamLimits?.blue ?? this.teamSize;

    let team = requestedTeam;
    if (team !== 'red' && team !== 'blue') {
      const redFull = this.teamCount('red') >= maxRed;
      const blueFull = this.teamCount('blue') >= maxBlue;
      if (redFull && !blueFull) team = 'blue';
      else if (blueFull && !redFull) team = 'red';
      else {
        team =
          this.humanCount('red') !== this.humanCount('blue')
            ? this.humanCount('red') < this.humanCount('blue') ? 'red' : 'blue'
            : this.teamCount('red') <= this.teamCount('blue') ? 'red' : 'blue';
      }
    }

    const maxForTeam = team === 'red' ? maxRed : maxBlue;
    if (this.teamCount(team) >= maxForTeam) {
      const bot = this.sim.state.players.find((p) => p.team === team && p.bot);
      if (bot) this.remove(bot.id);
    }
    return addPlayer(this.sim, { participantId, type: ParticipantType.HUMAN, userId, displayName: validName, team, cos, spawnIndex });
  }

  addBot(team = 'red') {
    const assignedTeam = this.modeId === 'ffa' ? 'free' : team;
    const name = this.sim.mode.variant === 'doll' ? 'Doll' : (this.botNames.pop() ?? 'Bot-' + this.sim.nextId);
    const botId = `local-${++this.botSequence}`;
    const id = addPlayer(this.sim, {
      participantId: `local:${botId}`, type: ParticipantType.BOT, botId,
      displayName: name, team: assignedTeam, cos: randomCos(),
    });
    // modes may supply their own bot brains (sandbox doll/fighter/ffa)
    const brain = this.sim.mode.createBrain?.(id) ?? createBotBrain(id);
    this.brains.set(id, adjustBotDifficulty(brain, this.config.rules.botDifficulty));
    return id;
  }

  spawnParticipants(participants) {
    if (this.sim.state.players.length) throw new Error('[MATCH] participants can only spawn into an empty simulation');
    assertParticipants(participants, participants.length);
    for (const participant of participants) {
      const id = addPlayer(this.sim, {
        id: participant.participantId,
        ...participant,
        bot: participant.type === ParticipantType.BOT,
      });
      if (participant.type === ParticipantType.BOT) {
        const brain = this.sim.mode.createBrain?.(id) ?? createBotBrain(id);
        if (!brain?.think) throw new Error(`[MATCH] BOT ${participant.botId} has no AI controller`);
        this.brains.set(id, adjustBotDifficulty(brain, this.config.rules.botDifficulty));
      }
      console.info(`[SPAWN] match participant=${participant.participantId} type=${participant.type} name=${participant.displayName} spawnIndex=${participant.spawnIndex}`);
    }
    if (this.sim.state.players.length !== participants.length) throw new Error('[MATCH] participant/entity count mismatch after spawn');
  }

  fillBots() {
    if (this.modeId === 'ffa') {
      const maxPlayers = this.teamLimits?.ffa ?? (this.teamSize * 2);
      while (this.sim.state.players.length < maxPlayers) this.addBot('free');
      return;
    }
    const maxRed = this.teamLimits?.red ?? this.teamSize;
    const maxBlue = this.teamLimits?.blue ?? this.teamSize;
    while (this.teamCount('red') < maxRed) this.addBot('red');
    while (this.teamCount('blue') < maxBlue) this.addBot('blue');
  }

  remove(id) {
    this.inputs.delete(id);
    this.brains.delete(id);
    removePlayer(this.sim, id);
  }

  // Human leaves an online match: a bot takes over their slot.
  replaceWithBot(id) {
    const p = this.sim.state.players.find((p) => p.id === id);
    if (!p) return;
    const team = p.team;
    this.remove(id);
    if (this.modeId === 'ffa') {
      const maxPlayers = this.teamLimits?.ffa ?? (this.teamSize * 2);
      if (this.sim.state.players.length < maxPlayers) this.addBot('free');
      return;
    }
    const maxForTeam = team === 'red' ? (this.teamLimits?.red ?? this.teamSize) : (this.teamLimits?.blue ?? this.teamSize);
    if (this.teamCount(team) < maxForTeam) this.addBot(team);
  }

  disconnectHuman(id) {
    const player = this.sim.state.players.find((candidate) => candidate.id === id);
    if (!player || player.type !== ParticipantType.HUMAN) return false;
    player.connected = false;
    this.inputs.set(id, { mx: 0, mz: 0, ax: 0, az: 0, run: 0 });
    return true;
  }

  setInput(id, input) {
    this.inputs.set(id, input);
  }

  step(dtWall) {
    this.acc = Math.min(this.acc + dtWall, 0.25);
    while (this.acc >= this.dt) {
      this.prevPlayers = this.sim.state.players.map((p) => ({
        id: p.id,
        state: p.state,
        x: p.x,
        y: p.y,
        z: p.z,
        spd: p.spd,
        face: p.face,
      }));
      this.prevBombs = this.sim.state.bombs.map((b) => ({
        id: b.id,
        x: b.x,
        y: b.y,
        z: b.z,
      }));
      for (const [id, brain] of this.brains) this.inputs.set(id, brain.think(this.sim, this.dt));
      step(this.sim, this.inputs, this.dt);
      this.acc -= this.dt;
    }
  }

  // Returns smoothly interpolated visual view between physics ticks (eliminates 60Hz judder on all displays)
  view() {
    const s = this.sim.state;
    if (!this.prevPlayers || this.prevPlayers.length === 0) return s;
    const t = clamp(this.acc / this.dt, 0, 1);
    if (t < 0.001) return s;

    const prevPMap = new Map(this.prevPlayers.map((p) => [p.id, p]));
    const interpPlayers = s.players.map((curr) => {
      const prev = prevPMap.get(curr.id);
      if (!prev || prev.state !== curr.state) return curr;
      if (Math.hypot(curr.x - prev.x, curr.z - prev.z) > 2.5) return curr;
      return {
        ...curr,
        x: lerp(prev.x, curr.x, t),
        y: lerp(prev.y, curr.y, t),
        z: lerp(prev.z, curr.z, t),
        spd: lerp(prev.spd, curr.spd, t),
        face: angleLerp(prev.face, curr.face, t),
      };
    });

    const prevBMap = new Map(this.prevBombs ? this.prevBombs.map((b) => [b.id, b]) : []);
    const interpBombs = s.bombs.map((curr) => {
      const prev = prevBMap.get(curr.id);
      if (!prev) return curr;
      return {
        ...curr,
        x: lerp(prev.x, curr.x, t),
        y: lerp(prev.y, curr.y, t),
        z: lerp(prev.z, curr.z, t),
      };
    });

    return {
      ...s,
      players: interpPlayers,
      bombs: interpBombs,
    };
  }

  drainEvents() {
    const out = this.sim.events;
    this.sim.events = [];
    return out;
  }
}
