import { describe, expect, it } from 'vitest';
import { extractBotCode, fixRequest, localBotId } from '../../src/ui/botCode.ts';

describe('pasted bot code', () => {
  it('keeps plain code as it is', () => {
    expect(extractBotCode('  export function decide() { return {}; }\n')).toBe('export function decide() { return {}; }');
  });

  it('picks the longest code block out of an AI reply', () => {
    const reply = [
      'Here is your bot:',
      '```javascript',
      'export function init(info) {}',
      'export function decide(state) { return {}; }',
      '```',
      'Run it with:',
      '```',
      'npm run dev',
      '```',
      'Good luck!',
    ].join('\n');
    expect(extractBotCode(reply)).toBe('export function init(info) {}\nexport function decide(state) { return {}; }');
  });

  it('handles CRLF line endings and fences with trailing spaces', () => {
    expect(extractBotCode('Bot:\r\n```js \r\nexport const a = 1;\r\n```\r\n')).toBe('export const a = 1;');
  });
});

describe('local bot ids', () => {
  it('slugs the name and avoids taken ids', () => {
    expect(localBotId('Sentinel Inertia!', new Set())).toBe('my/sentinel-inertia.js');
    expect(localBotId('Apex', new Set(['my/apex.js', 'my/apex-2.js']))).toBe('my/apex-3.js');
  });

  it('falls back to "bot" for names without latin letters or digits', () => {
    expect(localBotId('豆包', new Set())).toBe('my/bot.js');
  });
});

it('builds a fix request listing every error', () => {
  const text = fixRequest(['imports are not allowed (line 1)', 'missing export decide']);
  expect(text).toContain('- imports are not allowed (line 1)');
  expect(text).toContain('- missing export decide');
});
