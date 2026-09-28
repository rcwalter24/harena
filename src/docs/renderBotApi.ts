import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CONFIG_DOCS, DEFAULT_CONFIG, flattenConfig, type GameConfig } from '../engine/config.ts';
import { validateMap } from '../engine/maps.ts';
import { FORBIDDEN_GLOBALS, MAX_SOURCE_BYTES } from '../review/staticCheck.ts';

/**
 * Renders BOT_API.md from docs/BOT_API.template.md, the live config, the bot API
 * types and the example bot, so the document cannot drift from the code.
 *
 * Placeholders:
 *   {{knife.damage}}      any numeric config path
 *   {{ticks:knife.cooldown}}  a duration in seconds converted to ticks
 *   {{derived.name}}      computed values (see derivedValues)
 *   {{CONSTANTS_TABLE}} {{API_TYPES}} {{EXAMPLE_BOT}} {{FORBIDDEN_LIST}} {{MAPS_TABLE}} {{GENERATED_NOTICE}}
 */

const ROOT = resolve(import.meta.dirname, '../..');
export const EXAMPLE_BOT_FILE = 'bots/gunner.js';

const fmt = (n: number) => (Number.isInteger(n) ? String(n) : String(Number(n.toFixed(3))));

function derivedValues(c: GameConfig): Record<string, string> {
  const weights = Object.entries(c.items.weights)
    .map(([k, w]) => `${k} ${w}`)
    .join(', ');
  return {
    tickMs: fmt(1000 / c.tickRate),
    turnPerTick: fmt(c.player.turnRateDegrees / c.tickRate),
    knifeRange: fmt(2 * c.player.radius + c.knife.reach),
    knifeHalfArc: fmt(c.knife.arcDegrees / 2),
    bulletPerTick: fmt(c.gun.bulletSpeed / c.tickRate),
    bulletVsPlayer: fmt(Math.round((c.gun.bulletSpeed / c.player.speedKnife) * 10) / 10),
    bulletHitRadius: fmt(c.player.radius + c.gun.bulletRadius),
    pickupReach: fmt(c.player.radius + c.items.radius),
    itemWeights: weights,
    maxOpponents: fmt(c.match.maxPlayers - 1),
    maxSourceKb: fmt(MAX_SOURCE_BYTES / 1000),
  };
}

function lookup(config: GameConfig, path: string): number | undefined {
  let v: unknown = config;
  for (const key of path.split('.')) {
    if (v === null || typeof v !== 'object') return undefined;
    v = (v as Record<string, unknown>)[key];
  }
  return typeof v === 'number' ? v : undefined;
}

function constantsTable(config: GameConfig): string {
  const rows = flattenConfig(config);
  const sections = new Map<string, Array<[string, number]>>();
  for (const row of rows) {
    const section = row[0].includes('.') ? row[0].split('.')[0] : 'general';
    if (!sections.has(section)) sections.set(section, []);
    sections.get(section)!.push(row);
  }
  const out: string[] = [];
  for (const [section, entries] of sections) {
    out.push(`**${section}**\n`, '| `info.rules.…` | Value | Unit | Meaning |', '|---|---|---|---|');
    for (const [path, value] of entries) {
      const doc = CONFIG_DOCS[path];
      if (!doc) throw new Error(`CONFIG_DOCS is missing an entry for "${path}"`);
      out.push(`| \`${path}\` | ${fmt(value)} | ${doc.unit} | ${doc.description} |`);
    }
    out.push('');
  }
  return out.join('\n').trimEnd();
}

function mapsTable(): string {
  const dir = resolve(ROOT, 'maps');
  const maps = readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => validateMap(JSON.parse(readFileSync(resolve(dir, f), 'utf8'))));
  const rows = maps.map((m) => `| \`${m.id}\` | ${m.name} | ${m.width} × ${m.height} | ${m.walls.length} | ${m.bushes?.length ?? 0} | ${m.spawns.length} | ${m.gunSpawns.length} |`);
  return ['| id | Name | Size | Walls | Bushes | Spawns | Gun pads |', '|---|---|---|---|---|---|---|', ...rows].join('\n');
}

function forbiddenList(): string {
  const byReason = new Map<string, string[]>();
  for (const [name, reason] of FORBIDDEN_GLOBALS) {
    if (!byReason.has(reason)) byReason.set(reason, []);
    byReason.get(reason)!.push(`\`${name}\``);
  }
  return [...byReason].map(([reason, names]) => `- ${reason}: ${names.join(', ')}`).join('\n');
}

export function renderBotApi(config: GameConfig = DEFAULT_CONFIG): string {
  const template = readFileSync(resolve(ROOT, 'docs/BOT_API.template.md'), 'utf8');
  const derived = derivedValues(config);
  const blocks: Record<string, () => string> = {
    GENERATED_NOTICE: () =>
      '<!-- GENERATED FILE: edit docs/BOT_API.template.md or src/engine/config.ts, then run `npm run docs`. -->',
    CONSTANTS_TABLE: () => constantsTable(config),
    API_TYPES: () => readFileSync(resolve(ROOT, 'src/engine/botApi.ts'), 'utf8').trimEnd(),
    EXAMPLE_BOT: () => readFileSync(resolve(ROOT, EXAMPLE_BOT_FILE), 'utf8').trimEnd(),
    FORBIDDEN_LIST: forbiddenList,
    MAPS_TABLE: mapsTable,
  };

  const unknown: string[] = [];
  const rendered = template.replace(/\{\{\s*([\w.:]+)\s*\}\}/g, (whole, key: string) => {
    if (blocks[key]) return blocks[key]();
    if (key.startsWith('derived.')) {
      const v = derived[key.slice('derived.'.length)];
      if (v !== undefined) return v;
    } else if (key.startsWith('ticks:')) {
      const v = lookup(config, key.slice('ticks:'.length));
      if (v !== undefined) return fmt(Math.round(v * config.tickRate));
    } else {
      const v = lookup(config, key);
      if (v !== undefined) return fmt(v);
    }
    unknown.push(whole);
    return whole;
  });
  if (unknown.length > 0) throw new Error(`Unknown placeholders in BOT_API template: ${unknown.join(', ')}`);
  return rendered;
}
