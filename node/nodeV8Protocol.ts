/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as EE from 'events';

export class NodeV8Message {
	seq: number;
	type: string;

	public constructor(type: string) {
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

	private static TIMEOUT = 3000;

	private _state: string;
	private _contentLength: number;
	private _bodyStartByteIndex: number;
	private _res: any;
	private _sequence: number;
	private _writableStream: NodeJS.WritableStream;
	private _pendingRequests = new Map<number, NodeV8Response>();
	private _unresponsiveMode: boolean;

	public embeddedHostVersion: number = -1;


	public startDispatch(inStream: NodeJS.ReadableStream, outStream: NodeJS.WritableStream): void {
		this._sequence = 1;
		this._writableStream = outStream;
		this._newRes(null);

		inStream.setEncoding('utf8');

		inStream.on('data', (data) => this.execute(data));
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

	public stop(): void {
		if (this._writableStream) {
			this._writableStream.end();
		}
	}

	public command(command: string, args?: any, cb?: (response: NodeV8Response) => void): void {

		const timeout = NodeV8Protocol.TIMEOUT;

		const request: any = {
			command: command
		};
		if (args && Object.keys(args).length > 0) {
			request.arguments = args;
		}

		if (this._unresponsiveMode) {
			if (cb) {
				cb(new NodeV8Response(request, 'cancelled because node is unresponsive'));
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
					clb(new NodeV8Response(request, 'timeout after ' + timeout + 'ms'));

					this._unresponsiveMode = true;
					this.emitEvent(new NodeV8Event('diagnostic', { reason: 'unresponsive ' + command }));
				}
			}, timeout);
		}
	}

	public command2(command: string, args: any, timeout: number = NodeV8Protocol.TIMEOUT): Promise<NodeV8Response> {
		return new Promise((completeDispatch, errorDispatch) => {
			this.command(command, args, (result: NodeV8Response) => {
				if (result.success) {
					completeDispatch(result);
				} else {
					errorDispatch(result);
				}
			});
		});
	}

	public sendEvent(event: NodeV8Event): void {
		this.send('event', event);
	}

	public sendResponse(response: NodeV8Response): void {
		if (response.seq > 0) {
			console.error('attempt to send more than one response for command {0}', response.command);
		} else {
			this.send('response', response);
		}
	}

	// ---- private ------------------------------------------------------------

	private emitEvent(event: NodeV8Event) {
		this.emit(event.event, event);
	}

	private send(typ: string, message: NodeV8Message): void {
		message.type = typ;
		message.seq = this._sequence++;
		const json = JSON.stringify(message);
		const data = 'Content-Length: ' + Buffer.byteLength(json, 'utf8') + '\r\n\r\n' + json;
		if (this._writableStream) {
			this._writableStream.write(data);
		}
	}

	private _newRes(raw: string): void {
		this._res = {
			raw: raw || '',
			headers: {}
		};
		this._state = 'headers';
		this.execute('');
	}

	private internalDispatch(message: NodeV8Message): void {
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

	private execute(d): void {
		const res = this._res;
		res.raw += d;

		switch (this._state) {
			case 'headers':
				const endHeaderIndex = res.raw.indexOf('\r\n\r\n');
				if (endHeaderIndex < 0)
					break;

				const rawHeader = res.raw.slice(0, endHeaderIndex);
				const endHeaderByteIndex = Buffer.byteLength(rawHeader, 'utf8');
				const lines = rawHeader.split('\r\n');
				for (let i = 0; i < lines.length; i++) {
					const kv = lines[i].split(/: +/);
					res.headers[kv[0]] = kv[1];
					if (kv[0] === 'Embedding-Host') {
						const match = kv[1].match(/node\sv(\d+)\.\d+\.\d+/)
						if (match && match.length === 2) {
							this.embeddedHostVersion = parseInt(match[1]);
						} else if (kv[1] === 'Electron') {
							this.embeddedHostVersion = 4;
						}
					}
				}

				this._contentLength = +res.headers['Content-Length'];
				this._bodyStartByteIndex = endHeaderByteIndex + 4;

				this._state = 'body';

				const len = Buffer.byteLength(res.raw, 'utf8');
				if (len - this._bodyStartByteIndex < this._contentLength) {
					break;
				}
			// pass thru

			case 'body':
				const resRawByteLength = Buffer.byteLength(res.raw, 'utf8');
				if (resRawByteLength - this._bodyStartByteIndex >= this._contentLength) {
					const buf = new Buffer(resRawByteLength);
					buf.write(res.raw, 0, resRawByteLength, 'utf8');
					res.body = buf.slice(this._bodyStartByteIndex, this._bodyStartByteIndex + this._contentLength).toString('utf8');
					res.body = res.body.length ? JSON.parse(res.body) : {};
					this.internalDispatch(res.body);
					this._newRes(buf.slice(this._bodyStartByteIndex + this._contentLength).toString('utf8'));
				}
				break;

			default:
				throw new Error('Unknown state');
				break;
		}
	}
}
