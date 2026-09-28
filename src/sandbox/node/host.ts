import { Worker } from 'node:worker_threads';
import type { FromWorker, ToWorker } from '../protocol.ts';
import type { WorkerLike } from '../../match/supervisor.ts';

/**
 * Spawn a bot in a Node worker thread with a memory cap. `script` defaults to the worker entry
 * next to this file; the single-file test kit passes its own file (and `workerData` to tell
 * the copy it is a worker).
 */
export function createNodeWorker(script: URL | string = new URL('./botWorker.ts', import.meta.url), workerData?: unknown): WorkerLike {
  const worker = new Worker(script, {
    workerData,
    resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32 },
  });
  let dead = false;
  const errorListeners: Array<(err: string) => void> = [];
  worker.on('error', (err) => errorListeners.forEach((cb) => cb(String(err))));
  worker.on('exit', (code) => {
    if (!dead) errorListeners.forEach((cb) => cb(`worker exited with code ${code}`));
  });
  return {
    post: (msg: ToWorker) => worker.postMessage(msg),
    onMessage: (cb) => worker.on('message', (msg: FromWorker) => cb(msg)),
    onError: (cb) => errorListeners.push(cb),
    terminate: () => {
      dead = true;
      void worker.terminate();
    },
  };
}
