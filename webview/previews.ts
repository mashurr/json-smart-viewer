// Small helpers shown next to values: colour swatches, dates for timestamps, and links.
// Everything is checked against a strict pattern first; nothing from the file becomes markup or CSS text.

import { Kind, Row } from '../src/protocol';

const HEX_COLOR = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const NUM = '[+-]?(?:\\d+\\.?\\d*|\\.\\d+)(?:%|deg|turn|rad)?';
const FUNC_COLOR = new RegExp(`^(?:rgb|hsl)a?\\(\\s*${NUM}(?:\\s*,\\s*|\\s+)${NUM}(?:\\s*,\\s*|\\s+)${NUM}(?:\\s*(?:,|/)\\s*${NUM})?\\s*\\)$`, 'i');
const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;
const URL = /^https?:\/\/[^\s"<>]+$/i;
// Keys that name a time; only then is a number read as a timestamp (so ids aren't mislabelled)
const TIME_WORD = /(?:time|date|stamp|created|updated|modified|expires|expiry|deadline)/i;
const TIME_SUFFIX = /(?:_at|At|_ts|Ts|^ts|_on|On)$/;
// Timestamps between 2000 and 2100, in seconds or milliseconds
const MIN_S = 946684800, MAX_S = 4102444800;

export const isTimeKey = (key: string | number | undefined) => typeof key === 'string' && (TIME_WORD.test(key) || TIME_SUFFIX.test(key));
export const isColor = (s: string) => HEX_COLOR.test(s) || FUNC_COLOR.test(s);

function relative(ms: number): string {
    const units: [Intl.RelativeTimeFormatUnit, number][] = [['year', 31536e6], ['month', 2592e6], ['week', 6048e5], ['day', 864e5], ['hour', 36e5], ['minute', 6e4], ['second', 1e3]];
    const diff = ms - Date.now();
    const fmt = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
    for (const [unit, size] of units) {
        if (Math.abs(diff) >= size || unit === 'second') { return fmt.format(Math.round(diff / size), unit); }
    }
    return '';
}

function hint(ms: number): HTMLElement {
    const el = document.createElement('span');
    el.className = 'hint';
    el.textContent = relative(ms);
    el.title = new Date(ms).toLocaleString(undefined, { dateStyle: 'full', timeStyle: 'long' });
    return el;
}

/**
 * Decorates a value element: a swatch before colours, a link style on URLs, and returns a
 * date hint to show after dates and timestamps (or nothing).
 */
export function decorate(value: HTMLElement, row: Pick<Row, 'kind' | 'text' | 'truncated'>, key?: string | number): HTMLElement[] {
    const text = row.text;
    if (text === undefined || row.truncated) { return []; }
    if (row.kind === Kind.String) {
        if (isColor(text)) {
            const swatch = document.createElement('span');
            swatch.className = 'swatch';
            // Set through the CSSOM after the pattern check; the CSP allows this, not inline style text
            swatch.style.backgroundColor = text;
            value.prepend(swatch);
            return [];
        }
        if (URL.test(text)) {
            value.classList.add('url');
            value.dataset.url = text;
            value.title = `${navigator.platform.toUpperCase().includes('MAC') ? '⌘' : 'Ctrl'}+click to open`;
            return [];
        }
        if (ISO_DATE.test(text)) {
            const ms = Date.parse(text.length === 10 ? text + 'T00:00:00' : text);
            return Number.isNaN(ms) ? [] : [hint(ms)];
        }
    } else if (row.kind === Kind.Number && isTimeKey(key) && /^\d+(?:\.\d+)?$/.test(text)) {
        const n = Number(text);
        if (n >= MIN_S && n <= MAX_S) { return [hint(n * 1000)]; }
        if (n >= MIN_S * 1000 && n <= MAX_S * 1000) { return [hint(n)]; }
    }
    return [];
}
