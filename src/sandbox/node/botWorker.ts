import { parentPort } from 'node:worker_threads';
import { COMMON_BLOCKED_GLOBALS, createHarness, neuterGlobals } from '../harness.ts';
import type { ToWorker } from '../protocol.ts';

// Capture everything the harness needs before hiding globals from the bot.
const port = parentPort!;
const NodeBuffer = Buffer;
const toBase64 = (text: string) => NodeBuffer.from(text, 'utf8').toString('base64');
const now = performance.now.bind(performance);

const handle = createHarness({
  post: (msg) => port.postMessage(msg),
  now,
  // A data: URL module cannot resolve relative imports, so a bot is one self-contained file.
  loadModule: (source) => import(`data:text/javascript;base64,${toBase64(source)}`),
});

port.on('message', (msg: ToWorker) => {
  void handle(msg);
});

neuterGlobals([...COMMON_BLOCKED_GLOBALS, 'process', 'require', 'Buffer', 'global']);
