import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { HostMessage, PAGE, ViewMessage } from './protocol';
import { Build, buildIndex } from './index/build';
import { JsonIndex } from './index/query';
import { isScanError } from './index/scanner';

// How often indexing progress is sent to the webview
const PROGRESS_MS = 100;

/** A viewer for one document */
export class ViewerPanel {
    private readonly panel: vscode.WebviewPanel;
    private index: JsonIndex | undefined;
    private invalid: HostMessage | undefined;
    private build: Build | undefined;
    private progress: HostMessage | undefined;
    private viewReady = false;
    private readonly disposables: vscode.Disposable[] = [];

    private readonly fileName: string;

    /** `document` is absent for files VS Code doesn't share with extensions (over 50 MB) */
    constructor(private readonly context: vscode.ExtensionContext, private readonly uri: vscode.Uri, private readonly document: vscode.TextDocument | undefined) {
        const roots = ['media', 'out'].map(d => vscode.Uri.file(path.join(context.extensionPath, d)));
        this.fileName = path.posix.basename(uri.path);
        this.panel = vscode.window.createWebviewPanel('jsonSmartViewer', `JSON Smart View: ${this.fileName}`, vscode.ViewColumn.One, {
            enableScripts: true,
            localResourceRoots: roots,
        });
        this.panel.webview.html = this.html();
        this.panel.webview.onDidReceiveMessage((m: ViewMessage) => this.receive(m), undefined, this.disposables);
        this.panel.onDidDispose(() => this.dispose(), undefined, this.disposables);
        void this.rebuild();
    }

    private async readText(): Promise<{ text: string; version: number }> {
        if (this.document) { return { text: this.document.getText(), version: this.document.version }; }
        const bytes = await vscode.workspace.fs.readFile(this.uri);
        // Same decoding as the editor: UTF-8 without the byte order mark
        return { text: new TextDecoder('utf-8', { ignoreBOM: false }).decode(bytes), version: Date.now() };
    }

    private async rebuild() {
        this.build?.cancel();
        let text: string, version: number;
        try {
            ({ text, version } = await this.readText());
        } catch (e) {
            this.invalid = { type: 'invalid', message: `Could not read the file: ${e instanceof Error ? e.message : String(e)}`, line: 0, column: 0 };
            this.post(this.invalid);
            return;
        }
        let lastProgress = 0;
        const build = buildIndex(this.context.extensionPath, text, false, offset => {
            const now = Date.now();
            if (now - lastProgress < PROGRESS_MS) { return; }
            lastProgress = now;
            this.progress = { type: 'progress', loaded: offset, total: text.length };
            this.post(this.progress);
        });
        this.build = build;
        build.result.then(result => {
            if (this.build !== build) { return; }
            this.build = undefined;
            if (isScanError(result)) {
                const at = result.offset < 0 ? { line: 0, column: 0 } : lineColumn(text, result.offset);
                this.invalid = { type: 'invalid', message: result.message, line: at.line, column: at.column };
                this.post(this.invalid);
                return;
            }
            this.invalid = undefined;
            this.index = new JsonIndex(text, result, version);
            this.post(this.documentMessage());
        }, (e: unknown) => {
            this.invalid = { type: 'invalid', message: `Could not read the file: ${e instanceof Error ? e.message : String(e)}`, line: 0, column: 0 };
            this.post(this.invalid);
        });
    }

    private documentMessage(): HostMessage {
        const ix = this.index!;
        return { type: 'document', version: ix.version, fileName: this.fileName, root: ix.row(ix.root) };
    }

    private receive(m: ViewMessage) {
        switch (m.type) {
            case 'ready':
                // Sent on every load, including when a hidden panel is shown again
                this.viewReady = true;
                if (this.invalid) { this.post(this.invalid); }
                else if (this.index) { this.post(this.documentMessage()); }
                else if (this.progress) { this.post(this.progress); }
                break;
            case 'children': {
                const ix = this.index;
                if (!ix || m.version !== ix.version || m.id < 0 || m.id >= ix.data.count) { return; }
                const count = Math.min(Math.max(0, m.count), PAGE);
                this.post({ type: 'rows', version: ix.version, id: m.id, start: m.start, rows: ix.rows(m.id, m.start, count) });
                break;
            }
        }
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
        this.build?.cancel();
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
