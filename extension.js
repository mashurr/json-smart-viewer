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
    function jsonToHtml(data, depth = 0) {
        if (data === null) return '<span class="text-purple-300 font-bold">null</span>';
        if (typeof data === 'string') return `<span class="text-green-300">"${escapeHtml(data)}"</span>`;
        if (typeof data === 'number') return `<span class="text-blue-300">${data}</span>`;
        if (typeof data === 'boolean') return `<span class="text-yellow-300 font-bold">${data}</span>`;

        const isArray = Array.isArray(data);
        const entries = Object.entries(data);
        
        if (entries.length === 0) {
            return `<span class="text-white">${isArray ? '[]' : '{}'}</span>`;
        }

        const items = entries.map(([key, value], index) => {
            const isLast = index === entries.length - 1;
            const comma = isLast ? '' : '<span class="text-white">,</span>';
            const isCollapsible = value !== null && typeof value === 'object';
            const indent = `ml-${Math.min(depth * 4, 20)}`;
            
            if (isCollapsible) {
                const itemCount = Array.isArray(value) ? value.length : Object.keys(value).length;
                const preview = itemCount === 0 ? 
                    (Array.isArray(value) ? '[]' : '{}') : 
                    `${itemCount} item${itemCount !== 1 ? 's' : ''}`;
                
                return `
                    <div class="json-item ${indent}">
                        <div class="json-toggle flex items-center gap-1 py-1 px-2 rounded hover:bg-white/20 cursor-pointer group">
                            <svg class="json-arrow w-3 h-3 text-white transition-transform duration-200 transform group-data-[collapsed=true]:rotate-0 group-data-[collapsed=false]:rotate-90" viewBox="0 0 16 16">
                                <path d="M6 4l4 4-4 4" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
                            </svg>
                            <span class="text-cyan-200 font-semibold">${isArray ? key : `"${escapeHtml(key)}"`}</span>
                            <span class="text-white">:</span>
                            <span class="json-preview text-white">
                                ${isArray ? '[' : '{'} <span class="text-sm text-gray-300 italic font-medium">${preview}</span> ${isArray ? ']' : '}'}
                            </span>
                        </div>
                        <div class="json-content hidden ml-4">
                            <div class="text-white px-2 font-bold">${isArray ? '[' : '{'}</div>
                            <div class="ml-2">
                                ${jsonToHtml(value, depth + 1)}
                            </div>
                            <div class="text-white px-2 font-bold">${isArray ? ']' : '}'}${comma}</div>
                        </div>
                    </div>
                `;
            } else {
                return `
                    <div class="json-leaf ${indent} ml-6 flex items-center gap-2 py-1 px-2">
                        <span class="text-cyan-200 font-semibold">${isArray ? key : `"${escapeHtml(key)}"`}</span>
                        <span class="text-white">:</span>
                        <span>${jsonToHtml(value, depth + 1)}</span>${comma}
                    </div>
                `;
            }
        }).join('');

        return depth === 0 ? `
            <div class="json-root">
                <div class="text-white px-2 mb-2 font-bold text-lg">${isArray ? '[' : '{'}</div>
                <div>${items}</div>
                <div class="text-white px-2 mt-2 font-bold text-lg">${isArray ? ']' : '}'}</div>
            </div>
        ` : items;
    }

    function escapeHtml(text) {
        return String(text)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
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
            .json-arrow { transition: transform 0.2s ease; }
            .json-toggle[data-collapsed="false"] .json-arrow { transform: rotate(90deg); }
            .json-toggle[data-collapsed="false"] .json-preview { display: none; }
            .json-toggle[data-collapsed="false"] + .json-content { display: block !important; }
        </style>
    </head>
    <body class="bg-black text-white font-mono p-6 min-h-screen">
        <div class="max-w-full overflow-x-auto">
            <div id="json-container" class="text-sm leading-relaxed">${jsonToHtml(jsonData)}</div>
        </div>

        <script nonce="${nonce}">
            document.querySelectorAll('.json-toggle').forEach(toggle => {
                toggle.dataset.collapsed = 'true';
                
                toggle.addEventListener('click', function() {
                    const isCollapsed = this.dataset.collapsed === 'true';
                    this.dataset.collapsed = isCollapsed ? 'false' : 'true';
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