/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

'use strict';

import * as nls from 'vscode-nls';
import * as cp from 'child_process';
import { writeToConsole, extendObject, Logger } from './utilities';
import * as net from 'net';
import * as WSL from '../wslSupport';

const localize = nls.loadMessageBundle();

export const INSPECTOR_PORT_DEFAULT = 9229;
export const LEGACY_PORT_DEFAULT = 5858;

// For launch, use inspector protocol starting with v8 because it's stable after that version.
const InspectorMinNodeVersionLaunch = 80000;

export function detectDebugType(config: any, logger: Logger): Promise<string|null> {
	switch (config.request) {
		case 'attach':
			return detectProtocolForAttach(config, logger).then(protocol => {
				return protocol === 'inspector' ? 'node2' : 'node';
			});

		case 'launch':
			return Promise.resolve(detectProtocolForLaunch(config, logger) === 'inspector' ? 'node2' : 'node');
		default:
			// should not happen
			break;
		}

	return Promise.resolve(null);
}

/**
 * Detect which debug protocol is being used for a running node process.
 */
function detectProtocolForAttach(config: any, logger: Logger): Promise<string | undefined> {
	const address = config.address || '127.0.0.1';
	const port = config.port;
	const socket = new net.Socket();
	const cleanup = () => {
		try {
			socket.write(`"Content-Length: 50\r\n\r\n{"command":"disconnect","type":"request","seq":2}"`);
			socket.end();
		} catch (e) {
			// ignore failure
		}
	};

	return new Promise<{ reason?: string, protocol: string }>((resolve, reject) => {
		socket.once('data', data => {
			let reason: string|undefined = undefined;
			let protocol: string;
			const dataStr = data.toString();
			if (dataStr.indexOf('WebSockets request was expected') >= 0) {
				logger.debug('Debugging with inspector protocol because it was detected.');
				protocol = 'inspector';
			} else {
				reason = localize('protocol.switch.legacy.detected', "Debugging with legacy protocol because it was detected.");
				protocol = 'legacy';
			}

			resolve({ reason, protocol });
		});

		socket.once('error', err => {
			reject(err);
		});

		socket.connect(port, address);
		socket.on('connect', () => {
			// Send a safe request to trigger a response from the inspector protocol
			socket.write(`Content-Length: 102\r\n\r\n{"command":"evaluate","arguments":{"expression":"process.pid","global":true},"type":"request","seq":1}`);
		});

		setTimeout(() => {
			// No data or error received? Bail and let the debug adapter handle it.
			reject(new Error('timeout'));
		}, 2000);
	}).catch(err => {
		return {
			reason: localize('protocol.switch.unknown.error', "Debugging with inspector protocol because Node.js version could not be determined ({0})", err.toString()),
			protocol: 'inspector'
		};
	}).then(result => {
		cleanup();
		if (result.reason) {
			writeToConsole(result.reason);
			logger.debug(result.reason);
		}

		return result.protocol;
	});
}

function detectProtocolForLaunch(config: any, logger: Logger): 'legacy'|'inspector' {
	if (config.runtimeExecutable) {
		logger.debug('Debugging with inspector protocol because a runtime executable is set.');
		return 'inspector';
	} else {
		// only determine version if no runtimeExecutable is set (and 'node' on PATH is used)
		let env = process.env;
		if (config.env) {
			env = extendObject(extendObject( {} , process.env), config.env);
		}
		const result = WSL.spawnSync(config.useWSL, 'node', ['--version'], { shell: true, env: env });
		const semVerString = result.stdout ? result.stdout.toString() : undefined;
		if (semVerString) {
			config.__nodeVersion = semVerString.trim();
			if (semVerStringToInt(config.__nodeVersion) >= InspectorMinNodeVersionLaunch) {
				logger.debug(`Debugging with inspector protocol because Node.js ${config.__nodeVersion} was detected.`);
				return 'inspector';
			} else {
				writeToConsole(localize('protocol.switch.legacy.version', "Debugging with legacy protocol because Node.js {0} was detected.", config.__nodeVersion));
				logger.debug(`Debugging with legacy protocol because Node.js ${config.__nodeVersion} was detected.`);
				return 'legacy';
			}
		} else {
			logger.debug('Debugging with inspector protocol because Node.js version could not be determined.');
			return 'inspector';
		}
	}
}

/**
 * convert the 3 parts of a semVer string into a single number
 */
function semVerStringToInt(vString: string): number {
	const match = vString.match(/v(\d+)\.(\d+)\.(\d+)/);
	if (match && match.length === 4) {
		return (parseInt(match[1]) * 100 + parseInt(match[2])) * 100 + parseInt(match[3]);
	}
	return -1;
}

export function detectProtocolForPid(pid: number): Promise<string|null> {
	return process.platform === 'win32' ?
		detectProtocolForPidWin(pid) :
		detectProtocolForPidUnix(pid);
}

function detectProtocolForPidWin(pid: number): Promise<string|null> {
	return getOpenPortsForPidWin(pid).then(ports => {
		return ports.indexOf(INSPECTOR_PORT_DEFAULT) >= 0 ? 'inspector' :
			ports.indexOf(LEGACY_PORT_DEFAULT) >= 0 ? 'legacy' : null;
	});
}

/**
 * Netstat output is like:
   Proto  Local Address          Foreign Address        State           PID
   TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       812
 */
function getOpenPortsForPidWin(pid: number): Promise<number[]> {
	return new Promise(resolve => {
		cp.exec('netstat -a -n -o -p TCP', (err, stdout) => {
			if (err || !stdout) {
				resolve([]);
			}

			const ports = stdout
				.split(/\r?\n/)
				.map(line => line.trim().split(/\s+/))
				.filter(lineParts => {
					// Filter to just `pid` rows
					return lineParts[4] && lineParts[4] === String(pid);
				})
				.map(lineParts => {
					const address = lineParts[1];
					return parseInt(address.split(':')[1]);
				});

				resolve(ports);
		});
	});
}

function detectProtocolForPidUnix(pid: number): Promise<string|null> {
	return getPidListeningOnPortUnix(INSPECTOR_PORT_DEFAULT).then<string|null>(inspectorProtocolPid => {
		if (inspectorProtocolPid === pid) {
			return 'inspector';
		} else {
			return getPidListeningOnPortUnix(LEGACY_PORT_DEFAULT)
				.then(legacyProtocolPid => legacyProtocolPid === pid ? 'legacy' : null);
		}
	});
}

function getPidListeningOnPortUnix(port: number): Promise<number> {
	return new Promise(resolve => {
		cp.exec(`lsof -i:${port} -F p`, (err, stdout) => {
			if (err || !stdout) {
				resolve(-1);
				return;
			}

			const pidMatch = stdout.match(/p(\d+)/);
			if (pidMatch && pidMatch[1]) {
				resolve(Number(pidMatch[1]));
			} else {
				resolve(-1);
			}
		});
	});
}

export interface DebugArguments {
	usePort: boolean;	// if true debug by using the debug port
	protocol?: 'legacy' | 'inspector';	//
	address?: string;
	port: number;
}

/*
 * analyse the given command line arguments and extract debug port and protocol from it.
 */
export function analyseArguments(args: string): DebugArguments {

	const DEBUG_FLAGS_PATTERN = /--(inspect|debug)(-brk)?(=((\[[0-9a-fA-F:]*\]|[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+|[a-zA-Z0-9\.]*):)?(\d+))?/;
	const DEBUG_PORT_PATTERN = /--(inspect|debug)-port=(\d+)/;

	const result: DebugArguments = {
		usePort: false,
		port: -1
	};

	// match --debug, --debug=1234, --debug-brk, debug-brk=1234, --inspect, --inspect=1234, --inspect-brk, --inspect-brk=1234
	let matches = DEBUG_FLAGS_PATTERN.exec(args);
	if (matches && matches.length >= 2) {
		// attach via port
		result.usePort = true;
		if (matches.length >= 6 && matches[5]) {
			result.address = matches[5];
		}
		if (matches.length >= 7 && matches[6]) {
			result.port = parseInt(matches[6]);
		}
		result.protocol = matches[1] === 'debug' ? 'legacy' : 'inspector';
	}

	// a debug-port=1234 or --inspect-port=1234 overrides the port
	matches = DEBUG_PORT_PATTERN.exec(args);
	if (matches && matches.length === 3) {
		// override port
		result.port = parseInt(matches[2]);
		result.protocol = matches[1] === 'debug' ? 'legacy' : 'inspector';
	}

	if (result.port < 0) {
		result.port = result.protocol === 'inspector' ? INSPECTOR_PORT_DEFAULT : LEGACY_PORT_DEFAULT;
	}

	return result;
}