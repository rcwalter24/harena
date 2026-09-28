import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, secondsToTicks } from '../../src/engine/config.ts';
import { step } from '../../src/engine/game.ts';
import { hashState } from '../../src/engine/hash.ts';
import { validateReplay } from '../../src/engine/replay.ts';
import { buildBotState } from '../../src/engine/snapshot.ts';
import type { GameState } from '../../src/engine/types.ts';
import { act, place, testGame } from '../helpers.ts';

const CHARGE = secondsToTicks(DEFAULT_CONFIG.laser.chargeTime, DEFAULT_CONFIG);
const DAMAGE = DEFAULT_CONFIG.laser.damage;

function armLaser(s: GameState, id: number, shots = 3): void {
  Object.assign(s.players[id], { hasLaser: true, weapon: 'laser', laserShots: shots });
}

/** Start a charge, then wait until one tick before it fires. */
function chargeAlmost(s: GameState, during = act()): void {
  step(s, [act({ attack: true })]);
  for (let i = 0; i < CHARGE - 2; i++) step(s, [during]);
}

describe('laser', () => {
  it('fires only after the charge, instantly, for its damage', () => {
    const s = testGame();
    place(s, 0, 200, 500, 0);
    place(s, 1, 800, 500);
    armLaser(s, 0);
    chargeAlmost(s);
    expect(s.players[1].hp).toBe(100);
    expect(s.players[0].laserShots).toBe(3); // not used yet
    const events = step(s, []);
    expect(s.players[1].hp).toBe(100 - DAMAGE);
    const shot = events.find((e) => e.type === 'laser');
    expect(shot).toMatchObject({ playerId: 0, hitId: 1 });
    expect(s.players[0].laserShots).toBe(2);
    // The cooldown starts counting down in the tick the beam fires.
    expect(s.players[0].laserCooldown).toBe(secondsToTicks(DEFAULT_CONFIG.laser.cooldown, DEFAULT_CONFIG) - 1);
    expect(s.players[0].stats).toMatchObject({ lasersFired: 1, laserHits: 1 });
  });

  it('shows the warning line to bots, locks the direction, and fires from where the shooter is then', () => {
    const s = testGame();
    place(s, 0, 200, 500, 0);
    place(s, 1, 800, 500);
    armLaser(s, 0);
    step(s, [act({ attack: true })]);
    const view = buildBotState(s);
    expect(view.lasers).toHaveLength(1);
    expect(view.lasers[0]).toMatchObject({ ownerId: 0, angle: 0 });
    expect(view.lasers[0].charge).toBeCloseTo((CHARGE - 1) / 30);
    expect(view.lasers[0].path[0]).toEqual({ x: 200, y: 500 });
    expect(view.players[0].laserCharge).toBeCloseTo((CHARGE - 1) / 30);

    // Aiming elsewhere does nothing while charging; walking down takes the beam off the target.
    for (let i = 0; i < CHARGE - 1; i++) step(s, [act({ aim: Math.PI / 2, moveY: 1 })]);
    expect(s.players[0].facing).toBe(0);
    expect(s.players[0].y).toBeGreaterThan(500 + 16 + DEFAULT_CONFIG.laser.beamRadius);
    expect(s.players[1].hp).toBe(100);
    expect(s.players[0].laserShots).toBe(2);
  });

  it('reflects once off a wall and can hit whoever is on the reflected path', () => {
    // 45° down-right from (200, 800) meets the bottom edge at x = 400 and comes back up through (600, 800).
    const s = testGame();
    place(s, 0, 200, 800, Math.PI / 4);
    place(s, 1, 600, 800);
    armLaser(s, 0);
    chargeAlmost(s);
    const events = step(s, []);
    const shot = events.find((e) => e.type === 'laser');
    expect(shot && shot.type === 'laser' && shot.hitId).toBe(1);
    if (shot?.type === 'laser') expect(shot.path).toHaveLength(6); // start, bounce, end
    expect(s.players[1].hp).toBe(100 - DAMAGE);
  });

  it('can hit its own shooter after the bounce (a suicide at low hp)', () => {
    const s = testGame({ walls: [{ x: 600, y: 300, w: 40, h: 400 }] });
    place(s, 0, 300, 500, 0); // straight at the wall: the reflection comes straight back
    s.players[0].hp = 30;
    armLaser(s, 0);
    chargeAlmost(s);
    const events = step(s, []);
    expect(events.find((e) => e.type === 'laser')).toMatchObject({ hitId: 0 });
    const death = events.find((e) => e.type === 'death');
    expect(death).toMatchObject({ playerId: 0, killerId: -1, weapon: 'laser' });
  });

  it('stops at the first player, and a weapon switch cancels the charge without using the shot', () => {
    const s = testGame({ players: 3 });
    place(s, 0, 200, 500, 0);
    place(s, 1, 400, 500);
    place(s, 2, 600, 500);
    armLaser(s, 0);
    chargeAlmost(s);
    step(s, []);
    expect(s.players[1].hp).toBe(100 - DAMAGE);
    expect(s.players[2].hp).toBe(100);

    const c = testGame();
    place(c, 0, 200, 500, 0);
    place(c, 1, 800, 500);
    armLaser(c, 0);
    step(c, [act({ attack: true })]);
    step(c, [act({ weapon: 'knife' })]);
    for (let i = 0; i < CHARGE + 5; i++) step(c, []);
    expect(c.players[1].hp).toBe(100);
    expect(c.players[0]).toMatchObject({ laserShots: 3, laserCharge: 0 });
  });

  it('drops with its remaining shots on death', () => {
    const s = testGame();
    place(s, 0, 300, 300);
    armLaser(s, 0, 4);
    s.players[0].hp = 0;
    step(s, []);
    expect(s.items.find((i) => i.type === 'laser')).toMatchObject({ ammo: 4, origin: 'drop' });
  });

  it("leaves a laser-free game's state hash unchanged, and loads old replays with the laser off", () => {
    const s = testGame();
    const before = hashState(s);
    s.players[0].laserAim = 1; // not charging: ignored like the rest of the laser state
    expect(hashState(s)).toBe(before);

    const { laser: _laser, ...oldConfig } = DEFAULT_CONFIG;
    const { laser: _w, ...oldWeights } = DEFAULT_CONFIG.items.weights;
    const replay = validateReplay({
      format: 'harena-replay', version: 1, seed: 's', timeLimit: 0, ticks: 0, map: s.map,
      config: { ...oldConfig, items: { ...oldConfig.items, weights: oldWeights } },
      players: [{ name: 'A', kind: 'dummy', source: 'idle' }], actions: [[]], createdAt: '',
    });
    expect(replay.config.items.weights.laser).toBe(0);
    expect(replay.config.laser.maxAmmo).toBe(0);
  });
});
