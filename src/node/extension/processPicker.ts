/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

'use strict';

import * as nls from 'vscode-nls';
import * as vscode from 'vscode';
import { basename } from 'path';
import { getProcesses } from './processTree';

const localize = nls.loadMessageBundle();

//---- extension.pickNodeProcess

interface ProcessItem extends vscode.QuickPickItem {
	pid: string;	// payload for the QuickPick UI
}

export function pickProcess(): Promise<string|null> {
	return listProcesses().then(items => {
		let options : vscode.QuickPickOptions = {
			placeHolder: localize('pickNodeProcess', "Pick the node.js or gulp process to attach to"),
			matchOnDescription: true,
			matchOnDetail: true,
			ignoreFocusOut: true
		};
		return vscode.window.showQuickPick(items, options).then(item => item ? item.pid : null);
	}).catch(err => {
		return vscode.window.showErrorMessage(localize('process.picker.error', "Process picker failed ({0})", err.message), { modal: true }).then(_ => null);
	});
}

function listProcesses() : Promise<ProcessItem[]> {

	const NODE = new RegExp('^(?:node|iojs|gulp)$', 'i');

	const items : ProcessItem[]= [];
	let promise : Promise<void>;

	if (process.platform === 'win32') {

		const EXECUTABLE_ARGS = new RegExp('^(?:"([^"]+)"|([^ ]+))(?: (.+))?$');

		promise = getProcesses((pid: number, ppid: number, cmd: string) => {

			// remove leading device specifier
			if (cmd.indexOf('\\??\\') === 0) {
				cmd = cmd.replace('\\??\\', '');
			}

			let executable_path: string | undefined;
			const matches2 = EXECUTABLE_ARGS.exec(cmd);
			if (matches2 && matches2.length >= 2) {
				if (matches2.length >= 3) {
					executable_path = matches2[1] || matches2[2];
				} else {
					executable_path = matches2[1];
				}
			}

			if (executable_path) {

				let executable_name = basename(executable_path);
				executable_name = executable_name.split('.')[0];
				if (NODE.test(executable_name)) {
					items.push({
						label: executable_name,
						description: pid.toString(),
						detail: cmd,
						pid: pid.toString()
					});
				}
			}
		});

	} else {
		const MAC_APPS = new RegExp('^.*/(.*).(?:app|bundle)/Contents/.*$');

		promise = getProcesses((pid: number, ppid: number, cmd: string) => {

			const parts = cmd.split(' '); // this will break paths with spaces
			const executable_path = parts[0];
			const executable_name = basename(executable_path);

			if (NODE.test(executable_name)) {
				let application = cmd;
				// try to show the correct name for OS X applications and bundles
				const matches2 = MAC_APPS.exec(cmd);
				if (matches2 && matches2.length === 2) {
					application = matches2[1];
				} else {
					application = executable_name;
				}

				items.unshift({		// build up list reverted
					label: application,
					description: pid.toString(),
					detail: cmd,
					pid: pid.toString()
				});
			}
		});
	}

	return promise.then(() => items);
}
