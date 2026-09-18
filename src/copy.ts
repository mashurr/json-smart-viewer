// Text for the copy actions: paths in two notations, and values re-indented from the source text

import { PathStep } from './protocol';

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

/** JavaScript-style path, e.g. `orders[12].total` or `["a.b"][0]`; `$` for the root */
export function accessorPath(steps: readonly PathStep[]): string {
    let s = '';
    for (const { key } of steps) {
        if (typeof key === 'number') { s += `[${key}]`; }
        else if (IDENTIFIER.test(key)) { s += (s ? '.' : '') + key; }
        else { s += `[${JSON.stringify(key)}]`; }
    }
    return s || '$';
}

/** JSON Pointer (RFC 6901), e.g. `/orders/12/total`; empty for the root */
export function jsonPointer(steps: readonly PathStep[]): string {
    return steps.map(({ key }) => '/' + String(key).replace(/~/g, '~0').replace(/\//g, '~1')).join('');
}

/**
 * Re-indents the JSON between `start` and `end` with two spaces, copying strings and numbers
 * exactly as written (so big integers and 1e400 survive) and dropping comments. Never recurses.
 */
export function formatJson(text: string, start: number, end: number): string {
    const out: string[] = [];
    let depth = 0;
    const newline = () => '\n' + '  '.repeat(depth);
    let i = start;
    const nextSignificant = (from: number): number => {
        let j = from;
        for (;;) {
            const c = text.charCodeAt(j);
            if (c === 32 || c === 10 || c === 13 || c === 9) { j++; continue; }
            if (c === 47 && text.charCodeAt(j + 1) === 47) { const e = text.indexOf('\n', j); j = e < 0 ? end : e + 1; continue; }
            if (c === 47 && text.charCodeAt(j + 1) === 42) { const e = text.indexOf('*/', j + 2); j = e < 0 ? end : e + 2; continue; }
            return j;
        }
    };
    while (i < end) {
        i = nextSignificant(i);
        if (i >= end) { break; }
        const c = text[i];
        if (c === '"') {
            let j = i + 1;
            for (;;) {
                const q = text.indexOf('"', j);
                if (q < 0) { j = end; break; }
                let b = q - 1, slashes = 0;
                while (b > i && text.charCodeAt(b) === 92) { slashes++; b--; }
                j = q + 1;
                if ((slashes & 1) === 0) { break; }
            }
            out.push(text.slice(i, j));
            i = j;
        } else if (c === '{' || c === '[') {
            const close = c === '{' ? '}' : ']';
            const n = nextSignificant(i + 1);
            if (text[n] === close) {
                out.push(c + close);
                i = n + 1;
            } else {
                depth++;
                out.push(c + newline());
                i++;
            }
        } else if (c === '}' || c === ']') {
            depth--;
            out.push(newline() + c);
            i++;
        } else if (c === ',') {
            // A trailing comma (JSONC) before a closing bracket is dropped
            const n = nextSignificant(i + 1);
            if (text[n] !== '}' && text[n] !== ']') { out.push(',' + newline()); }
            i++;
        } else if (c === ':') {
            out.push(': ');
            i++;
        } else {
            // Numbers and literals, as written
            let j = i;
            while (j < end && !' \n\r\t,:]}/'.includes(text[j])) { j++; }
            out.push(text.slice(i, j));
            i = j;
        }
    }
    return out.join('');
}
