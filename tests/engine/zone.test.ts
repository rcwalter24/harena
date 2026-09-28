import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, mergeConfig } from '../../src/engine/config.ts';
import { createGame, step } from '../../src/engine/game.ts';
import { validateReplay } from '../../src/engine/replay.ts';
import { buildBotState } from '../../src/engine/snapshot.ts';
import { isVisibleTo } from '../../src/engine/systems/visibility.ts';
import { insideZone, randomZoneSpawn, zoneAt } from '../../src/engine/systems/zone.ts';
import type { GameState } from '../../src/engine/types.ts';
import { loadMaps } from '../../src/batch/batch.ts';
import { place, testGame, testMap, vulnerable } from '../helpers.ts';

// A fast zone around (500, 500): shrinks from 1 s to 3 s (ticks 30 → 90) down to radius 100,
// holds until 10 s (tick 300) and collapses to 0 by 12 s (tick 360).
const FAST = { zone: { shrinkStart: 1, shrinkDuration: 2, finalRadius: 100, holdTime: 7, collapseDuration: 2, damagePerSecond: 10 } };

function run(s: GameState, ticks: number): void {
  for (let i = 0; i < ticks; i++) step(s, []);
}

describe('safe zone', () => {
  it('covers the whole map, then shrinks linearly to its final radius', () => {
    const s = testGame({ config: FAST });
    const corner = Math.sqrt(500 * 500 + 500 * 500);
    expect(zoneAt(s, 0).radius).toBeCloseTo(corner);
    expect(zoneAt(s, 30).radius).toBeCloseTo(corner);
    expect(zoneAt(s, 60).radius).toBeCloseTo((corner + 100) / 2);
    expect(zoneAt(s, 90).radius).toBe(100);
    expect(zoneAt(s, 300).radius).toBe(100);
    expect(zoneAt(s, 330).radius).toBeCloseTo(50);
    expect(zoneAt(s, 360).radius).toBe(0);
    expect(zoneAt(s, 5000).radius).toBe(0);
    expect(zoneAt(s, 0)).toMatchObject({ x: 500, y: 500 });
  });

  it('damages players outside once per whole second, through the shield, with no kill credit', () => {
    const s = testGame({ config: FAST });
    s.tick = 90;
    vulnerable(s);
    place(s, 0, 500, 500); // inside
    place(s, 1, 900, 500); // outside
    s.players[1].shield = 5;
    const events = step(s, []);
    expect(s.players[0].hp).toBe(100);
    expect(s.players[1].shield).toBe(0);
    expect(s.players[1].hp).toBe(95);
    expect(events).toContainEqual(expect.objectContaining({ type: 'hit', attackerId: 1, targetId: 1, weapon: 'zone', damage: 10 }));
    run(s, 29); // ticks 91..119: no damage between whole seconds
    expect(s.players[1].hp).toBe(95);
    step(s, []); // tick 120
    expect(s.players[1].hp).toBe(85);

    s.players[1].hp = 5;
    s.tick = 150;
    const deathEvents = step(s, []);
    expect(deathEvents).toContainEqual(expect.objectContaining({ type: 'death', playerId: 1, killerId: -1, weapon: 'zone' }));
    expect(s.players[0].stats.kills).toBe(0);
  });

  it('reveals a player hiding in a bush outside the zone when it hurts them', () => {
    const map = { ...testMap(), bushes: [{ x: 850, y: 450, w: 100, h: 100 }] };
    const s = createGame({ map, seed: 'z', timeLimit: 0, players: [{ name: 'A' }, { name: 'B' }], config: mergeConfig(DEFAULT_CONFIG, { ...FAST, items: { maxOnMap: 0 } }) });
    s.tick = 89;
    vulnerable(s);
    place(s, 0, 500, 500);
    place(s, 1, 900, 500);
    step(s, []);
    expect(isVisibleTo(s, s.players[0], s.players[1])).toBe(false);
    step(s, []); // tick 90: zone damage
    expect(isVisibleTo(s, s.players[0], s.players[1])).toBe(true);
  });

  it('never collapses when collapseDuration is 0', () => {
    const s = testGame({ config: { zone: { ...FAST.zone, collapseDuration: 0 } } });
    expect(zoneAt(s, 5000).radius).toBe(100);
    s.tick = 5000;
    expect(buildBotState(s).zone).toMatchObject({ collapseStartsIn: null, collapseEndsIn: null });
  });

  it('keeps hurting everyone once it has closed, so a stalemate cannot last', () => {
    const s = testGame({ config: FAST });
    s.tick = 360;
    vulnerable(s);
    place(s, 0, 520, 500);
    place(s, 1, 480, 500);
    step(s, []);
    expect(s.players.map((p) => p.hp)).toEqual([90, 90]);
  });

  it('is off when damagePerSecond is 0', () => {
    const s = testGame({ config: { zone: { ...FAST.zone, damagePerSecond: 0 } } });
    place(s, 1, 990, 990);
    run(s, 200);
    expect(s.players[1].hp).toBe(100);
    expect(zoneAt(s).radius).toBeGreaterThan(700);
    expect(buildBotState(s).zone.damagePerSecond).toBe(0);
  });

  it('respawns players inside the zone once it has shrunk', () => {
    // testMap spawns are all on the left edge (x = 50), far outside a radius-100 zone.
    for (const seed of ['a', 'b', 'c', 'd']) {
      const s = testGame({ config: FAST, seed });
      s.tick = 120;
      vulnerable(s);
      s.players[0].hp = 0;
      s.players[0].lives = 3;
      step(s, []);
      run(s, 61);
      const p = s.players[0];
      expect(p.alive).toBe(true);
      expect(insideZone(zoneAt(s), p.x, p.y)).toBe(true);
    }
  });

  it('spawns random items only inside the zone once it shrinks', () => {
    const s = testGame({ config: { zone: { ...FAST.zone, finalRadius: 300 }, items: { maxOnMap: 50, spawnInterval: 0.1, firstSpawnDelay: 0 } } });
    run(s, 91);
    const late = s.items.filter((i) => i.origin === 'random');
    run(s, 150);
    const after = s.items.filter((i) => i.origin === 'random' && !late.includes(i));
    expect(after.length).toBeGreaterThan(5);
    for (const it of after) expect(insideZone(zoneAt(s), it.x, it.y)).toBe(true);
  });

  it('is described to bots in seconds', () => {
    const s = testGame({ config: FAST });
    s.tick = 15;
    expect(buildBotState(s).zone).toMatchObject({
      x: 500, y: 500, finalRadius: 100, shrinkStartsIn: 0.5, shrinkEndsIn: 2.5, collapseStartsIn: 9.5, collapseEndsIn: 11.5, damagePerSecond: 10,
    });
    s.tick = 100;
    expect(buildBotState(s).zone).toMatchObject({ radius: 100, shrinkStartsIn: 0, shrinkEndsIn: 0, collapseStartsIn: 20 / 3 });
    s.tick = 400;
    expect(buildBotState(s).zone).toMatchObject({ radius: 0, collapseStartsIn: 0, collapseEndsIn: 0 });
  });

  it('keeps spawning items inside when old ones are stranded outside', () => {
    const s = testGame({ config: { zone: { ...FAST.zone, finalRadius: 300 }, items: { maxOnMap: 3, spawnInterval: 0.1, firstSpawnDelay: 0 } } });
    run(s, 25); // before shrinking: the cap fills up anywhere on the map
    for (const it of s.items) [it.x, it.y] = [40, 40]; // strand them in a corner
    run(s, 100);
    const inside = s.items.filter((i) => insideZone(zoneAt(s), i.x, i.y));
    expect(inside.length).toBe(3);
  });

  it('leaves room to respawn inside the final zone on every map', () => {
    for (const map of loadMaps().values()) {
      const s = createGame({ map, seed: 'm', timeLimit: 0, players: [{ name: 'A' }, { name: 'B' }] });
      s.tick = zoneAt(s).endTick;
      expect(randomZoneSpawn(s, 0), map.id).not.toBeNull();
    }
  });

  it('replays recorded before the zone and the bush hiding limit existed play back with both off', () => {
    const { zone: _zone, ...rest } = DEFAULT_CONFIG;
    const oldConfig = { ...rest, bushes: { revealDistance: 90, noiseRevealTime: 1 } };
    const replay = validateReplay({
      format: 'harena-replay', version: 1, seed: 's', timeLimit: 0, ticks: 0, map: testMap(), config: oldConfig,
      players: [{ name: 'A', kind: 'dummy', source: 'idle' }], actions: [[]], createdAt: '',
    });
    expect(replay.config.zone.damagePerSecond).toBe(0);
    expect(replay.config.bushes.hideLimit).toBe(0);
  });
});
