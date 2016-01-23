/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

"use strict";

import cp = require('child_process');
import assert = require('assert');
import net = require('net');
import {DebugProtocol} from 'vscode-debugprotocol';
import {ProtocolClient} from './ProtocolClient';


export class DebugClient extends ProtocolClient {

	private _runtime: string;
	private _executable: string;
	private _adapterProcess: cp.ChildProcess;
	private _enableStderr: boolean;
	private _debugType: string;
	private _socket: net.Socket;


	constructor(runtime: string, executable: string, debugType: string) {
		super();
		this._runtime = runtime;
		this._executable = executable;
		this._enableStderr = false;
		this._debugType = debugType;
	}

	// ---- life cycle --------------------------------------------------------------------------------------------------------

	public start(done, port?: number) {

		if (typeof port === "number") {
			this._socket = net.createConnection(port, '127.0.0.1', () => {
				this.connect(this._socket, this._socket);
				done();
			});
		} else {
			this._adapterProcess = cp.spawn(this._runtime, [ this._executable ], {
					stdio: [
						'pipe', 	// stdin
						'pipe', 	// stdout
						'pipe'	// stderr
					],
				}
			);
			const sanitize = (s: string) => s.toString().replace(/\r?\n$/mg, '');
			// this.serverProcess.stdout.on('data', (data: string) => {
			// 	console.log('%c' + sanitize(data), 'background: #ddd; font-style: italic;');
			// });
			this._adapterProcess.stderr.on('data', (data: string) => {
				if (this._enableStderr) {
					console.log(sanitize(data));
				}
			});

			this._adapterProcess.on('error', (err: Error) => {
				console.log('error');
			});
			this._adapterProcess.on('exit', (code: number, signal: string) => {
				// console.log('exit');
			});

			this.connect(this._adapterProcess.stdout, this._adapterProcess.stdin);
			done();
		}
	}

	public stop() {
		if (this._adapterProcess) {
			this._adapterProcess.kill();
			this._adapterProcess = null;
		}
		if (this._socket) {
			this._socket.end();
			this._socket = null;
		}
	}

	// ---- protocol requests -------------------------------------------------------------------------------------------------

	public initializeRequest(args?: DebugProtocol.InitializeRequestArguments): Promise<DebugProtocol.InitializeResponse> {
		if (!args) {
			args = {
				adapterID: this._debugType,
				linesStartAt1: true,
				columnsStartAt1: true,
				pathFormat: 'path'
			}
		}
		return this.send('initialize', args);
	}

	public configurationDoneRequest(args?: DebugProtocol.ConfigurationDoneArguments): Promise<DebugProtocol.ConfigurationDoneResponse> {
		return this.send('configurationDone', args);
	}

	public launchRequest(args: DebugProtocol.LaunchRequestArguments): Promise<DebugProtocol.LaunchResponse> {
		return this.send('launch', args);
	}

	public attachRequest(args: DebugProtocol.AttachRequestArguments): Promise<DebugProtocol.AttachResponse> {
		return this.send('attach', args);
	}

	public disconnectRequest(args: DebugProtocol.DisconnectArguments): Promise<DebugProtocol.DisconnectResponse> {
		return this.send('disconnect', args);
	}

	public setBreakpointsRequest(args: DebugProtocol.SetBreakpointsArguments): Promise<DebugProtocol.SetBreakpointsResponse> {
		return this.send('setBreakpoints', args);
	}

	public setExceptionBreakpointsRequest(args: DebugProtocol.SetExceptionBreakpointsArguments): Promise<DebugProtocol.SetExceptionBreakpointsResponse> {
		return this.send('setExceptionBreakpoints', args);
	}

	public continueRequest(args: DebugProtocol.ContinueArguments): Promise<DebugProtocol.ContinueResponse> {
		return this.send('continue', args);
	}

	public nextRequest(args: DebugProtocol.NextArguments): Promise<DebugProtocol.NextResponse> {
		return this.send('next', args);
	}

	public stepInRequest(args: DebugProtocol.StepInArguments): Promise<DebugProtocol.StepInResponse> {
		return this.send('stepIn', args);
	}

	public stepOutRequest(args: DebugProtocol.StepOutArguments): Promise<DebugProtocol.StepOutResponse> {
		return this.send('stepOut', args);
	}

	public pauseRequest(args: DebugProtocol.PauseArguments): Promise<DebugProtocol.PauseResponse> {
		return this.send('pause', args);
	}

	public stacktraceRequest(args: DebugProtocol.StackTraceArguments): Promise<DebugProtocol.StackTraceResponse> {
		return this.send('stackTrace', args);
	}

	public scopesRequest(args: DebugProtocol.ScopesArguments): Promise<DebugProtocol.ScopesResponse> {
		return this.send('scopes', args);
	}

	public variablesRequest(args: DebugProtocol.VariablesArguments): Promise<DebugProtocol.VariablesResponse> {
		return this.send('variables', args);
	}

	public sourceRequest(args: DebugProtocol.SourceArguments): Promise<DebugProtocol.SourceResponse> {
		return this.send('source', args);
	}

	public threadsRequest(): Promise<DebugProtocol.ThreadsResponse> {
		return this.send('threads');
	}

	public evaluateRequest(args: DebugProtocol.EvaluateArguments): Promise<DebugProtocol.EvaluateResponse> {
		return this.send('evaluate', args);
	}

	// ---- convenience methods -----------------------------------------------------------------------------------------------

	/*
	 * Returns a promise that will resolve if an event with a specific type was received within the given timeout.
	 * The promise will be rejected if a timeout occurs.
	 */
	public waitForEvent(eventType: string, timeout: number = 1000): Promise<DebugProtocol.Event> {

		return new Promise((resolve, reject) => {
			this.on(eventType, event => {
				resolve(event);
			});
			if (!this._socket) {	// no timeouts if debugging the tests
				setTimeout(() => {
					reject(new Error(`no event '${eventType}' received after ${timeout} ms`));
				}, timeout);
			}
		})
	}

	/*
	 * Returns a promise that will resolve if an 'initialized' event was received within 1000ms
	 * and a subsequent 'configurationDone' request was successfully executed.
	 * The promise will be rejected if a timeout occurs or if the 'configurationDone' request fails.
	 */
	public configurationSequence(): Promise<any> {

		return this.waitForEvent('initialized').then(event => {
			return this.configurationDoneRequest();
		});
	}

	public launch(args: DebugProtocol.LaunchRequestArguments): Promise<DebugProtocol.LaunchResponse> {

		return this.initializeRequest().then(response => {
			return this.launchRequest(args);
		});
	}

	/*
	 * Returns a promise that will resolve if a 'stopped' event was received within 1000ms
	 * and the event's reason and line number was asserted.
	 * The promise will be rejected if a timeout occurs, the assertions fail, or if the 'stackTrace' request fails.
	 */
	public assertStoppedLocation(reason: string, line: number) : Promise<DebugProtocol.StackTraceResponse> {

		return this.waitForEvent('stopped').then(event => {
			assert.equal(event.body.reason, reason);
			return this.stacktraceRequest({
				threadId: event.body.threadId
			});
		}).then(response => {
			assert.equal(response.body.stackFrames[0].line, line);
			return response;
		});
	}

	// ---- scenarios ---------------------------------------------------------------------------------------------------------

	/**
	 * Returns a promise that will resolve if a configurable breakpoint has been hit within 1000ms
	 * and the event's reason and line number was asserted.
	 * The promise will be rejected if a timeout occurs, the assertions fail, or if the requests fails.
	 */
	public hitBreakpoint(launchArgs: any, program: string, line: number) : Promise<any> {

		return Promise.all([

			this.waitForEvent('initialized').then(event => {
				return this.setBreakpointsRequest({
					lines: [ line ],
					breakpoints: [ { line: line } ],
					source: { path: program }
				});
			}).then(response => {
				const bp = response.body.breakpoints[0];
				assert.equal(bp.verified, true);
				assert.equal(bp.line, line);
				return this.configurationDoneRequest();
			}),

			this.launch(launchArgs),

			this.assertStoppedLocation('breakpoint', line)

		]);
	}
}
