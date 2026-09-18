// Edits made since the index was built, so offsets in the indexed text and in the
// current document can be mapped onto each other while a rebuild is pending.

export interface Change {
    /** Offset in the text before this edit */
    offset: number;
    removed: number;
    inserted: number;
}

export class EditLog {
    // One entry per edit event; changes within an event all refer to the text before it
    private events: Change[][] = [];

    get length(): number { return this.events.length; }

    add(changes: readonly { rangeOffset: number; rangeLength: number; text: string }[]) {
        if (!changes.length) { return; }
        this.events.push(changes.map(c => ({ offset: c.rangeOffset, removed: c.rangeLength, inserted: c.text.length })).sort((a, b) => a.offset - b.offset));
    }

    /** Forgets the first `n` events, once an index includes them */
    drop(n: number) { this.events = this.events.slice(n); }

    /**
     * Indexed text offset → current document offset. Inside an edited span, a range start
     * stays at the start of the edit and a range end moves to the end of the inserted text.
     */
    forward(x: number, edge: 'start' | 'end'): number {
        for (const changes of this.events) {
            let delta = 0;
            let mapped: number | undefined;
            for (const c of changes) {
                // Edits ending at or before x (including insertions right at x) shift it
                if (c.offset + c.removed <= x) {
                    delta += c.inserted - c.removed;
                } else if (c.offset < x) {
                    mapped = (edge === 'start' ? c.offset : c.offset + c.inserted) + delta;
                    break;
                } else {
                    break;
                }
            }
            x = mapped ?? x + delta;
        }
        return x;
    }

    /** Current document offset → indexed text offset. Offsets inside inserted text map to the edit's start. */
    backward(y: number): number {
        for (let e = this.events.length - 1; e >= 0; e--) {
            let delta = 0;
            let mapped: number | undefined;
            for (const c of this.events[e]) {
                const start = c.offset + delta, end = start + c.inserted;
                if (end <= y) {
                    delta += c.inserted - c.removed;
                } else if (start < y) {
                    mapped = c.offset;
                    break;
                } else {
                    break;
                }
            }
            y = mapped ?? y - delta;
        }
        return y;
    }
}
