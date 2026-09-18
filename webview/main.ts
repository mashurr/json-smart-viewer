import { HostMessage, TableSort, ViewMessage } from '../src/protocol';
import { openMenu } from './menu';
import { SearchBox } from './search';
import { TableView } from './table';
import { GraphState, GraphView } from './graph';
import { Tree, TreeState } from './tree';

interface ViewState extends TreeState {
    query?: string;
    view?: View;
    /** The table on show, by JSON Pointer, and its sort */
    table?: string;
    sort?: TableSort | null;
    graph?: GraphState;
}
type View = 'tree' | 'table' | 'graph';
interface VsCodeApi {
    postMessage(m: ViewMessage): void;
    getState(): ViewState | undefined;
    setState(s: ViewState): void;
}
declare function acquireVsCodeApi(): VsCodeApi;

const vscode = acquireVsCodeApi();
const status = document.getElementById('status')!;
const treeEl = document.getElementById('tree')!;

let saveTimer = 0;
const isMac = navigator.platform.toUpperCase().includes('MAC');
function saveState() {
    clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => vscode.setState({ ...tree.state, query: search.value, view, table: table.pointer, sort: table.sortState, graph: graph.state }), 200);
}
const tree = new Tree(treeEl, document.getElementById('rows')!, m => vscode.postMessage(m), saveState, {
    copy: (version, id, what) => vscode.postMessage({ type: 'copy', version, id, what }),
    menu: (x, y, version, id) => rowMenu(x, y, version, id),
});

/** The menu for a row in the tree or the table */
function rowMenu(x: number, y: number, version: number, id: number) {
    openMenu(x, y, [
        { label: 'Copy path', run: () => vscode.postMessage({ type: 'copy', version, id, what: 'path' }) },
        { label: 'Copy JSON Pointer', run: () => vscode.postMessage({ type: 'copy', version, id, what: 'pointer' }) },
        { label: 'Copy value', hint: isMac ? '⌘C' : 'Ctrl+C', run: () => vscode.postMessage({ type: 'copy', version, id, what: 'value' }) },
        { label: 'Reveal in file', hint: 'Enter', run: () => vscode.postMessage({ type: 'select', version, id }) },
        { label: 'Open as table', run: () => vscode.postMessage({ type: 'openTable', version, id }) },
    ], view === 'table' ? tableEl : treeEl);
}

// Tree | Table
const tableEl = document.getElementById('table')!;
const tableBar = document.getElementById('tablebar')!;
const graphEl = document.getElementById('graph')!;
const viewButtons = { tree: document.getElementById('view-tree')!, table: document.getElementById('view-table')!, graph: document.getElementById('view-graph')! };
let view: View = 'tree';
let tablesAsked = -1;
const table = new TableView(tableEl, {
    select: document.getElementById('table-select') as HTMLSelectElement,
    note: document.getElementById('table-note')!,
}, m => vscode.postMessage(m), {
    select: (version, id) => vscode.postMessage({ type: 'select', version, id }),
    menu: rowMenu,
    openInTree: (version, id) => { setView('tree'); vscode.postMessage({ type: 'revealNode', version, id }); },
    onStateChange: saveState,
});
const graph = new GraphView(graphEl, m => vscode.postMessage(m), {
    select: (version, id) => vscode.postMessage({ type: 'select', version, id }),
    menu: rowMenu,
    onStateChange: saveState,
});
function showViews() {
    treeEl.hidden = view !== 'tree' || !loaded;
    tableEl.hidden = tableBar.hidden = view !== 'table' || !loaded;
    graphEl.hidden = view !== 'graph' || !loaded;
    document.getElementById('tree-tools')!.hidden = view !== 'tree';
}
function setView(next: View) {
    view = next;
    showViews();
    for (const [v, b] of Object.entries(viewButtons)) { b.setAttribute('aria-selected', String(v === next)); }
    if (next === 'table' && loaded) {
        if (tablesAsked !== version) { tablesAsked = version; vscode.postMessage({ type: 'tables', version }); }
        tableEl.focus({ preventScroll: true });
    } else if (next === 'graph' && loaded) {
        graphEl.focus({ preventScroll: true });
    } else if (loaded) {
        treeEl.focus({ preventScroll: true });
    }
    saveState();
}
viewButtons.tree.addEventListener('click', () => setView('tree'));
viewButtons.table.addEventListener('click', () => setView('table'));
viewButtons.graph.addEventListener('click', () => setView('graph'));
document.getElementById('expand-all')!.addEventListener('click', () => tree.expandAll());
document.getElementById('collapse-all')!.addEventListener('click', () => tree.collapseAll());
// Ctrl/Cmd+click on a link opens it (the extension checks it's http or https); a plain click selects as usual
document.addEventListener('click', e => {
    const link = (e.target as HTMLElement).closest<HTMLElement>('.url');
    if (link?.dataset.url && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        e.stopPropagation();
        vscode.postMessage({ type: 'openUrl', url: link.dataset.url });
    }
}, true);

const toast = document.getElementById('toast')!;
let toastTimer = 0;
function showToast(text: string) {
    toast.textContent = text;
    toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => { toast.hidden = true; }, 1800);
}
const search = new SearchBox(
    document.getElementById('search') as HTMLInputElement,
    document.getElementById('count')!,
    document.getElementById('prev') as HTMLButtonElement,
    document.getElementById('next') as HTMLButtonElement,
    m => vscode.postMessage(m),
    (matches, current) => { tree.setMatches(matches, current); table.setMatches(matches, current); graph.setMatches(matches, current); },
    () => treeEl.focus(),
);
const saved = vscode.getState();
if (saved) {
    tree.restore(saved);
    view = saved.view ?? 'tree';
    table.restoreSort(saved.sort ?? null);
    if (saved.graph) { graph.restore(saved.graph); }
}

function showStatus(text: string, kind: '' | 'error' | 'note' = '') {
    status.textContent = text;
    status.className = `status ${kind}`;
    status.hidden = !text;
}
// An edit that made the file invalid; stays until a valid version arrives
let problem = false;
let loaded = false;
let version = -1;

window.addEventListener('message', (e: MessageEvent<HostMessage>) => {
    const m = e.data;
    switch (m.type) {
        case 'progress':
            showStatus(`Reading file… ${Math.floor((m.loaded / m.total) * 100)}%`);
            break;
        case 'invalid':
            treeEl.hidden = tableEl.hidden = tableBar.hidden = graphEl.hidden = true;
            showStatus(m.line ? `Line ${m.line}, column ${m.column}: ${m.message}` : m.message, 'error');
            break;
        case 'editing':
            if (!problem) { showStatus('Editing… the view updates when you pause.', 'note'); }
            break;
        case 'problem':
            problem = true;
            showStatus(`${m.line ? `Line ${m.line}, column ${m.column}: ` : ''}${m.message} — showing the last valid version.`, 'error');
            break;
        case 'reveal':
            if (view === 'graph') { graph.reveal(m.version, m.path, m.pages); } else { tree.reveal(m.version, m.path, m.pages); }
            break;
        case 'document': {
            problem = false;
            showStatus('');
            const first = !loaded;
            const changed = loaded && m.version !== version;
            if (changed) { search.newVersion(); }
            loaded = true;
            version = m.version;
            tree.setDocument(m.version, m.root);
            graph.setDocument(m.version, m.root);
            // The open table is found again by its pointer; ids change with every version
            const pointer = table.pointer ?? (first ? saved?.table : undefined);
            if ((first || changed) && view === 'table' && pointer !== undefined) { vscode.postMessage({ type: 'openTable', version, pointer }); }
            // Focus only on first load: later versions arrive while the user is typing in the editor
            if (first) { setView(view); } else { showViews(); }
            break;
        }
        case 'rows':
            tree.addRows(m.version, m.id, m.start, m.rows);
            graph.addRows(m.version, m.id, m.start, m.rows);
            break;
        case 'matches':
            search.receive(m);
            break;
        case 'toast':
            showToast(m.text);
            break;
        case 'decoded':
            tree.setDecoded(m.version, m.id, m.root);
            if (m.error) { showToast(m.error); }
            break;
        case 'tables':
            table.setTables(m.version, m.tables);
            // Nothing chosen yet: show the biggest table
            if (view === 'table' && !table.shown && m.tables.length) { vscode.postMessage({ type: 'openTable', version: m.version, id: m.tables[0].id }); }
            if (view === 'table' && !m.tables.length) { table.setStatus('No arrays or objects of objects in this file'); }
            break;
        case 'table':
            table.setTable(m.version, m.info, m.columns, m.more);
            if (view !== 'table') { setView('table'); }
            break;
        case 'tableRows':
            table.addRows(m.version, m.id, m.start, m.sort, m.rows);
            break;
        case 'tableStatus':
            table.setStatus(m.text);
            break;
    }
});

showStatus('Reading file…');
vscode.postMessage({ type: 'ready' });
if (saved?.query) { search.restore(saved.query); }
