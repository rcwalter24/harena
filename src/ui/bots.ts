import type { BotReview } from '../review/jev.ts';
import { sourceHash, staticCheck, type StaticCheckResult } from '../review/staticCheck.ts';
import { localBotId } from './botCode.ts';
import { t } from './i18n.ts';

/** A bot from bots/ (bundled at build time) or one pasted into this browser. */
export interface BotEntry {
  /** File name in bots/, or `my/<slug>.js` for a bot saved in this browser. */
  file: string;
  /** meta.name if the file declares one, else the file name without .js. */
  name: string;
  author: string;
  source: string;
  hash: string;
  static: StaticCheckResult;
  /** Saved in this browser's storage rather than shipped in bots/. */
  local?: boolean;
}

const modules = import.meta.glob('/bots/*.js', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

/** Read `export const meta = { name: '...', author: '...' }` without running the bot. */
export function readMeta(source: string, key: 'name' | 'author'): string | null {
  const block = /export\s+const\s+meta\s*=\s*\{([^}]*)\}/.exec(source);
  if (!block) return null;
  const m = new RegExp(`${key}\\s*:\\s*(['"\`])([^'"\`]{1,40})\\1`).exec(block[1]);
  return m ? m[2] : null;
}

function makeEntry(file: string, source: string, name: string | null): BotEntry {
  return {
    file,
    name: name || (readMeta(source, 'name') ?? file.split('/').pop()!.replace(/\.js$/, '')),
    author: readMeta(source, 'author') ?? '',
    source,
    hash: sourceHash(source),
    static: staticCheck(source),
  };
}

const BUNDLED: BotEntry[] = Object.entries(modules)
  .map(([path, source]) => makeEntry(path.split('/').pop()!, source, null))
  .sort((a, b) => a.file.localeCompare(b.file));

// Bots pasted on the setup page. They live in this browser's storage only, so a hosted
// build (which has just the bundled bots) can still play anyone's bot.
const LOCAL_KEY = 'harena.localBots.v1';

interface StoredBot {
  file: string;
  name: string;
  source: string;
}

function loadLocal(): BotEntry[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(LOCAL_KEY) ?? '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((b): b is StoredBot => !!b && typeof b.file === 'string' && typeof b.name === 'string' && typeof b.source === 'string')
      .map((b) => ({ ...makeEntry(b.file, b.source, b.name), local: true }));
  } catch {
    return [];
  }
}

let localBots = loadLocal();

function storeLocal(bots: BotEntry[]): void {
  const stored: StoredBot[] = bots.map((b) => ({ file: b.file, name: b.name, source: b.source }));
  try {
    localStorage.setItem(LOCAL_KEY, JSON.stringify(stored));
  } catch {
    throw new Error(t('This browser would not store the bot (storage is full or disabled, e.g. in a private window).'));
  }
  localBots = bots;
}

/** Bots saved in this browser first (newest first), then the ones from bots/. */
export function listBots(): BotEntry[] {
  return [...localBots, ...BUNDLED];
}

export function getBot(file: string): BotEntry | undefined {
  return localBots.find((b) => b.file === file) ?? BUNDLED.find((b) => b.file === file);
}

/** Save a pasted bot, or replace the code and name of the local bot `file`. */
export function saveLocalBot(name: string, source: string, file?: string): BotEntry {
  const existing = file ? localBots.find((b) => b.file === file) : undefined;
  const id = existing?.file ?? localBotId(name || readMeta(source, 'name') || 'bot', new Set(listBots().map((b) => b.file)));
  const entry: BotEntry = { ...makeEntry(id, source, name.trim() || null), local: true };
  storeLocal(existing ? localBots.map((b) => (b.file === id ? entry : b)) : [entry, ...localBots]);
  return entry;
}

export function deleteLocalBot(file: string): void {
  storeLocal(localBots.filter((b) => b.file !== file));
}

// Display-name overrides set on the setup page. Kept in this browser only: renaming never
// touches the bot file, so its source hash and review stay valid.
const ALIAS_KEY = 'harena.botAliases.v1';
export const MAX_ALIAS_LENGTH = 24;

function loadAliases(): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(ALIAS_KEY) ?? '{}');
    if (!parsed || typeof parsed !== 'object') return {};
    return Object.fromEntries(Object.entries(parsed).filter((e): e is [string, string] => typeof e[1] === 'string'));
  } catch {
    return {};
  }
}

const aliases = loadAliases();

/** Collapse whitespace, drop control characters and cap the length. */
export function cleanAlias(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, MAX_ALIAS_LENGTH).trim();
}

/** Name shown in the UI, matches and replays: the alias if set, else meta.name / file name. */
export function displayName(bot: BotEntry): string {
  return aliases[bot.file] ?? bot.name;
}

export function hasAlias(bot: BotEntry): boolean {
  return bot.file in aliases;
}

/** Set a bot's alias; an empty name or the bot's own name removes it. */
export function setAlias(bot: BotEntry, text: string): void {
  const alias = cleanAlias(text);
  if (alias === '' || alias === bot.name) delete aliases[bot.file];
  else aliases[bot.file] = alias;
  try {
    localStorage.setItem(ALIAS_KEY, JSON.stringify(aliases));
  } catch {
    // Storage unavailable: the alias lasts until the page reloads.
  }
}

const bundledReviews = import.meta.glob('/bots/*.review.json', { import: 'default', eager: true }) as Record<string, BotReview>;

/**
 * Jev reviews run in the dev server (it holds the API key). A static build (e.g. a hosted
 * copy) has no server: it shows the reviews saved next to the bundled bots and no Review button.
 */
export const CAN_REVIEW = import.meta.env.DEV;

/** Saved reviews: fresh from the dev server, or the ones bundled with the build. */
export async function fetchReviews(): Promise<Record<string, BotReview>> {
  if (!CAN_REVIEW) return Object.fromEntries(Object.values(bundledReviews).map((r) => [r.file, r]));
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

export type ReviewBadge = 'pass' | 'warn' | 'danger' | 'blocked' | 'error' | 'stale' | 'unreviewed' | 'local';

/**
 * Badge for a bot: static errors always block; a pasted bot only gets the static check;
 * a review is stale once the source changes.
 */
export function reviewBadge(bot: BotEntry, review: BotReview | undefined): ReviewBadge {
  if (!bot.static.ok) return 'blocked';
  if (bot.local) return 'local';
  if (!review) return 'unreviewed';
  if (review.sourceHash !== bot.hash) return 'stale';
  if (!review.jev) return 'unreviewed';
  return review.verdict;
}
