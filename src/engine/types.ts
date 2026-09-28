import type { GameConfig, ItemType } from './config.ts';
import { boundaryWalls, type Rect } from './geometry.ts';
import type { Rng } from './rng.ts';

export type Weapon = 'knife' | 'gun' | 'launcher' | 'laser';

/** What dealt damage: a weapon, or a mine. */
export type DamageSource = Weapon | 'mine' | 'zone' | 'gas';

export type ThrowKind = 'smoke' | 'gas';

export interface SpawnPoint {
  x: number;
  y: number;
  /** Initial facing in degrees (0 = +x / right, 90 = +y / down). Default 0. */
  facing?: number;
}

/** A map, as stored in maps/*.json. */
export interface MapData {
  id: string;
  name: string;
  width: number;
  height: number;
  walls: Rect[];
  spawns: SpawnPoint[];
  gunSpawns: { x: number; y: number }[];
  /** Areas that hide players from enemies. They block nothing. */
  bushes?: Rect[];
}

/** Walls plus the map border, for projectile collisions. */
export function solidRects(map: MapData): Rect[] {
  let cached = solidCache.get(map);
  if (!cached) {
    cached = [...map.walls, ...boundaryWalls(map.width, map.height)];
    solidCache.set(map, cached);
  }
  return cached;
}
const solidCache = new WeakMap<MapData, Rect[]>();

/** Sanitized, engine-facing per-tick input for one player. */
export interface ActionInput {
  /** Desired move direction; length is clamped to 1 (1 = full speed). */
  moveX: number;
  moveY: number;
  /** Desired facing in radians, or null to keep turning toward nothing (keep facing). */
  aim: number | null;
  attack: boolean;
  /** Requested weapon, or null for no change. */
  weapon: Weapon | null;
  plantMine: boolean;
  /** Throw a smoke or gas grenade this tick, or null. */
  throwKind: ThrowKind | null;
  /** How far it should slide, or null for the maximum. */
  throwDistance: number | null;
}

export const IDLE_ACTION: Readonly<ActionInput> = Object.freeze({
  moveX: 0,
  moveY: 0,
  aim: null,
  attack: false,
  weapon: null,
  plantMine: false,
  throwKind: null,
  throwDistance: null,
});

export interface PlayerStats {
  kills: number;
  deaths: number;
  damageDealt: number;
  damageTaken: number;
  shotsFired: number;
  shotsHit: number;
  knifeSwings: number;
  knifeHits: number;
  grenadesFired: number;
  /** Grenades whose explosion damaged at least one enemy. */
  grenadeHits: number;
  lasersFired: number;
  /** Laser shots that hit an enemy. */
  laserHits: number;
  minesPlanted: number;
  itemsPicked: number;
  itemsByType: Record<ItemType, number>;
}

export interface PlayerState {
  id: number;
  name: string;
  x: number;
  y: number;
  /** Actual velocity over the last tick, u/s. */
  vx: number;
  vy: number;
  /** Facing in radians, (-PI, PI]. */
  facing: number;
  hp: number;
  shield: number;
  lives: number;
  alive: boolean;
  eliminated: boolean;
  /** Tick at which the player was eliminated, or -1. */
  eliminatedTick: number;
  weapon: Weapon;
  hasGun: boolean;
  /** Gun bullets. */
  ammo: number;
  hasLauncher: boolean;
  grenades: number;
  hasLaser: boolean;
  laserShots: number;
  mines: number;
  smokes: number;
  gases: number;
  throwCooldown: number;
  /** Remaining ticks for each timer; 0 = ready / inactive. */
  knifeCooldown: number;
  gunCooldown: number;
  launcherCooldown: number;
  laserCooldown: number;
  /** Ticks until a charging laser fires (0 = not charging). */
  laserCharge: number;
  /** Direction the charging laser is locked to, radians. */
  laserAim: number;
  mineCooldown: number;
  switchTimer: number;
  invulnerableTimer: number;
  respawnTimer: number;
  /** Ticks during which the player is revealed even inside a bush (after attacking or being hurt). */
  noiseTimer: number;
  /** Ticks spent in bushes in the current stay (capped at the hide limit); visibility only. */
  bushTicks: number;
  /** Ticks since leaving bushes, while bushTicks > 0; visibility only. */
  outOfBushTicks: number;
  /** Id of the last player who damaged this one during the current life, or -1. */
  lastDamagerId: number;
  lastDamageWeapon: DamageSource | null;
  stats: PlayerStats;
}

export interface Bullet {
  id: number;
  ownerId: number;
  x: number;
  y: number;
  /** Velocity, u/s. */
  vx: number;
  vy: number;
  traveled: number;
}

export interface Grenade {
  id: number;
  ownerId: number;
  x: number;
  y: number;
  /** Velocity, u/s. */
  vx: number;
  vy: number;
  traveled: number;
}

export interface Mine {
  id: number;
  ownerId: number;
  x: number;
  y: number;
  /** Ticks until it explodes. */
  fuseTimer: number;
}

/** A smoke or gas grenade sliding to a stop. */
export interface Throwable {
  id: number;
  ownerId: number;
  kind: ThrowKind;
  x: number;
  y: number;
  /** Velocity, u/s; it decreases by throwing.deceleration every second. */
  vx: number;
  vy: number;
}

/** A smoke or gas cloud left by a grenade that stopped. */
export interface Cloud {
  id: number;
  ownerId: number;
  kind: ThrowKind;
  x: number;
  y: number;
  radius: number;
  /** Ticks since it appeared. */
  age: number;
  /** Ticks until it disappears. */
  ticksLeft: number;
  /** Holes blown by explosions, closing over time. */
  holes: CloudHole[];
}

/** Part of a cloud blown away by an explosion: clear within `radius` (around walls), shrinking as it ages. */
export interface CloudHole {
  x: number;
  y: number;
  /** Radius when it was blown. */
  radius: number;
  /** Ticks since it was blown. */
  age: number;
}

export interface Explosion {
  ownerId: number;
  source: 'grenade' | 'mine';
  /** Id of the grenade or mine that exploded. */
  sourceId: number;
  x: number;
  y: number;
  radius: number;
}

export interface Item {
  id: number;
  type: ItemType;
  x: number;
  y: number;
  /** Ammo carried by a gun item, grenades by a launcher item, mine count by a mines item. */
  ammo: number;
  /** 'random' = item spawner, 'pad' = map gun pad, 'drop' = gun dropped on death. */
  origin: 'random' | 'pad' | 'drop';
  /** Index into GameState.gunPads if this item sits on a map gun pad, else -1. */
  padIndex: number;
}

export interface GunPad {
  x: number;
  y: number;
  /** Id of the gun item currently on the pad, or -1. */
  itemId: number;
  /** Ticks until the pad refills (only counts down while empty). */
  refillTimer: number;
}

export type GameEvent =
  | { type: 'shot'; tick: number; playerId: number; bulletId: number }
  | { type: 'swing'; tick: number; playerId: number; hitIds: number[] }
  | { type: 'hit'; tick: number; attackerId: number; targetId: number; weapon: DamageSource; damage: number; shieldDamage: number; hpDamage: number }
  | { type: 'grenade'; tick: number; playerId: number; grenadeId: number }
  | { type: 'laserCharge'; tick: number; playerId: number; aim: number }
  | { type: 'throw'; tick: number; playerId: number; throwableId: number; kind: ThrowKind }
  | { type: 'cloud'; tick: number; cloudId: number; ownerId: number; kind: ThrowKind; x: number; y: number; radius: number }
  /** A laser fired: `path` is x0, y0, x1, y1, … (start, bounce points, end); hitId is the player it stopped at, or -1. */
  | { type: 'laser'; tick: number; playerId: number; path: number[]; hitId: number }
  | { type: 'minePlanted'; tick: number; playerId: number; mineId: number; x: number; y: number }
  | { type: 'explosion'; tick: number; ownerId: number; source: 'grenade' | 'mine'; sourceId: number; x: number; y: number; radius: number; hitIds: number[] }
  | { type: 'bulletEnd'; tick: number; bulletId: number; x: number; y: number; reason: 'wall' | 'player' | 'range' }
  | { type: 'death'; tick: number; playerId: number; killerId: number; weapon: DamageSource | null; livesLeft: number }
  | { type: 'eliminated'; tick: number; playerId: number }
  | { type: 'respawn'; tick: number; playerId: number; x: number; y: number }
  | { type: 'switch'; tick: number; playerId: number; weapon: Weapon }
  | { type: 'pickup'; tick: number; playerId: number; itemId: number; itemType: ItemType }
  | { type: 'itemSpawn'; tick: number; itemId: number; itemType: ItemType; x: number; y: number }
  | { type: 'matchEnd'; tick: number; reason: MatchEndReason };

export type MatchEndReason = 'lastStanding' | 'allEliminated' | 'timeLimit';

export interface RankEntry {
  playerId: number;
  /** 1 = best. Tied players share a rank. */
  rank: number;
}

export interface MatchResult {
  reason: MatchEndReason;
  endTick: number;
  ranking: RankEntry[];
}

/** What one player last saw of another (used for players hidden in bushes). */
export interface Sighting {
  tick: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  facing: number;
}

export interface GameState {
  config: GameConfig;
  map: MapData;
  seed: string;
  /** Number of completed ticks. */
  tick: number;
  /** Match length in ticks; 0 = no limit (debug sandbox). */
  timeLimitTicks: number;
  players: PlayerState[];
  bullets: Bullet[];
  grenades: Grenade[];
  mines: Mine[];
  throwables: Throwable[];
  clouds: Cloud[];
  /** Explosions that happened during the most recent step(). */
  explosions: Explosion[];
  items: Item[];
  gunPads: GunPad[];
  nextEntityId: number;
  /** Ticks until the next random item spawn. */
  itemSpawnTimer: number;
  /** lastSeen[viewer][target]: the target as the viewer last saw it. */
  lastSeen: Sighting[][];
  /** Events produced by the most recent step(). */
  events: GameEvent[];
  over: boolean;
  result: MatchResult | null;
  rng: {
    spawns: Rng;
    items: Rng;
  };
}

export interface PlayerSetup {
  name: string;
}
