import { secondsToTicks } from '../config.ts';
import { length } from '../dmath.ts';
import { lineOfSight, pathAroundWalls, pathsAroundWallsFrom, segmentCircleHit, segmentRectHit } from '../geometry.ts';
import { solidRects, type ActionInput, type Explosion, type GameState, type PlayerState } from '../types.ts';
import { applyDamage } from './combat.ts';
import { blowHoles } from './throwables.ts';

/** Plant mines for players who asked to (any weapon in hand, even while switching). */
export function plantMines(state: GameState, actions: readonly ActionInput[]): void {
  const { config } = state;
  for (const p of state.players) {
    if (!p.alive || !actions[p.id].plantMine || p.mines <= 0 || p.mineCooldown > 0) continue;
    p.mines--;
    p.mineCooldown = secondsToTicks(config.mines.plantCooldown, config);
    p.invulnerableTimer = 0;
    p.noiseTimer = secondsToTicks(config.bushes.noiseRevealTime, config);
    p.stats.minesPlanted++;
    const mine = { id: state.nextEntityId++, ownerId: p.id, x: p.x, y: p.y, fuseTimer: Math.max(1, secondsToTicks(config.mines.fuse, config)) };
    state.mines.push(mine);
    state.events.push({ type: 'minePlanted', tick: state.tick, playerId: p.id, mineId: mine.id, x: mine.x, y: mine.y });
  }
}

/**
 * Move grenades along a swept segment. A grenade explodes at the first wall or
 * player (other than its owner) it touches, or where its range runs out.
 * Returns the resulting explosions (not yet resolved).
 */
export function updateGrenades(state: GameState): Explosion[] {
  const { config, map } = state;
  const { launcher } = config;
  const dt = 1 / config.tickRate;
  const hitRadius = config.player.radius + launcher.grenadeRadius;
  const out: Explosion[] = [];
  const survivors = [];

  for (const g of state.grenades) {
    let stepLen = launcher.grenadeSpeed * dt;
    const remaining = launcher.range - g.traveled;
    const expires = stepLen >= remaining;
    if (expires) stepLen = Math.max(0, remaining);
    const x0 = g.x;
    const y0 = g.y;
    const x1 = x0 + (g.vx / launcher.grenadeSpeed) * stepLen;
    const y1 = y0 + (g.vy / launcher.grenadeSpeed) * stepLen;

    let hitT = Infinity;
    for (const wall of solidRects(map)) {
      const t = segmentRectHit(x0, y0, x1, y1, wall, launcher.grenadeRadius);
      if (t !== null && t < hitT) hitT = t;
    }
    for (const p of state.players) {
      if (p.id === g.ownerId || !p.alive) continue;
      const t = segmentCircleHit(x0, y0, x1, y1, p.x, p.y, hitRadius);
      if (t !== null && t < hitT) hitT = t;
    }

    if (hitT <= 1 || expires) {
      const t = hitT <= 1 ? hitT : 1;
      out.push({
        ownerId: g.ownerId, source: 'grenade', sourceId: g.id,
        x: x0 + (x1 - x0) * t, y: y0 + (y1 - y0) * t, radius: launcher.blastRadius,
      });
      continue;
    }
    g.x = x1;
    g.y = y1;
    g.traveled += stepLen;
    survivors.push(g);
  }
  state.grenades = survivors;
  return out;
}

/** Mines whose fuse has run out explode now. */
export function dueMines(state: GameState): Explosion[] {
  const out: Explosion[] = [];
  const remaining = [];
  for (const m of state.mines) {
    if (m.fuseTimer <= 0) {
      out.push({ ownerId: m.ownerId, source: 'mine', sourceId: m.id, x: m.x, y: m.y, radius: state.config.mines.blastRadius });
    } else {
      remaining.push(m);
    }
  }
  state.mines = remaining;
  return out;
}

/** Damage at a given distance from the blast centre (to the target's edge), with linear falloff. */
export function blastDamage(center: number, edge: number, radius: number, distance: number): number {
  if (distance > radius) return 0;
  const d = Math.max(0, distance);
  return Math.round(center - (center - edge) * (d / radius));
}

/**
 * Damage a player centred at (px, py) takes from a `source` blast at (bx, by), before the
 * self-damage factor (0 if out of reach). Measured to the player's edge. Walls stop the blast,
 * but it spreads around wall corners: the distance that counts is the shortest path around
 * walls. With explosions.aroundCorners 0 (old replays) a wall on the straight line shields.
 */
export function blastDamageAt(state: GameState, source: 'grenade' | 'mine', bx: number, by: number, px: number, py: number): number {
  const { config } = state;
  const r = config.player.radius;
  const { blastRadius, centerDamage, edgeDamage } = source === 'grenade' ? config.launcher : config.mines;
  let distance = length(px - bx, py - by) - r;
  if (distance > blastRadius) return 0;
  if (config.explosions.aroundCorners > 0) {
    const path = pathAroundWalls(bx, by, px, py, state.map.walls, blastRadius + r);
    if (path === Infinity) return 0;
    distance = path - r;
  } else if (!lineOfSight(bx, by, px, py, state.map.walls)) {
    return 0;
  }
  return blastDamage(centerDamage, edgeDamage, blastRadius, distance);
}

/** `blastDamageAt` for one blast and many points (the renderer's damage maps), computed faster. */
export function blastDamageMap(state: GameState, source: 'grenade' | 'mine', bx: number, by: number): (px: number, py: number) => number {
  const { config } = state;
  const r = config.player.radius;
  const { blastRadius, centerDamage, edgeDamage } = source === 'grenade' ? config.launcher : config.mines;
  const path = config.explosions.aroundCorners > 0 ? pathsAroundWallsFrom(bx, by, state.map.walls, blastRadius + r) : null;
  return (px, py) => {
    let distance = length(px - bx, py - by) - r;
    if (distance > blastRadius) return 0;
    if (path) {
      const d = path(px, py);
      if (d === Infinity) return 0;
      distance = d - r;
    } else if (!lineOfSight(bx, by, px, py, state.map.walls)) {
      return 0;
    }
    return blastDamage(centerDamage, edgeDamage, blastRadius, distance);
  };
}

/**
 * Resolve a queue of explosions in order. Each explosion first detonates every
 * mine within its radius (they join the end of the queue: chain reactions),
 * then damages every living player within radius (measured to the player's
 * edge). Walls stop the blast, but it spreads around wall corners: the distance
 * that counts is the shortest path around walls (with explosions.aroundCorners 0,
 * as in old replays, a wall anywhere on the straight line shields). Owners take
 * explosions.selfDamageFactor × damage from their own blasts.
 */
export function resolveExplosions(state: GameState, queue: Explosion[]): void {
  const { config } = state;
  for (let i = 0; i < queue.length; i++) {
    const e = queue[i];

    const chained = state.mines.filter((m) => length(m.x - e.x, m.y - e.y) <= e.radius);
    if (chained.length > 0) {
      state.mines = state.mines.filter((m) => !chained.includes(m));
      chained.sort((a, b) => a.id - b.id);
      for (const m of chained) {
        queue.push({ ownerId: m.ownerId, source: 'mine', sourceId: m.id, x: m.x, y: m.y, radius: config.mines.blastRadius });
      }
    }

    const owner: PlayerState = state.players[e.ownerId];
    const hitIds: number[] = [];
    for (const p of state.players) {
      if (!p.alive || p.hp <= 0) continue;
      let amount = blastDamageAt(state, e.source, e.x, e.y, p.x, p.y);
      if (amount <= 0) continue;
      if (p.id === e.ownerId) amount = Math.round(amount * config.explosions.selfDamageFactor);
      const dealt = applyDamage(state, p, amount, owner, e.source === 'grenade' ? 'launcher' : 'mine');
      if (dealt > 0) hitIds.push(p.id);
    }
    if (e.source === 'grenade' && hitIds.some((id) => id !== e.ownerId)) owner.stats.grenadeHits++;
    // The blast also clears smoke and gas where it reaches, for a moment.
    blowHoles(state, e.x, e.y, e.radius + config.player.radius);
    state.explosions.push(e);
    state.events.push({ type: 'explosion', tick: state.tick, ownerId: e.ownerId, source: e.source, sourceId: e.sourceId, x: e.x, y: e.y, radius: e.radius, hitIds });
  }
}
