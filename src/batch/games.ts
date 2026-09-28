import type { GameConfig } from '../engine/config.ts';
import { createGame } from '../engine/game.ts';
import { ReplayRecorder, type Replay } from '../engine/replay.ts';
import { Rng } from '../engine/rng.ts';
import type { MapData, PlayerStats } from '../engine/types.ts';
import { MatchRunner } from '../match/runner.ts';
import { BotController, type BotStats, type LogEntry, type WorkerFactory } from '../match/supervisor.ts';

/**
 * Headless games between bots, without touching the file system: shared by the batch CLI
 * (bots from bots/) and the single-file test kit (bots from anywhere).
 */

export interface LoadedBot {
  file: string;
  source: string;
  hash: string;
}

export interface GamesOptions {
  bots: LoadedBot[];
  /** Maps to rotate through. */
  maps: MapData[];
  games: number;
  seed: string;
  /** Seconds; undefined = config default. */
  timeLimit?: number;
  /** Games run at the same time. */
  concurrency: number;
  config: GameConfig;
  createWorker: WorkerFactory;
  /** Record each game and hand the replay over (return where it was saved, if anywhere). */
  onReplay?: (game: Omit<GameResult, 'replayFile' | 'seats' | 'seconds' | 'reason' | 'endTick'>, replay: Replay) => string | undefined;
  /** Look at a game while it runs (e.g. to trace it). */
  observe?: (index: number, runner: MatchRunner) => void;
  /** Keep each seat's bot log in the results. */
  keepLogs?: boolean;
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
  /** The bot's log (only with keepLogs). */
  logs?: LogEntry[];
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

/** One game: seats shuffled by the game's seed, bots in fresh workers. */
async function playGame(index: number, opts: GamesOptions): Promise<GameResult> {
  const { bots, config } = opts;
  const seed = `${opts.seed}-${index}`;
  const map = opts.maps[index % opts.maps.length];
  // Shuffle seats per game so no bot always gets the same player id (ids break some ties).
  const seats = new Rng(`${seed}::seats`).shuffle([...bots]);
  const timeLimit = opts.timeLimit ?? config.match.defaultTimeLimit;
  const names = seats.map((b, i) => `${b.file.replace(/\.js$/, '')}#${i}`);
  const state = createGame({ map, config, seed, timeLimit, players: names.map((name) => ({ name })) });
  const controllers = seats.map((b, i) => new BotController({
    name: names[i], fileName: b.file, source: b.source, botSeed: `${seed}::bot${i}`, createWorker: opts.createWorker,
  }));
  const runner = new MatchRunner(state, controllers);
  const recorder = opts.onReplay
    ? new ReplayRecorder({ seed, timeLimit, map, config, players: seats.map((b, i) => ({ name: names[i], kind: 'bot' as const, source: b.file, sourceHash: b.hash })) })
    : null;
  runner.recorder = recorder;
  opts.observe?.(index, runner);
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
  if (recorder && opts.onReplay) {
    replayFile = opts.onReplay({ index, seed, map: map.id }, recorder.finish(state, controllers.map((c) => structuredClone(c.stats))));
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
      ...(opts.keepLogs ? { logs: structuredClone(controllers[playerId].logs) } : {}),
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

/** Run all games (up to `concurrency` at a time); results come back in game order. */
export async function runGames(opts: GamesOptions, onGame?: (game: GameResult, done: number) => void): Promise<GameResult[]> {
  if (opts.bots.length < 2) throw new Error('A game needs at least 2 bots (repeat a name to seat copies).');
  if (opts.bots.length > opts.config.match.maxPlayers) throw new Error(`At most ${opts.config.match.maxPlayers} bots per game.`);
  for (const map of opts.maps) {
    if (map.spawns.length < opts.bots.length) throw new Error(`Map "${map.id}" has fewer spawns than bots.`);
  }
  const games: GameResult[] = [];
  let next = 0;
  const worker = async () => {
    while (next < opts.games) {
      const index = next++;
      const game = await playGame(index, opts);
      games.push(game);
      onGame?.(game, games.length);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(opts.concurrency, opts.games)) }, worker));
  return games.sort((a, b) => a.index - b.index);
}
