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

const localize = nls.loadMessageBundle();

//---- extension.pickNodeProcess

interface ProcessItem extends vscode.QuickPickItem {
	pidOrPort: string;	// picker result
	pid: number;		// used for sorting
}

/**
 * end user action for picking a process and attaching debugger to it
 */
export async function attachProcess() {

	const config = {
		type: 'node',
		request: 'attach',
		name: 'process'
	};

	if (!await pickProcessForConfig(config)) {
		return vscode.debug.startDebugging(undefined, config);
	}
	return undefined;
}

/**
 * returns true if UI was cancelled
 */
export async function pickProcessForConfig(config: vscode.DebugConfiguration) : Promise<boolean> {

	const pidResult = await pickProcess(true);	// ask for pids and ports!
	if (!pidResult) {
		// UI dismissed (cancelled)
		return true;
	}
	const matches = /^(inspector|legacy)?([0-9]+)$/.exec(pidResult);
	if (matches && matches.length === 3) {

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
				throw new Error(localize('pid.error', "Attach to process: cannot put process '{0}' in debug mode.", pidResult));
			}
		}

	} else {
		throw new Error(localize('VSND2006', "Attach to process: '{0}' doesn't look like a process id.", pidResult));
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
			placeHolder: localize('pickNodeProcess', "Pick the node.js or gulp process to attach to"),
			matchOnDescription: true,
			matchOnDetail: true,
			ignoreFocusOut: true
		};
		return vscode.window.showQuickPick(items, options).then(item => item ? item.pidOrPort : null);
	}).catch(err => {
		return vscode.window.showErrorMessage(localize('process.picker.error', "Process picker failed ({0})", err.message), { modal: true }).then(_ => null);
	});
}

//---- private

function listProcesses(ports: boolean): Promise<ProcessItem[]> {

	const items: ProcessItem[] = [];

	const DEBUG_PORT_PATTERN = /\s--(inspect|debug)-port=(\d+)/;
	const DEBUG_FLAGS_PATTERN = /\s--(inspect|debug)(-brk)?(=(\d+))?/;

	const NODE = new RegExp('^(?:node|iojs)$', 'i');

	return getProcesses((pid: number, ppid: number, command: string, args: string) => {

		if (process.platform === 'win32' && command.indexOf('\\??\\') === 0) {
			// remove leading device specifier
			command = command.replace('\\??\\', '');
		}

		const executable_name = basename(command);

		let port = -1;
		let protocol = '';

		if (ports) {
			// match --debug, --debug=1234, --debug-brk, debug-brk=1234, --inspect, --inspect=1234, --inspect-brk, --inspect-brk=1234
			let matches = DEBUG_FLAGS_PATTERN.exec(args);
			if (matches && matches.length >= 2) {
				// attach via port
				if (matches.length === 5 && matches[4]) {
					port = parseInt(matches[4]);
				}
				protocol = matches[1] === 'debug' ? 'legacy' : 'inspector';
			}

			// a debug-port=1234 or --inspect-port=1234 overrides the port
			matches = DEBUG_PORT_PATTERN.exec(args);
			if (matches && matches.length === 3) {
				// override port
				port = parseInt(matches[2]);
				protocol = matches[1] === 'debug' ? 'legacy' : 'inspector';
			}
		}

		let description = '';
		let pidOrPort = '';
		if (protocol) {
			if (port < 0) {
				port = protocol === 'inspector' ? INSPECTOR_PORT_DEFAULT : LEGACY_PORT_DEFAULT;
			}
			if (protocol === 'inspector') {
				description = `Debug Port: ${port}`;
			} else {
				description = `Debug Port: ${port} (legacy protocol)`;
			}
			pidOrPort = `${protocol}${port}`;
		} else {
			if (NODE.test(executable_name)) {
				description = `Process Id: ${pid}`;
				pidOrPort = pid.toString();
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
				pid: pid
			});
		}

	}).then(() => items.sort((a, b) => b.pid - a.pid));		// sort items by process id, newest first
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
		throw new Error(localize('VSND2021', "Attach to process: cannot enable debug mode for process '{0}' ({1}).", pid, e));
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
