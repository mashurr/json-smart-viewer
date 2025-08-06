// extension.js
const vscode = require('vscode');

function activate(context) {
    let disposable = vscode.commands.registerCommand('json-smart-viewer.show', () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.document.languageId !== 'json') {
            vscode.window.showInformationMessage('This is not a JSON file.');
            return;
        }

        let jsonData;
        try {
            jsonData = JSON.parse(editor.document.getText());
        } catch (e) {
            vscode.window.showErrorMessage(`Invalid JSON: ${e.message}`);
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'jsonSmartViewer', 'JSON Smart View', vscode.ViewColumn.One, { enableScripts: true }
        );

        panel.webview.html = getWebviewContent(jsonData);
    });

    context.subscriptions.push(disposable);
}

function getWebviewContent(jsonData) {
    function jsonToHtml(data) {
        if (data === null) return '<span class="text-fuchsia-500">null</span>';
        if (typeof data === 'string') return `<span class="text-green-500">"${data}"</span>`;
        if (typeof data === 'number') return `<span class="text-blue-500">${data}</span>`;
        if (typeof data === 'boolean') return `<span class="text-indigo-500">${data}</span>`;

        const isArray = Array.isArray(data);
        const items = Object.entries(data);

        if (items.length === 0) return isArray ? '[]' : '{}';

        const listItems = items.map(([key, value]) => {
            const isCollapsible = value !== null && typeof value === 'object';
            const keyHtml = `<span class="text-gray-400">${isArray ? `${key}` : `"${key}"`}:</span>`;

            if (isCollapsible) {
                // The arrow starts collapsed (pointing right) which is a 180-degree rotation of our SVG.
                return `
                    <li>
                        <div class="collapser flex items-center cursor-pointer p-1 rounded hover:bg-white/10">
                            <span class="arrow w-3 h-3 inline-block transition-transform transform rotate-180"></span>
                            ${keyHtml}
                        </div>
                        <div class="content pl-4 hidden">
                            ${jsonToHtml(value)}
                        </div>
                    </li>
                `;
            } else {
                return `<li class="pl-7 p-1">${keyHtml} ${jsonToHtml(value)}</li>`;
            }
        }).join('');

        return `<ul class="space-y-1">${listItems}</ul>`;
    }

    const nonce = getNonce();

    return `<!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta http-equiv="Content-Security-Policy" content="
            default-src 'none'; 
            style-src 'unsafe-inline';
            script-src 'nonce-${nonce}' https://cdn.tailwindcss.com;
            img-src 'self' data:;">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>JSON Smart View</title>
        <script nonce="${nonce}" src="https://cdn.tailwindcss.com"></script>
        <style nonce="${nonce}">
            .arrow {
                background-color: var(--vscode-editor-foreground);
                -webkit-mask-image: url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path fill="currentColor" d="M10.44 2.06a.75.75 0 0 0 0 1.06L5.56 8l4.88 4.88a.75.75 0 0 0 1.06-1.06L7.69 8l3.81-3.88a.75.75 0 0 0-1.06-1.06z"/></svg>');
                mask-image: url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path fill="currentColor" d="M10.44 2.06a.75.75 0 0 0 0 1.06L5.56 8l4.88 4.88a.75.75 0 0 0 1.06-1.06L7.69 8l3.81-3.88a.75.75 0 0 0-1.06-1.06z"/></svg>');
            }
        </style>
    </head>
    <body class="bg-zinc-900 text-gray-200 font-mono p-4">
        <div id="json-container">${jsonToHtml(jsonData)}</div>

        <script nonce="${nonce}">
            document.querySelectorAll('.collapser').forEach(collapser => {
                collapser.addEventListener('click', function() {
                    const content = this.nextElementSibling;
                    const arrow = this.querySelector('.arrow');
                    
                    content.classList.toggle('hidden');
                    
                    arrow.classList.toggle('rotate-180');
                    arrow.classList.toggle('rotate-[-90deg]');
                });
            });
        </script>
    </body>
    </html>`;
}

function getNonce() {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}

function deactivate() {}

module.exports = {
    activate,
    deactivate
}