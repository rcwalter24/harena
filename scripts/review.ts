// Review bots: static check + Jev AI review. Results are saved as bots/<name>.review.json.
//
//   node scripts/review.ts                 review new or changed bots
//   node scripts/review.ts gunner.js       review specific bots (always re-reviews them)
//   node scripts/review.ts --all           re-review every bot
//   node scripts/review.ts --static-only   skip Jev (no network, no API key needed)

import { createJevClient, isReviewCurrent, isValidBotFile, listBotFiles, reviewBotFile } from '../src/review/node.ts';
import type { JevClient } from '../src/review/jev.ts';

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const named = args.filter((a) => !a.startsWith('--')).map((a) => a.replace(/^.*[\\/]/, ''));

for (const file of named) {
  if (!isValidBotFile(file)) {
    console.error(`Not a bot in bots/: ${file}`);
    process.exit(2);
  }
}

const targets = named.length > 0
  ? named
  : listBotFiles().filter((f) => flags.has('--all') || !isReviewCurrent(f));

if (targets.length === 0) {
  console.log('All bots already have up-to-date reviews. Use --all to re-review.');
  process.exit(0);
}

let client: JevClient | null = null;
if (!flags.has('--static-only')) {
  try {
    client = createJevClient();
  } catch (err) {
    console.error(`${(err as Error).message}\nRe-run with --static-only to skip the Jev review.`);
    process.exit(2);
  }
}

const ICON: Record<string, string> = { pass: '✔ pass', warn: '⚠ warn', danger: '✖ danger', blocked: '⛔ blocked', error: '? error' };
let worst = 0;
for (const file of targets) {
  const review = await reviewBotFile(file, client);
  const warnings = review.static.findings.filter((f) => f.severity === 'warning');
  console.log(`\n${file}: ${ICON[review.verdict]}`);
  for (const r of review.reasons) console.log(`  - ${r}`);
  for (const w of warnings) console.log(`  - static warning: ${w.message}${w.line ? ` (line ${w.line})` : ''}`);
  if (review.jev && !('error' in review.jev)) {
    const q = review.jev.quality;
    console.log(`  quality ${q.score.toFixed(2)}/${q.max} · interface: ${review.jev.conformance.choice} · ${review.jev.inputTokens} tokens · ${review.jev.model}`);
  }
  worst = Math.max(worst, review.verdict === 'blocked' ? 1 : 0);
}
process.exit(worst);
