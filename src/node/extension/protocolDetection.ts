/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

'use strict';

import * as cp from 'child_process';
import { log, localize, extendObject } from './utilities';
import * as net from 'net';
import * as WSL from '../wslSupport';

export const INSPECTOR_PORT_DEFAULT = 9229;
export const LEGACY_PORT_DEFAULT = 5858;

// For launch, use inspector protocol starting with v8 because it's stable after that version.
const InspectorMinNodeVersionLaunch = 80000;

export function detectDebugType(config: any): Promise<string|null> {
	switch (config.request) {
		case 'attach':
			return detectProtocolForAttach(config).then(protocol => {
				return protocol === 'inspector' ? 'node2' : 'node';
			});

		case 'launch':
			return Promise.resolve(detectProtocolForLaunch(config) === 'inspector' ? 'node2' : 'node');
		default:
			// should not happen
			break;
		}

	return Promise.resolve(null);
}

/**
 * Detect which debug protocol is being used for a running node process.
 */
function detectProtocolForAttach(config: any): Promise<string | undefined> {
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

	return new Promise<{ reason: string, protocol: string }>((resolve, reject) => {
		socket.once('data', data => {
			let reason: string;
			let protocol: string;
			const dataStr = data.toString();
			if (dataStr.indexOf('WebSockets request was expected') >= 0) {
				reason = localize('protocol.switch.inspector.detected', "Debugging with inspector protocol because it was detected.");
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
			reason: localize('protocol.switch.unknown.error', "Debugging with legacy protocol because Node.js version could not be determined ({0})", err.toString()),
			protocol: 'legacy'
		};
	}).then(result => {
		cleanup();
		log(result.reason);

		return result.protocol;
	});
}

function detectProtocolForLaunch(config: any): 'legacy'|'inspector' {
	if (config.runtimeExecutable) {
		log(localize('protocol.switch.runtime.set', "Debugging with inspector protocol because a runtime executable is set."));
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
				log(localize('protocol.switch.inspector.version', "Debugging with inspector protocol because Node.js {0} was detected.", config.__nodeVersion));
				return 'inspector';
			} else {
				log(localize('protocol.switch.legacy.version', "Debugging with legacy protocol because Node.js {0} was detected.", config.__nodeVersion));
				return 'legacy';
			}
		} else {
			log(localize('protocol.switch.unknown.version', "Debugging with inspector protocol because Node.js version could not be determined."));
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
