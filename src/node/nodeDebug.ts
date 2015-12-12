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
 * This class represents an internal line/column breakpoint and its verification state.
 * It is only used temporarily in the setBreakpointsRequest.
 */
export class InternalBreakpoint {

	/** The requested breakpoint line location in the JavaScript file. */
	line: number;
	/** The requested breakpoint column location in the JavaScript file. */
	column: number;

	/** do not try to set this breakpoint (because source locations could not successfully be mapped to destination locations) */
	ignore: boolean;

	/** true if this breakpoint could be set and node.js returned an 'actual location' for it. */
	verified: boolean;
	/** The actual line location of this breakpoint in client coordinates. Contains the original client line if breakpoint could not be verified. */
	actualLine: number;
	/** the actual column location of this breakpoint in client coordinates. Contains the original client column if breakpoint could not be verified. */
	actualColumn: number;
}

/**
 * This interface should always match the schema found in the node-debug extension manifest.
 */
export interface SourceMapsArguments {
	/** Configure source maps. By default source maps are disabled. */
	sourceMaps?: boolean;
	/** Where to look for the generated code. Only used if sourceMaps is true. */
	outDir?: string;
}

class SourceSource {
	scriptId: number;

	constructor(sid: number) {
		this.scriptId = sid;
	}
}

/**
 * This interface should always match the schema found in the node-debug extension manifest.
 */
export interface LaunchRequestArguments extends SourceMapsArguments {
	/** An absolute path to the program to debug. */
	program: string;
	/** Automatically stop target after launch. If not specified, target does not stop. */
	stopOnEntry?: boolean;
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
export interface AttachRequestArguments extends SourceMapsArguments {
	/** The local port to attach to */
	port: number;
}

export class NodeDebugSession extends DebugSession {

	private static TRACE = false;

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

	private _adapterID: string;
	public _variableHandles = new Handles<Expandable>();
	public _frameHandles = new Handles<any>();
	private _sourceHandles = new Handles<SourceSource>();
	private _scriptSources = new Map<number, string>();
	private _refCache = new Map<number, any>();

	private _externalConsole: boolean;
	private _isTerminated: boolean;
	private _inShutdown: boolean;
	private _terminalProcess: CP.ChildProcess;		// the terminal process or undefined
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
	private _lazy: boolean; // whether node is in 'lazy' mode

	private _gotEntryEvent: boolean;
	private _entryPath: string;
	private _entryLine: number;		// entry line in *.js file (not in the source file)
	private _entryColumn: number;	// entry column in *.js file (not in the source file)

	public constructor(debuggerLinesStartAt1: boolean, isServer: boolean = false) {
		super(debuggerLinesStartAt1, isServer);

		this._node = new NodeV8Protocol();

		this._node.on('break', (event: NodeV8Event) => {
			this.log('NodeDebugSession: got break event from node');
			this._stopped();
			this._lastStoppedEvent = this.createStoppedEvent(event.body);
			if (this._lastStoppedEvent.body.reason === NodeDebugSession.ENTRY_REASON) {
				this.log('NodeDebugSession: supressed stop-on-entry event');
			} else {
				this.sendEvent(this._lastStoppedEvent);
			}
		});

		this._node.on('exception', (event: NodeV8Event) => {
			this._stopped();
			this._lastStoppedEvent = this.createStoppedEvent(event.body);
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

	/**
	 * clear everything that is no longer valid after a new stopped event.
	 */
	private _stopped(): void {
		this._exception = undefined;
		this._variableHandles.reset();
		this._frameHandles.reset();
		this._refCache = new Map<number, any>();
	}

	/**
	 * The debug session has terminated.
	 */
	private _terminated(reason: string): void {
		this.log('_terminated: ' + reason);

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

		this.log('initializeRequest: adapterID: ' + args.adapterID);

		this._adapterID = args.adapterID;
		this.sendResponse(response);

		this.log('initializeRequest: after sending response');
	}

	//---- launch request -----------------------------------------------------------------------------------------------------

	protected launchRequest(response: DebugProtocol.LaunchResponse, args: LaunchRequestArguments): void {

		this._externalConsole = (typeof args.externalConsole === 'boolean') && args.externalConsole;
		this._stopOnEntry = (typeof args.stopOnEntry === 'boolean') && args.stopOnEntry;

		this._initializeSourceMaps(args);

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

		this._lazy = true;	// node by default starts in '--lazy' mode

		// special code for 'extensionHost' debugging
		if (this._adapterID === 'extensionHost') {

			// we know that extensionHost is always launched with --nolazy
			this._lazy = false;

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
			if (!FS.existsSync(programPath)) {
				this.sendErrorResponse(response, 2007, "program '{path}' does not exist", { path: programPath });
				return;
			}
		} else {
			this.sendErrorResponse(response, 2005, "property 'program' is missing or empty");
			return;
		}

		if (NodeDebugSession.isJavaScript(programPath)) {
			if (this._sourceMaps) {
				// source maps enabled indicates that a tool like Babel is used to transpile js to js
				const generatedPath = this._sourceMaps.MapPathFromSource(programPath);
				if (generatedPath) {
					// there seems to be a generated file, so use that
					programPath = generatedPath;
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

		if (runtimeArgs.indexOf('--nolazy') >= 0) {
			this._lazy = false;
		} else {
			if (runtimeArgs.indexOf('--lazy') < 0) {	// if user does not force 'lazy' mode
				runtimeArgs.push('--nolazy');  			// we force node to compile everything so that breakpoints work immediately
				this._lazy = false;
			}
		}

		// we always break on entry (but if user did not request this, we will not stop in the UI).
		const launchArgs = [ runtimeExecutable, `--debug-brk=${port}` ].concat(runtimeArgs, [ program ], programArgs);

		if (this._externalConsole) {

			Terminal.launchInTerminal(workingDirectory, launchArgs, args.env).then((term: CP.ChildProcess) => {

				if (term) {
					// if we got a terminal process, we will track it
					this._terminalProcess = term;
					term.on('exit', () => {
						this._terminalProcess = null;
						this._terminated('terminal exited');
					});
				}

				this._attach(response, port);
			}).catch((error) => {
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

			//cmd.stdin.end();	// close stdin because we do not support input for a target

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
		this.sendEvent(new OutputEvent(cli, 'console'));
	}

	private _captureOutput(process: CP.ChildProcess) {
		process.stdout.on('data', (data: string) => {
			this.sendEvent(new OutputEvent(data.toString(), 'stdout'));
		});
		process.stderr.on('data', (data: string) => {
			this.sendEvent(new OutputEvent(data.toString(), 'stderr'));
		});
	}

	private _initializeSourceMaps(args: SourceMapsArguments) {
		if (!this._sourceMaps) {
			if (typeof args.sourceMaps === 'boolean' && args.sourceMaps) {
				const generatedCodeDirectory = args.outDir;
				this._sourceMaps = new SourceMaps(generatedCodeDirectory);
			}
		}
	}

	//---- attach request -----------------------------------------------------------------------------------------------------

	protected attachRequest(response: DebugProtocol.AttachResponse, args: AttachRequestArguments): void {

		if (!args.port) {
			this.sendErrorResponse(response, 2008, "property 'port' is missing");
			return;
		}

		this.log('attachRequest: port ' + args.port);

		this._initializeSourceMaps(args);

		if (this._adapterID === 'extensionHost') {
			// in EH mode 'attach' means 'launch' mode
			this._attachMode = false;
		} else {
			this._attachMode = true;
		}

		this._attach(response, args.port);
	}

	/*
	 * shared code used in launchRequest and attachRequest
	 */
	private _attach(response: DebugProtocol.Response, port: number, timeout: number = NodeDebugSession.ATTACH_TIMEOUT): void {
		let connected = false;
		const socket = new Net.Socket();
		socket.connect(port);
		socket.on('connect', (err: any) => {
			this.log('_attach: connect event in _attach');
			connected = true;
			this._node.startDispatch(socket, socket);
			this._initialize(response);
			return;
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
							this.log('_attach: retry socket.connect');
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
				this.log('_initialize: retrieve node pid: OK');
				this._nodeProcessId = parseInt(resp.body.value);
			} else {
				if (resp.message.indexOf('process is not defined') >= 0) {
					this.log('_initialize: process not defined error; got no pid');
					ok = true; // continue and try to get process.pid later
				}
			}

			if (ok) {

				this._pollForNodeTermination();

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
				this.log('_initialize: retrieve node pid: failed');

				if (retryCount < 10) {
					setTimeout(() => {
						// recurse
						this._initialize(response, retryCount+1);
					}, 50);
					return;
				} else {
					this.sendNodeResponse(response, resp);
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
						this.log('_extendDebugger: node code inject: OK');
						this._nodeExtensionsAvailable = true;
						callback(false);
					} else {
						this.log('_extendDebugger: node code inject: failed, try again...');
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

		this.log(`_startInitialize: _startInitialize(${stopped})`);

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
			this.log(`_startInitialize: got break on entry event after ${n} retries`);
			if (this._nodeProcessId <= 0) {
				// if we haven't gotten a process pid so far, we try it again
				this._node.command('evaluate', { expression: 'process.pid', global: true }, (resp: NodeV8Response) => {
					if (resp.success) {
						this.log('_startInitialize: 2nd retrieve node pid: OK');
						this._nodeProcessId = parseInt(resp.body.value);
					}
					this._middleInitialize(stopped);
				});
			} else {
				this._middleInitialize(stopped);
			}
		} else {
			this.log(`_startInitialize: no entry event after ${n} retries; give up`);

			this._gotEntryEvent = true;	// we pretend to got one so that no ENTRY_REASON event will show up later...

			this._node.command('frame', null, (resp: NodeV8Response) => {
				if (resp.success) {
					this.cacheRefs(resp);
					let s = this.getValueFromCache(resp.body.script);
					this.rememberEntryLocation(s.name, resp.body.line, resp.body.column);
				}

				this._middleInitialize(stopped);
			});
		}
	}

	private _middleInitialize(stopped: boolean): void {
		// request UI to send breakpoints
		this.log('_middleInitialize: -> fire initialize event');
		this.sendEvent(new InitializedEvent());

		// in attach-mode we don't know whether the debuggee has been launched in 'stop on entry' mode
		// so we use the stopped state of the VM
		if (this._attachMode) {
			this.log(`_middleInitialize: in attach mode we guess stopOnEntry flag to be "${stopped}"`);
			this._stopOnEntry = stopped;
		}

		if (this._stopOnEntry) {
			// user has requested 'stop on entry' so send out a stop-on-entry
			this.log('_middleInitialize: -> fire stop-on-entry event');
			this.sendEvent(new StoppedEvent(NodeDebugSession.ENTRY_REASON, NodeDebugSession.DUMMY_THREAD_ID));
		}
		else {
			// since we are stopped but UI doesn't know about this, remember that we continue later in finishInitialize()
			this.log('_middleInitialize: remember to do a "Continue" later');
			this._needContinue = true;
		}
	}

	private _finishInitialize(): void {
		if (this._needContinue) {
			this._needContinue = false;
			this.log('_finishInitialize: do a "Continue"');
			this._node.command('continue', null, (nodeResponse) => { });
		}
		if (this._needBreakpointEvent) {
			this._needBreakpointEvent = false;
			this.log('_finishInitialize: fire a breakpoint event');
			this.sendEvent(new StoppedEvent(NodeDebugSession.BREAKPOINT_REASON, NodeDebugSession.DUMMY_THREAD_ID));
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
	 * we rely on the generic implementation from debugSession but we override 'v8Protocol.shutdown'
	 * to disconnect from node and kill node & subprocesses
	 */
	public shutdown(): void {

		this.log('shutdown: shutdown');

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
					this.log('shutdown: kill tree');
					Terminal.killTree(pid).then(() => {
						this._terminalProcess = null;
						this._nodeProcessId = -1;
						this.log('shutdown: calling super shutdown 1');
						super.shutdown();
					}).catch((error) => {
						this._terminalProcess = null;
						this._nodeProcessId = -1;
						this.log('shutdown: calling super shutdown 2');
						super.shutdown();
					});
					return;
				}
			}

			this.log('shutdown: calling super shutdown 3');
			super.shutdown();
		}
	}

	//--- set breakpoints request ---------------------------------------------------------------------------------------------

	protected setBreakPointsRequest(response: DebugProtocol.SetBreakpointsResponse, args: DebugProtocol.SetBreakpointsArguments): void {

		let sourcemap = false;

		const source = args.source;
		const clientLines = args.lines;

		// convert line numbers from client
		const lbs = new Array<InternalBreakpoint>(clientLines.length);
		for (let i = 0; i < clientLines.length; i++) {
			lbs[i] = {
				actualLine: clientLines[i],
				actualColumn: this.convertDebuggerColumnToClient(1),	// hardcoded for now
				line: this.convertClientLineToDebugger(clientLines[i]),
				column: 0,	// hardcoded for now
				verified: false,
				ignore: false
			};
		}

		let scriptId = -1;
		let path: string = null;

		// we assume that only one of the source attributes is specified.
		if (source.path) {
			path = this.convertClientPathToDebugger(source.path);
			// resolve the path to a real path (resolve symbolic links)
			//path = PathUtilities.RealPath(path, _realPathMap);

			let p: string = null;
			if (this._sourceMaps) {
				p = this._sourceMaps.MapPathFromSource(path);
			}
			if (p) {
				sourcemap = true;
				// source map line numbers
				for (let i = 0; i < lbs.length; i++) {
					let pp = path;
					const mr = this._sourceMaps.MapFromSource(pp, lbs[i].line, lbs[i].column);
					if (mr) {
						pp = mr.path;
						lbs[i].line = mr.line;
						lbs[i].column = mr.column;
					} else {
						// we couldn't map this breakpoint -> do not try to set it
						lbs[i].ignore = true;
					}
					if (pp !== p) {
						// console.error(`setBreakPointsRequest: sourceMap limitation ${pp}`);
					}
				}
				path = p;
			}
			else if (!NodeDebugSession.isJavaScript(path)) {
				// ignore all breakpoints for this source
				for (let lb of lbs) {
					lb.ignore = true;
				}
			}
			this._clearAllBreakpoints(response, path, -1, lbs, sourcemap);
			return;
		}

		if (source.name) {
			this.findModule(source.name, (id: number) => {
				if (id >= 0) {
					scriptId = id;
					this._clearAllBreakpoints(response, null, scriptId, lbs, sourcemap);
					return;
				} else {
					this.sendErrorResponse(response, 2019, "internal module {_module} not found", { _module: source.name });
					return;
				}
			});
			return;
		}

		if (source.sourceReference > 0) {
			const srcSource = this._sourceHandles.get(source.sourceReference);
			if (srcSource.scriptId) {
				this._clearAllBreakpoints(response, null, srcSource.scriptId, lbs, sourcemap);
				return;
			}
		}

		this.sendErrorResponse(response, 2012, "no valid source specified", null, ErrorDestination.Telemetry);
	}

	/*
	 * Phase 2 of setBreakpointsRequest: clear all breakpoints of a given file
	 */
	private _clearAllBreakpoints(response: DebugProtocol.SetBreakpointsResponse, path: string, scriptId: number, lbs: InternalBreakpoint[], sourcemap: boolean): void {

		// clear all existing breakpoints for the given path or script ID
		this._node.command('listbreakpoints', null, (nodeResponse: NodeV8Response) => {

			if (nodeResponse.success) {
				const toClear = new Array<number>();

				// try to match breakpoints
				for (let breakpoint of nodeResponse.body.breakpoints) {
					const type: string = breakpoint.type;
					switch (type) {
					case 'scriptId':
						const script_id: number = breakpoint.script_id;
						if (script_id === scriptId) {
							toClear.push(breakpoint.number);
						}
						break;
					case 'scriptName':
						const script_name: string = breakpoint.script_name;
						if (script_name === path) {
							toClear.push(breakpoint.number);
						}
						break;
					}
				}

				this._clearBreakpoints(toClear, 0, () => {
					this._finishSetBreakpoints(response, path, scriptId, lbs, sourcemap);
				});

			} else {
				this.sendNodeResponse(response, nodeResponse);
			}

		});
	}

	/**
	 * Recursive function for deleting node breakpoints.
	 */
	private _clearBreakpoints(ids: Array<number>, ix: number, done: () => void) : void {

		if (ids.length == 0) {
			done();
			return;
		}

		this._node.command('clearbreakpoint', { breakpoint: ids[ix] }, (nodeResponse: NodeV8Response) => {
			if (!nodeResponse.success) {
				// we ignore errors for now
				// console.error('clearbreakpoint error: ' + rr.message);
			}
			if (ix+1 < ids.length) {
				setImmediate(() => {
					// recurse
					this._clearBreakpoints(ids, ix+1, done);
				});
			} else {
				done();
			}
		});
	}

	/*
	 * Finish the setBreakpointsRequest: set the breakpooints and send the verification response back to client
	 */
	private _finishSetBreakpoints(response: DebugProtocol.SetBreakpointsResponse, path: string, scriptId: number, lbs: InternalBreakpoint[], sourcemap: boolean): void {

		this._setBreakpoints(0, path, scriptId, lbs, sourcemap, () => {

			const breakpoints = new Array<Breakpoint>();
			for (let lb of lbs) {
				breakpoints.push(new Breakpoint(lb.verified, lb.actualLine, lb.actualColumn));
			}

			response.body = {
				breakpoints: breakpoints
			};
			this.sendResponse(response);
		});
	}

	/**
	 * Recursive function for setting node breakpoints.
	 */
	private _setBreakpoints(ix: number, path: string, scriptId: number, lbs: InternalBreakpoint[], sourcemap: boolean, done: () => void) : void {

		if (lbs.length == 0) {	// nothing to do
			done();
			return;
		}

		this._robustSetBreakPoint(scriptId, path, lbs[ix], (success: boolean, actualLine: number, actualColumn: number) => {

			if (success) {
				// breakpoint successfully set and we've got an actual location

				if (sourcemap) {
					// this source uses a sourcemap so we have to map locations back
					if (!this._lazy) {	// only if not in lazy mode we try to map actual positions back
						// map adjusted js breakpoints back to source language
						if (path && this._sourceMaps) {
							const mr = this._sourceMaps.MapToSource(path, actualLine, actualColumn);
							if (mr) {
								actualLine = mr.line;
								actualColumn = mr.column;
							}
						}
					}
				}
				lbs[ix].verified = true;
				lbs[ix].actualLine = this.convertDebuggerLineToClient(actualLine);
				lbs[ix].actualColumn = this.convertDebuggerColumnToClient(actualColumn);
			}

			// nasty corner case: since we ignore the break-on-entry event we have to make sure that we
			// stop in the entry point line if the user has an explicit breakpoint there.
			// For this we check here whether a breakpoint is at the same location as the "break-on-entry" location.
			// If yes, then we plan for hitting the breakpoint instead of "continue" over it!

			if (!this._stopOnEntry && this._entryPath === path) {	// only relevant if we do not stop on entry and have a matching file
				if (this._entryLine === lbs[ix].line && this._entryColumn === lbs[ix].column) {
					// we do not have to "continue" but we have to generate a stopped event instead
					this._needContinue = false;
					this._needBreakpointEvent = true;
					this.log('_setBreakpoints: remember to fire a breakpoint event later');
				}
			}

			if (ix+1 < lbs.length) {
				setImmediate(() => {
					// recurse
					this._setBreakpoints(ix+1, path, scriptId, lbs, sourcemap, done);
				});
			} else {
				done();
			}
		});
	}

	/*
	 * register a single breakpoint with node and retry if it fails due to drive letter casing (on Windows).
	 * On success the actual line and column is returned.
	 */
	private _robustSetBreakPoint(scriptId: number, path: string, lb: InternalBreakpoint, done: (success: boolean, actualLine?: number, actualColumn?: number) => void): void {

		if (lb.ignore) {
			// ignore this breakpoint because it couldn't be source mapped successfully
			done(false);
			return;
		}

		this._setBreakpoint(scriptId, path, lb, (success: boolean, actualLine: number, actualColumn: number) => {

			if (success) {
				done(true, actualLine, actualColumn);
				return;
			}

			// failure -> guess: mismatch of drive letter caseing
			const root = PathUtils.getPathRoot(path);
			if (root && root.length === 3) { // root contains a drive letter
				path = path.substring(0, 1).toUpperCase() + path.substring(1);
				this._setBreakpoint(scriptId, path, lb, (success: boolean, actualLine, actualColumn) => {
					if (success) {
						done(true, actualLine, actualColumn);
					} else {
						done(false);
					}
				});
			} else {
				done(false);
			}
		});
	}

	/*
	 * register a single breakpoint with node.
	 */
	private _setBreakpoint(scriptId: number, path: string, lb: InternalBreakpoint, done: (success: boolean, actualLine?: number, actualColumn?: number) => void): void {

		let line = lb.line;
		let column = lb.column;

		if (line === 0) {
			column += NodeDebugSession.FIRST_LINE_OFFSET;
		}

		let a: any;
		if (scriptId > 0) {
			a = { type: 'scriptId', target: scriptId, line: line, column: column };
		} else {
			a = { type: 'script', target: path, line: line, column: column };
		}

		this._node.command('setbreakpoint', a, (resp: NodeV8Response) => {

			if (resp.success) {
				let actualLine = lb.line;
				let actualColumn = lb.column;

				const al = resp.body.breakpoint;
				if (al.length > 0) {
					actualLine = al[0].line;
					actualColumn = al[0].column;

					if (actualLine === 0) {
						actualColumn -= NodeDebugSession.FIRST_LINE_OFFSET;
						if (actualColumn < 0)
							actualColumn = 0;
					}

					if (actualLine !== lb.line) {
						// console.error(`setbreakpoint: ${l} !== ${actualLine}`);
					}
				}
				done(true, actualLine, actualColumn);
				return;
			}

			done(false);
			return;
		});
	}

	//--- set exception request -----------------------------------------------------------------------------------------------

	protected setExceptionBreakPointsRequest(response: DebugProtocol.SetExceptionBreakpointsResponse, args: DebugProtocol.SetExceptionBreakpointsArguments): void {

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
									this._finishInitialize();
								} else {
									this.sendNodeResponse(response, nodeResponse3);
								}
							});
						} else {
							this.sendResponse(response);	// send response for setexceptionbreak
							this._finishInitialize();
						}
					} else {
						this.sendNodeResponse(response, nodeResponse2);
					}
				});
			} else {
				this.sendNodeResponse(response, nodeResponse1);
			}
		});
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
		const maxLevels = args.levels;

		if (threadReference !== NodeDebugSession.DUMMY_THREAD_ID) {
			this.sendErrorResponse(response, 2014, "unexpected thread reference {_thread}", { _thread: threadReference }, ErrorDestination.Telemetry);
			return;
		}

		const stackframes = new Array<StackFrame>();

		this._getStackFrames(stackframes, 0, maxLevels, () => {
			response.body = {
				stackFrames: stackframes
			};
			this.sendResponse(response);
		} );
	}

	/**
	 * Recursive function for retrieving stackframes and their scopes in top to bottom order.
	 */
	private _getStackFrames(stackframes: Array<StackFrame>, frameIx: number, maxLevels: number, done: () => void): void {

		this._node.command('backtrace', { fromFrame: frameIx, toFrame: frameIx+1 }, (backtraceResponse: NodeV8Response) => {

			if (backtraceResponse.success) {

				this.cacheRefs(backtraceResponse);

				let totalFrames = backtraceResponse.body.totalFrames;
				if (maxLevels > 0 && totalFrames > maxLevels) {
					totalFrames = maxLevels;
				}

				if (totalFrames === 0) {
					// no stack frames (probably because a 'pause' stops node in non-javascript code)
					done();
					return;
				}

				const frame = backtraceResponse.body.frames[0];

				// resolve some refs
				this.getValues([ frame.script, frame.func, frame.receiver ], () => {

					let line: number = frame.line;
					let column: number = frame.column;

					let src: Source = null;
					const script_val = this.getValueFromCache(frame.script);
					if (script_val) {
						let name = script_val.name;
						if (name && Path.isAbsolute(name)) {
							// try to map the real path back to a symbolic link
							// string path = PathUtilities.MapResolvedBack(name, _realPathMap);
							let path = name;
							name = Path.basename(path);

							// workaround for column being off in the first line (because of a wrapped anonymous function)
							if (line === 0) {
								column -= NodeDebugSession.FIRST_LINE_OFFSET;
								if (column < 0)
									column = 0;
							}

							// source mapping
							if (this._sourceMaps) {
								const mr = this._sourceMaps.MapToSource(path, line, column);
								if (mr) {
									path = mr.path;
									line = mr.line;
									column = mr.column;
								}
							}

							src = new Source(name, this.convertDebuggerPathToClient(path));
						}

						if (src === null) {
							const script_id:number = script_val.id;
							if (script_id >= 0) {
								const sourceHandle = this._sourceHandles.create(new SourceSource(script_id));
								src = new Source(name, null, sourceHandle);
							}
						}
					}

					let func_name: string;
					const func_val = this.getValueFromCache(frame.func);
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
					const sf = new StackFrame(frameReference, func_name, src, this.convertDebuggerLineToClient(line), this.convertDebuggerColumnToClient(column));

					stackframes.push(sf);

					if (frameIx+1 < totalFrames) {
						// recurse
						setImmediate(() => {
							this._getStackFrames(stackframes, frameIx+1, maxLevels, done);
						});
					} else {
						// we are done
						done();
					}
				});

			} else {
				// error backtrace request
				// stackframes.push(new StackFrame(frameIx, NodeDebugSession.LARGE_DATASTRUCTURE_TIMEOUT, null, 0, 0, []));
				done();
			}
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
		const frameThis = this.getValueFromCache(frame.receiver);

		this._node.command('scopes', { frame_index: frameIx, frameNumber: frameIx }, (scopesResponse: NodeV8Response) => {

			if (scopesResponse.success) {

				this.cacheRefs(scopesResponse);

				const scopes = new Array<Scope>();

				// exception scope
				if (frameIx === 0 && this._exception) {
					scopes.push(new Scope("Exception", this._variableHandles.create(new PropertyExpander(this._exception))));
				}

				this._getScope(scopes, 0, scopesResponse.body.scopes, frameThis, () => {
					response.body = {
						scopes: scopes
					};
					this.sendResponse(response);
				});

			} else {
				response.body = {
					scopes: []
				};
				this.sendResponse(response);
			}
		});
	}

	/**
	 * Recursive function for creating scopes in top to bottom order.
	 */
	private _getScope(scopesResult: Array<Scope>, scopeIx: number, scopes: any[], this_val: any, done: () => void) {

		const scope = scopes[scopeIx];
		const type: number = scope.type;
		const scopeName = (type >= 0 && type < NodeDebugSession.SCOPE_NAMES.length) ? NodeDebugSession.SCOPE_NAMES[type] : ("Unknown Scope:" + type);
		const extra = type === 1 ? this_val : null;
		const expensive = type === 0;

		this.getValue(scope.object, (scopeObject: any) => {
			if (scopeObject) {
				scopesResult.push(new Scope(scopeName, this._variableHandles.create(new PropertyExpander(scopeObject, extra)), expensive));
			}
			if (scopeIx+1 < scopes.length) {
				setImmediate(() => {
					// recurse
					this._getScope(scopesResult, scopeIx+1, scopes, this_val, done);
				});
			} else {
				done();
			}
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
				this.resolveToCache(needLookup, () => {
					// build variables
					this._addVariables(variables, selectedProperties, 0, done);
				});
				return;
			}
		}
		done();
	}

	/**
	 * Recursive function for creating variables for the properties.
	 */
	private _addVariables(variables: Array<Variable>, properties: Array<any>, ix: number, done: () => void) {

		const property = properties[ix];
		const val = this.getValueFromCache(property);

		let name = property.name;
		if (typeof name == 'number') {
			name = `[${name}]`;
		}

		this._addVariable(variables, name, val, () => {
			if (ix+1 < properties.length) {
				setImmediate(() => {
					// recurse
					this._addVariables(variables, properties, ix+1, done);
				});
			} else {
				done();
			}
		});
	}

	private _addArrayElements(variables: Array<Variable>, array_ref: number, start: number, end: number, done: (message?: string) => void): void {
		this._node.command('vscode_range', { handle: array_ref, from: start, to: end }, (resp: NodeV8Response) => {
			if (resp.success) {
				this._addArrayElement(variables, start, resp.body.result, 0, done);
			} else {
				done(resp.message);
			}
		});
	}

	/**
	 * Recursive function for creating variables for the given array items.
	 */
	private _addArrayElement(variables: Array<Variable>, start: number, items: Array<any>, ix: number, done: () => void) {
		const name = `[${start+ix}]`;
		this._createVariable(name, items[ix], (v: Variable) => {
			variables.push(v);
			if (ix+1 < items.length) {
				setImmediate(() => {
					// recurse
					this._addArrayElement(variables, start, items, ix+1, done);
				});
			} else {
				done();
			}
		});
	}

	public _addVariable(variables: Array<Variable>, name: string, val: any, done: () => void): void {
		this._createVariable(name, val, (result: Variable) => {
			if (result) {
				variables.push(result);
			}
			done();
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
									this.getValue(l, (length_val: any) => {
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
						this.getValue(val.constructorFunction, (constructor_val) => {
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
				this._stopped();
				this._lastStoppedEvent = new StoppedEvent(NodeDebugSession.USER_REQUEST_REASON, NodeDebugSession.DUMMY_THREAD_ID);
				this.sendResponse(response);
				this.sendEvent(this._lastStoppedEvent);
			} else {
				this.sendNodeResponse(response, nodeResponse);
			}
        });
	}

	//--- continue request ----------------------------------------------------------------------------------------------------

	protected continueRequest(response: DebugProtocol.ContinueResponse, args: DebugProtocol.ContinueArguments): void {
    	this._node.command('continue', null, (nodeResponse) => {
			this.sendNodeResponse(response, nodeResponse);
        });
	}

	//--- step request --------------------------------------------------------------------------------------------------------

	protected stepInRequest(response: DebugProtocol.StepInResponse, args: DebugProtocol.StepInArguments) : void {
    	this._node.command('continue', { stepaction: 'in' }, (nodeResponse) => {
			this.sendNodeResponse(response, nodeResponse);
        });
	}

	protected stepOutRequest(response: DebugProtocol.StepOutResponse, args: DebugProtocol.StepOutArguments) : void {
    	this._node.command('continue', { stepaction: 'out' }, (nodeResponse) => {
			this.sendNodeResponse(response, nodeResponse);
        });
	}

	protected nextRequest(response: DebugProtocol.NextResponse, args: DebugProtocol.NextArguments): void {
    	this._node.command('continue', { stepaction: 'next' }, (nodeResponse) => {
			this.sendNodeResponse(response, nodeResponse);
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

		if (srcSource.scriptId) {

			let source = this._scriptSources.get(srcSource.scriptId);
			if (source) {
				response.body = {
					content: source
				};
				this.sendResponse(response);
			} else {
				this._node.command('scripts', { types: 1+2+4, includeSource: true, ids: [ srcSource.scriptId ] }, (nodeResponse: NodeV8Response) => {
					if (nodeResponse.success) {
						source = nodeResponse.body[0].source;
					} else {
						source = "<source not found>";
					}
					this._scriptSources.set(srcSource.scriptId, source);
					response.body = {
						content: source
					};
					this.sendResponse(response);
				});
			}

		} else {
			this.sendErrorResponse(response, 9999, "sourceRequest error");
		}
	}

	//---- private helpers ----------------------------------------------------------------------------------------------------

	private sendNodeResponse(response: DebugProtocol.Response, nodeResponse: NodeV8Response): void {
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

	private cacheRefs(response: NodeV8Response): void {
		const refs = response.refs;
		for (let r of refs) {
			this.cache(r.handle, r);
		}
	}

	private cache(handle: number, o: any): void {
		this._refCache[handle] = o;
	}

	private getValues(containers: any[], done: () => void): void {

		const handles = [];
		for (let container of containers) {
			handles.push(container.ref);
		}

		this.resolveToCache(handles, () => {
			done();
		});
	}

	private getValue(container: any, done: (result: any) => void): void {
		if (container) {
			const handle = container.ref;
			this.resolveToCache([ handle ], () => {
				const value = this._refCache[handle];
				done(value);
			});
		} else {
			done(null);
		}
	}

	private getValueFromCache(container: any): any {
		const handle = container.ref;
		const value = this._refCache[handle];
		if (value)
			return value;
		// console.error("ref not found cache");
		return null;
	}

	private resolveToCache(handles: number[], done: () => void): void {

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
					this.cacheRefs(resp);

					for (let key in resp.body) {
						const obj = resp.body[key];
						const handle: number = obj.handle;
						this.cache(handle, obj);
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
							this.cache(handle, val);
						}
					}
				}
				done();
			});
		} else {
			done();
		}
	}

	private createStoppedEvent(body: any): DebugProtocol.StoppedEvent {

		// workaround: load sourcemap for this location to populate cache
		if (this._sourceMaps) {
			const path = body.script.name;
			if (path) {
				let mr = this._sourceMaps.MapToSource(path, 0, 0);
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
					const path = body.script.name;
					const line = body.sourceLine;
					const column = body.sourceColumn;
					this.rememberEntryLocation(path, line, column);
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

	private rememberEntryLocation(path: string, line: number, column: number): void {
		if (path) {
			this._entryPath = path;
			this._entryLine = line;
			this._entryColumn = column;
			if (line === 0) {
				this._entryColumn -= NodeDebugSession.FIRST_LINE_OFFSET;
				if (this._entryColumn < 0)
					this._entryColumn = 0;
			}
			this._gotEntryEvent = true;
		}
	}

	private findModule(name: string, cb: (id: number) => void): void {
		this._node.command('scripts', { types: 1 + 2 + 4, filter: name }, (resp: NodeV8Response) => {
			if (resp.success) {
				if (resp.body.length > 0) {
					cb(resp.body[0].id);
					return;
				}
			}
			cb(-1);
		});
	}

	//---- private static ---------------------------------------------------------------

	private log(message: string) {
		if (NodeDebugSession.TRACE) {
			const s = process.pid + ": " + message + '\r\n';
			//console.error(s);
			this.sendEvent(new OutputEvent(s, 'stderr'));
		}
	}

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