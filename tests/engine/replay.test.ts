import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, mergeConfig } from '../../src/engine/config.ts';
import { applyCheat } from '../../src/engine/debug.ts';
import { createGame } from '../../src/engine/game.ts';
import { hashState } from '../../src/engine/hash.ts';
import { validateMap } from '../../src/engine/maps.ts';
import { ReplayPlayer, ReplayRecorder, validateReplay, type Replay } from '../../src/engine/replay.ts';
import { Rng } from '../../src/engine/rng.ts';
import type { ActionInput } from '../../src/engine/types.ts';
import type { Controller } from '../../src/match/controller.ts';
import { DummyController } from '../../src/match/dummies.ts';
import { MatchRunner } from '../../src/match/runner.ts';

const map = validateMap(JSON.parse(readFileSync(new URL('../../maps/blocks.json', import.meta.url), 'utf8')));

/** Unquantized, human-like random input (the runner must normalize it). */
function chaos(seed: string): Controller {
  const rng = new Rng(seed);
  return {
    label: 'chaos',
    decide: (): ActionInput => ({
      moveX: rng.range(-1.5, 1.5), moveY: Math.SQRT1_2 * rng.range(-1, 1), aim: rng.range(-10, 10),
      attack: rng.next() < 0.3, plantMine: rng.next() < 0.02,
      weapon: rng.next() < 0.05 ? (['knife', 'gun', 'launcher', 'laser'] as const)[rng.int(4)] : null,
      throwKind: rng.next() < 0.02 ? (rng.next() < 0.5 ? 'smoke' : 'gas') : null,
      throwDistance: rng.next() < 0.5 ? rng.range(-50, 500) : null,
    }),
  };
}

async function recordMatch(opts: { ticks: number; cheatAt?: number } = { ticks: 900 }) {
  const config = mergeConfig(DEFAULT_CONFIG, { player: { startLives: 2 } });
  const players = ['a', 'b', 'c', 'd'].map((name) => ({ name }));
  const state = createGame({ map, config, seed: 'rec', timeLimit: 60, players });
  const controllers = [chaos('x'), chaos('y'), new DummyController('shooter'), new DummyController('brawler')];
  const runner = new MatchRunner(state, controllers);
  const recorder = new ReplayRecorder({
    seed: 'rec', timeLimit: 60, map, config,
    players: players.map((p) => ({ name: p.name, kind: 'dummy' as const })),
  });
  runner.recorder = recorder;
  await runner.init();
  for (let i = 0; i < opts.ticks && !state.over; i++) {
    if (i === opts.cheatAt && applyCheat(state, 0, 'arm')) recorder.recordCheat(state.tick, 0, 'arm');
    await runner.tick();
  }
  return { state, replay: recorder.finish(state, [{ note: 'extra' }]) };
}

const roundTrip = (r: Replay): Replay => validateReplay(JSON.parse(JSON.stringify(r)));

describe('replays', () => {
  it('re-simulate a recorded match exactly after a JSON round trip', async () => {
    const { state, replay } = await recordMatch({ ticks: 1200 });
    const player = new ReplayPlayer(roundTrip(replay));
    const check = player.verifyAll();
    expect(check.desyncs).toEqual([]);
    expect(check.finalHash).toBe(hashState(state));
    expect(player.state.result).toEqual(state.result);
    expect(replay.extras).toEqual([{ note: 'extra' }]);
    // Combat actually happened, so the check is meaningful.
    expect(state.players.some((p) => p.stats.deaths > 0)).toBe(true);
  });

  it('are compact: identical consecutive actions are run-length encoded', async () => {
    const { replay } = await recordMatch({ ticks: 300 });
    const dummyRuns = replay.actions[2].length;
    expect(dummyRuns).toBeLessThan(300);
    expect(replay.actions.every((runs) => runs.reduce((s, r) => s + r[0], 0) === replay.ticks)).toBe(true);
  });

  it('record debug cheats so they replay identically', async () => {
    const { state, replay } = await recordMatch({ ticks: 400, cheatAt: 50 });
    expect(replay.cheats).toEqual([{ tick: 50, playerId: 0, kind: 'arm' }]);
    expect(new ReplayPlayer(roundTrip(replay)).verifyAll()).toMatchObject({ ok: true, finalHash: hashState(state) });
    const withoutCheat = { ...roundTrip(replay), cheats: [] };
    expect(new ReplayPlayer(withoutCheat).verifyAll().ok).toBe(false);
  });

  it('detect tampering through checksums', async () => {
    const { replay } = await recordMatch({ ticks: 300 });
    const tampered = roundTrip(replay);
    const run = tampered.actions[0][Math.floor(tampered.actions[0].length / 2)];
    run[1] = run[1] === 1 ? -1 : 1;
    const check = new ReplayPlayer(tampered).verifyAll();
    expect(check.ok).toBe(false);
    expect(check.desyncs.length).toBeGreaterThan(0);
  });

  it('seeking forwards and backwards gives the same state as playing through', async () => {
    const { replay } = await recordMatch({ ticks: 600 });
    const linear = new ReplayPlayer(replay);
    const hashes = new Map<number, string>();
    while (!linear.done) {
      linear.stepOnce();
      hashes.set(linear.state.tick, hashState(linear.state));
    }
    const seeker = new ReplayPlayer(replay);
    for (const t of [400, 120, 599, 1, 300]) {
      seeker.seek(t);
      expect(seeker.state.tick).toBe(t);
      expect(hashState(seeker.state)).toBe(hashes.get(t));
    }
    expect(seeker.desyncs).toEqual([]);
  });

  it('reject malformed files', async () => {
    const { replay } = await recordMatch({ ticks: 60 });
    expect(() => validateReplay(null)).toThrow(/not an object/);
    expect(() => validateReplay({ ...replay, format: 'x' })).toThrow(/format/);
    expect(() => validateReplay({ ...replay, version: 99 })).toThrow(/version/);
    expect(() => validateReplay({ ...replay, ticks: replay.ticks + 1 })).toThrow(/every tick/);
    expect(() => validateReplay({ ...replay, actions: [] })).toThrow(/players/);
  });
});
