/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

import * as vscode from 'vscode';
import * as nls from 'vscode-nls';
import { pollProcesses, attachToProcess } from './nodeProcessTree';

const localize = nls.loadMessageBundle();

const clusters = new Map<string,Cluster>();

export function prepareAutoAttachChildProcesses(folder: vscode.WorkspaceFolder | undefined, config: vscode.DebugConfiguration) {
	clusters.set(config.name, new Cluster(folder, config));
}

export function startSession(session: vscode.DebugSession) {
	const cluster = clusters.get(session.name);
	if (cluster) {
		cluster.startWatching(session);
	}
}

export function stopSession(session: vscode.DebugSession) {
	const cluster = clusters.get(session.name);
	if (cluster) {
		cluster.stopWatching();
		clusters.delete(session.name);
	}
}

//---- private

class Cluster {
	folder: vscode.WorkspaceFolder | undefined;
	config: vscode.DebugConfiguration;
	poller?: vscode.Disposable;

	constructor(folder: vscode.WorkspaceFolder | undefined, config: vscode.DebugConfiguration) {
		this.folder = folder;
		this.config = config;
	}

	startWatching(session: vscode.DebugSession) {

		setTimeout(_ => {
			// get the process ID from the debuggee
			if (session) {
				session.customRequest('evaluate', { expression: 'process.pid' }).then(reply => {
					const rootPid = parseInt(reply.result);
					this.attachChildProcesses(rootPid);
				}, e => {
					// 'evaluate' error -> use the fall back strategy
					this.attachChildProcesses(NaN);
				});
			}
		}, session.type === 'node2' ? 500 : 100);
	}

	stopWatching() {
		if (this.poller) {
			this.poller.dispose();
			this.poller = undefined;
		}
	}

	private attachChildProcesses(rootPid: number) {
		this.poller = pollProcesses(rootPid, (pid, cmd) => {
			const name = localize('childProcessWithPid', "Child Process {0}", pid);
			attachToProcess(this.folder, name, pid, cmd, this.config);
		});
	}
}
