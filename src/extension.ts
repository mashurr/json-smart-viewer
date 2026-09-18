import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

export function activate(context: vscode.ExtensionContext) {
    const disposable = vscode.commands.registerCommand('json-smart-viewer.show', () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.document.languageId !== 'json') {
            vscode.window.showInformationMessage('This is not a JSON file.');
            return;
        }

        let jsonData: unknown;
        try {
            jsonData = JSON.parse(editor.document.getText());
        } catch (e) {
            vscode.window.showErrorMessage(`Invalid JSON: ${e instanceof Error ? e.message : String(e)}`);
            return;
        }

        const mediaPath = path.join(context.extensionPath, 'media');
        const panel = vscode.window.createWebviewPanel(
            'jsonSmartViewer',
            'JSON Smart View',
            vscode.ViewColumn.One,
            {
                enableScripts: true,
                localResourceRoots: [vscode.Uri.file(mediaPath)]
            }
        );

        // Load the HTML template
        let htmlContent = fs.readFileSync(path.join(mediaPath, 'index.html'), 'utf8');

        // Replace placeholders with actual content
        const nonce = getNonce();
        const styleUri = panel.webview.asWebviewUri(vscode.Uri.file(path.join(mediaPath, 'viewer.css')));
        htmlContent = htmlContent
            .replace(/{{NONCE}}/g, nonce)
            .replace('{{CSP_SOURCE}}', panel.webview.cspSource)
            .replace('{{STYLE_URI}}', styleUri.toString())
            .replace('{{ESCAPED_JSON_HTML}}', generateJsonHtml(jsonData));

        panel.webview.html = htmlContent;
    });

    context.subscriptions.push(disposable);
}

function generateJsonHtml(jsonData: unknown): string {
    function jsonToHtml(data: unknown, depth = 0): string {
        if (data === null) { return '<span class="null">null</span>'; }
        if (typeof data === 'string') { return `<span class="str">"${escapeHtml(data)}"</span>`; }
        if (typeof data === 'number') { return `<span class="num">${data}</span>`; }
        if (typeof data === 'boolean') { return `<span class="bool">${data}</span>`; }

        const isArray = Array.isArray(data);
        const entries = Object.entries(data as object);

        if (entries.length === 0) {
            return `<span>${isArray ? '[]' : '{}'}</span>`;
        }

        const items = entries.map(([key, value], index) => {
            const isLast = index === entries.length - 1;
            const comma = isLast ? '' : '<span>,</span>';
            const isCollapsible = value !== null && typeof value === 'object';
            const indent = `d${Math.min(depth, 5)}`;

            if (isCollapsible) {
                const itemCount = Array.isArray(value) ? value.length : Object.keys(value).length;
                const preview = itemCount === 0 ?
                    (Array.isArray(value) ? '[]' : '{}') :
                    `${itemCount} item${itemCount !== 1 ? 's' : ''}`;

                return `
                    <div class="json-item ${indent}">
                        <div class="json-toggle">
                            <svg class="json-arrow" viewBox="0 0 16 16">
                                <path d="M6 4l4 4-4 4" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
                            </svg>
                            <span class="key">${isArray ? key : `"${escapeHtml(key)}"`}</span>
                            <span>:</span>
                            <span class="json-preview">
                                ${isArray ? '[' : '{'} <span class="count">${preview}</span> ${isArray ? ']' : '}'}
                            </span>
                        </div>
                        <div class="json-content">
                            <div class="bracket">${isArray ? '[' : '{'}</div>
                            <div class="json-children">
                                ${jsonToHtml(value, depth + 1)}
                            </div>
                            <div class="bracket">${isArray ? ']' : '}'}${comma}</div>
                        </div>
                    </div>
                `;
            } else {
                return `
                    <div class="json-leaf ${indent}">
                        <span class="key">${isArray ? key : `"${escapeHtml(key)}"`}</span>
                        <span>:</span>
                        <span>${jsonToHtml(value, depth + 1)}</span>${comma}
                    </div>
                `;
            }
        }).join('');

        return depth === 0 ? `
            <div class="json-root">
                <div class="bracket root-bracket">${isArray ? '[' : '{'}</div>
                <div>${items}</div>
                <div class="bracket root-bracket">${isArray ? ']' : '}'}</div>
            </div>
        ` : items;
    }

    function escapeHtml(text: string): string {
        return String(text)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    return jsonToHtml(jsonData);
}

function getNonce(): string {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuv8901';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}

export function deactivate() {}
