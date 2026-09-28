/**
 * Every tunable game rule lives here. BOT_API.md is generated from this file,
 * so each leaf value must also have an entry in CONFIG_DOCS.
 *
 * Units: distances in world units (u), times in seconds (s), speeds in u/s,
 * angles in degrees where noted (the engine converts to radians / ticks).
 */

export type ItemType = 'ammo' | 'shield' | 'health' | 'gun' | 'life' | 'launcher' | 'mines';

export const ITEM_TYPES: readonly ItemType[] = ['ammo', 'shield', 'health', 'gun', 'life', 'launcher', 'mines'];

export interface GameConfig {
  tickRate: number;
  player: {
    radius: number;
    speedKnife: number;
    speedGun: number;
    speedLauncher: number;
    turnRateDegrees: number;
    maxHp: number;
    maxShield: number;
    startShield: number;
    startLives: number;
    maxLives: number;
    switchTime: number;
  };
  knife: {
    damage: number;
    reach: number;
    arcDegrees: number;
    cooldown: number;
  };
  gun: {
    damage: number;
    bulletSpeed: number;
    bulletRadius: number;
    cooldown: number;
    range: number;
    pickupAmmo: number;
    maxAmmo: number;
  };
  launcher: {
    grenadeSpeed: number;
    grenadeRadius: number;
    cooldown: number;
    range: number;
    pickupAmmo: number;
    maxAmmo: number;
    blastRadius: number;
    centerDamage: number;
    edgeDamage: number;
  };
  mines: {
    fuse: number;
    plantCooldown: number;
    pickupAmount: number;
    maxCarry: number;
    blastRadius: number;
    centerDamage: number;
    edgeDamage: number;
  };
  explosions: {
    selfDamageFactor: number;
  };
  bushes: {
    revealDistance: number;
    noiseRevealTime: number;
  };
  zone: {
    shrinkStart: number;
    shrinkDuration: number;
    finalRadius: number;
    holdTime: number;
    collapseDuration: number;
    damagePerSecond: number;
  };
  respawn: {
    delay: number;
    invulnerability: number;
    safeDistance: number;
  };
  items: {
    radius: number;
    firstSpawnDelay: number;
    spawnInterval: number;
    maxOnMap: number;
    gunPadRespawn: number;
    ammoAmount: number;
    shieldAmount: number;
    healthAmount: number;
    lifeAmount: number;
    weights: Record<ItemType, number>;
  };
  match: {
    defaultTimeLimit: number;
    minPlayers: number;
    maxPlayers: number;
  };
  sandbox: {
    initBudgetMs: number;
    decideBudgetMs: number;
    graceMs: number;
    hangLimitMs: number;
    failureStreakLimit: number;
  };
}

export const DEFAULT_CONFIG: GameConfig = {
  tickRate: 30,
  player: {
    radius: 16,
    speedKnife: 210,
    speedGun: 190,
    speedLauncher: 180,
    turnRateDegrees: 540,
    maxHp: 100,
    maxShield: 100,
    startShield: 0,
    startLives: 3,
    maxLives: 5,
    switchTime: 0.3,
  },
  knife: {
    damage: 35,
    reach: 36,
    arcDegrees: 100,
    cooldown: 0.5,
  },
  gun: {
    damage: 20,
    bulletSpeed: 480,
    bulletRadius: 4,
    cooldown: 0.35,
    range: 900,
    pickupAmmo: 15,
    maxAmmo: 40,
  },
  launcher: {
    grenadeSpeed: 360,
    grenadeRadius: 6,
    cooldown: 1.2,
    range: 700,
    pickupAmmo: 3,
    maxAmmo: 6,
    blastRadius: 80,
    centerDamage: 70,
    edgeDamage: 20,
  },
  mines: {
    fuse: 2.5,
    plantCooldown: 0.5,
    pickupAmount: 2,
    maxCarry: 3,
    blastRadius: 100,
    centerDamage: 90,
    edgeDamage: 25,
  },
  explosions: {
    selfDamageFactor: 1,
  },
  bushes: {
    revealDistance: 90,
    noiseRevealTime: 1,
  },
  zone: {
    shrinkStart: 45,
    shrinkDuration: 105,
    finalRadius: 200,
    holdTime: 15,
    collapseDuration: 15,
    damagePerSecond: 10,
  },
  respawn: {
    delay: 2,
    invulnerability: 1.5,
    safeDistance: 300,
  },
  items: {
    radius: 12,
    firstSpawnDelay: 3,
    spawnInterval: 6,
    maxOnMap: 6,
    gunPadRespawn: 20,
    ammoAmount: 10,
    shieldAmount: 50,
    healthAmount: 40,
    lifeAmount: 1,
    weights: { ammo: 30, shield: 25, health: 25, gun: 12, life: 8, launcher: 6, mines: 10 },
  },
  match: {
    defaultTimeLimit: 180,
    minPlayers: 1,
    maxPlayers: 8,
  },
  sandbox: {
    initBudgetMs: 1000,
    decideBudgetMs: 10,
    graceMs: 40,
    hangLimitMs: 1000,
    failureStreakLimit: 5,
  },
};

export interface ConfigDoc {
  unit: string;
  description: string;
}

/** Human-readable documentation for every leaf of GameConfig (keyed by dotted path). */
export const CONFIG_DOCS: Record<string, ConfigDoc> = {
  'tickRate': { unit: 'ticks/s', description: 'Simulation ticks per second. decide() is called once per tick.' },
  'player.radius': { unit: 'u', description: 'Collision radius of every player (players are circles).' },
  'player.speedKnife': { unit: 'u/s', description: 'Maximum movement speed while holding the knife.' },
  'player.speedGun': { unit: 'u/s', description: 'Maximum movement speed while holding the gun.' },
  'player.speedLauncher': { unit: 'u/s', description: 'Maximum movement speed while holding the grenade launcher.' },
  'player.turnRateDegrees': { unit: 'deg/s', description: 'Maximum rate at which facing rotates toward the requested aim angle.' },
  'player.maxHp': { unit: 'hp', description: 'Health at spawn and the health cap.' },
  'player.maxShield': { unit: 'shield', description: 'Shield cap. Shield absorbs damage before health.' },
  'player.startShield': { unit: 'shield', description: 'Shield at every spawn and respawn.' },
  'player.startLives': { unit: 'lives', description: 'Lives at match start (including the current one).' },
  'player.maxLives': { unit: 'lives', description: 'Lives cap; extra-life items are not picked up at the cap.' },
  'player.switchTime': { unit: 's', description: 'After switching weapons you cannot attack for this long.' },
  'knife.damage': { unit: 'hp', description: 'Damage of one knife hit.' },
  'knife.reach': { unit: 'u', description: "Reach beyond the attacker's edge: a target is in range if centre distance <= 2*radius + reach." },
  'knife.arcDegrees': { unit: 'deg', description: "Total width of the knife arc, centred on the attacker's facing." },
  'knife.cooldown': { unit: 's', description: 'Minimum time between knife swings.' },
  'gun.damage': { unit: 'hp', description: 'Damage of one bullet.' },
  'gun.bulletSpeed': { unit: 'u/s', description: 'Bullet speed (constant, straight line).' },
  'gun.bulletRadius': { unit: 'u', description: 'Bullet collision radius.' },
  'gun.cooldown': { unit: 's', description: 'Minimum time between shots.' },
  'gun.range': { unit: 'u', description: 'Bullets disappear after travelling this far.' },
  'gun.pickupAmmo': { unit: 'bullets', description: 'Ammo gained from a gun item spawned by the map or the item spawner.' },
  'gun.maxAmmo': { unit: 'bullets', description: 'Ammo cap.' },
  'launcher.grenadeSpeed': { unit: 'u/s', description: 'Grenade speed (constant, straight line).' },
  'launcher.grenadeRadius': { unit: 'u', description: 'Grenade collision radius.' },
  'launcher.cooldown': { unit: 's', description: 'Minimum time between grenade shots.' },
  'launcher.range': { unit: 'u', description: 'A grenade explodes by itself after travelling this far.' },
  'launcher.pickupAmmo': { unit: 'grenades', description: 'Grenades gained from a launcher item.' },
  'launcher.maxAmmo': { unit: 'grenades', description: 'Grenade cap.' },
  'launcher.blastRadius': { unit: 'u', description: 'Grenade explosion radius (measured to the edge of a target).' },
  'launcher.centerDamage': { unit: 'hp', description: 'Grenade damage at the centre of the explosion.' },
  'launcher.edgeDamage': { unit: 'hp', description: 'Grenade damage at the edge of the blast radius (linear falloff in between).' },
  'mines.fuse': { unit: 's', description: 'A planted mine explodes this long after being planted.' },
  'mines.plantCooldown': { unit: 's', description: 'Minimum time between planting two mines.' },
  'mines.pickupAmount': { unit: 'mines', description: 'Mines gained from a mines item.' },
  'mines.maxCarry': { unit: 'mines', description: 'Maximum mines carried.' },
  'mines.blastRadius': { unit: 'u', description: 'Mine explosion radius (measured to the edge of a target).' },
  'mines.centerDamage': { unit: 'hp', description: 'Mine damage at the centre of the explosion.' },
  'mines.edgeDamage': { unit: 'hp', description: 'Mine damage at the edge of the blast radius (linear falloff in between).' },
  'explosions.selfDamageFactor': { unit: 'x', description: 'Multiplier for damage you take from your own explosions (1 = full damage).' },
  'bushes.revealDistance': { unit: 'u', description: 'An enemy in a bush is visible to you if the centres are at most this far apart.' },
  'bushes.noiseRevealTime': { unit: 's', description: 'A player in a bush stays visible this long after attacking or taking damage.' },
  'zone.shrinkStart': { unit: 's', description: 'Match time at which the safe zone starts shrinking (before that it covers the whole map).' },
  'zone.shrinkDuration': { unit: 's', description: 'The zone radius shrinks linearly to its final size over this long.' },
  'zone.finalRadius': { unit: 'u', description: 'Radius at the end of the first shrink. Its centre is the map centre.' },
  'zone.holdTime': { unit: 's', description: 'The zone then stays at finalRadius for this long.' },
  'zone.collapseDuration': { unit: 's', description: 'Then it shrinks linearly from finalRadius to 0 over this long (0 = it never collapses).' },
  'zone.damagePerSecond': { unit: 'hp', description: 'Damage taken at every whole second of match time while your centre is outside the zone (0 = zone off).' },
  'respawn.delay': { unit: 's', description: 'Time between losing a life and respawning.' },
  'respawn.invulnerability': { unit: 's', description: 'Invulnerability after (re)spawning; ends early when you attack.' },
  'respawn.safeDistance': { unit: 'u', description: 'Respawn picks a random spawn point at least this far from every living enemy (else the farthest one).' },
  'items.radius': { unit: 'u', description: 'Pickup radius of items: picked up when centre distance <= player radius + item radius.' },
  'items.firstSpawnDelay': { unit: 's', description: 'Time before the first random item spawns.' },
  'items.spawnInterval': { unit: 's', description: 'Time between random item spawns.' },
  'items.maxOnMap': { unit: 'items', description: 'Random spawning pauses while this many random items are on the map.' },
  'items.gunPadRespawn': { unit: 's', description: "A map gun pad refills this long after its gun is taken." },
  'items.ammoAmount': { unit: 'bullets', description: 'Ammo from an ammo item (only picked up if you hold a gun and are below max ammo).' },
  'items.shieldAmount': { unit: 'shield', description: 'Shield from a shield item (only picked up below max shield).' },
  'items.healthAmount': { unit: 'hp', description: 'Health from a health item (only picked up below max health).' },
  'items.lifeAmount': { unit: 'lives', description: 'Lives from an extra-life item (only picked up below max lives).' },
  'items.weights.ammo': { unit: 'weight', description: 'Relative spawn weight of ammo items.' },
  'items.weights.shield': { unit: 'weight', description: 'Relative spawn weight of shield items.' },
  'items.weights.health': { unit: 'weight', description: 'Relative spawn weight of health items.' },
  'items.weights.gun': { unit: 'weight', description: 'Relative spawn weight of gun items.' },
  'items.weights.life': { unit: 'weight', description: 'Relative spawn weight of extra-life items.' },
  'items.weights.launcher': { unit: 'weight', description: 'Relative spawn weight of grenade launcher items.' },
  'items.weights.mines': { unit: 'weight', description: 'Relative spawn weight of mines items.' },
  'match.defaultTimeLimit': { unit: 's', description: 'Default match length (the match setup may change it).' },
  'match.minPlayers': { unit: 'players', description: 'Minimum players in a match.' },
  'match.maxPlayers': { unit: 'players', description: 'Maximum players in a match.' },
  'sandbox.initBudgetMs': { unit: 'ms', description: 'Time budget for init().' },
  'sandbox.decideBudgetMs': { unit: 'ms', description: 'Time budget for one decide() call.' },
  'sandbox.graceMs': { unit: 'ms', description: 'Extra wall-clock wait for message passing before a reply counts as late.' },
  'sandbox.hangLimitMs': { unit: 'ms', description: 'A bot silent for this long is terminated and restarted once; a second hang disables it.' },
  'sandbox.failureStreakLimit': { unit: 'ticks', description: 'After this many consecutive failures (timeout, exception, invalid action) the bot stands still until it recovers.' },
};

/** Convert seconds to whole ticks (at least 0). */
export function secondsToTicks(seconds: number, config: GameConfig): number {
  return Math.max(0, Math.round(seconds * config.tickRate));
}

/** Flatten a config into dotted-path → value pairs (used by docs and tests). */
export function flattenConfig(obj: object, prefix = ''): Array<[string, number]> {
  const out: Array<[string, number]> = [];
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'number') out.push([path, value]);
    else if (value && typeof value === 'object') out.push(...flattenConfig(value, path));
  }
  return out;
}

/** Deep-merge a partial override onto a config (used for match settings and tests). */
export function mergeConfig(base: GameConfig, override: DeepPartial<GameConfig> = {}): GameConfig {
  const merge = (a: any, b: any): any => {
    if (typeof a !== 'object' || a === null) return b === undefined ? a : b;
    const out: any = {};
    for (const key of Object.keys(a)) out[key] = merge(a[key], b?.[key]);
    return out;
  };
  return merge(base, override);
}

export type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };
