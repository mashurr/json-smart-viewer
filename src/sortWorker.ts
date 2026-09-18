// Sorts table rows off the extension host's thread; the result is the row order
import { parentPort } from 'worker_threads';

interface SortRequest { rank: Uint8Array; num: Float64Array; text: string; ends: Int32Array; desc: boolean }

parentPort!.once('message', ({ rank, num, text, ends, desc }: SortRequest) => {
    const str = Array.from(ends, (end, i) => text.slice(i ? ends[i - 1] : 0, end));
    const collator = new Intl.Collator(undefined, { numeric: true });
    const dir = desc ? -1 : 1;
    const order = new Int32Array(rank.length);
    for (let i = 0; i < order.length; i++) { order[i] = i; }
    order.sort((a, b) => {
        // Kinds in a fixed order either way; missing values (rank 5) always last
        if (rank[a] !== rank[b]) { return rank[a] === 5 ? 1 : rank[b] === 5 ? -1 : (rank[a] - rank[b]) * dir; }
        const d = rank[a] === 1 ? collator.compare(str[a], str[b]) : num[a] - num[b];
        return d !== 0 && !Number.isNaN(d) ? d * dir : a - b;
    });
    parentPort!.postMessage(order, [order.buffer]);
});
