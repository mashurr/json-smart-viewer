// Messages between the extension host and the webview. Shared by both sides,
// so this file must not import anything.

export const enum Kind { Object, Array, String, Number, True, False, Null }

/** One tree row: a value plus the key or index it sits under */
export interface Row {
    /** Node id, valid for the document version it came with */
    id: number;
    /** Property name, or index inside an array; absent for the root */
    key?: string | number;
    kind: Kind;
    /** Display text for strings (decoded) and numbers (as written); cut at PREVIEW_CHARS */
    text?: string;
    /** Set when `text` was cut */
    truncated?: boolean;
    /** Number of children, for objects and arrays */
    size?: number;
}

/** One step of a path: the key (or array index) and the child's position in its parent */
export interface PathStep {
    key: string | number;
    index: number;
}

/** A container that reads as a table */
export interface TableInfo {
    id: number;
    /** rows: array of objects; map: object of objects (keys become a column); mixed: objects and other values */
    shape: 'rows' | 'map' | 'mixed';
    rows: number;
    /** Where it is, as `orders[3].items` and as a JSON Pointer (to find it again after a rebuild) */
    path: string;
    pointer: string;
}
export interface TableColumn {
    label: string;
    /** The object key this column shows */
    key?: string;
    /** 'key': the map key; 'value': a row that isn't an object */
    special?: 'key' | 'value';
}
export type TableCell = Omit<Row, 'key'>;
export interface TableRow {
    /** Position in the container, and the row's node */
    index: number;
    id: number;
    /** null where the row has no value for the column */
    cells: (TableCell | null)[];
}
export interface TableSort { column: number; desc: boolean }

export const PREVIEW_CHARS = 200;
/** Most rows sent in one reply, and the size of the smallest group */
export const PAGE = 100;

/** Smallest power of PAGE that splits `n` children into at most PAGE groups (groups nest above PAGE²) */
export function groupSize(n: number): number {
    let g = PAGE;
    while (Math.ceil(n / g) > PAGE) { g *= PAGE; }
    return g;
}

/** The range of at most PAGE children, inside nested groups, that holds child `index` */
export function leafRange(size: number, index: number): { start: number; end: number } {
    let start = 0, end = size;
    while (end - start > PAGE) {
        const g = groupSize(end - start), s = start + Math.floor((index - start) / g) * g;
        start = s;
        end = Math.min(s + g, end);
    }
    return { start, end };
}

/** A page of rows, as in a 'rows' message */
export interface Page { id: number; start: number; rows: Row[] }

export type HostMessage =
    | { type: 'progress'; loaded: number; total: number }
    | { type: 'document'; version: number; fileName: string; root: Row }
    | { type: 'invalid'; message: string; line: number; column: number }
    | { type: 'rows'; version: number; id: number; start: number; rows: Row[] }
    /** The document changed and a rebuild is waiting for typing to pause */
    | { type: 'editing' }
    /** The edited text is invalid; the last valid version stays on screen */
    | { type: 'problem'; message: string; line: number; column: number }
    /** Show the node at this path (the editor cursor moved, or a search match was chosen) */
    | { type: 'reveal'; version: number; path: PathStep[]; pages: Page[] }
    /** Matches for the current search; `reset` starts a new list */
    | { type: 'matches'; version: number; query: string; reset: boolean; ids: number[]; total: number; capped: boolean; done: boolean }
    /** A short confirmation to show, e.g. after copying */
    | { type: 'toast'; text: string }
    /** Tables found in the document, biggest first */
    | { type: 'tables'; version: number; tables: TableInfo[] }
    /** The table to show, with its columns (`more`: columns left out) */
    | { type: 'table'; version: number; info: TableInfo; columns: TableColumn[]; more: number }
    | { type: 'tableRows'; version: number; id: number; start: number; sort: string; rows: TableRow[] }
    /** Shown while a big table sorts */
    | { type: 'tableStatus'; text: string };

export type ViewMessage =
    | { type: 'ready' }
    | { type: 'children'; version: number; id: number; start: number; count: number }
    /** Select this node's text in the editor */
    | { type: 'select'; version: number; id: number }
    /** Search keys and values; an empty query clears the search */
    | { type: 'search'; query: string }
    /** Show this node in the viewer (a search match) */
    | { type: 'revealNode'; version: number; id: number }
    /** Copy a node's path, JSON Pointer or value to the clipboard */
    | { type: 'copy'; version: number; id: number; what: 'path' | 'pointer' | 'value' }
    /** List the tables in the document */
    | { type: 'tables'; version: number }
    /** Show a container as a table, by node id or (after a rebuild) by JSON Pointer */
    | { type: 'openTable'; version: number; id?: number; pointer?: string }
    | { type: 'tableRows'; version: number; id: number; start: number; count: number; sort: TableSort | null };
