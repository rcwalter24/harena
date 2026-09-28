import { secondsToTicks } from '../config.ts';
import { length } from '../dmath.ts';
import type { GameState, PlayerState, Sighting } from '../types.ts';

/** Index of the bush containing the point, or -1. */
export function bushAt(state: GameState, x: number, y: number): number {
  const bushes = state.map.bushes ?? [];
  for (let i = 0; i < bushes.length; i++) {
    const b = bushes[i];
    if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) return i;
  }
  return -1;
}

/** Hiding time in ticks, or 0 when there is no limit. */
function hideLimitTicks(state: GameState): number {
  return state.config.bushes.hideLimit > 0 ? Math.max(1, secondsToTicks(state.config.bushes.hideLimit, state.config)) : 0;
}

/** Has the player stayed in bushes too long to stay hidden? */
export function isExposed(state: GameState, p: PlayerState): boolean {
  const limit = hideLimitTicks(state);
  return limit > 0 && p.bushTicks >= limit;
}

/** Seconds of hiding left before exposure (Infinity when there is no limit). */
export function hideLeft(state: GameState, p: PlayerState): number {
  const limit = hideLimitTicks(state);
  return limit > 0 ? Math.max(0, limit - p.bushTicks) / state.config.tickRate : Infinity;
}

/**
 * Count time spent in bushes: it accumulates while a player's centre is in any
 * bush and only resets after bushes.rehideTime spent outside all of them, so
 * stepping out for a moment does not refill it.
 */
export function updateHiding(state: GameState): void {
  const limit = hideLimitTicks(state);
  if (limit === 0) return;
  const rehide = secondsToTicks(state.config.bushes.rehideTime, state.config);
  for (const p of state.players) {
    if (!p.alive) continue;
    if (bushAt(state, p.x, p.y) >= 0) {
      p.bushTicks = Math.min(limit, p.bushTicks + 1);
      p.outOfBushTicks = 0;
    } else if (p.bushTicks > 0 && ++p.outOfBushTicks >= rehide) {
      p.bushTicks = 0;
      p.outOfBushTicks = 0;
    }
  }
}

/**
 * Can `viewer` see `target` right now? Everyone is visible except a living
 * enemy whose centre is in a bush — unless the viewer is alive and within
 * bushes.revealDistance or in the same bush, the target recently made noise
 * (attacked, planted a mine or took damage), or the target has been in bushes
 * longer than bushes.hideLimit.
 */
export function isVisibleTo(state: GameState, viewer: PlayerState, target: PlayerState): boolean {
  if (viewer === target || !target.alive) return true;
  const bush = bushAt(state, target.x, target.y);
  if (bush < 0) return true;
  if (target.noiseTimer > 0 || isExposed(state, target)) return true;
  if (!viewer.alive) return false;
  if (length(viewer.x - target.x, viewer.y - target.y) <= state.config.bushes.revealDistance) return true;
  return bushAt(state, viewer.x, viewer.y) === bush;
}

function sightingOf(state: GameState, p: PlayerState): Sighting {
  return { tick: state.tick, x: p.x, y: p.y, vx: p.vx, vy: p.vy, facing: p.facing };
}

/** Everyone sees everyone at the start (spawn points are public). */
export function initSightings(state: GameState): void {
  state.lastSeen = state.players.map(() => state.players.map((t) => sightingOf(state, t)));
}

/** Record what every player can see after this tick. */
export function updateSightings(state: GameState): void {
  for (const viewer of state.players) {
    const row = state.lastSeen[viewer.id];
    for (const target of state.players) {
      if (isVisibleTo(state, viewer, target)) row[target.id] = sightingOf(state, target);
    }
  }
}
