import { secondsToTicks } from '../config.ts';
import { direction, length } from '../dmath.ts';
import { segmentRectEntry, type SegmentEntry } from '../geometry.ts';
import { solidRects, type ActionInput, type Cloud, type GameState } from '../types.ts';
import { applyDamage } from './combat.ts';

/**
 * Smoke and gas grenades. A throw launches the grenade from the thrower's centre along their
 * facing, fast enough to slide exactly the requested distance while it slows down at a constant
 * rate. It bounces off walls (losing speed), is not stopped by players, and when it stops it
 * turns into a cloud: smoke works like a bush, gas hurts and slows everyone inside.
 */

/** Throw requested grenades (any weapon in hand, even while switching). */
export function startThrows(state: GameState, actions: readonly ActionInput[]): void {
  const { config } = state;
  const { throwing } = config;
  for (const p of state.players) {
    const a = actions[p.id];
    if (!p.alive || !a.throwKind || p.throwCooldown > 0) continue;
    if (a.throwKind === 'smoke' ? p.smokes <= 0 : p.gases <= 0) continue;
    if (a.throwKind === 'smoke') p.smokes--;
    else p.gases--;
    p.throwCooldown = secondsToTicks(throwing.cooldown, config);
    p.invulnerableTimer = 0;
    p.noiseTimer = secondsToTicks(config.bushes.noiseRevealTime, config);
    const distance = Math.min(throwing.maxDistance, Math.max(0, a.throwDistance ?? throwing.maxDistance));
    const speed = Math.sqrt(2 * throwing.deceleration * distance);
    const f = direction(p.facing);
    const t = { id: state.nextEntityId++, ownerId: p.id, kind: a.throwKind, x: p.x, y: p.y, vx: f.x * speed, vy: f.y * speed };
    state.throwables.push(t);
    state.events.push({ type: 'throw', tick: state.tick, playerId: p.id, throwableId: t.id, kind: t.kind });
  }
}

function firstWall(state: GameState, x: number, y: number, dx: number, dy: number): SegmentEntry | null {
  let best: SegmentEntry | null = null;
  for (const r of solidRects(state.map)) {
    const hit = segmentRectEntry(x, y, dx, dy, r, state.config.throwing.radius);
    if (hit && (!best || hit.t < best.t)) best = hit;
  }
  return best;
}

/** Slide every thrown grenade for one tick; the ones that stop become clouds. */
export function updateThrowables(state: GameState): void {
  const { config } = state;
  const { throwing } = config;
  const dt = 1 / config.tickRate;
  const moving = [];
  for (const g of state.throwables) {
    let speed = length(g.vx, g.vy);
    let ux = speed > 0 ? g.vx / speed : 0;
    let uy = speed > 0 ? g.vy / speed : 0;
    const slowed = speed - throwing.deceleration * dt;
    // Distance covered this tick under constant deceleration (exactly up to the stopping point).
    let travel = slowed > 0 ? ((speed + slowed) / 2) * dt : (speed * speed) / (2 * throwing.deceleration);
    speed = Math.max(0, slowed);
    for (let bounces = 0; travel > 1e-9 && bounces < 4; bounces++) {
      const hit = firstWall(state, g.x, g.y, ux * travel, uy * travel);
      if (!hit) {
        g.x += ux * travel;
        g.y += uy * travel;
        break;
      }
      g.x += ux * travel * hit.t;
      g.y += uy * travel * hit.t;
      travel *= (1 - hit.t) * throwing.bounce;
      speed *= throwing.bounce;
      if (hit.axis === 'x') ux = -ux;
      else uy = -uy;
    }
    g.vx = ux * speed;
    g.vy = uy * speed;
    if (speed > 0) {
      moving.push(g);
      continue;
    }
    const settings = g.kind === 'smoke' ? config.smoke : config.gas;
    const cloud: Cloud = {
      id: state.nextEntityId++, ownerId: g.ownerId, kind: g.kind, x: g.x, y: g.y,
      radius: settings.radius, age: 0, ticksLeft: Math.max(1, secondsToTicks(settings.duration, config)),
    };
    state.clouds.push(cloud);
    state.events.push({ type: 'cloud', tick: state.tick, cloudId: cloud.id, ownerId: cloud.ownerId, kind: cloud.kind, x: cloud.x, y: cloud.y, radius: cloud.radius });
  }
  state.throwables = moving;
}

export function insideCloud(cloud: Cloud, x: number, y: number): boolean {
  return length(x - cloud.x, y - cloud.y) <= cloud.radius;
}

/** Is the point inside any gas cloud? (Players there move slower.) */
export function inGas(state: GameState, x: number, y: number): boolean {
  return state.clouds.some((c) => c.kind === 'gas' && insideCloud(c, x, y));
}

/** Age every cloud: gas hurts everyone inside at each whole second of its life; expired clouds vanish. */
export function updateClouds(state: GameState): void {
  const { config } = state;
  for (const cloud of state.clouds) {
    cloud.age++;
    cloud.ticksLeft--;
    if (cloud.kind !== 'gas' || cloud.age % config.tickRate !== 0) continue;
    const owner = state.players[cloud.ownerId];
    for (const p of state.players) {
      if (p.alive && insideCloud(cloud, p.x, p.y)) applyDamage(state, p, config.gas.damagePerSecond, owner, 'gas');
    }
  }
  state.clouds = state.clouds.filter((c) => c.ticksLeft > 0);
}
