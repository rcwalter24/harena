import type { FromWorker, ToWorker } from '../protocol.ts';
import type { WorkerLike } from '../../match/supervisor.ts';

/** Spawn a bot in a dedicated module Web Worker. */
export function createBrowserWorker(): WorkerLike {
  const worker = new Worker(new URL('./botWorker.ts', import.meta.url), { type: 'module' });
  return {
    post: (msg: ToWorker) => worker.postMessage(msg),
    onMessage: (cb) => worker.addEventListener('message', (e: MessageEvent<FromWorker>) => cb(e.data)),
    onError: (cb) => worker.addEventListener('error', (e) => {
      e.preventDefault();
      cb(e.message || 'worker error');
    }),
    terminate: () => worker.terminate(),
  };
}
