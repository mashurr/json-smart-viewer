import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { HostMessage, Kind, PAGE, ViewMessage } from './protocol';
import { EditLog } from './editLog';
import { Build, buildIndex } from './index/build';
import { JsonIndex } from './index/query';
import { isScanError } from './index/scanner';
import { Searcher } from './search';
import { accessorPath, formatJson, jsonPointer } from './copy';

// How often indexing progress is sent to the webview
const PROGRESS_MS = 100;
// Rebuild once typing pauses for this long (or twice the last build time, if longer)
const QUIET_MS = 300;
// Only report invalid text after it has stayed invalid this long, so pauses mid-word don't flash errors
const PROBLEM_DELAY_MS = 1500;
// Wait for the cursor to settle before revealing it in the viewer
const CURSOR_MS = 100;
// Files changed on disk are re-read after this long
const DISK_CHANGE_MS = 500;
// A selection event this soon after the viewer selected the same range is the viewer's own
const OWN_SELECTION_MS = 1000;
// Clicking a value bigger than this selects only its start in the editor
const MAX_SELECT_CHARS = 10000;
// Copying a value bigger than this asks first
const CONFIRM_COPY_CHARS = 50_000_000;

/** A viewer for one file, linked to its editor */
export class ViewerPanel {
    private static readonly panels = new Map<string, ViewerPanel>();

    static show(context: vscode.ExtensionContext, uri: vscode.Uri, document: vscode.TextDocument | undefined, sourceColumn: vscode.ViewColumn | undefined) {
        const open = ViewerPanel.panels.get(uri.toString());
        if (open) {
            open.panel.reveal(undefined, true);
            return;
        }
        ViewerPanel.panels.set(uri.toString(), new ViewerPanel(context, uri, document, sourceColumn));
    }

    private readonly panel: vscode.WebviewPanel;
    private readonly fileName: string;
    private index: JsonIndex | undefined;
    /** Shown instead of the tree when there's no valid version to show */
    private invalid: HostMessage | undefined;
    /** Latest error in edited text while the last valid version stays on screen */
    private problem: HostMessage | undefined;
    private problemSince: number | undefined;
    private problemTimer: NodeJS.Timeout | undefined;
    private problemShown = false;
    private build: Build | undefined;
    private lastBuildMs = 0;
    private rebuildTimer: NodeJS.Timeout | undefined;
    private cursorTimer: NodeJS.Timeout | undefined;
    private progress: HostMessage | undefined;
    private viewReady = false;
    private edits = new EditLog();
    private watcher: vscode.FileSystemWatcher | undefined;
    private lineStarts: Int32Array | undefined;
    private ownSelection: { selection: vscode.Selection; at: number } | undefined;
    private readonly searcher = new Searcher();
    private query = '';
    private readonly disposables: vscode.Disposable[] = [];

    /** `document` is absent for files VS Code doesn't share with extensions (over 50 MB) or that aren't open */
    private constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly uri: vscode.Uri,
        private document: vscode.TextDocument | undefined,
        private readonly sourceColumn: vscode.ViewColumn | undefined,
    ) {
        const roots = ['media', 'out'].map(d => vscode.Uri.file(path.join(context.extensionPath, d)));
        this.fileName = path.posix.basename(uri.path);
        this.panel = vscode.window.createWebviewPanel('jsonSmartViewer', `JSON Smart View: ${this.fileName}`,
            { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
            { enableScripts: true, localResourceRoots: roots });
        this.panel.webview.html = this.html();
        this.panel.webview.onDidReceiveMessage((m: ViewMessage) => this.receive(m), undefined, this.disposables);
        this.panel.onDidDispose(() => this.dispose(), undefined, this.disposables);

        const isMine = (d: vscode.TextDocument) => d.uri.toString() === uri.toString();
        this.disposables.push(
            vscode.workspace.onDidChangeTextDocument(e => {
                if (e.document === this.document && e.contentChanges.length) { this.edited(e.contentChanges); }
            }),
            vscode.workspace.onDidOpenTextDocument(d => { if (isMine(d) && !this.document) { this.follow(d); } }),
            vscode.workspace.onDidCloseTextDocument(d => { if (d === this.document) { this.follow(undefined); } }),
            vscode.window.onDidChangeTextEditorSelection(e => {
                if (e.textEditor.document !== this.document) { return; }
                // Skip the selection the viewer itself just made; follow every other move (keys, mouse, Go to Symbol, Find…)
                const own = this.ownSelection;
                if (own && Date.now() - own.at < OWN_SELECTION_MS && e.selections.length === 1 && e.selections[0].isEqual(own.selection)) { return; }
                clearTimeout(this.cursorTimer);
                this.cursorTimer = setTimeout(() => this.revealCursor(e.textEditor.selection.active), CURSOR_MS);
            }),
        );
        if (!document) { this.watchDisk(); }
        void this.rebuild();
    }

    /** Switches between following the open document and the file on disk */
    private follow(document: vscode.TextDocument | undefined) {
        this.document = document;
        this.edits = new EditLog();
        this.watcher?.dispose();
        this.watcher = undefined;
        if (!document) { this.watchDisk(); }
        this.scheduleRebuild(0);
    }

    private watchDisk() {
        const dir = vscode.Uri.joinPath(this.uri, '..');
        this.watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(dir, this.fileName));
        const changed = () => this.scheduleRebuild(DISK_CHANGE_MS);
        this.watcher.onDidChange(changed);
        this.watcher.onDidCreate(changed);
    }

    private edited(changes: readonly vscode.TextDocumentContentChangeEvent[]) {
        this.edits.add(changes);
        this.post({ type: 'editing' });
        this.build?.cancel();
        this.build = undefined;
        this.scheduleRebuild(Math.max(QUIET_MS, 2 * this.lastBuildMs));
    }

    private scheduleRebuild(ms: number) {
        clearTimeout(this.rebuildTimer);
        this.rebuildTimer = setTimeout(() => void this.rebuild(), ms);
    }

    private async readText(): Promise<{ text: string; version: number; bytes?: Uint8Array }> {
        if (this.document) { return { text: this.document.getText(), version: this.document.version }; }
        const bytes = await vscode.workspace.fs.readFile(this.uri);
        // Same decoding as the editor: UTF-8 without the byte order mark. Decoded in one go: pieces decoded
        // separately come back as two-byte strings, doubling the memory the text takes.
        return { text: new TextDecoder('utf-8', { ignoreBOM: false }).decode(bytes), version: Date.now(), bytes };
    }

    private async rebuild() {
        this.build?.cancel();
        this.build = undefined;
        // Edits made after this point are relative to the text read now
        const editsIncluded = this.edits.length;
        let text: string, version: number, bytes: Uint8Array | undefined;
        try {
            ({ text, version, bytes } = await this.readText());
        } catch (e) {
            this.fail(`Could not read the file: ${e instanceof Error ? e.message : String(e)}`, 0, 0);
            return;
        }
        // Let other work run between decoding the file and handing it to the worker
        if (bytes) { await new Promise(resolve => setImmediate(resolve)); }
        let lastProgress = 0;
        const started = Date.now();
        const build = buildIndex(this.context.extensionPath, text, false, offset => {
            const now = Date.now();
            if (now - lastProgress < PROGRESS_MS || this.index) { return; }
            lastProgress = now;
            this.progress = { type: 'progress', loaded: offset, total: text.length };
            this.post(this.progress);
        }, bytes);
        this.build = build;
        build.result.then(result => {
            if (this.build !== build) { return; }
            this.build = undefined;
            this.lastBuildMs = Date.now() - started;
            if (isScanError(result)) {
                const at = result.offset < 0 ? { line: 0, column: 0 } : lineColumn(text, result.offset);
                this.fail(result.message, at.line, at.column);
                return;
            }
            this.edits.drop(editsIncluded);
            this.invalid = this.problem = this.problemSince = undefined;
            clearTimeout(this.problemTimer);
            this.problemTimer = undefined;
            this.problemShown = false;
            this.lineStarts = undefined;
            this.index = new JsonIndex(text, result, version);
            this.post(this.documentMessage());
            // Matches are node ids, which change with every version
            if (this.query) { void this.runSearch(); }
        }, (e: unknown) => this.fail(`Could not read the file: ${e instanceof Error ? e.message : String(e)}`, 0, 0));
    }

    private fail(message: string, line: number, column: number) {
        if (!this.index) {
            // Nothing valid to show yet
            this.invalid = { type: 'invalid', message, line, column };
            this.post(this.invalid);
            return;
        }
        this.problem = { type: 'problem', message, line, column };
        this.problemSince ??= Date.now();
        if (this.problemShown) {
            this.post(this.problem);
        } else if (!this.problemTimer) {
            this.problemTimer = setTimeout(() => {
                this.problemTimer = undefined;
                if (this.problem) {
                    this.problemShown = true;
                    this.post(this.problem);
                }
            }, Math.max(0, this.problemSince + PROBLEM_DELAY_MS - Date.now()));
        }
    }

    private documentMessage(): HostMessage {
        const ix = this.index!;
        return { type: 'document', version: ix.version, fileName: this.fileName, root: ix.row(ix.root) };
    }

    private receive(m: ViewMessage) {
        const ix = this.index;
        switch (m.type) {
            case 'ready':
                // Sent on every load, including when a hidden panel is shown again
                this.viewReady = true;
                if (this.invalid) { this.post(this.invalid); return; }
                if (ix) { this.post(this.documentMessage()); }
                else if (this.progress) { this.post(this.progress); }
                if (this.problemShown && this.problem) { this.post(this.problem); }
                break;
            case 'search':
                this.query = m.query;
                void this.runSearch();
                break;
            case 'copy':
                if (!ix || m.version !== ix.version || !(m.id >= 0 && m.id < ix.data.count)) { return; }
                void this.copy(ix, m.id, m.what);
                break;
            case 'revealNode': {
                if (!ix || m.version !== ix.version || !(m.id > 0 && m.id < ix.data.count)) { return; }
                this.post({ type: 'reveal', version: ix.version, path: ix.pathAt(ix.hitStart(m.id)).path });
                break;
            }
            case 'children': {
                if (!ix || m.version !== ix.version || !(m.id >= 0 && m.id < ix.data.count)) { return; }
                const count = Math.min(Math.max(0, m.count), PAGE);
                this.post({ type: 'rows', version: ix.version, id: m.id, start: m.start, rows: ix.rows(m.id, m.start, count) });
                break;
            }
            case 'select': {
                if (!ix || m.version !== ix.version || !(m.id >= 0 && m.id < ix.data.count)) { return; }
                // The whole value when it's small; otherwise its start, so the editor never selects megabytes
                const start = ix.hitStart(m.id), end = ix.end(m.id) - start <= MAX_SELECT_CHARS ? ix.end(m.id) : ix.start(m.id) + 1;
                void this.selectInEditor(this.edits.forward(start, 'start'), this.edits.forward(end, 'end'));
                break;
            }
        }
    }

    /** Selects a range of the current text in the file's editor, opening it beside the viewer if needed */
    private async selectInEditor(start: number, end: number) {
        const document = this.document;
        if (document) {
            const range = new vscode.Range(document.positionAt(start), document.positionAt(end));
            this.ownSelection = { selection: new vscode.Selection(range.start, range.end), at: Date.now() };
            const editor = vscode.window.visibleTextEditors.find(e => e.document === document);
            if (editor) {
                editor.selection = this.ownSelection.selection;
                editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
                return;
            }
            await vscode.window.showTextDocument(document, { viewColumn: this.otherColumn(), preserveFocus: true, selection: range });
            return;
        }
        // Not shared with extensions: open the file at a range computed from our own copy of the text
        const range = new vscode.Range(this.position(start), this.position(end));
        await vscode.commands.executeCommand('vscode.open', this.uri, { viewColumn: this.otherColumn(), preserveFocus: true, selection: range });
    }

    private otherColumn(): vscode.ViewColumn {
        if (this.sourceColumn && this.sourceColumn !== this.panel.viewColumn) { return this.sourceColumn; }
        return this.panel.viewColumn === vscode.ViewColumn.One ? vscode.ViewColumn.Two : vscode.ViewColumn.One;
    }

    /** Editor position of an offset in the indexed text, with line starts found once and reused */
    private position(offset: number): vscode.Position {
        const text = this.index!.text;
        if (!this.lineStarts) {
            const starts: number[] = [text.charCodeAt(0) === 0xfeff ? 1 : 0];
            for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) { starts.push(i + 1); }
            this.lineStarts = Int32Array.from(starts);
        }
        const s = this.lineStarts;
        let lo = 0, hi = s.length - 1;
        while (lo < hi) {
            const mid = (lo + hi + 1) >> 1;
            if (s[mid] <= offset) { lo = mid; } else { hi = mid - 1; }
        }
        return new vscode.Position(lo, offset - s[lo]);
    }

    private revealCursor(position: vscode.Position) {
        const ix = this.index, document = this.document;
        if (!ix || !document) { return; }
        const { path: steps } = ix.pathAt(this.edits.backward(document.offsetAt(position)));
        if (steps.length) { this.post({ type: 'reveal', version: ix.version, path: steps }); }
    }

    private async copy(ix: JsonIndex, id: number, what: 'path' | 'pointer' | 'value') {
        const steps = ix.pathAt(ix.hitStart(id)).path;
        const where = accessorPath(steps);
        let text: string, toast: string;
        if (what === 'path') {
            text = where;
            toast = `Copied path ${where}`;
        } else if (what === 'pointer') {
            text = jsonPointer(steps);
            toast = `Copied JSON Pointer ${text || '(root)'}`;
        } else {
            const start = ix.start(id), end = ix.end(id);
            if (end - start > CONFIRM_COPY_CHARS) {
                const size = `${Math.round((end - start) / 1e6)} MB`;
                const go = await vscode.window.showWarningMessage(`Copy ${size} to the clipboard?`, { modal: true }, 'Copy');
                if (go !== 'Copy') { return; }
            }
            const kind = ix.kind(id);
            // Strings copy as their text; objects and arrays as indented JSON; numbers and literals as written
            text = kind === Kind.String ? JSON.parse(ix.text.slice(start, end)) as string
                : kind === Kind.Object || kind === Kind.Array ? formatJson(ix.text, start, end)
                : ix.text.slice(start, end);
            toast = `Copied value of ${where}`;
        }
        await vscode.env.clipboard.writeText(text);
        this.post({ type: 'toast', text: toast });
    }

    private async runSearch() {
        const ix = this.index, query = this.query;
        if (!ix || !query) {
            this.searcher.cancel();
            if (ix) { this.post({ type: 'matches', version: ix.version, query, reset: true, ids: [], total: 0, capped: false, done: true }); }
            return;
        }
        let reset = true;
        await this.searcher.search(ix, query, batch => {
            this.post({ type: 'matches', version: ix.version, query, reset, ...batch });
            reset = false;
        });
    }

    private post(m: HostMessage) {
        if (this.viewReady) { void this.panel.webview.postMessage(m); }
    }

    private html(): string {
        const webview = this.panel.webview;
        const nonce = crypto.randomBytes(16).toString('hex');
        const uri = (...p: string[]) => webview.asWebviewUri(vscode.Uri.file(path.join(this.context.extensionPath, ...p))).toString();
        return fs.readFileSync(path.join(this.context.extensionPath, 'media', 'index.html'), 'utf8')
            .replace(/{{NONCE}}/g, () => nonce)
            .replace('{{CSP_SOURCE}}', () => webview.cspSource)
            .replace('{{STYLE_URI}}', () => uri('media', 'viewer.css'))
            .replace('{{SCRIPT_URI}}', () => uri('out', 'webview.js'));
    }

    private dispose() {
        ViewerPanel.panels.delete(this.uri.toString());
        this.build?.cancel();
        this.searcher.cancel();
        clearTimeout(this.rebuildTimer);
        clearTimeout(this.problemTimer);
        clearTimeout(this.cursorTimer);
        this.watcher?.dispose();
        this.disposables.forEach(d => d.dispose());
    }
}

/** 1-based line and column of an offset, counting a BOM as nothing and CRLF as one line break */
export function lineColumn(text: string, offset: number): { line: number; column: number } {
    let line = 1, lineStart = text.charCodeAt(0) === 0xfeff ? 1 : 0;
    for (let i = text.indexOf('\n', lineStart); i >= 0 && i < offset; i = text.indexOf('\n', i + 1)) {
        line++;
        lineStart = i + 1;
    }
    return { line, column: offset - lineStart + 1 };
}
