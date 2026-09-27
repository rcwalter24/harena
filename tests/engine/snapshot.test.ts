import { describe, expect, it } from 'vitest';
import { step } from '../../src/engine/game.ts';
import { buildBotState, buildInitInfo, withSelf } from '../../src/engine/snapshot.ts';
import { act, place, testGame } from '../helpers.ts';

describe('bot snapshots', () => {
  it('are plain, cloneable data detached from the engine', () => {
    const s = testGame({ gunSpawns: [{ x: 500, y: 500 }] });
    const snap = buildBotState(s);
    expect(structuredClone(snap)).toEqual(snap);
    (snap.players[0] as { x: number }).x = -999;
    expect(s.players[0].x).not.toBe(-999);
    const info = buildInitInfo(s, 1);
    expect(structuredClone(info)).toEqual(info);
    info.map.walls.push({ x: 0, y: 0, w: 1, h: 1 });
    expect(s.map.walls).toHaveLength(0);
    expect(info.rules.knife.damage).toBe(35);
  });

  it('reports timers in seconds and the last tick events', () => {
    const s = testGame();
    place(s, 0, 500, 500, 0);
    place(s, 1, 560, 500);
    step(s, [act({ attack: true })]);
    const view = withSelf(buildBotState(s), 0);
    expect(view.self).toBe(view.players[0]);
    expect(view.self.cooldowns.knife).toBeCloseTo(14 / 30);
    expect(view.events).toContainEqual({ type: 'hit', attackerId: 0, targetId: 1, weapon: 'knife', damage: 35 });
    expect(view.timeLeft).toBeNull();
    expect(view.time).toBeCloseTo(1 / 30);
  });

  it('reports time left under a time limit', () => {
    const s = testGame({ timeLimit: 10 });
    step(s, []);
    expect(buildBotState(s).timeLeft).toBeCloseTo(10 - 1 / 30);
  });
});
