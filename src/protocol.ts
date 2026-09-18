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

export const PREVIEW_CHARS = 200;
/** Most rows sent in one reply, and the size of the smallest group */
export const PAGE = 100;

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
    | { type: 'reveal'; version: number; path: PathStep[] }
    /** Matches for the current search; `reset` starts a new list */
    | { type: 'matches'; version: number; query: string; reset: boolean; ids: number[]; total: number; capped: boolean; done: boolean }
    /** A short confirmation to show, e.g. after copying */
    | { type: 'toast'; text: string };

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
    | { type: 'copy'; version: number; id: number; what: 'path' | 'pointer' | 'value' };
