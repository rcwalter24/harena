import type { ActionInput, GameState } from '../engine/types.ts';

/**
 * Something that produces a player's action every tick: a human at the
 * keyboard, a scripted dummy, a sandboxed bot, or a replay.
 */
export interface Controller {
  /** Short label shown in the UI ("human", "dummy:brawler", "bot:gunner.js", ...). */
  readonly label: string;
  /** Called once before the first tick. */
  init?(state: Readonly<GameState>, playerId: number): void | Promise<void>;
  /** Produce the action for the upcoming tick. */
  decide(state: Readonly<GameState>, playerId: number): ActionInput | Promise<ActionInput>;
  dispose?(): void;
}
