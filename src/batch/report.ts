import type { BotSummary, GameResult } from './games.ts';

/** Plain-text results table shared by `npm run batch` and the test kit. */

const pct = (x: number | null) => (x === null ? '–' : `${(100 * x).toFixed(1)}%`);

export function table(rows: string[][]): string {
  const widths = rows[0].map((_, c) => Math.max(...rows.map((r) => r[c].length)));
  return rows
    .map((r, i) => {
      const line = r.map((cell, c) => (c === 0 ? cell.padEnd(widths[c]) : cell.padStart(widths[c]))).join('  ');
      return i === 0 ? `${line}\n${widths.map((w) => '-'.repeat(w)).join('  ')}` : line;
    })
    .join('\n');
}

export interface ReportInfo {
  maps: string[];
  seed: string;
  wallSeconds: number;
  tickRate: number;
}

export function formatReport(games: GameResult[], bots: BotSummary[], info: ReportInfo): string {
  const n = games.length;
  const header = ['bot', 'seats', 'wins', 'win%', 'draws', 'avg rank', 'K', 'D', 'K/D', 'dmg/game', 'gun acc', 'grenades', 'mines', 'items', 'fails', 'avg ms', 'max ms'];
  const rows = bots.map((b) => [
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
  for (const g of games) reasons.set(g.reason, (reasons.get(g.reason) ?? 0) + 1);
  const avgLen = games.reduce((s, g) => s + g.endTick, 0) / n / info.tickRate;
  return [
    `${n} games · maps ${info.maps.join(', ')} · seed ${info.seed} · ${info.wallSeconds.toFixed(1)}s wall time`,
    `endings: ${[...reasons].map(([r, c]) => `${r} ${c}`).join(', ')} · average length ${avgLen.toFixed(1)}s`,
    '',
    table([header, ...rows]),
    '',
    'win% = sole first places / seats (a bot seated twice has two seats per game). avg rank: 1 is best.',
    'fails: t = timeouts, e = exceptions, i = invalid actions, r = worker restarts, x = seats disabled.',
  ].join('\n');
}
