import { describe, expect, it } from 'vitest';
import { step } from '../../src/engine/game.ts';
import { act, place, testGame } from '../helpers.ts';

describe('movement', () => {
  it('moves at weapon speed per tick and reports velocity', () => {
    const s = testGame();
    place(s, 0, 500, 500);
    place(s, 1, 900, 900);
    step(s, [act({ moveX: 1 })]);
    expect(s.players[0].x).toBeCloseTo(500 + 210 / 30);
    expect(s.players[0].vx).toBeCloseTo(210);
    s.players[0].hasGun = true;
    s.players[0].weapon = 'gun';
    step(s, [act({ moveX: 1 })]);
    expect(s.players[0].x).toBeCloseTo(500 + 210 / 30 + 190 / 30);
  });

  it('clamps move vectors longer than 1', () => {
    const s = testGame();
    place(s, 0, 500, 500);
    step(s, [act({ moveX: 30, moveY: 40 })]);
    const d = Math.hypot(s.players[0].x - 500, s.players[0].y - 500);
    expect(d).toBeCloseTo(210 / 30);
  });

  it('walls block movement and let players slide along them', () => {
    const wall = { x: 520, y: 0, w: 40, h: 1000 };
    const s = testGame({ walls: [wall] });
    place(s, 0, 500, 500);
    for (let i = 0; i < 10; i++) step(s, [act({ moveX: 1, moveY: 1 })]);
    const p = s.players[0];
    expect(p.x).toBeCloseTo(520 - 16);
    expect(p.y).toBeGreaterThan(540); // kept sliding down
  });

  it('cannot leave the arena', () => {
    const s = testGame();
    place(s, 0, 20, 20);
    for (let i = 0; i < 10; i++) step(s, [act({ moveX: -1, moveY: -1 })]);
    expect(s.players[0].x).toBe(16);
    expect(s.players[0].y).toBe(16);
  });

  it('players cannot overlap', () => {
    const s = testGame();
    place(s, 0, 500, 500);
    place(s, 1, 540, 500);
    for (let i = 0; i < 20; i++) step(s, [act({ moveX: 1 }), act({ moveX: -1 })]);
    const [a, b] = s.players;
    expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThanOrEqual(32 - 1e-9);
  });

  it('separates perfectly stacked players', () => {
    const s = testGame();
    place(s, 0, 500, 500);
    place(s, 1, 500, 500);
    step(s, []);
    expect(Math.abs(s.players[0].x - s.players[1].x)).toBeCloseTo(32);
  });

  it('facing turns toward aim at the capped rate', () => {
    const s = testGame();
    place(s, 0, 500, 500, 0);
    const perTick = (540 * Math.PI) / 180 / 30;
    step(s, [act({ aim: Math.PI / 2 })]);
    expect(s.players[0].facing).toBeCloseTo(perTick);
    for (let i = 0; i < 10; i++) step(s, [act({ aim: Math.PI / 2 })]);
    expect(s.players[0].facing).toBeCloseTo(Math.PI / 2);
    // Takes the short way across ±PI.
    place(s, 0, 500, 500, Math.PI - 0.1);
    step(s, [act({ aim: -Math.PI + 0.1 })]);
    expect(s.players[0].facing).toBeCloseTo(-Math.PI + 0.1);
  });

  it('weapon switch requires a gun and blocks attacks briefly', () => {
    const s = testGame();
    place(s, 0, 500, 500);
    step(s, [act({ weapon: 'gun' })]);
    expect(s.players[0].weapon).toBe('knife');
    s.players[0].hasGun = true;
    s.players[0].ammo = 5;
    step(s, [act({ weapon: 'gun', attack: true })]);
    expect(s.players[0].weapon).toBe('gun');
    expect(s.players[0].ammo).toBe(5); // switching: can't fire yet
    const switchTicks = Math.round(0.3 * 30);
    for (let i = 0; i < switchTicks - 1; i++) step(s, [act({ attack: true })]);
    expect(s.players[0].ammo).toBe(5);
    step(s, [act({ attack: true })]);
    expect(s.players[0].ammo).toBe(4);
  });
});

describe('inertia', () => {
  // accelTime 0.3 s at 30 ticks/s: velocity changes by at most speed / 9 per tick.
  const inertia = () => testGame({ config: { player: { accelTime: 0.3 } } });

  it('reaches top speed after accelTime and brakes just as fast', () => {
    const s = inertia();
    place(s, 0, 300, 500);
    place(s, 1, 900, 900);
    step(s, [act({ moveX: 1 })]);
    expect(s.players[0].vx).toBeCloseTo(210 / 9);
    for (let i = 0; i < 8; i++) step(s, [act({ moveX: 1 })]);
    expect(s.players[0].vx).toBeCloseTo(210);
    step(s, [act({ moveX: 1 })]);
    expect(s.players[0].vx).toBeCloseTo(210);
    for (let i = 0; i < 4; i++) step(s, [act()]);
    expect(s.players[0].vx).toBeCloseTo(210 * 5 / 9);
    for (let i = 0; i < 5; i++) step(s, [act()]);
    expect(s.players[0].vx).toBeCloseTo(0);
  });

  it('turns gradually: reversing takes twice as long', () => {
    const s = inertia();
    place(s, 0, 500, 500);
    place(s, 1, 900, 900);
    for (let i = 0; i < 9; i++) step(s, [act({ moveX: 1 })]);
    for (let i = 0; i < 9; i++) step(s, [act({ moveX: -1 })]);
    expect(s.players[0].vx).toBeCloseTo(0);
    for (let i = 0; i < 9; i++) step(s, [act({ moveX: -1 })]);
    expect(s.players[0].vx).toBeCloseTo(-210);
  });

  it('loses speed against a wall', () => {
    const s = testGame({ walls: [{ x: 600, y: 0, w: 50, h: 1000 }], config: { player: { accelTime: 0.3 } } });
    place(s, 0, 500, 500);
    place(s, 1, 100, 900);
    for (let i = 0; i < 20; i++) step(s, [act({ moveX: 1 })]);
    expect(s.players[0].x).toBeCloseTo(600 - 16);
    expect(s.players[0].vx).toBeCloseTo(0);
    step(s, [act({ moveX: -1 })]); // starts from rest, not from a stored top speed
    expect(s.players[0].vx).toBeCloseTo(-210 / 9);
  });
});
