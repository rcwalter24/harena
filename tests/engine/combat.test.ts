import { describe, expect, it } from 'vitest';
import { step } from '../../src/engine/game.ts';
import { act, place, testGame, vulnerable } from '../helpers.ts';

describe('knife', () => {
  it('hits a target in front within reach', () => {
    const s = testGame();
    place(s, 0, 500, 500, 0);
    place(s, 1, 560, 500);
    step(s, [act({ attack: true })]);
    expect(s.players[1].hp).toBe(100 - 35);
    expect(s.players[0].stats.knifeHits).toBe(1);
    expect(s.players[0].stats.damageDealt).toBe(35);
  });

  it('misses beyond reach, behind, and through walls', () => {
    const reach = 2 * 16 + 36;
    const far = testGame();
    place(far, 0, 500, 500, 0);
    place(far, 1, 500 + reach + 1, 500);
    step(far, [act({ attack: true })]);
    expect(far.players[1].hp).toBe(100);

    const behind = testGame();
    place(behind, 0, 500, 500, 0);
    place(behind, 1, 450, 500);
    step(behind, [act({ attack: true })]);
    expect(behind.players[1].hp).toBe(100);

    const walled = testGame({ walls: [{ x: 530, y: 400, w: 4, h: 200 }] });
    place(walled, 0, 500, 500, 0);
    place(walled, 1, 566, 500);
    step(walled, [act({ attack: true })]);
    expect(walled.players[1].hp).toBe(100);
  });

  it('respects the arc edge', () => {
    const half = (100 / 2) * (Math.PI / 180);
    const inside = testGame();
    place(inside, 0, 500, 500, 0);
    place(inside, 1, 500 + 50 * Math.cos(half - 0.05), 500 + 50 * Math.sin(half - 0.05));
    step(inside, [act({ attack: true })]);
    expect(inside.players[1].hp).toBeLessThan(100);

    const outside = testGame();
    place(outside, 0, 500, 500, 0);
    place(outside, 1, 500 + 50 * Math.cos(half + 0.05), 500 + 50 * Math.sin(half + 0.05));
    step(outside, [act({ attack: true })]);
    expect(outside.players[1].hp).toBe(100);
  });

  it('has a cooldown', () => {
    const s = testGame();
    place(s, 0, 500, 500, 0);
    place(s, 1, 560, 500);
    const cd = Math.round(0.5 * 30);
    for (let i = 0; i < cd; i++) step(s, [act({ attack: true })]);
    expect(s.players[1].hp).toBe(65);
    step(s, [act({ attack: true })]);
    expect(s.players[1].hp).toBe(30);
  });

  it('shield absorbs damage before health', () => {
    const s = testGame();
    place(s, 0, 500, 500, 0);
    place(s, 1, 560, 500);
    s.players[1].shield = 20;
    step(s, [act({ attack: true })]);
    expect(s.players[1].shield).toBe(0);
    expect(s.players[1].hp).toBe(85);
  });

  it('invulnerable players take no damage; attacking ends invulnerability', () => {
    const s = testGame();
    place(s, 0, 500, 500, 0);
    place(s, 1, 560, 500, Math.PI);
    s.players[0].invulnerableTimer = 30;
    s.players[1].invulnerableTimer = 30;
    step(s, [act({ attack: true })]);
    expect(s.players[1].hp).toBe(100);
    expect(s.players[0].invulnerableTimer).toBe(0);
    step(s, [act(), act({ attack: true })]);
    expect(s.players[0].hp).toBe(65);
  });
});

describe('gun', () => {
  function gunner() {
    const s = testGame();
    vulnerable(s);
    place(s, 0, 200, 500, 0);
    place(s, 1, 800, 500);
    Object.assign(s.players[0], { hasGun: true, weapon: 'gun', ammo: 3 });
    return s;
  }

  it('fires a bullet that travels and hits', () => {
    const s = gunner();
    step(s, [act({ attack: true })]);
    expect(s.players[0].ammo).toBe(2);
    expect(s.bullets).toHaveLength(1);
    expect(s.bullets[0].x).toBeCloseTo(200 + 480 / 30);
    let ticks = 1;
    while (s.bullets.length > 0 && ticks < 100) {
      step(s, []);
      ticks++;
    }
    expect(s.players[1].hp).toBe(80);
    expect(s.players[0].stats.shotsHit).toBe(1);
    // ~ (600 - 16 - 4) / 16 per tick ≈ 37 ticks of flight.
    expect(ticks).toBeGreaterThan(30);
    expect(ticks).toBeLessThan(45);
  });

  it('respects cooldown and ammo', () => {
    const s = gunner();
    const cd = Math.round(0.35 * 30);
    for (let i = 0; i < cd * 5; i++) step(s, [act({ attack: true })]);
    expect(s.players[0].stats.shotsFired).toBe(3);
    expect(s.players[0].ammo).toBe(0);
  });

  it('bullets are stopped by walls', () => {
    const s = testGame({ walls: [{ x: 480, y: 0, w: 20, h: 1000 }] });
    place(s, 0, 200, 500, 0);
    place(s, 1, 800, 500);
    Object.assign(s.players[0], { hasGun: true, weapon: 'gun', ammo: 3 });
    step(s, [act({ attack: true })]);
    for (let i = 0; i < 60; i++) step(s, []);
    expect(s.bullets).toHaveLength(0);
    expect(s.players[1].hp).toBe(100);
  });

  it('the map border stops bullets', () => {
    const s = testGame();
    place(s, 0, 100, 500, Math.PI); // facing the left edge
    place(s, 1, 900, 900);
    Object.assign(s.players[0], { hasGun: true, weapon: 'gun', ammo: 1 });
    step(s, [act({ attack: true })]);
    let end: any = null;
    for (let i = 0; i < 20 && !end; i++) {
      for (const e of step(s, [])) if (e.type === 'bulletEnd') end = e;
    }
    expect(end).toMatchObject({ reason: 'wall' });
    expect(end.x).toBeCloseTo(4); // bullet radius from the edge
    expect(s.bullets).toHaveLength(0);
  });

  it('bullets expire at max range', () => {
    const s = testGame();
    place(s, 0, 20, 20, 0);
    place(s, 1, 20, 900);
    Object.assign(s.players[0], { hasGun: true, weapon: 'gun', ammo: 1 });
    step(s, [act({ attack: true })]);
    let maxX = 0;
    for (let i = 0; i < 100 && s.bullets.length; i++) {
      maxX = Math.max(maxX, s.bullets[0].x);
      step(s, []);
    }
    expect(s.bullets).toHaveLength(0);
    expect(maxX).toBeLessThanOrEqual(20 + 900 + 1e-6);
    expect(maxX).toBeGreaterThan(20 + 900 - 480 / 30);
  });

  it('a moving target can dodge a slow bullet', () => {
    const s = gunner();
    step(s, [act({ attack: true })]);
    for (let i = 0; i < 60; i++) step(s, [act(), act({ moveY: 1 })]);
    expect(s.players[1].hp).toBe(100);
  });

  it('does not hit its owner', () => {
    const s = gunner();
    step(s, [act({ attack: true, moveX: 1 })]);
    for (let i = 0; i < 5; i++) step(s, [act({ moveX: 1 })]);
    expect(s.players[0].hp).toBe(100);
  });
});
