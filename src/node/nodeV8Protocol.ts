/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as EE from 'events';
import * as nls from 'vscode-nls';

const localize = nls.loadMessageBundle();

type NodeV8MessageType = 'request' | 'response' | 'event';

export class NodeV8Message {
	seq: number;
	type: NodeV8MessageType;

	public constructor(type: NodeV8MessageType) {
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
	refs: V8Object[];

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
	body: V8EventBody;

	public constructor(event: string, body?: any) {
		super('event');
		this.event = event;
		if (body) {
			this.body = body;
		}
	}
}

// response types

export interface V8Handle {
	handle: number;
	type: 'undefined' | 'null' | 'boolean' | 'number' | 'string' | 'object' | 'function' | 'frame'
		| 'set' | 'map' | 'regexp' | 'promise' | 'generator' | 'error';
}

export interface V8Simple extends V8Handle {
	value?: boolean | number | string;
}

export interface V8Object extends V8Simple {

	vscode_indexedCnt?: number;
	vscode_namedCnt?: number;

	className?: string;
	constructorFunction?: V8Ref;
	protoObject?: V8Ref;
	prototypeObject?: V8Ref;
	properties?: V8Property[];


	text?: string;

	status?: string;
}

export interface V8Function extends V8Object {
	name?: string;
	inferredName?: string;
}

export interface V8Script extends V8Handle {
	name: string;
	id: number;
	source: string;
}

export interface V8Ref {
	ref: number;

	// if resolved, then a value exists
	value?: boolean | number | string;
	handle?: number;
}

export interface V8Property extends V8Ref {
	name: number | string;
}

export interface V8Frame {
	index: number;

	line: number;
	column: number;

	script: V8Ref;
	func: V8Ref;
	receiver: V8Ref;
}

export interface V8Scope {
	type: number;
	frameIndex : number;
	index: number;
	object: V8Ref;
}

type BreakpointType = 'function' | 'script' | 'scriptId' | 'scriptRegExp';

export interface V8Breakpoint {
	type: BreakpointType;
	script_id: number;
	number: number;
	script_regexp: string;
}

// responses

export interface V8ScopeResponse extends NodeV8Response {
	body: {
		vscode_locals?: number;
		scopes: V8Scope[];
	};
}

export interface V8EvaluateResponse extends NodeV8Response {
	body: V8Object;
}

export interface V8BacktraceResponse extends NodeV8Response {
	body: {
		fromFrame: number;
		toFrame: number;
		totalFrames: number;
		frames: V8Frame[];
	};
}

export interface V8ScriptsResponse extends NodeV8Response {
	body: V8Script[];
}

export interface V8SetVariableValueResponse extends NodeV8Response {
	body: {
		newValue: V8Handle;
	};
}

export interface V8FrameResponse extends NodeV8Response {
	body: V8Frame;
}

export interface V8ListBreakpointsResponse extends NodeV8Response {
	body: {
		breakpoints: V8Breakpoint[];
	};
}

export interface V8SetBreakpointResponse extends NodeV8Response {
	body: {
		type: string;
		breakpoint: number;
		script_id: number;
		actual_locations: {
			line: number;
			column: number;
		}[];
	};
}

type ExceptionType = 'all' | 'uncaught';

export interface V8SetExceptionBreakResponse extends NodeV8Response {
	body: {
		type: ExceptionType;
		enabled: boolean;
	};
}

export interface V8RestartFrameResponse extends NodeV8Response {
	body: {
		result: boolean;
	};
}

// events

export interface V8EventBody {
	script: V8Script;
	sourceLine: number;
	sourceColumn: number;
	sourceLineText: string;
}

export interface V8BreakEventBody extends V8EventBody {
	breakpoints: any[];
}

export interface V8ExceptionEventBody extends V8EventBody {
	exception: V8Object;
	uncaught: boolean;
}

// arguments

export interface V8BacktraceArgs {
	fromFrame: number;
	toFrame: number;
}

export interface V8RestartFrameArgs {
	frame: number | undefined;
}

export interface V8EvaluateArgs {
	expression: string;
	disable_break?: boolean;
	maxStringLength?: number;
	global?: boolean;
	frame?: number;
	additional_context?: {
		name: string;
		handle: number;
	}[];
}

export interface V8ScriptsArgs {
	types: number;
	includeSource?: boolean;
	ids?: number[];
	filter?: string;
}

export interface V8SetVariableValueArgs {
	scope: {
		frameNumber: number;
		number: number;
	};
	name: string;
	newValue: {
		type?: string;
		value?: boolean | number | string;
		handle?: number;
	};
}

export interface V8FrameArgs {
}

export interface V8ClearBreakpointArgs {
	breakpoint: number;
}

export interface V8SetBreakpointArgs {
	type: BreakpointType;
	target: number | string;
	line?: number;
	column?: number;
	condition?: string;
}

export interface V8SetExceptionBreakArgs {
	type: ExceptionType;
	enabled?: boolean;
}

//---- the protocol implementation

export class NodeV8Protocol extends EE.EventEmitter {

	private static TIMEOUT = 10000;
	private static TWO_CRLF = '\r\n\r\n';

	private _rawData: Buffer;
	private _contentLength: number;
	private _sequence: number;
	private _writableStream: NodeJS.WritableStream;
	private _pendingRequests = new Map<number, (response: NodeV8Response) => void>();
	private _unresponsiveMode: boolean;
	private _responseHook: ((response: NodeV8Response) => void) | undefined;

	public hostVersion: string | undefined;
	public embeddedHostVersion: number = -1;
	public v8Version: string | undefined;

	public constructor(responseHook?: (response: NodeV8Response) => void) {
		super();
		this._responseHook = responseHook;
	}

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
		return new Promise((resolve, reject) => {
			this._command(command, args, timeout, response => {
				if (response.success) {
					resolve(response);
				} else {
					if (!response.command) {
						// some responses don't have the 'command' attribute.
						response.command = command;
					}
					reject(response);
				}
			});
		});
	}

	public backtrace(args: V8BacktraceArgs, timeout: number = NodeV8Protocol.TIMEOUT) : Promise<V8BacktraceResponse> {
		return this.command2('backtrace', args);
	}

	public restartFrame(args: V8RestartFrameArgs, timeout: number = NodeV8Protocol.TIMEOUT) : Promise<V8RestartFrameResponse> {
		return this.command2('restartframe', args);
	}

	public evaluate(args: V8EvaluateArgs, timeout: number = NodeV8Protocol.TIMEOUT) : Promise<V8EvaluateResponse> {
		return this.command2('evaluate', args);
	}

	public scripts(args: V8ScriptsArgs, timeout: number = NodeV8Protocol.TIMEOUT) : Promise<V8ScriptsResponse> {
		return this.command2('scripts', args);
	}

	public setVariableValue(args: V8SetVariableValueArgs, timeout: number = NodeV8Protocol.TIMEOUT) : Promise<V8SetVariableValueResponse> {
		return this.command2('setvariablevalue', args);
	}

	public frame(args: V8FrameArgs, timeout: number = NodeV8Protocol.TIMEOUT) : Promise<V8FrameResponse> {
		return this.command2('frame', args);
	}

	public setBreakpoint(args: V8SetBreakpointArgs, timeout: number = NodeV8Protocol.TIMEOUT) : Promise<V8SetBreakpointResponse> {
		return this.command2('setbreakpoint', args);
	}

	public setExceptionBreak(args: V8SetExceptionBreakArgs, timeout: number = NodeV8Protocol.TIMEOUT) : Promise<V8SetExceptionBreakResponse> {
		return this.command2('setexceptionbreak', args);
	}

	public clearBreakpoint(args: V8ClearBreakpointArgs, timeout: number = NodeV8Protocol.TIMEOUT) : Promise<NodeV8Response> {
		return this.command2('clearbreakpoint', args);
	}

	public listBreakpoints(timeout: number = NodeV8Protocol.TIMEOUT) : Promise<V8ListBreakpointsResponse> {
		return this.command2('listbreakpoints');
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


	private _command(command: string, args: any, timeout: number, cb?: (response: NodeV8Response) => void) : void {

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
			this._pendingRequests.set(request.seq, cb);

			const timer = setTimeout(() => {
				clearTimeout(timer);
				const clb = this._pendingRequests.get(request.seq);
				if (clb) {
					this._pendingRequests.delete(request.seq);
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

	private send(typ: NodeV8MessageType, message: NodeV8Message) : void {
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
			const clb = this._pendingRequests.get(response.request_seq);
			if (clb) {
				this._pendingRequests.delete(response.request_seq);
				if (this._responseHook) {
					this._responseHook(response);
				}
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
									this.embeddedHostVersion = 60500; // TODO this needs to be detected in a smarter way by looking at the V8 version in Electron
								}
								const match1 = pair[1].match(/node\s(v\d+\.\d+\.\d+)/);
								if (match1 && match1.length === 2) {
									this.hostVersion = match1[1];
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
