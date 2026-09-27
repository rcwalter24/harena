import type { BotReview } from '../review/jev.ts';
import { sourceHash, staticCheck, type StaticCheckResult } from '../review/staticCheck.ts';

/** A bot file discovered in bots/, with its static check (computed in the browser). */
export interface BotEntry {
  file: string;
  /** meta.name if the file declares one, else the file name without .js. */
  name: string;
  author: string;
  source: string;
  hash: string;
  static: StaticCheckResult;
}

const modules = import.meta.glob('/bots/*.js', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

/** Read `export const meta = { name: '...', author: '...' }` without running the bot. */
function readMeta(source: string, key: 'name' | 'author'): string | null {
  const block = /export\s+const\s+meta\s*=\s*\{([^}]*)\}/.exec(source);
  if (!block) return null;
  const m = new RegExp(`${key}\\s*:\\s*(['"\`])([^'"\`]{1,40})\\1`).exec(block[1]);
  return m ? m[2] : null;
}

export const BOTS: BotEntry[] = Object.entries(modules)
  .map(([path, source]) => {
    const file = path.split('/').pop()!;
    return {
      file,
      name: readMeta(source, 'name') ?? file.replace(/\.js$/, ''),
      author: readMeta(source, 'author') ?? '',
      source,
      hash: sourceHash(source),
      static: staticCheck(source),
    };
  })
  .sort((a, b) => a.file.localeCompare(b.file));

export function getBot(file: string): BotEntry | undefined {
  return BOTS.find((b) => b.file === file);
}

/** Saved reviews from the dev server (empty when the API isn't available, e.g. a static build). */
export async function fetchReviews(): Promise<Record<string, BotReview>> {
  try {
    const res = await fetch('/api/reviews');
    if (!res.ok) return {};
    return (await res.json()) as Record<string, BotReview>;
  } catch {
    return {};
  }
}

export async function requestReview(file: string): Promise<BotReview> {
  const res = await fetch('/api/review', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ file }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? `review failed (${res.status})`);
  return body as BotReview;
}

export type ReviewBadge = 'pass' | 'warn' | 'danger' | 'blocked' | 'error' | 'stale' | 'unreviewed';

/** Badge for a bot: static errors always block; a review is stale once the source changes. */
export function reviewBadge(bot: BotEntry, review: BotReview | undefined): ReviewBadge {
  if (!bot.static.ok) return 'blocked';
  if (!review) return 'unreviewed';
  if (review.sourceHash !== bot.hash) return 'stale';
  if (!review.jev) return 'unreviewed';
  return review.verdict;
}
