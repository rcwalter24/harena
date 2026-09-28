import { describe, expect, it } from 'vitest';
import { planFrames } from '../../src/video/timeline.ts';

describe('video timeline', () => {
  it('shows every tick once when fast-forward is off', () => {
    const frames = planFrames(90, [], 30, { fastForward: false });
    expect(frames.map((f) => f.tick)).toEqual(Array.from({ length: 91 }, (_, i) => i));
    expect(frames.every((f) => !f.fast)).toBe(true);
  });

  it('runs quiet stretches at 4x and slows down before and after action', () => {
    // One hit at tick 600 (20 s): normal speed from 1.5 s before to 3 s after it.
    const frames = planFrames(1200, [600], 30, { fastForward: true });
    const at = (tick: number) => frames.find((f) => f.tick >= tick)!;
    expect(at(0).fast).toBe(true);
    expect(at(300).fast).toBe(true);
    expect(at(560).fast).toBe(false);
    expect(at(600).fast).toBe(false);
    expect(at(685).fast).toBe(false);
    expect(at(700).fast).toBe(true);
    // Normal stretch: one tick per frame, so the action itself is never skipped.
    const normal = frames.filter((f) => !f.fast).map((f) => f.tick);
    for (let t = 560; t <= 690; t++) expect(normal).toContain(t);
    expect(frames[frames.length - 1].tick).toBe(1200);
    // 40 s of game: 135 normal ticks at 1 frame each, the rest at 4 ticks per frame.
    expect(frames.length).toBeLessThan(135 + (1200 - 135) / 4 + 5);
  });

  it('keeps a busy match at normal speed', () => {
    const actions = Array.from({ length: 30 }, (_, i) => i * 60); // a hit every 2 s
    const frames = planFrames(1800, actions, 30, { fastForward: true });
    expect(frames.filter((f) => f.fast).every((f) => f.tick > 1740 + 90)).toBe(true);
  });
});
