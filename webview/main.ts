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

function showStatus(text: string, error = false) {
    status.textContent = text;
    status.classList.toggle('error', error);
    status.hidden = !text;
}

window.addEventListener('message', (e: MessageEvent<HostMessage>) => {
    const m = e.data;
    switch (m.type) {
        case 'progress':
            showStatus(`Reading file… ${Math.floor((m.loaded / m.total) * 100)}%`);
            break;
        case 'invalid':
            treeEl.hidden = true;
            showStatus(m.line ? `Line ${m.line}, column ${m.column}: ${m.message}` : m.message, true);
            break;
        case 'document':
            showStatus('');
            treeEl.hidden = false;
            tree.setDocument(m.version, m.root);
            treeEl.focus({ preventScroll: true });
            break;
        case 'rows':
            tree.addRows(m.version, m.id, m.start, m.rows);
            break;
    }
});

showStatus('Reading file…');
vscode.postMessage({ type: 'ready' });
