import { secondsToTicks } from '../config.ts';
import { direction } from '../dmath.ts';
import { segmentCircleHit, segmentRectEntry, type SegmentEntry } from '../geometry.ts';
import { solidRects, type GameState, type PlayerState } from '../types.ts';
import { applyDamage } from './combat.ts';

/**
 * The laser: attacking starts a charge that locks the beam's direction and shows everyone a
 * warning line; the holder can still move. When the charge runs out the beam fires instantly
 * from the holder's current centre, reflects off walls (and the map edge) up to
 * `laser.bounces` times, and stops at the first player it touches. After a bounce it can hit
 * its own shooter.
 */

/** First wall a ray (x, y) + t·(dx, dy), t in (0, 1], enters, and which axis its face is normal to. */
function firstWall(state: GameState, x: number, y: number, dx: number, dy: number): SegmentEntry | null {
  let best: SegmentEntry | null = null;
  for (const r of solidRects(state.map)) {
    const hit = segmentRectEntry(x, y, dx, dy, r);
    if (hit && (!best || hit.t < best.t)) best = hit;
  }
  return best;
}

export interface LaserSegment {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** The beam's path from (x, y) along `angle`, ignoring players: straight segments, one per bounce + 1. */
export function laserSegments(state: GameState, x: number, y: number, angle: number): LaserSegment[] {
  const { laser } = state.config;
  const f = direction(angle);
  let dx = f.x;
  let dy = f.y;
  let left = laser.range;
  const out: LaserSegment[] = [];
  for (let bounce = 0; bounce <= laser.bounces && left > 1e-6; bounce++) {
    const hit = firstWall(state, x, y, dx * left, dy * left);
    const t = hit ? hit.t : 1;
    const x1 = x + dx * left * t;
    const y1 = y + dy * left * t;
    out.push({ x0: x, y0: y, x1, y1 });
    if (!hit) break;
    left -= left * t;
    if (hit.axis === 'x') dx = -dx;
    else dy = -dy;
    x = x1;
    y = y1;
  }
  return out;
}

/** Flatten segments into x0, y0, x1, y1, … (start, bounce points, end). */
export function segmentPoints(segments: readonly LaserSegment[]): number[] {
  if (segments.length === 0) return [];
  const pts = [segments[0].x0, segments[0].y0];
  for (const s of segments) pts.push(s.x1, s.y1);
  return pts;
}

/** Start charging (called for an attack with the laser in hand). Returns false if not possible now. */
export function startLaserCharge(state: GameState, p: PlayerState): boolean {
  const { config } = state;
  if (p.laserCharge > 0 || p.laserCooldown > 0 || p.laserShots <= 0 || !p.hasLaser) return false;
  p.laserCharge = Math.max(1, secondsToTicks(config.laser.chargeTime, config));
  p.laserAim = p.facing;
  p.invulnerableTimer = 0;
  p.noiseTimer = secondsToTicks(config.bushes.noiseRevealTime, config);
  state.events.push({ type: 'laserCharge', tick: state.tick, playerId: p.id, aim: p.laserAim });
  return true;
}

/** Stop a charge without firing (weapon switch, death). */
export function cancelLaserCharge(p: PlayerState): void {
  p.laserCharge = 0;
}

/** Count down every charge; fire the ones that finish this tick. */
export function updateLasers(state: GameState): void {
  const { config } = state;
  const noise = secondsToTicks(config.bushes.noiseRevealTime, config);
  const hitRadius = config.player.radius + config.laser.beamRadius;
  for (const p of state.players) {
    if (p.laserCharge <= 0) continue;
    if (!p.alive) {
      p.laserCharge = 0;
      continue;
    }
    // Charging gives your position away like attacking does.
    p.noiseTimer = Math.max(p.noiseTimer, noise);
    p.laserCharge--;
    if (p.laserCharge > 0) continue;

    p.laserShots--;
    p.laserCooldown = secondsToTicks(config.laser.cooldown, config);
    p.stats.lasersFired++;
    const segments = laserSegments(state, p.x, p.y, p.laserAim);
    let hit: PlayerState | null = null;
    let cut = -1;
    for (let i = 0; i < segments.length && !hit; i++) {
      const s = segments[i];
      let bestT = Infinity;
      for (const target of state.players) {
        // The shooter can only be hit by the reflected part of its own beam.
        if (!target.alive || target.hp <= 0 || (target === p && i === 0)) continue;
        const t = segmentCircleHit(s.x0, s.y0, s.x1, s.y1, target.x, target.y, hitRadius);
        if (t !== null && t < bestT) {
          bestT = t;
          hit = target;
        }
      }
      if (hit) {
        cut = i;
        s.x1 = s.x0 + (s.x1 - s.x0) * bestT;
        s.y1 = s.y0 + (s.y1 - s.y0) * bestT;
      }
    }
    const path = segmentPoints(cut >= 0 ? segments.slice(0, cut + 1) : segments);
    state.events.push({ type: 'laser', tick: state.tick, playerId: p.id, path, hitId: hit ? hit.id : -1 });
    if (hit && applyDamage(state, hit, config.laser.damage, p, 'laser') > 0 && hit !== p) p.stats.laserHits++;
  }
}
