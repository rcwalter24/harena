import { parentPort } from 'node:worker_threads';
import { runBotWorker } from './workerMain.ts';

runBotWorker(parentPort!);
