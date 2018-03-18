/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

import { getProcessTree, ProcessTreeNode } from './processTree';
import * as vscode from 'vscode';

const DEBUG_PORT_PATTERN = /\s--(inspect|debug)-port=(\d+)/;
const DEBUG_FLAGS_PATTERN = /\s--(inspect|debug)(-brk)?(=(\d+))?/;

const pids = new Set<number>();

const POLL_INTERVAL = 1000;

/**
 * Poll for all subprocesses of given root process.
 */
export function pollProcesses(rootPid: number, inTerminal: boolean, cb: (pid: number, cmd: string, args: string) => void) : vscode.Disposable {

	let stopped = false;

	function poll() {
		//const start = Date.now();
		findChildProcesses(rootPid, inTerminal, cb).then(_ => {
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

export function attachToProcess(folder: vscode.WorkspaceFolder | undefined, name: string, pid: number, args: string, baseConfig?: vscode.DebugConfiguration) {

	if (pids.has(pid)) {
		return;
	}
	pids.add(pid);

	const config: vscode.DebugConfiguration = {
		type: 'node',
		request: 'attach',
		name: name,
		stopOnEntry: false
	};

	if (baseConfig) {
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
	}

	// match --debug, --debug=1234, --debug-brk, debug-brk=1234, --inspect, --inspect=1234, --inspect-brk, --inspect-brk=1234
	let matches = DEBUG_FLAGS_PATTERN.exec(args);
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
	matches = DEBUG_PORT_PATTERN.exec(args);
	if (matches && matches.length === 3) {
		// override port
		config.port = parseInt(matches[2]);
	}

	//log(`attach: ${config.protocol} ${config.port}`);

	vscode.debug.startDebugging(folder, config);
}

function findChildProcesses(rootPid: number, inTerminal: boolean, cb: (pid: number, cmd: string, args: string) => void): Promise<void> {

	function walker(node: ProcessTreeNode, terminal: boolean) {

		const matches = DEBUG_PORT_PATTERN.exec(node.args);
		const matches2 = DEBUG_FLAGS_PATTERN.exec(node.args);

		if (node.args.indexOf('--type=terminal') >= 0) {
			terminal = true;
		}

		if (terminal && ((matches && matches.length >= 3) || (matches2 && matches2.length >= 5))) {
			cb(node.pid, node.command, node.args);
		}

		for (const child of node.children || []) {
			walker(child, terminal);
		}
	}

	return getProcessTree(rootPid).then(tree => {
		if (tree) {
			for (const child of tree.children || []) {
				walker(child, !inTerminal);
			}
		}
	});
}
