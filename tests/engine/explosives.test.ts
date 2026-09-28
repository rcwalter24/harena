import { DEFAULT_CONFIG } from '../../src/engine/config.ts';
import { describe, expect, it } from 'vitest';
import { step } from '../../src/engine/game.ts';
import { blastDamage, blastDamageAt } from '../../src/engine/systems/explosives.ts';
import { buildBotState } from '../../src/engine/snapshot.ts';
import type { GameState } from '../../src/engine/types.ts';
import { act, place, testGame } from '../helpers.ts';

const FUSE = Math.round(2.5 * 30);

function armLauncher(s: GameState, id: number, grenades = 3): void {
  Object.assign(s.players[id], { hasLauncher: true, weapon: 'launcher', grenades });
}

function runUntilQuiet(s: GameState, max = 200): void {
  for (let i = 0; i < max && (s.grenades.length > 0 || s.mines.length > 0); i++) step(s, []);
}

describe('grenade launcher', () => {
  it('fires a grenade that explodes on hitting a player, with full centre damage minus falloff', () => {
    // Damage pinned below lethal so the falloff is measurable, whatever the tuned defaults are.
    const s = testGame({ config: { launcher: { centerDamage: 70, edgeDamage: 20 } } });
    place(s, 0, 200, 500, 0);
    place(s, 1, 500, 500);
    armLauncher(s, 0);
    step(s, [act({ attack: true })]);
    expect(s.players[0].grenades).toBe(2);
    expect(s.grenades).toHaveLength(1);
    runUntilQuiet(s);
    // Contact happens at (radius 16 + grenade 6) from the target centre → 6 u from its edge.
    const expected = blastDamage(70, 20, 80, 22 - 16);
    expect(s.players[1].hp).toBe(100 - expected);
    expect(s.players[0].hp).toBe(100); // shooter far away
    expect(s.players[0].stats.grenadeHits).toBe(1);
  });

  it('explodes on walls and at max range', () => {
    const wall = testGame({ walls: [{ x: 400, y: 0, w: 20, h: 1000 }] });
    place(wall, 0, 200, 500, 0);
    place(wall, 1, 370, 560); // beside the path, near the wall
    armLauncher(wall, 0);
    step(wall, [act({ attack: true })]);
    let wallBlast: { x: number } | null = null;
    for (let i = 0; i < 100 && !wallBlast; i++) {
      for (const e of step(wall, [])) if (e.type === 'explosion') wallBlast = e;
    }
    expect(wallBlast!.x).toBeCloseTo(400 - 6); // stops at the wall face, grenade radius away
    expect(wall.players[1].hp).toBeLessThan(100); // ~49 u from the blast, caught in it

    const range = testGame();
    place(range, 0, 20, 20, 0);
    place(range, 1, 20, 900);
    armLauncher(range, 0);
    step(range, [act({ attack: true })]);
    let blastX = 0;
    for (let i = 0; i < 100 && blastX === 0; i++) {
      for (const e of step(range, [])) if (e.type === 'explosion') blastX = e.x;
    }
    expect(blastX).toBeCloseTo(20 + 700);
  });

  it('respects cooldown and ammo, and moves at launcher speed', () => {
    const s = testGame();
    place(s, 0, 200, 200, 0);
    place(s, 1, 900, 900);
    armLauncher(s, 0, 2);
    for (let i = 0; i < 100; i++) step(s, [act({ attack: true })]);
    expect(s.players[0].stats.grenadesFired).toBe(2);
    const x = s.players[0].x;
    step(s, [act({ moveX: 1 })]);
    expect(s.players[0].x - x).toBeCloseTo(180 / 30);
  });
});

describe('explosions', () => {
  it('blastDamage falls off linearly and is 0 outside the radius', () => {
    expect(blastDamage(70, 20, 80, 0)).toBe(70);
    expect(blastDamage(70, 20, 80, -5)).toBe(70);
    expect(blastDamage(70, 20, 80, 40)).toBe(45);
    expect(blastDamage(70, 20, 80, 80)).toBe(20);
    expect(blastDamage(70, 20, 80, 80.1)).toBe(0);
  });

  it('walls shield players from blasts', () => {
    const s = testGame({ walls: [{ x: 540, y: 400, w: 10, h: 200 }] });
    place(s, 0, 500, 500);
    place(s, 1, 580, 500);
    s.players[0].mines = 1;
    step(s, [act({ plantMine: true })]);
    place(s, 0, 100, 100); // step away
    for (let i = 0; i < FUSE; i++) step(s, []);
    expect(s.mines).toHaveLength(0);
    expect(s.players[1].hp).toBe(100);
  });

  it('owners take full damage from their own explosives; dying to one is a suicide', () => {
    const s = testGame();
    place(s, 0, 500, 500);
    place(s, 1, 900, 900);
    s.players[0].mines = 1;
    s.players[0].hp = 50;
    s.players[0].lastDamagerId = 1; // earlier damage by someone else doesn't earn them the kill
    step(s, [act({ plantMine: true })]);
    let death: any = null;
    for (let i = 0; i < FUSE && !death; i++) {
      for (const e of step(s, [])) if (e.type === 'death') death = e;
    }
    expect(death).toMatchObject({ playerId: 0, killerId: -1, weapon: 'mine' });
    expect(s.players[1].stats.kills).toBe(0);
    expect(s.players[0].stats.damageDealt).toBe(0);
  });
});

describe('mines', () => {
  it('explode exactly after the fuse, and are planted whatever weapon is held', () => {
    const s = testGame({ config: { mines: { centerDamage: 90, edgeDamage: 25 } } });
    place(s, 0, 500, 500);
    place(s, 1, 560, 500);
    Object.assign(s.players[0], { mines: 2, hasGun: true, weapon: 'gun', switchTimer: 5 });
    step(s, [act({ plantMine: true })]);
    expect(s.mines).toHaveLength(1);
    expect(s.players[0].mines).toBe(1);
    place(s, 0, 100, 100);
    for (let i = 0; i < FUSE - 1; i++) step(s, []);
    expect(s.mines).toHaveLength(1);
    expect(s.players[1].hp).toBe(100);
    const events = step(s, []);
    expect(events.some((e) => e.type === 'explosion' && e.source === 'mine')).toBe(true);
    // 60 u centre distance → 44 u from the edge.
    expect(s.players[1].hp).toBe(100 - blastDamage(90, 25, 100, 44));
  });

  it('chain reactions detonate other mines in radius immediately, and only those', () => {
    const s = testGame({ players: 2 });
    place(s, 0, 100, 100);
    place(s, 1, 900, 900);
    s.mines.push(
      { id: 901, ownerId: 0, x: 500, y: 500, fuseTimer: 0 },
      { id: 902, ownerId: 1, x: 580, y: 500, fuseTimer: 50 }, // within 100 of the first
      { id: 903, ownerId: 1, x: 670, y: 500, fuseTimer: 50 }, // within 100 of the second only
      { id: 904, ownerId: 1, x: 800, y: 500, fuseTimer: 50 }, // too far from all
    );
    const events = step(s, []);
    const blasts = events.filter((e) => e.type === 'explosion').map((e) => (e as any).sourceId);
    expect(blasts).toEqual([901, 902, 903]);
    expect(s.mines.map((m) => m.id)).toEqual([904]);
  });

  it('mines outlive their owner and still credit them', () => {
    const s = testGame({ players: 3 });
    place(s, 0, 500, 500);
    place(s, 1, 540, 500);
    place(s, 2, 900, 900);
    s.players[0].mines = 1;
    s.players[1].hp = 10;
    step(s, [act({ plantMine: true })]);
    place(s, 0, 100, 100);
    s.players[0].hp = 0; // owner dies (no attacker)
    step(s, []);
    expect(s.players[0].alive).toBe(false);
    for (let i = 0; i < FUSE; i++) step(s, []);
    expect(s.players[1].stats.deaths).toBe(1);
    expect(s.players[0].stats.kills).toBe(1);
  });

  it('respect the plant cooldown', () => {
    const s = testGame();
    place(s, 0, 500, 500);
    s.players[0].mines = 3;
    step(s, [act({ plantMine: true })]);
    step(s, [act({ plantMine: true })]);
    expect(s.mines).toHaveLength(1);
  });
});

describe('drops and pickups', () => {
  it('death drops gun, launcher and mines with their ammo', () => {
    const s = testGame();
    place(s, 0, 500, 500, 0);
    place(s, 1, 560, 500);
    Object.assign(s.players[1], { hp: 10, hasGun: true, ammo: 7, hasLauncher: true, grenades: 2, mines: 3 });
    step(s, [act({ attack: true })]);
    const drops = s.items.filter((i) => i.origin === 'drop').map((i) => [i.type, i.ammo]);
    expect(drops).toEqual([['gun', 7], ['launcher', 2], ['mines', 3]]);
    expect(s.players[1]).toMatchObject({ hasGun: false, hasLauncher: false, grenades: 0, mines: 0 });
  });

  it('launcher and mines items respect their caps', () => {
    const s = testGame();
    place(s, 0, 500, 500);
    s.items.push(
      { id: 800, type: 'launcher', x: 500, y: 500, ammo: 3, origin: 'random', padIndex: -1 },
      { id: 801, type: 'mines', x: 505, y: 500, ammo: 2, origin: 'random', padIndex: -1 },
    );
    Object.assign(s.players[0], { hasLauncher: true, grenades: 5, mines: 2 });
    step(s, []);
    expect(s.players[0]).toMatchObject({ grenades: 6, mines: 3 });
    s.items.push({ id: 802, type: 'mines', x: 500, y: 500, ammo: 2, origin: 'random', padIndex: -1 });
    step(s, []);
    expect(s.items.map((i) => i.id)).toEqual([802]); // full: left on the ground
  });
});

describe('random item spawner', () => {
  it('spawns weighted items on free spots at the configured times, up to the cap', () => {
    const s = testGame({ config: { items: { maxOnMap: 3 } }, walls: [{ x: 300, y: 300, w: 400, h: 400 }] });
    place(s, 0, 50, 50);
    place(s, 1, 950, 950);
    const first = Math.round(3 * 30);
    for (let i = 0; i < first; i++) step(s, []);
    expect(s.items.filter((i) => i.origin === 'random')).toHaveLength(0);
    step(s, []);
    expect(s.items.filter((i) => i.origin === 'random')).toHaveLength(1);
    for (let i = 0; i < 30 * 60; i++) step(s, []);
    const spawned = s.items.filter((i) => i.origin === 'random');
    expect(spawned).toHaveLength(3);
    for (const it of spawned) {
      const insideWall = it.x > 300 - 12 && it.x < 700 + 12 && it.y > 300 - 12 && it.y < 700 + 12;
      expect(insideWall).toBe(false);
    }
  });

  it('is deterministic per seed', () => {
    const run = (seed: string) => {
      const s = testGame({ seed, config: { items: { maxOnMap: 6 } } });
      for (let i = 0; i < 30 * 30; i++) step(s, []);
      return s.items.map((i) => `${i.type}@${i.x.toFixed(3)},${i.y.toFixed(3)}`);
    };
    expect(run('a')).toEqual(run('a'));
    expect(run('a')).not.toEqual(run('b'));
  });
});

describe('snapshot of explosives', () => {
  it('exposes grenades, mines (fuse in seconds) and last-tick explosions', () => {
    const s = testGame();
    place(s, 0, 200, 500, 0);
    place(s, 1, 900, 900);
    armLauncher(s, 0);
    s.players[0].mines = 1;
    step(s, [act({ attack: true, plantMine: true })]);
    const view = buildBotState(s);
    expect(view.grenades).toHaveLength(1);
    expect(view.grenades[0]).toMatchObject({ ownerId: 0, radius: 6 });
    expect(view.mines[0].fuse).toBeCloseTo((FUSE - 1) / 30);
    expect(view.players[0].ammo.launcher).toBe(2);
    expect(view.players[0].mines).toBe(0);
    runUntilQuiet(s);
    s.mines.push({ id: 999, ownerId: 1, x: 900, y: 100, fuseTimer: 0 });
    step(s, []);
    expect(buildBotState(s).explosions).toEqual([{ ownerId: 1, source: 'mine', x: 900, y: 100, radius: 100 }]);
  });
});

describe('default tuning', () => {
  it('a grenade or mine blast at the centre kills a player with full health and shield', () => {
    const full = DEFAULT_CONFIG.player.maxHp + DEFAULT_CONFIG.player.maxShield;
    expect(DEFAULT_CONFIG.launcher.centerDamage).toBeGreaterThanOrEqual(full);
    expect(DEFAULT_CONFIG.mines.centerDamage).toBeGreaterThanOrEqual(full);
  });
});

describe('explosions around corners', () => {
  // A long vertical wall from y = 300 to the bottom edge.
  const walls = [{ x: 500, y: 300, w: 40, h: 700 }];

  it('reach a player just around a wall corner, weakened by the detour', () => {
    const s = testGame({ walls });
    const straight = blastDamageAt(s, 'grenade', 490, 320, 440, 320); // same side, 50 u away
    const around = blastDamageAt(s, 'grenade', 490, 320, 560, 320); // other side, over the top corner
    expect(around).toBeGreaterThan(0);
    expect(around).toBeLessThan(straight);
    // Detour: to (499.5, 299.5), across to (540.5, 299.5), down to (560, 320).
    const path = Math.hypot(9.5, 20.5) + 41 + Math.hypot(19.5, 20.5);
    expect(around).toBe(blastDamage(DEFAULT_CONFIG.launcher.centerDamage, DEFAULT_CONFIG.launcher.edgeDamage, 80, path - 16));
  });

  it('do not reach a player behind the middle of a long wall', () => {
    const s = testGame({ walls });
    expect(blastDamageAt(s, 'mine', 490, 600, 560, 600)).toBe(0);
  });

  it('with aroundCorners 0 (old replays) any wall on the straight line shields', () => {
    const s = testGame({ walls, config: { explosions: { aroundCorners: 0 } } });
    expect(blastDamageAt(s, 'grenade', 490, 320, 560, 320)).toBe(0);
  });
});
