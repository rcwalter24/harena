import { DEFAULT_CONFIG, type GameConfig } from './config.ts';
import { applyCheat, type CheatKind } from './debug.ts';
import { createGame, step } from './game.ts';
import { hashState } from './hash.ts';
import { validateMap } from './maps.ts';
import type { ActionInput, GameEvent, GameState, MapData, MatchResult, Weapon } from './types.ts';

/**
 * Replays store the seed, the full map and config, and every action the engine
 * applied. Re-simulating them reproduces the match exactly, without the bots.
 */

export const REPLAY_FORMAT = 'harena-replay';
export const REPLAY_VERSION = 1;
export const CHECKSUM_INTERVAL = 30;

export interface ReplayPlayerInfo {
  name: string;
  kind: 'bot' | 'human' | 'dummy';
  /** Bot file name, or dummy kind. */
  source?: string;
  /** Hash of the bot source used (bots only). */
  sourceHash?: string;
}

/**
 * A run of identical actions: [count, moveX, moveY, aim | null, flags, weapon, throwDistance?].
 * flags: 1 = attack, 2 = plantMine, 4 = throw smoke, 8 = throw gas. weapon: 0 none, 1 knife,
 * 2 gun, 3 launcher, 4 laser. throwDistance is only present for a throw with a chosen distance.
 */
export type ActionRun = [number, number, number, number | null, number, number] | [number, number, number, number | null, number, number, number];

export interface ReplayCheat {
  /** Applied just before this tick is simulated. */
  tick: number;
  playerId: number;
  kind: CheatKind;
}

export interface Replay {
  format: typeof REPLAY_FORMAT;
  version: number;
  createdAt: string;
  seed: string;
  timeLimit: number;
  map: MapData;
  config: GameConfig;
  players: ReplayPlayerInfo[];
  ticks: number;
  /** actions[playerId] = run-length encoded actions for ticks 0..ticks-1. */
  actions: ActionRun[][];
  cheats: ReplayCheat[];
  /** [tick, hashState] after every CHECKSUM_INTERVAL ticks and at the end. */
  checksums: [number, string][];
  result: MatchResult | null;
  /** Free-form per-player extras from the host (e.g. bot timeout/error stats). */
  extras?: unknown[];
}

const WEAPON_CODES: Array<Weapon | null> = [null, 'knife', 'gun', 'launcher', 'laser'];

/** An action without its run count. */
type EncodedAction = [number, number, number | null, number, number] | [number, number, number | null, number, number, number];

function encode(a: ActionInput): EncodedAction {
  const flags = (a.attack ? 1 : 0) | (a.plantMine ? 2 : 0) | (a.throwKind === 'smoke' ? 4 : 0) | (a.throwKind === 'gas' ? 8 : 0);
  const base: [number, number, number | null, number, number] = [a.moveX, a.moveY, a.aim, flags, WEAPON_CODES.indexOf(a.weapon)];
  return a.throwKind && a.throwDistance !== null ? [...base, a.throwDistance] : base;
}

function decode(run: ActionRun): ActionInput {
  return {
    moveX: run[1],
    moveY: run[2],
    aim: run[3],
    attack: (run[4] & 1) !== 0,
    plantMine: (run[4] & 2) !== 0,
    weapon: WEAPON_CODES[run[5]] ?? null,
    throwKind: (run[4] & 4) !== 0 ? 'smoke' : (run[4] & 8) !== 0 ? 'gas' : null,
    throwDistance: run[6] ?? null,
  };
}

function sameRun(run: ActionRun, enc: EncodedAction): boolean {
  return run[1] === enc[0] && run[2] === enc[1] && run[3] === enc[2] && run[4] === enc[3] && run[5] === enc[4] && (run[6] ?? null) === (enc[5] ?? null);
}

export interface ReplaySetup {
  seed: string;
  timeLimit: number;
  map: MapData;
  config: GameConfig;
  players: ReplayPlayerInfo[];
}

/** Collects actions, cheats and checksums while a match runs. */
export class ReplayRecorder {
  private readonly setup: ReplaySetup;
  private readonly actions: ActionRun[][];
  private readonly cheats: ReplayCheat[] = [];
  private readonly checksums: [number, string][] = [];
  private ticks = 0;

  constructor(setup: ReplaySetup) {
    this.setup = setup;
    this.actions = setup.players.map(() => []);
  }

  recordTick(tick: number, actions: readonly ActionInput[]): void {
    if (tick !== this.ticks) throw new Error(`Replay recorder expected tick ${this.ticks}, got ${tick}`);
    actions.forEach((a, id) => {
      const runs = this.actions[id];
      const enc = encode(a);
      const last = runs[runs.length - 1];
      if (last && sameRun(last, enc)) last[0]++;
      else runs.push([1, ...enc] as ActionRun);
    });
  }

  afterTick(state: GameState): void {
    this.ticks = state.tick;
    if (state.tick % CHECKSUM_INTERVAL === 0 || state.over) this.checksums.push([state.tick, hashState(state)]);
  }

  recordCheat(tick: number, playerId: number, kind: CheatKind): void {
    this.cheats.push({ tick, playerId, kind });
  }

  finish(state: GameState, extras?: unknown[]): Replay {
    const checksums = [...this.checksums];
    if (checksums.at(-1)?.[0] !== state.tick) checksums.push([state.tick, hashState(state)]);
    return {
      format: REPLAY_FORMAT,
      version: REPLAY_VERSION,
      createdAt: new Date().toISOString(),
      seed: this.setup.seed,
      timeLimit: this.setup.timeLimit,
      map: this.setup.map,
      config: this.setup.config,
      players: this.setup.players,
      ticks: state.tick,
      actions: this.actions.map((runs) => runs.map((r) => [...r] as ActionRun)),
      cheats: [...this.cheats],
      checksums,
      result: state.result,
      extras,
    };
  }
}

/** Check a parsed replay file's shape (throws with a readable message). */
export function validateReplay(raw: unknown): Replay {
  const r = raw as Partial<Replay>;
  const fail = (msg: string): never => {
    throw new Error(`Not a valid replay: ${msg}`);
  };
  if (!r || typeof r !== 'object') fail('not an object');
  if (r.format !== REPLAY_FORMAT) fail('unknown format');
  if (r.version !== REPLAY_VERSION) fail(`unsupported version ${String(r.version)}`);
  if (typeof r.seed !== 'string' || typeof r.timeLimit !== 'number' || typeof r.ticks !== 'number') fail('missing seed / timeLimit / ticks');
  if (!r.config || typeof r.config !== 'object') fail('missing config');
  if (!Array.isArray(r.players) || r.players.length === 0) fail('missing players');
  if (!Array.isArray(r.actions) || r.actions.length !== r.players!.length) fail('actions do not match players');
  for (const runs of r.actions!) {
    const total = runs.reduce((sum, run) => sum + run[0], 0);
    if (total !== r.ticks) fail('action runs do not cover every tick');
  }
  validateMap(r.map, r.config!.player?.radius);
  // Replays recorded before the safe zone existed have no zone settings: replay them with it off.
  // Likewise, replays from before inertia and the bush hiding limit replay without them.
  let config = r.config!.zone ? r.config! : { ...r.config!, zone: { ...DEFAULT_CONFIG.zone, damagePerSecond: 0 } };
  if (config.player.accelTime === undefined) config = { ...config, player: { ...config.player, accelTime: 0 } };
  if (config.bushes.hideLimit === undefined) config = { ...config, bushes: { ...config.bushes, hideLimit: 0, rehideTime: 0 } };
  // Before explosions went around corners, any wall on the straight line shielded completely.
  if (config.explosions.aroundCorners === undefined) config = { ...config, explosions: { ...config.explosions, aroundCorners: 0 } };
  // Before clouds spread over time and around corners, they were full-size circles at once.
  if (config.throwing !== undefined && config.throwing.spreadTime === undefined) {
    config = { ...config, throwing: { ...config.throwing, spreadTime: 0, cloudsAroundCorners: 0 } };
  }
  // Before smoke and gas grenades: none spawn and none can be carried.
  if (config.throwing === undefined) {
    config = {
      ...config,
      throwing: DEFAULT_CONFIG.throwing,
      smoke: { ...DEFAULT_CONFIG.smoke, maxCarry: 0 },
      gas: { ...DEFAULT_CONFIG.gas, maxCarry: 0 },
      items: { ...config.items, weights: { ...config.items.weights, smoke: 0, gas: 0 } },
    };
  }
  // Before the laser: none spawn (weight 0, the last type in the item roll) and none can be held.
  if (config.laser === undefined) {
    config = {
      ...config,
      player: { ...config.player, speedLaser: DEFAULT_CONFIG.player.speedLaser },
      laser: { ...DEFAULT_CONFIG.laser, pickupAmmo: 0, maxAmmo: 0 },
      items: { ...config.items, weights: { ...config.items.weights, laser: 0 } },
    };
  }
  return { ...r, config, cheats: r.cheats ?? [], checksums: r.checksums ?? [] } as Replay;
}

/**
 * Re-simulates a replay. `stepOnce()` advances one tick; `seek()` rebuilds the
 * state and fast-forwards (the engine is fast enough to re-run from tick 0).
 */
export class ReplayPlayer {
  readonly replay: Replay;
  state: GameState;
  /** Ticks at which the re-simulated state did not match the recorded checksum. */
  desyncs: number[] = [];
  private readonly perTick: ActionInput[][];
  private readonly checksums: Map<number, string>;

  constructor(replay: Replay) {
    this.replay = replay;
    this.checksums = new Map(replay.checksums);
    this.perTick = replay.actions.map((runs) => {
      const list: ActionInput[] = [];
      for (const run of runs) {
        const action = decode(run);
        for (let i = 0; i < run[0]; i++) list.push(action);
      }
      return list;
    });
    this.state = this.freshState();
  }

  private freshState(): GameState {
    const { replay } = this;
    return createGame({
      map: replay.map,
      config: replay.config,
      seed: replay.seed,
      timeLimit: replay.timeLimit,
      players: replay.players.map((p) => ({ name: p.name })),
    });
  }

  get done(): boolean {
    return this.state.over || this.state.tick >= this.replay.ticks;
  }

  actionsAt(tick: number): ActionInput[] {
    return this.perTick.map((list) => list[tick]);
  }

  /** Apply recorded cheats for the upcoming tick (call before stepping). */
  applyCheats(state: GameState = this.state): void {
    for (const c of this.replay.cheats) if (c.tick === state.tick) applyCheat(state, c.playerId, c.kind);
  }

  /** Verify the checksum for the state's current tick, if one was recorded. */
  verify(state: GameState = this.state): void {
    const expected = this.checksums.get(state.tick);
    if (expected !== undefined && expected !== hashState(state) && !this.desyncs.includes(state.tick)) this.desyncs.push(state.tick);
  }

  stepOnce(): GameEvent[] {
    if (this.done) return [];
    this.applyCheats();
    const events = step(this.state, this.actionsAt(this.state.tick));
    this.verify();
    return events;
  }

  /** Rebuild and fast-forward to `tick` (no events are returned for the skipped ticks). */
  seek(tick: number): void {
    const target = Math.max(0, Math.min(tick, this.replay.ticks));
    if (target < this.state.tick) this.state = this.freshState();
    while (this.state.tick < target && !this.done) this.stepOnce();
  }

  /** Run to the end and report whether it matched every checksum. */
  verifyAll(): { ok: boolean; desyncs: number[]; finalHash: string } {
    this.seek(this.replay.ticks);
    return { ok: this.desyncs.length === 0, desyncs: [...this.desyncs], finalHash: hashState(this.state) };
  }
}
