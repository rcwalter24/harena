import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { BotController, type WorkerFactory } from '../../src/match/supervisor.ts';
import type { FromWorker } from '../../src/sandbox/protocol.ts';
import { MatchRunner } from '../../src/match/runner.ts';
import { createNodeWorker } from '../../src/sandbox/node/host.ts';
import type { Controller } from '../../src/match/controller.ts';
import type { ActionInput } from '../../src/engine/types.ts';
import { act, place, testGame } from '../helpers.ts';

const SANDBOX = { initBudgetMs: 300, decideBudgetMs: 20, graceMs: 30, hangLimitMs: 400, failureStreakLimit: 3, workerStartMs: 15000 };

function fixture(name: string): string {
  return readFileSync(new URL(`../fixtures/bots/${name}.js`, import.meta.url), 'utf8');
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

/** One bot (player 0) against an idle scripted player (player 1). */
async function setup(name: string, seed = 'seed', sandbox = SANDBOX) {
  const state = testGame({ config: { sandbox }, seed });
  place(state, 0, 300, 300);
  place(state, 1, 700, 700);
  const bot = new BotController({
    name, fileName: `${name}.js`, source: fixture(name), botSeed: `${seed}::bot0`, createWorker: createNodeWorker,
  });
  const idle: Controller = { label: 'idle', decide: () => act() };
  const runner = new MatchRunner(state, [bot, idle]);
  cleanups.push(() => runner.dispose());
  await runner.init();
  return { state, bot, runner };
}

async function ticks(runner: MatchRunner, n: number): Promise<ActionInput[]> {
  const out: ActionInput[] = [];
  for (let i = 0; i < n; i++) {
    await runner.tick();
    out.push(runner.lastActions[0]);
  }
  return out;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('BotController (node worker_threads)', () => {
  it('runs a well-behaved bot, keeps module state, forwards console.log', async () => {
    // Generous budget: this is about behaviour, and a busy machine must not turn it into a timeout.
    const { state, bot, runner } = await setup('good', 'seed', { ...SANDBOX, decideBudgetMs: 200, graceMs: 300 });
    expect(bot.status).toBe('running');
    const actions = await ticks(runner, 5);
    expect(actions.every((a) => a.moveX === 1)).toBe(true);
    expect(state.players[0].x).toBeGreaterThan(300);
    const line = bot.logs.find((l) => l.level === 'bot')!;
    expect(line.message).toMatch(/^ticks 2 self 0 0 rand 0\./);
    expect(bot.stats).toMatchObject({ decisions: 5, timeouts: 0, errors: 0, invalid: 0 });
  });

  it('seeds Math.random so bots are deterministic', async () => {
    const a = await setup('good', 'same');
    await ticks(a.runner, 2);
    const b = await setup('good', 'same');
    await ticks(b.runner, 2);
    const c = await setup('good', 'other');
    await ticks(c.runner, 2);
    const msg = (bot: BotController) => bot.logs.find((l) => l.level === 'bot')!.message;
    expect(msg(a.bot)).toBe(msg(b.bot));
    expect(msg(a.bot)).not.toBe(msg(c.bot));
  });

  it('a slow bot times out, is skipped while busy, then stands still after the streak limit', async () => {
    const { bot, runner } = await setup('slow');
    const actions = await ticks(runner, 8);
    expect(bot.stats.timeouts).toBeGreaterThanOrEqual(3);
    expect(actions.at(-1)!.moveX).toBe(0); // standing still after 3 consecutive failures
    expect(bot.logs.some((l) => l.message.includes('consecutive failures'))).toBe(true);
    expect(bot.status).toBe('running');
  });

  it('reuses the last valid action on failure, then recovers', async () => {
    const { bot, runner } = await setup('flaky');
    const actions = await ticks(runner, 8);
    expect(actions[0].moveY).toBe(1);
    expect(actions[2].moveY).toBe(1); // tick 2 too slow: last action reused
    expect(bot.stats.timeouts).toBeGreaterThanOrEqual(1);
    expect(actions[7].moveY).toBe(1);
  });

  it('an exception reuses the last action, then streak → idle; the game keeps running', async () => {
    const { state, bot, runner } = await setup('throws');
    const actions = await ticks(runner, 6);
    expect(actions[1].moveY).toBe(1);
    expect(actions[5].moveY).toBe(0);
    expect(bot.stats.errors).toBe(5);
    expect(bot.logs.some((l) => l.message.includes('decide() threw: Error: boom'))).toBe(true);
    expect(state.tick).toBe(6);
  });

  it('invalid actions are rejected and logged', async () => {
    const { bot, runner } = await setup('invalid');
    const actions = await ticks(runner, 3);
    expect(actions.every((a) => a.moveX === 0 && a.moveY === 0)).toBe(true);
    expect(bot.stats.invalid).toBe(3);
    expect(bot.logs.some((l) => l.message.includes('move must be'))).toBe(true);
  });

  it('async decide() is rejected', async () => {
    const { bot, runner } = await setup('asyncbot');
    await ticks(runner, 2);
    expect(bot.logs.some((l) => l.message.includes('must be synchronous'))).toBe(true);
  });

  it('network access is not available inside the sandbox', async () => {
    const { bot, runner } = await setup('network');
    await ticks(runner, 1);
    expect(bot.stats.errors).toBe(1);
    expect(bot.logs.some((l) => /fetch/.test(l.message))).toBe(true);
  });

  it('modules that fail to load, or lack decide(), are disabled', async () => {
    const syntax = await setup('syntax');
    expect(syntax.bot.status).toBe('disabled');
    expect(syntax.bot.logs.at(-1)!.message).toMatch(/failed to load: SyntaxError/);
    await ticks(syntax.runner, 2);
    expect(syntax.state.tick).toBe(2);

    const noexport = await setup('noexport');
    expect(noexport.bot.status).toBe('disabled');
    expect(noexport.bot.logs.at(-1)!.message).toMatch(/decide/);
  });

  it('a hung bot is restarted once, then disabled on the second hang', async () => {
    const { bot, runner } = await setup('hang');
    await ticks(runner, 3); // tick 1 hangs
    await sleep(SANDBOX.hangLimitMs + 50);
    await ticks(runner, 1); // detects the hang → restart
    expect(bot.stats.restarts).toBe(1);
    for (let i = 0; i < 40 && bot.status !== 'running'; i++) await sleep(20);
    expect(bot.status).toBe('running');
    await ticks(runner, 2); // hangs again (tick >= 1)
    await sleep(SANDBOX.hangLimitMs + 50);
    await ticks(runner, 1);
    expect(bot.status).toBe('disabled');
    const actions = await ticks(runner, 2);
    expect(actions.every((a) => a.moveX === 0)).toBe(true);
  }, 10_000);

  it('an init() that never returns counts as a hang', async () => {
    const { bot } = await setup('inithang');
    expect(bot.stats.restarts).toBe(1);
    for (let i = 0; i < 80 && bot.status !== 'disabled'; i++) await sleep(20);
    expect(bot.status).toBe('disabled');
  }, 10_000);
});

describe('worker startup', () => {
  /** A real Node worker whose script takes `delayMs` to start (like a slow download), or never starts. */
  function slowWorker(delayMs: number | null): WorkerFactory {
    return () => {
      const inner = createNodeWorker();
      let booted = false;
      const held: FromWorker[] = [];
      let deliver: (msg: FromWorker) => void = () => {};
      inner.onMessage((msg) => {
        if (msg.type === 'booted') return; // re-sent below, after the delay
        if (booted) deliver(msg);
        else held.push(msg);
      });
      return {
        post: (msg) => inner.post(msg),
        onMessage: (cb) => {
          deliver = cb;
          if (delayMs === null) return;
          setTimeout(() => {
            booted = true;
            cb({ type: 'booted' });
            for (const msg of held.splice(0)) cb(msg);
          }, delayMs);
        },
        onError: (cb) => inner.onError(cb),
        terminate: () => inner.terminate(),
      };
    };
  }

  async function start(factory: WorkerFactory, sandbox = SANDBOX) {
    const state = testGame({ config: { sandbox } });
    const bot = new BotController({ name: 'good', fileName: 'good.js', source: fixture('good'), botSeed: 's', createWorker: factory });
    cleanups.push(() => bot.dispose());
    await bot.init(state, 0);
    return bot;
  }

  it('does not count a slow worker start against init()', async () => {
    const bot = await start(slowWorker(SANDBOX.hangLimitMs + SANDBOX.initBudgetMs + 200));
    expect(bot.status).toBe('running');
    expect(bot.stats.restarts).toBe(0);
  });

  it('restarts, then disables, a worker that never starts', async () => {
    const bot = await start(slowWorker(null), { ...SANDBOX, workerStartMs: 150 });
    await sleep(400); // the restarted worker gets another 150 ms
    expect(bot.status).toBe('disabled');
    expect(bot.logs.some((l) => l.message.includes('did not start within 0.15 s'))).toBe(true);
  });
});
