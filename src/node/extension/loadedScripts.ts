/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

'use strict';

import * as vscode from 'vscode';
import { localize } from './utilities';


//---- loaded script picker

interface ScriptItem extends vscode.QuickPickItem {
	source?: any;	// Source
}

export function pickLoadedScript() {

		return listLoadedScripts().then(items => {

			let options : vscode.QuickPickOptions = {
				placeHolder: localize('select.script', "Select a script"),
				matchOnDescription: true,
				matchOnDetail: true,
				ignoreFocusOut: true
			};

			if (items === undefined) {
				items = [ { label: localize('no.loaded.scripts', "No loaded scripts available"), description: '' } ];
			}

			vscode.window.showQuickPick(items, options).then(item => {
				if (item && item.source) {
					let uri = vscode.Uri.parse(`debug:${item.source.path}`);
					vscode.workspace.openTextDocument(uri).then(doc => vscode.window.showTextDocument(doc));
				}
			});
		});
	}

function listLoadedScripts() : Thenable<ScriptItem[] | undefined> {
	return vscode.commands.executeCommand<string[]>('workbench.customDebugRequest', 'getLoadedScripts', {} ).then((reply: any) => {
		if (reply && reply.success) {
			return reply.body.loadedScripts;
		} else {
			return undefined;
		}
	});
}

export function openScript(path: string) {
	let uri = vscode.Uri.parse(`debug:${path}`);
	vscode.workspace.openTextDocument(uri).then(doc => vscode.window.showTextDocument(doc));
}
