/**
 * Pure helpers for bots pasted into the browser (no DOM, no storage), so they can be
 * unit-tested.
 */

/**
 * The bot code inside a pasted AI reply. Chat assistants wrap code in Markdown fences and
 * add prose around it; take the longest fenced block, or the whole text when there is none.
 */
export function extractBotCode(text: string): string {
  const blocks = [...text.matchAll(/```[\w-]*[^\S\n]*\n([\s\S]*?)```/g)].map((m) => m[1]);
  if (blocks.length === 0) return text.trim();
  return blocks.reduce((a, b) => (b.length > a.length ? b : a)).trim();
}

/** Id for a bot saved in the browser: `my/<slug>.js`, unique among `taken`. */
export function localBotId(name: string, taken: ReadonlySet<string>): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'bot';
  let id = `my/${slug}.js`;
  for (let n = 2; taken.has(id); n++) id = `my/${slug}-${n}.js`;
  return id;
}

/** Text to paste back into the AI chat when the static check rejects its bot. */
export function fixRequest(errors: string[]): string {
  return [
    'Harena rejected this bot before running it:',
    ...errors.map((e) => `- ${e}`),
    '',
    'Please fix these problems and reply with the complete corrected file in a single ```js code block.',
  ].join('\n');
}
