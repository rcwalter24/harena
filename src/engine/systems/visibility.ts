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

/**
 * Can `viewer` see `target` right now? Everyone is visible except a living
 * enemy whose centre is in a bush — unless the viewer is alive and within
 * bushes.revealDistance or in the same bush, or the target recently made
 * noise (attacked, planted a mine or took damage).
 */
export function isVisibleTo(state: GameState, viewer: PlayerState, target: PlayerState): boolean {
  if (viewer === target || !target.alive) return true;
  const bush = bushAt(state, target.x, target.y);
  if (bush < 0) return true;
  if (target.noiseTimer > 0) return true;
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
