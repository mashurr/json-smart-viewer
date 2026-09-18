// Virtual tree: only rows on screen exist in the DOM, and children are fetched
// from the extension a page at a time when their parent is opened.

import { Kind, PAGE, Row, ViewMessage } from '../src/protocol';

export const ROW_HEIGHT = 22;
const OVERSCAN = 12;
const INDENT = 16;

/** JSON Pointer of a child (RFC 6901), used as a stable id for open state */
export function childPointer(parent: string, key: string | number): string {
    return parent + '/' + String(key).replace(/~/g, '~0').replace(/\//g, '~1');
}
// Group ids start with a character a pointer never starts with
const groupId = (pointer: string, start: number, end: number) => `\u0001${pointer}\u0001${start}-${end}`;

/** Smallest power of PAGE that splits `n` children into at most PAGE groups */
export function groupSize(n: number): number {
    let g = PAGE;
    while (Math.ceil(n / g) > PAGE) { g *= PAGE; }
    return g;
}

const isContainer = (r: Row) => r.kind === Kind.Object || r.kind === Kind.Array;

type Item =
    | { t: 'node'; row: Row; pointer: string; depth: number; pos: number; setSize: number }
    | { t: 'group'; parent: Row; pointer: string; id: string; start: number; end: number; depth: number; pos: number; setSize: number }
    | { t: 'loading'; depth: number };

type Task =
    | { t: 'emit'; item: Item }
    | { t: 'range'; parent: Row; pointer: string; depth: number; start: number; end: number };

export interface TreeState { expanded: string[]; scrollTop: number; active: number }

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
    ) {
        scroller.addEventListener('scroll', () => this.schedulePaint());
        scroller.addEventListener('click', e => this.click(e));
        scroller.addEventListener('keydown', e => this.key(e));
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

    setDocument(version: number, root: Row) {
        if (version !== this.version) {
            this.pages.clear();
            this.requested.clear();
        }
        this.version = version;
        this.root = root;
        this.refresh();
        if (this.pendingScroll !== undefined) {
            this.scroller.scrollTop = this.pendingScroll;
            this.pendingScroll = undefined;
        }
    }

    addRows(version: number, id: number, start: number, rows: Row[]) {
        if (version !== this.version) { return; }
        const k = `${id}:${start}`;
        this.pages.set(k, rows);
        this.requested.delete(k);
        // A timer, not an animation frame: frames pause while the panel isn't visible
        if (!this.refreshTimer) {
            this.refreshTimer = window.setTimeout(() => { this.refreshTimer = 0; this.refresh(); }, 0);
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
        this.active = Math.min(this.active, Math.max(0, this.items.length - 1));
        this.canvas.style.height = `${this.items.length * ROW_HEIGHT}px`;
        this.paint();
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
        const openable = isContainer(row) && !!row.size;
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
        return el;
    }

    private toggle(index: number) {
        const item = this.items[index];
        if (!item || item.t === 'loading') { return; }
        const id = item.t === 'group' ? item.id : item.pointer;
        if (item.t === 'node' && !(isContainer(item.row) && item.row.size)) { return; }
        if (this.expanded.has(id)) { this.expanded.delete(id); } else { this.expanded.add(id); }
        this.refresh();
        this.onStateChange();
    }

    private isOpen(item: Item): boolean | undefined {
        if (item.t === 'group') { return this.expanded.has(item.id); }
        if (item.t === 'node' && isContainer(item.row) && item.row.size) { return this.expanded.has(item.pointer); }
        return undefined;
    }

    private click(e: MouseEvent) {
        const rowEl = (e.target as HTMLElement).closest<HTMLElement>('.row');
        if (!rowEl) { return; }
        const i = Number(rowEl.dataset.i);
        this.active = i;
        this.scroller.focus({ preventScroll: true });
        if (this.isOpen(this.items[i]) !== undefined) { this.toggle(i); } else { this.paint(); this.onStateChange(); }
    }

    private key(e: KeyboardEvent) {
        const n = this.items.length;
        if (!n) { return; }
        const pageRows = Math.max(1, Math.floor(this.scroller.clientHeight / ROW_HEIGHT) - 1);
        const item = this.items[this.active], open = this.isOpen(item);
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

function span(cls: string, text: string): HTMLSpanElement {
    const s = document.createElement('span');
    s.className = cls;
    s.textContent = text;
    return s;
}

function valueElement(row: Row): HTMLElement {
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
        case Kind.True:
            return span('value bool', 'true');
        case Kind.False:
            return span('value bool', 'false');
        default:
            return span('value null', 'null');
    }
}
