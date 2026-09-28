import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, mergeConfig } from '../../src/engine/config.ts';
import { createGame } from '../../src/engine/game.ts';
import { hashState } from '../../src/engine/hash.ts';
import { validateMap } from '../../src/engine/maps.ts';
import { ReplayPlayer, ReplayRecorder, validateReplay } from '../../src/engine/replay.ts';
import { BotController } from '../../src/match/supervisor.ts';
import { MatchRunner } from '../../src/match/runner.ts';
import { createNodeWorker } from '../../src/sandbox/node/host.ts';

let runner: MatchRunner | null = null;
afterEach(() => runner?.dispose());

describe('replay of a real bot match', () => {
  it('reproduces the match from the recorded actions alone', async () => {
    const map = validateMap(JSON.parse(readFileSync(new URL('../../maps/corridors.json', import.meta.url), 'utf8')));
    const config = mergeConfig(DEFAULT_CONFIG, { sandbox: { decideBudgetMs: 50, graceMs: 100 } });
    const files = ['gunner', 'gunner', 'chaser', 'random'];
    const state = createGame({ map, config, seed: 'bots', timeLimit: 40, players: files.map((f, i) => ({ name: `${f}${i}` })) });
    runner = new MatchRunner(state, files.map((f, i) => new BotController({
      name: f, fileName: `${f}.js`, botSeed: `bots::bot${i}`, createWorker: createNodeWorker,
      source: readFileSync(new URL(`../../bots/${f}.js`, import.meta.url), 'utf8'),
    })));
    const recorder = new ReplayRecorder({ seed: 'bots', timeLimit: 40, map, config, players: files.map((f, i) => ({ name: `${f}${i}`, kind: 'bot', source: `${f}.js` })) });
    runner.recorder = recorder;
    await runner.init();
    while (!state.over) await runner.tick();
    const replay = validateReplay(JSON.parse(JSON.stringify(recorder.finish(state))));
    const player = new ReplayPlayer(replay);
    const check = player.verifyAll();
    expect(check.desyncs).toEqual([]);
    expect(check.finalHash).toBe(hashState(state));
    expect(player.state.result).toEqual(state.result);
    expect(JSON.stringify(replay).length).toBeLessThan(2_000_000);
  }, 60_000);
});
