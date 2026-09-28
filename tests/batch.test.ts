import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { loadBot, ROOT, runBatch } from '../src/batch/batch.ts';
import { ReplayPlayer, validateReplay } from '../src/engine/replay.ts';

const replayDir = join(ROOT, 'out', 'test-batch-replays');
afterAll(() => rmSync(replayDir, { recursive: true, force: true }));

const base = { maps: ['duel', 'corridors'], games: 4, seed: 't', timeLimit: 20, concurrency: 2, config: { sandbox: { decideBudgetMs: 50, graceMs: 100 } } };

describe('batch runner', () => {
  it('plays every game and summarizes per bot', async () => {
    const seen: number[] = [];
    const summary = await runBatch({ ...base, bots: ['gunner', 'chaser.js', 'gunner'] }, (_g, done) => seen.push(done));
    expect(seen).toEqual([1, 2, 3, 4]);
    expect(summary.games.map((g) => g.index)).toEqual([0, 1, 2, 3]);
    expect(summary.games.map((g) => g.map)).toEqual(['duel', 'corridors', 'duel', 'corridors']);
    const gunner = summary.bots.find((b) => b.bot === 'gunner.js')!;
    const chaser = summary.bots.find((b) => b.bot === 'chaser.js')!;
    expect(gunner.seats).toBe(8);
    expect(chaser.seats).toBe(4);
    const soleWins = summary.bots.reduce((s, b) => s + b.wins, 0);
    const gamesWithWinner = summary.games.filter((g) => g.seats.filter((s) => s.rank === 1).length === 1).length;
    expect(soleWins).toBe(gamesWithWinner);
    for (const g of summary.games) expect(g.seats.map((s) => s.rank)[0]).toBe(1);
    expect(gunner.errors + chaser.errors + gunner.invalid + chaser.invalid).toBe(0);
  }, 60_000);

  it('is deterministic for the same seed and shuffles seats per game', async () => {
    const strip = (s: Awaited<ReturnType<typeof runBatch>>) =>
      s.games.map((g) => ({ seed: g.seed, end: g.endTick, seats: g.seats.map((x) => [x.bot, x.rank, x.stats]) }));
    const a = await runBatch({ ...base, bots: ['gunner', 'chaser', 'random'] });
    const b = await runBatch({ ...base, bots: ['gunner', 'chaser', 'random'] });
    expect(strip(a)).toEqual(strip(b));
    const c = await runBatch({ ...base, seed: 'other', bots: ['gunner', 'chaser', 'random'] });
    expect(strip(c)).not.toEqual(strip(a));
  }, 60_000);

  it('writes replays that re-simulate exactly', async () => {
    const summary = await runBatch({ ...base, games: 2, bots: ['gunner', 'random'], replayDir });
    expect(readdirSync(replayDir)).toHaveLength(2);
    for (const g of summary.games) {
      expect(existsSync(g.replayFile!)).toBe(true);
      const replay = validateReplay(JSON.parse(readFileSync(g.replayFile!, 'utf8')));
      expect(replay.extras).toHaveLength(2);
      const check = new ReplayPlayer(replay).verifyAll();
      expect(check.desyncs).toEqual([]);
      expect(replay.result!.endTick).toBe(g.endTick);
    }
  }, 60_000);

  it('rejects bad input', async () => {
    await expect(runBatch({ ...base, bots: ['gunner'] })).rejects.toThrow(/at least 2 bots/);
    await expect(runBatch({ ...base, bots: ['gunner', 'missing'] })).rejects.toThrow(/Bot not found/);
    await expect(runBatch({ ...base, maps: ['moon'], bots: ['gunner', 'chaser'] })).rejects.toThrow(/Unknown map/);
    await expect(runBatch({ ...base, bots: Array(9).fill('gunner') })).rejects.toThrow(/At most 8/);
    expect(() => loadBot('network', join(ROOT, 'tests/fixtures/bots'))).toThrow(/static check[\s\S]*fetch/);
  });
});
