// Worker thread that builds the index off the extension host's main thread
import { parentPort } from 'worker_threads';
import { scan, isScanError } from './scanner';

export interface WorkerRequest { text: string; jsonc: boolean }

parentPort!.once('message', ({ text, jsonc }: WorkerRequest) => {
    const result = scan(text, { jsonc, onProgress: offset => parentPort!.postMessage({ type: 'progress', offset }) });
    if (isScanError(result)) {
        parentPort!.postMessage({ type: 'error', error: result });
        return;
    }
    const buffers = [result.kind, result.start, result.end, result.key, result.size, result.first, result.children].map(a => a.buffer as ArrayBuffer);
    parentPort!.postMessage({ type: 'done', data: result }, buffers);
});
