/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as EE from 'events';
import * as nls from 'vscode-nls';

const localize = nls.loadMessageBundle();

export class NodeV8Message {
	seq: number;
	type: 'request' | 'response' | 'event';

	public constructor(type: 'request' | 'response' | 'event') {
		this.seq = 0;
		this.type = type;
	}
}

export class NodeV8Response extends NodeV8Message {
	request_seq: number;
	success: boolean;
	running:  boolean;
	command: string;
	message: string;
	body: any;
	refs: any;

	public constructor(request: NodeV8Response, message?: string) {
		super('response');
		this.request_seq = request.seq;
		this.command = request.command;
		if (message) {
			this.success = false;
			this.message = message;
		} else {
			this.success = true;
		}
	}
}

export class NodeV8Event extends NodeV8Message {
	event: string;
	body: any;

	public constructor(event: string, body?: any) {
		super('event');
		this.event = event;
		if (body) {
			this.body = body;
		}
	}
}

export class NodeV8Protocol extends EE.EventEmitter {

	private static TIMEOUT = 10000;
	private static TWO_CRLF = '\r\n\r\n';

	private _rawData: Buffer;
	private _contentLength: number;
	private _sequence: number;
	private _writableStream: NodeJS.WritableStream;
	private _pendingRequests = new Map<number, NodeV8Response>();
	private _unresponsiveMode: boolean;

	public embeddedHostVersion: number = -1;
	public v8Version: string;


	public startDispatch(inStream: NodeJS.ReadableStream, outStream: NodeJS.WritableStream) : void {
		this._sequence = 1;
		this._writableStream = outStream;

		inStream.on('data', (data: Buffer) => this.execute(data));
		inStream.on('close', () => {
			this.emitEvent(new NodeV8Event('close'));
		});
		inStream.on('error', (error) => {
			this.emitEvent(new NodeV8Event('error'));
		});

		outStream.on('error', (error) => {
			this.emitEvent(new NodeV8Event('error'));
		});

		inStream.resume();
	}

	public stop() : void {
		if (this._writableStream) {
			this._writableStream.end();
		}
	}

	public command(command: string, args?: any, cb?: (response: NodeV8Response) => void) : void {
		this._command(command, args, NodeV8Protocol.TIMEOUT, cb);
	}

	public command2(command: string, args?: any, timeout: number = NodeV8Protocol.TIMEOUT) : Promise<NodeV8Response> {
		return new Promise((completeDispatch, errorDispatch) => {
			this._command(command, args, timeout, (result: NodeV8Response) => {
				if (result.success) {
					completeDispatch(result);
				} else {
					errorDispatch(result);
				}
			});
		});
	}

	public sendEvent(event: NodeV8Event) : void {
		this.send('event', event);
	}

	public sendResponse(response: NodeV8Response) : void {
		if (response.seq > 0) {
			// console.error('attempt to send more than one response for command {0}', response.command);
		} else {
			this.send('response', response);
		}
	}

	// ---- private ------------------------------------------------------------

	private _command(command: string, args: any, timeout: number, cb: (response: NodeV8Response) => void) : void {

		const request: any = {
			command: command
		};
		if (args && Object.keys(args).length > 0) {
			request.arguments = args;
		}

		if (!this._writableStream) {
			if (cb) {
				cb(new NodeV8Response(request, localize('not.connected', "not connected to runtime")));
			}
			return;
		}

		if (this._unresponsiveMode) {
			if (cb) {
				cb(new NodeV8Response(request, localize('runtime.unresponsive', "cancelled because Node.js is unresponsive")));
			}
			return;
		}

		this.send('request', request);

		if (cb) {
			this._pendingRequests[request.seq] = cb;

			const timer = setTimeout(() => {
				clearTimeout(timer);
				const clb = this._pendingRequests[request.seq];
				if (clb) {
					delete this._pendingRequests[request.seq];
					clb(new NodeV8Response(request, localize('runtime.timeout', "timeout after {0} ms", timeout)));

					this._unresponsiveMode = true;
					this.emitEvent(new NodeV8Event('diagnostic', { reason: `request '${command}' timed out'`}));
				}
			}, timeout);
		}
	}

	private emitEvent(event: NodeV8Event) {
		this.emit(event.event, event);
	}

	private send(typ: 'request' | 'response' | 'event', message: NodeV8Message) : void {
		message.type = typ;
		message.seq = this._sequence++;
		const json = JSON.stringify(message);
		const data = 'Content-Length: ' + Buffer.byteLength(json, 'utf8') + '\r\n\r\n' + json;
		if (this._writableStream) {
			this._writableStream.write(data);
		}
	}

	private internalDispatch(message: NodeV8Message) : void {
		switch (message.type) {
		case 'event':
			const e = <NodeV8Event> message;
			this.emitEvent(e);
			break;
		case 'response':
			if (this._unresponsiveMode) {
				this._unresponsiveMode = false;
				this.emitEvent(new NodeV8Event('diagnostic', { reason: 'responsive' }));
			}
			const response = <NodeV8Response> message;
			const clb = this._pendingRequests[response.request_seq];
			if (clb) {
				delete this._pendingRequests[response.request_seq];
				clb(response);
			}
			break;
		default:
			break;
		}
	}

	private execute(data: Buffer): void {

		this._rawData = this._rawData ? Buffer.concat([this._rawData, data]) : data;

		while (true) {
			if (this._contentLength >= 0) {
				if (this._rawData.length >= this._contentLength) {
					const message = this._rawData.toString('utf8', 0, this._contentLength);
					this._rawData = this._rawData.slice(this._contentLength);
					this._contentLength = -1;
					if (message.length > 0) {
						try {
							this.internalDispatch(JSON.parse(message));
						}
						catch (e) {
						}
					}
					continue;	// there may be more complete messages to process
				}
			} else {
				const idx = this._rawData.indexOf(NodeV8Protocol.TWO_CRLF);
				if (idx !== -1) {
					const header = this._rawData.toString('utf8', 0, idx);
					const lines = header.split('\r\n');
					for (let i = 0; i < lines.length; i++) {
						const pair = lines[i].split(/: +/);
						switch (pair[0]) {
							case 'V8-Version':
								const match0 = pair[1].match(/(\d+(?:\.\d+)+)/);
								if (match0 && match0.length === 2) {
									this.v8Version = match0[1];
								}
								break;
							case 'Embedding-Host':
								const match = pair[1].match(/node\sv(\d+)\.(\d+)\.(\d+)/);
								if (match && match.length === 4) {
									this.embeddedHostVersion = (parseInt(match[1])*100 + parseInt(match[2]))*100 + parseInt(match[3]);
								} else if (pair[1] === 'Electron') {
									this.embeddedHostVersion = 51000; // TODO this needs to be detected in a smarter way by looking at the V8 version in Electron
								}
								break;
							case 'Content-Length':
								this._contentLength = +pair[1];
								break;
						}
					}
					this._rawData = this._rawData.slice(idx + NodeV8Protocol.TWO_CRLF.length);
					continue;	// try to handle a complete message
				}
			}
			break;
		}
	}
}
