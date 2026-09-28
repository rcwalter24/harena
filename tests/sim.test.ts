import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ROOT, runBatch } from '../src/batch/batch.ts';

const OUT = join(ROOT, 'out', 'test-kit');
const KIT = join(OUT, 'harena-sim.mjs');

function kit(...args: string[]): string {
  return execFileSync(process.execPath, [KIT, ...args], { cwd: ROOT, encoding: 'utf8' });
}

describe('test kit (dist/harena-sim.mjs)', () => {
  beforeAll(() => {
    execFileSync(process.execPath, [join(ROOT, 'node_modules/vite/bin/vite.js'), 'build', '--config', 'vite.sim.config.ts', '--outDir', OUT, '--logLevel', 'error'], { cwd: ROOT });
  }, 60_000);
  afterAll(() => rmSync(OUT, { recursive: true, force: true }));

  it('plays exactly the games the batch runner plays', async () => {
    const out = JSON.parse(kit('bots/doubao.js', '--vs', 'gunner,chaser', '--games', '3', '--seed', 'kit', '--map', 'blocks,duel', '--json'));
    const batch = await runBatch({ bots: ['doubao', 'gunner', 'chaser'], maps: ['blocks', 'duel'], games: 3, seed: 'kit', concurrency: 2 });
    const pick = (b: { bot: string; wins: number; kills: number; deaths: number; damageDealt: number; shotsHit: number }) =>
      [b.bot.replace(/\.js$/, ''), b.wins, b.kills, b.deaths, b.damageDealt, b.shotsHit];
    expect(out.bots.map(pick).sort()).toEqual(batch.bots.map(pick).sort());
    expect(out.logs.doubao.problems).toEqual([]);
  }, 60_000);

  it('refuses a bot the static check would block, with the reasons', () => {
    let message = '';
    try {
      kit('tests/fixtures/bots/network.js');
    } catch (err) {
      message = String((err as { stderr?: string }).stderr);
    }
    expect(message).toMatch(/would be refused by Harena[\s\S]*fetch/);
  });

  it('reports what a failing bot did wrong', () => {
    const out = JSON.parse(kit('tests/fixtures/bots/throws.js', '--games', '1', '--seed', 'x', '--time-limit', '10', '--json'));
    expect(out.logs.throws.problems.join('\n')).toMatch(/decide\(\) threw: Error: boom/);
  }, 60_000);
});
