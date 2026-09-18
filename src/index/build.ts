// Builds an index for a document text, in a worker thread for anything but small files
import * as path from 'path';
import { Worker } from 'worker_threads';
import { IndexData, ScanError, scan } from './scanner';

// Below this size a worker costs more to start than the scan takes
const IN_PROCESS_CHARS = 1 << 20;

export interface Build {
    result: Promise<IndexData | ScanError>;
    /** Stops the build; `result` then never settles */
    cancel(): void;
}

/** `bytes`, when given, is the file `text` was decoded from; the worker gets it instead of a copy of the text */
export function buildIndex(extensionPath: string, text: string, jsonc: boolean, onProgress: (offset: number) => void, bytes?: Uint8Array): Build {
    if (text.length < IN_PROCESS_CHARS) {
        let cancelled = false;
        return {
            result: new Promise(resolve => setImmediate(() => { if (!cancelled) { resolve(scan(text, { jsonc })); } })),
            cancel: () => { cancelled = true; },
        };
    }
    const worker = new Worker(path.join(extensionPath, 'out', 'indexWorker.js'));
    const result = new Promise<IndexData | ScanError>((resolve, reject) => {
        worker.on('message', m => {
            if (m.type === 'progress') { onProgress(m.offset); return; }
            resolve(m.type === 'done' ? m.data : m.error);
            void worker.terminate();
        });
        worker.on('error', reject);
    });
    if (bytes) {
        // Hand over our own copy: VS Code's buffer may still be in use, and copying bytes is much cheaper than copying the text
        const own = bytes.slice();
        worker.postMessage({ bytes: own, jsonc }, [own.buffer]);
    } else {
        worker.postMessage({ text, jsonc });
    }
    return { result, cancel: () => { void worker.terminate(); } };
}
