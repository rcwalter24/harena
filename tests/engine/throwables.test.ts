import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../../src/engine/config.ts';
import { step } from '../../src/engine/game.ts';
import { resolveExplosions } from '../../src/engine/systems/explosives.ts';
import { validateReplay } from '../../src/engine/replay.ts';
import { buildBotState, viewForPlayer } from '../../src/engine/snapshot.ts';
import { cloudRadius, insideCloud } from '../../src/engine/systems/throwables.ts';
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
    for (let i = 0; i < 30; i++) step(s, []); // let it spread to full size
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
    expect(view).toMatchObject({ kind: 'smoke', ownerId: 0, fullRadius: smoke.radius, nextDamageIn: null });
    expect(view.radius).toBeLessThan(smoke.radius / 10); // it has only just started to spread
    expect(view.timeLeft).toBeCloseTo(smoke.duration, 1);
    for (let i = 0; i < smoke.duration * 30; i++) step(s, []);
    expect(s.clouds).toHaveLength(0);
  });

  it('spread to full size over the spread time', () => {
    const s = testGame();
    place(s, 0, 200, 500, 0);
    throwAndSettle(s, 0, 'gas', 200);
    const c = s.clouds[0];
    expect(cloudRadius(s, c)).toBeLessThan(gas.radius / 10);
    const spread = throwing.spreadTime * 30;
    for (let i = 0; i < spread / 2; i++) step(s, []);
    expect(cloudRadius(s, c)).toBeCloseTo((gas.radius * (c.age + 1)) / spread, 6); // linear growth
    for (let i = 0; i < spread; i++) step(s, []);
    expect(cloudRadius(s, c)).toBe(gas.radius);
  });

  it("don't pass through walls, but flow around corners", () => {
    // Wall from y = 450 down to the bottom; the cloud sits left of it, near its top end.
    const s = testGame({ walls: [{ x: 500, y: 450, w: 40, h: 550 }] });
    place(s, 0, 300, 480, 0);
    throwAndSettle(s, 0, 'smoke', 180); // stops at (480, 480)
    for (let i = 0; i < 40; i++) step(s, []);
    const c = s.clouds[0];
    expect(insideCloud(s, c, 550, 460)).toBe(true); // just around the top corner (≈ 91 u of path)
    expect(insideCloud(s, c, 550, 540)).toBe(false); // straight through the wall: within the radius, but no way around
    expect(Math.hypot(550 - c.x, 540 - c.y)).toBeLessThan(smoke.radius);
    const plain = testGame({ walls: [{ x: 500, y: 450, w: 40, h: 550 }], config: { throwing: { cloudsAroundCorners: 0 } } });
    expect(insideCloud(plain, c, 550, 540)).toBe(true);
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

describe('explosions and clouds', () => {
  it('blow a hole in smoke and gas that closes over clearTime', () => {
    const s = testGame();
    place(s, 0, 200, 500, 0);
    throwAndSettle(s, 0, 'smoke', 200); // cloud at (400, 500)
    for (let i = 0; i < 40; i++) step(s, []);
    const c = s.clouds[0];
    expect(insideCloud(s, c, 400, 500)).toBe(true);
    resolveExplosions(s, [{ ownerId: 1, source: 'grenade', sourceId: 99, x: 420, y: 500, radius: DEFAULT_CONFIG.launcher.blastRadius }]);
    expect(c.holes).toHaveLength(1);
    expect(insideCloud(s, c, 400, 500)).toBe(false); // blown clear
    expect(insideCloud(s, c, 400, 600)).toBe(true); // out of the blast's reach: still smoky
    expect(buildBotState(s).clouds[0].holes[0]).toMatchObject({ x: 420, y: 500 });
    const close = DEFAULT_CONFIG.explosions.clearTime * 30;
    for (let i = 0; i < close * 0.8; i++) step(s, []);
    // The hole shrinks toward the blast point: at 80% of clearTime it is 20% of its size, so 20 u away is smoky again.
    expect(insideCloud(s, c, 400, 500)).toBe(true);
    for (let i = 0; i < close; i++) step(s, []);
    expect(c.holes).toHaveLength(0);
  });

  it('a gas hole means no gas damage there', () => {
    const s = testGame();
    place(s, 0, 200, 500, 0);
    place(s, 1, 400, 520);
    throwAndSettle(s, 0, 'gas', 200);
    for (let i = 0; i < 20; i++) step(s, []);
    const hp = s.players[1].hp;
    s.clouds[0].holes = [{ x: 400, y: 520, radius: 60, age: 0 }];
    const untilHit = 30 - (s.clouds[0].age % 30);
    for (let i = 0; i < untilHit; i++) step(s, []);
    expect(s.players[1].hp).toBe(hp);
  });
});
