import { secondsToTicks, type GameConfig } from '../config.ts';
import { circleOverlapsRect } from '../geometry.ts';
import type { GameState, SpawnPoint } from '../types.ts';
import { applyDamage } from './combat.ts';

/**
 * The safe zone: a circle around the map centre. It covers the whole map until
 * `zone.shrinkStart`, then its radius shrinks linearly to `zone.finalRadius`.
 * Everything here is derived from the tick, so the zone adds no simulation state.
 */
export interface Zone {
  x: number;
  y: number;
  radius: number;
  /** Centre-to-corner distance: the radius before shrinking. */
  startRadius: number;
  finalRadius: number;
  startTick: number;
  endTick: number;
}

export function zoneEnabled(config: GameConfig): boolean {
  return config.zone.damagePerSecond > 0;
}

export function zoneAt(state: GameState, tick: number = state.tick): Zone {
  const { map, config } = state;
  const x = map.width / 2;
  const y = map.height / 2;
  const startRadius = Math.sqrt(x * x + y * y);
  const startTick = secondsToTicks(config.zone.shrinkStart, config);
  const endTick = startTick + secondsToTicks(config.zone.shrinkDuration, config);
  if (!zoneEnabled(config)) return { x, y, radius: startRadius, startRadius, finalRadius: startRadius, startTick, endTick };
  const finalRadius = Math.max(0, Math.min(config.zone.finalRadius, startRadius));
  const f = tick <= startTick ? 0 : tick >= endTick ? 1 : (tick - startTick) / (endTick - startTick);
  return { x, y, radius: startRadius + (finalRadius - startRadius) * f, startRadius, finalRadius, startTick, endTick };
}

/** True if (x, y) is at least `margin` inside the zone edge. */
export function insideZone(zone: Zone, x: number, y: number, margin = 0): boolean {
  const r = zone.radius - margin;
  if (r < 0) return false;
  const dx = x - zone.x;
  const dy = y - zone.y;
  return dx * dx + dy * dy <= r * r;
}

/** Has the zone started shrinking (so placement must avoid the outside)? */
export function zoneShrinking(state: GameState): boolean {
  return zoneEnabled(state.config) && state.tick > zoneAt(state).startTick;
}

/** At every whole second, players whose centre is outside the zone take damage (no kill credit). */
export function applyZoneDamage(state: GameState): void {
  const { config } = state;
  if (!zoneEnabled(config) || state.tick % config.tickRate !== 0) return;
  const zone = zoneAt(state);
  for (const p of state.players) {
    if (p.alive && !insideZone(zone, p.x, p.y)) applyDamage(state, p, config.zone.damagePerSecond, p, 'zone');
  }
}

/**
 * A free random point well inside the zone, for respawns when no spawn point is inside it:
 * the candidate farthest from the nearest living enemy, or null if none was found.
 */
export function randomZoneSpawn(state: GameState, selfId: number): SpawnPoint | null {
  const { map, config, rng } = state;
  const zone = zoneAt(state);
  const r = config.player.radius;
  const margin = 2 * r;
  const reach = zone.radius - margin;
  if (reach <= 0) return null;
  const enemies = state.players.filter((q) => q.id !== selfId && q.alive);
  let best: SpawnPoint | null = null;
  let bestDist = -Infinity;
  let found = 0;
  for (let attempt = 0; attempt < 60 && found < 8; attempt++) {
    const x = rng.spawns.range(Math.max(r, zone.x - reach), Math.min(map.width - r, zone.x + reach));
    const y = rng.spawns.range(Math.max(r, zone.y - reach), Math.min(map.height - r, zone.y + reach));
    if (!insideZone(zone, x, y, margin)) continue;
    if (map.walls.some((w) => circleOverlapsRect(x, y, r + 2, w))) continue;
    if (state.players.some((q) => q.alive && q.id !== selfId && (q.x - x) * (q.x - x) + (q.y - y) * (q.y - y) < 4 * r * r + 16)) continue;
    found++;
    let nearest = Infinity;
    for (const e of enemies) nearest = Math.min(nearest, (e.x - x) * (e.x - x) + (e.y - y) * (e.y - y));
    if (nearest > bestDist) {
      best = { x, y };
      bestDist = nearest;
    }
  }
  return best;
}
