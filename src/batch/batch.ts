import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { DEFAULT_CONFIG, mergeConfig, type DeepPartial, type GameConfig } from '../engine/config.ts';
import { createGame } from '../engine/game.ts';
import { validateMap } from '../engine/maps.ts';
import { ReplayRecorder } from '../engine/replay.ts';
import { Rng } from '../engine/rng.ts';
import type { MapData, PlayerStats } from '../engine/types.ts';
import { MatchRunner } from '../match/runner.ts';
import { BotController, type BotStats } from '../match/supervisor.ts';
import { sourceHash, staticCheck } from '../review/staticCheck.ts';
import { createNodeWorker } from '../sandbox/node/host.ts';

/** Headless batch matches in Node: bots run in worker_threads, games run in parallel. */

export const ROOT = resolve(import.meta.dirname, '../..');

export interface BatchOptions {
  /** Bot file names in bots/ (repeat a name to seat several copies). */
  bots: string[];
  /** Map ids to rotate through. */
  maps: string[];
  games: number;
  seed: string;
  /** Seconds; undefined = config default. */
  timeLimit?: number;
  /** Games run at the same time. */
  concurrency: number;
  /** Directory to write one replay per game into (optional). */
  replayDir?: string;
  config?: DeepPartial<GameConfig>;
  botsDir?: string;
  mapsDir?: string;
}

export interface SeatResult {
  bot: string;
  rank: number;
  /** Sole winner (rank 1 and nobody else at rank 1). */
  won: boolean;
  /** Shared first place. */
  drew: boolean;
  stats: PlayerStats;
  botStats: BotStats;
  status: string;
}

export interface GameResult {
  index: number;
  seed: string;
  map: string;
  reason: string;
  endTick: number;
  seconds: number;
  seats: SeatResult[];
  replayFile?: string;
}

export interface BotSummary {
  bot: string;
  seats: number;
  wins: number;
  draws: number;
  winRate: number;
  avgRank: number;
  kills: number;
  deaths: number;
  damageDealt: number;
  damageTaken: number;
  shotsFired: number;
  shotsHit: number;
  accuracy: number | null;
  knifeHits: number;
  grenadesFired: number;
  grenadeHits: number;
  minesPlanted: number;
  itemsPicked: number;
  timeouts: number;
  errors: number;
  invalid: number;
  restarts: number;
  disabled: number;
  avgDecideMs: number;
  maxDecideMs: number;
}

export interface BatchSummary {
  options: Omit<BatchOptions, 'config'>;
  games: GameResult[];
  bots: BotSummary[];
  wallSeconds: number;
}

export function loadMaps(dir = join(ROOT, 'maps')): Map<string, MapData> {
  const maps = new Map<string, MapData>();
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
    const map = validateMap(JSON.parse(readFileSync(join(dir, f), 'utf8')));
    maps.set(map.id, map);
  }
  return maps;
}

export interface LoadedBot {
  file: string;
  source: string;
  hash: string;
}

/** Read a bot from bots/, accepting "gunner" or "gunner.js". Throws on missing or blocked bots. */
export function loadBot(name: string, dir = join(ROOT, 'bots')): LoadedBot {
  const file = basename(name.endsWith('.js') ? name : `${name}.js`);
  let source: string;
  try {
    source = readFileSync(join(dir, file), 'utf8');
  } catch {
    throw new Error(`Bot not found: bots/${file}`);
  }
  const check = staticCheck(source);
  if (!check.ok) {
    const errors = check.findings.filter((f) => f.severity === 'error').map((f) => `  - ${f.message}${f.line ? ` (line ${f.line})` : ''}`);
    throw new Error(`Bot ${file} fails the static check:\n${errors.join('\n')}`);
  }
  return { file, source, hash: sourceHash(source) };
}

async function playGame(index: number, opts: BatchOptions, maps: Map<string, MapData>, bots: LoadedBot[], config: GameConfig): Promise<GameResult> {
  const seed = `${opts.seed}-${index}`;
  const map = maps.get(opts.maps[index % opts.maps.length])!;
  // Shuffle seats per game so no bot always gets the same player id (ids break some ties).
  const seats = new Rng(`${seed}::seats`).shuffle([...bots]);
  const timeLimit = opts.timeLimit ?? config.match.defaultTimeLimit;
  const names = seats.map((b, i) => `${b.file.replace(/\.js$/, '')}#${i}`);
  const state = createGame({ map, config, seed, timeLimit, players: names.map((name) => ({ name })) });
  const controllers = seats.map((b, i) => new BotController({
    name: names[i], fileName: b.file, source: b.source, botSeed: `${seed}::bot${i}`, createWorker: createNodeWorker,
  }));
  const runner = new MatchRunner(state, controllers);
  const recorder = opts.replayDir
    ? new ReplayRecorder({ seed, timeLimit, map, config, players: seats.map((b, i) => ({ name: names[i], kind: 'bot' as const, source: b.file, sourceHash: b.hash })) })
    : null;
  runner.recorder = recorder;
  const started = performance.now();
  try {
    await runner.init();
    while (!state.over) await runner.tick();
  } finally {
    runner.dispose();
  }

  const result = state.result!;
  const firsts = result.ranking.filter((r) => r.rank === 1).length;
  let replayFile: string | undefined;
  if (recorder && opts.replayDir) {
    replayFile = join(opts.replayDir, `game-${String(index).padStart(4, '0')}-${map.id}-${seed}.json`);
    writeFileSync(replayFile, JSON.stringify(recorder.finish(state, controllers.map((c) => structuredClone(c.stats)))));
  }
  return {
    index,
    seed,
    map: map.id,
    reason: result.reason,
    endTick: result.endTick,
    seconds: (performance.now() - started) / 1000,
    replayFile,
    seats: result.ranking.map(({ playerId, rank }) => ({
      bot: seats[playerId].file,
      rank,
      won: rank === 1 && firsts === 1,
      drew: rank === 1 && firsts > 1,
      stats: structuredClone(state.players[playerId].stats),
      botStats: structuredClone(controllers[playerId].stats),
      status: controllers[playerId].status,
    })),
  };
}

export function summarize(games: GameResult[]): BotSummary[] {
  const byBot = new Map<string, SeatResult[]>();
  for (const g of games) for (const s of g.seats) byBot.set(s.bot, [...(byBot.get(s.bot) ?? []), s]);
  const sum = (list: SeatResult[], f: (s: SeatResult) => number) => list.reduce((acc, s) => acc + f(s), 0);
  return [...byBot].map(([bot, seats]) => {
    const decisions = sum(seats, (s) => s.botStats.decisions);
    const shotsFired = sum(seats, (s) => s.stats.shotsFired);
    const shotsHit = sum(seats, (s) => s.stats.shotsHit);
    const wins = seats.filter((s) => s.won).length;
    return {
      bot,
      seats: seats.length,
      wins,
      draws: seats.filter((s) => s.drew).length,
      winRate: wins / seats.length,
      avgRank: sum(seats, (s) => s.rank) / seats.length,
      kills: sum(seats, (s) => s.stats.kills),
      deaths: sum(seats, (s) => s.stats.deaths),
      damageDealt: sum(seats, (s) => s.stats.damageDealt),
      damageTaken: sum(seats, (s) => s.stats.damageTaken),
      shotsFired,
      shotsHit,
      accuracy: shotsFired > 0 ? shotsHit / shotsFired : null,
      knifeHits: sum(seats, (s) => s.stats.knifeHits),
      grenadesFired: sum(seats, (s) => s.stats.grenadesFired),
      grenadeHits: sum(seats, (s) => s.stats.grenadeHits),
      minesPlanted: sum(seats, (s) => s.stats.minesPlanted),
      itemsPicked: sum(seats, (s) => s.stats.itemsPicked),
      timeouts: sum(seats, (s) => s.botStats.timeouts),
      errors: sum(seats, (s) => s.botStats.errors),
      invalid: sum(seats, (s) => s.botStats.invalid),
      restarts: sum(seats, (s) => s.botStats.restarts),
      disabled: seats.filter((s) => s.status === 'disabled').length,
      avgDecideMs: decisions > 0 ? sum(seats, (s) => s.botStats.totalDecideMs) / decisions : 0,
      maxDecideMs: Math.max(0, ...seats.map((s) => s.botStats.maxDecideMs)),
    };
  }).sort((a, b) => b.winRate - a.winRate || a.avgRank - b.avgRank || a.bot.localeCompare(b.bot));
}

/** Run all games (up to `concurrency` at a time) and return per-game results and per-bot totals. */
export async function runBatch(opts: BatchOptions, onGame?: (game: GameResult, done: number) => void): Promise<BatchSummary> {
  const maps = loadMaps(opts.mapsDir);
  for (const id of opts.maps) if (!maps.has(id)) throw new Error(`Unknown map "${id}". Available: ${[...maps.keys()].join(', ')}`);
  if (opts.bots.length < 2) throw new Error('A batch needs at least 2 bots (repeat a name to seat copies).');
  const config = mergeConfig(DEFAULT_CONFIG, opts.config);
  if (opts.bots.length > config.match.maxPlayers) throw new Error(`At most ${config.match.maxPlayers} bots per game.`);
  for (const id of opts.maps) {
    if (maps.get(id)!.spawns.length < opts.bots.length) throw new Error(`Map "${id}" has fewer spawns than bots.`);
  }
  const bots = opts.bots.map((b) => loadBot(b, opts.botsDir));
  if (opts.replayDir) mkdirSync(opts.replayDir, { recursive: true });

  const started = performance.now();
  const games: GameResult[] = [];
  let next = 0;
  const worker = async () => {
    while (next < opts.games) {
      const index = next++;
      const game = await playGame(index, opts, maps, bots, config);
      games.push(game);
      onGame?.(game, games.length);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(opts.concurrency, opts.games)) }, worker));
  games.sort((a, b) => a.index - b.index);
  const { config: _config, ...rest } = opts;
  return { options: rest, games, bots: summarize(games), wallSeconds: (performance.now() - started) / 1000 };
}
