import type { GameConfig, ItemType } from './config.ts';
import type { Rect } from './geometry.ts';
import type { Rng } from './rng.ts';

export type Weapon = 'knife' | 'gun' | 'launcher';

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
}

export const IDLE_ACTION: Readonly<ActionInput> = Object.freeze({
  moveX: 0,
  moveY: 0,
  aim: null,
  attack: false,
  weapon: null,
  plantMine: false,
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
  mines: number;
  /** Remaining ticks for each timer; 0 = ready / inactive. */
  knifeCooldown: number;
  gunCooldown: number;
  launcherCooldown: number;
  mineCooldown: number;
  switchTimer: number;
  invulnerableTimer: number;
  respawnTimer: number;
  /** Id of the last player who damaged this one during the current life, or -1. */
  lastDamagerId: number;
  lastDamageWeapon: Weapon | null;
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

export interface Item {
  id: number;
  type: ItemType;
  x: number;
  y: number;
  /** Ammo carried by a gun item. */
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
  | { type: 'hit'; tick: number; attackerId: number; targetId: number; weapon: Weapon; damage: number; shieldDamage: number; hpDamage: number }
  | { type: 'bulletEnd'; tick: number; bulletId: number; x: number; y: number; reason: 'wall' | 'player' | 'range' }
  | { type: 'death'; tick: number; playerId: number; killerId: number; weapon: Weapon | null; livesLeft: number }
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
  items: Item[];
  gunPads: GunPad[];
  nextEntityId: number;
  /** Ticks until the next random item spawn. */
  itemSpawnTimer: number;
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
