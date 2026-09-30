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

export class GameHost {
  constructor({
    levelId = DEFAULT_LEVEL,
    modeId = DEFAULT_MODE,
    config = CONFIG,
    teamSize = CONFIG.teamSize,
    teamLimits = null,
    respawnTime = null,
    friendlyFire = null,
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
    this.botNames = [...BOT_NAMES].sort(() => Math.random() - 0.5);
  }

  teamCount(team) {
    return this.sim.state.players.filter((p) => p.team === team).length;
  }

  humanCount(team) {
    return this.sim.state.players.filter((p) => p.team === team && !p.bot).length;
  }

  addHuman({ name, cos, team: requestedTeam }) {
    if (this.modeId === 'ffa') {
      const maxPlayers = this.teamLimits?.ffa ?? (this.teamSize * 2);
      if (this.sim.state.players.length >= maxPlayers) {
        const bot = this.sim.state.players.find((p) => p.bot);
        if (bot) this.remove(bot.id);
      }
      return addPlayer(this.sim, { name: name || 'Player', team: 'free', bot: false, cos });
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
    return addPlayer(this.sim, { name: name || 'Player', team, bot: false, cos });
  }

  addBot(team = 'red') {
    const assignedTeam = this.modeId === 'ffa' ? 'free' : team;
    const name = this.sim.mode.variant === 'doll' ? 'Doll' : (this.botNames.pop() ?? 'Bot-' + this.sim.nextId);
    const id = addPlayer(this.sim, { name, team: assignedTeam, bot: true, cos: randomCos() });
    // modes may supply their own bot brains (sandbox doll/fighter/ffa)
    this.brains.set(id, this.sim.mode.createBrain?.(id) ?? createBotBrain(id));
    return id;
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
