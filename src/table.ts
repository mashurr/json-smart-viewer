// Table view data: which containers read as tables, their columns, rows of cells, and sorting.
// Three shapes qualify: arrays of objects, objects whose values are objects (the key becomes
// the first column), and arrays mixing objects with other values (those go in a "value" column).

import * as path from 'path';
import { Worker } from 'worker_threads';
import { Kind, TableCell, TableColumn, TableInfo, TableRow } from './protocol';
import { JsonIndex, stringEnd } from './index/query';
import { accessorPath, jsonPointer } from './copy';

// Children checked to decide whether a container is a table
const SHAPE_SAMPLE = 20;
// Rows whose keys make up the columns, and the most columns shown
const COLUMN_SAMPLE = 500;
export const MAX_COLUMNS = 200;
// Tables offered in the list
const MAX_TABLES = 200;
// Time a chunk of work may take before yielding to the extension host
const CHUNK_MS = 8;

const isContainer = (k: Kind) => k === Kind.Object || k === Kind.Array;
const yieldNow = () => new Promise(resolve => setImmediate(resolve));

type Shape = TableInfo['shape'];

/** Whether a container reads as a table, judged from its first children */
export function tableShape(ix: JsonIndex, id: number): Shape | undefined {
    const kind = ix.kind(id), n = Math.min(ix.size(id), SHAPE_SAMPLE);
    if (!isContainer(kind) || n === 0) { return undefined; }
    let objects = 0;
    for (let i = 0; i < n; i++) { if (ix.kind(ix.child(id, i)) === Kind.Object) { objects++; } }
    if (kind === Kind.Object) { return objects === n ? 'map' : undefined; }
    if (objects === n) { return 'rows'; }
    return objects > 0 ? 'mixed' : undefined;
}

export function tableInfo(ix: JsonIndex, id: number, shape: Shape): TableInfo {
    const steps = ix.pathAt(ix.hitStart(id)).path;
    return { id, shape, rows: ix.size(id), path: accessorPath(steps), pointer: jsonPointer(steps) };
}

/** Tables in the document, biggest first */
export async function findTables(ix: JsonIndex, isCurrent: () => boolean): Promise<TableInfo[] | undefined> {
    const found: { id: number; shape: Shape }[] = [];
    const count = ix.data.count;
    let began = Date.now();
    for (let id = 0; id < count; id++) {
        if (ix.data.size[id] > 1 || (id === 0 && ix.data.size[id] > 0)) {
            const shape = tableShape(ix, id);
            if (shape) { found.push({ id, shape }); }
        }
        if ((id & 0xffff) === 0 && Date.now() - began > CHUNK_MS) {
            await yieldNow();
            if (!isCurrent()) { return undefined; }
            began = Date.now();
        }
    }
    found.sort((a, b) => ix.size(b.id) - ix.size(a.id) || a.id - b.id);
    return found.slice(0, MAX_TABLES).map(t => tableInfo(ix, t.id, t.shape));
}

/** The node a JSON Pointer names, or -1 */
export function nodeByPointer(ix: JsonIndex, pointer: string): number {
    let id = ix.root;
    if (!pointer) { return id; }
    for (const raw of pointer.split('/').slice(1)) {
        const seg = raw.replace(/~1/g, '/').replace(/~0/g, '~');
        const kind = ix.kind(id), n = ix.size(id);
        if (kind === Kind.Array) {
            const i = Number(seg);
            if (!/^\d+$/.test(seg) || i >= n) { return -1; }
            id = ix.child(id, i);
        } else if (kind === Kind.Object) {
            let found = -1;
            for (let i = 0; i < n && found < 0; i++) { if (ix.keyOf(ix.child(id, i)) === seg) { found = ix.child(id, i); } }
            if (found < 0) { return -1; }
            id = found;
        } else {
            return -1;
        }
    }
    return id;
}

/** Columns from the keys of the first rows, in the order they first appear */
export function tableColumns(ix: JsonIndex, id: number, shape: Shape): { columns: TableColumn[]; more: number } {
    const keys = new Map<string, true>();
    let other = false;
    const n = Math.min(ix.size(id), COLUMN_SAMPLE);
    for (let i = 0; i < n; i++) {
        const row = ix.child(id, i);
        if (ix.kind(row) !== Kind.Object) { other = true; continue; }
        for (let j = 0; j < ix.size(row); j++) { keys.set(ix.keyOf(ix.child(row, j)), true); }
    }
    const all: TableColumn[] = [...keys.keys()].map(key => ({ label: key, key }));
    const columns = all.slice(0, MAX_COLUMNS);
    if (shape === 'map') { columns.unshift({ label: 'key', special: 'key' }); }
    if (shape === 'mixed' && other) { columns.push({ label: 'value', special: 'value' }); }
    return { columns, more: all.length - Math.min(all.length, MAX_COLUMNS) };
}

/** The child of object `row` whose key is `key`; `raw` is the key as JSON.stringify writes it */
function field(ix: JsonIndex, row: number, key: string, raw: string): number {
    const text = ix.text, n = ix.size(row);
    for (let j = 0; j < n; j++) {
        const c = ix.child(row, j), at = ix.data.key[c];
        if (text.startsWith(raw, at)) { return c; }
        // Keys written with other escapes (\u00e9, \/) than JSON.stringify uses
        const end = stringEnd(text, at);
        if (text.slice(at, end).includes('\\') && ix.keyOf(c) === key) { return c; }
    }
    return -1;
}

/** The node shown in a cell, or -1 when the row has nothing for that column */
function cellNode(ix: JsonIndex, table: number, shape: Shape, index: number, column: TableColumn, raw: string): number {
    const row = ix.child(table, index);
    if (column.special === 'value') { return ix.kind(row) === Kind.Object ? -1 : row; }
    if (ix.kind(row) !== Kind.Object || column.key === undefined) { return -1; }
    return field(ix, row, column.key, raw);
}

function cell(ix: JsonIndex, id: number): TableCell {
    const { key: _key, ...row } = ix.row(id);
    return row;
}

export function tableRows(ix: JsonIndex, id: number, shape: Shape, columns: TableColumn[], order: Int32Array | undefined, start: number, count: number): TableRow[] {
    const raws = columns.map(c => c.key === undefined ? '' : JSON.stringify(c.key));
    const out: TableRow[] = [];
    const end = Math.min(ix.size(id), start + count);
    for (let r = start; r < end; r++) {
        const index = order ? order[r] : r;
        const child = ix.child(id, index);
        const cells = columns.map((col, i) => {
            if (col.special === 'key') { return { id: child, kind: Kind.String, text: ix.keyOf(child) } as TableCell; }
            const c = cellNode(ix, id, shape, index, col, raws[i]);
            return c < 0 ? null : cell(ix, c);
        });
        out.push({ index, id: child, cells });
    }
    return out;
}

// Sort order of kinds: numbers, strings, booleans, null, objects/arrays, then missing
const RANK: Record<number, number> = { [Kind.Number]: 0, [Kind.String]: 1, [Kind.True]: 2, [Kind.False]: 2, [Kind.Null]: 3, [Kind.Object]: 4, [Kind.Array]: 4 };
const MISSING = 5;

/** Strings travel as one joined string with end offsets: one copy instead of a million */
export interface SortKeys { rank: Uint8Array; num: Float64Array; text: string; ends: Int32Array }

/** Sort keys for every row, read in chunks so the extension host stays responsive */
export async function sortKeys(ix: JsonIndex, id: number, shape: Shape, column: TableColumn, isCurrent: () => boolean): Promise<SortKeys | undefined> {
    const n = ix.size(id), raw = column.key === undefined ? '' : JSON.stringify(column.key);
    const rank = new Uint8Array(n), num = new Float64Array(n), str: string[] = new Array(n).fill('');
    let began = Date.now();
    for (let i = 0; i < n; i++) {
        let c: number;
        if (column.special === 'key') {
            rank[i] = RANK[Kind.String];
            str[i] = ix.keyOf(ix.child(id, i));
        } else if ((c = cellNode(ix, id, shape, i, column, raw)) < 0) {
            rank[i] = MISSING;
        } else {
            const kind = ix.kind(c);
            rank[i] = RANK[kind];
            if (kind === Kind.Number) { num[i] = Number(ix.text.slice(ix.start(c), ix.end(c))); }
            else if (kind === Kind.String) { str[i] = JSON.parse(ix.text.slice(ix.start(c), ix.end(c))); }
            else if (kind === Kind.True) { num[i] = 1; }
            else if (isContainer(kind)) { num[i] = ix.size(c); }
        }
        if ((i & 0x3ff) === 0 && Date.now() - began > CHUNK_MS) {
            await yieldNow();
            if (!isCurrent()) { return undefined; }
            began = Date.now();
        }
    }
    const ends = new Int32Array(n);
    let at = 0;
    for (let i = 0; i < n; i++) { at += str[i].length; ends[i] = at; }
    return { rank, num, text: str.join(''), ends };
}

export interface SortJob { result: Promise<Int32Array>; cancel(): void }

/** Sorts rows in a worker (the comparison sort is the slow part); stable, missing values always last */
export function sortInWorker(extensionPath: string, keys: SortKeys, desc: boolean): SortJob {
    const worker = new Worker(path.join(extensionPath, 'out', 'sortWorker.js'));
    const result = new Promise<Int32Array>((resolve, reject) => {
        worker.once('message', (order: Int32Array) => { resolve(order); void worker.terminate(); });
        worker.once('error', reject);
    });
    worker.postMessage({ ...keys, desc }, [keys.rank.buffer as ArrayBuffer, keys.num.buffer as ArrayBuffer, keys.ends.buffer as ArrayBuffer]);
    return { result, cancel: () => { void worker.terminate(); } };
}

