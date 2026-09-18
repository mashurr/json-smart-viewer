// Read access to an indexed document: rows for the viewer, keys and previews.
// Values are decoded from the source text only when asked for.

import { Kind, PathStep, PREVIEW_CHARS, Row } from '../protocol';
import { IndexData } from './scanner';

// Raw characters read for a string preview; escapes can make the source longer than the text
const RAW_PREVIEW = PREVIEW_CHARS * 6 + 16;

export class JsonIndex {
    constructor(readonly text: string, readonly data: IndexData, readonly version: number) {}

    get root(): number { return 0; }

    kind(id: number): Kind { return this.data.kind[id]; }
    start(id: number): number { return this.data.start[id]; }
    end(id: number): number { return this.data.end[id]; }
    size(id: number): number { return this.data.size[id]; }

    child(id: number, index: number): number {
        return this.data.children[this.data.first[id] + index];
    }

    /** The decoded property name of a node inside an object */
    keyOf(id: number): string {
        const at = this.data.key[id];
        return JSON.parse(this.text.slice(at, stringEnd(this.text, at)));
    }

    row(id: number, key?: string | number): Row {
        const kind = this.data.kind[id];
        const row: Row = { id, kind };
        if (key !== undefined) { row.key = key; }
        if (kind === Kind.Object || kind === Kind.Array) {
            row.size = this.data.size[id];
        } else if (kind === Kind.String) {
            const s = this.data.start[id], e = this.data.end[id];
            Object.assign(row, stringPreview(this.text, s, e));
            // Looks like a stringified object or array ("{…}" or "[…]"); decoding tells for sure
            const a = this.text.charCodeAt(s + 1), z = this.text.charCodeAt(e - 2);
            if (e - s > 3 && ((a === 123 && z === 125) || (a === 91 && z === 93))) { row.json = true; }
        } else if (kind === Kind.Error) {
            row.text = `Line ${this.data.size[id].toLocaleString()}: ${this.data.errors[this.data.first[id]]}`;
        } else if (kind === Kind.Number) {
            const s = this.data.start[id], e = this.data.end[id];
            row.text = this.text.slice(s, Math.min(e, s + PREVIEW_CHARS));
            if (e - s > PREVIEW_CHARS) { row.truncated = true; }
        }
        return row;
    }

    /** Where a node's selection starts in the text: its key if it has one, else its value */
    hitStart(id: number): number {
        const k = this.data.key[id];
        return k >= 0 ? k : this.data.start[id];
    }

    /**
     * The deepest node whose key or value contains `offset`, with the path to it.
     * Walks down from the root with a binary search per level, so it never recurses.
     */
    pathAt(offset: number): { id: number; path: PathStep[] } {
        let id = this.root;
        const path: PathStep[] = [];
        for (;;) {
            const kind = this.data.kind[id], n = this.data.size[id];
            if ((kind !== Kind.Object && kind !== Kind.Array) || n === 0) { break; }
            let lo = 0, hi = n - 1, found = -1;
            while (lo <= hi) {
                const mid = (lo + hi) >> 1;
                if (this.hitStart(this.child(id, mid)) <= offset) { found = mid; lo = mid + 1; } else { hi = mid - 1; }
            }
            if (found < 0) { break; }
            const c = this.child(id, found);
            if (offset >= this.data.end[c]) { break; }
            path.push({ key: kind === Kind.Array ? found : this.keyOf(c), index: found });
            id = c;
        }
        return { id, path };
    }

    /** Rows for children `start` to `start + count` of a container */
    rows(id: number, start: number, count: number): Row[] {
        const inArray = this.data.kind[id] === Kind.Array;
        const end = Math.min(this.data.size[id], start + count), out: Row[] = [];
        for (let i = Math.max(0, start); i < end; i++) {
            const c = this.child(id, i);
            out.push(this.row(c, inArray ? i : this.keyOf(c)));
        }
        return out;
    }
}

/** Offset just past the closing quote of the string whose opening quote is at `open` */
export function stringEnd(text: string, open: number): number {
    let from = open + 1;
    for (;;) {
        const q = text.indexOf('"', from);
        if (q < 0) { return text.length; }
        let b = q - 1, slashes = 0;
        while (b > open && text.charCodeAt(b) === 92) { slashes++; b--; }
        if ((slashes & 1) === 0) { return q + 1; }
        from = q + 1;
    }
}

/** Decodes at most PREVIEW_CHARS characters of a string value without reading all of it */
export function stringPreview(text: string, start: number, end: number): { text: string; truncated?: true } {
    if (end - start <= RAW_PREVIEW) {
        const full: string = JSON.parse(text.slice(start, end));
        return full.length > PREVIEW_CHARS ? { text: full.slice(0, PREVIEW_CHARS), truncated: true } : { text: full };
    }
    let raw = text.slice(start + 1, start + RAW_PREVIEW);
    // Don't cut an escape sequence in half
    const tail = /\\(u[0-9a-fA-F]{0,3})?$/.exec(raw);
    if (tail) {
        let slashes = 0;
        for (let i = tail.index; i >= 0 && raw.charCodeAt(i) === 92; i--) { slashes++; }
        if (slashes % 2 === 1) { raw = raw.slice(0, tail.index); }
    }
    return { text: (JSON.parse('"' + raw + '"') as string).slice(0, PREVIEW_CHARS), truncated: true };
}
