import { DEFAULT_CONFIG, mergeConfig, type DeepPartial, type GameConfig } from '../src/engine/config.ts';
import { createGame } from '../src/engine/game.ts';
import { IDLE_ACTION, type ActionInput, type GameState, type MapData } from '../src/engine/types.ts';
import type { Rect } from '../src/engine/geometry.ts';

/** An empty 1000x1000 arena with 8 spawns along the left edge and optional walls. */
export function testMap(walls: Rect[] = [], gunSpawns: { x: number; y: number }[] = []): MapData {
  return {
    id: 'test',
    name: 'Test',
    width: 1000,
    height: 1000,
    walls,
    spawns: Array.from({ length: 8 }, (_, i) => ({ x: 50, y: 60 + i * 120 })),
    gunSpawns,
  };
}

export interface TestGameOptions {
  players?: number;
  walls?: Rect[];
  gunSpawns?: { x: number; y: number }[];
  config?: DeepPartial<GameConfig>;
  seed?: string;
  timeLimit?: number;
}

/** Create a game and return it; tests usually reposition players with place(). */
export function testGame(opts: TestGameOptions = {}): GameState {
  const n = opts.players ?? 2;
  return createGame({
    map: testMap(opts.walls, opts.gunSpawns),
    players: Array.from({ length: n }, (_, i) => ({ name: `P${i}` })),
    seed: opts.seed ?? 'test',
    config: mergeConfig(DEFAULT_CONFIG, opts.config),
    timeLimit: opts.timeLimit ?? 0,
  });
}

export function place(state: GameState, id: number, x: number, y: number, facing = 0): void {
  const p = state.players[id];
  p.x = x;
  p.y = y;
  p.facing = facing;
}

export function act(partial: Partial<ActionInput> = {}): ActionInput {
  return { ...IDLE_ACTION, ...partial };
}

/** Clear spawn invulnerability for all players (initial spawns aren't invulnerable, but respawns are). */
export function vulnerable(state: GameState): void {
  for (const p of state.players) p.invulnerableTimer = 0;
}
