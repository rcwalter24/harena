import { Worker } from 'node:worker_threads';
import type { FromWorker, ToWorker } from '../protocol.ts';
import type { WorkerLike } from '../../match/supervisor.ts';

/** Spawn a bot in a Node worker thread with a memory cap. */
export function createNodeWorker(): WorkerLike {
  const worker = new Worker(new URL('./botWorker.ts', import.meta.url), {
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
