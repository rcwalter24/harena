import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { TypeSafeClient } from '@typesafe-ai/sdk';
import { sourceHash } from './staticCheck.ts';
import { JEV_MODEL, reviewSource, type BotReview, type JevClient } from './jev.ts';

/** Node-side helpers for bot reviews: locating bots, the API key, and review files. */

export const BOTS_DIR = resolve(import.meta.dirname, '../../bots');

/** `gunner.js` → `bots/gunner.review.json` */
export function reviewPath(botFile: string): string {
  return join(BOTS_DIR, `${basename(botFile, '.js')}.review.json`);
}

export function listBotFiles(): string[] {
  return readdirSync(BOTS_DIR).filter((f) => f.endsWith('.js')).sort();
}

/** Only plain file names inside bots/ are accepted (no paths). */
export function isValidBotFile(file: string): boolean {
  return /^[\w.-]+\.js$/.test(file) && !file.startsWith('.') && existsSync(join(BOTS_DIR, file));
}

/**
 * Read the TypeSafe API key without ever printing it. Order: TYPESAFE_API_KEY,
 * then the file at TYPESAFE_KEY_FILE, then ~/.secrets/typesafe. The file may
 * hold just the key, or a `TYPESAFE_API_KEY=...` line.
 */
export function loadTypesafeKey(): string | null {
  const fromEnv = process.env.TYPESAFE_API_KEY?.trim();
  if (fromEnv) return fromEnv;
  const path = process.env.TYPESAFE_KEY_FILE ?? join(homedir(), '.secrets', 'typesafe');
  if (!existsSync(path)) return null;
  if (statSync(path).isDirectory()) {
    throw new Error(`${path} is a directory; set TYPESAFE_KEY_FILE to the file that contains the key`);
  }
  const text = readFileSync(path, 'utf8');
  const assigned = /TYPESAFE_API_KEY\s*[=:]\s*["']?([^\s"']+)/.exec(text);
  if (assigned) return assigned[1];
  const line = text.split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('#'));
  return line ? line.replace(/^export\s+/, '').replace(/^["']|["']$/g, '') : null;
}

export function createJevClient(): JevClient {
  const apiKey = loadTypesafeKey();
  if (!apiKey) throw new Error('No TypeSafe API key: set TYPESAFE_API_KEY or put the key in ~/.secrets/typesafe');
  return new TypeSafeClient({ apiKey, defaultModel: JEV_MODEL, timeout: 30_000, logLevel: 'off' });
}

export function readReview(botFile: string): BotReview | null {
  const path = reviewPath(botFile);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as BotReview;
  } catch {
    return null;
  }
}

/** All saved reviews keyed by bot file name. */
export function readAllReviews(): Record<string, BotReview> {
  const out: Record<string, BotReview> = {};
  for (const file of listBotFiles()) {
    const review = readReview(file);
    if (review) out[file] = review;
  }
  return out;
}

export function isReviewCurrent(botFile: string): boolean {
  const review = readReview(botFile);
  if (!review) return false;
  return review.sourceHash === sourceHash(readFileSync(join(BOTS_DIR, botFile), 'utf8'));
}

/** Review a bot in bots/ and save the result next to it. */
export async function reviewBotFile(botFile: string, client: JevClient | null): Promise<BotReview> {
  if (!isValidBotFile(botFile)) throw new Error(`Not a bot file in bots/: ${botFile}`);
  const source = readFileSync(join(BOTS_DIR, botFile), 'utf8');
  const review = await reviewSource(botFile, source, client);
  writeFileSync(reviewPath(botFile), `${JSON.stringify(review, null, 2)}\n`);
  return review;
}
