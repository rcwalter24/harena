import { describe, expect, it } from 'vitest';
import { createGame, step } from '../../src/engine/game.ts';
import { hashState } from '../../src/engine/hash.ts';
import { Rng } from '../../src/engine/rng.ts';
import type { ActionInput } from '../../src/engine/types.ts';
import openMap from '../../maps/open.json';
import { validateMap } from '../../src/engine/maps.ts';

/** Run a match with pseudo-random scripted inputs and return per-tick hashes. */
function simulate(seed: string, inputSeed: string, ticks = 600): string[] {
  const state = createGame({
    map: validateMap(structuredClone(openMap)),
    players: Array.from({ length: 6 }, (_, i) => ({ name: `P${i}` })),
    seed,
    timeLimit: 0,
  });
  for (const p of state.players) {
    p.hasGun = true;
    p.ammo = 40;
  }
  const input = new Rng(inputSeed);
  const hashes: string[] = [];
  let events = 0;
  for (let t = 0; t < ticks; t++) {
    const actions: ActionInput[] = state.players.map(() => ({
      moveX: input.range(-1, 1),
      moveY: input.range(-1, 1),
      aim: input.range(-4, 4),
      attack: input.next() < 0.3,
      weapon: input.next() < 0.05 ? (input.next() < 0.5 ? 'gun' : 'knife') : null,
      throwKind: null,
      throwDistance: null,
      plantMine: false,
    }));
    events += step(state, actions).filter((e) => e.type === 'hit' || e.type === 'death').length;
    hashes.push(hashState(state));
  }
  // Sanity check: the scripted chaos should include some combat, or the test proves little.
  if (ticks >= 600 && events === 0) throw new Error('no combat happened');
  return hashes;
}

describe('determinism', () => {
  it('same seed and inputs give identical states every tick', () => {
    expect(simulate('abc', 'inputs')).toEqual(simulate('abc', 'inputs'));
  });

  it('different seeds diverge', () => {
    expect(simulate('abc', 'inputs', 5).at(-1)).not.toEqual(simulate('xyz', 'inputs', 5).at(-1));
  });

});

describe('rng', () => {
  it('is reproducible and roughly uniform', () => {
    const a = new Rng(42);
    const b = new Rng(42);
    let sum = 0;
    for (let i = 0; i < 10000; i++) {
      const x = a.next();
      expect(x).toBe(b.next());
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
      sum += x;
    }
    expect(sum / 10000).toBeGreaterThan(0.48);
    expect(sum / 10000).toBeLessThan(0.52);
  });
});
