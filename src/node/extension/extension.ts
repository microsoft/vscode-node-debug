/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

'use strict';

import * as vscode from 'vscode';

import { NodeConfigurationProvider } from './configurationProvider';
import { LoadedScriptsProvider, pickLoadedScript, openScript } from './loadedScripts';
import { pickProcess } from './processPicker';
import { startSession, stopSession } from './childProcesses';


export function activate(context: vscode.ExtensionContext) {

	// register a configuration provider
	context.subscriptions.push(vscode.debug.registerDebugConfigurationProvider('node', new NodeConfigurationProvider(context)));

	// toggle skipping file action
	context.subscriptions.push(vscode.commands.registerCommand('extension.node-debug.toggleSkippingFile', toggleSkippingFile));

	// process quickpicker
	context.subscriptions.push(vscode.commands.registerCommand('extension.pickNodeProcess', () => pickProcess()));

	// loaded scripts
	const provider = new LoadedScriptsProvider(context);
	vscode.window.registerTreeDataProvider('extension.node-debug.loadedScriptsExplorer.node', provider);
	vscode.window.registerTreeDataProvider('extension.node-debug.loadedScriptsExplorer.node2', provider);
	vscode.window.registerTreeDataProvider('extension.node-debug.loadedScriptsExplorer.extensionHost', provider);
	vscode.window.registerTreeDataProvider('extension.node-debug.loadedScriptsExplorer.chrome', provider);
	context.subscriptions.push(vscode.commands.registerCommand('extension.node-debug.pickLoadedScript', () => pickLoadedScript()));
	context.subscriptions.push(vscode.commands.registerCommand('extension.node-debug.openScript', (session: vscode.DebugSession, source) => openScript(session, source)));

	// cluster
	context.subscriptions.push(vscode.debug.onDidStartDebugSession(session => startSession(session)));
	context.subscriptions.push(vscode.debug.onDidTerminateDebugSession(session => stopSession(session)));
}

export function deactivate() {
}


//---- toggle skipped files

function toggleSkippingFile(res: string | number): void {

	let resource: string | number | undefined = res;

	if (!resource) {
		const activeEditor = vscode.window.activeTextEditor;
		resource = activeEditor && activeEditor.document.fileName;
	}

	if (resource && vscode.debug.activeDebugSession) {
		const args = typeof resource === 'string' ? { resource } : { sourceReference: resource };
		vscode.debug.activeDebugSession.customRequest('toggleSkipFileStatus', args);
	}
}
