import { step } from '../engine/game.ts';
import type { ActionInput, GameEvent, GameState } from '../engine/types.ts';
import type { Controller } from './controller.ts';

/**
 * Drives one match: asks every controller for its action, then steps the engine.
 * Environment-agnostic; the browser paces it by the clock, Node runs it flat out.
 */
export class MatchRunner {
  readonly state: GameState;
  readonly controllers: Controller[];
  /** Actions applied on the most recent tick (index = player id). */
  lastActions: ActionInput[] = [];
  private listeners: Array<(events: GameEvent[], state: GameState) => void> = [];

  constructor(state: GameState, controllers: Controller[]) {
    if (controllers.length !== state.players.length) {
      throw new Error(`Expected ${state.players.length} controllers, got ${controllers.length}`);
    }
    this.state = state;
    this.controllers = controllers;
  }

  async init(): Promise<void> {
    await Promise.all(this.controllers.map((c, id) => c.init?.(this.state, id)));
  }

  onTick(listener: (events: GameEvent[], state: GameState) => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  async tick(): Promise<GameEvent[]> {
    if (this.state.over) return [];
    const actions = await Promise.all(this.controllers.map((c, id) => c.decide(this.state, id)));
    this.lastActions = actions;
    const events = step(this.state, actions);
    for (const l of this.listeners) l(events, this.state);
    return events;
  }

  dispose(): void {
    for (const c of this.controllers) c.dispose?.();
    this.listeners = [];
  }
}
