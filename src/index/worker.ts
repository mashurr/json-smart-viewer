// Worker thread that builds the index off the extension host's main thread
import { parentPort } from 'worker_threads';
import { scan, isScanError } from './scanner';

/** Either the text, or the file's bytes (transferred, so the host never copies a big string) */
export interface WorkerRequest { text?: string; bytes?: Uint8Array; jsonc: boolean }

parentPort!.once('message', ({ text, bytes, jsonc }: WorkerRequest) => {
    // Decoded exactly like the host decodes its own copy, so offsets agree
    text ??= new TextDecoder('utf-8', { ignoreBOM: false }).decode(bytes);
    const result = scan(text, { jsonc, onProgress: offset => parentPort!.postMessage({ type: 'progress', offset }) });
    if (isScanError(result)) {
        parentPort!.postMessage({ type: 'error', error: result });
        return;
    }
    const buffers = [result.kind, result.start, result.end, result.key, result.size, result.first, result.children].map(a => a.buffer as ArrayBuffer);
    parentPort!.postMessage({ type: 'done', data: result }, buffers);
});
