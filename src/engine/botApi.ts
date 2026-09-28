// Harena bot API — the exact shapes a bot receives and returns.
//
// Conventions used everywhere below:
//   * Distances are world units (u). Origin (0, 0) is the TOP-LEFT corner of the map;
//     +x points right, +y points DOWN.
//   * Angles are radians, 0 = pointing right (+x), increasing CLOCKWISE on screen
//     (PI/2 = pointing down). This is exactly Math.atan2(dy, dx) for a vector (dx, dy).
//     Angles in the state are normalized to (-PI, PI]; you may return any finite angle.
//   * Speeds are u/s, times and timers are seconds.
//   * `players` is indexed by player id: state.players[id].id === id.

export type WeaponName = 'knife' | 'gun' | 'launcher' | 'laser';

export type ItemType = 'ammo' | 'shield' | 'health' | 'gun' | 'life' | 'launcher' | 'mines' | 'laser';

export interface Vec2 {
  x: number;
  y: number;
}

/** Axis-aligned wall rectangle: top-left corner (x, y), width w, height h. */
export interface Wall {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Passed once to init(). */
export interface InitInfo {
  /** Your player id. */
  selfId: number;
  /** Everyone in the match, in id order (including you). */
  players: { id: number; name: string }[];
  map: {
    id: string;
    name: string;
    width: number;
    height: number;
    /** Solid for players, bullets, grenades and explosions. The map edge is solid too. */
    walls: Wall[];
    /** Possible (re)spawn points. */
    spawns: Vec2[];
    /** Gun pads: a gun appears here at the start and refills some time after being taken. */
    gunSpawns: Vec2[];
    /** Bushes: enemies inside can be hidden from you (see the rules). They block nothing. */
    bushes: Wall[];
  };
  /** Every rule constant (same values as the tables in this document), e.g. rules.knife.damage. */
  rules: Record<string, any>;
  /** Match length in seconds, or 0 for no limit. */
  timeLimit: number;
}

export interface PlayerView {
  id: number;
  name: string;
  /**
   * false if this enemy is hidden from you in a bush. x, y, vx, vy and facing then
   * show what you saw last time it was visible (they are not updated while hidden).
   * You and your own data are always visible.
   */
  visible: boolean;
  /** Seconds since you last saw this player (0 while visible). */
  seenAgo: number;
  x: number;
  y: number;
  /** Actual velocity during the last tick, u/s. */
  vx: number;
  vy: number;
  /** Current facing in radians. Attacks go this way. It turns toward your `aim` at a capped rate. */
  facing: number;
  hp: number;
  shield: number;
  /** Lives left, including the current one. */
  lives: number;
  /** false while waiting to respawn or after elimination. */
  alive: boolean;
  /** true once all lives are gone (out of the match for good). */
  eliminated: boolean;
  /** Seconds until respawn while dead (0 when alive or eliminated). */
  respawnIn: number;
  /**
   * Seconds this player can still hide in bushes before being exposed (0 = exposed while in
   * a bush). Counts down while its centre is in any bush; refills after a break outside.
   * null if the match has no hiding limit.
   */
  hideLeft: number | null;
  /** Seconds of invulnerability left (0 = can be damaged). */
  invulnerable: number;
  /** Weapon in hand. */
  weapon: WeaponName;
  /** Weapons owned besides the knife (the knife is always owned). */
  hasGun: boolean;
  hasLauncher: boolean;
  hasLaser: boolean;
  /** Ammunition: gun bullets, launcher grenades and laser shots. */
  ammo: { gun: number; launcher: number; laser: number };
  /** Seconds until this player's charging laser fires (0 = not charging). See `lasers` in the state. */
  laserCharge: number;
  /** Mines carried. */
  mines: number;
  /** Seconds until each action is available again (0 = ready now). */
  cooldowns: {
    knife: number;
    gun: number;
    launcher: number;
    /** Until you can start charging the laser again (it starts after a shot fires). */
    laser: number;
    mine: number;
    /** Weapon switching: no attacks until this reaches 0. */
    switch: number;
  };
}

export interface BulletView {
  id: number;
  ownerId: number;
  x: number;
  y: number;
  /** Constant velocity, u/s. */
  vx: number;
  vy: number;
  radius: number;
}

export interface GrenadeView {
  id: number;
  ownerId: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  /** Distance left before it explodes on its own. */
  remainingRange: number;
}

export interface MineView {
  id: number;
  ownerId: number;
  x: number;
  y: number;
  /** Seconds until it explodes. */
  fuse: number;
}

/**
 * A laser being charged: it fires along `path` when `charge` runs out. The direction is locked,
 * but the shooter can still move, so the whole line moves with them until it fires.
 */
export interface LaserView {
  ownerId: number;
  /** Seconds until it fires. */
  charge: number;
  /** Locked direction, radians. */
  angle: number;
  /**
   * Where the beam would go if it fired now from the shooter's current centre: the start, each
   * bounce point, then the end. It stops at the first player it touches (not shown here).
   */
  path: Vec2[];
}

/** An explosion that happened during the last tick. */
export interface ExplosionView {
  ownerId: number;
  source: 'grenade' | 'mine';
  x: number;
  y: number;
  radius: number;
}

/**
 * The safe zone: a circle around the map centre that shrinks during the match.
 * At every whole second, a player whose centre is outside it takes damage.
 */
export interface ZoneView {
  /** Centre (the map centre; it never moves). */
  x: number;
  y: number;
  /** Current radius. You are outside if the distance from (x, y) to your centre is greater. */
  radius: number;
  /** Radius at the end of the first shrink; the zone holds there, then collapses to 0. */
  finalRadius: number;
  /** Seconds until shrinking starts (0 once it has started). */
  shrinkStartsIn: number;
  /** Seconds until finalRadius is reached (0 once reached). The radius shrinks linearly. */
  shrinkEndsIn: number;
  /** Seconds until the collapse from finalRadius toward 0 starts (0 once started; null if it never collapses). */
  collapseStartsIn: number | null;
  /** Seconds until the radius reaches 0 (0 once reached; null if it never collapses). Linear. */
  collapseEndsIn: number | null;
  /** Damage per second outside the zone. 0 means the zone is off in this match. */
  damagePerSecond: number;
}

export interface ItemView {
  id: number;
  type: ItemType;
  x: number;
  y: number;
}

/** Things that happened during the last tick. */
export type EventView =
  | { type: 'shot'; playerId: number }
  | { type: 'swing'; playerId: number; hitIds: number[] }
  | { type: 'hit'; attackerId: number; targetId: number; weapon: WeaponName | 'explosion' | 'zone'; damage: number }
  /** A laser fired: its path (start, bounce points, end) and the player it hit, or null. */
  | { type: 'laser'; playerId: number; path: Vec2[]; hitId: number | null }
  | { type: 'death'; playerId: number; killerId: number; livesLeft: number }
  | { type: 'eliminated'; playerId: number }
  | { type: 'respawn'; playerId: number; x: number; y: number }
  | { type: 'pickup'; playerId: number; itemType: ItemType };

/** Passed to decide() every tick. A fresh copy each time: changing it has no effect. */
export interface BotState {
  /** Index of the tick being decided (0, 1, 2, ...). */
  tick: number;
  /** Seconds elapsed since the start. */
  time: number;
  /** Seconds left before the time limit, or null if there is no limit. */
  timeLeft: number | null;
  /** You (same object as players[selfId]). */
  self: PlayerView;
  /** Everyone, indexed by id, including you and dead / eliminated players. */
  players: PlayerView[];
  bullets: BulletView[];
  grenades: GrenadeView[];
  mines: MineView[];
  /** Lasers being charged (their warning lines). */
  lasers: LaserView[];
  explosions: ExplosionView[];
  items: ItemView[];
  events: EventView[];
  zone: ZoneView;
}

/**
 * Returned from decide(). Every field is optional; returning {} or null means
 * "stand still, keep facing, don't attack".
 */
export interface Action {
  /** Movement direction. Length is clamped to 1: {x:1,y:0} = full speed right, {x:0.5,y:0} = half speed. */
  move?: Vec2;
  /** Angle to turn toward, radians. Facing rotates toward it at most rules.player.turnRateDegrees per second. */
  aim?: number;
  /** Attack with the weapon in hand (ignored while on cooldown, switching, or out of ammo). */
  attack?: boolean;
  /** Switch to this weapon (ignored if you don't own it or already hold it). */
  weapon?: WeaponName;
  /** Plant a mine at your position (needs a carried mine and a ready mine cooldown). */
  plantMine?: boolean;
}
