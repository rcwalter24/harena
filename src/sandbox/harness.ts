import type { BotState } from '../engine/botApi.ts';
import { Rng } from '../engine/rng.ts';
import type { FromWorker, ToWorker, WorkerError } from './protocol.ts';

/**
 * Environment-independent bot runner used inside both the browser Web Worker
 * and the Node worker thread. It loads the bot module, seeds Math.random,
 * captures console output, times init()/decide(), and reports results.
 */
export interface HarnessEnv {
  post(msg: FromWorker): void;
  loadModule(source: string, fileName: string): Promise<Record<string, unknown>>;
  now(): number;
}

const MAX_LOGS_PER_TICK = 20;
const MAX_LOG_LENGTH = 500;

export function errorInfo(err: unknown): WorkerError {
  if (err instanceof Error) {
    const stack = err.stack?.split('\n').slice(0, 4).join('\n');
    return { message: `${err.name}: ${err.message}`, stack };
  }
  let text: string;
  try {
    text = typeof err === 'string' ? err : JSON.stringify(err) ?? String(err);
  } catch {
    text = String(err);
  }
  return { message: `thrown value: ${text.slice(0, 200)}` };
}

/** Reduce the bot's return value to structured-clone-safe plain data, keeping only action fields. */
export function toPlainAction(value: unknown): unknown {
  const prim = (v: unknown): unknown => {
    if (v === null || v === undefined || typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string') return v;
    if (typeof v === 'object') return Array.isArray(v) ? '[array]' : '[object]';
    return `[${typeof v}]`;
  };
  if (value === null || value === undefined) return value;
  if (typeof value !== 'object') return prim(value);
  if (Array.isArray(value)) return '[array]';
  const src = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(src).slice(0, 50)) {
    const v = src[key];
    if (key === 'move' && v && typeof v === 'object' && !Array.isArray(v)) {
      const m = v as Record<string, unknown>;
      out.move = { x: prim(m.x), y: prim(m.y) };
    } else {
      out[key] = prim(v);
    }
  }
  return out;
}

export function createHarness(env: HarnessEnv): (msg: ToWorker) => Promise<void> {
  let mod: Record<string, unknown> | null = null;
  let selfId = 0;
  let currentTick = -1;
  let logsThisTick = 0;
  // Only output produced while bot code runs is forwarded (ignores e.g. dev-tool clients in the worker).
  let inBotCode = false;

  const capture = (level: 'log' | 'warn' | 'error') => (...args: unknown[]) => {
    if (!inBotCode || logsThisTick >= MAX_LOGS_PER_TICK) return;
    logsThisTick++;
    const text = args
      .map((a) => {
        if (typeof a === 'string') return a;
        try {
          return JSON.stringify(a);
        } catch {
          return String(a);
        }
      })
      .join(' ')
      .slice(0, MAX_LOG_LENGTH);
    env.post({ type: 'log', tick: currentTick, level, text });
  };
  const botConsole = console as unknown as Record<string, unknown>;
  botConsole.log = capture('log');
  botConsole.info = capture('log');
  botConsole.debug = capture('log');
  botConsole.warn = capture('warn');
  botConsole.error = capture('error');

  return async (msg: ToWorker) => {
    if (msg.type === 'init') {
      selfId = msg.info.selfId;
      const rng = new Rng(msg.botSeed);
      Math.random = () => rng.next();
      logsThisTick = 0;
      const t0 = env.now();
      try {
        inBotCode = true;
        mod = await env.loadModule(msg.source, msg.fileName);
      } catch (err) {
        env.post({ type: 'ready', loadMs: env.now() - t0, initMs: 0, error: { stage: 'load', ...errorInfo(err) } });
        return;
      } finally {
        inBotCode = false;
      }
      const loadMs = env.now() - t0;
      if (typeof mod.decide !== 'function') {
        env.post({ type: 'ready', loadMs, initMs: 0, error: { stage: 'load', message: 'the module does not export a decide(state) function' } });
        return;
      }
      const t1 = env.now();
      try {
        inBotCode = true;
        if (typeof mod.init === 'function') (mod.init as (info: unknown) => unknown)(msg.info);
        inBotCode = false;
        env.post({ type: 'ready', loadMs, initMs: env.now() - t1 });
      } catch (err) {
        inBotCode = false;
        env.post({ type: 'ready', loadMs, initMs: env.now() - t1, error: { stage: 'init', ...errorInfo(err) } });
      }
      return;
    }

    if (msg.type === 'decide') {
      currentTick = msg.tick;
      logsThisTick = 0;
      if (!mod) return;
      const state = msg.state as BotState;
      state.self = state.players[selfId];
      const t0 = env.now();
      let result: unknown;
      try {
        inBotCode = true;
        result = (mod.decide as (s: BotState) => unknown)(state);
      } catch (err) {
        env.post({ type: 'error', tick: msg.tick, error: errorInfo(err), elapsedMs: env.now() - t0 });
        return;
      } finally {
        inBotCode = false;
      }
      const elapsedMs = env.now() - t0;
      if (result && typeof (result as { then?: unknown }).then === 'function') {
        env.post({
          type: 'error', tick: msg.tick, elapsedMs,
          error: { message: 'decide() returned a Promise; decide must be synchronous (no async/await)' },
        });
        return;
      }
      env.post({ type: 'action', tick: msg.tick, action: toPlainAction(result), elapsedMs });
    }
  };
}

/**
 * Hide globals a bot has no business using (network, storage, timers, raw
 * messaging). Call this after the harness has captured what it needs. This is
 * defence in depth against accidents and casual misuse, not a security boundary.
 */
export function neuterGlobals(names: readonly string[]): void {
  const g = globalThis as Record<string, unknown>;
  for (const name of names) {
    try {
      Object.defineProperty(g, name, { value: undefined, writable: false, configurable: false });
    } catch {
      // Some hosts refuse to redefine certain globals; the static check still flags their use.
    }
  }
}

/** Globals removed in every environment. Timers are removed so bots cannot compute between ticks. */
export const COMMON_BLOCKED_GLOBALS = [
  'fetch', 'XMLHttpRequest', 'WebSocket', 'WebSocketStream', 'EventSource', 'WebTransport',
  'BroadcastChannel', 'MessageChannel', 'Worker', 'SharedWorker', 'indexedDB', 'caches',
  'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'queueMicrotask',
  'requestAnimationFrame', 'setImmediate', 'WebAssembly',
] as const;
