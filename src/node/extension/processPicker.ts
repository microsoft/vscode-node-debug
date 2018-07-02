/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

'use strict';

import * as nls from 'vscode-nls';
import * as vscode from 'vscode';
import { basename } from 'path';
import { getProcesses } from './processTree';
import { execSync } from 'child_process';
import { detectProtocolForPid, INSPECTOR_PORT_DEFAULT, LEGACY_PORT_DEFAULT } from './protocolDetection';
import { analyseArguments } from './protocolDetection';

const localize = nls.loadMessageBundle();

//---- extension.pickNodeProcess

interface ProcessItem extends vscode.QuickPickItem {
	pidOrPort: string;	// picker result
	sortKey: number;
}

/**
 * end user action for picking a process and attaching debugger to it
 */
export async function attachProcess() {

	const config = {
		type: 'node',
		request: 'attach',
		name: 'process',
		processId: '${command:extension.pickNodeProcess}'
	};

	if (!await resolveProcessId(config)) {
		return vscode.debug.startDebugging(undefined, config);
	}
	return undefined;
}

/**
 * returns true if UI was cancelled
 */
export async function resolveProcessId(config: vscode.DebugConfiguration) : Promise<boolean> {

	// we resolve Process Picker early (before VS Code) so that we can probe the process for its protocol
	let processId = config.processId.trim();
	if (processId === '${command:PickProcess}' || processId === '${command:extension.pickNodeProcess}') {
		const result = await pickProcess(true);	// ask for pids and ports!
		if (!result) {
			// UI dismissed (cancelled)
			return true;
		}
		processId = result;
	}

	const matches = /^(inspector|legacy)?([0-9]+)(inspector|legacy)?([0-9]+)?$/.exec(processId);
	if (matches && matches.length === 5) {

		if (matches[2] && matches[3] && matches[4]) {

			// process id and protocol and port

			const pid = Number(matches[2]);
			putPidInDebugMode(pid);

			// debug port
			config.port = Number(matches[4]);
			config.protocol = matches[3];
			delete config.processId;

		} else {

			// protocol and port
			if (matches[1]) {

				// debug port
				config.port = Number(matches[2]);
				config.protocol = matches[1];
				delete config.processId;

			} else {

				// process id
				const pid = Number(matches[2]);
				putPidInDebugMode(pid);

				const debugType = await determineDebugTypeForPidInDebugMode(config, pid);
				if (debugType) {
					// processID is handled, so turn this config into a normal port attach configuration
					delete config.processId;
					config.port = debugType === 'node2' ? INSPECTOR_PORT_DEFAULT : LEGACY_PORT_DEFAULT;
					config.protocol = debugType === 'node2' ? 'inspector' : 'legacy';
				} else {
					throw new Error(localize('pid.error', "Attach to process: cannot put process '{0}' in debug mode.", processId));
				}
			}
		}

	} else {
		throw new Error(localize('process.id.error', "Attach to process: '{0}' doesn't look like a process id.", processId));
	}

	return false;
}

/**
 * Process picker command (for launch config variable)
 * Returns as a string with these formats:
 * - "12345": process id
 * - "inspector12345": port number and inspector protocol
 * - "legacy12345": port number and legacy protocol
 * - null: abort launch silently
 */
export function pickProcess(ports?): Promise<string | null> {

	return listProcesses(ports).then(items => {
		let options: vscode.QuickPickOptions = {
			placeHolder: localize('pickNodeProcess', "Pick the node.js process to attach to"),
			matchOnDescription: true,
			matchOnDetail: true
		};
		return vscode.window.showQuickPick(items, options).then(item => item ? item.pidOrPort : null);
	}).catch(err => {
		return vscode.window.showErrorMessage(localize('process.picker.error', "Process picker failed ({0})", err.message), { modal: true }).then(_ => null);
	});
}

//---- private

function listProcesses(ports: boolean): Promise<ProcessItem[]> {

	const items: ProcessItem[] = [];

	const NODE = new RegExp('^(?:node|iojs)$', 'i');

	let seq = 0;	// default sort key

	return getProcesses((pid: number, ppid: number, command: string, args: string, date: number) => {

		if (process.platform === 'win32' && command.indexOf('\\??\\') === 0) {
			// remove leading device specifier
			command = command.replace('\\??\\', '');
		}

		const executable_name = basename(command, '.exe');

		let port = -1;
		let protocol: string | undefined = '';
		let usePort = true;

		if (ports) {
			const x = analyseArguments(args);
			usePort = x.usePort;
			protocol = x.protocol;
			port = x.port;
		}

		let description = '';
		let pidOrPort = '';

		if (usePort) {
			if (protocol === 'inspector') {
				description = localize('process.id.port', "process id: {0}, debug port: {1}", pid, port);
			} else {
				description = localize('process.id.port.legacy', "process id: {0}, debug port: {1} (legacy protocol)", pid, port);
			}
			pidOrPort = `${protocol}${port}`;
		} else {
			if (protocol && port > 0) {
				description = localize('process.id.port.signal', "process id: {0}, debug port: {1} ({2})", pid, port, 'SIGUSR1');
				pidOrPort = `${pid}${protocol}${port}`;
			} else {
				// no port given
				if (NODE.test(executable_name)) {
					description = localize('process.id.signal', "process id: {0} ({1})", pid, 'SIGUSR1');
					pidOrPort = pid.toString();
				}
			}
		}

		if (description && pidOrPort) {
			items.push({
				// render data
				label: executable_name,
				description: args,
				detail: description,

				// picker result
				pidOrPort: pidOrPort,
				// sort key
				sortKey: date ? date : seq++
			});
		}

	}).then(() => items.sort((a, b) => b.sortKey - a.sortKey));		// sort items by process id, newest first
}

function putPidInDebugMode(pid: number): void {
	try {
		if (process.platform === 'win32') {
			// regular node has an undocumented API function for forcing another node process into debug mode.
			// 		(<any>process)._debugProcess(pid);
			// But since we are running on Electron's node, process._debugProcess doesn't work (for unknown reasons).
			// So we use a regular node instead:
			const command = `node -e process._debugProcess(${pid})`;
			execSync(command);
		} else {
			process.kill(pid, 'SIGUSR1');
		}
	} catch (e) {
		throw new Error(localize('cannot.enable.debug.mode.error', "Attach to process: cannot enable debug mode for process '{0}' ({1}).", pid, e));
	}
}

function determineDebugTypeForPidInDebugMode(config: any, pid: number): Promise<string | null> {
	let debugProtocolP: Promise<string | null>;
	if (config.port === INSPECTOR_PORT_DEFAULT) {
		debugProtocolP = Promise.resolve('inspector');
	} else if (config.port === LEGACY_PORT_DEFAULT) {
		debugProtocolP = Promise.resolve('legacy');
	} else if (config.protocol) {
		debugProtocolP = Promise.resolve(config.protocol);
	} else {
		debugProtocolP = detectProtocolForPid(pid);
	}

	return debugProtocolP.then(debugProtocol => {
		return debugProtocol === 'inspector' ? 'node2' :
			debugProtocol === 'legacy' ? 'node' :
				null;
	});
}
