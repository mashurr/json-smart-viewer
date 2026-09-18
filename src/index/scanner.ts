// Builds a compact index of a JSON document in one pass, without recursion,
// so very large and very deeply nested files can't exhaust memory or the stack.

import { Kind } from '../protocol';

export { Kind };

export interface IndexData {
    count: number;
    /** Kind of each node */
    kind: Uint8Array;
    /** Offset where each value starts and ends (exclusive) in the text */
    start: Int32Array;
    end: Int32Array;
    /** Offset of the opening quote of the node's key, or -1 when it has none */
    key: Int32Array;
    /** Number of children of containers */
    size: Int32Array;
    /** Where a container's children start in `children` */
    first: Int32Array;
    /** Child node ids, stored contiguously per container in document order */
    children: Int32Array;
}

export interface ScanError {
    /** Where the problem is, or -1 when it has no position */
    offset: number;
    message: string;
}

export interface ScanOptions {
    /** Allow comments and trailing commas */
    jsonc?: boolean;
    /** Called about every 16M characters with the current offset */
    onProgress?: (offset: number) => void;
}

const PROGRESS_STEP = 1 << 24;
const HEX4 = /^[0-9a-fA-F]{4}$/;
const isDigit = (c: number) => c >= 48 && c <= 57;

const enum Ch {
    Tab = 9, LineFeed = 10, CarriageReturn = 13, Space = 32, Quote = 34, Plus = 43, Comma = 44, Minus = 45, Dot = 46,
    Slash = 47, Zero = 48, Nine = 57, Colon = 58, Star = 42, OpenBracket = 91, Backslash = 92, CloseBracket = 93,
    LowerE = 101, OpenBrace = 123, CloseBrace = 125, Bom = 0xfeff,
}

class Grow32 {
    a: Int32Array;
    constructor(n: number) { this.a = new Int32Array(Math.max(16, n)); }
    ensure(n: number) {
        if (n > this.a.length) {
            const b = new Int32Array(Math.max(n, Math.floor(this.a.length * 1.5)));
            b.set(this.a);
            this.a = b;
        }
    }
}

export function scan(text: string, options: ScanOptions = {}): IndexData | ScanError {
    const len = text.length;
    const jsonc = !!options.jsonc;
    let cap = Math.max(16, Math.floor(len / 8));
    let kind = new Uint8Array(cap);
    const start = new Grow32(cap), end = new Grow32(cap), key = new Grow32(cap), size = new Grow32(cap), first = new Grow32(cap);
    const children = new Grow32(cap);
    // Children of every open container, as one stack of contiguous segments
    const pending = new Grow32(1024);
    // Open containers: node id, start of their segment in `pending`, and whether a child was read
    const stackNode = new Grow32(256), stackSeg = new Grow32(256);
    let stackAfter = new Uint8Array(256);
    let count = 0, childLen = 0, pendingLen = 0, sp = 0;
    let pos = 0, nextProgress = PROGRESS_STEP;
    let error: ScanError | undefined;

    const fail = (message: string, at = pos): ScanError => (error = { offset: at, message });

    function newNode(k: Kind, keyAt: number): number {
        if (count === cap) {
            cap = Math.floor(cap * 1.5) + 16;
            const nk = new Uint8Array(cap); nk.set(kind); kind = nk;
            start.ensure(cap); end.ensure(cap); key.ensure(cap); size.ensure(cap); first.ensure(cap);
        }
        kind[count] = k;
        start.a[count] = pos;
        key.a[count] = keyAt;
        if (sp > 0) { pending.ensure(pendingLen + 1); pending.a[pendingLen++] = count; }
        return count++;
    }

    // Skips whitespace, plus comments in JSONC. Returns false on an unterminated comment.
    function skip(): boolean {
        for (;;) {
            const c = text.charCodeAt(pos);
            if (c === Ch.Space || c === Ch.LineFeed || c === Ch.CarriageReturn || c === Ch.Tab) { pos++; continue; }
            if (jsonc && c === Ch.Slash) {
                const n = text.charCodeAt(pos + 1);
                if (n === Ch.Slash) {
                    const e = text.indexOf('\n', pos + 2);
                    pos = e < 0 ? len : e + 1;
                    continue;
                }
                if (n === Ch.Star) {
                    const e = text.indexOf('*/', pos + 2);
                    if (e < 0) { fail('Unterminated comment'); return false; }
                    pos = e + 2;
                    continue;
                }
            }
            return true;
        }
    }

    // Moves past a string whose opening quote is at `pos`, checking escapes and control characters
    function skipString(): boolean {
        const open = pos;
        pos++;
        for (;;) {
            const c = text.charCodeAt(pos);
            if (c === Ch.Quote) { pos++; return true; }
            if (c === Ch.Backslash) {
                const e = text.charCodeAt(pos + 1);
                if (e === 117) {
                    if (!HEX4.test(text.substr(pos + 2, 4))) { fail('Invalid unicode escape'); return false; }
                    pos += 6;
                } else if (e === Ch.Quote || e === Ch.Backslash || e === Ch.Slash || e === 98 || e === 102 || e === 110 || e === 114 || e === 116) {
                    pos += 2;
                } else {
                    fail(pos + 1 >= len ? 'Unterminated string' : 'Invalid escape character', pos + 1 >= len ? open : pos);
                    return false;
                }
                continue;
            }
            if (c < Ch.Space || pos >= len) {
                fail(pos >= len ? 'Unterminated string' : 'Invalid character in string', pos >= len ? open : pos);
                return false;
            }
            pos++;
        }
    }

    // JSON number: -?(0|[1-9][0-9]*)(.[0-9]+)?([eE][+-]?[0-9]+)?
    function skipNumber(): boolean {
        const s = pos;
        const digits = () => { const d = pos; while (isDigit(text.charCodeAt(pos))) { pos++; } return pos > d; };
        if (text.charCodeAt(pos) === Ch.Minus) { pos++; }
        if (text.charCodeAt(pos) === Ch.Zero) { pos++; } else if (!digits()) { fail('Invalid number', s); return false; }
        if (text.charCodeAt(pos) === Ch.Dot) {
            pos++;
            if (!digits()) { fail('Invalid number', s); return false; }
        }
        if ((text.charCodeAt(pos) | 32) === Ch.LowerE) {
            pos++;
            const c = text.charCodeAt(pos);
            if (c === Ch.Plus || c === Ch.Minus) { pos++; }
            if (!digits()) { fail('Invalid number', s); return false; }
        }
        return true;
    }

    function literal(word: string, k: Kind, keyAt: number): boolean {
        if (!text.startsWith(word, pos)) { fail('Unexpected character'); return false; }
        const id = newNode(k, keyAt);
        pos += word.length;
        end.a[id] = pos;
        return true;
    }

    // Reads one value at `pos`. Containers are opened and finished by the main loop.
    function value(keyAt: number): boolean {
        const c = text.charCodeAt(pos);
        if (c === Ch.OpenBrace || c === Ch.OpenBracket) {
            const id = newNode(c === Ch.OpenBrace ? Kind.Object : Kind.Array, keyAt);
            pos++;
            stackNode.ensure(sp + 1); stackSeg.ensure(sp + 1);
            if (sp + 1 > stackAfter.length) { const a = new Uint8Array(stackAfter.length * 2); a.set(stackAfter); stackAfter = a; }
            stackNode.a[sp] = id; stackSeg.a[sp] = pendingLen; stackAfter[sp] = 0; sp++;
            return true;
        }
        if (c === Ch.Quote) {
            const id = newNode(Kind.String, keyAt);
            if (!skipString()) { return false; }
            end.a[id] = pos;
            return true;
        }
        if (c === Ch.Minus || (c >= Ch.Zero && c <= Ch.Nine)) {
            const id = newNode(Kind.Number, keyAt);
            if (!skipNumber()) { return false; }
            end.a[id] = pos;
            return true;
        }
        if (c === 116) { return literal('true', Kind.True, keyAt); }
        if (c === 102) { return literal('false', Kind.False, keyAt); }
        if (c === 110) { return literal('null', Kind.Null, keyAt); }
        fail(pos >= len ? 'Unexpected end of file' : 'Expected a value');
        return false;
    }

    function close() {
        const id = stackNode.a[--sp], seg = stackSeg.a[sp], n = pendingLen - seg;
        pos++;
        end.a[id] = pos;
        children.ensure(childLen + n);
        children.a.set(pending.a.subarray(seg, pendingLen), childLen);
        first.a[id] = childLen;
        size.a[id] = n;
        childLen += n;
        pendingLen = seg;
    }

    if (text.charCodeAt(0) === Ch.Bom) { pos = 1; }
    if (!skip()) { return error!; }
    if (pos >= len) { return { offset: -1, message: 'The file is empty' }; }
    if (!value(-1)) { return error!; }

    while (sp > 0) {
        if (pos >= nextProgress) { options.onProgress?.(pos); nextProgress = pos + PROGRESS_STEP; }
        if (!skip()) { return error!; }
        const top = sp - 1, isObject = kind[stackNode.a[top]] === Kind.Object;
        const closeCh = isObject ? Ch.CloseBrace : Ch.CloseBracket;
        let c = text.charCodeAt(pos);
        if (stackAfter[top]) {
            if (c === closeCh) { close(); continue; }
            if (c !== Ch.Comma) { return fail(pos >= len ? 'Unexpected end of file' : isObject ? "Expected ',' or '}'" : "Expected ',' or ']'"); }
            pos++;
            if (!skip()) { return error!; }
            c = text.charCodeAt(pos);
            if (c === closeCh) {
                if (jsonc) { close(); continue; }
                return fail('Trailing comma');
            }
        } else if (c === closeCh) {
            close();
            continue;
        }
        stackAfter[top] = 1;
        let keyAt = -1;
        if (isObject) {
            if (c !== Ch.Quote) { return fail(pos >= len ? 'Unexpected end of file' : 'Expected a property name'); }
            keyAt = pos;
            if (!skipString() || !skip()) { return error!; }
            if (text.charCodeAt(pos) !== Ch.Colon) { return fail("Expected ':'"); }
            pos++;
            if (!skip()) { return error!; }
        }
        if (!value(keyAt)) { return error!; }
    }

    if (!skip()) { return error!; }
    if (pos < len) { return { offset: pos, message: 'Unexpected content after the end of the JSON value' }; }

    return {
        count,
        kind: kind.slice(0, count),
        start: start.a.slice(0, count),
        end: end.a.slice(0, count),
        key: key.a.slice(0, count),
        size: size.a.slice(0, count),
        first: first.a.slice(0, count),
        children: children.a.slice(0, childLen),
    };
}

export function isScanError(r: IndexData | ScanError): r is ScanError {
    return (r as ScanError).message !== undefined;
}
