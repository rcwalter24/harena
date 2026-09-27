import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CONFIG_DOCS, DEFAULT_CONFIG, flattenConfig } from '../src/engine/config.ts';
import { renderBotApi } from '../src/docs/renderBotApi.ts';

describe('BOT_API.md', () => {
  it('is up to date with the config, types and example bot (run `npm run docs`)', () => {
    const current = readFileSync(new URL('../BOT_API.md', import.meta.url), 'utf8');
    expect(current === renderBotApi(), 'BOT_API.md is stale: run `npm run docs`').toBe(true);
  });

  it('documents every config value, and nothing else', () => {
    const paths = flattenConfig(DEFAULT_CONFIG).map(([p]) => p).sort();
    expect(Object.keys(CONFIG_DOCS).sort()).toEqual(paths);
  });

  it('reflects config changes', () => {
    const doc = renderBotApi({ ...DEFAULT_CONFIG, knife: { ...DEFAULT_CONFIG.knife, damage: 99 } });
    expect(doc).toContain('Damage **99**');
    expect(doc).toContain('| `knife.damage` | 99 |');
  });
});
