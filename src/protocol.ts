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

export const PREVIEW_CHARS = 200;
/** Most rows sent in one reply, and the size of the smallest group */
export const PAGE = 100;

export type HostMessage =
    | { type: 'progress'; loaded: number; total: number }
    | { type: 'document'; version: number; fileName: string; root: Row }
    | { type: 'invalid'; message: string; line: number; column: number }
    | { type: 'rows'; version: number; id: number; start: number; rows: Row[] };

export type ViewMessage =
    | { type: 'ready' }
    | { type: 'children'; version: number; id: number; start: number; count: number };
