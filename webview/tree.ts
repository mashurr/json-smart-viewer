// Virtual tree: only rows on screen exist in the DOM, and children are fetched
// from the extension a page at a time when their parent is opened.

import { Kind, PAGE, Page, PathStep, Row, ViewMessage, groupSize } from '../src/protocol';
import { closeMenu } from './menu';

export const ROW_HEIGHT = 22;
const OVERSCAN = 12;
const INDENT = 16;
// How long a changed row stays highlighted after a rebuild
const FLASH_MS = 600;
// How long after a rebuild the view keeps the top row in place while pages load
const ANCHOR_MS = 1500;

/** JSON Pointer of a child (RFC 6901), used as a stable id for open state */
export function childPointer(parent: string, key: string | number): string {
    return parent + '/' + String(key).replace(/~/g, '~0').replace(/\//g, '~1');
}
// Group ids start with a character a pointer never starts with
export const groupId = (pointer: string, start: number, end: number) => `\u0001${pointer}\u0001${start}-${end}`;

export { groupSize };

const isContainer = (r: Row) => r.kind === Kind.Object || r.kind === Kind.Array;
const isJsonString = (r: Row) => r.kind === Kind.String && !!r.json;
const signature = (r: Row) => `${r.kind}|${r.text ?? ''}|${r.truncated ? 1 : 0}|${r.size ?? ''}`;
const itemKey = (item: Item | undefined) => !item || item.t === 'loading' ? undefined : item.t === 'group' ? item.id : item.pointer;
const parentPointer = (p: string) => p.slice(0, Math.max(0, p.lastIndexOf('/')));

type Item =
    | { t: 'node'; row: Row; pointer: string; depth: number; pos: number; setSize: number }
    | { t: 'group'; parent: Row; pointer: string; id: string; start: number; end: number; depth: number; pos: number; setSize: number }
    | { t: 'loading'; depth: number };

type Task =
    | { t: 'emit'; item: Item }
    | { t: 'range'; parent: Row; pointer: string; depth: number; start: number; end: number };

export interface TreeState { expanded: string[]; scrollTop: number; active: number }

export type CopyWhat = 'path' | 'pointer' | 'value';
export interface TreeActions {
    copy(version: number, id: number, what: CopyWhat): void;
    /** Opens the row menu at a point (right-click or the keyboard) */
    menu(x: number, y: number, version: number, id: number): void;
}

export class Tree {
    private version = -1;
    private root: Row | undefined;
    private readonly pages = new Map<string, Row[]>();
    private readonly requested = new Set<string>();
    private expanded = new Set<string>();
    private items: Item[] = [];
    private active = 0;
    private frame = 0;

    constructor(
        private readonly scroller: HTMLElement,
        private readonly canvas: HTMLElement,
        private readonly send: (m: ViewMessage) => void,
        private readonly onStateChange: () => void,
        private readonly actions: TreeActions,
    ) {
        scroller.addEventListener('contextmenu', e => {
            const rowEl = (e.target as HTMLElement).closest<HTMLElement>('.row');
            const item = rowEl && this.items[Number(rowEl.dataset.i)];
            if (item?.t !== 'node') { return; }
            e.preventDefault();
            this.active = Number(rowEl!.dataset.i);
            this.paint();
            this.actions.menu(e.clientX, e.clientY, this.version, item.row.id);
        });
        scroller.addEventListener('scroll', () => this.schedulePaint());
        // The user taking over scrolling ends any restore after a rebuild
        for (const e of ['wheel', 'mousedown', 'keydown', 'touchstart']) {
            scroller.addEventListener(e, () => { this.anchor = undefined; }, { passive: true });
        }
        scroller.addEventListener('click', e => this.click(e));
        scroller.addEventListener('keydown', e => this.key(e));
        scroller.addEventListener('scroll', () => closeMenu());
        new ResizeObserver(() => this.schedulePaint()).observe(scroller);
    }

    get state(): TreeState {
        return { expanded: [...this.expanded], scrollTop: this.scroller.scrollTop, active: this.active };
    }

    restore(s: TreeState) {
        this.expanded = new Set(s.expanded);
        this.active = s.active;
        this.pendingScroll = s.scrollTop;
    }
    private pendingScroll: number | undefined;

    // Kept across a rebuild: the top row and its offset, the active row, and old values to spot changes
    private anchor: { key: string; offset: number; until: number } | undefined;
    private activeKey: string | undefined;
    private before: Map<string, string> | undefined;
    private readonly changedAt = new Map<string, number>();
    private pendingReveal: PathStep[] | undefined;
    /** JSON decoded from strings, by string id: its root row, or null when it wasn't JSON after all */
    private readonly decoded = new Map<number, Row | null>();
    private readonly decodeAsked = new Set<number>();

    setDecoded(version: number, id: number, root: Row | undefined) {
        if (version !== this.version) { return; }
        this.decoded.set(id, root && isContainer(root) && root.size ? root : null);
        this.refresh();
        this.onStateChange();
    }

    /** Whether a row opens, and the row whose children it shows */
    private opens(row: Row): boolean {
        if (isContainer(row)) { return !!row.size; }
        return isJsonString(row) && this.decoded.get(row.id) !== null;
    }
    private matches: ReadonlySet<number> = new Set();
    private currentMatch: number | undefined;

    /** Search matches to highlight, by node id */
    setMatches(matches: ReadonlySet<number>, current: number | undefined) {
        this.matches = matches;
        this.currentMatch = current;
        this.paint();
    }

    setDocument(version: number, root: Row) {
        if (version !== this.version) {
            if (this.version !== -1) { this.keepPlace(); }
            this.pages.clear();
            this.requested.clear();
            this.decoded.clear();
            this.decodeAsked.clear();
        }
        this.version = version;
        this.root = root;
        this.refresh();
        if (this.pendingScroll !== undefined) {
            this.scroller.scrollTop = this.pendingScroll;
            this.pendingScroll = undefined;
        }
    }

    /** Remembers where the user is, by path, before the rows are replaced by a new version */
    private keepPlace() {
        const top = Math.floor(this.scroller.scrollTop / ROW_HEIGHT), key = itemKey(this.items[top]);
        this.anchor = key === undefined ? undefined : { key, offset: this.scroller.scrollTop - top * ROW_HEIGHT, until: Date.now() + ANCHOR_MS };
        this.activeKey = itemKey(this.items[this.active]);
        this.before = new Map();
        for (const item of this.items) {
            if (item.t === 'node') { this.before.set(item.pointer, signature(item.row)); }
        }
        const before = this.before;
        window.setTimeout(() => { if (this.before === before) { this.before = undefined; } }, 3000);
    }

    /** Opens every parent of a path (the editor cursor moved) and makes it the active row */
    reveal(version: number, path: PathStep[], pages: Page[] = []) {
        if (version !== this.version) { return; }
        // The pages along the path come with the reveal, so it needs no round-trip per level
        for (const p of pages) { this.pages.set(`${p.id}:${p.start}`, p.rows); }
        this.pendingReveal = path;
        this.tryReveal();
    }

    private tryReveal() {
        const path = this.pendingReveal, root = this.root;
        if (!path || !root) { return; }
        let parent = root, pointer = '', target = '';
        for (let i = 0; i < path.length; i++) {
            const step = path[i];
            let start = 0, end = parent.size ?? 0;
            // Open the groups the child falls in, like flatten() lays them out
            while (end - start > PAGE) {
                const g = groupSize(end - start), s = start + Math.floor((step.index - start) / g) * g, e = Math.min(s + g, end);
                this.expanded.add(groupId(pointer, s, e));
                start = s;
                end = e;
            }
            const rows = this.page(parent, start, end);
            if (!rows) { this.refresh(); return; }
            const child = rows[step.index - start];
            if (!child) { this.pendingReveal = undefined; return; }
            const p = childPointer(pointer, step.key);
            if (i === path.length - 1) { target = p; break; }
            this.expanded.add(p);
            parent = child;
            pointer = p;
        }
        this.refresh();
        const index = this.items.findIndex(item => item.t === 'node' && item.pointer === target);
        if (index < 0) { return; }
        this.pendingReveal = undefined;
        this.active = index;
        const y = index * ROW_HEIGHT, s = this.scroller;
        if (y < s.scrollTop || y + ROW_HEIGHT > s.scrollTop + s.clientHeight) { s.scrollTop = y - s.clientHeight / 3; }
        this.paint();
        this.onStateChange();
    }

    addRows(version: number, id: number, start: number, rows: Row[]) {
        if (version !== this.version) { return; }
        const k = `${id}:${start}`;
        this.pages.set(k, rows);
        this.requested.delete(k);
        // A timer, not an animation frame: frames pause while the panel isn't visible
        if (!this.refreshTimer) {
            this.refreshTimer = window.setTimeout(() => { this.refreshTimer = 0; this.refresh(); this.tryReveal(); }, 0);
        }
    }
    private refreshTimer = 0;

    /** Rows for children [start, end) of `parent`, or undefined while they're being fetched */
    private page(parent: Row, start: number, end: number): Row[] | undefined {
        const k = `${parent.id}:${start}`;
        const rows = this.pages.get(k);
        if (rows) { return rows; }
        if (!this.requested.has(k)) {
            this.requested.add(k);
            this.send({ type: 'children', version: this.version, id: parent.id, start, count: end - start });
        }
        return undefined;
    }

    /** Flattens the open part of the tree into rows, without recursion */
    private flatten() {
        const out: Item[] = [];
        const root = this.root;
        if (!root) { this.items = out; return; }
        if (!isContainer(root)) {
            this.items = [{ t: 'node', row: root, pointer: '', depth: 0, pos: 1, setSize: 1 }];
            return;
        }
        const stack: Task[] = [{ t: 'range', parent: root, pointer: '', depth: 0, start: 0, end: root.size ?? 0 }];
        while (stack.length) {
            const task = stack.pop()!;
            if (task.t === 'emit') { out.push(task.item); continue; }
            const { parent, pointer, depth, start, end } = task;
            const n = end - start, tasks: Task[] = [];
            if (n > PAGE) {
                const g = groupSize(n), setSize = Math.ceil(n / g);
                for (let s = start, pos = 1; s < end; s += g, pos++) {
                    const e = Math.min(s + g, end), id = groupId(pointer, s, e);
                    tasks.push({ t: 'emit', item: { t: 'group', parent, pointer, id, start: s, end: e, depth, pos, setSize } });
                    if (this.expanded.has(id)) { tasks.push({ t: 'range', parent, pointer, depth: depth + 1, start: s, end: e }); }
                }
            } else {
                const rows = this.page(parent, start, end);
                if (!rows) {
                    tasks.push({ t: 'emit', item: { t: 'loading', depth } });
                } else {
                    rows.forEach((row, i) => {
                        const p = childPointer(pointer, row.key!);
                        tasks.push({ t: 'emit', item: { t: 'node', row, pointer: p, depth, pos: start + i + 1, setSize: parent.size ?? 0 } });
                        if (isContainer(row) && row.size && this.expanded.has(p)) {
                            tasks.push({ t: 'range', parent: row, pointer: p, depth: depth + 1, start: 0, end: row.size });
                        } else if (isJsonString(row) && this.expanded.has(p)) {
                            // JSON inside a string: its decoded root's children, once the extension has read it
                            const inner = this.decoded.get(row.id);
                            if (inner) {
                                tasks.push({ t: 'range', parent: inner, pointer: p, depth: depth + 1, start: 0, end: inner.size ?? 0 });
                            } else if (inner === undefined) {
                                if (!this.decodeAsked.has(row.id)) {
                                    this.decodeAsked.add(row.id);
                                    this.send({ type: 'decode', version: this.version, id: row.id });
                                }
                                tasks.push({ t: 'emit', item: { t: 'loading', depth: depth + 1 } });
                            }
                        }
                    });
                }
            }
            for (let i = tasks.length - 1; i >= 0; i--) { stack.push(tasks[i]); }
        }
        this.items = out;
    }

    refresh() {
        this.flatten();
        this.canvas.style.height = `${this.items.length * ROW_HEIGHT}px`;
        this.restorePlace();
        this.active = Math.min(this.active, Math.max(0, this.items.length - 1));
        this.paint();
    }

    /** After a rebuild: keep the same top row in view and the same row active, by path */
    private restorePlace() {
        const loading = this.items.some(i => i.t === 'loading');
        const anchor = this.anchor;
        if (anchor) {
            const index = this.items.findIndex(i => itemKey(i) === anchor.key);
            if (index >= 0) { this.scroller.scrollTop = index * ROW_HEIGHT + anchor.offset; }
            if (Date.now() > anchor.until || (index >= 0 && !loading)) { this.anchor = undefined; }
        }
        if (this.activeKey !== undefined) {
            // A path that no longer exists falls back to its nearest surviving parent
            for (let key: string | undefined = this.activeKey; key !== undefined; key = key ? parentPointer(key) : undefined) {
                const index = this.items.findIndex(i => itemKey(i) === key);
                if (index >= 0) { this.active = index; break; }
                if (loading) { return; }
            }
            if (!loading) { this.activeKey = undefined; }
        }
    }

    private schedulePaint() {
        cancelAnimationFrame(this.frame);
        this.frame = requestAnimationFrame(() => { this.paint(); this.onStateChange(); });
    }

    private paint() {
        const top = this.scroller.scrollTop, height = this.scroller.clientHeight;
        const first = Math.max(0, Math.floor(top / ROW_HEIGHT) - OVERSCAN);
        const last = Math.min(this.items.length, Math.ceil((top + height) / ROW_HEIGHT) + OVERSCAN);
        const frag = document.createDocumentFragment();
        for (let i = first; i < last; i++) { frag.append(this.renderItem(this.items[i], i)); }
        this.canvas.replaceChildren(frag);
        this.scroller.setAttribute('aria-activedescendant', `row-${this.active}`);
    }

    private renderItem(item: Item, index: number): HTMLElement {
        const el = document.createElement('div');
        el.className = 'row';
        el.id = `row-${index}`;
        el.dataset.i = String(index);
        el.style.top = `${index * ROW_HEIGHT}px`;
        el.style.paddingLeft = `${8 + item.depth * INDENT}px`;
        el.setAttribute('role', 'treeitem');
        el.setAttribute('aria-level', String(item.depth + 1));
        if (index === this.active) { el.classList.add('active'); el.setAttribute('aria-selected', 'true'); }
        const twist = span('twist', '›');
        el.append(twist);
        if (item.t === 'loading') {
            twist.classList.add('leaf');
            el.append(span('meta', 'Loading…'));
            return el;
        }
        el.setAttribute('aria-posinset', String(item.pos));
        el.setAttribute('aria-setsize', String(item.setSize));
        if (item.t === 'group') {
            const open = this.expanded.has(item.id);
            twist.classList.toggle('open', open);
            el.setAttribute('aria-expanded', String(open));
            const n = item.end - item.start;
            el.append(span('key', `[${item.start.toLocaleString()} … ${(item.end - 1).toLocaleString()}]`),
                span('meta', `${n.toLocaleString()} ${item.parent.kind === Kind.Array ? 'items' : 'keys'}`));
            return el;
        }
        const row = item.row;
        this.markChanged(el, item.pointer, row);
        if (this.matches.has(row.id)) { el.classList.add(row.id === this.currentMatch ? 'current-match' : 'match'); }
        const openable = this.opens(row);
        if (openable) {
            const open = this.expanded.has(item.pointer);
            twist.classList.toggle('open', open);
            el.setAttribute('aria-expanded', String(open));
        } else {
            twist.classList.add('leaf');
        }
        if (row.key !== undefined) {
            el.append(span('key', typeof row.key === 'number' ? String(row.key) : JSON.stringify(row.key)), span('punct', ':'));
        }
        el.append(valueElement(row));
        if (isJsonString(row) && this.decoded.get(row.id) !== null) {
            const inner = this.decoded.get(row.id);
            el.append(span('badge', inner ? `JSON ${inner.kind === Kind.Array ? `[ ${inner.size!.toLocaleString()} ]` : `{ ${inner.size!.toLocaleString()} }`}` : 'JSON'));
        }
        // Shown on hover and on the active row
        const acts = document.createElement('span');
        acts.className = 'acts';
        for (const [what, label] of [['path', 'Copy path'], ['value', 'Copy value']] as const) {
            const b = document.createElement('button');
            b.dataset.act = what;
            b.tabIndex = -1;
            b.textContent = label;
            acts.append(b);
        }
        el.append(acts);
        return el;
    }

    /** Highlights a row whose value differs from before the last rebuild */
    private markChanged(el: HTMLElement, pointer: string, row: Row) {
        const old = this.before?.get(pointer);
        if (old !== undefined) {
            this.before!.delete(pointer);
            if (old !== signature(row)) { this.changedAt.set(pointer, Date.now()); }
        }
        const at = this.changedAt.get(pointer);
        if (at === undefined) { return; }
        const age = Date.now() - at;
        if (age >= FLASH_MS) { this.changedAt.delete(pointer); return; }
        el.classList.add('changed');
        // Rows are redrawn while scrolling; continue the fade where it was
        el.style.animationDelay = `-${age}ms`;
    }

    private select(index: number) {
        const item = this.items[index];
        if (item?.t === 'node') { this.send({ type: 'select', version: this.version, id: item.row.id }); }
    }

    private toggle(index: number) {
        const item = this.items[index];
        if (!item || item.t === 'loading') { return; }
        const id = item.t === 'group' ? item.id : item.pointer;
        if (item.t === 'node' && !this.opens(item.row)) { return; }
        if (this.expanded.has(id)) { this.expanded.delete(id); } else { this.expanded.add(id); }
        this.refresh();
        this.onStateChange();
    }

    private isOpen(item: Item): boolean | undefined {
        if (item.t === 'group') { return this.expanded.has(item.id); }
        if (item.t === 'node' && this.opens(item.row)) { return this.expanded.has(item.pointer); }
        return undefined;
    }

    private click(e: MouseEvent) {
        const rowEl = (e.target as HTMLElement).closest<HTMLElement>('.row');
        if (!rowEl) { return; }
        const i = Number(rowEl.dataset.i);
        const act = (e.target as HTMLElement).closest<HTMLElement>('button[data-act]')?.dataset.act as CopyWhat | undefined;
        const clicked = this.items[i];
        if (act && clicked?.t === 'node') {
            this.actions.copy(this.version, clicked.row.id, act);
            return;
        }
        this.active = i;
        this.scroller.focus({ preventScroll: true });
        this.select(i);
        if (this.isOpen(this.items[i]) !== undefined) { this.toggle(i); } else { this.paint(); this.onStateChange(); }
    }

    private key(e: KeyboardEvent) {
        const n = this.items.length;
        if (!n) { return; }
        const pageRows = Math.max(1, Math.floor(this.scroller.clientHeight / ROW_HEIGHT) - 1);
        const item = this.items[this.active], open = this.isOpen(item);
        if (item?.t === 'node' && (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'c') {
            e.preventDefault();
            this.actions.copy(this.version, item.row.id, 'value');
            return;
        }
        if (item?.t === 'node' && (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10'))) {
            e.preventDefault();
            const r = this.scroller.querySelector<HTMLElement>(`#row-${this.active}`)?.getBoundingClientRect();
            this.actions.menu(r ? r.left + 24 : 0, r ? r.bottom : 0, this.version, item.row.id);
            return;
        }
        let next = this.active;
        switch (e.key) {
            case 'ArrowDown': next++; break;
            case 'ArrowUp': next--; break;
            case 'Home': next = 0; break;
            case 'End': next = n - 1; break;
            case 'PageDown': next += pageRows; break;
            case 'PageUp': next -= pageRows; break;
            case 'ArrowRight':
                if (open === false) { this.toggle(this.active); } else if (open) { next++; }
                break;
            case 'ArrowLeft':
                if (open) { this.toggle(this.active); break; }
                for (let i = this.active - 1; i >= 0; i--) {
                    if (this.items[i].depth < item.depth) { next = i; break; }
                }
                break;
            case 'Enter':
                this.select(this.active);
                break;
            case ' ':
                this.toggle(this.active);
                break;
            default:
                return;
        }
        e.preventDefault();
        this.active = Math.max(0, Math.min(n - 1, next));
        this.ensureVisible(this.active);
        this.paint();
        this.onStateChange();
    }

    private ensureVisible(i: number) {
        const y = i * ROW_HEIGHT, s = this.scroller;
        if (y < s.scrollTop) { s.scrollTop = y; }
        else if (y + ROW_HEIGHT > s.scrollTop + s.clientHeight) { s.scrollTop = y + ROW_HEIGHT - s.clientHeight; }
    }
}

export function span(cls: string, text: string): HTMLSpanElement {
    const s = document.createElement('span');
    s.className = cls;
    s.textContent = text;
    return s;
}

export function valueElement(row: Pick<Row, 'kind' | 'text' | 'truncated' | 'size'>): HTMLElement {
    switch (row.kind) {
        case Kind.Object:
        case Kind.Array: {
            const arr = row.kind === Kind.Array, n = row.size ?? 0;
            if (!n) { return span('punct', arr ? '[]' : '{}'); }
            return span('meta', arr ? `[ ${n.toLocaleString()} item${n === 1 ? '' : 's'} ]` : `{ ${n.toLocaleString()} key${n === 1 ? '' : 's'} }`);
        }
        case Kind.String:
            return span('value str', JSON.stringify(row.text ?? '').slice(0, row.truncated ? -1 : undefined) + (row.truncated ? '…"' : ''));
        case Kind.Number:
            return span('value num', (row.text ?? '') + (row.truncated ? '…' : ''));
        case Kind.Error:
            return span('value error', `⚠ ${row.text ?? ''}`);
        case Kind.True:
            return span('value bool', 'true');
        case Kind.False:
            return span('value bool', 'false');
        default:
            return span('value null', 'null');
    }
}
