/**
 * Seeded, deterministic PRNG (sfc32) with labelled sub-streams, so e.g. item
 * spawning and bot Math.random draw from independent sequences.
 */

/** Hash an arbitrary string (or number) seed to a 32-bit unsigned integer (FNV-1a + avalanche). */
export function hashSeed(seed: string | number): number {
  const text = String(seed);
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

export interface RngState {
  a: number;
  b: number;
  c: number;
  d: number;
}

export class Rng {
  private a: number;
  private b: number;
  private c: number;
  private d: number;

  constructor(seed: string | number) {
    const s = hashSeed(seed);
    this.a = s;
    this.b = hashSeed(s + 1);
    this.c = hashSeed(s + 2);
    this.d = 1;
    for (let i = 0; i < 15; i++) this.nextUint32();
  }

  /** Next 32-bit unsigned integer. */
  nextUint32(): number {
    const t = (((this.a + this.b) | 0) + this.d) | 0;
    this.d = (this.d + 1) | 0;
    this.a = this.b ^ (this.b >>> 9);
    this.b = (this.c + (this.c << 3)) | 0;
    this.c = (this.c << 21) | (this.c >>> 11);
    this.c = (this.c + t) | 0;
    return t >>> 0;
  }

  /** Uniform float in [0, 1). */
  next(): number {
    return this.nextUint32() / 4294967296;
  }

  /** Uniform integer in [0, n). */
  int(n: number): number {
    return Math.floor(this.next() * n);
  }

  /** Uniform float in [min, max). */
  range(min: number, max: number): number {
    return min + (max - min) * this.next();
  }

  /** Pick a key from a weight table (non-positive weights are never picked). */
  weighted<K extends string>(weights: Record<K, number>, keys: readonly K[]): K | null {
    let total = 0;
    for (const k of keys) total += Math.max(0, weights[k]);
    if (total <= 0) return null;
    let roll = this.next() * total;
    for (const k of keys) {
      const w = Math.max(0, weights[k]);
      if (roll < w) return k;
      roll -= w;
    }
    return keys[keys.length - 1];
  }

  /** In-place Fisher–Yates shuffle. */
  shuffle<T>(arr: T[]): T[] {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = this.int(i + 1);
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  getState(): RngState {
    return { a: this.a, b: this.b, c: this.c, d: this.d };
  }

  setState(s: RngState): void {
    this.a = s.a;
    this.b = s.b;
    this.c = s.c;
    this.d = s.d;
  }
}

/** Derive an independent stream from a match seed and a label, e.g. deriveRng(seed, 'items'). */
export function deriveRng(seed: string | number, label: string): Rng {
  return new Rng(`${seed}::${label}`);
}
