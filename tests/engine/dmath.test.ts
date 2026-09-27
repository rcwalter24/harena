import { describe, expect, it } from 'vitest';
import { angleDiff, normalizeAngle, sincos } from '../../src/engine/dmath.ts';

describe('dmath', () => {
  it('sincos matches Math.sin/cos closely', () => {
    for (let a = -20; a <= 20; a += 0.0137) {
      const [s, c] = sincos(a);
      expect(Math.abs(s - Math.sin(a))).toBeLessThan(1e-9);
      expect(Math.abs(c - Math.cos(a))).toBeLessThan(1e-9);
    }
  });

  it('normalizes angles to (-PI, PI]', () => {
    expect(normalizeAngle(3 * Math.PI)).toBeCloseTo(Math.PI);
    expect(normalizeAngle(-Math.PI)).toBeCloseTo(Math.PI);
    expect(normalizeAngle(0.5)).toBe(0.5);
    expect(normalizeAngle(NaN)).toBe(0);
    expect(normalizeAngle(Infinity)).toBe(0);
    for (let a = -50; a < 50; a += 0.31) {
      const n = normalizeAngle(a);
      expect(n).toBeGreaterThan(-Math.PI);
      expect(n).toBeLessThanOrEqual(Math.PI);
    }
  });

  it('angleDiff takes the short way round', () => {
    expect(angleDiff(0.1, -0.1)).toBeCloseTo(0.2);
    expect(angleDiff(-Math.PI + 0.1, Math.PI - 0.1)).toBeCloseTo(0.2);
  });
});
