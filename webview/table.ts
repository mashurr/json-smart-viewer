// Table view: rows and columns are both virtual, so only what's on screen exists in the DOM.
// Rows come from the extension a page at a time, in the current sort order.

import { Kind, PAGE, TableColumn, TableInfo, TableRow, TableSort, ViewMessage } from '../src/protocol';
import { closeMenu } from './menu';
import { decorate } from './previews';
import { span, valueElement } from './tree';

const ROW_HEIGHT = 22;
const HEADER_HEIGHT = 26;
const INDEX_WIDTH = 72;
const DEFAULT_WIDTH = 160;
const MIN_WIDTH = 48;
const OVERSCAN_ROWS = 10;
const OVERSCAN_PX = 200;

export interface TableActions {
    /** A row was chosen: select it in the editor */
    select(version: number, id: number): void;
    menu(x: number, y: number, version: number, id: number): void;
    /** A nested value was clicked: show it in the tree */
    openInTree(version: number, id: number): void;
    onStateChange(): void;
}

const isContainer = (k: Kind) => k === Kind.Object || k === Kind.Array;

export class TableView {
    private version = -1;
    private info: TableInfo | undefined;
    private columns: TableColumn[] = [];
    private widths: number[] = [];
    private sort: TableSort | null = null;
    private readonly pages = new Map<number, TableRow[]>();
    private readonly requested = new Set<number>();
    private active = -1;
    private frame = 0;
    private matches: ReadonlySet<number> = new Set();
    private currentMatch: number | undefined;
    private readonly header: HTMLElement;
    private readonly canvas: HTMLElement;

    constructor(
        private readonly scroller: HTMLElement,
        private readonly bar: { select: HTMLSelectElement; note: HTMLElement },
        private readonly send: (m: ViewMessage) => void,
        private readonly actions: TableActions,
    ) {
        this.header = document.createElement('div');
        this.header.className = 'thead';
        this.header.setAttribute('role', 'row');
        this.canvas = document.createElement('div');
        this.canvas.className = 'tbody';
        scroller.append(this.header, this.canvas);
        scroller.addEventListener('scroll', () => { closeMenu(); this.schedulePaint(); });
        new ResizeObserver(() => this.schedulePaint()).observe(scroller);
        scroller.addEventListener('click', e => this.click(e));
        scroller.addEventListener('contextmenu', e => {
            const r = this.rowAt(e.target);
            if (!r) { return; }
            e.preventDefault();
            this.actions.menu(e.clientX, e.clientY, this.version, r.row.id);
        });
        scroller.addEventListener('keydown', e => this.key(e));
        bar.select.addEventListener('change', () => this.send({ type: 'openTable', version: this.version, id: Number(bar.select.value) }));
    }

    get pointer(): string | undefined { return this.info?.pointer; }
    get sortState(): TableSort | null { return this.sort; }
    get shown(): boolean { return !!this.info; }

    setTables(version: number, tables: TableInfo[]) {
        if (version !== this.version && this.version !== -1) { return; }
        const select = this.bar.select;
        select.replaceChildren(...tables.map(t => {
            const o = document.createElement('option');
            o.value = String(t.id);
            o.textContent = `${t.path} — ${t.rows.toLocaleString()} rows`;
            return o;
        }));
        if (this.info) { select.value = String(this.info.id); }
        select.disabled = !tables.length;
    }

    /** A new table (or the same one again after a rebuild); `sort` is kept when the columns still have it */
    setTable(version: number, info: TableInfo, columns: TableColumn[], more: number) {
        const same = this.info?.pointer === info.pointer && this.columns.length === columns.length;
        this.version = version;
        this.info = info;
        if (!same) {
            this.widths = columns.map(c => c.special === 'key' ? 200 : DEFAULT_WIDTH);
            this.sort = null;
            this.active = -1;
            this.scroller.scrollTop = 0;
        }
        this.columns = columns;
        this.pages.clear();
        this.requested.clear();
        if (![...this.bar.select.options].some(o => o.value === String(info.id))) {
            const o = document.createElement('option');
            o.value = String(info.id);
            o.textContent = `${info.path} — ${info.rows.toLocaleString()} rows`;
            this.bar.select.prepend(o);
        }
        this.bar.select.value = String(info.id);
        this.bar.note.textContent = more ? `+${more.toLocaleString()} more columns not shown` : '';
        this.layout();
        this.actions.onStateChange();
    }

    restoreSort(sort: TableSort | null) { this.sort = sort; }

    setStatus(text: string) { this.bar.note.textContent = text; }

    addRows(version: number, id: number, start: number, sort: string, rows: TableRow[]) {
        if (version !== this.version || id !== this.info?.id || sort !== this.sortKey()) { return; }
        if (start >= 0) {
            this.pages.set(start, rows);
            this.requested.delete(start);
            this.stale = undefined;
        } else {
            // A sort finished: requests made while it ran weren't answered, so ask again for what's on screen
            this.requested.clear();
        }
        this.paint();
    }

    setMatches(matches: ReadonlySet<number>, current: number | undefined) {
        this.matches = matches;
        this.currentMatch = current;
        if (this.info) { this.paint(); }
    }

    private sortKey() { return this.sort ? `${this.sort.column}:${this.sort.desc ? 'desc' : 'asc'}` : ''; }

    private get totalWidth() { return INDEX_WIDTH + this.widths.reduce((a, b) => a + b, 0); }

    private layout() {
        const rows = this.info?.rows ?? 0;
        this.canvas.style.height = `${HEADER_HEIGHT + rows * ROW_HEIGHT}px`;
        this.canvas.style.width = this.header.style.width = `${this.totalWidth}px`;
        this.paint();
    }

    private schedulePaint() {
        cancelAnimationFrame(this.frame);
        this.frame = requestAnimationFrame(() => this.paint());
    }

    /** Columns overlapping the visible width, with their left edges */
    private visibleColumns(): { i: number; left: number }[] {
        const from = this.scroller.scrollLeft - OVERSCAN_PX, to = this.scroller.scrollLeft + this.scroller.clientWidth + OVERSCAN_PX;
        const out: { i: number; left: number }[] = [];
        let left = INDEX_WIDTH;
        for (let i = 0; i < this.widths.length; i++) {
            const w = this.widths[i];
            if (left + w >= from && left <= to) { out.push({ i, left }); }
            left += w;
            if (left > to) { break; }
        }
        return out;
    }

    private paint() {
        if (!this.info) { return; }
        const cols = this.visibleColumns();
        this.paintHeader(cols);
        const top = Math.max(0, this.scroller.scrollTop - HEADER_HEIGHT);
        const first = Math.max(0, Math.floor(top / ROW_HEIGHT) - OVERSCAN_ROWS);
        const last = Math.min(this.info.rows, Math.ceil((top + this.scroller.clientHeight) / ROW_HEIGHT) + OVERSCAN_ROWS);
        const frag = document.createDocumentFragment();
        for (let r = first; r < last; r++) {
            const pageStart = Math.floor(r / PAGE) * PAGE;
            const page = this.pages.get(pageStart);
            if (!page) { this.request(pageStart); }
            const old = page ? undefined : this.stale?.get(pageStart)?.[r - pageStart];
            const el = this.renderRow(r, page?.[r - pageStart] ?? old, cols);
            if (old) { el.classList.add('stale'); }
            frag.append(el);
        }
        this.canvas.replaceChildren(frag);
    }

    private request(start: number) {
        if (this.requested.has(start) || !this.info) { return; }
        this.requested.add(start);
        this.send({ type: 'tableRows', version: this.version, id: this.info.id, start, count: PAGE, sort: this.sort });
    }

    private paintHeader(cols: { i: number; left: number }[]) {
        const cells: HTMLElement[] = [];
        const index = document.createElement('div');
        index.className = 'th index';
        index.style.left = '0';
        index.style.width = `${INDEX_WIDTH}px`;
        index.textContent = this.info!.shape === 'map' ? '#' : 'index';
        cells.push(index);
        for (const { i, left } of cols) {
            const c = this.columns[i];
            const th = document.createElement('div');
            th.className = 'th';
            th.setAttribute('role', 'columnheader');
            th.dataset.col = String(i);
            th.style.left = `${left}px`;
            th.style.width = `${this.widths[i]}px`;
            th.title = c.special === 'value' ? 'Values that are not objects' : c.label;
            const sorted = this.sort?.column === i;
            th.setAttribute('aria-sort', sorted ? (this.sort!.desc ? 'descending' : 'ascending') : 'none');
            th.append(span(c.special ? 'label special' : 'label', c.label));
            if (sorted) { th.append(span('arrow', this.sort!.desc ? '▼' : '▲')); }
            const grip = document.createElement('span');
            grip.className = 'grip';
            grip.addEventListener('pointerdown', e => this.resize(e, i));
            th.append(grip);
            cells.push(th);
        }
        this.header.replaceChildren(...cells);
    }

    private renderRow(r: number, row: TableRow | undefined, cols: { i: number; left: number }[]): HTMLElement {
        const el = document.createElement('div');
        el.className = 'trow';
        el.setAttribute('role', 'row');
        el.style.top = `${HEADER_HEIGHT + r * ROW_HEIGHT}px`;
        el.dataset.r = String(r);
        if (r === this.active) { el.classList.add('active'); }
        const index = document.createElement('div');
        index.className = 'td index';
        index.style.width = `${INDEX_WIDTH}px`;
        index.textContent = row ? row.index.toLocaleString() : '…';
        el.append(index);
        if (!row) { return el; }
        for (const { i, left } of cols) {
            const td = document.createElement('div');
            td.className = 'td';
            td.setAttribute('role', 'cell');
            td.style.left = `${left}px`;
            td.style.width = `${this.widths[i]}px`;
            const c = row.cells[i];
            if (c) {
                td.dataset.col = String(i);
                const value = valueElement(c);
                td.append(value, ...decorate(value, c, this.columns[i].key));
                if (isContainer(c.kind) && c.size) { td.classList.add('nested'); td.title = 'Show in the tree'; }
                if (this.matches.has(c.id)) { td.classList.add(c.id === this.currentMatch ? 'current-match' : 'match'); }
            } else {
                td.classList.add('missing');
            }
            el.append(td);
        }
        if (this.matches.has(row.id)) { index.classList.add(row.id === this.currentMatch ? 'current-match' : 'match'); }
        return el;
    }

    private rowAt(target: EventTarget | null): { r: number; row: TableRow } | undefined {
        const el = (target as HTMLElement).closest<HTMLElement>('.trow');
        if (!el) { return undefined; }
        const r = Number(el.dataset.r), start = Math.floor(r / PAGE) * PAGE;
        const row = this.pages.get(start)?.[r - start];
        return row && { r, row };
    }

    private click(e: MouseEvent) {
        const th = (e.target as HTMLElement).closest<HTMLElement>('.th[data-col]');
        if (th && !(e.target as HTMLElement).classList.contains('grip')) {
            this.cycleSort(Number(th.dataset.col));
            return;
        }
        const hit = this.rowAt(e.target);
        if (!hit) { return; }
        this.active = hit.r;
        this.scroller.focus({ preventScroll: true });
        const td = (e.target as HTMLElement).closest<HTMLElement>('.td.nested');
        const cell = td ? hit.row.cells[Number(td.dataset.col)] : null;
        if (cell) {
            this.actions.openInTree(this.version, cell.id);
            return;
        }
        this.actions.select(this.version, hit.row.id);
        this.paint();
        this.actions.onStateChange();
    }

    /** No sort → ascending → descending → no sort */
    private cycleSort(column: number) {
        if (this.sort?.column !== column) { this.sort = { column, desc: false }; }
        else if (!this.sort.desc) { this.sort = { column, desc: true }; }
        else { this.sort = null; }
        // Keep showing the old rows (dimmed) until the first rows in the new order arrive
        this.stale = new Map(this.pages);
        this.pages.clear();
        this.requested.clear();
        this.paint();
        this.actions.onStateChange();
    }
    private stale: Map<number, TableRow[]> | undefined;

    private resize(e: PointerEvent, i: number) {
        e.preventDefault();
        e.stopPropagation();
        const startX = e.clientX, startW = this.widths[i];
        const grip = e.target as HTMLElement;
        grip.setPointerCapture(e.pointerId);
        const move = (m: PointerEvent) => {
            this.widths[i] = Math.max(MIN_WIDTH, startW + m.clientX - startX);
            this.canvas.style.width = this.header.style.width = `${this.totalWidth}px`;
            this.schedulePaint();
        };
        const up = () => { grip.removeEventListener('pointermove', move); grip.removeEventListener('pointerup', up); };
        grip.addEventListener('pointermove', move);
        grip.addEventListener('pointerup', up);
    }

    private key(e: KeyboardEvent) {
        if (!this.info) { return; }
        const n = this.info.rows, pageRows = Math.max(1, Math.floor((this.scroller.clientHeight - HEADER_HEIGHT) / ROW_HEIGHT) - 1);
        let next = this.active;
        switch (e.key) {
            case 'ArrowDown': next++; break;
            case 'ArrowUp': next--; break;
            case 'PageDown': next += pageRows; break;
            case 'PageUp': next -= pageRows; break;
            case 'Home': next = 0; break;
            case 'End': next = n - 1; break;
            case 'Enter': {
                const start = Math.floor(this.active / PAGE) * PAGE, row = this.pages.get(start)?.[this.active - start];
                if (row) { this.actions.select(this.version, row.id); }
                e.preventDefault();
                return;
            }
            default: return;
        }
        e.preventDefault();
        this.active = Math.max(0, Math.min(n - 1, next));
        const y = HEADER_HEIGHT + this.active * ROW_HEIGHT, s = this.scroller;
        if (y - HEADER_HEIGHT < s.scrollTop) { s.scrollTop = y - HEADER_HEIGHT; }
        else if (y + ROW_HEIGHT > s.scrollTop + s.clientHeight) { s.scrollTop = y + ROW_HEIGHT - s.clientHeight; }
        this.paint();
    }
}
