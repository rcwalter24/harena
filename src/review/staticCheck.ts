/**
 * Deterministic static checks on a bot's source text. Errors block the bot from
 * being selected; warnings are shown but don't block. This complements (and does
 * not replace) the runtime sandbox, which hides these APIs anyway.
 *
 * Pure TS with no DOM or Node APIs: runs in the browser (bot list) and in Node
 * (review CLI).
 */

export type Severity = 'error' | 'warning';

export interface Finding {
  rule: string;
  severity: Severity;
  message: string;
  /** 1-based line number, or 0 for whole-file findings. */
  line: number;
}

export interface StaticCheckResult {
  ok: boolean;
  findings: Finding[];
}

export const MAX_SOURCE_BYTES = 200_000;

/**
 * Blank out comments and the contents of string/template literals (keeping
 * length and newlines, so indices still map to lines). Also returns the
 * literal texts, for obfuscation heuristics.
 */
export function stripCommentsAndStrings(src: string): { code: string; strings: { text: string; index: number }[]; commentsRemoved: string } {
  const out = src.split('');
  const strings: { text: string; index: number }[] = [];
  let noComments = '';
  const blank = (from: number, to: number) => {
    for (let k = from; k < to; k++) if (out[k] !== '\n') out[k] = ' ';
  };
  let i = 0;
  let copiedTo = 0;
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    if (c === '/' && next === '/') {
      const end = src.indexOf('\n', i);
      const stop = end === -1 ? src.length : end;
      noComments += src.slice(copiedTo, i);
      copiedTo = stop;
      blank(i, stop);
      i = stop;
    } else if (c === '/' && next === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end === -1 ? src.length : end + 2;
      noComments += src.slice(copiedTo, i) + src.slice(i, stop).replace(/[^\n]/g, '');
      copiedTo = stop;
      blank(i, stop);
      i = stop;
    } else if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < src.length && src[j] !== c) {
        if (src[j] === '\\') j++;
        else if (c !== '`' && src[j] === '\n') break;
        j++;
      }
      strings.push({ text: src.slice(i + 1, j), index: i });
      blank(i + 1, j);
      i = j + 1;
    } else {
      i++;
    }
  }
  noComments += src.slice(copiedTo);
  return { code: out.join(''), strings, commentsRemoved: noComments };
}

interface Rule {
  id: string;
  severity: Severity;
  pattern: RegExp;
  message: string;
  /** Skip this rule when the bot declares its own variable/function with this name. */
  unlessDeclared?: string;
}

/** Names the bot declares itself (const/let/var/function/class, incl. simple destructuring). */
function declaredNames(code: string): Set<string> {
  const names = new Set<string>();
  for (const m of code.matchAll(/(?<![\w$])(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  for (const m of code.matchAll(/(?<![\w$])(?:const|let|var)\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(',')) {
      const local = part.split(':').pop()!.split('=')[0].trim();
      if (/^[A-Za-z_$][\w$]*$/.test(local)) names.add(local);
    }
  }
  return names;
}

// `(?<![.\w$])` = not a property access and not part of a longer identifier.
const id = (name: string) => `(?<![.\\w$])${name}(?![\\w$])`;

export const FORBIDDEN_GLOBALS: Array<[string, string]> = [
  ['fetch', 'network access'], ['XMLHttpRequest', 'network access'], ['WebSocket', 'network access'],
  ['EventSource', 'network access'], ['WebTransport', 'network access'],
  ['importScripts', 'loading external code'], ['Worker', 'spawning workers'], ['SharedWorker', 'spawning workers'],
  ['BroadcastChannel', 'cross-context messaging'], ['MessageChannel', 'cross-context messaging'],
  ['postMessage', 'raw messaging with the host'], ['indexedDB', 'storage'], ['localStorage', 'storage'],
  ['sessionStorage', 'storage'], ['caches', 'storage'], ['navigator', 'browser APIs'], ['document', 'the page (DOM)'],
  ['process', 'the Node process'], ['Deno', 'runtime APIs'], ['Bun', 'runtime APIs'], ['WebAssembly', 'native code'],
  ['eval', 'dynamic code execution'], ['globalThis', 'the global scope'],
  ['setTimeout', 'running code outside decide()'], ['setInterval', 'running code outside decide()'],
  ['setImmediate', 'running code outside decide()'], ['queueMicrotask', 'running code outside decide()'],
  ['requestAnimationFrame', 'running code outside decide()'], ['SharedArrayBuffer', 'shared memory'],
  ['Atomics', 'shared memory'],
];

const RULES: Rule[] = [
  { id: 'no-import', severity: 'error', pattern: /(?<![.\w$])import(?![\w$])(?=\s*[({*\w'"`.])/g, message: 'imports are not allowed; a bot must be one self-contained file' },
  { id: 'no-require', severity: 'error', pattern: new RegExp(`${id('require')}\\s*\\(`, 'g'), message: 'require() is not allowed' },
  { id: 'no-function-constructor', severity: 'error', pattern: new RegExp(`${id('Function')}\\s*\\(|new\\s+Function(?![\\w$])`, 'g'), message: 'the Function constructor (dynamic code execution) is not allowed' },
  { id: 'no-constructor-escape', severity: 'error', pattern: /\.constructor\s*\.\s*constructor|\[\s*['"`]constructor['"`]\s*\]/g, message: 'reaching the Function constructor through .constructor is not allowed' },
  { id: 'no-builtin-mutation', severity: 'error', pattern: /(?<![.\w$])(Math|JSON|Object|Array|Number|String|Boolean|Reflect|console|Date|performance)\s*\.\s*[\w$]+\s*=(?!=)/g, message: 'modifying built-in objects is not allowed' },
  { id: 'no-prototype-mutation', severity: 'error', pattern: /\.prototype\s*(\.\s*[\w$]+\s*)?=(?!=)|__proto__|Object\s*\.\s*setPrototypeOf/g, message: 'modifying prototypes is not allowed' },
  { id: 'async-decide', severity: 'error', pattern: /export\s+async\s+function\s+decide\b|export\s+const\s+decide\s*=\s*async\b/g, message: 'decide() must be synchronous' },
  { id: 'async-code', severity: 'warning', pattern: new RegExp(`${id('async')}|${id('await')}|${id('Promise')}`, 'g'), message: 'async code can run outside decide(); keep all work inside decide()' },
  { id: 'obfuscation-decode', severity: 'warning', pattern: new RegExp(`${id('atob')}|${id('btoa')}|String\\s*\\.\\s*fromCharCode|${id('unescape')}|${id('decodeURIComponent')}`, 'g'), message: 'decoding text at runtime looks like obfuscation' },
  { id: 'define-property', severity: 'warning', pattern: /Object\s*\.\s*(defineProperty|defineProperties|freeze)\s*\(\s*(Math|JSON|Object|Array|console|self|globalThis)\b/g, message: 'changing built-in objects is suspicious' },
];

for (const [name, what] of FORBIDDEN_GLOBALS) {
  RULES.push({
    id: `no-${name}`, severity: 'error', pattern: new RegExp(id(name), 'g'),
    message: `\`${name}\` is not available to bots (${what})`, unlessDeclared: name,
  });
}

function lineOf(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

export function staticCheck(source: string): StaticCheckResult {
  const findings: Finding[] = [];
  const bytes = new TextEncoder().encode(source).length;
  if (bytes > MAX_SOURCE_BYTES) {
    findings.push({ rule: 'max-size', severity: 'error', message: `file is ${bytes} bytes; the limit is ${MAX_SOURCE_BYTES}`, line: 0 });
  }

  const { code, strings } = stripCommentsAndStrings(source);
  const declared = declaredNames(code);

  for (const rule of RULES) {
    if (rule.unlessDeclared && declared.has(rule.unlessDeclared)) continue;
    rule.pattern.lastIndex = 0;
    const seenLines = new Set<number>();
    for (const m of code.matchAll(rule.pattern)) {
      const line = lineOf(code, m.index ?? 0);
      if (seenLines.has(line)) continue;
      seenLines.add(line);
      findings.push({ rule: rule.id, severity: rule.severity, message: rule.message, line });
      if (seenLines.size >= 5) break;
    }
  }

  const exportsDecide = /export\s+(function\s+decide\b|(const|let|var)\s+decide\b)|export\s*\{[^}]*\bdecide\b/.test(code);
  const exportsInit = /export\s+(function\s+init\b|(const|let|var)\s+init\b)|export\s*\{[^}]*\binit\b/.test(code);
  if (!exportsDecide) findings.push({ rule: 'export-decide', severity: 'error', message: 'the file must export a decide(state) function', line: 0 });
  if (!exportsInit) findings.push({ rule: 'export-init', severity: 'warning', message: 'the file should export an init(info) function', line: 0 });

  for (const s of strings) {
    if (s.text.length > 2000) {
      findings.push({ rule: 'long-string', severity: 'warning', message: `a ${s.text.length}-character string literal may hide encoded code or data`, line: lineOf(source, s.index) });
    }
  }

  findings.sort((a, b) => (a.severity === b.severity ? a.line - b.line : a.severity === 'error' ? -1 : 1));
  return { ok: !findings.some((f) => f.severity === 'error'), findings };
}

/** Stable 53-bit string hash (cyrb53), hex. Used to tie reviews to exact source text. */
export function sourceHash(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0');
}
