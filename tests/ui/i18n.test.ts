import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DUMMY_KINDS } from '../../src/match/dummies.ts';
import { ZH } from '../../src/ui/i18n.ts';

const SOURCE_DIRS = ['src/ui', 'src/video'];

/** String literals passed straight to t(...), including both branches of `t(cond ? 'a' : 'b')`. */
function translatedLiterals(): string[] {
  const keys: string[] = [];
  for (const dir of SOURCE_DIRS) {
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.ts'))) {
      const source = readFileSync(join(dir, file), 'utf8');
      for (const call of source.matchAll(/\bt\(((?:'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|[^)'"])*)\)/g)) {
        // Skip the operands of comparisons (`e.weapon === 'mine' ? ... : ...`): those aren't shown.
        const shown = call[1].replace(/[!=]==\s*('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")/g, '');
        for (const lit of shown.matchAll(/'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"/g)) {
          const text = (lit[1] ?? lit[2]).replace(/\\(.)/g, '$1');
          if (/[A-Za-z]/.test(text)) keys.push(text);
        }
      }
    }
  }
  return keys;
}

/** Keys reached through a variable (map names, dummy kinds, weapons, badge and reason tables). */
const INDIRECT = [
  ...readdirSync('maps').map((f) => (JSON.parse(readFileSync(join('maps', f), 'utf8')) as { name: string }).name),
  ...DUMMY_KINDS,
  'knife', 'gun', 'launcher',
  'follows', 'partial', 'broken',
  'reviewed ✓', 'review: warning', 'review: danger', 'blocked', 'review failed', 'changed since review', 'not reviewed', 'checked ✓',
  'Last one standing', 'Everyone eliminated', 'Time limit',
  ' blew themselves up', ' was caught outside the zone', ' died',
];

const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe('Chinese UI text', () => {
  it('has a translation for every string passed to t()', () => {
    const keys = [...new Set([...translatedLiterals(), ...INDIRECT])];
    expect(keys.length).toBeGreaterThan(150);
    expect(keys.filter((k) => !(k in ZH))).toEqual([]);
  });

  it('keeps the placeholders of every entry', () => {
    const broken = Object.entries(ZH).filter(([en, zh]) => placeholders(en).join() !== placeholders(zh).join());
    expect(broken).toEqual([]);
  });
});
