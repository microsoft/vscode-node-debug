/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import {DebugSession, Thread, Source, StackFrame, Scope, Variable, Breakpoint, TerminatedEvent, InitializedEvent, StoppedEvent, OutputEvent, Handles, ErrorDestination} from 'vscode-debugadapter';
import {DebugProtocol} from 'vscode-debugprotocol';

import {NodeV8Protocol, NodeV8Event, NodeV8Response} from './nodeV8Protocol';
import {ISourceMaps, SourceMaps} from './sourceMaps';
import {Terminal} from './terminal';
import * as PathUtils from './pathUtilities';
import * as CP from 'child_process';
import * as Net from 'net';
import * as Path from 'path';
import * as FS from 'fs';


const RANGESIZE = 1000;

export interface Expandable {
	Expand(session: NodeDebugSession, results: Array<Variable>, done: () => void): void;
}

export class PropertyExpander implements Expandable {

	private _object: any;
	private _this: any;
	protected _mode: string;
	protected _start: number;
	protected _end: number;

	public constructor(obj: any, ths?: any) {
		this._object = obj;
		this._this = ths;
		this._mode = 'all';
		this._start = 0;
		this._end = -1;
	}

	public Expand(session: NodeDebugSession, variables: Array<Variable>, done: () => void): void {
		session._addProperties(variables, this._object, this._mode, this._start, this._end, () => {
			if (this._this) {
				session._addVariable(variables, 'this', this._this, done);
			} else {
				done();
			}
		});
	}
}

export class PropertyRangeExpander extends PropertyExpander {
	public constructor(obj: any, start: number, end: number) {
		super(obj, null);
		this._mode = 'range';
		this._start = start;
		this._end = end;
	}
}

export class ArrayExpander implements Expandable {

	private _object: any;
	private _size: number;

	public constructor(obj: any, size: number) {
		this._object = obj;
		this._size = size;
	}

	public Expand(session: NodeDebugSession, variables: Array<Variable>, done: () => void): void {
		// first add named properties
		session._addProperties(variables, this._object, 'named', 0, -1, () => {
			// then add indexed properties as ranges
			for (let start = 0; start < this._size; start += RANGESIZE) {
				let end = Math.min(start + RANGESIZE, this._size)-1;
				variables.push(new Variable(`[${start}..${end}]`, ' ', session._variableHandles.create(new PropertyRangeExpander(this._object, start, end))));
			}
			done();
		});
	}
}

/**
 * A SourceSource represents the source contents of an internal module or of a source map with inlined contents.
 */
class SourceSource {
	scriptId: number;	// if 0 then source contains the file contents of a source map, otherwise a scriptID.
	source: string;

	constructor(sid: number, content?: string) {
		this.scriptId = sid;
		this.source = content;
	}
}

/**
 * Arguments shared between Launch and Attach requests.
 */
export interface CommonArguments {
	/** comma separated list of trace selectors. Supported:
	 * 'all': all
	 * 'la': launch/attach
	 * 'bp': breakpoints
	 * 'sm': source maps
	 * */
	trace?: string;
	/** Automatically stop target after launch. If not specified, target does not stop. */
	stopOnEntry?: boolean;
	/** Configure source maps. By default source maps are disabled. */
	sourceMaps?: boolean;
	/** Where to look for the generated code. Only used if sourceMaps is true. */
	outDir?: string;
}

/**
 * This interface should always match the schema found in the node-debug extension manifest.
 */
export interface LaunchRequestArguments extends CommonArguments {
	/** An absolute path to the program to debug. */
	program: string;
	/** Optional arguments passed to the debuggee. */
	args?: string[];
	/** Launch the debuggee in this working directory (specified as an absolute path). If omitted the debuggee is lauched in its own directory. */
	cwd?: string;
	/** Absolute path to the runtime executable to be used. Default is the runtime executable on the PATH. */
	runtimeExecutable?: string;
	/** Optional arguments passed to the runtime executable. */
	runtimeArgs?: string[];
	/** Optional environment variables to pass to the debuggee. The string valued properties of the 'environmentVariables' are used as key/value pairs. */
	env?: { [key: string]: string; };
	/** If true launch the target in an external console. */
	externalConsole?: boolean;
}

/**
 * This interface should always match the schema found in the node-debug extension manifest.
 */
export interface AttachRequestArguments extends CommonArguments {
	/** The debug port to attach to. */
	port: number;
	/** The TCP/IP address of the port (remote addresses only supported for node >= 5.0). */
	address?: string;
	/** Retry for this number of milliseconds to connect to the node runtime. */
	timeout?: number;

	/** Node's root directory. */
	remoteRoot?: string;
	/** VS Code's root directory. */
	localRoot?: string;
}


export class NodeDebugSession extends DebugSession {

	private static NODE = 'node';
	private static DUMMY_THREAD_ID = 1;
	private static DUMMY_THREAD_NAME = 'Node';
	private static FIRST_LINE_OFFSET = 62;
	private static PROTO = '__proto__';
	private static DEBUG_EXTENSION = 'debugExtension.js';
	private static NODE_TERMINATION_POLL_INTERVAL = 3000;
	private static ATTACH_TIMEOUT = 10000;

	private static NODE_SHEBANG_MATCHER = new RegExp('#! */usr/bin/env +node');

	// stop reasons
	private static ENTRY_REASON = "entry";
	private static STEP_REASON = "step";
	private static BREAKPOINT_REASON = "breakpoint";
	private static EXCEPTION_REASON = "exception";
	private static DEBUGGER_REASON = "debugger statement";
	private static USER_REQUEST_REASON = "user request";

	private static ANON_FUNCTION = "(anonymous function)";

	private static SCOPE_NAMES = [ "Global", "Local", "With", "Closure", "Catch", "Block", "Script" ];

	private static LARGE_DATASTRUCTURE_TIMEOUT = "<...>"; // "<large data structure timeout>";

	private _trace: string[];
	private _traceAll = false;

	private _adapterID: string;
	public _variableHandles = new Handles<Expandable>();
	private _frameHandles = new Handles<any>();
	private _sourceHandles = new Handles<SourceSource>();
	private _refCache = new Map<number, any>();
	private _functionBreakpoints = new Array<number>();	// node function breakpoint ids

	private _localRoot: string;
	private _remoteRoot: string;
	private _externalConsole: boolean;
	private _isTerminated: boolean;
	private _inShutdown: boolean;
	private _terminalProcess: CP.ChildProcess;		// the terminal process or undefined
	private _pollForNodeProcess = false;
	private _nodeProcessId: number = -1; 		// pid of the node runtime
	private _node: NodeV8Protocol;
	private _exception;
	private _lastStoppedEvent;
	private _nodeExtensionsAvailable: boolean = false;
	private _tryToExtendNode: boolean = true;
	private _attachMode: boolean = false;
	private _sourceMaps: ISourceMaps;
	private _stopOnEntry: boolean;
	private _needContinue: boolean;
	private _needBreakpointEvent: boolean;

	private _gotEntryEvent: boolean;
	private _entryPath: string;
	private _entryLine: number;		// entry line in *.js file (not in the source file)
	private _entryColumn: number;	// entry column in *.js file (not in the source file)

	public constructor(debuggerLinesStartAt1: boolean, isServer: boolean = false) {
		super(debuggerLinesStartAt1, isServer);

		this._node = new NodeV8Protocol();

		this._node.on('break', (event: NodeV8Event) => {
			this._stopped('break');
			this._lastStoppedEvent = this._createStoppedEvent(event.body);
			if (this._lastStoppedEvent.body.reason === NodeDebugSession.ENTRY_REASON) {
				this.log('la', 'NodeDebugSession: supressed stop-on-entry event');
			} else {
				this.sendEvent(this._lastStoppedEvent);
			}
		});

		this._node.on('exception', (event: NodeV8Event) => {
			this._stopped('exception');
			this._lastStoppedEvent = this._createStoppedEvent(event.body);
			this.sendEvent(this._lastStoppedEvent);
		});

		this._node.on('close', (event: NodeV8Event) => {
			this._terminated('node v8protocol close');
		});

		this._node.on('error', (event: NodeV8Event) => {
			this._terminated('node v8protocol error');
		});

		this._node.on('diagnostic', (event: NodeV8Event) => {
			// console.error('diagnostic event: ' + event.body.reason);
		});
	}

	public log(category: string, message: string) {
		if (this._trace && (this._traceAll || this._trace.indexOf(category) >= 0)) {
			const s = process.pid + ": " + message + '\r\n';
			this.sendEvent(new OutputEvent(s));
		}
	}

	/**
	 * clear everything that is no longer valid after a new stopped event.
	 */
	private _stopped(reason: string): void {
		this.log('la', `_stopped: got ${reason} event from node`);
		this._exception = undefined;
		this._variableHandles.reset();
		this._frameHandles.reset();
		this._refCache = new Map<number, any>();
	}

	/**
	 * The debug session has terminated.
	 */
	private _terminated(reason: string): void {
		this.log('la', `_terminated: ${reason}`);

		if (this._terminalProcess) {
			// if the debug adapter owns a terminal,
			// we delay the TerminatedEvent so that the user can see the result of the process in the terminal.
			return;
		}

		if (!this._isTerminated) {
			this._isTerminated = true;
			this.sendEvent(new TerminatedEvent());
		}
	}

	//---- initialize request -------------------------------------------------------------------------------------------------

	protected initializeRequest(response: DebugProtocol.InitializeResponse, args: DebugProtocol.InitializeRequestArguments): void {

		this.log('la', `initializeRequest: adapterID: ${args.adapterID}`);

		this._adapterID = args.adapterID;

		//---- Send back feature and their options

		// This debug adapter supports the configurationDoneRequest.
		response.body.supportsConfigurationDoneRequest = true;

		// This debug adapter does not (yet) support a side effect free evaluate request for data hovers.
		response.body.supportsEvaluateForHovers = true;

		// This debug adapter supports function breakpoints.
		response.body.supportsFunctionBreakpoints = true;

		this.sendResponse(response);
	}

	//---- launch request -----------------------------------------------------------------------------------------------------

	protected launchRequest(response: DebugProtocol.LaunchResponse, args: LaunchRequestArguments): void {

		if (this._processCommonArgs(response, args)) {
			return;
		}

		this._externalConsole = (typeof args.externalConsole === 'boolean') && args.externalConsole;

		var port = random(3000, 50000);

		let runtimeExecutable = this.convertClientPathToDebugger(args.runtimeExecutable);
		if (runtimeExecutable) {
			if (!FS.existsSync(runtimeExecutable)) {
				this.sendErrorResponse(response, 2006, "runtime executable '{path}' does not exist", { path: runtimeExecutable });
				return;
			}
		} else {
			if (!Terminal.isOnPath(NodeDebugSession.NODE)) {
				this.sendErrorResponse(response, 2001, "cannot find runtime '{_runtime}' on PATH", { _runtime: NodeDebugSession.NODE });
				return;
			}
			runtimeExecutable = NodeDebugSession.NODE;     // use node from PATH
		}

		const runtimeArgs = args.runtimeArgs || [];
		const programArgs = args.args || [];

		// special code for 'extensionHost' debugging
		if (this._adapterID === 'extensionHost') {

			// we always launch in 'debug-brk' mode, but we only show the break event if 'stopOnEntry' attribute is true.
			const launchArgs = [ runtimeExecutable, `--debugBrkPluginHost=${port}` ].concat(runtimeArgs, programArgs);

			this._sendLaunchCommandToConsole(launchArgs);

			const cmd = CP.spawn(runtimeExecutable, launchArgs.slice(1));
			cmd.on('error', (err) => {
				this._terminated(`failed to launch extensionHost (${err})`);
			});
			this._captureOutput(cmd);

			// we are done!
			this.sendResponse(response);
			return;
		}

		let programPath = args.program;
		if (programPath) {
			programPath = this.convertClientPathToDebugger(programPath);
			programPath = Path.normalize(programPath);
			if (!FS.existsSync(programPath)) {
				this.sendErrorResponse(response, 2007, "program '{path}' does not exist", { path: programPath });
				return;
			}
			if (programPath != PathUtils.realPath(programPath)) {
				this.sendErrorResponse(response, 2021, "program path uses differently cased character than file on disk; this might result in breakpoints not being hit");
				return;
			}
		} else {
			this.sendErrorResponse(response, 2005, "property 'program' is missing or empty");
			return;
		}

		if (NodeDebugSession.isJavaScript(programPath)) {
			if (this._sourceMaps) {
				// if programPath is a JavaScript file and sourceMaps are enabled, we don't know whether
				// programPath is the generated file or whether it is the source (and we need source mapping).
				// Typically this happens if a tool like 'babel' or 'uglify' is used (because they both transpile js to js).
				// We use the source maps to find a 'source' file for the given js file.
				const generatedPath = this._sourceMaps.MapPathFromSource(programPath);
				if (generatedPath && generatedPath !== programPath) {
					// programPath must be source because there seems to be a generated file for it
					this.log('sm', `launchRequest: program '${programPath}' seems to be the source; launch the generated file '${generatedPath}' instead`);
					programPath = generatedPath;
				} else {
					this.log('sm', `launchRequest: program '${programPath}' seems to be the generated file`);
				}
			}
		} else {
			// node cannot execute the program directly
			if (!this._sourceMaps) {
				this.sendErrorResponse(response, 2002, "cannot launch program '{path}'; enabling source maps might help", { path: programPath });
				return;
			}
			const generatedPath = this._sourceMaps.MapPathFromSource(programPath);
			if (!generatedPath) {	// cannot find generated file
				this.sendErrorResponse(response, 2003, "cannot launch program '{path}'; setting the 'outDir' attribute might help", { path: programPath });
				return;
			}
			this.log('sm', `launchRequest: program '${programPath}' seems to be the source; launch the generated file '${generatedPath}' instead`);
			programPath = generatedPath;
		}

		let program: string;
		let workingDirectory = this.convertClientPathToDebugger(args.cwd);
		if (workingDirectory) {
			if (!FS.existsSync(workingDirectory)) {
				this.sendErrorResponse(response, 2004, "working directory '{path}' does not exist", { path: workingDirectory });
				return;
			}
			// if working dir is given and if the executable is within that folder, we make the executable path relative to the working dir
			program = Path.relative(workingDirectory, programPath);
		}
		else {	// should not happen
			// if no working dir given, we use the direct folder of the executable
			workingDirectory = Path.dirname(programPath);
			program = Path.basename(programPath);
		}

		// we always break on entry (but if user did not request this, we will not stop in the UI).
		const launchArgs = [ runtimeExecutable, `--debug-brk=${port}` ].concat(runtimeArgs, [ program ], programArgs);

		if (this._externalConsole) {

			Terminal.launchInTerminal(workingDirectory, launchArgs, args.env).then(term => {

				if (term) {
					// if we got a terminal process, we will track it
					this._terminalProcess = term;
					term.on('exit', () => {
						this._terminalProcess = null;
						this._terminated('terminal exited');
					});
				}

				// since node starts in a terminal, we cannot track it with an 'exit' handler
				// plan for polling after we have gotten the process pid.
				this._pollForNodeProcess = true;

				this._attach(response, port);

			}).catch(error => {
				this.sendErrorResponse(response, 2011, "cannot launch target in terminal (reason: {_error})", { _error: error.message }, ErrorDestination.Telemetry | ErrorDestination.User );
				this._terminated('terminal error: ' + error.message);
			});

		} else {

			this._sendLaunchCommandToConsole(launchArgs);

			// merge environment variables into a copy of the process.env
			const env = extendObject(extendObject( { }, process.env), args.env);

			const options = {
				cwd: workingDirectory,
				env: env
			};

			const cmd = CP.spawn(runtimeExecutable, launchArgs.slice(1), options);
			cmd.on('error', (error) => {
				this.sendErrorResponse(response, 2017, "cannot launch target (reason: {_error})", { _error: error.message }, ErrorDestination.Telemetry | ErrorDestination.User );
				this._terminated(`failed to launch target (${error})`);
			});
			cmd.on('exit', () => {
				this._terminated('target exited');
			});
			cmd.on('close', (code) => {
				this._terminated('target closed');
			});

			this._captureOutput(cmd);

			this._attach(response, port);
		}
	}

	private _sendLaunchCommandToConsole(args: string[]) {
		// print the command to launch the target to the debug console
		let cli = '';
		for (var a of args) {
			if (a.indexOf(' ') >= 0) {
				cli += '\'' + a + '\'';
			} else {
				cli += a;
			}
			cli += ' ';
		}
		this.sendEvent(new OutputEvent(cli));
	}

	private _captureOutput(process: CP.ChildProcess) {
		process.stdout.on('data', (data: string) => {
			this.sendEvent(new OutputEvent(data.toString(), 'stdout'));
		});
		process.stderr.on('data', (data: string) => {
			this.sendEvent(new OutputEvent(data.toString(), 'stderr'));
		});
	}

	private _processCommonArgs(response: DebugProtocol.Response, args: CommonArguments): boolean {

		if (typeof args.trace === 'string') {
			this._trace = args.trace.split(',');
			this._traceAll = this._trace.indexOf('all') >= 0;
		}

		this._stopOnEntry = (typeof args.stopOnEntry === 'boolean') && args.stopOnEntry;

		if (!this._sourceMaps) {
			if (typeof args.sourceMaps === 'boolean' && args.sourceMaps) {
				const generatedCodeDirectory = args.outDir;

				if (!FS.existsSync(generatedCodeDirectory)) {
					this.sendErrorResponse(response, 2022, "attribute 'outDir' ('{path}') does not exist", { path: generatedCodeDirectory });
					return true;
				}

				this._sourceMaps = new SourceMaps(this, generatedCodeDirectory);
			}
		}

		return false;
	}

	//---- attach request -----------------------------------------------------------------------------------------------------

	protected attachRequest(response: DebugProtocol.AttachResponse, args: AttachRequestArguments): void {

		if (this._processCommonArgs(response, args)) {
			return;
		}

		if (this._adapterID === 'extensionHost') {
			// in EH mode 'attach' means 'launch' mode
			this._attachMode = false;
		} else {
			this._attachMode = true;
		}

		if (args.localRoot) {
			if (!FS.existsSync(args.localRoot)) {
				this.sendErrorResponse(response, 2023, "attribute 'localRoot' ('{path}') does not exist", { path: args.localRoot });
				return;
			}
			this._localRoot = args.localRoot;
		}
		this._remoteRoot = args.remoteRoot;

		this._attach(response, args.port, args.address, args.timeout);
	}

	/*
	 * shared code used in launchRequest and attachRequest
	 */
	private _attach(response: DebugProtocol.Response, port?: number, address?: string, timeout?: number): void {

		if (!port) {
			port = 5858;
		}

		if (!address || address === 'localhost') {
			address = '127.0.0.1';
		}

		if (!timeout) {
			timeout = NodeDebugSession.ATTACH_TIMEOUT;
		}

		this.log('la', `_attach: address: ${address} port: ${port}`);

		let connected = false;
		const socket = new Net.Socket();
		socket.connect(port, address);

		socket.on('connect', (err: any) => {
			this.log('la', '_attach: connected');
			connected = true;
			this._node.startDispatch(socket, socket);
			this._initialize(response);
		});

		const endTime = new Date().getTime() + timeout;
		socket.on('error', (err: any) => {
			if (connected) {
				// since we are connected this error is fatal
				this._terminated('socket error');
			} else {
				// we are not yet connected so retry a few times
				if (err.code === 'ECONNREFUSED' || err.code === 'ECONNRESET') {
					const now = new Date().getTime();
					if (now < endTime) {
						setTimeout(() => {
							this.log('la', '_attach: retry socket.connect');
							socket.connect(port);
						}, 200);		// retry after 200 ms
					} else {
						this.sendErrorResponse(response, 2009, "cannot connect to runtime process (timeout after {_timeout}ms)", { _timeout: timeout });
					}
				} else {
					this.sendErrorResponse(response, 2010, "cannot connect to runtime process (reason: {_error})", { _error: err.message });
				}
			}
		});

		socket.on('end', (err: any) => {
			this._terminated('socket end');
		});
	}

	private _initialize(response: DebugProtocol.Response, retryCount: number = 0) : void {

		this._node.command('evaluate', { expression: 'process.pid', global: true }, (resp: NodeV8Response) => {

			let ok = resp.success;
			if (resp.success) {
				this._nodeProcessId = parseInt(resp.body.value);
				this.log('la', `_initialize: got process id ${this._nodeProcessId} from node`);
			} else {
				if (resp.message.indexOf('process is not defined') >= 0) {
					this.log('la', '_initialize: process not defined error; got no pid');
					ok = true; // continue and try to get process.pid later
				}
			}

			if (ok) {

				if (this._pollForNodeProcess) {
					this._pollForNodeTermination();
				}

				const runtimeSupportsExtension = this._node.embeddedHostVersion === 0; // node version 0.x.x (io.js has version >= 1)
				if (this._tryToExtendNode && runtimeSupportsExtension) {
					this._extendDebugger((success: boolean) => {
						this.sendResponse(response);
						this._startInitialize(!resp.running);
						return;
					});
				} else {
					this.sendResponse(response);
					this._startInitialize(!resp.running);
					return;
				}
			} else {
				this.log('la', '_initialize: retrieving process id from node failed');

				if (retryCount < 10) {
					setTimeout(() => {
						// recurse
						this._initialize(response, retryCount+1);
					}, 50);
					return;
				} else {
					this._sendNodeResponse(response, resp);
				}
			}
		});
	}

	private _pollForNodeTermination() : void {
		const id = setInterval(() => {
			try {
				if (this._nodeProcessId > 0) {
					(<any>process).kill(this._nodeProcessId, 0);	// node.d.ts doesn't like number argumnent
				} else {
					clearInterval(id);
				}
			} catch(e) {
				clearInterval(id);
				this._terminated('node process kill exception');
			}
		}, NodeDebugSession.NODE_TERMINATION_POLL_INTERVAL);
	}

	/*
	 * Inject code into node.js to fix timeout issues with large data structures.
	 */
	private _extendDebugger(done: (success: boolean) => void) : void {
		try {
			const contents = FS.readFileSync(Path.join(__dirname, NodeDebugSession.DEBUG_EXTENSION), 'utf8');

			this._repeater(4, done, (callback: (again: boolean) => void) => {

				this._node.command('evaluate', { expression: contents }, (resp: NodeV8Response) => {
					if (resp.success) {
						this.log('la', '_extendDebugger: node code inject: OK');
						this._nodeExtensionsAvailable = true;
						callback(false);
					} else {
						this.log('la', '_extendDebugger: node code inject: failed, try again...');
						callback(true);
					}
				});

			});

		} catch(e) {
			done(false);
		}
	}

	/*
	 * start the initialization sequence:
	 * 1. wait for "break-on-entry" (with timeout)
	 * 2. send "inititialized" event in order to trigger setBreakpointEvents request from client
	 * 3. prepare for sending "break-on-entry" or "continue" later in _finishInitialize()
	 */
	private _startInitialize(stopped: boolean, n: number = 0): void {

		if (n == 0) {
			this.log('la', `_startInitialize: stopped: ${stopped}`);
		}

		// wait at most 500ms for receiving the break on entry event
		// (since in attach mode we cannot enforce that node is started with --debug-brk, we cannot assume that we receive this event)

		if (!this._gotEntryEvent && n < 10) {
			setTimeout(() => {
				// recurse
				this._startInitialize(stopped, n+1);
			}, 50);
			return;
		}

		if (this._gotEntryEvent) {
			this.log('la', `_startInitialize: got break on entry event after ${n} retries`);
			if (this._nodeProcessId <= 0) {
				// if we haven't gotten a process pid so far, we try it again
				this._node.command('evaluate', { expression: 'process.pid', global: true }, (resp: NodeV8Response) => {
					if (resp.success) {
						this._nodeProcessId = parseInt(resp.body.value);
						this.log('la', `_initialize: got process id ${this._nodeProcessId} from node (2nd try)`);
					}
					this._startInitialize2(stopped);
				});
			} else {
				this._startInitialize2(stopped);
			}
		} else {
			this.log('la', `_startInitialize: no entry event after ${n} retries; giving up`);

			this._gotEntryEvent = true;	// we pretend to got one so that no ENTRY_REASON event will show up later...

			this._node.command('frame', null, (resp: NodeV8Response) => {
				if (resp.success) {
					this._cacheRefs(resp);
					let s = this._getValueFromCache(resp.body.script);
					this._rememberEntryLocation(s.name, resp.body.line, resp.body.column);
				}

				this._startInitialize2(stopped);
			});
		}
	}

	private _startInitialize2(stopped: boolean): void {
		// request UI to send breakpoints
		this.log('la', '_startInitialize2: fire initialized event');
		this.sendEvent(new InitializedEvent());

		// in attach-mode we don't know whether the debuggee has been launched in 'stop on entry' mode
		// so we use the stopped state of the VM
		if (this._attachMode) {
			this.log('la', `_startInitialize2: in attach mode we guess stopOnEntry flag to be "${stopped}"`);
			this._stopOnEntry = stopped;
		}

		if (this._stopOnEntry) {
			// user has requested 'stop on entry' so send out a stop-on-entry
			this.log('la', '_startInitialize2: fire stop-on-entry event');
			this.sendEvent(new StoppedEvent(NodeDebugSession.ENTRY_REASON, NodeDebugSession.DUMMY_THREAD_ID));
		}
		else {
			// since we are stopped but UI doesn't know about this, remember that we continue later in finishInitialize()
			this.log('la', '_startInitialize2: remember to do a "Continue" later');
			this._needContinue = true;
		}
	}

	//---- disconnect request -------------------------------------------------------------------------------------------------

	protected disconnectRequest(response: DebugProtocol.DisconnectResponse, args: DebugProtocol.DisconnectArguments): void {

		// special code for 'extensionHost' debugging
		if (this._adapterID === 'extensionHost') {
			// detect whether this disconnect request is part of a restart session
			if (this._nodeProcessId > 0 && args && typeof (<any>args).restart === 'boolean' && (<any>args).restart) {
				// do not kill extensionHost (since vscode will do this for us in a nicer way without killing the window)
				this._nodeProcessId = 0;
			}
		}

		super.disconnectRequest(response, args);
	}

	/**
	 * we rely on the generic implementation from DebugSession but we override 'Protocol.shutdown'
	 * to disconnect from node and kill node & subprocesses
	 */
	public shutdown(): void {

		if (!this._inShutdown) {
			this._inShutdown = true;

			if (this._attachMode) {
				// disconnect only in attach mode since otherwise node continues to run until it is killed
				this._node.command('disconnect'); // we don't wait for reponse
			}

			this._node.stop();	// stop socket connection (otherwise node.js dies with ECONNRESET on Windows)

			if (!this._attachMode) {
				// kill the whole process tree either starting with the terminal or with the node process
				let pid = this._terminalProcess ? this._terminalProcess.pid : this._nodeProcessId;
				if (pid > 0) {
					this.log('la', 'shutdown: kill debugee and sub-processes');
					Terminal.killTree(pid).then(() => {
						this._terminalProcess = null;
						this._nodeProcessId = -1;
						super.shutdown();
					}).catch(error => {
						this._terminalProcess = null;
						this._nodeProcessId = -1;
						super.shutdown();
					});
					return;
				}
			}

			super.shutdown();
		}
	}

	//--- set breakpoints request ---------------------------------------------------------------------------------------------

	protected setBreakPointsRequest(response: DebugProtocol.SetBreakpointsResponse, args: DebugProtocol.SetBreakpointsArguments): void {

		this.log('bp', `setBreakPointsRequest: ${JSON.stringify(args.source)} ${JSON.stringify(args.breakpoints)}`);

		// prefer the new API: array of breakpoints
		let lbs = args.breakpoints;
		if (lbs) {
			for (let b of lbs) {
				b.line = this.convertClientLineToDebugger(b.line);
				b.column = typeof b.column === 'number' ? this.convertClientColumnToDebugger(b.column) : 0;
			}
		} else {
			lbs = new Array<DebugProtocol.SourceBreakpoint>();
			// deprecated API: convert line number array
			for (let l of args.lines) {
				lbs.push({
					line: this.convertClientLineToDebugger(l),
					column: 0
				});
			}
		}

		const source = args.source;

		if (source.adapterData) {

			if (source.adapterData.inlinePath) {
				// a breakpoint in inlined source: we need to source map
				this._mapSourceAndUpdateBreakpoints(response, source.adapterData.inlinePath, lbs);
				return;
			}

			if (source.adapterData.remotePath) {
				// a breakpoint in a remote file: don't try to source map
				this._updateBreakpoints(response, source.adapterData.remotePath, -1, lbs);
				return;
			}
		}

		if (source.sourceReference > 0) {
			const srcSource = this._sourceHandles.get(source.sourceReference);
			if (srcSource && srcSource.scriptId) {
				this._updateBreakpoints(response, null, srcSource.scriptId, lbs);
				return;
			}
		}

		if (source.path) {
			let path = this.convertClientPathToDebugger(source.path);
			this._mapSourceAndUpdateBreakpoints(response, path, lbs);
			return;
		}

		if (source.name) {
			// a core module
			this._findModule(source.name, (scriptId: number) => {
				if (scriptId >= 0) {
					this._updateBreakpoints(response, null, scriptId, lbs);
				} else {
					this.sendErrorResponse(response, 2019, "internal module {_module} not found", { _module: source.name });
				}
				return;
			});
			return;
		}

		this.sendErrorResponse(response, 2012, "no valid source specified", null, ErrorDestination.Telemetry);
	}

	private _mapSourceAndUpdateBreakpoints(response: DebugProtocol.SetBreakpointsResponse, path: string, lbs: DebugProtocol.SourceBreakpoint[]) {

		let sourcemap = false;

		let generated: string = null;
		if (this._sourceMaps) {
			generated = this._sourceMaps.MapPathFromSource(path);
			if (generated === path) {   // if generated and source are the same we don't need a sourcemap
				this.log('bp', `_mapSourceAndUpdateBreakpoints: source and generated are same -> ignore sourcemap`);
				generated = null;
			}
		}
		if (generated) {
			sourcemap = true;
			// source map line numbers
			for (let lb of lbs) {
				const mapresult = this._sourceMaps.MapFromSource(path, lb.line, lb.column);
				if (mapresult) {
					this.log('sm', `_mapSourceAndUpdateBreakpoints: src: '${path}' ${lb.line}:${lb.column} -> gen: '${mapresult.path}' ${mapresult.line}:${mapresult.column}`);
					if (mapresult.path !== generated) {
						// this source line maps to a different destination file -> this is not supported, ignore breakpoint by setting line to -1
						lb.line = -1;
					} else {
						lb.line = mapresult.line;
						lb.column = mapresult.column;
					}
				} else {
					this.log('sm', `_mapSourceAndUpdateBreakpoints: src: '${path}' ${lb.line}:${lb.column} -> gen: couldn't be mapped; breakpoint ignored`);
					lb.line = -1;
				}
			}
			path = generated;
		}
		else if (!NodeDebugSession.isJavaScript(path)) {
			// ignore all breakpoints for this source
			for (let lb of lbs) {
				lb.line = -1;
			}
		}

		// try to convert local path to remote path
		path = this._localToRemote(path);

		this._updateBreakpoints(response, path, -1, lbs, sourcemap);
	}

	/*
	 * clear and set all breakpoints of a given source.
	 */
	private _updateBreakpoints(response: DebugProtocol.SetBreakpointsResponse, path: string, scriptId: number, lbs: DebugProtocol.SourceBreakpoint[], sourcemap: boolean = false): void {

		// clear all existing breakpoints for the given path or script ID
		this._node.command2('listbreakpoints').then(nodeResponse => {

			const toClear = new Array<number>();

			const path_regexp = this._pathToRegexp(path);

			// try to match breakpoints
			for (let breakpoint of nodeResponse.body.breakpoints) {
				switch (breakpoint.type) {
				case 'scriptId':
					if (scriptId === breakpoint.script_id) {
						toClear.push(breakpoint.number);
					}
					break;
				case 'scriptRegExp':
					if (path_regexp === breakpoint.script_regexp) {
						toClear.push(breakpoint.number);
					}
					break;
				}
			}

			return this._clearBreakpoints(toClear);

		}).then( () => {

			return Promise.all(lbs.map(bp => this._setBreakpoint(scriptId, path, bp, sourcemap)));

		}).then(result => {

			response.body = {
				breakpoints: result
			};
			this.sendResponse(response);
			this.log('bp', `_updateBreakpoints: result ${JSON.stringify(result)}`);

		}).catch(nodeResponse => {
			this._sendNodeResponse(response, nodeResponse);
		});
	}

	/*
	 * Clear breakpoints by their ids.
	 */
	private _clearBreakpoints(ids: Array<number>) : Promise<void> {
		return Promise.all(ids.map(id => this._node.command2('clearbreakpoint', { breakpoint: id }))).then(() => {
			return;
		}).catch((e) => {
			return;	// ignore errors
		});
	}

	/*
	 * register a single breakpoint with node.
	 */
	private _setBreakpoint(scriptId: number, path: string, lb: DebugProtocol.SourceBreakpoint, sourcemap: boolean) : Promise<Breakpoint> {

		if (lb.line < 0) {
			// ignore this breakpoint because it couldn't be source mapped successfully
			return Promise.resolve(new Breakpoint(false));
		}

		if (lb.line === 0) {
			lb.column += NodeDebugSession.FIRST_LINE_OFFSET;
		}

		if (scriptId > 0) {
			(<any>lb).type = 'scriptId';
			(<any>lb).target = scriptId;
		} else {
			(<any>lb).type = 'scriptRegExp';
			(<any>lb).target = this._pathToRegexp(path);
		}

		return this._node.command2('setbreakpoint', lb).then(resp => {

			this.log('bp', `_setBreakpoint: ${JSON.stringify(lb)}`);

			let actualLine = lb.line;
			let actualColumn = lb.column;

			const al = resp.body.actual_locations;
			if (al.length > 0) {
				actualLine = al[0].line;
				actualColumn = this._adjustColumn(actualLine, al[0].column);
			}

			if (sourcemap) {
				// this source uses a sourcemap so we have to map js locations back to source locations
				const mapresult = this._sourceMaps.MapToSource(path, actualLine, actualColumn);
				if (mapresult) {
					this.log('sm', `_setBreakpoints: bp verification gen: '${path}' ${actualLine}:${actualColumn} -> src: '${mapresult.path}' ${mapresult.line}:${mapresult.column}`);
					actualLine = mapresult.line;
					actualColumn = mapresult.column;
				}
			}

			// nasty corner case: since we ignore the break-on-entry event we have to make sure that we
			// stop in the entry point line if the user has an explicit breakpoint there.
			// For this we check here whether a breakpoint is at the same location as the "break-on-entry" location.
			// If yes, then we plan for hitting the breakpoint instead of "continue" over it!

			if (!this._stopOnEntry && this._entryPath === path) {	// only relevant if we do not stop on entry and have a matching file
				if (this._entryLine === actualLine && this._entryColumn === actualColumn) {
					// we do not have to "continue" but we have to generate a stopped event instead
					this._needContinue = false;
					this._needBreakpointEvent = true;
					this.log('la', '_setBreakpoints: remember to fire a breakpoint event later');
				}
			}

			return new Breakpoint(true, this.convertDebuggerLineToClient(actualLine), this.convertDebuggerColumnToClient(actualColumn));

		}).catch((error) => {
			return new Breakpoint(false);
		});
	}

	/**
	 * converts a path into a regular expression for use in the setbreakpoint request
	 */
	private _pathToRegexp(path: string): string {

		if (!path)
			return path;

		let escPath = path.replace(/([/\\.?*()^${}|[\]])/g, '\\$1');

 		// check for drive letter
		if (/^[a-zA-Z]:\\/.test(path)) {
			const u = escPath.substring(0, 1).toUpperCase();
			const l = u.toLowerCase();
			escPath = '[' + l + u + ']' + escPath.substring(1);
		}

		/*
		// support case-insensitive breakpoint paths
		const escPathUpper = escPath.toUpperCase();
		const escPathLower = escPath.toLowerCase();

		escPath = '';
		for (var i = 0; i < escPathUpper.length; i++) {
			const u = escPathUpper[i];
			const l = escPathLower[i];
			if (u === l) {
				escPath += u;
			} else {
				escPath += '[' + l + u + ']';
			}
		}
		*/

		const pathRegex = '^(.*[\\/\\\\])?' + escPath + '$';		// skips drive letters
		return pathRegex;
	}

	//--- set function breakpoints request ------------------------------------------------------------------------------------

	protected setFunctionBreakPointsRequest(response: DebugProtocol.SetFunctionBreakpointsResponse, args: DebugProtocol.SetFunctionBreakpointsArguments): void {

		// clear all existing function breakpoints
		this._clearBreakpoints(this._functionBreakpoints).then(() => {

			this._functionBreakpoints.length = 0;	// clear array

			// set new function breakpoints
			return Promise.all(args.breakpoints.map(functionBreakpoint => this._setFunctionBreakpoint(functionBreakpoint)));

		}).then(results => {

			response.body = {
				breakpoints: results
			};
			this.sendResponse(response);

			this.log('bp', `setFunctionBreakPointsRequest: result ${JSON.stringify(results)}`);

		}).catch(nodeResponse => {

			this._sendNodeResponse(response, nodeResponse);
		});
	}

	/*
	 * Register a single function breakpoint with node.
	 * Returns verification info about the breakpoint.
	 */
	private _setFunctionBreakpoint(functionBreakpoint: DebugProtocol.FunctionBreakpoint): Promise<Breakpoint> {

		let args: any = {
			type: 'function',
			target: functionBreakpoint.name
		};
		if (functionBreakpoint.condition) {
			args.condition = functionBreakpoint.condition;
		}

		return this._node.command2('setbreakpoint', args).then(resp => {
			this._functionBreakpoints.push(resp.body.breakpoint);	// remember function breakpoint ids
			const locations = resp.body.actual_locations;
			if (locations && locations.length > 0) {
				const actualLine = this.convertDebuggerLineToClient(locations[0].line);
				const actualColumn = this.convertDebuggerColumnToClient(this._adjustColumn(actualLine, locations[0].column));
				return new Breakpoint(true, actualLine, actualColumn);	// TODO@AW add source
			} else {
				return new Breakpoint(true);
			}
		}).catch((resp: NodeV8Response) => {
			return <DebugProtocol.Breakpoint> {
				verified: false,
				message: resp.message
			};
		});
	}

	//--- set exception request -----------------------------------------------------------------------------------------------

	protected setExceptionBreakPointsRequest(response: DebugProtocol.SetExceptionBreakpointsResponse, args: DebugProtocol.SetExceptionBreakpointsArguments): void {

		this.log('bp', `setExceptionBreakPointsRequest: ${JSON.stringify(args.filters)}`);

		let f: string;
		const filters = args.filters;
		if (filters) {
			if (filters.indexOf('all') >= 0) {
				f = 'all';
			} else if (filters.indexOf('uncaught') >= 0) {
				f = 'uncaught';
			}
		}

		// we need to simplify this...
		this._node.command('setexceptionbreak', { type: 'all', enabled: false }, (nodeResponse1: NodeV8Response) => {
			if (nodeResponse1.success) {
				this._node.command('setexceptionbreak', { type: 'uncaught', enabled: false }, (nodeResponse2: NodeV8Response) => {
					if (nodeResponse2.success) {
						if (f) {
							this._node.command('setexceptionbreak', { type: f, enabled: true }, (nodeResponse3: NodeV8Response) => {
								if (nodeResponse3.success) {
									this.sendResponse(response);	// send response for setexceptionbreak
								} else {
									this._sendNodeResponse(response, nodeResponse3);
								}
							});
						} else {
							this.sendResponse(response);	// send response for setexceptionbreak
						}
					} else {
						this._sendNodeResponse(response, nodeResponse2);
					}
				});
			} else {
				this._sendNodeResponse(response, nodeResponse1);
			}
		});
	}

	//--- set exception request -----------------------------------------------------------------------------------------------

	protected configurationDoneRequest(response: DebugProtocol.ConfigurationDoneResponse, args: DebugProtocol.ConfigurationDoneArguments): void {

		// all breakpoints are configured now -> start debugging

		let info = 'nothing to do';

		if (this._needContinue) {	// we do not break on entry
			this._needContinue = false;
			info = 'do a "Continue"';
			this._node.command('continue', null, (nodeResponse) => { });
		}

		if (this._needBreakpointEvent) {	// we have to break on entry
			this._needBreakpointEvent = false;
			info = 'fire breakpoint event';
			this.sendEvent(new StoppedEvent(NodeDebugSession.BREAKPOINT_REASON, NodeDebugSession.DUMMY_THREAD_ID));
		}

		this.log('la', `configurationDoneRequest: ${info}`);

		this.sendResponse(response);
	}

	//--- threads request -----------------------------------------------------------------------------------------------------

	protected threadsRequest(response: DebugProtocol.ThreadsResponse): void {
		this._node.command('threads', null, (nodeResponse: NodeV8Response) => {
			const threads = new Array<Thread>();
			if (nodeResponse.success) {
				const ths = nodeResponse.body.threads;
				if (ths) {
					for (let thread of ths) {
						const id = thread.id;
						if (id >= 0) {
							threads.push(new Thread(id, NodeDebugSession.DUMMY_THREAD_NAME));
						}
					}
				}
			}
			if (threads.length === 0) {
				threads.push(new Thread(NodeDebugSession.DUMMY_THREAD_ID, NodeDebugSession.DUMMY_THREAD_NAME));
			}
			response.body = {
				threads: threads
			};
			this.sendResponse(response);
		});
	}

	//--- stacktrace request --------------------------------------------------------------------------------------------------

	protected stackTraceRequest(response: DebugProtocol.StackTraceResponse, args: DebugProtocol.StackTraceArguments): void {

		const threadReference = args.threadId;
		let maxLevels = args.levels;

		if (threadReference !== NodeDebugSession.DUMMY_THREAD_ID) {
			this.sendErrorResponse(response, 2014, "unexpected thread reference {_thread}", { _thread: threadReference }, ErrorDestination.Telemetry);
			return;
		}

		// get first frame and the total number of frames
		this._node.command2('backtrace', { fromFrame: 0, toFrame: 1 }).then(backtraceResponse => {

			let totalFrames = backtraceResponse.body.totalFrames;
			if (!maxLevels || totalFrames < maxLevels) {
				maxLevels = totalFrames;
			}

			return this._createStackFrame(backtraceResponse);

		}).then(firstframe => {

			const frames = new Array<Promise<StackFrame>>(Promise.resolve(firstframe));
			// get the remaining frames
			for (let frameIx = 1; frameIx < maxLevels; frameIx++) {
				frames.push(this._getStackFrame(frameIx));
			}
			return Promise.all(frames);

		}).then(stackframes => {

			response.body = {
				stackFrames: stackframes
			};
			this.sendResponse(response);

		}).catch(error => {

			response.body = {
				stackFrames: []
			};
			this.sendResponse(response);

		});
	}

	private _getStackFrame(frameIx: number) : Promise<StackFrame> {

		return this._node.command2('backtrace', { fromFrame: frameIx, toFrame: frameIx+1 }).then(backtraceResponse => {

			return this._createStackFrame(backtraceResponse);

		}).catch((response) => {
			// error backtrace request
			return null;
		});
	}

	private _createStackFrame(backtraceResponse: any) : Promise<StackFrame> {

		this._cacheRefs(backtraceResponse);

		const frame = backtraceResponse.body.frames[0];

		// resolve some refs
		return this._getValues([ frame.script, frame.func, frame.receiver ]).then(() => {

			let line = frame.line;
			let column = this._adjustColumn(line, frame.column);

			let src: Source = null;
			let origin = "content streamed from node";
			let adapterData: any;

			const script_val = this._getValueFromCache(frame.script);
			if (script_val) {
				let name = script_val.name;
				if (name && PathUtils.isAbsolutePath(name)) {

					let remotePath = name;		// with remote debugging path might come from a different OS

					// if launch.json defines localRoot and remoteRoot try to convert remote path back to a local path
					let localPath = this._remoteToLocal(remotePath);

					if (localPath !== remotePath && this._attachMode) {
						// assume attached to remote node process
						origin = "content streamed from remote node";
					}

					name = Path.basename(localPath);

					// source mapping
					if (this._sourceMaps) {

						// try to map
						const mapresult = this._sourceMaps.MapToSource(localPath, line, column);
						if (mapresult) {
							this.log('sm', `_getStackFrame: gen: '${localPath}' ${line}:${column} -> src: '${mapresult.path}' ${mapresult.line}:${mapresult.column}`);
							// verify that a file exists at path
							if (FS.existsSync(mapresult.path)) {
								// use this mapping
								localPath = mapresult.path;
								name = Path.basename(localPath);
								line = mapresult.line;
								column = mapresult.column;
							} else {
								// file doesn't exist at path
								// if source map has inlined source use it
								const content = (<any>mapresult).content;
								if (content) {
									name = Path.basename(mapresult.path);
									const sourceHandle = this._sourceHandles.create(new SourceSource(0, content));
									const adapterData = {
										inlinePath: mapresult.path
									};
									src = new Source(name, null, sourceHandle, "inlined content from source map", adapterData);
									line = mapresult.line;
									column = mapresult.column;
									this.log('sm', `_getStackFrame: source '${mapresult.path}' doesn't exist -> use inlined source`);
								} else {
									this.log('sm', `_getStackFrame: source doesn't exist and no inlined source -> use generated file`);
								}
							}
						} else {
							this.log('sm', `_getStackFrame: gen: '${localPath}' ${line}:${column} -> couldn't be mapped to source -> use generated file`);
						}
					}

					if (src === null) {
						if (FS.existsSync(localPath)) {
							src = new Source(name, this.convertDebuggerPathToClient(localPath));
						} else {
							// source doesn't exist locally
							adapterData = {
								remotePath: remotePath	// assume it is a remote path
							};
						}
					}
				} else {
					origin = "core module";
				}

				if (src === null) {
					// fall back: source not found locally -> prepare to stream source content from node backend.
					const script_id:number = script_val.id;
					if (script_id >= 0) {
						const sourceHandle = this._sourceHandles.create(new SourceSource(script_id));
						src = new Source(name, null, sourceHandle, origin, adapterData);
					}
				}
			}

			let func_name: string;
			const func_val = this._getValueFromCache(frame.func);
			if (func_val) {
				func_name = func_val.inferredName;
				if (!func_name || func_name.length === 0) {
					func_name = func_val.name;
				}
			}
			if (!func_name || func_name.length === 0) {
				func_name = NodeDebugSession.ANON_FUNCTION;
			}

			const frameReference = this._frameHandles.create(frame);
			return new StackFrame(frameReference, func_name, src, this.convertDebuggerLineToClient(line), this.convertDebuggerColumnToClient(column));
		});
	}

	//--- scopes request ------------------------------------------------------------------------------------------------------

	protected scopesRequest(response: DebugProtocol.ScopesResponse, args: DebugProtocol.ScopesArguments): void {

		const frame = this._frameHandles.get(args.frameId);
		if (!frame) {
			this.sendErrorResponse(response, 2020, "stack frame not valid");
			return;
		}
		const frameIx = frame.index;
		const frameThis = this._getValueFromCache(frame.receiver);

		this._node.command2('scopes', { frame_index: frameIx, frameNumber: frameIx }).then(response => {

			this._cacheRefs(response);

			const scopes : any[] = response.body.scopes;

			return Promise.all(scopes.map(scope => {

				const type: number = scope.type;
				const scopeName = (type >= 0 && type < NodeDebugSession.SCOPE_NAMES.length) ? NodeDebugSession.SCOPE_NAMES[type] : ("Unknown Scope:" + type);
				const extra = type === 1 ? frameThis : null;
				const expensive = type === 0;	// global scope is expensive

				return this._getValue2(scope.object).then(scopeObject => {
					return new Scope(scopeName, this._variableHandles.create(new PropertyExpander(scopeObject, extra)), expensive);
				}).catch(error => {
					return new Scope(scopeName, 0);
				});
			}));

		}).then(scopes => {

			// exception scope
			if (frameIx === 0 && this._exception) {
				scopes.unshift(new Scope("Exception", this._variableHandles.create(new PropertyExpander(this._exception))));
			}

			response.body = {
				scopes: scopes
			};
			this.sendResponse(response);

		}).catch(error => {
			// in case of error return empty scopes array
			response.body = { scopes: [] };
			this.sendResponse(response);
		});
	}

	//--- variables request ---------------------------------------------------------------------------------------------------

	protected variablesRequest(response: DebugProtocol.VariablesResponse, args: DebugProtocol.VariablesArguments): void {
		const reference = args.variablesReference;
		const expander = this._variableHandles.get(reference);
		if (expander) {
			const variables = new Array<Variable>();
			expander.Expand(this, variables, () => {
				variables.sort(NodeDebugSession.compareVariableNames);
				response.body = {
					variables: variables
				};
				this.sendResponse(response);
			});
		} else {
			response.body = {
				variables: []
			};
			this.sendResponse(response);
		}
	}

	/*
	 * there are three modes:
	 * "all": add all properties (indexed and named)
	 * "range": add only the indexed properties between 'start' and 'end' (inclusive)
	 * "named": add only the named properties.
 	 */
	public _addProperties(variables: Array<Variable>, obj: any, mode: string, start: number, end: number, done: (message?) => void): void {

		const type = <string> obj.type;
		if (type === 'object' || type === 'function' || type === 'error' || type === 'regexp' || type === 'map' || type === 'set') {

			const properties = obj.properties;
			if (!properties) {       // if properties are missing, try to use size from vscode node extension

				switch (mode) {
					case "range":
					case "all":
						const size = obj.size;
						if (size >= 0) {
							const handle = obj.handle;
							if (typeof handle === 'number' && handle != 0) {
								this._addArrayElements(variables, handle, start, end, done);
								return;
							}
						}
						done("array size not found");
						return;

					case "named":
						// can't add named properties because we don't have access to them yet.
						break;
				}
				done();
				return;
			}

			const selectedProperties = new Array<any>();

			// first pass: determine properties
			let found_proto = false;
			for (let property of properties) {

				if ('name' in property) {	// bug #19654: only extract properties with a node

					const name = property.name;

					if (name === NodeDebugSession.PROTO) {
						found_proto = true;
					}

					switch (mode) {
						case "all":
							selectedProperties.push(property);
							break;
						case "named":
							if (typeof name == 'string') {
								selectedProperties.push(property);
							}
							break;
						case "range":
							if (typeof name == 'number' && name >= start && name <= end) {
								selectedProperties.push(property);
							}
							break;
					}
				}
			}

			// do we have to add the protoObject to the list of properties?
			if (!found_proto && (mode === 'all' || mode === 'named')) {
				const h = <number> obj.handle;
				if (h > 0) {    // only add if not an internal debugger object
					obj.protoObject.name = NodeDebugSession.PROTO;
					selectedProperties.push(obj.protoObject);
				}
			}

			// second pass: find properties where additional value lookup is required
			const needLookup = new Array<number>();
			for (let property of selectedProperties) {
				if (!property.value && property.ref) {
					if (needLookup.indexOf(property.ref) < 0) {
						needLookup.push(property.ref);
					}
				}
			}

			if (selectedProperties.length > 0) {
				// third pass: now lookup all refs at once
				this._resolveToCache(needLookup, () => {
					// build variables
					this._addVariables(selectedProperties).then(result => {
						result.forEach(v => variables.push(v));
						done();
					});
				});
				return;
			}
		}
		done();
	}

	private _addVariables(properties: Array<any>) : Promise<Variable[]> {
		return Promise.all<Variable>(properties.map(property => {
			const val = this._getValueFromCache(property);
			let name = property.name;
			if (typeof name == 'number') {
				name = `[${name}]`;
			}
			return this._addVariable2(name, val);
		}));
	};

	private _addArrayElements(variables: Array<Variable>, array_ref: number, start: number, end: number, done: (message?: string) => void): void {
		this._node.command('vscode_range', { handle: array_ref, from: start, to: end }, resp => {
			if (resp.success) {
				this._addArrayElement(start, resp.body.result).then(result => {
					result.forEach(v => variables.push(v));
					done();
				}).catch((error) => {
					done(error);
				});
			} else {
				done(resp.message);
			}
		});
	}

	private _addArrayElement(start: number, items: Array<any>) : Promise<Variable[]> {
		return Promise.all<Variable>(items.map((item, ix) => {
			return new Promise<Variable>((completeDispatch, errorDispatch) => {
				const name = `[${start+ix}]`;
				this._createVariable(name, item, (v: Variable) => {
					completeDispatch(v);
				});
			});
		}));
	}

	public _addVariable(variables: Array<Variable>, name: string, val: any, done: () => void): void {
		this._createVariable(name, val, (result: Variable) => {
			if (result) {
				variables.push(result);
			}
			done();
		});
	}

	public _addVariable2(name: string, val: any): Promise<Variable> {
		return new Promise<Variable>((completeDispatch, errorDispatch) => {
			this._createVariable(name, val, (result: Variable) => {
				completeDispatch(result);
			});
		});
	}

	private _createVariable(name: string, val: any, done: (result: Variable) => void): void {
		if (!val) {
			done(null);
			return;
		}
		let str_val = val.value;
		const type = <string> val.type;

		switch (type) {

			case 'object':
			case 'function':
			case 'regexp':
			case 'error':
				// indirect value

				let value = <string> val.className;
				let text = <string> val.text;

				switch (value) {
					case 'Array': case 'Buffer':
					case 'Int8Array': case 'Uint8Array': case 'Uint8ClampedArray':
					case 'Int16Array': case 'Uint16Array':
					case 'Int32Array': case 'Uint32Array':
					case 'Float32Array': case 'Float64Array':

						if (val.ref) {
							//val = this.getRef(val.ref);
						}

						let size = <number>val.size;     // probe for our own "size"
						if (size) {
							done(this._createArrayVariable(name, val, value, size));
						} else {
							const l = val.properties[0];
							if (l) {
								size = l.value;
								if (size) {
									done(this._createArrayVariable(name, val, value, size));
								} else {
									// the first property of arrays is the length
									this._getValue(l, (length_val: any) => {
										let size = -1;
										if (length_val) {
											size = length_val.value;
										}
										done(this._createArrayVariable(name, val, value, size));
									});
								}
							}
						}
						return;

					case 'RegExp':
						done(new Variable(name, text, this._variableHandles.create(new PropertyExpander(val))));
						return;

					case 'Object':
						this._getValue(val.constructorFunction, (constructor_val) => {
							if (constructor_val) {
								const constructor_name = <string>constructor_val.name;
								if (constructor_name) {
									value = constructor_name;
								}
							}
							done(new Variable(name, value, this._variableHandles.create(new PropertyExpander(val))));
						});
						return;

					case 'Function':
					case 'Error':
					default:
						if (text) {
							if (text.indexOf('\n') >= 0) {
								// replace body of function with '...'
								const pos = text.indexOf('{');
								if (pos > 0) {
									text = text.substring(0, pos) + '{ … }';
								}
							}
							value = text;
						}
						break;
				}
				done(new Variable(name, value, this._variableHandles.create(new PropertyExpander(val))));
				return;

			case 'string':      // direct value
				if (str_val) {
					str_val = str_val.replace('\n', '\\n').replace('\r', '\\r');
				}
				done(new Variable(name, `"${str_val}"`));
				return;

			case 'boolean':
				done(new Variable(name, str_val.toString().toLowerCase()));	// node returns these boolean values capitalized
				return;

			case 'map':
			case 'set':
			case 'undefined':
			case 'null':
				// type is only info we have
				done(new Variable(name, type));
				return;

			case 'number':
				done(new Variable(name, '' + val.value));
				return;

			case 'frame':
			default:
				done(new Variable(name, str_val ? str_val.toString() : 'undefined'));
				return;
		}
	}

	private _createArrayVariable(name: string, val: any, value: string, size: number): Variable {
		value += (size >= 0) ? `[${size}]` : '[]';
		const expander = (size > RANGESIZE) ? new ArrayExpander(val, size) : new PropertyExpander(val); // new PropertyRangeExpander(val, 0, size-1);
		return new Variable(name, value, this._variableHandles.create(expander));
	}

	//--- pause request -------------------------------------------------------------------------------------------------------

	protected pauseRequest(response: DebugProtocol.PauseResponse, args: DebugProtocol.PauseArguments) : void {
		this._node.command('suspend', null, (nodeResponse) => {
			if (nodeResponse.success) {
				this._stopped('pause');
				this._lastStoppedEvent = new StoppedEvent(NodeDebugSession.USER_REQUEST_REASON, NodeDebugSession.DUMMY_THREAD_ID);
				this.sendResponse(response);
				this.sendEvent(this._lastStoppedEvent);
			} else {
				this._sendNodeResponse(response, nodeResponse);
			}
		});
	}

	//--- continue request ----------------------------------------------------------------------------------------------------

	protected continueRequest(response: DebugProtocol.ContinueResponse, args: DebugProtocol.ContinueArguments): void {
		this._node.command('continue', null, (nodeResponse) => {
			this._sendNodeResponse(response, nodeResponse);
		});
	}

	//--- step request --------------------------------------------------------------------------------------------------------

	protected stepInRequest(response: DebugProtocol.StepInResponse, args: DebugProtocol.StepInArguments) : void {
		this._node.command('continue', { stepaction: 'in' }, (nodeResponse) => {
			this._sendNodeResponse(response, nodeResponse);
		});
	}

	protected stepOutRequest(response: DebugProtocol.StepOutResponse, args: DebugProtocol.StepOutArguments) : void {
		this._node.command('continue', { stepaction: 'out' }, (nodeResponse) => {
			this._sendNodeResponse(response, nodeResponse);
		});
	}

	protected nextRequest(response: DebugProtocol.NextResponse, args: DebugProtocol.NextArguments): void {
		this._node.command('continue', { stepaction: 'next' }, (nodeResponse) => {
			this._sendNodeResponse(response, nodeResponse);
		});
	}

	//--- evaluate request ----------------------------------------------------------------------------------------------------

	protected evaluateRequest(response: DebugProtocol.EvaluateResponse, args: DebugProtocol.EvaluateArguments): void {

		const expression = args.expression;

		const evalArgs = {
			expression: expression,
			disable_break: true,
			maxStringLength: 10000
		};
		if (args.frameId > 0) {
			const frame = this._frameHandles.get(args.frameId);
			if (!frame) {
				this.sendErrorResponse(response, 2020, "stack frame not valid");
				return;
			}
			const frameIx = frame.index;
			(<any>evalArgs).frame = frameIx;
		} else {
			(<any>evalArgs).global = true;
		}

		this._node.command(this._nodeExtensionsAvailable ? 'vscode_evaluate' : 'evaluate', evalArgs, (resp: NodeV8Response) => {
			if (resp.success) {
				this._createVariable('evaluate', resp.body, (v: Variable) => {
					if (v) {
						response.body = {
							result: v.value,
							variablesReference: v.variablesReference
						};
					} else {
						response.success = false;
						response.message = "not available";
					}
					this.sendResponse(response);
				});
			} else {
				response.success = false;
				if (resp.message.indexOf('ReferenceError: ') === 0 || resp.message === 'No frames') {
					response.message = "not available";
				} else if (resp.message.indexOf('SyntaxError: ') === 0) {
					const m = resp.message.substring('SyntaxError: '.length).toLowerCase();
					response.message = `invalid expression: ${m}`;
				} else {
					response.message = resp.message;
				}
				this.sendResponse(response);
			}
		});
	}

	//--- source request ------------------------------------------------------------------------------------------------------

	protected sourceRequest(response: DebugProtocol.SourceResponse, args: DebugProtocol.SourceArguments): void {

		const sourceHandle = args.sourceReference;
		const srcSource = this._sourceHandles.get(sourceHandle);

		if (srcSource.source) {
			response.body = {
				content: srcSource.source
			};
			this.sendResponse(response);
			return;
		}

		if (srcSource.scriptId) {

			this._node.command('scripts', { types: 1+2+4, includeSource: true, ids: [ srcSource.scriptId ] }, (nodeResponse: NodeV8Response) => {
				if (nodeResponse.success) {
					srcSource.source = nodeResponse.body[0].source;
				} else {
					srcSource.source = "<source not found>";
				}
				response.body = {
					content: srcSource.source
				};
				this.sendResponse(response);
			});

		} else {
			this.sendErrorResponse(response, 9999, "sourceRequest error");
		}
	}

	//---- private helpers ----------------------------------------------------------------------------------------------------

	/**
	 * Tries to map a (local) VSCode path to a corresponding path on a remote host (where node is running).
	 * The remote host might use a different OS so we have to make sure to create correct file paths.
	 */
	private _localToRemote(localPath: string) : string {
		if (this._remoteRoot && this._localRoot) {

			let relPath = PathUtils.makeRelative2(this._localRoot, localPath);
			let remotePath = PathUtils.join(this._remoteRoot, relPath);

			if (/^[a-zA-Z]:[\/\\]/.test(this._remoteRoot)) {	// Windows
				remotePath = PathUtils.toWindows(remotePath);
			}

			this.log('bp', `_localToRemote: ${localPath} -> ${remotePath}`);

			return remotePath;
		} else {
			return localPath;
		}
	}

	/**
	 * Tries to map a path from the remote host (where node is running) to a corresponding local path.
	 * The remote host might use a different OS so we have to make sure to create correct file paths.
	 */
	private _remoteToLocal(remotePath: string) : string {
		if (this._remoteRoot && this._localRoot) {

			let relPath = PathUtils.makeRelative2(this._remoteRoot, remotePath);
			let localPath = PathUtils.join(this._localRoot, relPath);

			if (process.platform === 'win32') {	// local is Windows
				localPath = PathUtils.toWindows(localPath);
			}

			this.log('bp', `_remoteToLocal: ${remotePath} -> ${localPath}`);

			return localPath;
		} else {
			return remotePath;
		}
	}

	private _sendNodeResponse(response: DebugProtocol.Response, nodeResponse: NodeV8Response): void {
		if (nodeResponse.success) {
			this.sendResponse(response);
		} else {
			const errmsg = nodeResponse.message;
			if (errmsg.indexOf('unresponsive') >= 0) {
				this.sendErrorResponse(response, 2015, "request '{_request}' was cancelled because node is unresponsive", { _request: nodeResponse.command } );
			} else if (errmsg.indexOf('timeout') >= 0) {
				this.sendErrorResponse(response, 2016, "node did not repond to request '{_request}' in a reasonable amount of time", { _request: nodeResponse.command } );
			} else {
				this.sendErrorResponse(response, 2013, "node request '{_request}' failed (reason: {_error})", { _request: nodeResponse.command, _error: errmsg }, ErrorDestination.Telemetry);
			}
		}
	}

	private _repeater(n: number, done: (success: boolean) => void, asyncwork: (done2: (again: boolean) => void) => void): void {
		if (n > 0) {
			asyncwork( (again: boolean) => {
				if (again) {
					setTimeout(() => {
						// recurse
						this._repeater(n-1, done, asyncwork);
					}, 100);		// retry after 100 ms
				} else {
					done(true);
				}
			});
		} else {
			done(false);
		}
	}

	private _cacheRefs(response: NodeV8Response): void {
		const refs = response.refs;
		for (let r of refs) {
			this._cache(r.handle, r);
		}
	}

	private _cache(handle: number, o: any): void {
		this._refCache[handle] = o;
	}

	private _getValues(containers: any[]) : Promise<any> {

		return new Promise((c, e) => {
			const handles = [];
			for (let container of containers) {
				handles.push(container.ref);
			}
			this._resolveToCache(handles, () => {
				c();
			});
		});
	}

	private _getValue(container: any, done: (result: any) => void): void {
		if (container) {
			const handle = container.ref;
			this._resolveToCache([ handle ], () => {
				const value = this._refCache[handle];
				done(value);
			});
		} else {
			done(null);
		}
	}

	private _getValue2(container: any) : Promise<any> {
		return new Promise((c, e) => {
			if (container) {
				const handle = container.ref;
				this._resolveToCache([ handle ], () => {
					const value = this._refCache[handle];
					c(value);
				});
			} else {
				c(null);
			}
		});
	}

	private _getValueFromCache(container: any): any {
		const handle = container.ref;
		const value = this._refCache[handle];
		if (value)
			return value;
		// console.error("ref not found cache");
		return null;
	}

	private _resolveToCache(handles: number[], done: () => void): void {

		const lookup = new Array<number>();

		for (let handle of handles) {
			const val = this._refCache[handle];
			if (!val) {
				if (handle >= 0) {
					lookup.push(handle);
				} else {
					// console.error("shouldn't happen: cannot lookup transient objects");
				}
			}
		}

		if (lookup.length > 0) {
			this._node.command(this._nodeExtensionsAvailable ? 'vscode_lookup' : 'lookup', { handles: lookup }, (resp: NodeV8Response) => {

				if (resp.success) {
					this._cacheRefs(resp);

					for (let key in resp.body) {
						const obj = resp.body[key];
						const handle: number = obj.handle;
						this._cache(handle, obj);
					}

				} else {
					let val: any;
					if (resp.message.indexOf('timeout') >= 0) {
						val = { type: 'number', value: NodeDebugSession.LARGE_DATASTRUCTURE_TIMEOUT };
					} else {
						val = { type: 'number', value: `<data error: ${resp.message}>` };
					}

					// store error value in cache
					for (let i = 0; i < handles.length; i++) {
						const handle = handles[i];
						const r = this._refCache[handle];
						if (!r) {
							this._cache(handle, val);
						}
					}
				}
				done();
			});
		} else {
			done();
		}
	}

	private _createStoppedEvent(body: any): DebugProtocol.StoppedEvent {

		// workaround: load sourcemap for this location to populate cache
		if (this._sourceMaps) {
			let path = body.script.name;
			if (path && PathUtils.isAbsolutePath(path)) {
				path = this._remoteToLocal(path);
				this._sourceMaps.MapToSource(path, 0, 0);
			}
		}

		let reason: string;
		let exception_text: string;

		// is exception?
		if (body.exception) {
			this._exception = body.exception;
			exception_text = body.exception.text;
			reason = NodeDebugSession.EXCEPTION_REASON;
		}

		// is breakpoint?
		if (!reason) {
			const breakpoints = body.breakpoints;
			if (isArray(breakpoints) && breakpoints.length > 0) {
				const id = breakpoints[0];
				if (!this._gotEntryEvent && id === 1) {	// 'stop on entry point' is implemented as a breakpoint with id 1
					reason = NodeDebugSession.ENTRY_REASON;
					this._rememberEntryLocation(body.script.name, body.sourceLine, body.sourceColumn);
				} else {
					reason = NodeDebugSession.BREAKPOINT_REASON;
				}
			}
		}

		// is debugger statement?
		if (!reason) {
			const sourceLine = body.sourceLineText;
			if (sourceLine && sourceLine.indexOf('debugger') >= 0) {
				reason = NodeDebugSession.DEBUGGER_REASON;
			}
		}

		// must be "step"!
		if (!reason) {
			reason = NodeDebugSession.STEP_REASON;
		}

		return new StoppedEvent(reason, NodeDebugSession.DUMMY_THREAD_ID, exception_text);
	}

	private _rememberEntryLocation(path: string, line: number, column: number): void {
		if (path) {
			this._entryPath = path;
			this._entryLine = line;
			this._entryColumn = this._adjustColumn(line, column);
			this._gotEntryEvent = true;
		}
	}

	/**
	 * workaround for column being off in the first line (because of a wrapped anonymous function)
	 */
	private _adjustColumn(line: number, column: number): number {
		if (line === 0) {
			column -= NodeDebugSession.FIRST_LINE_OFFSET;
			if (column < 0) {
				column = 0;
			}
		}
		return column;
	}

	private _findModule(name: string, done: (id: number) => void): void {
		this._node.command('scripts', { types: 1 + 2 + 4, filter: name }, (resp: NodeV8Response) => {
			if (resp.success) {
				for (var result of resp.body) {
					if (result.name === name) {	// return the first exact match
						done(result.id);
						return;
					}
				}
			}
			done(-1);	// not found
		});
	}

	//---- private static ---------------------------------------------------------------

	private static isJavaScript(path: string): boolean {

		const name = Path.basename(path).toLowerCase();
		if (endsWith(name, '.js')) {
			return true;
		}

		try {
			const buffer = new Buffer(30);
			const fd = FS.openSync(path, 'r');
			FS.readSync(fd, buffer, 0, buffer.length, 0);
			FS.closeSync(fd);
			const line = buffer.toString();
			if (NodeDebugSession.NODE_SHEBANG_MATCHER.test(line)) {
				return true;
			}
		} catch(e) {
			// silently ignore problems
		}

		return false;
	}

	private static compareVariableNames(v1: Variable, v2: Variable): number {
		let n1 = v1.name;
		let n2 = v2.name;

		if (n1 === NodeDebugSession.PROTO) {
			return 1;
		}
		if (n2 === NodeDebugSession.PROTO) {
			return -1;
		}

		// convert [n], [n..m] -> n
		n1 = NodeDebugSession.extractNumber(n1);
		n2 = NodeDebugSession.extractNumber(n2);

		const i1 = parseInt(n1);
		const i2 = parseInt(n2);
		const isNum1 = !isNaN(i1);
		const isNum2 = !isNaN(i2);

		if (isNum1 && !isNum2) {
			return 1;		// numbers after names
		}
		if (!isNum1 && isNum2) {
			return -1;		// names before numbers
		}
		if (isNum1 && isNum2) {
			return i1 - i2;
		}
		return n1.localeCompare(n2);
	}

	private static extractNumber(s: string): string {
		if (s[0] === '[' && s[s.length-1] === ']') {
			s = s.substring(1, s.length - 1);
			const p = s.indexOf('..');
			if (p >= 0) {
				s = s.substring(0, p);
			}
		}
		return s;
	}
}

function endsWith(str, suffix): boolean {
	return str.indexOf(suffix, str.length - suffix.length) !== -1;
}

function random(low: number, high: number): number {
	return Math.floor(Math.random() * (high - low) + low);
}

function isArray(what: any): boolean {
	return Object.prototype.toString.call(what) === '[object Array]';
}

function extendObject<T> (objectCopy: T, object: T): T {

	for (let key in object) {
		if (object.hasOwnProperty(key)) {
			objectCopy[key] = object[key];
		}
	}
	return objectCopy;
}


DebugSession.run(NodeDebugSession);
