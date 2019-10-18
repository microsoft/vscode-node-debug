/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

import * as vscode from 'vscode';
import * as nls from 'vscode-nls';
import { basename } from 'path';
import { analyseArguments } from './protocolDetection';
import { ProcessTreeNode, getProcessTree } from './processTree';

const localize = nls.loadMessageBundle();

const POLL_INTERVAL = 1000;

const pids: Promise<number>[] = [];
let autoAttacher: vscode.Disposable | undefined;


export function getPidFromSession(session: vscode.DebugSession): Promise<number> {
	return new Promise<number>((resolve, e) => {
		setTimeout(_ => {

			// wait a maximum of 100 ms for response
			const timer = setTimeout(_ => {
				resolve(NaN);
			}, 100);

			// try to get the process ID from the debuggee
			if (session) {
				session.customRequest('evaluate', { expression: 'process.pid' }).then(reply => {
					clearTimeout(timer);
					resolve(parseInt(reply.result));
				}, e => {
					clearTimeout(timer);
					resolve(NaN);
				});
			} else {
				clearTimeout(timer);
				resolve(NaN);
			}
		}, session.type === 'node2' ? 500 : 100);
	});
}

export function initializeAutoAttach(context: vscode.ExtensionContext) {

	context.subscriptions.push(vscode.debug.onDidStartDebugSession(session => {
		if (session.type === 'node' || session.type === 'node2') {
			// try to get pid from newly started node.js debug session
			pids.push(getPidFromSession(session));
		}
	}));

	context.subscriptions.push(vscode.commands.registerCommand('extension.node-debug.startAutoAttach', rootPid => {
		if (typeof rootPid === 'number') {
			autoAttacher = pollProcesses(rootPid, true, (pid, cmdPath, args) => {
				const cmdName = basename(cmdPath, '.exe');
				if (cmdName === 'node') {
					const name = localize('process.with.pid.label', "Auto attached ({0})", pid);
					attachToProcess(undefined, name, pid, args);
				}
			});
		}
	}));

	context.subscriptions.push(vscode.commands.registerCommand('extension.node-debug.stopAutoAttach', () => {
		if (autoAttacher) {
			autoAttacher.dispose();
			autoAttacher = undefined;
		}
	}));
}

function alreadyAttached(pid: number): Promise<boolean> {

	return Promise.all(pids).then(pids => {
		return pids.indexOf(pid) >= 0;
	});
}

export function attachToProcess(folder: vscode.WorkspaceFolder | undefined, name: string, pid: number, args: string, baseConfig?: vscode.DebugConfiguration, parentSession?: vscode.DebugSession) {

	alreadyAttached(pid).then(isAttached => {
		if (isAttached) {
			// console.log(`ignore auto attach for ${pid}`);
		} else {

			pids.push(Promise.resolve(pid));

			const config: vscode.DebugConfiguration = {
				type: 'node',
				request: 'attach',
				name: name,
				stopOnEntry: false,
				__autoAttach: true
			};

			if (baseConfig) {
				// selectively copy attributes
				if (typeof baseConfig.timeout === 'number') {
					config.timeout = baseConfig.timeout;
				}
				if (typeof baseConfig.sourceMaps === 'boolean') {
					config.sourceMaps = baseConfig.sourceMaps;
				}
				if (baseConfig.outFiles) {
					config.outFiles = baseConfig.outFiles;
				}
				if (baseConfig.sourceMapPathOverrides) {
					config.sourceMapPathOverrides = baseConfig.sourceMapPathOverrides;
				}
				if (typeof baseConfig.smartStep === 'boolean') {
					config.smartStep = baseConfig.smartStep;
				}
				if (baseConfig.skipFiles) {
					config.skipFiles = baseConfig.skipFiles;
				}
				if (typeof baseConfig.showAsyncStacks === 'boolean') {
					config.showAsyncStacks = baseConfig.showAsyncStacks;
				}
				if (typeof baseConfig.trace === 'boolean' || typeof baseConfig.trace === 'string') {
					config.trace = baseConfig.trace;
				}
				if (typeof baseConfig.stopOnEntry === 'boolean') {
					config.stopOnEntry = baseConfig.stopOnEntry;
				}
			}

			let { usePort, protocol, port } = analyseArguments(args);
			if (usePort) {
				config.processId = `${protocol}${port}`;
			} else {
				if (protocol && port > 0) {
					config.processId = `${pid}${protocol}${port}`;
				} else {
					config.processId = pid.toString();
				}
			}

			vscode.debug.startDebugging(folder, config, parentSession);
		}
	});
}

/**
 * Poll for all subprocesses of given root process.
 */
function pollProcesses(rootPid: number, inTerminal: boolean, cb: (pid: number, cmd: string, args: string) => void) : vscode.Disposable {

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

function findChildProcesses(rootPid: number, inTerminal: boolean, cb: (pid: number, cmd: string, args: string) => void): Promise<void> {

	function walker(node: ProcessTreeNode, terminal: boolean, terminalPids: number[]) {

		if (terminalPids.indexOf(node.pid) >= 0) {
			terminal = true;	// found the terminal shell
		}

		let { protocol } = analyseArguments(node.args);
		if (terminal && protocol) {
			cb(node.pid, node.command, node.args);
		}

		for (const child of node.children || []) {
			walker(child, terminal, terminalPids);
		}
	}

	return getProcessTree(rootPid).then(tree => {
		if (tree) {
			const terminals = vscode.window.terminals;
			if (terminals.length > 0) {
				Promise.all(terminals.map(terminal => terminal.processId)).then(terminalPids => {
					walker(tree, !inTerminal, terminalPids);
				});
			}
		}
	});
}
