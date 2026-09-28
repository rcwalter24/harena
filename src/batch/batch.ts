import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { DEFAULT_CONFIG, mergeConfig, type DeepPartial, type GameConfig } from '../engine/config.ts';
import { validateMap } from '../engine/maps.ts';
import type { MapData } from '../engine/types.ts';
import { sourceHash, staticCheck } from '../review/staticCheck.ts';
import { createNodeWorker } from '../sandbox/node/host.ts';
import { runGames, summarize, type BotSummary, type GameResult, type LoadedBot } from './games.ts';

export type { BotSummary, GameResult, LoadedBot, SeatResult } from './games.ts';

/** Headless batch matches in Node between bots in bots/: bots run in worker_threads, games in parallel. */

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

/** Run a batch between bots in bots/ and return per-game results and per-bot totals. */
export async function runBatch(opts: BatchOptions, onGame?: (game: GameResult, done: number) => void): Promise<BatchSummary> {
  const maps = loadMaps(opts.mapsDir);
  for (const id of opts.maps) if (!maps.has(id)) throw new Error(`Unknown map "${id}". Available: ${[...maps.keys()].join(', ')}`);
  const config = mergeConfig(DEFAULT_CONFIG, opts.config);
  const bots = opts.bots.map((b) => loadBot(b, opts.botsDir));
  const replayDir = opts.replayDir;
  if (replayDir) mkdirSync(replayDir, { recursive: true });

  const started = performance.now();
  const games = await runGames({
    bots,
    maps: opts.maps.map((id) => maps.get(id)!),
    games: opts.games,
    seed: opts.seed,
    timeLimit: opts.timeLimit,
    concurrency: opts.concurrency,
    config,
    createWorker: createNodeWorker,
    onReplay: replayDir
      ? ({ index, map, seed }, replay) => {
        const file = join(replayDir, `game-${String(index).padStart(4, '0')}-${map}-${seed}.json`);
        writeFileSync(file, JSON.stringify(replay));
        return file;
      }
      : undefined,
  }, onGame);
  const { config: _config, ...rest } = opts;
  return { options: rest, games, bots: summarize(games), wallSeconds: (performance.now() - started) / 1000 };
}
