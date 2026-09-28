/// <reference lib="webworker" />
import { COMMON_BLOCKED_GLOBALS, createHarness, neuterGlobals } from '../harness.ts';
import type { FromWorker, ToWorker } from '../protocol.ts';

// Capture everything the harness needs before hiding globals from the bot.
const scope = self as unknown as DedicatedWorkerGlobalScope;
const post = scope.postMessage.bind(scope);
const createObjectURL = URL.createObjectURL.bind(URL);
const revokeObjectURL = URL.revokeObjectURL.bind(URL);
const now = performance.now.bind(performance);

// In dev, Vite's HMR client runs inside the worker too; keep its chatter out of the bot log.
const isDevNoise = (msg: FromWorker) => import.meta.env.DEV && msg.type === 'log' && msg.text.startsWith('[vite]');

const handle = createHarness({
  post: (msg) => {
    if (!isDevNoise(msg)) post(msg);
  },
  now,
  async loadModule(source) {
    const url = createObjectURL(new Blob([source], { type: 'text/javascript' }));
    try {
      return await import(/* @vite-ignore */ url);
    } finally {
      revokeObjectURL(url);
    }
  },
});

scope.addEventListener('message', (e: MessageEvent<ToWorker>) => {
  void handle(e.data);
});

neuterGlobals([...COMMON_BLOCKED_GLOBALS, 'importScripts', 'postMessage', 'close']);
post({ type: 'booted' } satisfies FromWorker);
