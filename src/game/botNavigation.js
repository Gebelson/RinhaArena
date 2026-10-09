// Shared navigation for all competitive bots. Collision checks read the live
// level solids, including moving walls, carts and rotating pillars.
import { norm2 } from '../core/math.js';

export function clearBotPath(sim, me, to) {
  const radius = sim.mats.player.radius + 0.09;
  if ([me, to].some((point) => Math.abs(point.x) > sim.level.bounds.w / 2 - radius - 0.15 || Math.abs(point.z) > sim.level.bounds.d / 2 - radius - 0.15)) return false;
  // Sweep the full segment against expanded boxes. Point samples can miss
  // a corner between probes and direct a bot into a wall repeatedly.
  for (const box of sim.level.solids) {
    if (box.h <= 0.08) continue;
    let enter = 0, leave = 1;
    for (const [axis, size] of [['x', 'w'], ['z', 'd']]) {
      const delta = to[axis] - me[axis];
      const min = box[axis] - box[size] / 2 - radius;
      const max = box[axis] + box[size] / 2 + radius;
      if (Math.abs(delta) < 0.00001) {
        if (me[axis] < min || me[axis] > max) { enter = 2; break; }
      } else {
        const a = (min - me[axis]) / delta, b = (max - me[axis]) / delta;
        enter = Math.max(enter, Math.min(a, b)); leave = Math.min(leave, Math.max(a, b));
      }
    }
    if (enter <= leave) return false;
  }
  return true;
}

function routeAround(sim, me, target) {
  // Search a one-meter grid only when a direct route is blocked. Connections
  // also test the segment, so diagonal paths cannot cut through corners.
  const key = (x, z) => `${x},${z}`;
  const nearestCell = (point) => {
    let best = null, distance = Infinity;
    for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) {
      const node = { x: Math.round(point.x) + dx, z: Math.round(point.z) + dz };
      const d = Math.hypot(point.x - node.x, point.z - node.z);
      if (d < distance && clearBotPath(sim, node, node)) { best = node; distance = d; }
    }
    return best;
  };
  const start = nearestCell(me), goal = nearestCell(target);
  if (!start || !goal) return [];
  const visited = new Map([[key(start.x, start.z), start]]);
  const queue = [start];
  let found;
  for (let i = 0; i < queue.length && i < 3600; i++) {
    const current = queue[i];
    if (current.x === goal.x && current.z === goal.z) { found = current; break; }
    const directions = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
    // Pursue the goal first while retaining all escape directions.
    directions.sort((a, b) => Math.hypot(current.x + a[0] - goal.x, current.z + a[1] - goal.z) - Math.hypot(current.x + b[0] - goal.x, current.z + b[1] - goal.z));
    for (const [dx, dz] of directions) {
      const next = { x: current.x + dx, z: current.z + dz, previous: current };
      const id = key(next.x, next.z);
      if (visited.has(id)) continue;
      if (!clearBotPath(sim, current, next)) continue;
      visited.set(id, next);
      queue.push(next);
    }
  }
  const route = [];
  while (found?.previous) { route.push({ x: found.x, z: found.z }); found = found.previous; }
  return route.reverse();
}

export function steerBot(sim, me, target, memory, dt, desired = norm2(target.x - me.x, target.z - me.z)) {
  memory.navigation ??= { wait: 0, path: [], observed: { x: me.x, z: me.z }, stuck: 0 };
  const nav = memory.navigation;
  nav.wait = Math.max(0, nav.wait - dt);
  nav.stuck += dt;
  if (Math.hypot(me.x - nav.observed.x, me.z - nav.observed.z) > 0.35) {
    nav.observed = { x: me.x, z: me.z }; nav.stuck = 0;
  }
  if (Math.hypot(target.x - me.x, target.z - me.z) < 0.6) return { x: 0, z: 0 };
  while (nav.path.length && Math.hypot(nav.path[0].x - me.x, nav.path[0].z - me.z) < 0.5) nav.path.shift();
  const direction = norm2(desired.x, desired.z);
  const ahead = { x: me.x + direction.x * 1.8, z: me.z + direction.z * 1.8 };
  const blocked = !clearBotPath(sim, me, ahead);
  const invalidWaypoint = nav.path.length && !clearBotPath(sim, me, nav.path[0]);
  if (invalidWaypoint) nav.path = [];
  if (!nav.wait && (blocked || nav.stuck > 0.75 || nav.path.length)) {
    nav.path = routeAround(sim, me, target);
    nav.wait = 0.8;
    nav.stuck = 0;
  }
  if (nav.path.length) {
    // Skip nodes only when the complete shortcut is clear right now.
    while (nav.path.length > 1 && clearBotPath(sim, me, nav.path[1])) nav.path.shift();
    return norm2(nav.path[0].x - me.x, nav.path[0].z - me.z);
  }
  if (!blocked) return direction;
  for (const angle of [Math.PI / 2, -Math.PI / 2, Math.PI, Math.PI / 4, -Math.PI / 4]) {
    const c = Math.cos(angle), s = Math.sin(angle);
    const escape = { x: direction.x * c - direction.z * s, z: direction.x * s + direction.z * c };
    if (clearBotPath(sim, me, { x: me.x + escape.x * 1.8, z: me.z + escape.z * 1.8 })) return escape;
  }
  return { x: 0, z: 0 };
}
