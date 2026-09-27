import { knifeCanHit } from '../engine/systems/combat.ts';
import { IDLE_ACTION, type ActionInput, type GameState, type PlayerState } from '../engine/types.ts';
import type { Controller } from './controller.ts';

/**
 * Simple in-process scripted opponents for the debug sandbox. They read the
 * engine state directly (they are trusted code), unlike real bots.
 */
export type DummyKind = 'idle' | 'strafe' | 'brawler' | 'shooter';

export const DUMMY_KINDS: readonly DummyKind[] = ['idle', 'strafe', 'brawler', 'shooter'];

function nearestEnemy(state: Readonly<GameState>, self: PlayerState): PlayerState | null {
  let best: PlayerState | null = null;
  let bestD = Infinity;
  for (const p of state.players) {
    if (p === self || !p.alive) continue;
    const d = Math.hypot(p.x - self.x, p.y - self.y);
    if (d < bestD) {
      best = p;
      bestD = d;
    }
  }
  return best;
}

function toward(self: PlayerState, x: number, y: number): { dx: number; dy: number; dist: number; angle: number } {
  const dx = x - self.x;
  const dy = y - self.y;
  return { dx, dy, dist: Math.hypot(dx, dy), angle: Math.atan2(dy, dx) };
}

export class DummyController implements Controller {
  readonly label: string;
  private readonly kind: DummyKind;

  constructor(kind: DummyKind) {
    this.kind = kind;
    this.label = `dummy:${kind}`;
  }

  decide(state: Readonly<GameState>, playerId: number): ActionInput {
    const self = state.players[playerId];
    if (!self.alive) return IDLE_ACTION;
    const enemy = nearestEnemy(state, self);
    const aim = enemy ? toward(self, enemy.x, enemy.y).angle : null;

    switch (this.kind) {
      case 'idle':
        return { ...IDLE_ACTION, aim };

      case 'strafe': {
        // Walk up and down, flipping every 1.5 s, while facing the nearest enemy.
        const phase = Math.floor(state.tick / (state.config.tickRate * 1.5)) % 2;
        return { moveX: 0, moveY: phase === 0 ? 1 : -1, aim, attack: false, weapon: null, plantMine: false };
      }

      case 'brawler': {
        if (!enemy) return IDLE_ACTION;
        const t = toward(self, enemy.x, enemy.y);
        return {
          moveX: t.dx / (t.dist || 1),
          moveY: t.dy / (t.dist || 1),
          aim: t.angle,
          attack: knifeCanHit(state as GameState, self, enemy),
          weapon: 'knife',
          plantMine: false,
        };
      }

      case 'shooter': {
        if (!self.hasGun || self.ammo === 0) {
          // Go get a gun (or ammo); fall back to brawling if none is on the map.
          const want = state.items.filter((it) => it.type === 'gun' || (self.hasGun && it.type === 'ammo'));
          want.sort((a, b) => Math.hypot(a.x - self.x, a.y - self.y) - Math.hypot(b.x - self.x, b.y - self.y));
          if (want.length > 0) {
            const t = toward(self, want[0].x, want[0].y);
            return { moveX: t.dx / (t.dist || 1), moveY: t.dy / (t.dist || 1), aim: t.angle, attack: false, weapon: null, plantMine: false };
          }
          return new DummyController('brawler').decide(state, playerId);
        }
        if (!enemy) return { ...IDLE_ACTION, weapon: 'gun' };
        const t = toward(self, enemy.x, enemy.y);
        // Keep ~300 u away, circling slightly.
        const radial = t.dist > 340 ? 1 : t.dist < 260 ? -1 : 0;
        const nx = t.dx / (t.dist || 1);
        const ny = t.dy / (t.dist || 1);
        return {
          moveX: nx * radial - ny * 0.6,
          moveY: ny * radial + nx * 0.6,
          aim: t.angle,
          attack: self.weapon === 'gun' && Math.abs(angleDelta(t.angle, self.facing)) < 0.1,
          weapon: 'gun',
          plantMine: false,
        };
      }
    }
  }
}

function angleDelta(a: number, b: number): number {
  let d = (a - b) % (2 * Math.PI);
  if (d > Math.PI) d -= 2 * Math.PI;
  if (d <= -Math.PI) d += 2 * Math.PI;
  return d;
}
