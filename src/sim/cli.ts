// Harena test kit: the real engine, rules and bot sandbox in one Node file, so an AI (or anyone)
// can try a bot before handing it over. Built into dist/harena-sim.mjs by `npm run build`.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import { runGames, summarize, type GameResult, type LoadedBot } from '../batch/games.ts';
import { formatReport } from '../batch/report.ts';
import { DEFAULT_CONFIG, mergeConfig } from '../engine/config.ts';
import { validateMap } from '../engine/maps.ts';
import type { GameEvent, GameState, MapData } from '../engine/types.ts';
import { sourceHash, staticCheck } from '../review/staticCheck.ts';
import { createNodeWorker } from '../sandbox/node/host.ts';
import { runBotWorker } from '../sandbox/node/workerMain.ts';

/** Build stamp, set by the bundler (vite.sim.config.ts). */
declare const __HARENA_BUILD__: string;

const WORKER_ROLE = 'harena-bot-worker';

// Only the three example bots ship in the kit. The kit goes to AIs that are writing bots, and
// the other bots in bots/ are their competition: their code must not be handed over with it.
const BUILTIN_BOTS: Record<string, string> = Object.fromEntries(
  Object.entries(import.meta.glob(['/bots/random.js', '/bots/chaser.js', '/bots/gunner.js'], { query: '?raw', import: 'default', eager: true }) as Record<string, string>)
    .map(([path, source]) => [basename(path, '.js'), source]),
);

const MAPS: MapData[] = Object.values(import.meta.glob('/maps/*.json', { import: 'default', eager: true }))
  .map((raw) => validateMap(raw))
  .sort((a, b) => a.id.localeCompare(b.id));

const HELP = `Harena test kit: play your bot against others with the exact engine, rules and sandbox
of real Harena matches, and see how it does. Needs Node.js 18 or newer.

Usage: node harena-sim.mjs <bot.js> [more bots…] [options]

  Bots are file paths or built-in bot names (see --list). Each game seats the bots you
  list plus the --vs opponents, in shuffled seats.

Options:
  --vs <list>          Opponents, comma separated built-in names or files (default: gunner).
                       Repeat a name for several copies, e.g. --vs gunner,gunner,chaser.
  --games <n>          Number of games (default 10).
  --map <ids|all>      Map id(s), comma separated; games rotate through them (default all).
  --seed <s>           Base seed (default: random). Same seed + same bots = same games.
  --time-limit <sec>   Match length (default ${DEFAULT_CONFIG.match.defaultTimeLimit}).
  --no-zone            Turn the shrinking safe zone off.
  --budget <ms>        decide() time budget (default ${DEFAULT_CONFIG.sandbox.decideBudgetMs}; raise it on a slow machine).
  --trace <file>       Write a tick-by-tick JSON trace of game 0 (positions, hp, events).
  --replays <dir>      Save each game as a replay .json (open it on the Harena page: Load replay…).
  --json               Print results as JSON.
  --list               List built-in bots and maps.
  -h, --help           Show this help.

Examples:
  node harena-sim.mjs mybot.js
  node harena-sim.mjs mybot.js --vs gunner,chaser,astra --games 20 --map blocks
  node harena-sim.mjs mybot.js --games 1 --trace trace.json
`;

function fail(message: string): never {
  console.error(`${message}\n\nRun with --help for usage.`);
  process.exit(2);
}

/** A bot from a file path or a built-in name; exits with the static-check errors if it would be blocked. */
function loadBot(spec: string, label?: string): LoadedBot {
  let source: string;
  const builtin = BUILTIN_BOTS[spec.replace(/\.js$/, '')];
  if (builtin !== undefined && !spec.includes('/') && !spec.includes('\\')) {
    source = builtin;
  } else {
    try {
      source = readFileSync(resolve(spec), 'utf8');
    } catch {
      fail(`Bot not found: "${spec}" is neither a file nor a built-in bot (${Object.keys(BUILTIN_BOTS).join(', ')}).`);
    }
  }
  const check = staticCheck(source);
  if (!check.ok) {
    const errors = check.findings.filter((f) => f.severity === 'error').map((f) => `  - ${f.message}${f.line ? ` (line ${f.line})` : ''}`);
    console.error(`${spec} would be refused by Harena before it runs:\n${errors.join('\n')}`);
    process.exit(1);
  }
  for (const f of check.findings.filter((f) => f.severity === 'warning')) {
    console.error(`warning: ${spec}: ${f.message}${f.line ? ` (line ${f.line})` : ''}`);
  }
  return { file: label ?? basename(spec).replace(/\.js$/, ''), source, hash: sourceHash(source) };
}

interface TraceFrame {
  t: number;
  /** Per player: [x, y, hp, shield, alive 0/1, weapon, lives]. */
  p: Array<[number, number, number, number, number, string, number]>;
  ev?: GameEvent[];
}

function traceGame(state: GameState, frames: TraceFrame[], events: GameEvent[]): void {
  const r = (v: number) => Math.round(v * 10) / 10;
  frames.push({
    t: state.tick,
    p: state.players.map((p) => [r(p.x), r(p.y), Math.round(p.hp), Math.round(p.shield), p.alive ? 1 : 0, p.weapon, p.lives]),
    ...(events.length ? { ev: events } : {}),
  });
}

/** The log lines worth showing for the bots under test: problems (with counts) and early console output. */
function logDigest(games: GameResult[], bot: string): { problems: string[]; console: string[] } {
  const problems = new Map<string, number>();
  const output: string[] = [];
  for (const game of games) {
    for (const seat of game.seats.filter((s) => s.bot === bot)) {
      for (const entry of seat.logs ?? []) {
        if (entry.level === 'error' || entry.level === 'warn') problems.set(entry.message, (problems.get(entry.message) ?? 0) + entry.count);
        else if (entry.level === 'bot' && game.index === 0 && output.length < 20) output.push(`tick ${entry.tick}: ${entry.message}`);
      }
    }
  }
  return {
    problems: [...problems].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([m, n]) => (n > 1 ? `${m} (×${n})` : m)),
    console: output,
  };
}

async function main(): Promise<void> {
  let parsed;
  try {
    parsed = parseArgs({
      allowPositionals: true,
      options: {
        vs: { type: 'string', default: 'gunner' },
        games: { type: 'string', default: '10' },
        map: { type: 'string', default: 'all' },
        seed: { type: 'string' },
        'time-limit': { type: 'string' },
        budget: { type: 'string' },
        'no-zone': { type: 'boolean', default: false },
        trace: { type: 'string' },
        replays: { type: 'string' },
        json: { type: 'boolean', default: false },
        list: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
    });
  } catch (err) {
    fail((err as Error).message);
  }
  const args = parsed.values;
  const build = typeof __HARENA_BUILD__ === 'string' ? __HARENA_BUILD__ : 'dev';
  if (args.help) {
    console.log(`${HELP}\nBuild: ${build}`);
    return;
  }
  if (args.list) {
    console.log(`Built-in bots: ${Object.keys(BUILTIN_BOTS).join(', ')}`);
    console.log(`Maps: ${MAPS.map((m) => `${m.id} (${m.name}, ${m.width}×${m.height}, up to ${m.spawns.length} players)`).join(', ')}`);
    return;
  }
  if (parsed.positionals.length === 0) fail('Give at least one bot file to test.');

  const positiveInt = (name: string, value: string | undefined, fallback: number): number => {
    if (value === undefined) return fallback;
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1) fail(`--${name} must be a positive integer.`);
    return n;
  };
  const opponents = args.vs.split(',').map((s) => s.trim()).filter(Boolean);
  // A tested file named like a built-in opponent (e.g. your own gunner.js) gets a distinct label.
  const tested = parsed.positionals.map((spec) => {
    const base = basename(spec).replace(/\.js$/, '');
    return loadBot(spec, opponents.includes(base) ? `${base} (yours)` : base);
  });
  const bots = [...tested, ...opponents.map((spec) => loadBot(spec))];
  const maps = args.map === 'all'
    ? MAPS.filter((m) => m.spawns.length >= bots.length)
    : args.map.split(',').map((id) => MAPS.find((m) => m.id === id.trim()) ?? fail(`Unknown map "${id}". Maps: ${MAPS.map((m) => m.id).join(', ')}`));
  if (maps.length === 0) fail(`No map has room for ${bots.length} players.`);
  const games = positiveInt('games', args.games, 10);
  const budget = args.budget === undefined ? undefined : positiveInt('budget', args.budget, DEFAULT_CONFIG.sandbox.decideBudgetMs);
  const timeLimit = args['time-limit'] === undefined ? undefined : positiveInt('time-limit', args['time-limit'], DEFAULT_CONFIG.match.defaultTimeLimit);
  const seed = args.seed ?? Math.floor(Math.random() * 1e9).toString(36);
  const config = mergeConfig(DEFAULT_CONFIG, {
    ...(budget ? { sandbox: { decideBudgetMs: budget } } : {}),
    ...(args['no-zone'] ? { zone: { damagePerSecond: 0 } } : {}),
  });
  const replayDir = args.replays ? resolve(args.replays) : undefined;
  if (replayDir) mkdirSync(replayDir, { recursive: true });

  const self = fileURLToPath(import.meta.url);
  const frames: TraceFrame[] = [];
  let traceNames: string[] = [];
  const started = performance.now();
  const results = await runGames({
    bots,
    maps,
    games,
    seed,
    timeLimit,
    concurrency: Math.max(1, Math.min(8, Math.floor((os.availableParallelism?.() ?? os.cpus().length) / bots.length))),
    config,
    createWorker: () => createNodeWorker(self, { role: WORKER_ROLE }),
    keepLogs: true,
    observe: args.trace
      ? (index, runner) => {
        if (index !== 0) return;
        traceNames = runner.state.players.map((p) => p.name);
        traceGame(runner.state, frames, []);
        runner.onTick((events, state) => traceGame(state, frames, events));
      }
      : undefined,
    onReplay: replayDir
      ? ({ index, map, seed: gameSeed }, replay) => {
        const file = join(replayDir, `game-${String(index).padStart(3, '0')}-${map}-${gameSeed}.json`);
        writeFileSync(file, JSON.stringify(replay));
        return file;
      }
      : undefined,
  }, (game, done) => {
    if (process.stderr.isTTY) process.stderr.write(`\r[${done}/${games}] game ${game.index} (${game.map}) done`.padEnd(60));
  });
  if (process.stderr.isTTY) process.stderr.write(`\r${' '.repeat(60)}\r`);
  const wallSeconds = (performance.now() - started) / 1000;
  const summary = summarize(results);
  const digests = Object.fromEntries(tested.map((b) => [b.file, logDigest(results, b.file)]));

  if (args.trace) {
    const g = results[0];
    writeFileSync(resolve(args.trace), JSON.stringify({
      format: 'harena-trace-1',
      map: g.map,
      seed: g.seed,
      tickRate: config.tickRate,
      players: traceNames,
      note: 'p = [x, y, hp, shield, alive, weapon, lives] per player (index = player id), one frame per tick; ev = engine events of that tick.',
      frames,
    }));
  }

  if (args.json) {
    const strip = (g: GameResult) => ({ ...g, seats: g.seats.map(({ logs: _logs, ...rest }) => rest) });
    console.log(JSON.stringify({ build, seed, games: results.map(strip), bots: summary, logs: digests }, null, 2));
    return;
  }
  console.log(`Harena test kit (build ${build}) — same engine, rules and sandbox as real matches.\n`);
  console.log(formatReport(results, summary, { maps: maps.map((m) => m.id), seed, wallSeconds, tickRate: config.tickRate }));
  for (const bot of tested) {
    const { problems, console: output } = digests[bot.file];
    console.log(`\n${bot.file}: ${problems.length ? 'problems' : 'no errors, timeouts or invalid actions'}`);
    for (const p of problems) console.log(`  - ${p}`);
    if (output.length) {
      console.log(`  console output (game 0, first ${output.length} lines):`);
      for (const line of output) console.log(`    ${line}`);
    }
  }
  if (args.trace) console.log(`\nTrace of game 0 written to ${resolve(args.trace)}`);
  if (replayDir) console.log(`Replays written to ${replayDir}`);
}

if (!isMainThread && (workerData as { role?: string } | null)?.role === WORKER_ROLE) {
  runBotWorker(parentPort!);
} else {
  await main();
}
