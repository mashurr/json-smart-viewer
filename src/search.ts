// Finds keys and values containing a query, in slices, so a search over hundreds of
// megabytes never blocks the extension host and a newer query can cancel it.

import { Kind } from './protocol';
import { JsonIndex, stringEnd } from './index/query';

/** Most matches kept; the count stops there too */
export const MAX_MATCHES = 100_000;
// Text searched per slice, and how long a slice may run before yielding
const SLICE_CHARS = 2 << 20;
const SLICE_MS = 8;

export interface SearchBatch {
    /** Node ids of new matches, in document order */
    ids: number[];
    total: number;
    capped: boolean;
    done: boolean;
}

// Short escapes JSON allows besides \uXXXX
const SHORT_ESCAPES: Record<string, string> = { '"': '\\"', '\\': '\\\\', '/': '\\/', '\b': '\\b', '\f': '\\f', '\n': '\\n', '\r': '\\r', '\t': '\\t' };
const reEscape = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
const unicodeEscape = (c: string) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0');

/**
 * A case-insensitive regular expression for the query as it may appear in raw JSON text.
 * Each character may be written as itself or as a JSON escape (\" \/ \n … or \uXXXX in any case),
 * so a file that escapes non-ASCII characters still matches.
 */
export function queryPattern(query: string): RegExp {
    let source = '';
    // Code units, not code points: a surrogate pair may be written as two \u escapes
    for (let i = 0; i < query.length; i++) {
        const c = query[i];
        const forms = new Set<string>();
        for (const v of new Set([c, c.toLowerCase(), c.toUpperCase()])) {
            if (v.length !== 1) { continue; }
            const code = v.charCodeAt(0);
            if (code >= 0x20 && v !== '"' && v !== '\\') { forms.add(reEscape(v)); }
            // Escapes are matched as literal text (a backslash and letters), so they're regex-escaped too
            if (SHORT_ESCAPES[v]) { forms.add(reEscape(SHORT_ESCAPES[v])); }
            if (code > 0x7e || code < 0x20 || SHORT_ESCAPES[v]) { forms.add(reEscape(unicodeEscape(v))); }
        }
        source += forms.size === 1 ? [...forms][0] : `(?:${[...forms].join('|')})`;
    }
    return new RegExp(source, 'gi');
}

export class Searcher {
    private run = 0;

    cancel() { this.run++; }

    /** Streams matches through `onBatch`; stops early if `cancel()` or another `search()` is called */
    async search(ix: JsonIndex, query: string, onBatch: (b: SearchBatch) => void): Promise<void> {
        const run = ++this.run;
        const text = ix.text;
        const pattern = queryPattern(query);
        let total = 0, last = -1, pending: number[] = [];
        const flush = (done: boolean, capped: boolean) => {
            onBatch({ ids: pending, total, capped, done });
            pending = [];
        };
        let sliceStart = 0;
        while (sliceStart < text.length) {
            const began = Date.now();
            // Work through slices until this turn's time is used up
            while (sliceStart < text.length && Date.now() - began < SLICE_MS) {
                const sliceEnd = Math.min(text.length, sliceStart + SLICE_CHARS);
                // Overlap slices so a match across the boundary is found, but only count matches starting inside
                const piece = text.slice(sliceStart, Math.min(text.length, sliceEnd + 64 + query.length * 6));
                pattern.lastIndex = 0;
                for (let m = pattern.exec(piece); m; m = pattern.exec(piece)) {
                    const at = sliceStart + m.index;
                    if (at >= sliceEnd) { break; }
                    const id = matchNode(ix, at, at + m[0].length);
                    if (id >= 0 && id !== last) {
                        last = id;
                        pending.push(id);
                        if (++total >= MAX_MATCHES) { flush(true, true); return; }
                    }
                    if (m[0].length === 0) { pattern.lastIndex++; }
                }
                sliceStart = sliceEnd;
            }
            if (pending.length) { flush(false, false); }
            await new Promise(resolve => setImmediate(resolve));
            if (run !== this.run) { return; }
        }
        flush(true, false);
    }
}

/** The node whose key or value holds text [start, end), or -1 when the text spans JSON structure */
export function matchNode(ix: JsonIndex, start: number, end: number): number {
    const { id } = ix.pathAt(start);
    const d = ix.data, key = d.key[id];
    if (key >= 0 && start > key && end < stringEnd(ix.text, key)) { return id; }
    const kind = d.kind[id];
    if (kind === Kind.Object || kind === Kind.Array) { return -1; }
    const s = d.start[id], e = d.end[id];
    if (kind === Kind.String) { return start > s && end < e ? id : -1; }
    return start >= s && end <= e ? id : -1;
}
