import type { GameEvent, GameState } from '../engine/types.ts';
import { captureFrame, type FrameCapture } from '../render/renderer.ts';

/** Anything that advances a game one tick at a time: a MatchRunner, or a replay. */
export interface Ticker {
  readonly state: GameState;
  tick(): Promise<GameEvent[]>;
}

export const SPEEDS = [0.25, 0.5, 1, 2, 4, 8];

/**
 * Real-time driver for a Ticker in the browser: fixed-rate ticks scaled by
 * a speed multiplier, with render interpolation between ticks. If controllers
 * (bots) are slower than the requested rate, the game simply runs slower.
 */
export class GameLoop {
  readonly runner: Ticker;
  paused = false;
  speedIndex = SPEEDS.indexOf(1);
  /** Measured simulation rate (ticks per real second). */
  actualTps = 0;

  private prev: FrameCapture | null = null;
  private accumulator = 0;
  private lastTime = 0;
  private inFlight = false;
  private rafId = 0;
  private running = false;
  private tickTimes: number[] = [];
  private readonly onFrame: (state: GameState, prev: FrameCapture | null, alpha: number) => void;
  private readonly onEvents: (events: GameEvent[], state: GameState) => void;

  constructor(
    runner: Ticker,
    onFrame: (state: GameState, prev: FrameCapture | null, alpha: number) => void,
    onEvents: (events: GameEvent[], state: GameState) => void,
  ) {
    this.runner = runner;
    this.onFrame = onFrame;
    this.onEvents = onEvents;
  }

  get speed(): number {
    return SPEEDS[this.speedIndex];
  }

  changeSpeed(delta: number): void {
    this.speedIndex = Math.max(0, Math.min(SPEEDS.length - 1, this.speedIndex + delta));
  }

  start(): void {
    this.running = true;
    this.lastTime = performance.now();
    const frame = (now: number) => {
      if (!this.running) return;
      this.frame(now);
      this.rafId = requestAnimationFrame(frame);
    };
    this.rafId = requestAnimationFrame(frame);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.rafId);
  }

  /** Forget the previous frame (after a seek, so nothing is interpolated across the jump). */
  resetInterpolation(): void {
    this.prev = null;
    this.accumulator = 0;
  }

  /** Advance exactly one tick (used by the "step" button while paused). */
  async stepOnce(): Promise<void> {
    if (this.inFlight || this.runner.state.over) return;
    this.inFlight = true;
    try {
      await this.runTick();
    } finally {
      this.inFlight = false;
    }
  }

  private frame(now: number): void {
    const tickMs = 1000 / this.runner.state.config.tickRate;
    const elapsed = Math.min(now - this.lastTime, 250);
    this.lastTime = now;
    if (!this.paused && !this.runner.state.over) this.accumulator += elapsed * this.speed;
    if (!this.inFlight && this.accumulator >= tickMs) void this.runTicks(tickMs);
    const alpha = this.paused || this.runner.state.over ? 1 : Math.min(1, this.accumulator / tickMs);
    this.tickTimes = this.tickTimes.filter((t) => now - t < 1000);
    this.actualTps = this.tickTimes.length;
    this.onFrame(this.runner.state, this.prev, alpha);
  }

  private async runTicks(tickMs: number): Promise<void> {
    this.inFlight = true;
    try {
      // Cap catch-up work per frame so a slow frame doesn't snowball.
      const maxTicks = Math.max(2, Math.ceil(this.speed * 2));
      let n = 0;
      while (this.accumulator >= tickMs && n < maxTicks && !this.runner.state.over && !this.paused) {
        await this.runTick();
        this.accumulator -= tickMs;
        n++;
      }
      if (this.accumulator > tickMs * maxTicks) this.accumulator = tickMs;
    } finally {
      this.inFlight = false;
    }
  }

  private async runTick(): Promise<void> {
    const prev = captureFrame(this.runner.state);
    const events = await this.runner.tick();
    this.prev = prev;
    this.tickTimes.push(performance.now());
    this.onEvents(events, this.runner.state);
  }
}
