import { HostMessage, ViewMessage } from '../src/protocol';
import { Tree, TreeState } from './tree';

interface VsCodeApi {
    postMessage(m: ViewMessage): void;
    getState(): TreeState | undefined;
    setState(s: TreeState): void;
}
declare function acquireVsCodeApi(): VsCodeApi;

const vscode = acquireVsCodeApi();
const status = document.getElementById('status')!;
const treeEl = document.getElementById('tree')!;

let saveTimer = 0;
const tree = new Tree(treeEl, document.getElementById('rows')!, m => vscode.postMessage(m), () => {
    clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => vscode.setState(tree.state), 200);
});
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
            loaded = true;
            treeEl.hidden = false;
            tree.setDocument(m.version, m.root);
            // Only on first load: later versions arrive while the user is typing in the editor
            if (first) { treeEl.focus({ preventScroll: true }); }
            break;
        }
        case 'rows':
            tree.addRows(m.version, m.id, m.start, m.rows);
            break;
    }
});

showStatus('Reading file…');
vscode.postMessage({ type: 'ready' });
