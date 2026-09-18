import { HostMessage, ViewMessage } from '../src/protocol';
import { openMenu } from './menu';
import { SearchBox } from './search';
import { Tree, TreeState } from './tree';

interface ViewState extends TreeState { query?: string }
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
const tree = new Tree(treeEl, document.getElementById('rows')!, m => vscode.postMessage(m), () => {
    clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => vscode.setState({ ...tree.state, query: search.value }), 200);
}, {
    copy: (version, id, what) => vscode.postMessage({ type: 'copy', version, id, what }),
    menu: (x, y, version, id) => openMenu(x, y, [
        { label: 'Copy path', run: () => vscode.postMessage({ type: 'copy', version, id, what: 'path' }) },
        { label: 'Copy JSON Pointer', run: () => vscode.postMessage({ type: 'copy', version, id, what: 'pointer' }) },
        { label: 'Copy value', hint: isMac ? '⌘C' : 'Ctrl+C', run: () => vscode.postMessage({ type: 'copy', version, id, what: 'value' }) },
        { label: 'Reveal in file', hint: 'Enter', run: () => vscode.postMessage({ type: 'select', version, id }) },
    ], treeEl),
});

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
    (matches, current) => tree.setMatches(matches, current),
    () => treeEl.focus(),
);
const saved = vscode.getState();
if (saved) { tree.restore(saved); }

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
            treeEl.hidden = true;
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
            tree.reveal(m.version, m.path);
            break;
        case 'document': {
            problem = false;
            showStatus('');
            const first = treeEl.hidden || !loaded;
            if (loaded && m.version !== version) { search.newVersion(); }
            loaded = true;
            version = m.version;
            treeEl.hidden = false;
            tree.setDocument(m.version, m.root);
            // Only on first load: later versions arrive while the user is typing in the editor
            if (first) { treeEl.focus({ preventScroll: true }); }
            break;
        }
        case 'rows':
            tree.addRows(m.version, m.id, m.start, m.rows);
            break;
        case 'matches':
            search.receive(m);
            break;
        case 'toast':
            showToast(m.text);
            break;
    }
});

showStatus('Reading file…');
vscode.postMessage({ type: 'ready' });
if (saved?.query) { search.restore(saved.query); }
