import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, rmSync } from 'node:fs';
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

  it('ships only the three example bots, not the competition', () => {
    expect(kit('--list')).toMatch(/^Built-in bots: chaser, gunner, random$/m);
    const bundle = readFileSync(KIT, 'utf8');
    for (const other of readdirSync(join(ROOT, 'bots')).filter((f) => f.endsWith('.js') && !['random.js', 'chaser.js', 'gunner.js'].includes(f))) {
      const meta = /export const meta = \{[^}]*\}/.exec(readFileSync(join(ROOT, 'bots', other), 'utf8'))?.[0];
      if (meta) expect(bundle.includes(meta), `${other} must not be in the kit`).toBe(false);
    }
  });

  it('a stuck bot loses about real time, not the rest of the match (as in a live game)', () => {
    // hang.js loops forever from its second tick: 1 s of silence → restart → again → disabled.
    const out = JSON.parse(kit('tests/fixtures/bots/hang.js', '--games', '1', '--seed', 'h', '--time-limit', '30', '--json'));
    const problems: string[] = out.logs.hang.problems;
    const skipped = Number(/tick skipped \(×(\d+)\)/.exec(problems.join('\n'))?.[1] ?? 0);
    expect(skipped).toBeGreaterThan(20); // it did miss ticks while stuck…
    expect(skipped).toBeLessThan(150); // …about 2 s worth, not the whole 900-tick match
    expect(problems.join('\n')).toMatch(/restarted/);
    expect(problems.join('\n')).toMatch(/disabled/);
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
