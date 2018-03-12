/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

import * as nls from 'vscode-nls';
import * as vscode from 'vscode';
import { getProcessTree, ProcessTreeNode } from './processTree';

const localize = nls.loadMessageBundle();

const POLL_INTERVAL = 1000;

const DEBUG_PORT_PATTERN = /\s--(inspect|debug)-port=(\d+)/;
const DEBUG_FLAGS_PATTERN = /\s--(inspect|debug)(-brk)?(=(\d+))?/;

class Cluster {
	folder: vscode.WorkspaceFolder | undefined;
	config: vscode.DebugConfiguration;
	session: vscode.DebugSession | undefined;
	pids: Set<number>;
	timeoutId: NodeJS.Timer | undefined;

	constructor(folder: vscode.WorkspaceFolder | undefined, config: vscode.DebugConfiguration) {
		this.folder = folder;
		this.config = config;
		this.pids = new Set<number>();
	}

	startWatching(session: vscode.DebugSession) {
		this.session = session;

		setTimeout(_ => {
			// get the process ID from the debuggee
			if (this.session) {
				this.session.customRequest('evaluate', { expression: 'process.pid' }).then(reply => {
					const rootPid = parseInt(reply.result);
					this.attachChildProcesses(rootPid);
				}, e => {
					// 'evaluate' error -> use the fall back strategy
					this.attachChildProcesses(NaN);
				});
			}
		}, this.session.type === 'node2' ? 500 : 100);
	}

	stopWatching() {
		this.session = undefined;
		if (this.timeoutId) {
			clearTimeout(this.timeoutId);
			this.timeoutId = undefined;
		}
	}

	private attachChildProcesses(rootPid: number) {
		this.pollChildProcesses(rootPid, (pid, cmd) => {
			if (!this.pids.has(pid)) {
				this.pids.add(pid);
				attachChildProcess(this.folder, pid, cmd, this.config);
			}
		});
	}

	private pollChildProcesses(rootPid: number, cb: (pid, cmd) => void) {
		//const start = Date.now();
		findChildProcesses(rootPid, cb).then(_ => {
			//console.log(`duration: ${Date.now() - start}`);
			if (this.session) {
				this.timeoutId = setTimeout(_ => {
					this.pollChildProcesses(rootPid, cb);
				}, POLL_INTERVAL);
			}
		});
	}
}

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

function attachChildProcess(folder: vscode.WorkspaceFolder | undefined, pid: number, cmd: string, baseConfig: vscode.DebugConfiguration) {

	const config: vscode.DebugConfiguration = {
		type: 'node',
		request: 'attach',
		name: localize('childProcessWithPid', "Child Process {0}", pid),
		stopOnEntry: false
	};

	// selectively copy attributes
	if (baseConfig.timeout) {
		config.timeout = baseConfig.timeout;
	}
	if (baseConfig.sourceMaps) {
		config.sourceMaps = baseConfig.sourceMaps;
	}
	if (baseConfig.outFiles) {
		config.outFiles = baseConfig.outFiles;
	}
	if (baseConfig.sourceMapPathOverrides) {
		config.sourceMapPathOverrides = baseConfig.sourceMapPathOverrides;
	}
	if (baseConfig.smartStep) {
		config.smartStep = baseConfig.smartStep;
	}
	if (baseConfig.skipFiles) {
		config.skipFiles = baseConfig.skipFiles;
	}
	if (baseConfig.showAsyncStacks) {
		config.sourceMaps = baseConfig.showAsyncStacks;
	}
	if (baseConfig.trace) {
		config.trace = baseConfig.trace;
	}

	// match --debug, --debug=1234, --debug-brk, debug-brk=1234, --inspect, --inspect=1234, --inspect-brk, --inspect-brk=1234
	let matches = DEBUG_FLAGS_PATTERN.exec(cmd);
	if (matches && matches.length >= 2) {
		// attach via port
		if (matches.length === 5 && matches[4]) {
			config.port = parseInt(matches[4]);
		}
		config.protocol= matches[1] === 'debug' ? 'legacy' : 'inspector';
	} else {
		// no port -> try to attach via pid (send SIGUSR1)
		config.processId = String(pid);
	}

	// a debug-port=1234 or --inspect-port=1234 overrides the port
	matches = DEBUG_PORT_PATTERN.exec(cmd);
	if (matches && matches.length === 3) {
		// override port
		config.port = parseInt(matches[2]);
	}

	//log(`attach: ${config.protocol} ${config.port}`);

	vscode.debug.startDebugging(folder, config);
}

function findChildProcesses(rootPid: number, cb: (pid: number, cmd: string) => void): Promise<void> {

	function walker(node: ProcessTreeNode) {

		const matches = DEBUG_PORT_PATTERN.exec(node.args);
		const matches2 = DEBUG_FLAGS_PATTERN.exec(node.args);

		if ((matches && matches.length >= 3) || (matches2 && matches2.length >= 5)) {
			cb(node.pid, node.args);
		}

		for (const child of node.children || []) {
			walker(child);
		}
	}

	return getProcessTree(rootPid).then(tree => {

		for (const child of tree.children || []) {
			walker(child);
		}

	}).catch(err => {
	});
}
