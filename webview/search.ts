// The search box: sends queries, keeps the matches, and steps through them

import { HostMessage, ViewMessage } from '../src/protocol';

// Wait for typing to pause before searching
const TYPING_MS = 150;

type Matches = Extract<HostMessage, { type: 'matches' }>;

export class SearchBox {
    private query = '';
    private ids: number[] = [];
    private set = new Set<number>();
    private total = 0;
    private capped = false;
    private done = true;
    private current = -1;
    private version = -1;
    /** Jump to the first match once it arrives (only for a query the user just typed) */
    private jump = false;
    private timer = 0;

    constructor(
        private readonly input: HTMLInputElement,
        private readonly count: HTMLElement,
        prev: HTMLButtonElement,
        next: HTMLButtonElement,
        private readonly send: (m: ViewMessage) => void,
        private readonly onChange: (matches: ReadonlySet<number>, current: number | undefined) => void,
        private readonly onDone: () => void,
    ) {
        input.addEventListener('input', () => {
            clearTimeout(this.timer);
            this.timer = window.setTimeout(() => this.setQuery(input.value), TYPING_MS);
        });
        input.addEventListener('keydown', e => {
            if (e.key === 'Enter') {
                e.preventDefault();
                // Search right away if the query changed but the timer hasn't fired yet
                if (input.value !== this.query) { clearTimeout(this.timer); this.setQuery(input.value); return; }
                this.go(this.current + (e.shiftKey ? -1 : 1));
            } else if (e.key === 'Escape') {
                e.preventDefault();
                input.value = '';
                this.setQuery('');
                this.onDone();
            }
        });
        prev.addEventListener('click', () => this.go(this.current - 1));
        next.addEventListener('click', () => this.go(this.current + 1));
        window.addEventListener('keydown', e => {
            if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'f') {
                e.preventDefault();
                input.focus();
                input.select();
            }
        });
    }

    get value(): string { return this.query; }

    /** Restores a query after the panel reloads */
    restore(query: string) {
        this.input.value = query;
        if (query) { this.setQuery(query, false); }
    }

    private setQuery(query: string, jump = true) {
        this.query = query;
        this.ids = [];
        this.set = new Set();
        this.total = 0;
        this.capped = false;
        this.done = !query;
        this.current = -1;
        this.jump = jump && !!query;
        this.send({ type: 'search', query });
        this.update();
    }

    /** A new document version: the old ids mean nothing until the new matches arrive */
    newVersion() {
        this.ids = [];
        this.set = new Set();
        this.update();
    }

    receive(m: Matches) {
        if (m.query !== this.query) { return; }
        if (m.reset) {
            this.ids = [];
            this.set = new Set();
        }
        this.version = m.version;
        for (const id of m.ids) { this.ids.push(id); this.set.add(id); }
        this.total = m.total;
        this.capped = m.capped;
        this.done = m.done;
        if (this.jump && this.ids.length) {
            this.jump = false;
            this.go(0);
            return;
        }
        if (this.current >= this.ids.length) { this.current = this.ids.length - 1; }
        this.update();
    }

    private go(index: number) {
        const n = this.ids.length;
        if (!n) { return; }
        this.current = ((index % n) + n) % n;
        this.send({ type: 'revealNode', version: this.version, id: this.ids[this.current] });
        this.update();
    }

    private update() {
        const total = this.total.toLocaleString() + (this.capped ? '+' : '');
        let text = '';
        if (this.query) {
            if (!this.total) { text = this.done ? 'No results' : 'Searching…'; }
            else if (this.current >= 0) { text = `${(this.current + 1).toLocaleString()} of ${total}${this.done ? '' : '…'}`; }
            else { text = `${total} match${this.total === 1 ? '' : 'es'}${this.done ? '' : '…'}`; }
        }
        this.count.textContent = text;
        this.input.classList.toggle('no-results', !!this.query && this.done && !this.total);
        this.onChange(this.set, this.current >= 0 ? this.ids[this.current] : undefined);
    }
}
