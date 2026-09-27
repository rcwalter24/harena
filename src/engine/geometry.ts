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

/** True if the straight segment between two points does not cross any wall. */
export function lineOfSight(x0: number, y0: number, x1: number, y1: number, walls: readonly Rect[]): boolean {
  for (const wall of walls) {
    if (segmentRectHit(x0, y0, x1, y1, wall) !== null) return false;
  }
  return true;
}
