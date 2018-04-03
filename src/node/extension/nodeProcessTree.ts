/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

import * as vscode from 'vscode';
import { getProcessTree, ProcessTreeNode } from './processTree';
import { INSPECTOR_PORT_DEFAULT, LEGACY_PORT_DEFAULT } from './protocolDetection';

const DEBUG_FLAGS_PATTERN = /--(inspect|debug)(-brk)?(=(\d+))?[^-]/;
const DEBUG_PORT_PATTERN = /--(inspect|debug)-port=(\d+)/;

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

	let port = -1;
	let protocol = '';
	let usePid = true;

	// match --debug, --debug=1234, --debug-brk, debug-brk=1234, --inspect, --inspect=1234, --inspect-brk, --inspect-brk=1234
	let matches = DEBUG_FLAGS_PATTERN.exec(args);
	if (matches && matches.length >= 2) {
		// attach via port
		if (matches.length === 5 && matches[4]) {
			port = parseInt(matches[4]);
		}
		protocol= matches[1] === 'debug' ? 'legacy' : 'inspector';
		usePid = false;
	}

	// a debug-port=1234 or --inspect-port=1234 overrides the port
	matches = DEBUG_PORT_PATTERN.exec(args);
	if (matches && matches.length === 3) {
		// override port
		port = parseInt(matches[2]);
		protocol = matches[1] === 'debug' ? 'legacy' : 'inspector';
	}

	if (usePid) {
		if (protocol && port > 0) {
			config.processId = `${pid}${protocol}${port}`;
		} else {
			// no port given
			//if (NODE.test(executable_name)) {
				config.processId = pid.toString();
			//}
		}
	} else {
		if (port < 0) {
			port = protocol === 'inspector' ? INSPECTOR_PORT_DEFAULT : LEGACY_PORT_DEFAULT;
		}
		config.processId = `${protocol}${port}`;
	}

	//log(`attach: ${config.protocol} ${config.port}`);

	vscode.debug.startDebugging(folder, config);
}

function findChildProcesses(rootPid: number, inTerminal: boolean, cb: (pid: number, cmd: string, args: string) => void): Promise<void> {

	function walker(node: ProcessTreeNode, terminal: boolean, renderer: number) {

		const matches = DEBUG_PORT_PATTERN.exec(node.args);
		const matches2 = DEBUG_FLAGS_PATTERN.exec(node.args);

		if (node.args.indexOf('--type=terminal') >= 0 && (renderer === 0 || node.ppid === renderer)) {
			terminal = true;
		}

		if (terminal && ((matches && matches.length >= 3) || (matches2 && matches2.length >= 5))) {
			cb(node.pid, node.command, node.args);
		}

		for (const child of node.children || []) {
			walker(child, terminal, renderer);
		}
	}

	function finder(node: ProcessTreeNode, pid) {
		if (node.pid === pid) {
			return node;
		}
		for (const child of node.children || []) {
			const p = finder(child, pid);
			if (p) {
				return p;
			}
		}
	}

	return getProcessTree(rootPid).then(tree => {
		if (tree) {

			// find the pid of the renderer process
			const extensionHost = finder(tree, process.pid);
			let rendererPid = extensionHost ? extensionHost.ppid : 0;

			for (const child of tree.children || []) {
				walker(child, !inTerminal, rendererPid);
			}
		}
	});
}
