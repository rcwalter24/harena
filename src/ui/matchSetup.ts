import type { DummyKind } from '../match/dummies.ts';

/** One seat in a match. */
export type SlotSpec =
  | { kind: 'bot'; file: string }
  | { kind: 'human' }
  | { kind: 'dummy'; dummy: DummyKind };

export interface MatchSetup {
  mapId: string;
  seed: string;
  /** Seconds; 0 = no limit. */
  timeLimit: number;
  /** Debug rules: 99 lives, cheat keys (G = gun, H = heal). */
  debug: boolean;
  /** Shrinking safe zone; missing (older saved setups) means on. */
  zone?: boolean;
  slots: SlotSpec[];
}

const STORAGE_KEY = 'harena.setup.v1';

export function loadSetup(): MatchSetup | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as MatchSetup) : null;
  } catch {
    return null;
  }
}

export function saveSetup(setup: MatchSetup): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(setup));
  } catch {
    // Storage unavailable (private mode etc.): the setup just isn't remembered.
  }
}

export function randomSeed(): string {
  return Math.floor(Math.random() * 1e9).toString(36);
}
