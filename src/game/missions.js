const MISSION_COUNT = 10;

const TEMPLATES = [
  { stat: 'matches', text: (n) => `Jogue ${n} partidas`, targets: [2, 3, 5] },
  { stat: 'wins', text: (n) => `Vença ${n} partidas`, targets: [1, 2, 3] },
  { stat: 'rankedMatches', text: (n) => `Jogue ${n} partidas ranqueadas`, targets: [1, 2, 4] },
  { stat: 'rankedWins', text: (n) => `Vença ${n} partidas ranqueadas`, targets: [1, 2] },
  { stat: 'normalMatches', text: (n) => `Jogue ${n} partidas Normal Game`, targets: [1, 3, 5] },
  { stat: 'ctfMatches', text: (n) => `Jogue ${n} partidas Capture the Flag`, targets: [1, 3, 4] },
  { stat: 'deathmatchMatches', text: (n) => `Jogue ${n} partidas Death Match`, targets: [1, 3, 4] },
  { stat: 'ffaMatches', text: (n) => `Jogue ${n} partidas Todos contra Todos`, targets: [1, 2, 3] },
  { stat: 'goldEarned', text: (n) => `Ganhe ${n} Gold em partidas`, targets: [100, 200, 400] },
  { stat: 'draws', text: (n) => `Complete ${n} partidas sem abandonar`, targets: [2, 4, 6] },
];

const safeStats = (stats = {}) => Object.fromEntries(
  ['matches', 'wins', 'rankedMatches', 'rankedWins', 'normalMatches', 'ctfMatches', 'deathmatchMatches', 'ffaMatches', 'goldEarned', 'draws']
    .map((key) => [key, Math.max(0, Number(stats[key]) || 0)]),
);

function makeMission(stats, usedStats = []) {
  const choices = TEMPLATES.filter((template) => !usedStats.includes(template.stat));
  const template = (choices.length ? choices : TEMPLATES)[Math.floor(Math.random() * (choices.length || TEMPLATES.length))];
  const target = template.targets[Math.floor(Math.random() * template.targets.length)];
  const difficulty = template.targets.indexOf(target) + 1;
  return {
    id: crypto.randomUUID(), stat: template.stat, title: template.text(target), target,
    start: stats[template.stat] || 0,
    gold: 35 + difficulty * 20,
    xp: 15 + difficulty * 10,
  };
}

export function ensureMissions(profile) {
  profile.missionStats = safeStats(profile.missionStats);
  profile.missions = Array.isArray(profile.missions) ? profile.missions.filter((mission) => mission?.id && mission?.stat) : [];
  while (profile.missions.length < MISSION_COUNT) {
    profile.missions.push(makeMission(profile.missionStats, profile.missions.map((mission) => mission.stat)));
  }
  profile.missions = profile.missions.slice(0, MISSION_COUNT);
  return profile.missions;
}

export function missionProgress(profile, mission) {
  return Math.min(mission.target, Math.max(0, (profile.missionStats?.[mission.stat] || 0) - mission.start));
}

export function recordMissionMatch(profile, { won, draw, ranked, modeId, gold }) {
  ensureMissions(profile);
  const stats = profile.missionStats;
  stats.matches += 1;
  stats.draws += 1;
  stats.goldEarned += Math.max(0, Number(gold) || 0);
  if (won) stats.wins += 1;
  if (ranked) {
    stats.rankedMatches += 1;
    if (won) stats.rankedWins += 1;
  } else stats.normalMatches += 1;
  if (modeId === 'ctf') stats.ctfMatches += 1;
  if (modeId === 'deathmatch') stats.deathmatchMatches += 1;
  if (modeId === 'ffa') stats.ffaMatches += 1;
}

export function claimMission(profile, missionId) {
  ensureMissions(profile);
  const index = profile.missions.findIndex((mission) => mission.id === missionId);
  if (index < 0) return null;
  const mission = profile.missions[index];
  if (missionProgress(profile, mission) < mission.target) return null;
  profile.gold = Math.max(0, Number(profile.gold) || 0) + mission.gold;
  profile.rankXp = Math.max(0, Number(profile.rankXp) || 0) + mission.xp;
  const reward = { gold: mission.gold, xp: mission.xp };
  profile.missions[index] = makeMission(profile.missionStats, profile.missions.map((item) => item.stat));
  return reward;
}
