import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../../src/engine/config.ts';
import { step } from '../../src/engine/game.ts';
import { act, place, testGame } from '../helpers.ts';

function killSetup() {
  const s = testGame({ players: 3 });
  place(s, 0, 500, 500, 0);
  place(s, 1, 560, 500);
  place(s, 2, 900, 100);
  s.players[1].hp = 10;
  return s;
}

describe('death and respawn', () => {
  it('losing all hp costs a life and credits the killer', () => {
    const s = killSetup();
    const events = step(s, [act({ attack: true })]);
    const victim = s.players[1];
    expect(victim.alive).toBe(false);
    expect(victim.lives).toBe(DEFAULT_CONFIG.player.startLives - 1);
    expect(victim.stats.deaths).toBe(1);
    expect(s.players[0].stats.kills).toBe(1);
    expect(events).toContainEqual(expect.objectContaining({ type: 'death', playerId: 1, killerId: 0, weapon: 'knife', livesLeft: DEFAULT_CONFIG.player.startLives - 1 }));
  });

  it('drops the gun with its ammo on death', () => {
    const s = killSetup();
    Object.assign(s.players[1], { hasGun: true, weapon: 'gun', ammo: 7 });
    step(s, [act({ attack: true })]);
    expect(s.players[1].hasGun).toBe(false);
    const drop = s.items.find((i) => i.origin === 'drop')!;
    expect(drop).toMatchObject({ type: 'gun', ammo: 7 });
  });

  it('respawns after the delay with full hp, knife and invulnerability', () => {
    const s = killSetup();
    step(s, [act({ attack: true })]);
    const delay = Math.round(2 * 30);
    for (let i = 0; i < delay - 1; i++) step(s, []);
    expect(s.players[1].alive).toBe(false);
    const events = step(s, []);
    expect(events.some((e) => e.type === 'respawn' && e.playerId === 1)).toBe(true);
    const p = s.players[1];
    expect(p).toMatchObject({ alive: true, hp: 100, weapon: 'knife', hasGun: false });
    expect(p.invulnerableTimer).toBeGreaterThan(0);
  });

  it('respawns at a spawn point far from living enemies', () => {
    const s = killSetup();
    step(s, [act({ attack: true })]);
    for (let i = 0; i < 60; i++) step(s, []);
    const p = s.players[1];
    for (const q of [s.players[0], s.players[2]]) {
      expect(Math.hypot(p.x - q.x, p.y - q.y)).toBeGreaterThanOrEqual(300);
    }
  });

  it('is eliminated after the last life', () => {
    const s = killSetup();
    s.players[1].lives = 1;
    const events = step(s, [act({ attack: true })]);
    expect(s.players[1].eliminated).toBe(true);
    expect(events.some((e) => e.type === 'eliminated')).toBe(true);
    for (let i = 0; i < 200; i++) step(s, []);
    expect(s.players[1].alive).toBe(false);
  });

  it('only the first lethal hit gets the kill when two attackers strike in the same tick', () => {
    const s = testGame({ players: 3 });
    place(s, 0, 440, 500, 0);
    place(s, 1, 500, 500);
    place(s, 2, 560, 500, Math.PI);
    s.players[1].hp = 10;
    step(s, [act({ attack: true }), act(), act({ attack: true })]);
    expect(s.players[0].stats.kills + s.players[2].stats.kills).toBe(1);
    expect(s.players[1].stats.deaths).toBe(1);
  });
});

describe('gun pads and pickups', () => {
  it('pad guns are picked up by walking over them and refill later', () => {
    const s = testGame({ gunSpawns: [{ x: 500, y: 500 }] });
    expect(s.items).toHaveLength(1);
    place(s, 0, 470, 500);
    step(s, [act({ moveX: 1 })]);
    expect(s.players[0].hasGun).toBe(true);
    expect(s.players[0].ammo).toBe(15);
    expect(s.items).toHaveLength(0);
    place(s, 0, 100, 100);
    const refill = Math.round(20 * 30);
    for (let i = 0; i < refill - 1; i++) step(s, []);
    expect(s.items).toHaveLength(0);
    step(s, []);
    expect(s.items).toHaveLength(1);
  });

  it('useless items are left on the ground', () => {
    const s = testGame({ gunSpawns: [{ x: 500, y: 500 }] });
    Object.assign(s.players[0], { hasGun: true, ammo: 40 });
    place(s, 0, 500, 500);
    step(s, []);
    expect(s.items).toHaveLength(1);
    s.players[0].ammo = 30;
    step(s, []);
    expect(s.items).toHaveLength(0);
    expect(s.players[0].ammo).toBe(40);
  });

  it('the closest player gets a contested item', () => {
    const s = testGame({ gunSpawns: [{ x: 500, y: 500 }] });
    place(s, 0, 475, 500);
    place(s, 1, 530, 500);
    step(s, []);
    expect(s.players[0].hasGun).toBe(true);
    expect(s.players[1].hasGun).toBe(false);
  });
});
