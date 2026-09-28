import { readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { defineConfig, type Plugin } from 'vitest/config';

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<string> {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 10_000) throw new Error('request too large');
  }
  return body;
}

/**
 * Dev-server endpoints for bot reviews. The TypeSafe API key is only ever read
 * here, in Node; the browser just gets review results.
 *   GET  /api/reviews          → { [botFile]: BotReview }
 *   POST /api/review {file}    → BotReview (runs static check + Jev, saves bots/<name>.review.json)
 */
function botReviewApi(): Plugin {
  const running = new Set<string>();
  return {
    name: 'harena-bot-review-api',
    configureServer(server) {
      server.middlewares.use('/api/reviews', async (req, res) => {
        if (req.method !== 'GET') return sendJson(res, 405, { error: 'GET only' });
        const { readAllReviews } = await import('./src/review/node.ts');
        sendJson(res, 200, readAllReviews());
      });
      server.middlewares.use('/api/review', async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'POST only' });
        let file = '';
        try {
          file = String(JSON.parse(await readBody(req)).file ?? '');
        } catch {
          return sendJson(res, 400, { error: 'body must be JSON {"file": "name.js"}' });
        }
        const review = await import('./src/review/node.ts');
        if (!review.isValidBotFile(file)) return sendJson(res, 400, { error: `not a bot file in bots/: ${file}` });
        if (running.has(file)) return sendJson(res, 409, { error: `${file} is already being reviewed` });
        running.add(file);
        try {
          let client = null;
          try {
            client = review.createJevClient();
          } catch (err) {
            return sendJson(res, 500, { error: (err as Error).message });
          }
          sendJson(res, 200, await review.reviewBotFile(file, client));
        } catch (err) {
          sendJson(res, 500, { error: (err as Error).message });
        } finally {
          running.delete(file);
        }
      });
    },
  };
}

/** Ship BOT_API.md with the static build, so the setup page's link works when hosted. */
function botApiDoc(): Plugin {
  return {
    name: 'harena-bot-api-doc',
    apply: 'build',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'BOT_API.md', source: readFileSync('BOT_API.md', 'utf8') });
    },
  };
}

export default defineConfig({
  // Relative asset paths: the build works at a domain root or in a subdirectory.
  base: './',
  plugins: [botReviewApi(), botApiDoc()],
  server: {
    open: false,
    // Review files are read through the API; don't reload the page when one is written.
    watch: { ignored: ['**/bots/*.review.json'] },
  },
  test: {
    include: ['tests/**/*.test.ts'],
  },
});
