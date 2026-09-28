import type { BotState, InitInfo } from '../engine/botApi.ts';

/** Messages from the match host to a bot worker. */
export type ToWorker =
  | {
    type: 'init';
    /** Bot module source text (an ES module exporting init and decide). */
    source: string;
    fileName: string;
    /** Seed for the bot's Math.random. */
    botSeed: string;
    info: InitInfo;
  }
  | { type: 'decide'; tick: number; state: Omit<BotState, 'self'> };

export interface WorkerError {
  message: string;
  stack?: string;
}

/** Messages from a bot worker back to the host. */
export type FromWorker =
  /** The worker script is running (sent once, before any init). */
  | { type: 'booted' }
  | { type: 'ready'; loadMs: number; initMs: number; error?: WorkerError & { stage: 'load' | 'init' } }
  | { type: 'action'; tick: number; action: unknown; elapsedMs: number }
  | { type: 'error'; tick: number; error: WorkerError; elapsedMs: number }
  | { type: 'log'; tick: number; level: 'log' | 'warn' | 'error'; text: string };
