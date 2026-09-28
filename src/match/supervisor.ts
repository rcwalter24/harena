import type { BotState } from '../engine/botApi.ts';
import { sanitizeAction, unknownActionKeys } from '../engine/sanitize.ts';
import { buildBotState, buildInitInfo, viewForPlayer } from '../engine/snapshot.ts';
import { IDLE_ACTION, type ActionInput, type GameState } from '../engine/types.ts';
import type { FromWorker, ToWorker } from '../sandbox/protocol.ts';
import type { Controller } from './controller.ts';

/** Minimal worker interface implemented by the browser and Node hosts (and test fakes). */
export interface WorkerLike {
  post(msg: ToWorker): void;
  onMessage(cb: (msg: FromWorker) => void): void;
  onError(cb: (err: string) => void): void;
  terminate(): void;
}

export type WorkerFactory = () => WorkerLike;

export type LogLevel = 'info' | 'warn' | 'error' | 'bot';

export interface LogEntry {
  tick: number;
  level: LogLevel;
  message: string;
  /** How many times this exact message repeated in a row. */
  count: number;
}

export interface BotStats {
  decisions: number;
  timeouts: number;
  errors: number;
  invalid: number;
  restarts: number;
  lateReplies: number;
  totalDecideMs: number;
  maxDecideMs: number;
}

export type BotStatus = 'starting' | 'running' | 'disabled';

export interface BotControllerOptions {
  /** Display name, e.g. "gunner.js #2". */
  name: string;
  fileName: string;
  source: string;
  /** Seed for the bot's Math.random (derive from the match seed and player id). */
  botSeed: string;
  createWorker: WorkerFactory;
  /** Called whenever a log entry is added (for live UI). */
  onLog?: (entry: LogEntry) => void;
}

const MAX_LOG_ENTRIES = 500;

/** One bot snapshot per game tick, shared by every BotController in the match. */
const snapshotCache = new WeakMap<GameState, { tick: number; snapshot: Omit<BotState, 'self'> }>();

function sharedSnapshot(state: GameState): Omit<BotState, 'self'> {
  const cached = snapshotCache.get(state);
  if (cached && cached.tick === state.tick) return cached.snapshot;
  const snapshot = buildBotState(state);
  snapshotCache.set(state, { tick: state.tick, snapshot });
  return snapshot;
}

interface Pending {
  tick: number;
  sentAt: number;
  /** Resolves the tick's wait; null once the wait has timed out (a reply after that is stale). */
  resolve: ((msg: FromWorker) => void) | null;
}

/**
 * Runs one bot in a sandboxed worker and enforces the rules:
 *
 * - Each decide() has a time budget (sandbox.decideBudgetMs, measured inside the
 *   worker) plus a short wall-clock grace for messaging. Too slow = timeout.
 * - Any failure (timeout, exception, invalid action) reuses the bot's last valid
 *   action. After sandbox.failureStreakLimit consecutive failures the bot stands
 *   still until it gives a valid, on-time answer again.
 * - While a previous decide() is still running the bot is "busy": ticks are
 *   skipped (counted as timeouts) and a late reply is discarded.
 * - A worker silent for sandbox.hangLimitMs is terminated and restarted with
 *   init() (module state is lost). A second hang or crash disables the bot.
 * - A module that fails to load, or has no decide(), is disabled immediately.
 */
export class BotController implements Controller {
  readonly label: string;
  readonly name: string;
  status: BotStatus = 'starting';
  readonly stats: BotStats = {
    decisions: 0, timeouts: 0, errors: 0, invalid: 0, restarts: 0, lateReplies: 0, totalDecideMs: 0, maxDecideMs: 0,
  };
  readonly logs: LogEntry[] = [];

  private readonly opts: BotControllerOptions;
  private worker: WorkerLike | null = null;
  private workerGeneration = 0;
  private hangs = 0;
  private pending: Pending | null = null;
  private lastAction: ActionInput = { ...IDLE_ACTION };
  private failStreak = 0;
  private playerId = 0;
  private state: GameState | null = null;
  private warnedKeys = false;

  constructor(opts: BotControllerOptions) {
    this.opts = opts;
    this.name = opts.name;
    this.label = `bot:${opts.fileName}`;
  }

  private get sandbox() {
    return this.state!.config.sandbox;
  }

  private get tick(): number {
    return this.state?.tick ?? 0;
  }

  log(level: LogLevel, message: string): void {
    const last = this.logs[this.logs.length - 1];
    if (last && last.level === level && last.message === message) {
      last.count++;
      last.tick = this.tick;
      this.opts.onLog?.(last);
      return;
    }
    const entry: LogEntry = { tick: this.tick, level, message, count: 1 };
    this.logs.push(entry);
    if (this.logs.length > MAX_LOG_ENTRIES) this.logs.splice(0, this.logs.length - MAX_LOG_ENTRIES);
    this.opts.onLog?.(entry);
  }

  async init(state: Readonly<GameState>, playerId: number): Promise<void> {
    this.state = state as GameState;
    this.playerId = playerId;
    await this.startWorker();
  }

  /** Start (or restart) the worker and run init(). Resolves once the bot is running or disabled. */
  private async startWorker(): Promise<void> {
    this.status = 'starting';
    this.pending = null;
    const generation = ++this.workerGeneration;
    let worker: WorkerLike;
    try {
      worker = this.opts.createWorker();
    } catch (err) {
      this.disable(`could not start a worker: ${String(err)}`);
      return;
    }
    this.worker = worker;

    // Two clocks: the worker script gets workerStartMs to start (a hosted page may download
    // it over a slow network); only then does the bot's load + init() get its own limit.
    type Ready = (FromWorker & { type: 'ready' }) | 'crashed' | 'timeout' | 'no-start';
    let finish: (r: Ready) => void = () => {};
    let booted: () => void = () => {};
    const ready = new Promise<Ready>((resolve) => {
      const limit = Math.max(this.sandbox.initBudgetMs, this.sandbox.hangLimitMs) + this.sandbox.graceMs;
      let timer = setTimeout(() => finish('no-start'), this.sandbox.workerStartMs);
      booted = () => {
        clearTimeout(timer);
        timer = setTimeout(() => finish('timeout'), limit);
      };
      finish = (r) => {
        clearTimeout(timer);
        resolve(r);
      };
    });
    worker.onError((err) => {
      if (generation !== this.workerGeneration) return;
      if (this.status === 'starting') finish('crashed');
      else this.onCrash(err);
    });
    worker.onMessage((msg) => {
      if (generation !== this.workerGeneration) return;
      if (msg.type === 'booted') booted();
      else if (msg.type === 'ready') finish(msg);
      else this.onMessage(msg);
    });

    worker.post({
      type: 'init',
      source: this.opts.source,
      fileName: this.opts.fileName,
      botSeed: this.opts.botSeed,
      info: buildInitInfo(this.state!, this.playerId),
    });

    const result = await ready;
    if (generation !== this.workerGeneration) return;
    if (result === 'timeout' || result === 'crashed' || result === 'no-start') {
      this.handleHang(
        result === 'timeout'
          ? 'init() did not return in time'
          : result === 'crashed'
            ? 'the worker crashed during init()'
            : `the sandbox worker did not start within ${this.sandbox.workerStartMs / 1000} s (slow network?)`,
      );
      return;
    }
    if (result.error?.stage === 'load') {
      this.disable(`failed to load: ${result.error.message}`);
      return;
    }
    if (result.error) this.log('error', `init() threw: ${result.error.message}`);
    if (result.initMs > this.sandbox.initBudgetMs) {
      this.log('warn', `init() took ${result.initMs.toFixed(1)} ms (budget ${this.sandbox.initBudgetMs} ms)`);
    }
    this.status = 'running';
    this.log('info', `ready (load ${result.loadMs.toFixed(1)} ms, init ${result.initMs.toFixed(1)} ms)`);
  }

  private onMessage(msg: FromWorker): void {
    if (msg.type === 'log') {
      this.log('bot', msg.text);
      return;
    }
    if (msg.type === 'action' || msg.type === 'error') {
      const p = this.pending;
      if (!p || p.tick !== msg.tick) return;
      if (p.resolve) {
        p.resolve(msg);
      } else {
        // The tick's wait already timed out: the reply is stale. The worker is free again.
        this.stats.lateReplies++;
        this.pending = null;
      }
    }
  }

  private onCrash(err: string): void {
    this.handleHang(`the worker crashed: ${err}`);
  }

  /** Terminate a hung or crashed worker; restart it once, disable it the second time. */
  private handleHang(reason: string): void {
    this.worker?.terminate();
    this.worker = null;
    this.pending = null;
    this.hangs++;
    if (this.hangs >= 2) {
      this.disable(`${reason}; second hang or crash, bot disabled for the rest of the match`);
      return;
    }
    this.stats.restarts++;
    this.log('error', `${reason}; worker terminated and restarted (module state is lost)`);
    void this.startWorker();
  }

  private disable(reason: string): void {
    this.workerGeneration++;
    this.worker?.terminate();
    this.worker = null;
    this.pending = null;
    this.status = 'disabled';
    this.log('error', reason);
  }

  /** Record a failure; returns the action to use this tick. */
  private fail(kind: 'timeouts' | 'errors' | 'invalid', message: string): ActionInput {
    this.stats[kind]++;
    this.failStreak++;
    this.log(kind === 'timeouts' ? 'warn' : 'error', message);
    const limit = this.sandbox.failureStreakLimit;
    if (this.failStreak === limit) {
      this.log('warn', `${limit} consecutive failures: standing still until the bot answers correctly again`);
    }
    if (this.failStreak >= limit) return { ...IDLE_ACTION };
    return { ...this.lastAction, plantMine: false };
  }

  /**
   * The bot can't answer this tick right away: its worker is (re)starting or still busy with an
   * earlier decide(). A live match moves on in real time meanwhile, so headless runs slow down to
   * real time while this is true (instead of racing through the ticks it misses).
   */
  get lagging(): boolean {
    return this.status === 'starting' || this.pending !== null;
  }

  decide(state: Readonly<GameState>, playerId: number): ActionInput | Promise<ActionInput> {
    this.state = state as GameState;
    this.playerId = playerId;
    if (this.status !== 'running' || !this.worker) return { ...IDLE_ACTION };

    const now = performance.now();
    if (this.pending) {
      if (now - this.pending.sentAt > this.sandbox.hangLimitMs) {
        this.handleHang(`no reply for ${Math.round(now - this.pending.sentAt)} ms`);
        return { ...IDLE_ACTION };
      }
      return this.fail('timeouts', 'still busy with a previous decide(); tick skipped');
    }

    const tick = state.tick;
    const pending: Pending = { tick, sentAt: now, resolve: null };
    this.pending = pending;
    const reply = new Promise<FromWorker | 'timeout'>((resolve) => {
      const timer = setTimeout(() => {
        pending.resolve = null;
        resolve('timeout');
      }, this.sandbox.decideBudgetMs + this.sandbox.graceMs);
      pending.resolve = (msg) => {
        clearTimeout(timer);
        pending.resolve = null;
        resolve(msg);
      };
    });
    const view = viewForPlayer(state as GameState, sharedSnapshot(state as GameState), playerId);
    this.worker.post({ type: 'decide', tick, state: view });

    return reply.then((msg) => {
      if (msg === 'timeout') {
        return this.fail('timeouts', `decide() gave no reply within ${this.sandbox.decideBudgetMs + this.sandbox.graceMs} ms`);
      }
      if (this.pending === pending) this.pending = null;
      if (msg.type !== 'action' && msg.type !== 'error') return this.fail('errors', 'unexpected message from worker');
      this.stats.decisions++;
      this.stats.totalDecideMs += msg.elapsedMs;
      this.stats.maxDecideMs = Math.max(this.stats.maxDecideMs, msg.elapsedMs);
      if (msg.type === 'error') return this.fail('errors', `decide() threw: ${msg.error.message}`);
      if (msg.elapsedMs > this.sandbox.decideBudgetMs) {
        return this.fail('timeouts', `decide() took ${msg.elapsedMs.toFixed(1)} ms (budget ${this.sandbox.decideBudgetMs} ms); action discarded`);
      }
      const result = sanitizeAction(msg.action);
      if (!result.valid) return this.fail('invalid', `invalid action: ${result.problems.join('; ')}`);
      if (!this.warnedKeys) {
        const unknown = unknownActionKeys(msg.action);
        if (unknown.length > 0) {
          this.warnedKeys = true;
          this.log('warn', `ignoring unknown action field(s): ${unknown.join(', ')}`);
        }
      }
      if (this.failStreak >= this.sandbox.failureStreakLimit) this.log('info', 'recovered');
      this.failStreak = 0;
      this.lastAction = result.action;
      return result.action;
    });
  }

  dispose(): void {
    this.workerGeneration++;
    this.worker?.terminate();
    this.worker = null;
    this.pending = null;
  }
}
