// Graph view: one card per object or array, laid out left to right. Simple values are listed
// inside a card; child objects and arrays are rows that open their own card. Big containers
// open as group cards. Only cards on screen are drawn, and nothing here recurses.

import { Kind, PAGE, Page, PathStep, Row, ViewMessage } from '../src/protocol';
import { closeMenu } from './menu';
import { childPointer, groupId, groupSize, span, valueElement } from './tree';

const CARD_WIDTH = 260;
const COLUMN_GAP = 90;
const HEAD = 26;
const ROW = 20;
const GAP = 18;
const ROWS_SHOWN = 10;
const MIN_ZOOM = 0.2;
const MAX_ZOOM = 2;
// Cards this far outside the view are still drawn, so panning doesn't show gaps
const CULL_MARGIN = 300;

const isContainer = (r: Row) => (r.kind === Kind.Object || r.kind === Kind.Array) && !!r.size;

/** What a card lists: a range of a container's children */
interface CardSpec {
    /** Stable id: the container's pointer, or a group id */
    id: string;
    /** Pointer of the container whose children are listed */
    pointer: string;
    parent: Row;
    start: number;
    end: number;
    label: string;
    meta: string;
}

type Entry =
    | { t: 'value'; row: Row }
    | { t: 'port'; row: Row; child: CardSpec }
    | { t: 'group'; child: CardSpec; count: number }
    | { t: 'more'; hidden: number }
    | { t: 'loading' };

interface Card {
    spec: CardSpec;
    entries: Entry[];
    kids: { row: number; card: Card }[];
    x: number;
    y: number;
    h: number;
}

export interface GraphState { open: string[]; limits: [string, number][]; x: number; y: number; k: number }

export interface GraphActions {
    select(version: number, id: number): void;
    menu(x: number, y: number, version: number, id: number): void;
    onStateChange(): void;
}

export class GraphView {
    private version = -1;
    private root: Row | undefined;
    private readonly pages = new Map<string, Row[]>();
    private readonly requested = new Set<string>();
    private open = new Set<string>();
    private limits = new Map<string, number>();
    private x = 24;
    private y = 24;
    private k = 1;
    private cards: Card[] = [];
    private active: number | undefined;
    private matches: ReadonlySet<number> = new Set();
    private currentMatch: number | undefined;
    private pendingReveal: PathStep[] | undefined;
    private frame = 0;
    private timer = 0;
    private readonly layer: HTMLElement;
    private readonly edges: SVGSVGElement;

    constructor(
        private readonly viewport: HTMLElement,
        private readonly send: (m: ViewMessage) => void,
        private readonly actions: GraphActions,
    ) {
        this.layer = document.createElement('div');
        this.layer.className = 'layer';
        this.edges = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        this.edges.classList.add('edges');
        this.layer.append(this.edges);
        viewport.append(this.layer);
        this.controls();
        this.panAndZoom();
        viewport.addEventListener('contextmenu', e => {
            const id = this.nodeAt(e.target);
            if (id === undefined) { return; }
            e.preventDefault();
            this.active = id;
            this.paint();
            this.actions.menu(e.clientX, e.clientY, this.version, id);
        });
        new ResizeObserver(() => this.schedulePaint()).observe(viewport);
    }

    get state(): GraphState { return { open: [...this.open], limits: [...this.limits], x: this.x, y: this.y, k: this.k }; }

    restore(s: GraphState) {
        this.open = new Set(s.open);
        this.limits = new Map(s.limits);
        this.x = s.x;
        this.y = s.y;
        this.k = s.k;
    }

    setDocument(version: number, root: Row) {
        if (version !== this.version) {
            this.pages.clear();
            this.requested.clear();
        }
        this.version = version;
        this.root = root;
        this.layout();
    }

    /** Rows arrive for everyone; keep only the pages this view asked for */
    addRows(version: number, id: number, start: number, rows: Row[]) {
        const k = `${id}:${start}`;
        if (version !== this.version || !this.requested.has(k)) { return; }
        this.pages.set(k, rows);
        this.requested.delete(k);
        if (!this.timer) {
            this.timer = window.setTimeout(() => { this.timer = 0; this.layout(); this.tryReveal(); }, 0);
        }
    }

    setMatches(matches: ReadonlySet<number>, current: number | undefined) {
        this.matches = matches;
        this.currentMatch = current;
        this.paint();
    }

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

    private rootSpec(): CardSpec | undefined {
        const r = this.root;
        if (!r || !isContainer(r)) { return undefined; }
        return { id: '', pointer: '', parent: r, start: 0, end: r.size!, label: '$', meta: summary(r) };
    }

    /** What a card lists right now; pages that aren't loaded yet are requested */
    private entries(spec: CardSpec): Entry[] {
        const { parent, pointer, start, end } = spec, n = end - start;
        const all: Entry[] = [];
        if (n > PAGE) {
            const g = groupSize(n);
            for (let s = start; s < end; s += g) {
                const e = Math.min(s + g, end);
                all.push({
                    t: 'group', count: e - s,
                    child: { id: groupId(pointer, s, e), pointer, parent, start: s, end: e, label: `[${s.toLocaleString()} … ${(e - 1).toLocaleString()}]`, meta: `${(e - s).toLocaleString()} ${parent.kind === Kind.Array ? 'items' : 'keys'}` },
                });
            }
        } else {
            const rows = this.page(parent, start, end);
            if (!rows) { return [{ t: 'loading' }]; }
            for (const row of rows) {
                if (isContainer(row)) {
                    const p = childPointer(pointer, row.key!);
                    all.push({ t: 'port', row, child: { id: p, pointer: p, parent: row, start: 0, end: row.size!, label: keyLabel(row.key!), meta: summary(row) } });
                } else {
                    all.push({ t: 'value', row });
                }
            }
        }
        const limit = this.limits.get(spec.id) ?? ROWS_SHOWN;
        if (all.length <= limit) { return all; }
        return [...all.slice(0, limit), { t: 'more', hidden: all.length - limit }];
    }

    /** Builds the open cards and places them, left to right, without recursion */
    private layout() {
        const rootSpec = this.rootSpec();
        this.cards = [];
        if (!rootSpec) { this.paint(); return; }
        const make = (spec: CardSpec): Card => {
            const entries = this.entries(spec);
            return { spec, entries, kids: [], x: 0, y: 0, h: HEAD + entries.length * ROW + 2 };
        };
        const root = make(rootSpec);
        const stack: { card: Card; depth: number }[] = [{ card: root, depth: 0 }];
        while (stack.length) {
            const { card, depth } = stack.pop()!;
            card.x = depth * (CARD_WIDTH + COLUMN_GAP);
            this.cards.push(card);
            card.entries.forEach((e, i) => {
                if ((e.t === 'port' || e.t === 'group') && this.open.has(e.child.id)) {
                    card.kids.push({ row: i, card: make(e.child) });
                }
            });
            for (let i = card.kids.length - 1; i >= 0; i--) { stack.push({ card: card.kids[i].card, depth: depth + 1 }); }
        }
        // Children first, then their parent centred beside them
        const frames: { card: Card; y0: number; next: number; y: number }[] = [{ card: root, y0: 0, next: 0, y: 0 }];
        // `y` is where the next child starts; `returned` is where the child just placed ended
        let returned = 0;
        while (frames.length) {
            const f = frames[frames.length - 1];
            if (f.next > 0) { f.y = returned; }
            if (f.next < f.card.kids.length) {
                const kid = f.card.kids[f.next++].card;
                frames.push({ card: kid, y0: f.y, next: 0, y: f.y });
                continue;
            }
            frames.pop();
            const c = f.card;
            if (!c.kids.length) {
                c.y = f.y0;
                returned = f.y0 + c.h + GAP;
            } else {
                const first = c.kids[0].card, last = c.kids[c.kids.length - 1].card;
                c.y = Math.max(f.y0, (first.y + last.y + last.h) / 2 - c.h / 2);
                returned = Math.max(f.y, c.y + c.h + GAP);
            }
        }
        this.paint();
    }

    private schedulePaint() {
        cancelAnimationFrame(this.frame);
        this.frame = requestAnimationFrame(() => this.paint());
    }

    /** Draws only the cards (and edges) near the visible area */
    private paint() {
        this.layer.style.transform = `translate(${this.x}px, ${this.y}px) scale(${this.k})`;
        const w = this.viewport.clientWidth, h = this.viewport.clientHeight;
        const vx0 = (-this.x - CULL_MARGIN) / this.k, vy0 = (-this.y - CULL_MARGIN) / this.k;
        const vx1 = (w - this.x + CULL_MARGIN) / this.k, vy1 = (h - this.y + CULL_MARGIN) / this.k;
        const visible = (c: Card) => c.x + CARD_WIDTH >= vx0 && c.x <= vx1 && c.y + c.h >= vy0 && c.y <= vy1;
        const frag = document.createDocumentFragment();
        const paths: string[] = [];
        for (const c of this.cards) {
            const show = visible(c);
            if (show) { frag.append(this.renderCard(c)); }
            for (const { row, card } of c.kids) {
                if (!show && !visible(card)) { continue; }
                const x1 = c.x + CARD_WIDTH, y1 = c.y + HEAD + row * ROW + ROW / 2, x2 = card.x, y2 = card.y + HEAD / 2, mx = (x1 + x2) / 2;
                paths.push(`M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`);
            }
        }
        this.layer.querySelectorAll('.card').forEach(n => n.remove());
        this.layer.dataset.cards = String(this.cards.length);
        this.layer.append(frag);
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', paths.join(' '));
        this.edges.replaceChildren(path);
    }

    private renderCard(c: Card): HTMLElement {
        const el = document.createElement('div');
        el.className = 'card';
        el.style.left = `${c.x}px`;
        el.style.top = `${c.y}px`;
        el.style.width = `${CARD_WIDTH}px`;
        const head = document.createElement('div');
        head.className = 'card-head';
        head.append(span('key', c.spec.label), span('meta', c.spec.meta));
        el.append(head);
        c.entries.forEach((e, i) => {
            const r = document.createElement('div');
            r.className = 'card-row';
            r.dataset.card = c.spec.id;
            r.dataset.i = String(i);
            if (e.t === 'loading') { r.append(span('meta', 'Loading…')); }
            else if (e.t === 'more') { r.classList.add('more'); r.append(span('meta', `… ${e.hidden.toLocaleString()} more — show ${Math.min(ROWS_SHOWN, e.hidden)}`)); }
            else if (e.t === 'group') {
                r.classList.add('port');
                r.append(span('key', e.child.label), span('meta', e.child.meta), span('arrow', this.open.has(e.child.id) ? '▾' : '▸'));
            } else {
                const row = e.row;
                r.dataset.id = String(row.id);
                r.append(span('key', keyLabel(row.key!)));
                if (e.t === 'port') {
                    r.classList.add('port');
                    r.append(span('meta', summary(row)), span('arrow', this.open.has(e.child.id) ? '▾' : '▸'));
                } else {
                    r.append(span('punct', ':'), valueElement(row));
                }
                if (row.id === this.active) { r.classList.add('active'); }
                if (this.matches.has(row.id)) { r.classList.add(row.id === this.currentMatch ? 'current-match' : 'match'); }
            }
            el.append(r);
        });
        if (this.active !== undefined && c.entries.some(e => (e.t === 'value' || e.t === 'port') && e.row.id === this.active)) { el.classList.add('has-active'); }
        return el;
    }

    private nodeAt(target: EventTarget | null): number | undefined {
        const r = (target as HTMLElement).closest<HTMLElement>('.card-row');
        return r?.dataset.id ? Number(r.dataset.id) : undefined;
    }

    private rowClicked(target: HTMLElement) {
        const r = target.closest<HTMLElement>('.card-row');
        if (!r) { return; }
        const card = this.cards.find(c => c.spec.id === r.dataset.card);
        const e = card?.entries[Number(r.dataset.i)];
        if (!card || !e) { return; }
        let opened: string | undefined;
        if (e.t === 'more') {
            this.limits.set(card.spec.id, (this.limits.get(card.spec.id) ?? ROWS_SHOWN) + ROWS_SHOWN);
        } else if (e.t === 'port' || e.t === 'group') {
            if (this.open.has(e.child.id)) { this.open.delete(e.child.id); } else { this.open.add(e.child.id); opened = e.child.id; }
        }
        if (e.t === 'port' || e.t === 'value') {
            this.active = e.row.id;
            this.actions.select(this.version, e.row.id);
        }
        this.layout();
        if (opened !== undefined) { this.bringIntoView(opened); }
        this.actions.onStateChange();
    }

    /** Pans just enough to show a card that opened off-screen (its head, at least) */
    private bringIntoView(id: string) {
        const c = this.cards.find(c => c.spec.id === id);
        if (!c) { return; }
        const w = this.viewport.clientWidth, h = this.viewport.clientHeight, pad = 24;
        const right = Math.min(c.x + CARD_WIDTH, c.x + (w - 2 * pad) / this.k);
        const sx = this.x + right * this.k, sy = this.y + c.y * this.k;
        if (sx > w - pad) { this.x -= sx - (w - pad); }
        if (sy + HEAD * this.k > h - pad) { this.y -= sy + HEAD * this.k - (h - pad); }
        if (this.y + c.y * this.k < pad) { this.y = pad - c.y * this.k; }
        this.paint();
    }

    /** Opens the cards along a path and centres its target (the editor cursor moved, or a search match) */
    reveal(version: number, path: PathStep[], pages: Page[] = []) {
        if (version !== this.version) { return; }
        for (const p of pages) { this.pages.set(`${p.id}:${p.start}`, p.rows); }
        this.pendingReveal = path;
        this.tryReveal();
    }

    private tryReveal() {
        const path = this.pendingReveal, rootSpec = this.rootSpec();
        if (!path || !rootSpec) { return; }
        let spec = rootSpec;
        let target: number | undefined;
        for (let i = 0; i < path.length; i++) {
            const step = path[i];
            // Open group cards down to a range of at most PAGE children
            while (spec.end - spec.start > PAGE) {
                const n = spec.end - spec.start, g = groupSize(n);
                const s = spec.start + Math.floor((step.index - spec.start) / g) * g, e = Math.min(s + g, spec.end);
                this.showEntry(spec, Math.floor((s - spec.start) / g));
                const id = groupId(spec.pointer, s, e);
                this.open.add(id);
                spec = { id, pointer: spec.pointer, parent: spec.parent, start: s, end: e, label: '', meta: '' };
            }
            const rows = this.page(spec.parent, spec.start, spec.end);
            if (!rows) { this.layout(); return; }
            const row = rows[step.index - spec.start];
            if (!row) { this.pendingReveal = undefined; return; }
            this.showEntry(spec, step.index - spec.start);
            if (i === path.length - 1 || !isContainer(row)) { target = row.id; break; }
            const p = childPointer(spec.pointer, step.key);
            this.open.add(p);
            spec = { id: p, pointer: p, parent: row, start: 0, end: row.size!, label: '', meta: '' };
        }
        this.pendingReveal = undefined;
        this.active = target;
        this.layout();
        this.centreOn(target);
        this.actions.onStateChange();
    }

    /** Makes sure entry `i` of a card isn't hidden behind its "more" row */
    private showEntry(spec: CardSpec, i: number) {
        const limit = this.limits.get(spec.id) ?? ROWS_SHOWN;
        if (i >= limit) { this.limits.set(spec.id, Math.ceil((i + 1) / ROWS_SHOWN) * ROWS_SHOWN); }
    }

    private centreOn(id: number | undefined) {
        const card = this.cards.find(c => c.entries.some(e => (e.t === 'value' || e.t === 'port') && e.row.id === id));
        if (!card) { return; }
        const i = card.entries.findIndex(e => (e.t === 'value' || e.t === 'port') && e.row.id === id);
        this.x = this.viewport.clientWidth / 2 - (card.x + CARD_WIDTH / 2) * this.k;
        this.y = this.viewport.clientHeight / 3 - (card.y + HEAD + i * ROW) * this.k;
        this.paint();
    }

    private zoomAt(factor: number, cx: number, cy: number) {
        const k = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, this.k * factor));
        this.x = cx - (cx - this.x) * k / this.k;
        this.y = cy - (cy - this.y) * k / this.k;
        this.k = k;
        this.schedulePaint();
        this.actions.onStateChange();
    }

    fit() {
        if (!this.cards.length) { return; }
        const maxX = Math.max(...this.cards.map(c => c.x + CARD_WIDTH)), maxY = Math.max(...this.cards.map(c => c.y + c.h));
        this.k = Math.min(1, Math.max(MIN_ZOOM, Math.min((this.viewport.clientWidth - 48) / maxX, (this.viewport.clientHeight - 48) / maxY)));
        this.x = 24;
        this.y = 24;
        this.paint();
        this.actions.onStateChange();
    }

    private controls() {
        const bar = document.createElement('div');
        bar.className = 'graph-controls';
        const button = (label: string, title: string, run: () => void) => {
            const b = document.createElement('button');
            b.className = 'icon';
            b.textContent = label;
            b.title = title;
            b.setAttribute('aria-label', title);
            b.addEventListener('click', run);
            bar.append(b);
        };
        const centre = () => [this.viewport.clientWidth / 2, this.viewport.clientHeight / 2] as const;
        button('+', 'Zoom in', () => this.zoomAt(1.2, ...centre()));
        button('−', 'Zoom out', () => this.zoomAt(1 / 1.2, ...centre()));
        button('Fit', 'Fit to view', () => this.fit());
        this.viewport.append(bar);
    }

    private panAndZoom() {
        const vp = this.viewport;
        vp.addEventListener('wheel', e => {
            e.preventDefault();
            const r = vp.getBoundingClientRect();
            this.zoomAt(e.deltaY < 0 ? 1.1 : 1 / 1.1, e.clientX - r.left, e.clientY - r.top);
        }, { passive: false });
        let drag: { x: number; y: number; ox: number; oy: number; moved: boolean } | undefined;
        vp.addEventListener('pointerdown', e => {
            if (e.button !== 0 || (e.target as HTMLElement).closest('.graph-controls')) { return; }
            closeMenu();
            drag = { x: e.clientX, y: e.clientY, ox: this.x, oy: this.y, moved: false };
        });
        vp.addEventListener('pointermove', e => {
            if (!drag) { return; }
            const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
            if (!drag.moved && Math.abs(dx) + Math.abs(dy) > 4) {
                drag.moved = true;
                // Keeps the drag going outside the panel; fails harmlessly for a pointer that isn't down
                try { vp.setPointerCapture(e.pointerId); } catch { /* not capturable */ }
                vp.classList.add('dragging');
            }
            if (drag.moved) {
                this.x = drag.ox + dx;
                this.y = drag.oy + dy;
                this.schedulePaint();
            }
        });
        vp.addEventListener('pointerup', e => {
            const d = drag;
            drag = undefined;
            vp.classList.remove('dragging');
            if (!d) { return; }
            if (d.moved) { this.actions.onStateChange(); return; }
            this.rowClicked(e.target as HTMLElement);
        });
    }

    /** Test hook: how many cards are drawn */
    get drawn(): number { return this.layer.querySelectorAll('.card').length; }
}

function keyLabel(key: string | number): string {
    return typeof key === 'number' ? String(key) : JSON.stringify(key);
}

function summary(r: Row): string {
    const n = r.size ?? 0, arr = r.kind === Kind.Array;
    return arr ? `[ ${n.toLocaleString()} item${n === 1 ? '' : 's'} ]` : `{ ${n.toLocaleString()} key${n === 1 ? '' : 's'} }`;
}
