import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../../src/engine/config.ts';
import { circleOverlapsRect } from '../../src/engine/geometry.ts';
import { validateMap } from '../../src/engine/maps.ts';
import type { MapData } from '../../src/engine/types.ts';

const dir = new URL('../../maps/', import.meta.url);
const maps: MapData[] = readdirSync(dir)
  .filter((f) => f.endsWith('.json'))
  .map((f) => validateMap(JSON.parse(readFileSync(new URL(f, dir), 'utf8'))));

/** Grid flood fill of the places a player's centre can be, 4-connected, 8 u cells. */
function reachable(map: MapData, from: { x: number; y: number }) {
  const cell = 8;
  const r = DEFAULT_CONFIG.player.radius;
  const cols = Math.floor(map.width / cell);
  const rows = Math.floor(map.height / cell);
  const free = (cx: number, cy: number) => {
    const x = cx * cell + cell / 2;
    const y = cy * cell + cell / 2;
    return x >= r && y >= r && x <= map.width - r && y <= map.height - r && !map.walls.some((w) => circleOverlapsRect(x, y, r, w));
  };
  const seen = new Uint8Array(cols * rows);
  const start = [Math.floor(from.x / cell), Math.floor(from.y / cell)];
  const stack = [start];
  seen[start[1] * cols + start[0]] = 1;
  while (stack.length) {
    const [cx, cy] = stack.pop()!;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= cols || ny >= rows || seen[ny * cols + nx] || !free(nx, ny)) continue;
      seen[ny * cols + nx] = 1;
      stack.push([nx, ny]);
    }
  }
  return (p: { x: number; y: number }) => seen[Math.floor(p.y / cell) * cols + Math.floor(p.x / cell)] === 1;
}

describe('maps', () => {
  it('there are at least 3 valid maps with unique ids', () => {
    expect(maps.length).toBeGreaterThanOrEqual(3);
    expect(new Set(maps.map((m) => m.id)).size).toBe(maps.length);
  });

  for (const map of maps) {
    it(`${map.id}: has room for ${DEFAULT_CONFIG.match.maxPlayers} players and gun pads`, () => {
      expect(map.spawns.length).toBeGreaterThanOrEqual(DEFAULT_CONFIG.match.maxPlayers);
      expect(map.gunSpawns.length).toBeGreaterThanOrEqual(1);
      for (let i = 0; i < map.spawns.length; i++) {
        for (let j = i + 1; j < map.spawns.length; j++) {
          const d = Math.hypot(map.spawns[i].x - map.spawns[j].x, map.spawns[i].y - map.spawns[j].y);
          expect(d, `spawns ${i} and ${j}`).toBeGreaterThan(2 * DEFAULT_CONFIG.player.radius);
        }
      }
    });

    it(`${map.id}: every spawn and gun pad is reachable from spawn 0`, () => {
      const canReach = reachable(map, map.spawns[0]);
      map.spawns.forEach((s, i) => expect(canReach(s), `spawn ${i}`).toBe(true));
      map.gunSpawns.forEach((g, i) => expect(canReach(g), `gun pad ${i}`).toBe(true));
    });
  }

  it('rejects malformed maps', () => {
    const good = { id: 'm', name: 'M', width: 500, height: 500, walls: [], spawns: [{ x: 100, y: 100 }], gunSpawns: [] };
    expect(() => validateMap(good)).not.toThrow();
    expect(() => validateMap({ ...good, spawns: [{ x: 5, y: 100 }] })).toThrow(/outside/);
    expect(() => validateMap({ ...good, walls: [{ x: 90, y: 90, w: 20, h: 20 }] })).toThrow(/overlaps a wall/);
    expect(() => validateMap({ ...good, walls: [{ x: 0, y: 0, w: -1, h: 5 }] })).toThrow(/malformed/);
    expect(() => validateMap({ ...good, bushes: [{ x: 0, y: 0, w: 5 }] })).toThrow(/bush 0/);
    expect(() => validateMap({ ...good, spawns: [] })).toThrow(/spawn/);
  });
});
