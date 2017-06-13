/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

'use strict';

import { spawnSync } from 'child_process';
import { log, localize } from './utilities';
import * as net from 'net';

// For launch, use inspector protocol starting with v8 because it's stable after that version.
const InspectorMinNodeVersionLaunch = 80000;

export function determineDebugType(config: any): Promise<string> {
	switch (config.protocol) {
		case 'legacy':
			return Promise.resolve('node');
		case 'inspector':
			return Promise.resolve('node2');
		case 'auto':
		default:
			switch (config.request) {
				case 'attach':
					return autodetectProtocolForAttach(config).then(protocol => {
						return protocol === 'inspector' ? 'node2' : 'node';
					});

				case 'launch':
					return Promise.resolve(autodetectProtocolForLaunch(config) === 'inspector' ? 'node2' : 'node');
				default:
					// should not happen
					break;
			}
			return Promise.resolve('undefined');
	}
}

/**
 * Detect which debug protocol is being used for a running node process.
 */
function autodetectProtocolForAttach(config: any): Promise<string | undefined> {
	const address = config.address || '127.0.0.1';
	const port = config.port;

	if (config.processId) {
		// this is only supported for legacy protocol
		log(localize('protocol.switch.attach.process', "Debugging with legacy protocol because attaching to a process by ID is only supported for legacy protocol."));
		return Promise.resolve('legacy');
	}

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

function autodetectProtocolForLaunch(config: any): string | undefined {
	if (config.runtimeExecutable) {
		log(localize('protocol.switch.runtime.set', "Debugging with inspector protocol because a runtime executable is set."));
		return 'inspector';
	} else {
		// only determine version if no runtimeExecutable is set (and 'node' on PATH is used)
		const result = spawnSync('node', ['--version']);
		const semVerString = result.stdout.toString();
		if (semVerString) {
			if (semVerStringToInt(semVerString) >= InspectorMinNodeVersionLaunch) {
				log(localize('protocol.switch.inspector.version', "Debugging with inspector protocol because Node.js {0} was detected.", semVerString.trim()));
				return 'inspector';
			} else {
				log(localize('protocol.switch.legacy.version', "Debugging with legacy protocol because Node.js {0} was detected.", semVerString.trim()));
				return 'legacy';
			}
		} else {
			log(localize('protocol.switch.unknown.version', "Debugging with legacy protocol because Node.js version could not be determined."));
		}
	}

	return undefined;
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
