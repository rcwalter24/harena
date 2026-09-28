import { clamp, type Vec } from './dmath.ts';

/** Axis-aligned rectangle: top-left corner (x, y), width w, height h. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Vector that pushes a circle out of a rectangle, or null if they don't overlap.
 * If the centre is inside the rectangle, pushes out through the nearest side.
 */
export function circleRectPush(cx: number, cy: number, r: number, rect: Rect): Vec | null {
  const qx = clamp(cx, rect.x, rect.x + rect.w);
  const qy = clamp(cy, rect.y, rect.y + rect.h);
  const dx = cx - qx;
  const dy = cy - qy;
  const d2 = dx * dx + dy * dy;
  if (d2 >= r * r) return null;
  if (d2 > 0) {
    const d = Math.sqrt(d2);
    const k = (r - d) / d;
    return { x: dx * k, y: dy * k };
  }
  // Centre inside the rectangle: exit through the closest side.
  const left = cx - rect.x;
  const right = rect.x + rect.w - cx;
  const top = cy - rect.y;
  const bottom = rect.y + rect.h - cy;
  const m = Math.min(left, right, top, bottom);
  if (m === left) return { x: -(left + r), y: 0 };
  if (m === right) return { x: right + r, y: 0 };
  if (m === top) return { x: 0, y: -(top + r) };
  return { x: 0, y: bottom + r };
}

export function circleOverlapsRect(cx: number, cy: number, r: number, rect: Rect): boolean {
  const qx = clamp(cx, rect.x, rect.x + rect.w);
  const qy = clamp(cy, rect.y, rect.y + rect.h);
  const dx = cx - qx;
  const dy = cy - qy;
  return dx * dx + dy * dy < r * r;
}

/**
 * Move a circle out of all walls (a few relaxation passes handle corners) and
 * keep it inside the map bounds. Mutates and returns `pos`.
 */
export function resolveCircleWalls(pos: Vec, r: number, walls: readonly Rect[], width: number, height: number): Vec {
  for (let pass = 0; pass < 4; pass++) {
    let moved = false;
    for (const wall of walls) {
      const push = circleRectPush(pos.x, pos.y, r, wall);
      if (push) {
        pos.x += push.x;
        pos.y += push.y;
        moved = true;
      }
    }
    pos.x = clamp(pos.x, r, width - r);
    pos.y = clamp(pos.y, r, height - r);
    if (!moved) break;
  }
  return pos;
}

/**
 * Earliest parameter t in [0, 1] where segment p0→p1 enters `rect` grown by
 * `inflate` on every side, or null. Returns 0 if p0 is already inside.
 */
export function segmentRectHit(
  x0: number, y0: number, x1: number, y1: number, rect: Rect, inflate = 0,
): number | null {
  const minX = rect.x - inflate;
  const maxX = rect.x + rect.w + inflate;
  const minY = rect.y - inflate;
  const maxY = rect.y + rect.h + inflate;
  let tMin = 0;
  let tMax = 1;
  const dx = x1 - x0;
  const dy = y1 - y0;
  if (dx === 0) {
    if (x0 < minX || x0 > maxX) return null;
  } else {
    let t1 = (minX - x0) / dx;
    let t2 = (maxX - x0) / dx;
    if (t1 > t2) [t1, t2] = [t2, t1];
    tMin = Math.max(tMin, t1);
    tMax = Math.min(tMax, t2);
    if (tMin > tMax) return null;
  }
  if (dy === 0) {
    if (y0 < minY || y0 > maxY) return null;
  } else {
    let t1 = (minY - y0) / dy;
    let t2 = (maxY - y0) / dy;
    if (t1 > t2) [t1, t2] = [t2, t1];
    tMin = Math.max(tMin, t1);
    tMax = Math.min(tMax, t2);
    if (tMin > tMax) return null;
  }
  return tMin;
}

/**
 * Earliest parameter t in [0, 1] where segment p0→p1 comes within `radius` of
 * (cx, cy), or null. Returns 0 if p0 is already within range.
 */
export function segmentCircleHit(
  x0: number, y0: number, x1: number, y1: number, cx: number, cy: number, radius: number,
): number | null {
  const fx = x0 - cx;
  const fy = y0 - cy;
  const c = fx * fx + fy * fy - radius * radius;
  if (c <= 0) return 0;
  const dx = x1 - x0;
  const dy = y1 - y0;
  const a = dx * dx + dy * dy;
  if (a === 0) return null;
  const b = 2 * (fx * dx + fy * dy);
  const disc = b * b - 4 * a * c;
  if (disc < 0) return null;
  const t = (-b - Math.sqrt(disc)) / (2 * a);
  return t >= 0 && t <= 1 ? t : null;
}

export interface SegmentEntry {
  /** Fraction of the segment at which it enters the rectangle. */
  t: number;
  /** The entered face is normal to this axis (reflect that velocity component to bounce). */
  axis: 'x' | 'y';
}

/**
 * Where the segment (x, y) + t·(dx, dy), t in (0, 1], enters `rect` grown by `inflate`, and
 * through which face. A segment starting inside or on the rectangle does not count.
 */
export function segmentRectEntry(x: number, y: number, dx: number, dy: number, rect: Rect, inflate = 0): SegmentEntry | null {
  const minX = rect.x - inflate;
  const maxX = rect.x + rect.w + inflate;
  const minY = rect.y - inflate;
  const maxY = rect.y + rect.h + inflate;
  let tMin = -Infinity;
  let tMax = Infinity;
  let axis: 'x' | 'y' = 'x';
  if (dx === 0) {
    if (x <= minX || x >= maxX) return null;
  } else {
    let t1 = (minX - x) / dx;
    let t2 = (maxX - x) / dx;
    if (t1 > t2) [t1, t2] = [t2, t1];
    tMin = t1;
    tMax = t2;
  }
  if (dy === 0) {
    if (y <= minY || y >= maxY) return null;
  } else {
    let t1 = (minY - y) / dy;
    let t2 = (maxY - y) / dy;
    if (t1 > t2) [t1, t2] = [t2, t1];
    if (t1 > tMin) {
      tMin = t1;
      axis = 'y';
    }
    tMax = Math.min(tMax, t2);
  }
  if (tMin > tMax || tMin <= 1e-9 || tMin > 1) return null;
  return { t: tMin, axis };
}

/** How far outside a wall corner a path turns, so it never grazes the wall it goes around. */
const CORNER_GAP = 0.5;

/**
 * Length of the shortest path from (x0, y0) to (x1, y1) that goes around walls, turning only at
 * wall corners, or Infinity if every such path is longer than `maxLength`. Straight distance
 * when nothing is in the way. Deterministic: a small Dijkstra over the corners in wall order.
 */
export function pathAroundWalls(x0: number, y0: number, x1: number, y1: number, walls: readonly Rect[], maxLength: number): number {
  const direct = Math.sqrt((x1 - x0) * (x1 - x0) + (y1 - y0) * (y1 - y0));
  if (direct > maxLength) return Infinity;
  if (lineOfSight(x0, y0, x1, y1, walls)) return direct;

  const dist = (ax: number, ay: number, bx: number, by: number) => Math.sqrt((bx - ax) * (bx - ax) + (by - ay) * (by - ay));
  // Corners that could lie on a short enough path (and aren't buried in another wall).
  const nodes: { x: number; y: number }[] = [];
  for (const w of walls) {
    for (const [cx, cy] of [
      [w.x - CORNER_GAP, w.y - CORNER_GAP], [w.x + w.w + CORNER_GAP, w.y - CORNER_GAP],
      [w.x - CORNER_GAP, w.y + w.h + CORNER_GAP], [w.x + w.w + CORNER_GAP, w.y + w.h + CORNER_GAP],
    ]) {
      if (dist(x0, y0, cx, cy) + dist(cx, cy, x1, y1) > maxLength) continue;
      if (walls.some((o) => cx > o.x && cx < o.x + o.w && cy > o.y && cy < o.y + o.h)) continue;
      nodes.push({ x: cx, y: cy });
    }
  }
  // Dijkstra from the start over the corners; the goal is reached from any corner that sees it.
  const best = nodes.map((n) => (lineOfSight(x0, y0, n.x, n.y, walls) ? dist(x0, y0, n.x, n.y) : Infinity));
  const done = nodes.map(() => false);
  let result = Infinity;
  for (;;) {
    let i = -1;
    for (let k = 0; k < nodes.length; k++) if (!done[k] && best[k] < Infinity && (i < 0 || best[k] < best[i])) i = k;
    if (i < 0 || best[i] >= result) break;
    done[i] = true;
    const n = nodes[i];
    if (lineOfSight(n.x, n.y, x1, y1, walls)) result = Math.min(result, best[i] + dist(n.x, n.y, x1, y1));
    for (let k = 0; k < nodes.length; k++) {
      if (done[k]) continue;
      const via = best[i] + dist(n.x, n.y, nodes[k].x, nodes[k].y);
      if (via < best[k] && lineOfSight(n.x, n.y, nodes[k].x, nodes[k].y, walls)) best[k] = via;
    }
  }
  return result <= maxLength ? result : Infinity;
}

/**
 * `pathAroundWalls` from one fixed start to many points: the corner distances are worked out
 * once, so each query only checks which corners see the point. Same lengths as
 * `pathAroundWalls`; used to draw whole blast and cloud maps without stalling a frame.
 */
export function pathsAroundWallsFrom(x0: number, y0: number, walls: readonly Rect[], maxLength: number): (x1: number, y1: number) => number {
  const dist = (ax: number, ay: number, bx: number, by: number) => Math.sqrt((bx - ax) * (bx - ax) + (by - ay) * (by - ay));
  const nodes: { x: number; y: number; d: number }[] = [];
  for (const w of walls) {
    for (const [cx, cy] of [
      [w.x - CORNER_GAP, w.y - CORNER_GAP], [w.x + w.w + CORNER_GAP, w.y - CORNER_GAP],
      [w.x - CORNER_GAP, w.y + w.h + CORNER_GAP], [w.x + w.w + CORNER_GAP, w.y + w.h + CORNER_GAP],
    ]) {
      if (dist(x0, y0, cx, cy) > maxLength) continue;
      if (walls.some((o) => cx > o.x && cx < o.x + o.w && cy > o.y && cy < o.y + o.h)) continue;
      nodes.push({ x: cx, y: cy, d: lineOfSight(x0, y0, cx, cy, walls) ? dist(x0, y0, cx, cy) : Infinity });
    }
  }
  const done = nodes.map(() => false);
  for (;;) {
    let i = -1;
    for (let k = 0; k < nodes.length; k++) if (!done[k] && nodes[k].d < maxLength && (i < 0 || nodes[k].d < nodes[i].d)) i = k;
    if (i < 0) break;
    done[i] = true;
    const n = nodes[i];
    for (let k = 0; k < nodes.length; k++) {
      if (done[k]) continue;
      const via = n.d + dist(n.x, n.y, nodes[k].x, nodes[k].y);
      if (via < nodes[k].d && lineOfSight(n.x, n.y, nodes[k].x, nodes[k].y, walls)) nodes[k].d = via;
    }
  }
  const reached = nodes.filter((n) => n.d < maxLength).sort((a, b) => a.d - b.d);
  return (x1, y1) => {
    const direct = dist(x0, y0, x1, y1);
    if (direct > maxLength) return Infinity;
    if (lineOfSight(x0, y0, x1, y1, walls)) return direct;
    let best = Infinity;
    for (const n of reached) {
      if (n.d >= best) break;
      const via = n.d + dist(n.x, n.y, x1, y1);
      if (via < best && lineOfSight(n.x, n.y, x1, y1, walls)) best = via;
    }
    return best <= maxLength ? best : Infinity;
  };
}

/** True if the straight segment between two points does not cross any wall. */
export function lineOfSight(x0: number, y0: number, x1: number, y1: number, walls: readonly Rect[]): boolean {
  for (const wall of walls) {
    if (segmentRectHit(x0, y0, x1, y1, wall) !== null) return false;
  }
  return true;
}

/**
 * Four thick rectangles just outside a width × height arena, so projectiles can
 * treat the map border like any other wall.
 */
export function boundaryWalls(width: number, height: number): Rect[] {
  const t = 1000;
  return [
    { x: -t, y: -t, w: width + 2 * t, h: t },
    { x: -t, y: height, w: width + 2 * t, h: t },
    { x: -t, y: 0, w: t, h: height },
    { x: width, y: 0, w: t, h: height },
  ];
}
