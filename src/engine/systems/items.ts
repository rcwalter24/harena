import { secondsToTicks, type ItemType } from '../config.ts';
import { length } from '../dmath.ts';
import type { GameState, Item, PlayerState } from '../types.ts';

/** Would picking up this item do anything for the player? Useless items are left on the ground. */
export function canUseItem(state: GameState, p: PlayerState, type: ItemType): boolean {
  const { player, gun } = state.config;
  switch (type) {
    case 'gun': return !p.hasGun || p.ammo < gun.maxAmmo;
    case 'ammo': return p.hasGun && p.ammo < gun.maxAmmo;
    case 'shield': return p.shield < player.maxShield;
    case 'health': return p.hp < player.maxHp;
    case 'life': return p.lives < player.maxLives;
  }
}

function applyItem(state: GameState, p: PlayerState, item: Item): void {
  const { player, gun, items } = state.config;
  switch (item.type) {
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
