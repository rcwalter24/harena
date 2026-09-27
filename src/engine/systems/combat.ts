import { secondsToTicks } from '../config.ts';
import { DEG, dcos, direction, length } from '../dmath.ts';
import { lineOfSight, segmentCircleHit, segmentRectHit } from '../geometry.ts';
import type { ActionInput, GameState, PlayerState, Weapon } from '../types.ts';

/**
 * Apply damage to a target. Shield absorbs first. Players that are dead, already
 * at 0 hp this tick, or invulnerable take nothing. Returns the damage dealt.
 */
export function applyDamage(
  state: GameState, target: PlayerState, amount: number, attacker: PlayerState, weapon: Weapon,
): number {
  if (!target.alive || target.hp <= 0 || target.invulnerableTimer > 0 || amount <= 0) return 0;
  const shieldDamage = Math.min(target.shield, amount);
  const hpDamage = Math.min(target.hp, amount - shieldDamage);
  target.shield -= shieldDamage;
  target.hp -= hpDamage;
  const dealt = shieldDamage + hpDamage;
  target.lastDamagerId = attacker.id;
  target.lastDamageWeapon = weapon;
  target.stats.damageTaken += dealt;
  attacker.stats.damageDealt += dealt;
  state.events.push({
    type: 'hit', tick: state.tick, attackerId: attacker.id, targetId: target.id,
    weapon, damage: dealt, shieldDamage, hpDamage,
  });
  return dealt;
}

/** Can `p` hit `target` with a knife swing right now (range, arc, line of sight)? */
export function knifeCanHit(state: GameState, p: PlayerState, target: PlayerState): boolean {
  const { player, knife } = state.config;
  const dx = target.x - p.x;
  const dy = target.y - p.y;
  const d = length(dx, dy);
  if (d > 2 * player.radius + knife.reach) return false;
  if (d > 1e-9) {
    const f = direction(p.facing);
    const cosToTarget = (dx * f.x + dy * f.y) / d;
    if (cosToTarget < dcos((knife.arcDegrees / 2) * DEG)) return false;
  }
  return lineOfSight(p.x, p.y, target.x, target.y, state.map.walls);
}

export function applyAttacks(state: GameState, actions: readonly ActionInput[]): void {
  const { config } = state;
  for (const p of state.players) {
    if (!p.alive || !actions[p.id].attack || p.switchTimer > 0) continue;
    if (p.weapon === 'knife') {
      if (p.knifeCooldown > 0) continue;
      p.knifeCooldown = secondsToTicks(config.knife.cooldown, config);
      p.invulnerableTimer = 0;
      p.stats.knifeSwings++;
      const hitIds: number[] = [];
      for (const target of state.players) {
        if (target === p || !target.alive || target.hp <= 0) continue;
        if (!knifeCanHit(state, p, target)) continue;
        if (applyDamage(state, target, config.knife.damage, p, 'knife') > 0) hitIds.push(target.id);
      }
      if (hitIds.length > 0) p.stats.knifeHits++;
      state.events.push({ type: 'swing', tick: state.tick, playerId: p.id, hitIds });
    } else {
      if (p.gunCooldown > 0 || p.ammo <= 0 || !p.hasGun) continue;
      p.gunCooldown = secondsToTicks(config.gun.cooldown, config);
      p.invulnerableTimer = 0;
      p.ammo--;
      p.stats.shotsFired++;
      const f = direction(p.facing);
      const bullet = {
        id: state.nextEntityId++,
        ownerId: p.id,
        x: p.x,
        y: p.y,
        vx: f.x * config.gun.bulletSpeed,
        vy: f.y * config.gun.bulletSpeed,
        traveled: 0,
      };
      state.bullets.push(bullet);
      state.events.push({ type: 'shot', tick: state.tick, playerId: p.id, bulletId: bullet.id });
    }
  }
}

/**
 * Advance bullets one tick along a swept segment. A bullet stops at whichever
 * comes first on its path: a wall, a player (not its owner), or its max range.
 * Bullets fired this tick start at the shooter's centre and move immediately.
 */
export function updateBullets(state: GameState): void {
  const { config, map } = state;
  const dt = 1 / config.tickRate;
  const hitRadius = config.player.radius + config.gun.bulletRadius;
  const survivors = [];

  for (const b of state.bullets) {
    let stepLen = config.gun.bulletSpeed * dt;
    const remaining = config.gun.range - b.traveled;
    const expires = stepLen >= remaining;
    if (expires) stepLen = Math.max(0, remaining);
    const x0 = b.x;
    const y0 = b.y;
    const x1 = x0 + (b.vx / config.gun.bulletSpeed) * stepLen;
    const y1 = y0 + (b.vy / config.gun.bulletSpeed) * stepLen;

    let wallT = Infinity;
    for (const wall of map.walls) {
      const t = segmentRectHit(x0, y0, x1, y1, wall, config.gun.bulletRadius);
      if (t !== null && t < wallT) wallT = t;
    }
    let hitPlayer: PlayerState | null = null;
    let playerT = Infinity;
    for (const p of state.players) {
      if (p.id === b.ownerId || !p.alive || p.hp <= 0) continue;
      const t = segmentCircleHit(x0, y0, x1, y1, p.x, p.y, hitRadius);
      if (t !== null && t < playerT) {
        playerT = t;
        hitPlayer = p;
      }
    }

    if (hitPlayer && playerT <= wallT) {
      const owner = state.players[b.ownerId];
      owner.stats.shotsHit++;
      applyDamage(state, hitPlayer, config.gun.damage, owner, 'gun');
      endBullet(state, b.id, x0 + (x1 - x0) * playerT, y0 + (y1 - y0) * playerT, 'player');
      continue;
    }
    if (wallT <= 1) {
      endBullet(state, b.id, x0 + (x1 - x0) * wallT, y0 + (y1 - y0) * wallT, 'wall');
      continue;
    }
    b.x = x1;
    b.y = y1;
    b.traveled += stepLen;
    if (expires) {
      endBullet(state, b.id, x1, y1, 'range');
      continue;
    }
    survivors.push(b);
  }
  state.bullets = survivors;
}

function endBullet(state: GameState, bulletId: number, x: number, y: number, reason: 'wall' | 'player' | 'range'): void {
  state.events.push({ type: 'bulletEnd', tick: state.tick, bulletId, x, y, reason });
}
