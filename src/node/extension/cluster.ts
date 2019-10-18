/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

import * as vscode from 'vscode';
import * as nls from 'vscode-nls';
import { attachToProcess, getPidFromSession } from './autoAttach';
import { ProcessTreeNode, getProcessTree } from './processTree';
import { analyseArguments } from './protocolDetection';

const localize = nls.loadMessageBundle();

const POLL_INTERVAL = 1000;

export class Cluster {

	static clusters = new Map<string,Cluster>();

	private _poller?: vscode.Disposable;
	private _subProcesses: Set<number>;		// we remember all child process attached to here
	private _childCounter: number;


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
		this._subProcesses = new Set<number>();
		this._childCounter = 1;
	}

	private startWatching(session: vscode.DebugSession) {
		// get the process ID from the leader debuggee
		getPidFromSession(session).then(leaderPid => {
			// start polling for child processes under the leader
			this._poller = pollProcesses(leaderPid, false, (pid, cmd, args) => {
				// only attach to new child processes
				if (!this._subProcesses.has(pid)) {
					this._subProcesses.add(pid);
					const name = localize('child.process.with.pid.label', "Child process {0}", this._childCounter++);
					attachToProcess(this._folder, name, pid, args, this._config, session);
				}
			});
		});
	}

	private stopWatching() {
		if (this._poller) {
			this._poller.dispose();
			this._poller = undefined;
		}
	}
}

/**
 * Poll for all subprocesses of given root process.
 */
function pollProcesses(rootPid: number, inTerminal: boolean, cb: (pid: number, cmd: string, args: string) => void) : vscode.Disposable {

	let stopped = false;

	function poll() {
		//const start = Date.now();
		findChildProcesses(rootPid, cb).then(_ => {
			//console.log(`duration: ${Date.now() - start}`);
			setTimeout(_ => {
				if (!stopped) {
					poll();
				}
			}, POLL_INTERVAL);
		});
	}

	poll();

	return new vscode.Disposable(() => stopped = true);
}

function findChildProcesses(rootPid: number, cb: (pid: number, cmd: string, args: string) => void): Promise<void> {

	function walker(node: ProcessTreeNode) {

		if (node.pid !== rootPid) {
			let { protocol } = analyseArguments(node.args);
			if (protocol) {
				cb(node.pid, node.command, node.args);
			}
		}

		for (const child of node.children || []) {
			walker(child);
		}
	}

	return getProcessTree(rootPid).then(tree => {
		if (tree) {
			walker(tree);
		}
	});
}
