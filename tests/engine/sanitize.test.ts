import { describe, expect, it } from 'vitest';
import { normalizeAction, sanitizeAction, unknownActionKeys } from '../../src/engine/sanitize.ts';
import { Rng } from '../../src/engine/rng.ts';

describe('sanitizeAction', () => {
  it('null / undefined / {} mean stand still and are valid', () => {
    for (const raw of [null, undefined, {}]) {
      const r = sanitizeAction(raw);
      expect(r.valid).toBe(true);
      expect(r.action).toMatchObject({ moveX: 0, moveY: 0, aim: null, attack: false, weapon: null, plantMine: false });
    }
  });

  it('accepts a normal action', () => {
    const r = sanitizeAction({ move: { x: 0.6, y: -0.8 }, aim: 1.5, attack: true, weapon: 'gun', plantMine: true });
    expect(r.valid).toBe(true);
    expect(r.action).toEqual({ moveX: 0.6, moveY: -0.8, aim: 1.5, attack: true, weapon: 'gun', plantMine: true, throwKind: null, throwDistance: null });
  });

  it('accepts throws, and rejects a bad throw kind or distance', () => {
    expect(sanitizeAction({ throw: 'gas', throwDistance: 120 }).action).toMatchObject({ throwKind: 'gas', throwDistance: 120 });
    expect(sanitizeAction({ throw: 'smoke' }).action).toMatchObject({ throwKind: 'smoke', throwDistance: null });
    expect(sanitizeAction({ throw: 'grenade' }).valid).toBe(false);
    expect(sanitizeAction({ throw: 'gas', throwDistance: Infinity }).valid).toBe(false);
    // A distance without a throw means nothing, so it is dropped.
    expect(normalizeAction(sanitizeAction({ throwDistance: 50 }).action).throwDistance).toBeNull();
    expect(normalizeAction(sanitizeAction({ throw: 'gas', throwDistance: -5 }).action).throwDistance).toBe(0);
  });

  it('clamps move to length 1 and normalizes aim', () => {
    const r = sanitizeAction({ move: { x: 300, y: 400 }, aim: 7 * Math.PI });
    expect(r.action.moveX).toBeCloseTo(0.6);
    expect(r.action.moveY).toBeCloseTo(0.8);
    expect(Math.abs(r.action.aim!)).toBeCloseTo(Math.PI, 3); // +PI and -PI are the same direction
  });

  it('rejects wrong types entirely', () => {
    const bad = [
      42, 'attack', [1, 2], true,
      { move: 'left' }, { move: { x: NaN, y: 0 } }, { move: { x: Infinity, y: 0 } }, { move: [1, 0] },
      { move: { x: '1', y: 0 } }, { aim: NaN }, { aim: -Infinity }, { aim: '1' },
      { attack: 1 }, { attack: 'yes' }, { weapon: 'rocket' }, { weapon: 2 }, { plantMine: 'true' },
    ];
    for (const raw of bad) {
      const r = sanitizeAction(raw);
      expect(r.valid, JSON.stringify(raw)).toBe(false);
      expect(r.action).toMatchObject({ moveX: 0, moveY: 0, aim: null, attack: false });
      expect(r.problems.length).toBeGreaterThan(0);
    }
  });

  it('ignores unknown keys but reports them', () => {
    const raw = { move: { x: 1, y: 0 }, atack: true, speed: 9999 };
    expect(sanitizeAction(raw).valid).toBe(true);
    expect(unknownActionKeys(raw)).toEqual(['atack', 'speed']);
  });

  it('survives getters that throw', () => {
    const raw = { get move(): unknown { throw new Error('nope'); } };
    expect(sanitizeAction(raw).valid).toBe(false);
  });

  it('fuzz: output is always a bounded, finite action', () => {
    const rng = new Rng('fuzz');
    const values: unknown[] = [0, -0, 1, -1, 1e308, -1e308, 5e-324, NaN, Infinity, -Infinity, '', 'x', true, false,
      null, undefined, [], {}, { x: 1 }, { x: 1, y: 2 }, 'gun', 'knife', 'launcher', () => 1];
    const pick = () => values[rng.int(values.length)];
    for (let i = 0; i < 5000; i++) {
      const raw: Record<string, unknown> = {};
      if (rng.next() < 0.7) raw.move = rng.next() < 0.5 ? pick() : { x: pick(), y: pick() };
      if (rng.next() < 0.7) raw.aim = pick();
      if (rng.next() < 0.7) raw.attack = pick();
      if (rng.next() < 0.5) raw.weapon = pick();
      if (rng.next() < 0.3) raw.plantMine = pick();
      const { action } = sanitizeAction(rng.next() < 0.05 ? pick() : raw);
      expect(Number.isFinite(action.moveX) && Number.isFinite(action.moveY)).toBe(true);
      expect(Math.hypot(action.moveX, action.moveY)).toBeLessThanOrEqual(1 + 2e-3);
      if (action.aim !== null) {
        expect(Number.isFinite(action.aim)).toBe(true);
        expect(Math.abs(action.aim)).toBeLessThanOrEqual(Math.PI);
      }
      expect(typeof action.attack).toBe('boolean');
      expect([null, 'knife', 'gun', 'launcher']).toContain(action.weapon);
    }
  });
});
