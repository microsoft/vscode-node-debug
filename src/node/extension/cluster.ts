/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

import * as vscode from 'vscode';
import * as nls from 'vscode-nls';
import { pollProcesses, attachToProcess } from './nodeProcessTree';

const localize = nls.loadMessageBundle();

export class Cluster {

	static clusters = new Map<string,Cluster>();

	private poller?: vscode.Disposable;


	public static prepareAutoAttachChildProcesses(folder: vscode.WorkspaceFolder | undefined, config: vscode.DebugConfiguration) {
		this.clusters.set(config.name, new Cluster(folder, config));
	}

	static startSession(session: vscode.DebugSession) {
		const cluster = this.clusters.get(session.name);
		if (cluster) {
			cluster.startWatching(session);
		}
	}

	static stopSession(session: vscode.DebugSession) {
		const cluster = this.clusters.get(session.name);
		if (cluster) {
			cluster.stopWatching();
			this.clusters.delete(session.name);
		}
	}

	private constructor(private _folder: vscode.WorkspaceFolder | undefined, private _config: vscode.DebugConfiguration) {
	}

	private startWatching(session: vscode.DebugSession) {

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

	private stopWatching() {
		if (this.poller) {
			this.poller.dispose();
			this.poller = undefined;
		}
	}

	private attachChildProcesses(rootPid: number) {
		this.poller = pollProcesses(rootPid, false, (pid, cmd, args) => {
			const name = localize('child.process.with.pid.label', "Child Process {0}", pid);
			attachToProcess(this._folder, name, pid, args, this._config);
		});
	}
}
