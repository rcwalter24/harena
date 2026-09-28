import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, mergeConfig } from '../../src/engine/config.ts';
import { createGame } from '../../src/engine/game.ts';
import { validateMap } from '../../src/engine/maps.ts';
import { BotController } from '../../src/match/supervisor.ts';
import { DummyController } from '../../src/match/dummies.ts';
import { MatchRunner } from '../../src/match/runner.ts';
import { createNodeWorker } from '../../src/sandbox/node/host.ts';

const EXAMPLES = ['random', 'chaser', 'gunner'];
let runner: MatchRunner | null = null;
afterEach(() => runner?.dispose());

async function play(files: string[], ticks: number, seed: string) {
  const map = validateMap(JSON.parse(readFileSync(new URL('../../maps/open.json', import.meta.url), 'utf8')));
  // Generous budget: CI machines vary, and this test is about behaviour, not speed.
  const config = mergeConfig(DEFAULT_CONFIG, { sandbox: { decideBudgetMs: 50, graceMs: 100 } });
  const state = createGame({ map, config, seed, timeLimit: 0, players: files.map((f, i) => ({ name: `${f} ${i}` })) });
  const bots = files.map((f, i) => new BotController({
    name: f, fileName: `${f}.js`, botSeed: `${seed}::bot${i}`, createWorker: createNodeWorker,
    source: readFileSync(new URL(`../../bots/${f}.js`, import.meta.url), 'utf8'),
  }));
  runner = new MatchRunner(state, bots);
  await runner.init();
  for (let i = 0; i < ticks; i++) await runner.tick();
  return { state, bots };
}

describe('example bots', () => {
  it('run without errors and actually fight', async () => {
    const { state, bots } = await play(EXAMPLES, 900, 'examples');
    for (const bot of bots) {
      expect(bot.status, bot.name).toBe('running');
      expect(bot.stats.errors + bot.stats.invalid, `${bot.name}: ${JSON.stringify(bot.logs.slice(-3))}`).toBe(0);
    }
    const damage = state.players.reduce((sum, p) => sum + p.stats.damageDealt, 0);
    expect(damage).toBeGreaterThan(0);
  }, 60_000);

  it('gunner walks around a wall to reach a target behind it instead of dithering', async () => {
    // From a replay: gunner stuck at a block's corner, the target standing still behind it.
    const map = validateMap(JSON.parse(readFileSync(new URL('../../maps/blocks.json', import.meta.url), 'utf8')));
    const config = mergeConfig(DEFAULT_CONFIG, { sandbox: { decideBudgetMs: 50, graceMs: 100 }, zone: { damagePerSecond: 0 }, items: { maxOnMap: 0 } });
    const state = createGame({ map, config, seed: 'corner', timeLimit: 0, players: [{ name: 'gunner' }, { name: 'target' }] });
    const [me, target] = state.players;
    Object.assign(me, { x: 905, y: 313, hasGun: true, ammo: 11, weapon: 'gun' });
    Object.assign(target, { x: 954, y: 189 });
    state.items = [];
    const bot = new BotController({
      name: 'gunner', fileName: 'gunner.js', botSeed: 'corner::bot0', createWorker: createNodeWorker,
      source: readFileSync(new URL('../../bots/gunner.js', import.meta.url), 'utf8'),
    });
    runner = new MatchRunner(state, [bot, new DummyController('idle')]);
    await runner.init();
    for (let i = 0; i < 150 && target.stats.damageTaken === 0; i++) await runner.tick();
    expect(target.stats.damageTaken).toBeGreaterThan(0);
  }, 60_000);

  it('gunner picks up a gun and lands shots', async () => {
    const { state } = await play(['gunner', 'random'], 900, 'gunner-test');
    const gunner = state.players[0];
    expect(gunner.stats.itemsByType.gun).toBeGreaterThan(0);
    expect(gunner.stats.shotsFired).toBeGreaterThan(0);
    expect(gunner.stats.shotsHit).toBeGreaterThan(0);
  }, 60_000);
});
