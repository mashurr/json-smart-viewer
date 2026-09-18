import * as vscode from 'vscode';
import { ViewerPanel } from './panel';

const LANGUAGES = new Set(['json', 'jsonc', 'jsonl']);
const EXTENSIONS = /\.(json|jsonc|jsonl|ndjson)$/i;

export function activate(context: vscode.ExtensionContext) {
    context.subscriptions.push(
        vscode.commands.registerCommand('json-smart-viewer.show', (clicked?: unknown) => {
            // Menus pass the file; the command palette uses the active editor tab
            const uri = clicked instanceof vscode.Uri ? clicked : activeUri();
            if (!uri) {
                vscode.window.showInformationMessage('Open a JSON file first.');
                return;
            }
            // VS Code only shares files up to 50 MB with extensions; bigger ones are read from disk
            const document = vscode.workspace.textDocuments.find(d => d.uri.toString() === uri.toString());
            if (document ? !LANGUAGES.has(document.languageId) && !EXTENSIONS.test(uri.path) : !EXTENSIONS.test(uri.path)) {
                vscode.window.showInformationMessage('This is not a JSON file. To view JSON inside it, select the JSON and use "Open Selection in JSON Smart View".');
                return;
            }
            const sourceColumn = vscode.window.activeTextEditor?.viewColumn ?? vscode.window.tabGroups.activeTabGroup.viewColumn;
            ViewerPanel.show(context, uri, document, sourceColumn);
        }),
        vscode.commands.registerTextEditorCommand('json-smart-viewer.showSelection', editor => {
            const selection = editor.selection;
            if (selection.isEmpty) {
                vscode.window.showInformationMessage('Select some JSON first.');
                return;
            }
            ViewerPanel.showSelection(context, editor.document, editor.document.offsetAt(selection.start), editor.document.getText(selection), editor.viewColumn);
        }),
    );
}

function activeUri(): vscode.Uri | undefined {
    const editor = vscode.window.activeTextEditor;
    if (editor) { return editor.document.uri; }
    const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    return input instanceof vscode.TabInputText ? input.uri : undefined;
}

export function deactivate() {}
