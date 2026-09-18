import * as vscode from 'vscode';
import { ViewerPanel } from './panel';

export function activate(context: vscode.ExtensionContext) {
    context.subscriptions.push(vscode.commands.registerCommand('json-smart-viewer.show', (clicked?: unknown) => {
        // Menus pass the file; the command palette uses the active editor tab
        const uri = clicked instanceof vscode.Uri ? clicked : activeUri();
        if (!uri) {
            vscode.window.showInformationMessage('Open a JSON file first.');
            return;
        }
        // VS Code only shares files up to 50 MB with extensions; bigger ones are read from disk
        const document = vscode.workspace.textDocuments.find(d => d.uri.toString() === uri.toString());
        if (document ? document.languageId !== 'json' : !uri.path.toLowerCase().endsWith('.json')) {
            vscode.window.showInformationMessage('This is not a JSON file.');
            return;
        }
        new ViewerPanel(context, uri, document);
    }));
}

function activeUri(): vscode.Uri | undefined {
    const editor = vscode.window.activeTextEditor;
    if (editor) { return editor.document.uri; }
    const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    return input instanceof vscode.TabInputText ? input.uri : undefined;
}

export function deactivate() {}
