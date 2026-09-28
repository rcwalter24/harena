import { secondsToTicks, type ItemType } from '../config.ts';
import { DEG, dcos, dsin, length, normalizeAngle } from '../dmath.ts';
import { resolveCircleWalls } from '../geometry.ts';
import type { GameState, PlayerState, SpawnPoint } from '../types.ts';

/** Handle players whose hp reached 0 this tick: lose a life, drop the gun, credit the kill. */
export function handleDeaths(state: GameState): void {
  const { config } = state;
  for (const p of state.players) {
    if (!p.alive || p.hp > 0) continue;
    p.alive = false;
    p.vx = 0;
    p.vy = 0;
    p.lives = Math.max(0, p.lives - 1);
    p.stats.deaths++;

    const killer = p.lastDamagerId >= 0 && p.lastDamagerId !== p.id ? state.players[p.lastDamagerId] : null;
    if (killer) killer.stats.kills++;

    // Drop gear where the player died, slightly spread so the items don't stack.
    const drops: Array<[ItemType, number]> = [];
    if (p.hasGun && p.ammo > 0) drops.push(['gun', p.ammo]);
    if (p.hasLauncher && p.grenades > 0) drops.push(['launcher', p.grenades]);
    if (p.mines > 0) drops.push(['mines', p.mines]);
    drops.forEach(([type, ammo], i) => {
      const offset = drops.length > 1 ? 14 : 0;
      const angle = (i * 2 * Math.PI) / drops.length;
      const pos = resolveCircleWalls(
        { x: p.x + offset * dcos(angle), y: p.y + offset * dsin(angle) },
        state.config.items.radius, state.map.walls, state.map.width, state.map.height,
      );
      const id = state.nextEntityId++;
      state.items.push({ id, type, x: pos.x, y: pos.y, ammo, origin: 'drop', padIndex: -1 });
      state.events.push({ type: 'itemSpawn', tick: state.tick, itemId: id, itemType: type, x: pos.x, y: pos.y });
    });
    p.hasGun = false;
    p.ammo = 0;
    p.hasLauncher = false;
    p.grenades = 0;
    p.mines = 0;
    p.weapon = 'knife';

    state.events.push({
      type: 'death', tick: state.tick, playerId: p.id, killerId: killer ? killer.id : -1,
      weapon: p.lastDamageWeapon, livesLeft: p.lives,
    });

    if (p.lives <= 0) {
      p.eliminated = true;
      p.eliminatedTick = state.tick;
      state.events.push({ type: 'eliminated', tick: state.tick, playerId: p.id });
    } else {
      p.respawnTimer = secondsToTicks(config.respawn.delay, config);
    }
  }
}

export function handleRespawns(state: GameState): void {
  for (const p of state.players) {
    if (p.alive || p.eliminated || p.respawnTimer > 0) continue;
    const spawn = pickRespawnPoint(state, p);
    placeAtSpawn(state, p, spawn);
    p.invulnerableTimer = secondsToTicks(state.config.respawn.invulnerability, state.config);
    state.events.push({ type: 'respawn', tick: state.tick, playerId: p.id, x: p.x, y: p.y });
  }
}

/** Reset a player to full health at a spawn point (used for the initial spawn and respawns). */
export function placeAtSpawn(state: GameState, p: PlayerState, spawn: SpawnPoint): void {
  const { player } = state.config;
  p.x = spawn.x;
  p.y = spawn.y;
  p.vx = 0;
  p.vy = 0;
  p.facing = normalizeAngle((spawn.facing ?? 0) * DEG);
  p.hp = player.maxHp;
  p.shield = player.startShield;
  p.alive = true;
  p.weapon = 'knife';
  p.knifeCooldown = 0;
  p.gunCooldown = 0;
  p.launcherCooldown = 0;
  p.mineCooldown = 0;
  p.switchTimer = 0;
  p.respawnTimer = 0;
  p.lastDamagerId = -1;
  p.lastDamageWeapon = null;
}

/**
 * A random spawn point that is at least `respawn.safeDistance` from every living
 * enemy and not blocked by a player; if none qualifies, the one farthest from
 * the nearest enemy.
 */
export function pickRespawnPoint(state: GameState, self: PlayerState): SpawnPoint {
  const { spawns } = state.map;
  const r = state.config.player.radius;
  const enemies = state.players.filter((q) => q !== self && q.alive);
  const nearestEnemy = (s: SpawnPoint): number => {
    let best = Infinity;
    for (const e of enemies) best = Math.min(best, length(e.x - s.x, e.y - s.y));
    return best;
  };
  const safe = spawns.filter((s) => nearestEnemy(s) >= Math.max(state.config.respawn.safeDistance, 2 * r));
  if (safe.length > 0) return safe[state.rng.spawns.int(safe.length)];
  let best = spawns[0];
  let bestDist = -Infinity;
  for (const s of spawns) {
    const d = nearestEnemy(s);
    if (d > bestDist) {
      best = s;
      bestDist = d;
    }
  }
  return best;
}
