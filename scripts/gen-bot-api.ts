// Regenerate BOT_API.md (or, with --check, fail if it is out of date).
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderBotApi } from '../src/docs/renderBotApi.ts';

const target = resolve(import.meta.dirname, '../BOT_API.md');
const content = renderBotApi();
if (process.argv.includes('--check')) {
  let current = '';
  try {
    current = readFileSync(target, 'utf8');
  } catch {
    // missing file = out of date
  }
  if (current !== content) {
    console.error('BOT_API.md is out of date. Run `npm run docs`.');
    process.exit(1);
  }
  console.log('BOT_API.md is up to date.');
} else {
  writeFileSync(target, content);
  console.log(`Wrote ${target}`);
}
