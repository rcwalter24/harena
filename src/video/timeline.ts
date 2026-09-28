import type { GameEvent } from '../engine/types.ts';

export const VIDEO_FPS = 30;

export interface TimelineOptions {
  /** Speed up stretches where nobody lands a hit. */
  fastForward: boolean;
  /** A stretch counts as quiet this long after the last action... */
  quietAfterSeconds?: number;
  /** ...and until this long before the next one (so the lead-up plays at normal speed). */
  leadInSeconds?: number;
  /** Playback speed during quiet stretches. */
  fastSpeed?: number;
}

/** One video frame: the game tick to show, and whether it is part of a sped-up stretch. */
export interface PlannedFrame {
  tick: number;
  fast: boolean;
}

/** Is this event something worth watching at normal speed? Zone damage is not. */
export function isActionEvent(e: GameEvent): boolean {
  if (e.type === 'hit') return e.weapon !== 'zone';
  return e.type === 'death' || e.type === 'explosion';
}

/**
 * Which tick each video frame shows. Normally one frame per tick at `tickRate / fps`
 * ticks per frame; in quiet stretches (no action from `quietAfterSeconds` after the
 * last one until `leadInSeconds` before the next) `fastSpeed` times as many.
 * `actionTicks` must be sorted. The last frame always shows `totalTicks`.
 */
export function planFrames(totalTicks: number, actionTicks: readonly number[], tickRate: number, opts: TimelineOptions): PlannedFrame[] {
  const after = Math.round((opts.quietAfterSeconds ?? 3) * tickRate);
  const before = Math.round((opts.leadInSeconds ?? 1.5) * tickRate);
  const fastSpeed = opts.fastSpeed ?? 4;
  const step = tickRate / VIDEO_FPS;
  let next = 0; // index of the first action tick >= the current tick - after
  const quiet = (tick: number): boolean => {
    while (next < actionTicks.length && actionTicks[next] < tick - after) next++;
    return next >= actionTicks.length || actionTicks[next] > tick + before;
  };
  const frames: PlannedFrame[] = [];
  let t = 0;
  for (;;) {
    const tick = Math.min(totalTicks, Math.round(t));
    const fast = opts.fastForward && quiet(tick);
    frames.push({ tick, fast });
    if (tick >= totalTicks) break;
    t += fast ? step * fastSpeed : step;
  }
  return frames;
}
