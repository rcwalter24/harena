import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../../src/engine/config.ts';
import { step } from '../../src/engine/game.ts';
import { validateReplay } from '../../src/engine/replay.ts';
import { buildBotState, viewForPlayer } from '../../src/engine/snapshot.ts';
import { isVisibleTo } from '../../src/engine/systems/visibility.ts';
import type { GameState, ThrowKind } from '../../src/engine/types.ts';
import { act, place, testGame } from '../helpers.ts';

const { gas, smoke, throwing } = DEFAULT_CONFIG;

/** Throw from wherever player `id` stands, then run until the grenade has stopped. */
function throwAndSettle(s: GameState, id: number, kind: ThrowKind, distance: number | null = null): void {
  Object.assign(s.players[id], { smokes: 2, gases: 2 });
  const actions = s.players.map(() => act());
  actions[id] = act({ throwKind: kind, throwDistance: distance });
  step(s, actions);
  for (let i = 0; i < 120 && s.throwables.length > 0; i++) step(s, []);
}

describe('smoke and gas grenades', () => {
  it('slide exactly the chosen distance along the facing, up to the maximum', () => {
    const s = testGame();
    place(s, 0, 200, 500, 0);
    throwAndSettle(s, 0, 'smoke', 200);
    expect(s.clouds).toHaveLength(1);
    expect(s.clouds[0].x).toBeCloseTo(400, 6);
    expect(s.clouds[0].y).toBeCloseTo(500, 6);
    expect(s.players[0].smokes).toBe(1);

    const far = testGame();
    place(far, 0, 100, 300, Math.PI / 2); // facing down
    throwAndSettle(far, 0, 'gas', 5000);
    expect(far.clouds[0].y).toBeCloseTo(300 + throwing.maxDistance, 6);
  });

  it('bounce off walls, losing speed', () => {
    const s = testGame({ walls: [{ x: 300, y: 0, w: 40, h: 1000 }] });
    place(s, 0, 200, 500, 0);
    throwAndSettle(s, 0, 'smoke', 300);
    const c = s.clouds[0];
    // It reaches the wall face (x = 300 − radius), comes back, and stops short of where it started.
    expect(c.x).toBeLessThan(300 - throwing.radius);
    expect(c.x).toBeGreaterThan(200);
  });

  it('smoke hides whoever is inside from players outside, like a bush', () => {
    const s = testGame({ players: 3 });
    place(s, 0, 200, 500, 0);
    place(s, 1, 700, 200);
    place(s, 2, 700, 800);
    throwAndSettle(s, 0, 'smoke', 150);
    const c = s.clouds[0];
    place(s, 2, c.x + 20, c.y); // step into the smoke
    s.players[2].noiseTimer = 0;
    s.players[0].x = 100; // thrower walks away, beyond the reveal distance
    expect(isVisibleTo(s, s.players[1], s.players[2])).toBe(false);
    expect(viewForPlayer(s, buildBotState(s), 1).players[2].visible).toBe(false);
    place(s, 1, c.x - 30, c.y + 30); // inside the same smoke: visible
    expect(isVisibleTo(s, s.players[1], s.players[2])).toBe(true);
  });

  it('gas hurts everyone inside (the thrower too) every whole second, and slows them', () => {
    const s = testGame();
    place(s, 0, 300, 500, 0);
    place(s, 1, 450, 500);
    throwAndSettle(s, 0, 'gas', 150);
    place(s, 0, 430, 470); // walk into your own gas
    const before = s.players.map((p) => p.hp);
    const cloud = s.clouds[0];
    const untilHit = 30 - (cloud.age % 30);
    for (let i = 0; i < untilHit; i++) step(s, []);
    expect(s.players[1].hp).toBe(before[1] - gas.damagePerSecond);
    expect(s.players[0].hp).toBe(before[0] - gas.damagePerSecond);

    // Slowed: one tick of full-speed movement inside the cloud covers (1 − slow) of the normal distance.
    const x0 = s.players[1].x;
    step(s, [act(), act({ moveX: 1 })]);
    expect(s.players[1].x - x0).toBeCloseTo((DEFAULT_CONFIG.player.speedKnife * (1 - gas.slow)) / 30, 6);
  });

  it('clouds vanish after their duration; bots see thrown grenades and clouds', () => {
    const s = testGame();
    place(s, 0, 200, 500, 0);
    Object.assign(s.players[0], { smokes: 1 });
    step(s, [act({ throwKind: 'smoke' })]);
    expect(buildBotState(s).thrown).toHaveLength(1);
    for (let i = 0; i < 120 && s.throwables.length > 0; i++) step(s, []);
    const view = buildBotState(s).clouds[0];
    expect(view).toMatchObject({ kind: 'smoke', ownerId: 0, radius: smoke.radius, nextDamageIn: null });
    expect(view.timeLeft).toBeCloseTo(smoke.duration, 1);
    for (let i = 0; i < smoke.duration * 30; i++) step(s, []);
    expect(s.clouds).toHaveLength(0);
  });

  it('old replays load with smoke and gas off', () => {
    const { throwing: _t, smoke: _s, gas: _g, ...oldConfig } = DEFAULT_CONFIG;
    const { smoke: _ws, gas: _wg, ...oldWeights } = DEFAULT_CONFIG.items.weights;
    const replay = validateReplay({
      format: 'harena-replay', version: 1, seed: 's', timeLimit: 0, ticks: 0, map: testGame().map,
      config: { ...oldConfig, items: { ...oldConfig.items, weights: oldWeights } },
      players: [{ name: 'A', kind: 'dummy', source: 'idle' }], actions: [[]], createdAt: '',
    });
    expect(replay.config.items.weights).toMatchObject({ smoke: 0, gas: 0 });
    expect(replay.config.smoke.maxCarry).toBe(0);
    expect(replay.config.gas.maxCarry).toBe(0);
  });
});
