// Shared wire protocol helpers (imported by both browser and Node server).
// Messages are JSON. packState() rounds floats to shrink snapshots — the
// full dynamic state of a 2v2 match packs to roughly 2KB.

const r2 = (n) => Math.round((n ?? 0) * 100) / 100;

export function packState(st) {
  return {
    tick: st.tick,
    phase: st.phase,
    countdown: r2(st.countdown),
    timeLeft: r2(st.timeLeft),
    overT: r2(st.overT),
    scores: st.scores,
    ffaScores: st.ffaScores ?? null,
    modeId: st.modeId ?? null,
    winner: st.winner,
    lab: st.lab ?? null,
    players: st.players.map((p) => ({
      id: p.id, participantId: p.participantId, matchId: p.matchId, type: p.type,
      userId: p.userId ?? null, botId: p.botId ?? null,
      displayName: p.displayName, name: p.displayName,
      characterId: p.characterId, spawnIndex: p.spawnIndex,
      connected: p.connected !== false, team: p.team, bot: p.type === 'BOT', cos: p.cos,
      x: r2(p.x), z: r2(p.z), y: r2(p.y),
      vx: r2(p.vx), vz: r2(p.vz), face: r2(p.face), spd: r2(p.spd),
      hp: Math.round(p.hp), state: p.state,
      respawn: r2(p.respawn), invuln: r2(p.invuln), knockT: r2(p.knockT),
      carryFlag: p.carryFlag, heldBomb: p.heldBomb,
      heldPlayer: p.heldPlayer, heldBy: p.heldBy,
      throwT: r2(p.throwT), punchT: r2(p.punchT), punchArm: p.punchArm,
      punchedT: r2(p.punchedT),
      shieldHp: Math.round(p.shieldHp), glovesT: r2(p.glovesT),
      frozenT: r2(p.frozenT), curseT: r2(p.curseT),
      mines: p.mines, bombKind: p.bombKind,
    })),
    bombs: st.bombs.map((b) => ({
      id: b.id, kind: b.kind, x: r2(b.x), z: r2(b.z), y: r2(b.y),
      vx: r2(b.vx), vz: r2(b.vz), holder: b.holder, stuckTo: b.stuckTo,
      fuse: b.fuse == null ? null : r2(b.fuse), arm: r2(b.arm),
    })),
    powerups: (st.powerups ?? []).map((u) => ({
      id: u.id, kind: u.kind,
      x: r2(u.x), z: r2(u.z), y: r2(u.y), life: r2(u.life),
    })),
    flags: st.flags
      ? Object.fromEntries(Object.entries(st.flags).map(([team, f]) => [team, {
          team, st: f.st, x: r2(f.x), z: r2(f.z), y: r2(f.y),
          carrier: f.carrier, idle: r2(f.idle), cd: r2(f.cd),
        }]))
      : null,
    interactives: (st.interactives ?? []).map((o) => ({ id: o.id, type: o.type, x: r2(o.x), z: r2(o.z), angle: r2(o.angle), active: o.active, warning: o.warning })),
  };
}
