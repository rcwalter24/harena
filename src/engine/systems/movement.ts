import { secondsToTicks } from '../config.ts';
import { angleDiff, clamp, DEG, length, normalizeAngle } from '../dmath.ts';
import { resolveCircleWalls } from '../geometry.ts';
import type { ActionInput, GameState } from '../types.ts';

export function applyWeaponSwitches(state: GameState, actions: readonly ActionInput[]): void {
  const switchTicks = secondsToTicks(state.config.player.switchTime, state.config);
  for (const p of state.players) {
    if (!p.alive) continue;
    const want = actions[p.id].weapon;
    if (!want || want === p.weapon) continue;
    if (want === 'gun' && !p.hasGun) continue;
    p.weapon = want;
    p.switchTimer = switchTicks;
    state.events.push({ type: 'switch', tick: state.tick, playerId: p.id, weapon: want });
  }
}

export function applyTurning(state: GameState, actions: readonly ActionInput[]): void {
  const maxTurn = (state.config.player.turnRateDegrees * DEG) / state.config.tickRate;
  for (const p of state.players) {
    if (!p.alive) continue;
    const aim = actions[p.id].aim;
    if (aim === null) continue;
    const diff = angleDiff(aim, p.facing);
    p.facing = normalizeAngle(p.facing + clamp(diff, -maxTurn, maxTurn));
  }
}

export function applyMovement(state: GameState, actions: readonly ActionInput[]): void {
  const { config, map } = state;
  const r = config.player.radius;
  const dt = 1 / config.tickRate;
  const prev = state.players.map((p) => ({ x: p.x, y: p.y }));

  for (const p of state.players) {
    if (!p.alive) continue;
    const a = actions[p.id];
    let mx = a.moveX;
    let my = a.moveY;
    const len = length(mx, my);
    if (len > 1) {
      mx /= len;
      my /= len;
    }
    const speed = p.weapon === 'gun' ? config.player.speedGun : config.player.speedKnife;
    const pos = { x: p.x + mx * speed * dt, y: p.y + my * speed * dt };
    resolveCircleWalls(pos, r, map.walls, map.width, map.height);
    p.x = pos.x;
    p.y = pos.y;
  }

  resolvePlayerOverlaps(state);

  for (const p of state.players) {
    if (!p.alive) {
      p.vx = 0;
      p.vy = 0;
      continue;
    }
    p.vx = (p.x - prev[p.id].x) * config.tickRate;
    p.vy = (p.y - prev[p.id].y) * config.tickRate;
  }
}

/** Push overlapping living players apart (equal split), then re-resolve walls. */
export function resolvePlayerOverlaps(state: GameState): void {
  const { config, map } = state;
  const r = config.player.radius;
  const minDist = 2 * r;
  const alive = state.players.filter((p) => p.alive);
  for (let pass = 0; pass < 4; pass++) {
    let any = false;
    for (let i = 0; i < alive.length; i++) {
      for (let j = i + 1; j < alive.length; j++) {
        const a = alive[i];
        const b = alive[j];
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let d = length(dx, dy);
        if (d >= minDist) continue;
        any = true;
        if (d === 0) {
          // Perfectly stacked: separate along x, lower id to the left.
          dx = 1;
          dy = 0;
          d = 1;
        }
        const push = (minDist - d) / 2;
        const nx = dx / d;
        const ny = dy / d;
        const pa = resolveCircleWalls({ x: a.x - nx * push, y: a.y - ny * push }, r, map.walls, map.width, map.height);
        const pb = resolveCircleWalls({ x: b.x + nx * push, y: b.y + ny * push }, r, map.walls, map.width, map.height);
        a.x = pa.x;
        a.y = pa.y;
        b.x = pb.x;
        b.y = pb.y;
      }
    }
    if (!any) break;
  }
}
