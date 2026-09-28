import { DEFAULT_CONFIG, ITEM_TYPES, secondsToTicks, type GameConfig, type ItemType } from './config.ts';
import { deriveRng } from './rng.ts';
import { applyAttacks, updateBullets } from './systems/combat.ts';
import { dueMines, plantMines, resolveExplosions, updateGrenades } from './systems/explosives.ts';
import { handlePickups, refillGunPads, updateItemSpawner } from './systems/items.ts';
import { handleDeaths, handleRespawns, placeAtSpawn } from './systems/lives.ts';
import { applyMovement, applyTurning, applyWeaponSwitches } from './systems/movement.ts';
import { checkMatchEnd } from './systems/victory.ts';
import { initSightings, updateHiding, updateSightings } from './systems/visibility.ts';
import { applyZoneDamage } from './systems/zone.ts';
import { IDLE_ACTION, type ActionInput, type GameEvent, type GameState, type MapData, type PlayerSetup, type PlayerState } from './types.ts';

export interface GameOptions {
  map: MapData;
  players: PlayerSetup[];
  seed: string | number;
  config?: GameConfig;
  /** Match length in seconds; 0 = unlimited. Defaults to config.match.defaultTimeLimit. */
  timeLimit?: number;
}

function emptyStats(): PlayerState['stats'] {
  const itemsByType = {} as Record<ItemType, number>;
  for (const t of ITEM_TYPES) itemsByType[t] = 0;
  return {
    kills: 0, deaths: 0, damageDealt: 0, damageTaken: 0, shotsFired: 0, shotsHit: 0,
    knifeSwings: 0, knifeHits: 0, grenadesFired: 0, grenadeHits: 0, minesPlanted: 0, itemsPicked: 0, itemsByType,
  };
}

export function createGame(opts: GameOptions): GameState {
  const config = opts.config ?? DEFAULT_CONFIG;
  const seed = String(opts.seed);
  const { map } = opts;
  if (opts.players.length < 1) throw new Error('A match needs at least one player');
  if (map.spawns.length < opts.players.length) {
    throw new Error(`Map "${map.id}" has ${map.spawns.length} spawn points but ${opts.players.length} players`);
  }

  const state: GameState = {
    config,
    map,
    seed,
    tick: 0,
    timeLimitTicks: secondsToTicks(opts.timeLimit ?? config.match.defaultTimeLimit, config),
    players: [],
    bullets: [],
    grenades: [],
    mines: [],
    explosions: [],
    items: [],
    gunPads: map.gunSpawns.map((g) => ({ x: g.x, y: g.y, itemId: -1, refillTimer: 0 })),
    nextEntityId: 1,
    itemSpawnTimer: secondsToTicks(config.items.firstSpawnDelay, config),
    lastSeen: [],
    events: [],
    over: false,
    result: null,
    rng: {
      spawns: deriveRng(seed, 'spawns'),
      items: deriveRng(seed, 'items'),
    },
  };

  const spawnOrder = state.rng.spawns.shuffle(map.spawns.map((_, i) => i));
  opts.players.forEach((setup, id) => {
    const p: PlayerState = {
      id,
      name: setup.name,
      x: 0, y: 0, vx: 0, vy: 0, facing: 0,
      hp: 0,
      shield: 0,
      lives: config.player.startLives,
      alive: true,
      eliminated: false,
      eliminatedTick: -1,
      weapon: 'knife',
      hasGun: false,
      ammo: 0,
      hasLauncher: false,
      grenades: 0,
      mines: 0,
      knifeCooldown: 0,
      gunCooldown: 0,
      launcherCooldown: 0,
      mineCooldown: 0,
      switchTimer: 0,
      invulnerableTimer: 0,
      respawnTimer: 0,
      noiseTimer: 0,
      bushTicks: 0,
      outOfBushTicks: 0,
      lastDamagerId: -1,
      lastDamageWeapon: null,
      stats: emptyStats(),
    };
    placeAtSpawn(state, p, map.spawns[spawnOrder[id]]);
    state.players.push(p);
  });

  refillGunPads(state);
  initSightings(state);
  state.events = [];
  return state;
}

/** Count down every per-player and per-pad timer by one tick. */
function tickTimers(state: GameState): void {
  const dec = (v: number) => (v > 0 ? v - 1 : 0);
  for (const p of state.players) {
    if (p.alive) {
      p.knifeCooldown = dec(p.knifeCooldown);
      p.gunCooldown = dec(p.gunCooldown);
      p.launcherCooldown = dec(p.launcherCooldown);
      p.mineCooldown = dec(p.mineCooldown);
      p.switchTimer = dec(p.switchTimer);
      p.invulnerableTimer = dec(p.invulnerableTimer);
      p.noiseTimer = dec(p.noiseTimer);
    } else if (!p.eliminated) {
      p.respawnTimer = dec(p.respawnTimer);
    }
  }
  for (const pad of state.gunPads) {
    if (pad.itemId < 0) pad.refillTimer = dec(pad.refillTimer);
  }
  for (const mine of state.mines) mine.fuseTimer = dec(mine.fuseTimer);
  state.itemSpawnTimer = dec(state.itemSpawnTimer);
}

/**
 * Advance the game by exactly one tick. `actions[i]` is player i's sanitized
 * input (missing entries count as idle). Mutates `state` and returns the events
 * produced during this tick (also stored in state.events).
 *
 * Order: weapon switches → turning → movement & collisions → attacks & mine
 * planting → bullets → grenades → due mines → explosions (with chain reactions) →
 * zone damage → deaths → pickups → respawns, gun pads & item spawns → timers & bush
 * hiding time → match end.
 */
export function step(state: GameState, actions: readonly (ActionInput | undefined)[]): GameEvent[] {
  if (state.over) return [];
  state.events = [];
  state.explosions = [];
  const acts = state.players.map((p) => actions[p.id] ?? IDLE_ACTION);

  applyWeaponSwitches(state, acts);
  applyTurning(state, acts);
  applyMovement(state, acts);
  applyAttacks(state, acts);
  plantMines(state, acts);
  updateBullets(state);
  const blasts = updateGrenades(state);
  blasts.push(...dueMines(state));
  resolveExplosions(state, blasts);
  applyZoneDamage(state);
  handleDeaths(state);
  handlePickups(state);
  handleRespawns(state);
  refillGunPads(state);
  updateItemSpawner(state);
  tickTimers(state);
  updateHiding(state);

  state.tick++;
  updateSightings(state);
  checkMatchEnd(state);
  return state.events;
}
