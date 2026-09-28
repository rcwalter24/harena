import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  circleRectPush, lineOfSight, pathAroundWalls, pathsAroundWallsFrom, resolveCircleWalls, segmentCircleHit, segmentRectHit,
} from '../../src/engine/geometry.ts';

const box = { x: 100, y: 100, w: 100, h: 50 };

describe('geometry', () => {
  it('circleRectPush: no overlap → null', () => {
    expect(circleRectPush(50, 50, 10, box)).toBeNull();
    expect(circleRectPush(90, 125, 10, box)).toBeNull(); // exactly touching
  });

  it('circleRectPush: side overlap pushes straight out', () => {
    const push = circleRectPush(95, 125, 10, box)!;
    expect(push.x).toBeCloseTo(-5);
    expect(push.y).toBeCloseTo(0);
  });

  it('circleRectPush: corner overlap pushes diagonally', () => {
    const push = circleRectPush(95, 95, 10, box)!;
    expect(push.x).toBeLessThan(0);
    expect(push.y).toBeLessThan(0);
    const d = Math.hypot(95 + push.x - 100, 95 + push.y - 100);
    expect(d).toBeCloseTo(10);
  });

  it('circleRectPush: centre inside exits through nearest side', () => {
    const push = circleRectPush(105, 125, 10, box)!;
    expect(push.x).toBeCloseTo(-15);
    expect(push.y).toBe(0);
  });

  it('resolveCircleWalls keeps circles inside bounds and out of walls', () => {
    const pos = resolveCircleWalls({ x: 105, y: 125 }, 10, [box], 1000, 1000);
    expect(pos.x).toBeCloseTo(90);
    const edge = resolveCircleWalls({ x: -50, y: 2000 }, 10, [], 1000, 1000);
    expect(edge).toEqual({ x: 10, y: 990 });
  });

  it('segmentRectHit finds entry parameter', () => {
    expect(segmentRectHit(0, 125, 200, 125, box)).toBeCloseTo(0.5);
    expect(segmentRectHit(0, 125, 50, 125, box)).toBeNull();
    expect(segmentRectHit(0, 0, 50, 0, box)).toBeNull();
    expect(segmentRectHit(150, 125, 300, 125, box)).toBe(0); // starts inside
    expect(segmentRectHit(0, 125, 200, 125, box, 10)).toBeCloseTo(0.45); // inflated
    expect(segmentRectHit(150, 0, 150, 300, box)).toBeCloseTo(1 / 3); // vertical
  });

  it('segmentCircleHit finds first contact', () => {
    expect(segmentCircleHit(0, 0, 100, 0, 50, 0, 10)).toBeCloseTo(0.4);
    expect(segmentCircleHit(0, 0, 100, 0, 50, 20, 10)).toBeNull();
    expect(segmentCircleHit(0, 0, 30, 0, 50, 0, 10)).toBeNull();
    expect(segmentCircleHit(48, 0, 100, 0, 50, 0, 10)).toBe(0);
  });

  it('lineOfSight is blocked by walls', () => {
    expect(lineOfSight(0, 125, 300, 125, [box])).toBe(false);
    expect(lineOfSight(0, 50, 300, 50, [box])).toBe(true);
  });
  it("pathsAroundWallsFrom gives exactly pathAroundWalls's lengths", () => {
    const { walls } = JSON.parse(readFileSync(new URL('../../maps/corridors.json', import.meta.url), 'utf8')) as { walls: typeof box[] };
    let shadowed = 0;
    for (const w of walls.slice(0, 6)) {
      const [x0, y0] = [w.x - 15, w.y + 30]; // beside a wall, just below its top corner
      const path = pathsAroundWallsFrom(x0, y0, walls, 120);
      for (let y = y0 - 120; y <= y0 + 120; y += 7) {
        for (let x = x0 - 120; x <= x0 + 120; x += 7) {
          const expected = pathAroundWalls(x0, y0, x, y, walls, 120);
          if (expected !== Infinity && !lineOfSight(x0, y0, x, y, walls)) shadowed++;
          expect(path(x, y)).toBe(expected);
        }
      }
    }
    expect(shadowed).toBeGreaterThan(50); // the check covers paths that bend around corners
  });
});
