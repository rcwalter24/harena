// Headless batch matches: npm run batch -- --bots gunner,chaser --games 50
import { availableParallelism } from 'node:os';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { loadMaps, runBatch, type BatchSummary } from '../src/batch/batch.ts';

const HELP = `Usage: npm run batch -- --bots <a,b,...> [options]

Plays N headless games between bots in bots/ and prints win rates and stats.
Every game uses its own seed (<seed>-<index>) and shuffles the seats, and
spawn points are shuffled by the seed. With no timeouts, the same arguments
give the same results.

Options:
  --bots <list>        Bot files, comma separated ("gunner,chaser" or "gunner.js,chaser.js").
                       Repeat a name to seat several copies (2-8 bots per game). Required.
  --games <n>          Number of games (default 20).
  --map <ids|all>      Map id(s), comma separated; games rotate through them (default open).
  --seed <s>           Base seed (default: random).
  --time-limit <sec>   Match length (default from config: 180).
  --concurrency <n>    Games played at the same time (default: CPU cores / bots, 1-8).
  --budget <ms>        Override the per-tick decide() budget (default from config).
  --replays <dir>      Write one replay .json per game into <dir> (open them in the web app).
  --json               Print the full summary as JSON instead of a table.
  -h, --help           Show this help.
`;

function fail(message: string): never {
  console.error(`${message}\n\nRun with --help for usage.`);
  process.exit(2);
}

let args;
try {
  args = parseArgs({
    options: {
      bots: { type: 'string' },
      games: { type: 'string', default: '20' },
      map: { type: 'string', default: 'open' },
      seed: { type: 'string' },
      'time-limit': { type: 'string' },
      concurrency: { type: 'string' },
      budget: { type: 'string' },
      replays: { type: 'string' },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  }).values;
} catch (err) {
  fail((err as Error).message);
}

if (args.help) {
  console.log(HELP);
  process.exit(0);
}
if (!args.bots) fail('--bots is required.');

const positiveInt = (name: string, value: string | undefined, fallback: number): number => {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) fail(`--${name} must be a positive integer.`);
  return n;
};

const bots = args.bots.split(',').map((s) => s.trim()).filter(Boolean);
const maps = args.map === 'all' ? [...loadMaps().keys()] : args.map.split(',').map((s) => s.trim()).filter(Boolean);
const games = positiveInt('games', args.games, 20);
const timeLimit = args['time-limit'] === undefined ? undefined : positiveInt('time-limit', args['time-limit'], 180);
const budget = args.budget === undefined ? undefined : positiveInt('budget', args.budget, 10);
const defaultConcurrency = Math.max(1, Math.min(8, Math.floor(availableParallelism() / Math.max(1, bots.length))));
const concurrency = positiveInt('concurrency', args.concurrency, defaultConcurrency);
const seed = args.seed ?? Math.floor(Math.random() * 1e9).toString(36);

const pct = (x: number | null) => (x === null ? '–' : `${(100 * x).toFixed(1)}%`);

function table(rows: string[][]): string {
  const widths = rows[0].map((_, c) => Math.max(...rows.map((r) => r[c].length)));
  return rows
    .map((r, i) => {
      const line = r.map((cell, c) => (c === 0 ? cell.padEnd(widths[c]) : cell.padStart(widths[c]))).join('  ');
      return i === 0 ? `${line}\n${widths.map((w) => '-'.repeat(w)).join('  ')}` : line;
    })
    .join('\n');
}

function report(summary: BatchSummary): string {
  const n = summary.games.length;
  const header = ['bot', 'seats', 'wins', 'win%', 'draws', 'avg rank', 'K', 'D', 'K/D', 'dmg/game', 'gun acc', 'grenades', 'mines', 'items', 'fails', 'avg ms', 'max ms'];
  const rows = summary.bots.map((b) => [
    b.bot,
    String(b.seats),
    String(b.wins),
    pct(b.winRate),
    String(b.draws),
    b.avgRank.toFixed(2),
    String(b.kills),
    String(b.deaths),
    b.deaths > 0 ? (b.kills / b.deaths).toFixed(2) : b.kills > 0 ? '∞' : '–',
    (b.damageDealt / b.seats).toFixed(0),
    pct(b.accuracy),
    `${b.grenadeHits}/${b.grenadesFired}`,
    String(b.minesPlanted),
    (b.itemsPicked / b.seats).toFixed(1),
    b.timeouts + b.errors + b.invalid + b.restarts > 0
      ? `${b.timeouts}t ${b.errors}e ${b.invalid}i ${b.restarts}r${b.disabled ? ` ${b.disabled}x` : ''}`
      : '0',
    b.avgDecideMs.toFixed(3),
    b.maxDecideMs.toFixed(2),
  ]);
  const reasons = new Map<string, number>();
  for (const g of summary.games) reasons.set(g.reason, (reasons.get(g.reason) ?? 0) + 1);
  const avgLen = summary.games.reduce((s, g) => s + g.endTick, 0) / n / 30;
  return [
    `${n} games · maps ${summary.options.maps.join(', ')} · seed ${summary.options.seed} · ${summary.wallSeconds.toFixed(1)}s wall time`,
    `endings: ${[...reasons].map(([r, c]) => `${r} ${c}`).join(', ')} · average length ${avgLen.toFixed(1)}s`,
    '',
    table([header, ...rows]),
    '',
    'win% = sole first places / seats (a bot seated twice has two seats per game). avg rank: 1 is best.',
    'fails: t = timeouts, e = exceptions, i = invalid actions, r = worker restarts, x = seats disabled.',
  ].join('\n');
}

try {
  const summary = await runBatch(
    { bots, maps, games, seed, timeLimit, concurrency, replayDir: args.replays ? resolve(args.replays) : undefined, config: budget ? { sandbox: { decideBudgetMs: budget } } : undefined },
    (game, done) => {
      if (process.stderr.isTTY) {
        const winner = game.seats.filter((s) => s.rank === 1).map((s) => s.bot).join(' = ');
        process.stderr.write(`\r[${done}/${games}] game ${game.index} (${game.map}) → ${winner}`.padEnd(70));
      }
    },
  );
  if (process.stderr.isTTY) process.stderr.write(`\r${' '.repeat(70)}\r`);
  if (args.json) console.log(JSON.stringify(summary, null, 2));
  else console.log(report(summary));
  if (args.replays) console.error(`Replays written to ${resolve(args.replays)}`);
} catch (err) {
  if (process.stderr.isTTY) process.stderr.write(`\r${' '.repeat(70)}\r`);
  console.error((err as Error).message);
  process.exit(1);
}
