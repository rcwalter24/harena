import { circleOverlapsRect } from './geometry.ts';
import type { MapData } from './types.ts';

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * Validate parsed map JSON and return it typed. Throws a descriptive error for
 * malformed maps (bad numbers, spawns inside walls or outside the arena, ...).
 */
export function validateMap(raw: unknown, playerRadius = 16): MapData {
  const m = raw as Partial<MapData>;
  const fail = (msg: string): never => {
    throw new Error(`Invalid map "${m?.id ?? '?'}": ${msg}`);
  };
  if (!m || typeof m !== 'object') fail('not an object');
  if (typeof m.id !== 'string' || !m.id) fail('missing id');
  if (typeof m.name !== 'string') fail('missing name');
  if (!isNum(m.width) || !isNum(m.height) || m.width! <= 0 || m.height! <= 0) fail('bad width/height');
  if (!Array.isArray(m.walls)) fail('walls must be an array');
  if (!Array.isArray(m.spawns) || m.spawns!.length === 0) fail('needs at least one spawn');
  if (!Array.isArray(m.gunSpawns)) fail('gunSpawns must be an array');
  const map = m as MapData;
  map.walls.forEach((w, i) => {
    if (![w.x, w.y, w.w, w.h].every(isNum) || w.w <= 0 || w.h <= 0) fail(`wall ${i} is malformed`);
  });
  const checkPoint = (p: { x: number; y: number }, what: string, r: number) => {
    if (!isNum(p.x) || !isNum(p.y)) fail(`${what} is malformed`);
    if (p.x < r || p.y < r || p.x > map.width - r || p.y > map.height - r) fail(`${what} is outside the arena`);
    if (map.walls.some((w) => circleOverlapsRect(p.x, p.y, r, w))) fail(`${what} overlaps a wall`);
  };
  map.spawns.forEach((s, i) => checkPoint(s, `spawn ${i}`, playerRadius));
  map.gunSpawns.forEach((g, i) => checkPoint(g, `gun spawn ${i}`, 1));
  return map;
}
