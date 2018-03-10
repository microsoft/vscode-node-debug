/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

import * as nls from 'vscode-nls';
import { spawn } from 'child_process';
import * as vscode from 'vscode';
import { join } from 'path';

const localize = nls.loadMessageBundle();

const POLL_INTERVAL = 1000;

const DEBUG_PORT_PATTERN = /\s--(inspect|debug)-port=(\d+)/;
const DEBUG_FLAGS_PATTERN = /\s--(inspect|debug)(-brk)?(=(\d+))?/;

class Cluster {
	folder: vscode.WorkspaceFolder | undefined;
	config: vscode.DebugConfiguration;
	session: vscode.DebugSession;
	pids: Set<number>;
	intervalId: NodeJS.Timer;

	constructor(folder: vscode.WorkspaceFolder | undefined, config: vscode.DebugConfiguration) {
		this.folder = folder;
		this.config = config;
		this.pids = new Set<number>();
	}

	startWatching(session: vscode.DebugSession) {
		this.session = session;

		setTimeout(_ => {
			// get the process ID from the debuggee
			this.session.customRequest('evaluate', { expression: 'process.pid' }).then(reply => {
				const rootPid = parseInt(reply.result);
				this.attachChildProcesses(rootPid);
			}, e => {
				// 'evaluate' error -> use the fall back strategy
				this.attachChildProcesses(NaN);
			});
		}, this.session.type === 'node2' ? 500 : 100);
	}

	stopWatching() {
		if (this.intervalId) {
			clearInterval(this.intervalId);
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
		findChildProcesses(rootPid, cb);
		this.intervalId = setInterval(() => {
			findChildProcesses(rootPid, cb);
		}, POLL_INTERVAL);
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

function findChildProcesses(rootPid: number, cb: (pid: number, cmd: string) => void) {

	const set = new Set<number>();

	if (!isNaN(rootPid) && rootPid > 0) {
		set.add(rootPid);
	}

	function oneProcess(pid: number, ppid: number, cmd: string) {

		if (set.size === 0) {
			// try to find the root process
			const matches = DEBUG_PORT_PATTERN.exec(cmd);
			if (matches && matches.length >= 3) {
				// since this is a child we add the parent id as the root id
				set.add(ppid);
			}
		}

		if (set.has(ppid)) {
			set.add(pid);
			const matches = DEBUG_PORT_PATTERN.exec(cmd);
			const matches2 = DEBUG_FLAGS_PATTERN.exec(cmd);
			if ((matches && matches.length >= 3) || (matches2 && matches2.length >= 5)) {
				cb(pid, cmd);
			}
		}
	}

	// returns a function that aggregates chunks of data until one or more complete lines are received and passes them to a callback.
	function lines(callback: (a: string) => void) {
		let unfinished = '';	// unfinished last line of chunk
		return (data: string | Buffer) => {
			const lines = data.toString().split(/\r?\n/);
			const finishedLines = lines.slice(0, lines.length - 1);
			finishedLines[0] = unfinished + finishedLines[0]; // complete previous unfinished line
			unfinished = lines[lines.length - 1]; // remember unfinished last line of this chunk for next round
			for (const s of finishedLines) {
				callback(s);
			}
		}
	}

	if (process.platform === 'win32') {

		const CMD_PAT = /^(.+)\s+([0-9]+)\s+([0-9]+)$/;

		const wmic = join(process.env['WINDIR'] || 'C:\\Windows', 'System32', 'wbem', 'WMIC.exe');
		var proc = spawn(wmic, [ 'process', 'get', 'CommandLine,ParentProcessId,ProcessId' ]);
		proc.stdout.setEncoding('utf8');
		proc.stdout.on('data', lines(line => {
			let matches = CMD_PAT.exec(line.trim());
			if (matches && matches.length === 4) {
				oneProcess(parseInt(matches[3]), parseInt(matches[2]), matches[1].trim());
			}
		}));

	} else {	// OS X & Linux

		const CMD_PAT = /^\s*([0-9]+)\s+([0-9]+)\s+(.+)$/;

		var proc = spawn('/bin/ps', [ '-ax', '-o', 'pid=,ppid=,command=' ]);
		proc.stdout.setEncoding('utf8');
		proc.stdout.on('data', lines(line => {
			let matches = CMD_PAT.exec(line.trim());
			if (matches && matches.length === 4) {
				oneProcess(parseInt(matches[1]), parseInt(matches[2]), matches[3]);
			}
		}));
	}
}
