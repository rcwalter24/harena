/**
 * Deterministic math helpers.
 *
 * Math.sin / Math.cos / Math.atan2 are "implementation-approximated" in the
 * ECMAScript spec and may differ between JS engines, which would break replays.
 * The engine therefore only uses + - * / %, Math.sqrt / floor / round / min /
 * max / abs (all exact or correctly rounded), and the polynomial sin/cos below.
 */

export const PI = Math.PI;
export const TWO_PI = 2 * Math.PI;
const HALF_PI = Math.PI / 2;

export const DEG = PI / 180;

/** Normalize an angle to (-PI, PI]. Non-finite input becomes 0. */
export function normalizeAngle(a: number): number {
  if (!Number.isFinite(a)) return 0;
  let r = a % TWO_PI;
  if (r <= -PI) r += TWO_PI;
  else if (r > PI) r -= TWO_PI;
  return r;
}

/** Signed shortest rotation from `from` to `to`, in (-PI, PI]. */
export function angleDiff(to: number, from: number): number {
  return normalizeAngle(to - from);
}

function sinPoly(r: number): number {
  const r2 = r * r;
  return r + r * r2 * (-1 / 6 + r2 * (1 / 120 + r2 * (-1 / 5040 + r2 * (1 / 362880 + r2 * (-1 / 39916800)))));
}

function cosPoly(r: number): number {
  const r2 = r * r;
  return 1 + r2 * (-1 / 2 + r2 * (1 / 24 + r2 * (-1 / 720 + r2 * (1 / 40320 + r2 * (-1 / 3628800 + r2 * (1 / 479001600))))));
}

/** Deterministic [sin(a), cos(a)], accurate to ~1e-11 for |a| <= a few PI. */
export function sincos(a: number): [number, number] {
  const x = normalizeAngle(a);
  const k = Math.round(x / HALF_PI);
  const r = x - k * HALF_PI;
  const s = sinPoly(r);
  const c = cosPoly(r);
  switch (((k % 4) + 4) % 4) {
    case 0: return [s, c];
    case 1: return [c, -s];
    case 2: return [-s, -c];
    default: return [-c, s];
  }
}

export function dsin(a: number): number {
  return sincos(a)[0];
}

export function dcos(a: number): number {
  return sincos(a)[1];
}

export interface Vec {
  x: number;
  y: number;
}

/** Unit vector for an angle (0 = +x, +PI/2 = +y i.e. down on screen). */
export function direction(angle: number): Vec {
  const [s, c] = sincos(angle);
  return { x: c, y: s };
}

export function length(x: number, y: number): number {
  return Math.sqrt(x * x + y * y);
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
