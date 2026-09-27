import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { sourceHash, staticCheck, stripCommentsAndStrings } from '../../src/review/staticCheck.ts';

const ok = `export function init(info) {}\nexport function decide(state) { return {}; }\n`;
const rules = (src: string) => staticCheck(src).findings.map((f) => `${f.severity}:${f.rule}`);

describe('staticCheck', () => {
  it('passes the example bots with no findings', () => {
    for (const name of ['random', 'chaser', 'gunner']) {
      const src = readFileSync(new URL(`../../bots/${name}.js`, import.meta.url), 'utf8');
      expect(staticCheck(src), name).toEqual({ ok: true, findings: [] });
    }
  });

  it('flags imports, require and dynamic code', () => {
    expect(rules(`import fs from 'fs';\n${ok}`)).toContain('error:no-import');
    expect(rules(`${ok}const m = import('x');`)).toContain('error:no-import');
    expect(rules(`${ok}const u = import.meta.url;`)).toContain('error:no-import');
    expect(rules(`${ok}require('fs');`)).toContain('error:no-require');
    expect(rules(`${ok}eval('1');`)).toContain('error:no-eval');
    expect(rules(`${ok}new Function('return 1');`)).toContain('error:no-function-constructor');
    expect(rules(`${ok}const F = (() => {}).constructor.constructor;`)).toContain('error:no-constructor-escape');
  });

  it('flags network, timers, globals and builtin tampering', () => {
    expect(rules(`${ok}fetch('https://x');`)).toContain('error:no-fetch');
    expect(rules(`${ok}setTimeout(() => {}, 1);`)).toContain('error:no-setTimeout');
    expect(rules(`${ok}globalThis.x = 1;`)).toContain('error:no-globalThis');
    expect(rules(`${ok}Math.random = () => 0;`)).toContain('error:no-builtin-mutation');
    expect(rules(`${ok}Array.prototype.foo = 1;`)).toContain('error:no-prototype-mutation');
    expect(rules(`${ok}postMessage({});`)).toContain('error:no-postMessage');
  });

  it('requires a synchronous decide export', () => {
    expect(staticCheck('export function init() {}').ok).toBe(false);
    expect(rules('export function init() {}')).toContain('error:export-decide');
    expect(rules('export async function decide() {}\nexport function init() {}')).toContain('error:async-decide');
    expect(rules('function decide() {}\nfunction init() {}\nexport { init, decide };')).not.toContain('error:export-decide');
    expect(rules('export const decide = (s) => ({});')).toEqual(['warning:export-init']);
  });

  it('ignores comments, strings, property names and local declarations', () => {
    const src = `${ok}
// fetch('x'); import x from 'y'; eval(1)
/* setTimeout(); require('fs') */
const note = "we never call fetch or eval here";
const t = \`template with process and import\`;
const important = 1;
const { self } = { self: 1 };
function process(p) { return p.fetch; }
`;
    expect(staticCheck(src)).toEqual({ ok: true, findings: [] });
  });

  it('warns about obfuscation and async code', () => {
    expect(rules(`${ok}const s = atob('ZmV0Y2g=');`)).toContain('warning:obfuscation-decode');
    expect(rules(`${ok}const big = "${'A'.repeat(2500)}";`)).toContain('warning:long-string');
    expect(rules(`${ok}Promise.resolve().then(() => 1);`)).toContain('warning:async-code');
  });

  it('reports line numbers', () => {
    const f = staticCheck(`${ok}\n\nfetch('x');`).findings.find((x) => x.rule === 'no-fetch')!;
    expect(f.line).toBe(5);
  });

  it('rejects oversized files', () => {
    expect(rules(`${ok}//${'x'.repeat(210_000)}`)).toContain('error:max-size');
  });

  it('strips comments but keeps strings for review', () => {
    const { commentsRemoved } = stripCommentsAndStrings('a(); // gone\n/* gone */ b("// kept");');
    expect(commentsRemoved).toBe('a(); \n b("// kept");');
  });

  it('source hash is stable and sensitive', () => {
    expect(sourceHash('abc')).toBe(sourceHash('abc'));
    expect(sourceHash('abc')).not.toBe(sourceHash('abd'));
  });
});
