import { ITEM_TYPES, secondsToTicks, type ItemType } from '../config.ts';
import { circleOverlapsRect } from '../geometry.ts';
import { length } from '../dmath.ts';
import type { GameState, Item, PlayerState } from '../types.ts';
import { insideZone, zoneAt, zoneShrinking } from './zone.ts';

/** Would picking up this item do anything for the player? Useless items are left on the ground. */
export function canUseItem(state: GameState, p: PlayerState, type: ItemType): boolean {
  const { player, gun, launcher, laser, mines, smoke, gas } = state.config;
  switch (type) {
    case 'smoke': return p.smokes < smoke.maxCarry;
    case 'gas': return p.gases < gas.maxCarry;
    case 'launcher': return !p.hasLauncher || p.grenades < launcher.maxAmmo;
    case 'laser': return !p.hasLaser || p.laserShots < laser.maxAmmo;
    case 'mines': return p.mines < mines.maxCarry;
    case 'gun': return !p.hasGun || p.ammo < gun.maxAmmo;
    case 'ammo': return p.hasGun && p.ammo < gun.maxAmmo;
    case 'shield': return p.shield < player.maxShield;
    case 'health': return p.hp < player.maxHp;
    case 'life': return p.lives < player.maxLives;
  }
}

function applyItem(state: GameState, p: PlayerState, item: Item): void {
  const { player, gun, items, launcher, laser, mines, smoke, gas } = state.config;
  switch (item.type) {
    case 'smoke':
      p.smokes = Math.min(smoke.maxCarry, p.smokes + item.ammo);
      break;
    case 'gas':
      p.gases = Math.min(gas.maxCarry, p.gases + item.ammo);
      break;
    case 'laser':
      p.hasLaser = true;
      p.laserShots = Math.min(laser.maxAmmo, p.laserShots + item.ammo);
      break;
    case 'launcher':
      p.hasLauncher = true;
      p.grenades = Math.min(launcher.maxAmmo, p.grenades + item.ammo);
      break;
    case 'mines':
      p.mines = Math.min(mines.maxCarry, p.mines + item.ammo);
      break;
    case 'gun':
      p.hasGun = true;
      p.ammo = Math.min(gun.maxAmmo, p.ammo + item.ammo);
      break;
    case 'ammo':
      p.ammo = Math.min(gun.maxAmmo, p.ammo + items.ammoAmount);
      break;
    case 'shield':
      p.shield = Math.min(player.maxShield, p.shield + items.shieldAmount);
      break;
    case 'health':
      p.hp = Math.min(player.maxHp, p.hp + items.healthAmount);
      break;
    case 'life':
      p.lives = Math.min(player.maxLives, p.lives + items.lifeAmount);
      break;
  }
}

/**
 * Each item goes to the closest living player touching it who can use it.
 * Exact distance ties are broken with the seeded item RNG.
 */
export function handlePickups(state: GameState): void {
  const reach = state.config.player.radius + state.config.items.radius;
  const remaining: Item[] = [];
  for (const item of state.items) {
    let best: PlayerState[] = [];
    let bestDist = Infinity;
    for (const p of state.players) {
      if (!p.alive) continue;
      const d = length(p.x - item.x, p.y - item.y);
      if (d > reach || !canUseItem(state, p, item.type)) continue;
      if (d < bestDist) {
        best = [p];
        bestDist = d;
      } else if (d === bestDist) {
        best.push(p);
      }
    }
    if (best.length === 0) {
      remaining.push(item);
      continue;
    }
    const taker = best.length === 1 ? best[0] : best[state.rng.items.int(best.length)];
    applyItem(state, taker, item);
    taker.stats.itemsPicked++;
    taker.stats.itemsByType[item.type]++;
    if (item.padIndex >= 0) {
      const pad = state.gunPads[item.padIndex];
      pad.itemId = -1;
      pad.refillTimer = secondsToTicks(state.config.items.gunPadRespawn, state.config);
    }
    state.events.push({ type: 'pickup', tick: state.tick, playerId: taker.id, itemId: item.id, itemType: item.type });
  }
  state.items = remaining;
}

/** Put a gun on every empty map gun pad whose refill timer has run out. */
export function refillGunPads(state: GameState): void {
  state.gunPads.forEach((pad, index) => {
    if (pad.itemId >= 0 || pad.refillTimer > 0) return;
    const id = state.nextEntityId++;
    state.items.push({ id, type: 'gun', x: pad.x, y: pad.y, ammo: state.config.gun.pickupAmmo, origin: 'pad', padIndex: index });
    pad.itemId = id;
    state.events.push({ type: 'itemSpawn', tick: state.tick, itemId: id, itemType: 'gun', x: pad.x, y: pad.y });
  });
}

/** Ammo (or count) a freshly spawned item of this type carries. */
export function defaultItemAmmo(state: GameState, type: ItemType): number {
  const { gun, launcher, laser, mines, smoke, gas } = state.config;
  return type === 'gun' ? gun.pickupAmmo : type === 'launcher' ? launcher.pickupAmmo : type === 'laser' ? laser.pickupAmmo
    : type === 'mines' ? mines.pickupAmount : type === 'smoke' ? smoke.pickupAmount : type === 'gas' ? gas.pickupAmount : 0;
}

/**
 * A random spot for a new item: inside the arena, clear of walls, and not right
 * next to a living player or another item. Null if none was found.
 */
export function findItemSpot(state: GameState): { x: number; y: number } | null {
  const { map, config, rng } = state;
  const margin = config.items.radius + 8;
  // Once the zone shrinks, random items only appear inside it.
  let [x0, x1, y0, y1] = [margin, map.width - margin, margin, map.height - margin];
  const zone = zoneShrinking(state) ? zoneAt(state) : null;
  if (zone) {
    const reach = zone.radius - margin;
    if (reach <= 0) return null;
    [x0, x1, y0, y1] = [Math.max(x0, zone.x - reach), Math.min(x1, zone.x + reach), Math.max(y0, zone.y - reach), Math.min(y1, zone.y + reach)];
  }
  for (let attempt = 0; attempt < 40; attempt++) {
    const x = rng.items.range(x0, x1);
    const y = rng.items.range(y0, y1);
    if (zone && !insideZone(zone, x, y, margin)) continue;
    if (map.walls.some((w) => circleOverlapsRect(x, y, margin, w))) continue;
    if (state.players.some((p) => p.alive && length(p.x - x, p.y - y) < 80)) continue;
    if (state.items.some((i) => length(i.x - x, i.y - y) < 60)) continue;
    return { x, y };
  }
  return null;
}

/** Every items.spawnInterval, add a weighted-random item while fewer than items.maxOnMap spawned items exist. */
export function updateItemSpawner(state: GameState): void {
  if (state.itemSpawnTimer > 0) return;
  state.itemSpawnTimer = secondsToTicks(state.config.items.spawnInterval, state.config);
  // Items left outside a shrinking zone don't count, so fresh ones keep appearing inside it.
  const zone = zoneShrinking(state) ? zoneAt(state) : null;
  const spawned = state.items.filter((i) => i.origin === 'random' && (!zone || insideZone(zone, i.x, i.y))).length;
  if (spawned >= state.config.items.maxOnMap) return;
  const type = state.rng.items.weighted(state.config.items.weights, ITEM_TYPES);
  if (!type) return;
  const spot = findItemSpot(state);
  if (!spot) return;
  const id = state.nextEntityId++;
  state.items.push({ id, type, x: spot.x, y: spot.y, ammo: defaultItemAmmo(state, type), origin: 'random', padIndex: -1 });
  state.events.push({ type: 'itemSpawn', tick: state.tick, itemId: id, itemType: type, x: spot.x, y: spot.y });
}
