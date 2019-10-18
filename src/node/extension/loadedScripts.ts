/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

'use strict';

import * as nls from 'vscode-nls';
import * as vscode from 'vscode';
import { basename } from 'path';

const localize = nls.loadMessageBundle();

//---- loaded script explorer

class Source {
	name: string;
	path: string;
	sourceReference: number;

	constructor(path: string) {
		this.name = basename(path);
		this.path = path;
	}
}

class LoadedScriptItem implements vscode.QuickPickItem {
	label: string;
	description: string;
	source?: Source;

	constructor(source: Source) {
		this.label = basename(source.path);
		this.description = source.path;
		this.source = source;
	}
}

//---- loaded script picker

export function pickLoadedScript() {

	const session = vscode.debug.activeDebugSession;

	return listLoadedScripts(session).then(sources => {

		let options: vscode.QuickPickOptions = {
			placeHolder: localize('select.script', "Select a script"),
			matchOnDescription: true,
			matchOnDetail: true,
			ignoreFocusOut: true
		};

		let items: LoadedScriptItem[];
		if (sources === undefined) {
			items = [ { label: localize('no.loaded.scripts', "No loaded scripts available"), description: '' }];
		} else {
			items = sources.map(source => new LoadedScriptItem(source)).sort((a, b) => a.label.localeCompare(b.label));
		}

		vscode.window.showQuickPick(items, options).then(item => {
			if (item && item.source) {
				openScript(session, item.source);
			}
		});
	});
}

function listLoadedScripts(session: vscode.DebugSession | undefined): Thenable<Source[] | undefined> {

	if (session) {

		return session.customRequest('loadedSources').then(reply => {
			return <Source[]>reply.sources;
		}, err => {
			return undefined;
		});

	} else {
		return Promise.resolve(undefined);
	}
}

export function openScript(session: vscode.DebugSession | undefined, source: Source) {
	let uri: vscode.Uri;
	if (source.sourceReference) {
		let debug = `debug:${encodeURIComponent(source.path)}`;
		let sep = '?';
		if (session) {
			debug += `${sep}session=${encodeURIComponent(session.id)}`;
			sep = '&';
		}
		debug += `${sep}ref=${source.sourceReference}`;
		uri = vscode.Uri.parse(debug);
	} else {
		uri = vscode.Uri.file(source.path);
	}
	vscode.workspace.openTextDocument(uri).then(doc => vscode.window.showTextDocument(doc));
}
