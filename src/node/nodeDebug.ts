/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import {
	LoggingDebugSession, DebugSession, Logger, logger,
	Thread, Source, StackFrame, Scope, Variable, Breakpoint,
	TerminatedEvent, InitializedEvent, StoppedEvent, OutputEvent, LoadedSourceEvent,
	Handles, ErrorDestination, CapabilitiesEvent
} from 'vscode-debugadapter';
import {DebugProtocol} from 'vscode-debugprotocol';

import {
	NodeV8Protocol, NodeV8Event, NodeV8Response,
	V8SetBreakpointArgs, V8SetVariableValueArgs, V8RestartFrameArgs, V8BacktraceArgs,
	V8ScopeResponse, V8EvaluateResponse, V8FrameResponse,
	V8EventBody, V8BreakEventBody, V8ExceptionEventBody,
	V8Ref, V8Handle, V8Property, V8Object, V8Simple, V8Function, V8Frame, V8Scope, V8Script
} from './nodeV8Protocol';
import {ISourceMaps, SourceMaps, SourceMap} from './sourceMaps';
import * as PathUtils from './pathUtilities';
import * as WSL from './wslSupport';
import * as CP from 'child_process';
import * as Net from 'net';
import * as URL from 'url';
import * as Path from 'path';
import * as FS from 'fs';
import * as nls from 'vscode-nls';

let localize = nls.loadMessageBundle();

type FilterType = 'named' | 'indexed' | 'all';

export interface VariableContainer {
	Expand(session: NodeDebugSession, filter: FilterType, start: number | undefined, count: number | undefined): Promise<Variable[]>;
	SetValue(session: NodeDebugSession, name: string, value: string): Promise<Variable>;
}

type ExpanderFunction = (start: number, count: number) => Promise<Variable[]>;

export class Expander implements VariableContainer {

	public static SET_VALUE_ERROR = localize('setVariable.error', "Setting value not supported");

	private _expanderFunction : ExpanderFunction;

	public constructor(func: ExpanderFunction) {
		this._expanderFunction = func;
	}

	public Expand(session: NodeDebugSession, filter: string, start: number, count: number) : Promise<Variable[]> {
		return this._expanderFunction(start, count);
	}

	public SetValue(session: NodeDebugSession, name: string, value: string) : Promise<Variable> {
		return Promise.reject(new Error(Expander.SET_VALUE_ERROR));
	}
}

export class PropertyContainer implements VariableContainer {

	private _evalName: string | undefined;
	private _object: V8Object;
	private _this: V8Object | undefined;

	public constructor(evalName: string | undefined, obj: V8Object, ths?: V8Object) {
		this._evalName = evalName;
		this._object = obj;
		this._this = ths;
	}

	public Expand(session: NodeDebugSession, filter: FilterType, start: number, count: number) : Promise<Variable[]> {

		if (filter === 'named') {
			return session._createProperties(this._evalName, this._object, 'named').then(variables => {
				if (this._this) {
					return session._createVariable(this._evalName, 'this', this._this).then(variable => {
						if (variable) {
							variables.push(variable);
						}
						return variables;
					});
				} else {
					return variables;
				}
			});
		}

		if (typeof start === 'number' && typeof count === 'number') {
			return session._createProperties(this._evalName, this._object, 'indexed', start, count);
		} else {
			return session._createProperties(this._evalName, this._object, 'all').then(variables => {
				if (this._this) {
					return session._createVariable(this._evalName, 'this', this._this).then(variable => {
						if (variable) {
							variables.push(variable);
						}
						return variables;
					});
				} else {
					return variables;
				}
			});
		}
	}

	public SetValue(session: NodeDebugSession, name: string, value: string) : Promise<Variable> {
		return session._setPropertyValue(this._object.handle, name, value);
	}
}

export class SetMapContainer implements VariableContainer {

	private _evalName: string | undefined;
	private _object: V8Object;

	public constructor(evalName: string | undefined, obj: V8Object) {
		this._evalName = evalName;
		this._object = obj;
	}

	public Expand(session: NodeDebugSession, filter: FilterType, start: number, count: number) : Promise<Variable[]> {

		if (filter === 'named') {
			return session._createSetMapProperties(this._evalName, this._object);
		}

		if (this._object.type === 'set') {
			return session._createSetElements(this._object, start, count);
		} else {
			return session._createMapElements(this._object, start, count);
		}
	}

	public SetValue(session: NodeDebugSession, name: string, value: string) : Promise<Variable> {
		return Promise.reject(new Error(Expander.SET_VALUE_ERROR));
	}
}

export class ScopeContainer implements VariableContainer {

	private _frame: number;
	private _scope: number;
	private _object: V8Object;
	private _this: V8Object | undefined;

	public constructor(scope: V8Scope, obj: V8Object, ths?: V8Object) {
		this._frame = scope.frameIndex;
		this._scope = scope.index;
		this._object = obj;
		this._this = ths;
	}

	public Expand(session: NodeDebugSession, filter: FilterType, start: number, count: number) : Promise<Variable[]> {
		return session._createProperties('', this._object, filter).then(variables => {
			if (this._this) {
				return session._createVariable('', 'this', this._this).then(variable => {
					if (variable) {
						variables.push(variable);
					}
					return variables;
				});
			} else {
				return variables;
			}
		});
	}

	public SetValue(session: NodeDebugSession, name: string, value: string) : Promise<Variable> {
		return session._setVariableValue(this._frame, this._scope, name, value);
	}
}

type ReasonType = 'step' | 'breakpoint' | 'exception' | 'pause' | 'entry' | 'debugger_statement' | 'frame_entry';

class Script {
	contents: string;
	sourceMap: SourceMap;

	constructor(script: V8Script) {
		this.contents = script.source;
	}
}

type HitterFunction = (hitCount: number) => boolean;

class InternalSourceBreakpoint {

	line: number;
	orgLine: number;
	column: number;
	orgColumn: number;
	condition: string | undefined;
	hitCount: number;
	hitter: HitterFunction | undefined;
	verificationMessage: string;

	constructor(line: number, column: number = 0, condition?: string, logMessage?: string, hitter?: HitterFunction) {
		this.line = this.orgLine = line;
		this.column = this.orgColumn = column;

		if (logMessage) {
			this.condition = logMessageToExpression(logMessage);
			if (condition) {
				this.condition = `(${condition}) && ${this.condition}`;
			}
		} else if (condition) {
			this.condition = condition;
		}

		this.hitCount = 0;
		this.hitter = hitter;
	}
}

/**
 * A SourceSource represents the source contents of an internal module or of a source map with inlined contents.
 */
class SourceSource {
	scriptId: number;	// if 0 then source contains the file contents of a source map, otherwise a scriptID.
	source: string | undefined;

	constructor(sid: number, content?: string) {
		this.scriptId = sid;
		this.source = content;
	}
}

/**
 * Arguments shared between Launch and Attach requests.
 */
interface CommonArguments {
	/** comma separated list of trace selectors. Supported:
	 * 'all': all
	 * 'la': launch/attach
	 * 'ls': load scripts
	 * 'bp': breakpoints
	 * 'sm': source maps
	 * 'va': data structure access
	 * 'ss': smart steps
	 * 'rc': ref caching
	 * */
	trace?: boolean | string;
	/** The debug port to attach to. */
	port: number;
	/** The TCP/IP address of the port (remote addresses only supported for node >= 5.0). */
	address?: string;
	/** Retry for this number of milliseconds to connect to the node runtime. */
	timeout?: number;
	/** Automatically stop target after launch. If not specified, target does not stop. */
	stopOnEntry?: boolean;
	/** Configure source maps. By default source maps are enabled (since v1.9.11). */
	sourceMaps?: boolean;
	/** obsolete: Where to look for the generated code. Only used if sourceMaps is true. */
	outDir?: string;
	/** output files glob patterns */
	outFiles?: string[];
	/** Try to automatically step over uninteresting source. */
	smartStep?: boolean;
	/** automatically skip these files. */
	skipFiles?: string[];
	/** Request frontend to restart session on termination. */
	restart?: boolean;
	/** Node's root directory. */
	remoteRoot?: string;
	/** VS Code's root directory. */
	localRoot?: string;

	// unofficial flags

	/** Step back supported. */
	stepBack?: boolean;
	/** Control mapping of node.js scripts to files on disk. */
	mapToFilesOnDisk?: boolean;

	// internal attributes

	/** Debug session ID */
	__sessionId: string;
}

type ConsoleType = 'internalConsole' | 'integratedTerminal' | 'externalTerminal';

/**
 * This interface should always match the schema found in the node-debug extension manifest.
 */
interface LaunchRequestArguments extends DebugProtocol.LaunchRequestArguments, CommonArguments {
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
	env?: { [key: string]: string | null; };
	/** Optional path to .env file. */
	envFile?: string;
	/** Deprecated: if true launch the target in an external console. */
	externalConsole?: boolean;
	/** Where to launch the debug target. */
	console?: ConsoleType;
	/** Use Windows Subsystem Linux */
	useWSL?: boolean;
}

/**
 * This interface should always match the schema found in the node-debug extension manifest.
 */
interface AttachRequestArguments extends DebugProtocol.AttachRequestArguments, CommonArguments {

	// currently nothing is 'attach' specific
}


export class NodeDebugSession extends LoggingDebugSession {

	private static MAX_STRING_LENGTH = 10000;	// max string size to return in 'evaluate' request
	private static MAX_JSON_LENGTH = 500000;	// max size of stringified object to return in 'evaluate' request

	private static NODE_TERMINATION_POLL_INTERVAL = 3000;
	private static ATTACH_TIMEOUT = 10000;
	private static RUNINTERMINAL_TIMEOUT = 5000;

	private static PREVIEW_PROPERTIES = 3;			// maximum number of properties to show in object/array preview
	private static PREVIEW_MAX_STRING_LENGTH = 50;	// truncate long strings for object/array preview

	private static NODE = 'node';
	private static DUMMY_THREAD_ID = 1;
	private static DUMMY_THREAD_NAME = 'Node';
	private static FIRST_LINE_OFFSET = 62;
	private static PROTO = '__proto__';
	private static DEBUG_INJECTION = 'debugInjection.js';
	private static NODE_INTERNALS = '<node_internals>';
	private static NODE_INTERNALS_PREFIX = /^<node_internals>[/\\]/;
	private static NODE_INTERNALS_VM = /^<node_internals>[/\\]VM([0-9]+)/;
	private static JS_EXTENSIONS = [ '.js', '.es6', '.jsx', '.mjs' ];

	private static NODE_SHEBANG_MATCHER = new RegExp('#! */usr/bin/env +node');
	private static LONG_STRING_MATCHER = /\.\.\. \(length: [0-9]+\)$/;
	private static HITCOUNT_MATCHER = /(>|>=|=|==|<|<=|%)?\s*([0-9]+)/;
	private static PROPERTY_NAME_MATCHER = /^[$_\w][$_\w0-9]*$/;

	// tracing
	private _trace: string[] | undefined;
	private _traceAll = false;

	// options
	private _tryToInjectExtension = true;
	private _skipRejects = false;			// do not stop on rejected promises
	private _maxVariablesPerScope = 100;	// only load this many variables for a scope
	private _smartStep = false;				// try to automatically step over uninteresting source
	private _skipFiles: string[] | undefined;	// skip glob patterns
	private _mapToFilesOnDisk = true; 		// by default try to map node.js scripts to files on disk
	private _compareContents = true;		// by default verify that script contents is same as file contents
	private _supportsRunInTerminalRequest = false;

	// session state
	private _node: NodeV8Protocol;
	private _attachSuccessful: boolean;
	private _processId: number = -1;						// pid of the program launched
	private _nodeProcessId: number = -1; 					// pid of the node runtime
	private _isWSL = false;
	private _functionBreakpoints = new Array<number>();		// node function breakpoint ids
	private _scripts = new Map<number, Promise<Script>>();	// script cache
	private _files = new Map<string, Promise<string>>();	// file cache
	private _scriptId2Handle = new Map<number, number>();
	private _inlinedContentHandle = new Map<string, number>();
	private _modifiedSources = new Set<string>();			// track edited files
	private _hitCounts = new Map<number, InternalSourceBreakpoint>();		// breakpoint ID -> ignore count

	// session configurations
	private _noDebug = false;
	private _attachMode = false;
	private _localRoot: string | undefined;
	private _remoteRoot: string | undefined;
	private _restartMode = false;
	private _port: number | undefined;
	private _sourceMaps: ISourceMaps;
	private _console: ConsoleType = 'internalConsole';
	private _stopOnEntry: boolean;
	private _stepBack = false;

	// state valid between stop events
	public _variableHandles = new Handles<VariableContainer>();
	private _frameHandles = new Handles<V8Frame>();
	private _sourceHandles = new Handles<SourceSource>();
	private _refCache = new Map<number, V8Handle>();

	// internal state
	private _isTerminated: boolean;
	private _inShutdown: boolean;
	private _pollForNodeProcess = false;
	private _exception: V8ExceptionEventBody | undefined;
	private _restartFramePending: boolean;
	private _stoppedReason: string;
	private _nodeInjectionAvailable = false;
	private _needContinue: boolean;
	private _needBreakpointEvent: boolean;
	private _needDebuggerEvent: boolean;
	private _gotEntryEvent: boolean;
	private _gotDebuggerEvent = false;
	private _entryPath: string;
	private _entryLine: number;		// entry line in *.js file (not in the source file)
	private _entryColumn: number;	// entry column in *.js file (not in the source file)
	private _smartStepCount = 0;
	private _catchRejects = false;
	private _disableSkipFiles = false;

	public constructor() {
		super('node-debug.txt');

		// this debugger uses zero-based lines and columns which is the default
		// so the following two calls are not really necessary.
		this.setDebuggerLinesStartAt1(false);
		this.setDebuggerColumnsStartAt1(false);

		this._node = new NodeV8Protocol(response => {
			// if request successful, cache alls refs
			if (response.success && response.refs) {
				const oldSize = this._refCache.size;
				for (let r of response.refs) {
					this._cache(r.handle, r);
				}
				if (this._refCache.size !== oldSize) {
					this.log('rc', `NodeV8Protocol hook: ref cache size: ${this._refCache.size}`);
				}
			}
		});

		this._node.on('break', (event: NodeV8Event) => {
			this._stopped('break');
			this._handleNodeBreakEvent(<V8BreakEventBody>event.body);
		});

		this._node.on('exception', (event: NodeV8Event) => {
			this._stopped('exception');
			this._handleNodeExceptionEvent(<V8ExceptionEventBody>event.body);
		});

		/*
		this._node.on('beforeCompile', (event: NodeV8Event) => {
			//this.outLine(`beforeCompile ${this._scriptToPath(event.body.script)}`);
			this.sendEvent(new Event('customScriptLoad', { script: this._scriptToPath(event.body.script) }));
		});
		*/

		this._node.on('afterCompile', (event: NodeV8Event) => {
			this._scriptToSource(event.body.script).then(source => {
				this.sendEvent(new LoadedSourceEvent('new', source));
			});
		});

		this._node.on('close', (event: NodeV8Event) => {
			this._terminated('node v8protocol close');
		});

		this._node.on('error', (event: NodeV8Event) => {
			this._terminated('node v8protocol error');
		});

		/*
		this._node.on('diagnostic', (event: NodeV8Event) => {
			this.outLine(`diagnostic event ${event.body.reason}`);
		});
		*/
	}

	/**
	 * Analyse why node has stopped and sends StoppedEvent if necessary.
	 */
	private _handleNodeExceptionEvent(eventBody: V8ExceptionEventBody) : void {

		// should we skip this location?
		if (this._skip(eventBody)) {
			this._node.command('continue');
			return;
		}

		let description: string | undefined;

		// in order to identify rejects extract source at current location
		if (eventBody.sourceLineText && typeof eventBody.sourceColumn === 'number') {
			let source = eventBody.sourceLineText.substr(eventBody.sourceColumn);
			if (source.indexOf('reject(') === 0) {
				if (this._skipRejects && !this._catchRejects) {
					this._node.command('continue');
					return;
				}
				description = localize('exception.paused.promise.rejection', "Paused on Promise Rejection");
				if (eventBody.exception.text) {
					eventBody.exception.text = localize('exception.promise.rejection.text', "Promise Rejection ({0})", eventBody.exception.text);
				} else {
					eventBody.exception.text = localize('exception.promise.rejection', "Promise Rejection");
				}
			}
		}

		// send event
		this._exception = eventBody;
		this._sendStoppedEvent('exception', description, eventBody.exception.text);
	}

	/**
	 * Analyse why node has stopped and sends StoppedEvent if necessary.
	 */
	private _handleNodeBreakEvent(eventBody: V8BreakEventBody) : void {

		const breakpoints = eventBody.breakpoints;

		// check for breakpoints
		if (Array.isArray(breakpoints) && breakpoints.length > 0) {

			this._disableSkipFiles = this._skip(eventBody);

			const id = breakpoints[0];
			if (!this._gotEntryEvent && id === 1) {	// 'stop on entry point' is implemented as a breakpoint with ID 1

				this.log('la', '_handleNodeBreakEvent: suppressed stop-on-entry event');
				// do not send event now
				this._rememberEntryLocation(eventBody.script.name, eventBody.sourceLine, eventBody.sourceColumn);
				return;
			}

			this._sendBreakpointStoppedEvent(id);
			return;
		}

		// in order to identify debugger statements extract source at current location
		if (eventBody.sourceLineText && typeof eventBody.sourceColumn === 'number') {
			let source = eventBody.sourceLineText.substr(eventBody.sourceColumn);
			if (source.indexOf('debugger') === 0) {
				this._gotDebuggerEvent = true;
				this._sendStoppedEvent('debugger_statement');
				return;
			}
		}

		// must be the result of a 'step'
		let reason: ReasonType = 'step';
		if (this._restartFramePending) {
			this._restartFramePending = false;
			reason = 'frame_entry';
		}

		if (!this._disableSkipFiles) {
			// should we continue until we find a better place to stop?
			if ((this._smartStep && this._sourceMaps) || this._skipFiles) {
				this._skipGenerated(eventBody).then(r => {
					if (r) {
						this._node.command('continue', { stepaction: 'in' });
						this._smartStepCount++;
					} else {
						this._sendStoppedEvent(<ReasonType>reason);
					}
				});
				return;
			}
		}

		this._sendStoppedEvent(reason);
	}

	private _sendBreakpointStoppedEvent(breakpointId: number): void {

		// evaluate hit counts
		let ibp = this._hitCounts.get(breakpointId);
		if (ibp) {
			ibp.hitCount++;
			if (ibp.hitter && !ibp.hitter(ibp.hitCount)) {
				this._node.command('continue');
				return;
			}
		}

		this._sendStoppedEvent('breakpoint');
	}

	private _sendStoppedEvent(reason: ReasonType, description?: string, exception_text?: string): void {

		if (this._smartStepCount > 0) {
			this.log('ss', `_handleNodeBreakEvent: ${this._smartStepCount} steps skipped`);
			this._smartStepCount = 0;
		}

		const e = new StoppedEvent(reason, NodeDebugSession.DUMMY_THREAD_ID, exception_text);

		if (!description) {
			switch (reason) {
				case 'step':
					description = localize('reason.description.step', "Paused on step");
					break;
				case 'breakpoint':
					description = localize('reason.description.breakpoint', "Paused on breakpoint");
					break;
				case 'exception':
					description = localize('reason.description.exception', "Paused on exception");
					break;
				case 'pause':
					description = localize('reason.description.user_request', "Paused on user request");
					break;
				case 'entry':
					description = localize('reason.description.entry', "Paused on entry");
					break;
				case 'debugger_statement':
					description = localize('reason.description.debugger_statement', "Paused on debugger statement");
					break;
				case 'frame_entry':
					description = localize('reason.description.restart', "Paused on frame entry");
					break;
			}
		}
		(<DebugProtocol.StoppedEvent>e).body.description = description;

		this.sendEvent(e);
	}

	private isSkipped(path: string): boolean {
		return this._skipFiles ? PathUtils.multiGlobMatches(this._skipFiles, path) : false;
	}

	/**
	 * Returns true if a source location of the given event should be skipped.
	 */
	private _skip(event: V8EventBody) : boolean {

		if (this._skipFiles) {
			let path = this._scriptToPath(event.script);

			// if launch.json defines localRoot and remoteRoot try to convert remote path back to a local path
			let localPath = this._remoteToLocal(path);

			return PathUtils.multiGlobMatches(this._skipFiles, localPath);
		}

		return false;
	}

	/**
	 * Returns true if a source location of the given event should be skipped.
	 */
	private _skipGenerated(event: V8EventBody) : Promise<boolean> {

		let path = this._scriptToPath(event.script);

		// if launch.json defines localRoot and remoteRoot try to convert remote path back to a local path
		let localPath = this._remoteToLocal(path);

		if (this._skipFiles) {
			if (PathUtils.multiGlobMatches(this._skipFiles, localPath)) {
				return Promise.resolve(true);
			}
			return Promise.resolve(false);
		}

		if (this._smartStep) {
			// try to map
			let line = event.sourceLine;
			let column = this._adjustColumn(line, event.sourceColumn);

			return this._sourceMaps.CannotMapLine(localPath, null, line, column).then(skip => {
				return skip;
			});
		}

		return Promise.resolve(false);
	}

	private toggleSkippingResource(response: DebugProtocol.Response, resource: string) {

		resource = decodeURI(<string>URL.parse(resource).pathname);
		if (this.isSkipped(resource)) {
			if (!this._skipFiles) {
				this._skipFiles = new Array<string>();
			}
			this._skipFiles.push('!' + resource);
		} else {
			if (!this._skipFiles) {
				this._skipFiles = new Array<string>();
			}
			this._skipFiles.push(resource);
		}
		this.sendResponse(response);
	}

	/**
	 * create a path for a script following these rules:
	 * - script name is an absolute path: return name as is
	 * - script name is an internal module: return "<node_internals/name"
	 * - script has no name: return "<node_internals/VMnnn" where nnn is the script ID
	 */
	private _scriptToPath(script: V8Script): string {
		let name = script.name;
		if (name) {
			if (PathUtils.isAbsolutePath(name)) {
				return name;
			}
		} else {
			name = `VM${script.id}`;
		}
		return `${NodeDebugSession.NODE_INTERNALS}/${name}`;
	}

	/**
	 * create a Source for a script following these rules:
	 * - script name is an absolute path: return name as is
	 * - script name is an internal module: return "<node_internals/name"
	 * - script has no name: return "<node_internals/VMnnn" where nnn is the script ID
	 */
	private _scriptToSource(script: V8Script): Promise<Source> {
		let path = script.name;
		if (path) {
			if (!PathUtils.isAbsolutePath(path)) {
				path = `${NodeDebugSession.NODE_INTERNALS}/${path}`;
			}
		} else {
			path = `${NodeDebugSession.NODE_INTERNALS}/VM${script.id}`;
		}
		const src = new Source(Path.basename(path), path, this._getScriptIdHandle(script.id));
		if (this._sourceMaps) {
			return this._sourceMaps.AllSources(path).then(sources => {
				if (sources && sources.length > 0) {
					(<DebugProtocol.Source>src).sources = sources.map(s => new Source(Path.basename(s), s) );
				}
				return src;
			});
		}
		return Promise.resolve(src);
	}

	/**
	 * Special treatment for internal modules:
	 * we remove the '<node_internals>/' or '<node_internals>\' prefix and return either the name of the module or its ID
	 */
	private _pathToScript(path: string): number | string {

		const result = NodeDebugSession.NODE_INTERNALS_VM.exec(path);
		if (result && result.length >= 2) {
			return + result[1];
		}
		return path.replace(NodeDebugSession.NODE_INTERNALS_PREFIX, '');
	}

	/**
	 * clear everything that is no longer valid after a new stopped event.
	 */
	private _stopped(reason: string): void {
		this._stoppedReason = reason;
		this.log('la', `_stopped: got ${reason} event from node`);
		this._exception = undefined;
		this._variableHandles.reset();
		this._frameHandles.reset();
		this._refCache = new Map<number, V8Object>();
		this.log('rc', `_stopped: new ref cache`);
	}

	/**
	 * The debug session has terminated.
	 */
	private _terminated(reason: string): void {
		this.log('la', `_terminated: ${reason}`);

		if (!this._isTerminated) {
			this._isTerminated = true;
			if (this._restartMode && this._attachSuccessful && !this._inShutdown) {
				this.sendEvent(new TerminatedEvent({ port: this._port }));
			} else {
				this.sendEvent(new TerminatedEvent());
			}
		}
	}

	//---- initialize request -------------------------------------------------------------------------------------------------

	protected initializeRequest(response: DebugProtocol.InitializeResponse, args: DebugProtocol.InitializeRequestArguments): void {

		this.log('la', `initializeRequest: adapterID: ${args.adapterID}`);

		if (args.locale) {
			localize = nls.config({ locale: args.locale })();
		}

		if (typeof args.supportsRunInTerminalRequest === 'boolean') {
			this._supportsRunInTerminalRequest = args.supportsRunInTerminalRequest;
		}

		//---- Send back feature and their options

		response.body = response.body || {};

		// This debug adapter supports the configurationDoneRequest.
		response.body.supportsConfigurationDoneRequest = true;

		// This debug adapter supports function breakpoints.
		response.body.supportsFunctionBreakpoints = true;

		// This debug adapter supports conditional breakpoints.
		response.body.supportsConditionalBreakpoints = true;

		// This debug adapter does not support a side effect free evaluate request for data hovers.
		response.body.supportsEvaluateForHovers = false;

		// This debug adapter supports two exception breakpoint filters
		response.body.exceptionBreakpointFilters = [
			{
				label: localize('exceptions.all', "All Exceptions"),
				filter: 'all',
				default: false
			},
			{
				label: localize('exceptions.uncaught', "Uncaught Exceptions"),
				filter: 'uncaught',
				default: true
			}
		];
		if (this._skipRejects) {
			response.body.exceptionBreakpointFilters.push({
				label: localize('exceptions.rejects', "Promise Rejects"),
				filter: 'rejects',
				default: false
			});
		}

		// This debug adapter supports setting variables
		response.body.supportsSetVariable = true;

		// This debug adapter supports the restartFrame request
		response.body.supportsRestartFrame = true;

		// This debug adapter supports the completions request
		response.body.supportsCompletionsRequest = true;

		// This debug adapter supports the exception info request
		response.body.supportsExceptionInfoRequest = true;

		// This debug adapter supports delayed loading of stackframes
		response.body.supportsDelayedStackTraceLoading = true;

		// This debug adapter supports log points
		response.body.supportsLogPoints = true;

		// This debug adapter supports terminate request (but not on Windows)
		response.body.supportsTerminateRequest = process.platform !== 'win32';

		// This debug adapter supports loaded sources request
		response.body.supportsLoadedSourcesRequest = true;

		this.sendResponse(response);
	}

	//---- launch request -----------------------------------------------------------------------------------------------------

	protected launchRequest(response: DebugProtocol.LaunchResponse, args: LaunchRequestArguments): void {

		if (this._processCommonArgs(response, args)) {
			return;
		}

		if (args.__restart && typeof args.__restart.port === 'number') {
			this._attach(response, args, args.__restart.port, undefined, args.timeout);
			return;
		}

		this._noDebug = (typeof args.noDebug === 'boolean') && args.noDebug;

		if (typeof args.console === 'string') {
			switch (args.console) {
				case 'internalConsole':
				case 'integratedTerminal':
				case 'externalTerminal':
					this._console = args.console;
					break;
				default:
					this.sendErrorResponse(response, 2028, localize('VSND2028', "Unknown console type '{0}'.", args.console));
					return;
			}
		} else if (typeof args.externalConsole === 'boolean' && args.externalConsole) {
			this._console = 'externalTerminal';
		}

		if (args.useWSL) {
			if (!WSL.subsystemLinuxPresent()) {
				this.sendErrorResponse(response, 2007, localize('attribute.wls.not.exist', "Cannot find Windows Subsystem Linux installation"));
				return;
			}
			this._isWSL = true;
		}

		let runtimeExecutable = args.runtimeExecutable;
		if (args.useWSL) {
			runtimeExecutable = runtimeExecutable || NodeDebugSession.NODE;
		} else if (runtimeExecutable) {
			if (!Path.isAbsolute(runtimeExecutable)) {
				const re = PathUtils.findOnPath(runtimeExecutable, args.env);
				if (!re) {
					this.sendErrorResponse(response, 2001, localize('VSND2001', "Cannot find runtime '{0}' on PATH. Make sure to have '{0}' installed.", '{_runtime}'), { _runtime: runtimeExecutable });
					return;
				}
				runtimeExecutable = re;
			} else {
				const re = PathUtils.findExecutable(runtimeExecutable, args.env);
				if (!re) {
					this.sendNotExistErrorResponse(response, 'runtimeExecutable', runtimeExecutable);
					return;
				}
				runtimeExecutable = re;
			}
		} else {
			const re = PathUtils.findOnPath(NodeDebugSession.NODE, args.env);
			if (!re) {
				this.sendErrorResponse(response, 2001, localize('VSND2001', "Cannot find runtime '{0}' on PATH. Make sure to have '{0}' installed.", '{_runtime}'), { _runtime: NodeDebugSession.NODE });
				return;
			}
			runtimeExecutable = re;
		}

		let runtimeArgs = args.runtimeArgs || [];
		const programArgs = args.args || [];

		let programPath = args.program;
		if (programPath) {
			if (!Path.isAbsolute(programPath)) {
				this.sendRelativePathErrorResponse(response, 'program', programPath);
				return;
			}
			if (!FS.existsSync(programPath)) {
				if (!FS.existsSync(programPath + '.js')) {
					this.sendNotExistErrorResponse(response, 'program', programPath);
					return;
				}
				programPath += '.js';
			}
			programPath = Path.normalize(programPath);
			if (PathUtils.normalizeDriveLetter(programPath) !== PathUtils.realPath(programPath)) {
				this.outLine(localize('program.path.case.mismatch.warning', "Program path uses differently cased character as file on disk; this might result in breakpoints not being hit."));
			}
		}

		if (!args.runtimeArgs && !this._noDebug) {
			runtimeArgs = [ '--nolazy' ];
		}

		if (programPath) {
			if (NodeDebugSession.isJavaScript(programPath)) {
				if (this._sourceMaps) {
					// if programPath is a JavaScript file and sourceMaps are enabled, we don't know whether
					// programPath is the generated file or whether it is the source (and we need source mapping).
					// Typically this happens if a tool like 'babel' or 'uglify' is used (because they both transpile js to js).
					// We use the source maps to find a 'source' file for the given js file.
					this._sourceMaps.MapPathFromSource(programPath).then(generatedPath => {
						if (generatedPath && generatedPath !== programPath) {
							// programPath must be source because there seems to be a generated file for it
							this.log('sm', `launchRequest: program '${programPath}' seems to be the source; launch the generated file '${generatedPath}' instead`);
							programPath = generatedPath;
						} else {
							this.log('sm', `launchRequest: program '${programPath}' seems to be the generated file`);
						}
						this.launchRequest2(response, args, programPath, programArgs, <string> runtimeExecutable, runtimeArgs);
					});
					return;
				}
			} else {
				// node cannot execute the program directly
				if (!this._sourceMaps) {
					this.sendErrorResponse(response, 2002, localize('VSND2002', "Cannot launch program '{0}'; configuring source maps might help.", '{path}'), { path: programPath });
					return;
				}
				this._sourceMaps.MapPathFromSource(programPath).then(generatedPath => {
					if (!generatedPath) {	// cannot find generated file
						if (args.outFiles || args.outDir) {
							this.sendErrorResponse(response, 2009, localize('VSND2009', "Cannot launch program '{0}' because corresponding JavaScript cannot be found.", '{path}'), { path: programPath });
						} else {
							this.sendErrorResponse(response, 2003, localize('VSND2003', "Cannot launch program '{0}'; setting the '{1}' attribute might help.", '{path}', 'outFiles'), { path: programPath });
						}
						return;
					}
					this.log('sm', `launchRequest: program '${programPath}' seems to be the source; launch the generated file '${generatedPath}' instead`);
					programPath = generatedPath;
					this.launchRequest2(response, args, programPath, programArgs, <string> runtimeExecutable, runtimeArgs);
				});
				return;
			}
		}

		this.launchRequest2(response, args, programPath, programArgs, runtimeExecutable, runtimeArgs);
	}

	private async launchRequest2(response: DebugProtocol.LaunchResponse, args: LaunchRequestArguments, programPath: string, programArgs: string[], runtimeExecutable: string, runtimeArgs: string[]): Promise<void> {

		let program: string | undefined;
		let workingDirectory = args.cwd;

		if (workingDirectory) {
			if (!Path.isAbsolute(workingDirectory)) {
				this.sendRelativePathErrorResponse(response, 'cwd', workingDirectory);
				return;
			}
			if (!FS.existsSync(workingDirectory)) {
				this.sendNotExistErrorResponse(response, 'cwd', workingDirectory);
				return;
			}
			// if working dir is given and if the executable is within that folder, we make the executable path relative to the working dir
			if (programPath) {
				program = Path.relative(workingDirectory, programPath);
			}
		}
		else if (programPath) {	// should not happen
			// if no working dir given, we use the direct folder of the executable
			workingDirectory = Path.dirname(programPath);
			program = Path.basename(programPath);
		}

		// figure out when to add a '--debug-brk=nnnn'
		let port = args.port;
		let launchArgs = [ runtimeExecutable ].concat(runtimeArgs);
		if (!this._noDebug) {

			if (args.port) {	// a port was specified in launch config

				// only if the default runtime 'node' is used without arguments
				if (!args.runtimeExecutable && !args.runtimeArgs) {

					// use the specfied port
					launchArgs.push(`--debug-brk=${port}`);
				}
			} else { // no port is specified

				// use a random port
				port = await findport();
				launchArgs.push(`--debug-brk=${port}`);
			}
		}

		if (program) {
			launchArgs.push(program);
		}
		launchArgs = launchArgs.concat(programArgs);

		const address = args.address;
		const timeout = args.timeout;

		let envVars = args.env;

		// read env from disk and merge into envVars
		if (args.envFile) {
			try {
				const buffer = PathUtils.stripBOM(FS.readFileSync(args.envFile, 'utf8'));
				const env = {};
				buffer.split('\n').forEach( line => {
					const r = line.match(/^\s*([\w\.\-]+)\s*=\s*(.*)?\s*$/);
					if (r !== null) {
						const key = r[1];
						if (!process.env[key]) {	// .env variables never overwrite existing variables (see #21169)
							let value = r[2] || '';
							if (value.length > 0 && value.charAt(0) === '"' && value.charAt(value.length-1) === '"') {
								value = value.replace(/\\n/gm, '\n');
							}
							env[key] = value.replace(/(^['"]|['"]$)/g, '');
						}
					}
				});
				envVars = PathUtils.extendObject(env, args.env); // launch config env vars overwrite .env vars
			} catch (e) {
				this.sendErrorResponse(response, 2029, localize('VSND2029', "Can't load environment variables from file ({0}).", '{_error}'), { _error: e.message });
				return;
			}
		}

		const wslLaunchArgs = WSL.createLaunchArg(args.useWSL,
			this._supportsRunInTerminalRequest && this._console === 'externalTerminal',
			<string> workingDirectory,
			launchArgs[0],
			launchArgs.slice(1),
			program);	// workaround for #35249

		// if using subsystem linux, we use local/remote mapping (if not configured by user)
		if (args.useWSL && !args.localRoot && !args.remoteRoot) {
			this._localRoot = wslLaunchArgs.localRoot;
			this._remoteRoot = wslLaunchArgs.remoteRoot;
		}

		if (this._supportsRunInTerminalRequest && (this._console === 'externalTerminal' || this._console === 'integratedTerminal')) {

			const termArgs : DebugProtocol.RunInTerminalRequestArguments = {
				kind: this._console === 'integratedTerminal' ? 'integrated' : 'external',
				title: localize('node.console.title', "Node Debug Console"),
				cwd: wslLaunchArgs.cwd,
				args: wslLaunchArgs.combined,
				env: envVars
			};

			this.runInTerminalRequest(termArgs, NodeDebugSession.RUNINTERMINAL_TIMEOUT, runResponse => {
				if (runResponse.success) {

					// since node starts in a terminal, we cannot track it with an 'exit' handler
					// plan for polling after we have gotten the process pid.
					this._pollForNodeProcess = !args.runtimeExecutable	// only if no 'runtimeExecutable' is specified
											&& !args.useWSL;			// it will not work with WSL either

					if (this._noDebug) {
						this.sendResponse(response);

						// since we do not know the process ID we will not be able to terminate it properly
						// therefore we end the session
						this._terminated('cannot track process');

					} else {
						this._attach(response, args, port, address, timeout);
					}
				} else {
					this.sendErrorResponse(response, 2011, localize('VSND2011', "Cannot launch debug target in terminal ({0}).", '{_error}'), { _error: runResponse.message } );
					this._terminated('terminal error: ' + runResponse.message);
				}
			});

		} else {

			this._sendLaunchCommandToConsole(launchArgs);

			// merge environment variables into a copy of the process.env
			envVars = PathUtils.extendObject(PathUtils.extendObject( {}, process.env), envVars);

			// delete all variables that have a 'null' value
			if (envVars) {
				const e = envVars; // without this tsc complains about envVars potentially undefined
				Object.keys(e).filter(v => e[v] === null).forEach(key => delete e[key] );
			}

			const options: CP.SpawnOptions = {
				cwd: workingDirectory,
				env: <NodeJS.ProcessEnv> envVars
			};

			// see bug #45832
			if (process.platform === 'win32' && wslLaunchArgs.executable.indexOf(' ') > 0) {
				let foundArgWithSpace = false;

				// check whether there is one arg with a space
				const args: string[] = [];
				for (const a of wslLaunchArgs.args) {
					if (a.indexOf(' ') > 0) {
						args.push(`"${a}"`);
						foundArgWithSpace = true;
					} else {
						args.push(a);
					}
				}

				if (foundArgWithSpace) {
					wslLaunchArgs.args = args;
					wslLaunchArgs.executable = `"${wslLaunchArgs.executable}"`;
					(<any>options).shell = true;
				}
			}

			const nodeProcess = CP.spawn(wslLaunchArgs.executable, wslLaunchArgs.args, options);
			nodeProcess.on('error', (error) => {
				// tslint:disable-next-line:no-bitwise
				this.sendErrorResponse(response, 2017, localize('VSND2017', "Cannot launch debug target ({0}).", '{_error}'), { _error: error.message }, ErrorDestination.Telemetry | ErrorDestination.User );
				this._terminated(`failed to launch target (${error})`);
			});
			nodeProcess.on('exit', () => {
				this._terminated('target exited');
			});
			nodeProcess.on('close', (code) => {
				this._terminated('target closed');
			});

			this._processId = nodeProcess.pid;

			this._captureOutput(nodeProcess);

			if (this._noDebug) {
				this.sendResponse(response);
			} else {
				this._attach(response, args, port, address, timeout);
			}
		}
	}

	private _sendLaunchCommandToConsole(args: string[]) {
		// print the command to launch the target to the debug console
		let cli = '';
		for (let a of args) {
			if (a.indexOf(' ') >= 0) {
				cli += '\'' + a + '\'';
			} else {
				cli += a;
			}
			cli += ' ';
		}
		this.outLine(cli);
	}

	private _captureOutput(process: CP.ChildProcess) {
		process.stdout.on('data', (data: string) => {
			this.sendEvent(new OutputEvent(data.toString(), 'stdout'));
		});
		process.stderr.on('data', (data: string) => {
			this.sendEvent(new OutputEvent(data.toString(), 'stderr'));
		});
	}

	/**
	 * returns true on error.
	 */
	private _processCommonArgs(response: DebugProtocol.Response, args: CommonArguments): boolean {

		let stopLogging = true;
		if (typeof args.trace === 'boolean') {
			this._trace = args.trace ? [ 'all' ] : undefined;
			this._traceAll = args.trace;
		} else if (typeof args.trace === 'string') {
			this._trace = args.trace.split(',');
			this._traceAll = this._trace.indexOf('all') >= 0;

			if (this._trace.indexOf('dap') >= 0) {
				logger.setup(Logger.LogLevel.Verbose, /*logToFile=*/false);
				stopLogging = false;
			}
		}
		if (stopLogging) {
			logger.setup(Logger.LogLevel.Stop, false);
		}

		if (typeof args.stepBack === 'boolean') {
			this._stepBack = args.stepBack;
		}

		if (typeof args.mapToFilesOnDisk === 'boolean') {
			this._mapToFilesOnDisk = args.mapToFilesOnDisk;
		}

		if (typeof args.smartStep === 'boolean') {
			this._smartStep = args.smartStep;
		}

		if (Array.isArray(args.skipFiles)) {
			this._skipFiles = args.skipFiles;
		}

		if (typeof args.stopOnEntry === 'boolean') {
			this._stopOnEntry = args.stopOnEntry;
		}

		if (typeof args.restart === 'boolean') {
			this._restartMode = args.restart;
		}

		if (args.localRoot) {
			const localRoot = args.localRoot;
			if (!Path.isAbsolute(localRoot)) {
				this.sendRelativePathErrorResponse(response, 'localRoot', localRoot);
				return true;
			}
			if (!FS.existsSync(localRoot)) {
				this.sendNotExistErrorResponse(response, 'localRoot', localRoot);
				return true;
			}
			this._localRoot = localRoot;
		}
		this._remoteRoot = args.remoteRoot;

		if (!this._sourceMaps) {
			if (args.sourceMaps === undefined) {
				args.sourceMaps = true;
			}
			if (typeof args.sourceMaps === 'boolean' && args.sourceMaps) {
				const generatedCodeDirectory = args.outDir;
				if (generatedCodeDirectory) {
					if (!Path.isAbsolute(generatedCodeDirectory)) {
						this.sendRelativePathErrorResponse(response, 'outDir', generatedCodeDirectory);
						return true;
					}
					if (!FS.existsSync(generatedCodeDirectory)) {
						this.sendNotExistErrorResponse(response, 'outDir', generatedCodeDirectory);
						return true;
					}
				}
				this._sourceMaps = new SourceMaps(this, generatedCodeDirectory, args.outFiles);
			}
		}

		return false;
	}

	//---- attach request -----------------------------------------------------------------------------------------------------

	protected attachRequest(response: DebugProtocol.AttachResponse, args: AttachRequestArguments): void {

		if (this._processCommonArgs(response, args)) {
			return;
		}

		this._attachMode = true;

		this._attach(response, args, args.port, args.address, args.timeout);
	}

	/*
	 * shared 'attach' code used in launchRequest and attachRequest.
	 */
	private _attach(response: DebugProtocol.Response, args: CommonArguments, port: number, adr: string | undefined, timeout: number | undefined): void {

		if (!port) {
			port = 5858;
		}
		this._port = port;

		let address: string;
		if (!adr || adr === 'localhost') {
			address = '127.0.0.1';
		} else {
			address = adr;
		}

		if (!timeout) {
			timeout = NodeDebugSession.ATTACH_TIMEOUT;
		}

		this.log('la', `_attach: address: ${address} port: ${port}`);

		let connected = false;
		const socket = new Net.Socket();
		socket.connect(port, address);

		socket.on('connect', err => {
			this.log('la', '_attach: connected');
			connected = true;
			this._node.startDispatch(<NodeJS.ReadableStream>socket, socket);

			this._isRunning().then(running => {

				if (this._pollForNodeProcess) {
					this._pollForNodeTermination();
				}

				setTimeout(() => {
					this._injectDebuggerExtensions().then(_ => {

						if (!this._stepBack) {
							// does runtime support 'step back'?
							const v = this._node.embeddedHostVersion;	// x.y.z version represented as (x*100+y)*100+z
							if (!this._node.v8Version && v >= 70000) {
								this._stepBack = true;
								this.sendEvent(new CapabilitiesEvent({ supportsStepBack: true}));
							}
						}

						this.sendResponse(response);
						this._startInitialize(!running);
					});
				}, 10);

			}).catch(resp => {
				this._sendNodeResponse(response, resp);
			});
		});

		const endTime = new Date().getTime() + timeout;
		socket.on('error', err => {
			if (connected) {
				// since we are connected this error is fatal
				this.sendErrorResponse(response, 2010, localize('VSND2010', "Cannot connect to runtime process (reason: {0}).", '{_error}'), { _error: err.message });
			} else {
				// we are not yet connected so retry a few times
				if ((<any>err).code === 'ECONNREFUSED' || (<any>err).code === 'ECONNRESET') {
					const now = new Date().getTime();
					if (now < endTime) {
						setTimeout(() => {
							this.log('la', '_attach: retry socket.connect');
							socket.connect(port, address);
						}, 200);		// retry after 200 ms
					} else {
						if (typeof args.port === 'number') {
							this.sendErrorResponse(response, 2033, localize('VSND2033', "Cannot connect to runtime; make sure that runtime is in 'legacy' debug mode."));
						} else {
							this.sendErrorResponse(response, 2034, localize('VSND2034', "Cannot connect to runtime via 'legacy' protocol; try to use 'inspector' protocol."));
						}
					}
				} else {
					this.sendErrorResponse(response, 2010, localize('VSND2010', "Cannot connect to runtime process (reason: {0}).", '{_error}'), { _error: err.message });
				}
			}
		});

		socket.on('end', err => {
			this._terminated('socket end');
		});
	}

	/**
	 * Determine whether the runtime is running or stopped.
	 * We do this by running an 'evaluate' request
	 * (a benevolent side effect of the evaluate is to find the process id and runtime version).
	 */
	private _isRunning() : Promise<boolean> {
		return new Promise((completeDispatch, errorDispatch) => {
			this._isRunningWithRetry(0, completeDispatch, errorDispatch);
		});
	}

	private _isRunningWithRetry(retryCount: number, completeDispatch: (value: boolean) => void, errorDispatch: (error: V8EvaluateResponse) => void) : void {

		this._node.command('evaluate', { expression: 'process.pid', global: true }, (resp: V8EvaluateResponse) => {

			if (resp.success && resp.body.value !== undefined) {
				this._nodeProcessId = +resp.body.value;
				this.log('la', `__initialize: got process id ${this._nodeProcessId} from node`);
				this.logNodeVersion();
			} else {
				if (resp.message.indexOf('process is not defined') >= 0) {
					this.log('la', '__initialize: process not defined error; got no pid');
					resp.success = true; // continue and try to get process.pid later
				}
			}

			if (resp.success) {
				completeDispatch(resp.running);
			} else {
				this.log('la', '__initialize: retrieving process id from node failed');

				if (retryCount < 4) {
					setTimeout(() => {
						// recurse
						this._isRunningWithRetry(retryCount+1, completeDispatch, errorDispatch);
					}, 100);
					return;
				} else {
					errorDispatch(resp);
				}
			}
		});
	}

	private logNodeVersion(): void {
		this._node.command('evaluate', { expression: 'process.version', global: true }, (resp: V8EvaluateResponse) => {
			if (resp.success && resp.body.value !== undefined) {
				const version = resp.body.value;
				/* __GDPR__
				   "nodeVersion" : {
					  "version" : { "classification": "SystemMetaData", "purpose": "FeatureInsight" }
				   }
				 */
				this.sendEvent(new OutputEvent('nodeVersion', 'telemetry', { version }));
				this.log('la', `_initialize: target node version: ${version}`);
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
	 * Inject code into node.js to address slowness issues when inspecting large data structures.
	 */
	private _injectDebuggerExtensions() : Promise<boolean> {

		if (this._tryToInjectExtension) {

			const v = this._node.embeddedHostVersion;	// x.y.z version represented as (x*100+y)*100+z

			if (this._node.v8Version && ((v >= 1200 && v < 10000) || (v >= 40301 && v < 50000) || (v >= 50600))) {
				try {
					const contents = FS.readFileSync(Path.join(__dirname, NodeDebugSession.DEBUG_INJECTION), 'utf8');

					const args = {
						expression: contents,
						global: true,
						disable_break: true
					};

					return this._node.evaluate(args).then(resp => {
						this.log('la', `_injectDebuggerExtensions: code injection successful`);
						this._nodeInjectionAvailable = true;
						return true;
					}).catch(resp => {
						this.log('la', `_injectDebuggerExtensions: code injection failed with error '${resp.message}'`);
						return true;
					});

				} catch(e) {
					// fall through
				}
			}
		}
		return Promise.resolve(true);
	}

	/*
	 * start the initialization sequence:
	 * 1. wait for 'break-on-entry' (with timeout)
	 * 2. send 'inititialized' event in order to trigger setBreakpointEvents request from client
	 * 3. prepare for sending 'break-on-entry' or 'continue' later in configurationDoneRequest()
	 */
	private _startInitialize(stopped: boolean, n: number = 0): void {

		if (n === 0) {
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
				this._node.command('evaluate', { expression: 'process.pid', global: true }, (resp: V8EvaluateResponse) => {
					if (resp.success && resp.body.value !== undefined) {
						this._nodeProcessId = +resp.body.value;
						this.log('la', `_initialize: got process id ${this._nodeProcessId} from node (2nd try)`);
						this.logNodeVersion();
					}
					this._startInitialize2(stopped);
				});
			} else {
				this._startInitialize2(stopped);
			}
		} else {
			this.log('la', `_startInitialize: no entry event after ${n} retries; giving up`);

			this._gotEntryEvent = true;	// we pretend to got one so that no 'entry' event will show up later...

			this._node.command('frame', null, (resp: V8FrameResponse) => {
				if (resp.success) {
					const s = <V8Script> this._getValueFromCache(resp.body.script);
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

		this._attachSuccessful = true;

		// in attach-mode we don't know whether the debuggee has been launched in 'stop on entry' mode
		// so we use the stopped state of the VM
		if (this._attachMode) {
			this.log('la', `_startInitialize2: in attach mode we guess stopOnEntry flag to be '${stopped}''`);
			if (this._stopOnEntry === undefined) {
				this._stopOnEntry = stopped;
			}
		}

		if (this._stopOnEntry) {
			// user has requested 'stop on entry' so send out a stop-on-entry event
			this.log('la', '_startInitialize2: fire stop-on-entry event');
			this._sendStoppedEvent('entry');
		}
		else {
			// since we are stopped but UI doesn't know about this, remember that we later do the right thing in configurationDoneRequest()
			if (this._gotDebuggerEvent) {
				this._needDebuggerEvent = true;
			} else {
				this.log('la', `_startInitialize2: remember to do a 'Continue' later`);
				this._needContinue = true;
			}
		}
	}

	//---- disconnect request -------------------------------------------------------------------------------------------------

	protected terminateRequest(response: DebugProtocol.TerminateResponse, args: DebugProtocol.TerminateArguments): void {

		if (!this._isWSL && this._nodeProcessId > 0) {
			process.kill(this._nodeProcessId, 'SIGINT');
		}

		this.log('la', 'terminateRequest: send response');
		this.sendResponse(response);
	}

	protected disconnectRequest(response: DebugProtocol.DisconnectResponse, args: DebugProtocol.DisconnectArguments): void {

		this.shutdown();

		this.log('la', 'disconnectRequest: send response');
		this.sendResponse(response);
	}

	/**
	 * Overridden from DebugSession:
	 * attach: disconnect from node
	 * launch: kill node & subprocesses
	 */
	public shutdown(): void {

		if (!this._inShutdown) {
			this._inShutdown = true;

			if (this._attachMode) {

				// disconnect only in attach mode since otherwise node continues to run until it is killed
				this._node.command('disconnect'); // we don't wait for reponse

				// stop socket connection (otherwise node.js dies with ECONNRESET on Windows)
				this._node.stop();

			} else {

				// stop socket connection (otherwise node.js dies with ECONNRESET on Windows)
				this._node.stop();

				this.log('la', 'shutdown: kill debugee and sub-processes');

				let pid = this._processId;
				this._processId = -1;

				if (this._isWSL) {

					// kill the whole process tree by starting with the launched runtimeExecutable
					if (pid > 0) {
						NodeDebugSession.killTree(pid);
					}

					// under WSL killing the "bash" shell on the Windows side does not automatically kill node.js on the linux side
					// so let's kill the node.js process on the linux side explicitly
					const node_pid = this._nodeProcessId;
					if (node_pid > 0) {
						this._nodeProcessId = -1;
						try {
							WSL.spawnSync(true, '/bin/kill', [ '-9', node_pid.toString() ]);
						} catch (err) {
						}
					}

				} else {

					// backward compatibilty
					if (this._nodeProcessId > 0) {
						pid = this._nodeProcessId;
						this._nodeProcessId = -1;
					}
					if (pid > 0) {
						NodeDebugSession.killTree(pid);
					}
				}
			}

			super.shutdown();
		}
	}

	//--- set breakpoints request ---------------------------------------------------------------------------------------------

	protected setBreakPointsRequest(response: DebugProtocol.SetBreakpointsResponse, args: DebugProtocol.SetBreakpointsArguments): void {

		this.log('bp', `setBreakPointsRequest: ${JSON.stringify(args.source)} ${JSON.stringify(args.breakpoints)}`);

		const sbs = new Array<InternalSourceBreakpoint>();
		// prefer the new API: array of breakpoints
		if (args.breakpoints) {
			for (let b of args.breakpoints) {

				let hitter: HitterFunction | undefined;
				if (b.hitCondition) {
					const result = NodeDebugSession.HITCOUNT_MATCHER.exec(b.hitCondition.trim());
					if (result && result.length >= 3) {
						let op = result[1] || '>=';
						if (op === '=') {
							op = '==';
						}
						const value = result[2];
						const expr = op === '%'
							? `return (hitcnt % ${value}) === 0;`
							: `return hitcnt ${op} ${value};`;
						hitter = <HitterFunction> Function('hitcnt', expr);
					} else {
						// error
					}
				}

				sbs.push(new InternalSourceBreakpoint(
					this.convertClientLineToDebugger(b.line),
					typeof b.column === 'number' ? this.convertClientColumnToDebugger(b.column) : 0,
					b.condition, b.logMessage, hitter)
				);
			}
		} else if (args.lines) {
			// deprecated API: convert line number array
			for (let l of args.lines) {
				sbs.push(new InternalSourceBreakpoint(this.convertClientLineToDebugger(l)));
			}
		}

		const source = args.source;
		const sourcePath = source.path ? this.convertClientPathToDebugger(source.path) : undefined;

		if (sourcePath) {
			// as long as node debug doesn't implement 'hot code replacement' we have to mark all breakpoints as unverified.

			let keepUnverified = false;

			if (this._modifiedSources.has(sourcePath)) {
				keepUnverified = true;
			} else {
				if (typeof args.sourceModified === 'boolean' && args.sourceModified) {
					keepUnverified = true;
					this._modifiedSources.add(sourcePath);
				}
			}

			if (keepUnverified) {
				const message = localize('file.on.disk.changed', "Unverified because file on disk has changed. Please restart debug session.");
				for (let ibp of sbs) {
					ibp.verificationMessage = message;
				}
			}
		}

		if (source.adapterData) {

			if (source.adapterData.inlinePath) {
				// a breakpoint in inlined source: we need to source map
				this._mapSourceAndUpdateBreakpoints(response, source.adapterData.inlinePath, sbs);
				return;
			}

			if (source.adapterData.remotePath) {
				// a breakpoint in a remote file: don't try to source map
				this._updateBreakpoints(response, source.adapterData.remotePath, -1, sbs);
				return;
			}
		}

		if (sourcePath && NodeDebugSession.NODE_INTERNALS_PREFIX.test(sourcePath)) {

			// an internal module
			this._findScript(this._pathToScript(sourcePath)).then(scriptId => {
				if (scriptId >= 0) {
					this._updateBreakpoints(response, null, scriptId, sbs);
				} else {
					this.sendErrorResponse(response, 2019, localize('VSND2019', "Internal module {0} not found.", '{_module}'), { _module: sourcePath });
				}
			});
			return;
		}

		if (typeof source.sourceReference === 'number' && source.sourceReference > 0) {
			const srcSource = this._sourceHandles.get(source.sourceReference);
			if (srcSource && srcSource.scriptId) {
				this._updateBreakpoints(response, null, srcSource.scriptId, sbs);
				return;
			}
		}

		if (sourcePath) {
			this._mapSourceAndUpdateBreakpoints(response, sourcePath, sbs);
			return;
		}

		this.sendErrorResponse(response, 2012, 'No valid source specified.', null, ErrorDestination.Telemetry);
	}

	private _mapSourceAndUpdateBreakpoints(response: DebugProtocol.SetBreakpointsResponse, path: string, lbs: InternalSourceBreakpoint[]) : void {

		let generated = '';

		Promise.resolve(generated).then(generated => {

			if (this._sourceMaps) {
				return this._sourceMaps.MapPathFromSource(path);
			}
			return generated;

		}).then(generated => {

			if (generated !== null && PathUtils.pathCompare(generated, path)) {   // if generated and source are the same we don't need a sourcemap
				this.log('bp', `_mapSourceAndUpdateBreakpoints: source and generated are same -> ignore sourcemap`);
				generated = '';
			}

			if (generated) {

				// source map line numbers
				Promise.all(lbs.map(lbrkpt => this._sourceMaps.MapFromSource(path, lbrkpt.line, lbrkpt.column))).then(mapResults => {

					for (let i = 0; i < lbs.length; i++) {
						const lb = lbs[i];
						const mapresult = mapResults[i];
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

					path = <string> generated;
					path = this._localToRemote(path);

					this._updateBreakpoints(response, path, -1, lbs, true);
				});

				return;
			}

			if (!NodeDebugSession.isJavaScript(path)) {
				// ignore all breakpoints for this source
				for (let lb of lbs) {
					lb.line = -1;
				}
			}

			// try to convert local path to remote path
			path = this._localToRemote(path);

			this._updateBreakpoints(response, path, -1, lbs, false);
		});
	}

	/*
	 * clear and set all breakpoints of a given source.
	 */
	private _updateBreakpoints(response: DebugProtocol.SetBreakpointsResponse, path: string | null, scriptId: number, lbs: InternalSourceBreakpoint[], sourcemap = false): void {

		// clear all existing breakpoints for the given path or script ID
		this._node.listBreakpoints().then(nodeResponse => {

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
		return Promise.all(ids.map(id => this._node.clearBreakpoint({ breakpoint: id }))).then(response => {
			return;
		}).catch(err => {
			return;	// ignore errors
		});
	}

	/*
	 * register a single breakpoint with node.
	 */
	private _setBreakpoint(scriptId: number, path: string | null, lb: InternalSourceBreakpoint, sourcemap: boolean) : Promise<Breakpoint> {

		if (lb.line < 0) {
			// ignore this breakpoint because it couldn't be source mapped successfully
			const bp: DebugProtocol.Breakpoint = new Breakpoint(false);
			bp.message = localize('sourcemapping.fail.message', "Breakpoint ignored because generated code not found (source map problem?).");
			return Promise.resolve(bp);
		}

		if (lb.line === 0) {
			lb.column += NodeDebugSession.FIRST_LINE_OFFSET;
		}

		let args: V8SetBreakpointArgs;

		if (scriptId > 0) {
			args = {
				type: 'scriptId',
				target: scriptId,
				line: lb.line,
				column: lb.column,
				condition: lb.condition
			};
		} else {
			args = {
				type: 'scriptRegExp',
				target: <string> this._pathToRegexp(path),
				line: lb.line,
				column: lb.column,
				condition: lb.condition
			};
		}

		return this._node.setBreakpoint(args).then(resp => {

			this.log('bp', `_setBreakpoint: ${JSON.stringify(args)}`);

			if (lb.hitter) {
				this._hitCounts.set(resp.body.breakpoint, lb);
			}

			let actualLine = <number> args.line;
			let actualColumn = <number> args.column;

			const al = resp.body.actual_locations;
			if (al.length > 0) {
				actualLine = al[0].line;
				actualColumn = this._adjustColumn(actualLine, al[0].column);
			}

			let actualSrcLine = actualLine;
			let actualSrcColumn = actualColumn;

			if (path && sourcemap) {

				if (actualLine !== args.line || actualColumn !== args.column) {
					// breakpoint location was adjusted by node.js so we have to map the new location back to source

					// first try to map the remote path back to local
					const localpath = this._remoteToLocal(path);

					// then try to map js locations back to source locations
					return this._sourceMaps.MapToSource(localpath, null, actualLine, actualColumn).then(mapresult => {

						if (mapresult) {
							this.log('sm', `_setBreakpoint: bp verification gen: '${localpath}' ${actualLine}:${actualColumn} -> src: '${mapresult.path}' ${mapresult.line}:${mapresult.column}`);
							actualSrcLine = mapresult.line;
							actualSrcColumn = mapresult.column;
						} else {
							actualSrcLine = lb.orgLine;
							actualSrcColumn = lb.orgColumn;
						}

						return this._setBreakpoint2(lb, path, actualSrcLine, actualSrcColumn, actualLine, actualColumn);
					});

				} else {
					actualSrcLine = lb.orgLine;
					actualSrcColumn = lb.orgColumn;
				}
			}

			return this._setBreakpoint2(lb, path, actualSrcLine, actualSrcColumn, actualLine, actualColumn);

		}).catch(error => {
			return new Breakpoint(false);
		});
	}

	private async _setBreakpoint2(ibp: InternalSourceBreakpoint, path: string | null, actualSrcLine: number, actualSrcColumn: number, actualLine: number, actualColumn: number) : Promise<Breakpoint> {

		// nasty corner case: since we ignore the break-on-entry event we have to make sure that we
		// stop in the entry point line if the user has an explicit breakpoint there (or if there is a 'debugger' statement).
		// For this we check here whether a breakpoint is at the same location as the 'break-on-entry' location.
		// If yes, then we plan for hitting the breakpoint instead of 'continue' over it!

		if (path && PathUtils.pathCompare(this._entryPath, path) && this._entryLine === actualLine && this._entryColumn === actualColumn) {	// only relevant if the breakpoints matches entrypoint

			let conditionMet = true;	// for regular breakpoints condition is always true
			if (ibp.condition) {
				// if conditional breakpoint we have to evaluate the condition because node didn't do it (because it stopped on entry).
				conditionMet = await this.evaluateCondition(ibp.condition);
			}

			if (!this._stopOnEntry && conditionMet) {
				// we do not have to 'continue' but we have to generate a stopped event instead
				this._needContinue = false;
				this._needBreakpointEvent = true;
				this.log('la', '_setBreakpoint2: remember to fire a breakpoint event later');
			}

		}

		if (ibp.verificationMessage) {
			const bp: DebugProtocol.Breakpoint = new Breakpoint(false, this.convertDebuggerLineToClient(actualSrcLine), this.convertDebuggerColumnToClient(actualSrcColumn));
			bp.message = ibp.verificationMessage;
			return bp;
		} else {
			return new Breakpoint(true, this.convertDebuggerLineToClient(actualSrcLine), this.convertDebuggerColumnToClient(actualSrcColumn));
		}
	}

	private evaluateCondition(condition: string): Promise<boolean> {

		const args = {
			expression: condition,
			frame: 0,	// evaluate always in top frame
			disable_break: true
		};

		return this._node.evaluate(args).then(response => {
			return !!response.body.value;
		}).catch(e => {
			return false;
		});
	}

	/**
	 * converts a path into a regular expression for use in the setbreakpoint request
	 */
	private _pathToRegexp(path: string | null): string | null {

		if (!path) {
			return path;
		}

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

		let args: V8SetBreakpointArgs = {
			type: 'function',
			target: functionBreakpoint.name
		};
		if (functionBreakpoint.condition) {
			args.condition = functionBreakpoint.condition;
		}

		return this._node.setBreakpoint(args).then(resp => {
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

		let all = false;
		let uncaught = false;
		this._catchRejects = false;

		const filters = args.filters;
		if (filters) {
			all = filters.indexOf('all') >= 0;
			uncaught = filters.indexOf('uncaught') >= 0;
			this._catchRejects = filters.indexOf('rejects') >= 0;
		}

		Promise.all([
			this._node.setExceptionBreak({ type: 'all', enabled: all }),
			this._node.setExceptionBreak({ type: 'uncaught', enabled: uncaught })
		]).then(r => {
			this.sendResponse(response);
		}).catch(err => {
			this.sendErrorResponse(response, 2024, 'Configuring exception break options failed ({_nodeError}).', { _nodeError: err.message }, ErrorDestination.Telemetry);
		});
	}

	//--- configuration done request ------------------------------------------------------------------------------------------

	protected configurationDoneRequest(response: DebugProtocol.ConfigurationDoneResponse, args: DebugProtocol.ConfigurationDoneArguments): void {

		// all breakpoints are configured now -> start debugging

		let info = 'nothing to do';

		if (this._needContinue) {	// we do not break on entry
			this._needContinue = false;
			info = 'do a \'Continue\'';
			this._node.command('continue');
		}

		if (this._needBreakpointEvent) {	// we have to break on entry
			this._needBreakpointEvent = false;
			info = 'fire breakpoint event';
			this._sendBreakpointStoppedEvent(1); 	// we know the ID of the entry point breakpoint
		}

		if (this._needDebuggerEvent) {	// we have to break on entry
			this._needDebuggerEvent = false;
			info = 'fire debugger statement event';
			this._sendStoppedEvent('debugger_statement');
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
							threads.push(new Thread(id, `Thread (id: ${id})`));
						}
					}
				}
			}
			if (threads.length === 0) { // always return at least one thread
				let name = NodeDebugSession.DUMMY_THREAD_NAME;
				if (this._nodeProcessId > 0 && this._node.hostVersion) {
					name = `${name} (${this._nodeProcessId}, ${this._node.hostVersion})`;
				} else if (this._nodeProcessId > 0) {
					name = `${name} (${this._nodeProcessId})`;
				} else if (this._node.hostVersion) {
					name = `${name} (${this._node.hostVersion})`;
				}
				threads.push(new Thread(NodeDebugSession.DUMMY_THREAD_ID, name));
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
		const startFrame = typeof args.startFrame === 'number' ? args.startFrame : 0;
		const maxLevels = typeof args.levels === 'number' ? args.levels : 10;

		let totalFrames = 0;

		if (threadReference !== NodeDebugSession.DUMMY_THREAD_ID) {
			this.sendErrorResponse(response, 2014, 'Unexpected thread reference {_thread}.', { _thread: threadReference }, ErrorDestination.Telemetry);
			return;
		}

		const backtraceArgs : V8BacktraceArgs = {
			fromFrame: startFrame,
			toFrame: startFrame+maxLevels
		};

		this.log('va', `stackTraceRequest: backtrace ${startFrame} ${maxLevels}`);
		this._node.backtrace(backtraceArgs).then(response => {

			if (response.body.totalFrames > 0 || response.body.frames) {
				const frames = response.body.frames;
				totalFrames = response.body.totalFrames;
				return Promise.all<StackFrame>(frames.map(frame => this._createStackFrame(frame)));
			} else {
				throw new Error('no stack');
			}

		}).then(stackframes => {

			response.body = {
				stackFrames: stackframes,
				totalFrames: totalFrames
			};
			this.sendResponse(response);

		}).catch(error => {

			if (error.message === 'no stack') {
				if (this._stoppedReason === 'pause') {
					this.sendErrorResponse(response, 2022, localize('VSND2022', "No call stack because program paused outside of JavaScript."));
				} else {
					this.sendErrorResponse(response, 2023, localize('VSND2023', "No call stack available."));
				}
			} else {
				this.sendErrorResponse(response, 2018, localize('VSND2018', "No call stack available ({_command}: {_error})."), { _command: error.command, _error: error.message } );
			}

		});
	}

	/**
	 * Create a single stack frame.
	 */
	private _createStackFrame(frame: V8Frame) : Promise<StackFrame> {

		// resolve some refs
		return this._resolveValues([ frame.script, frame.func, frame.receiver ]).then(() => {

			let line = frame.line;
			let column = this._adjustColumn(line, frame.column);

			let src: Source | undefined;

			let origin = localize('origin.from.node', "read-only content from Node.js");

			const script_val = <V8Script> this._getValueFromCache(frame.script);
			if (script_val) {
				let name = script_val.name;
				let path: string | undefined;

				if (name) {

					if (this._mapToFilesOnDisk) {

						// try to map the script to a file in the workspace

						// first convert urls to paths
						const u = URL.parse(name);
						if (u.protocol === 'file:' && u.path) {
							// a local file path
							name = decodeURI(u.path);
						}

						// we can only map absolute paths
						if (PathUtils.isAbsolutePath(name)) {

							// with remote debugging path might come from a different OS
							let remotePath = name;

							// if launch.json defines localRoot and remoteRoot try to convert remote path back to a local path
							let localPath = this._remoteToLocal(remotePath);
							if (localPath !== remotePath && this._attachMode) {
								// assume attached to remote node process
								origin = localize('origin.from.remote.node', "read-only content from remote Node.js");
							}

							// source mapping is enabled
							if (this._sourceMaps) {

								// load script to find source reference
								return this._loadScript(script_val.id).then(script => {
									return this._createStackFrameFromSourceMap(frame, script.contents, name, localPath, remotePath, origin, line, column);
								});
							}

							return this._createStackFrameFromPath(frame, name, localPath, remotePath, origin, line, column);
						}

						// if we end up here, 'name' is not a path and is an internal module
						path = this._scriptToPath(script_val);
						origin = localize('origin.core.module', "read-only core module");

					} else {
						// do not map the script to a file in the workspace
						// fall through
					}
				}

				if (!name) {

					if (typeof script_val.id !== 'number') {
						// if the script has not ID something is seriously wrong: give up.
						throw new Error('no script id');
					}

					// if a function is dynamically created from a string, its script has no name.
					path = this._scriptToPath(script_val);
					name = Path.basename(path);
				}

				// source not found locally -> prepare to stream source content from node backend.
				const sourceHandle = this._getScriptIdHandle(script_val.id);
				src = this._createSource(false, name, path, sourceHandle, origin);
			}

			return this._createStackFrameFromSource(frame, src, line, column);

		});
	}

	private _createSource(hasSource: boolean, name: string, path: string | undefined, sourceHandle: number = 0, origin?: string, data?: any): Source {

		let deemphasize = false;
		if (path && this.isSkipped(path)) {
			const skipFiles = localize('source.skipFiles', "skipped due to 'skipFiles'");
			deemphasize = true;
			origin = origin ? `${origin} (${skipFiles})` : skipFiles;
		} else if (!hasSource && this._smartStep && this._sourceMaps) {
			const smartStep = localize('source.smartstep', "skipped due to 'smartStep'");
			deemphasize = true;
			origin = origin ? `${origin} (${smartStep})` : smartStep;
		}

		// make sure to only use the basename of a path
		name = Path.basename(name);

		const src = new Source(name, path, sourceHandle, origin, data);

		if (deemphasize) {
			(<DebugProtocol.Source>src).presentationHint = 'deemphasize';
		}

		return src;
	}

	/**
	 * Creates a StackFrame when source maps are involved.
	 */
	private _createStackFrameFromSourceMap(frame: V8Frame, content: string, name: string, localPath: string, remotePath: string, origin: string, line: number, column: number) : Promise<StackFrame> {

		return this._sourceMaps.MapToSource(localPath, content, line, column).then(mapresult => {

			if (mapresult) {
				this.log('sm', `_createStackFrameFromSourceMap: gen: '${localPath}' ${line}:${column} -> src: '${mapresult.path}' ${mapresult.line}:${mapresult.column}`);

				return this._sameFile(mapresult.path, this._compareContents, 0, mapresult.content).then(same => {

					if (same) {
						// use this mapping
						const src = this._createSource(true, mapresult.path, this.convertDebuggerPathToClient(mapresult.path));
						return this._createStackFrameFromSource(frame, src, mapresult.line, mapresult.column);
					}

					// file doesn't exist at path: if source map has inlined source use it
					if (mapresult.content) {
						this.log('sm', `_createStackFrameFromSourceMap: source '${mapresult.path}' doesn't exist -> use inlined source`);
						const sourceHandle = this._getInlinedContentHandle(mapresult.content);
						origin = localize('origin.inlined.source.map', "read-only inlined content from source map");
						const src = this._createSource(true, mapresult.path, undefined, sourceHandle, origin, { inlinePath: mapresult.path });
						return this._createStackFrameFromSource(frame, src, mapresult.line, mapresult.column);
					}

					// no source found
					this.log('sm', `_createStackFrameFromSourceMap: gen: '${localPath}' ${line}:${column} -> can't find source -> use generated file`);
					return this._createStackFrameFromPath(frame, name, localPath, remotePath, origin, line, column);
				});
			}

			this.log('sm', `_createStackFrameFromSourceMap: gen: '${localPath}' ${line}:${column} -> couldn't be mapped to source -> use generated file`);
			return this._createStackFrameFromPath(frame, name, localPath, remotePath, origin, line, column);
		});
	}

	private _getInlinedContentHandle(content: string) {
		let handle = this._inlinedContentHandle.get(content);
		if (!handle) {
			handle = this._sourceHandles.create(new SourceSource(0, content));
			this._inlinedContentHandle.set(content, handle);
		}
		return handle;
	}

	/**
	 * Creates a StackFrame from the given local path.
	 * The remote path is used if the local path doesn't exist.
	 */
	private _createStackFrameFromPath(frame: V8Frame, name: string, localPath: string, remotePath: string, origin: string, line: number, column: number) : Promise<StackFrame> {

		const script_val = <V8Script> this._getValueFromCache(frame.script);
		const script_id = script_val.id;

		return this._sameFile(localPath, this._compareContents, script_id).then(same => {
			let src: Source;
			if (same) {
				// we use the file on disk
				src = this._createSource(false, name, this.convertDebuggerPathToClient(localPath));
			} else {
				// we use the script's content streamed from node
				const sourceHandle = this._getScriptIdHandle(script_id);
				src = this._createSource(false, name, undefined, sourceHandle, origin, { remotePath: remotePath });	// assume it is a remote path
			}
			return this._createStackFrameFromSource(frame, src, line, column);
		});
	}

	private _getScriptIdHandle(scriptId: number) {
		let handle = this._scriptId2Handle.get(scriptId);
		if (!handle) {
			handle = this._sourceHandles.create(new SourceSource(scriptId));
			this._scriptId2Handle.set(scriptId, handle);
		}
		return handle;
	}

	/**
	 * Creates a StackFrame with the given source location information.
	 * The name of the frame is extracted from the frame.
	 */
	private _createStackFrameFromSource(frame: V8Frame, src: Source | undefined, line: number, column: number) : StackFrame {

		const name = this._getFrameName(frame);
		const frameReference = this._frameHandles.create(frame);
		return new StackFrame(frameReference, name, src, this.convertDebuggerLineToClient(line), this.convertDebuggerColumnToClient(column));
	}

	private _getFrameName(frame: V8Frame) {
		let func_name: string | undefined;
		const func_val = <V8Function> this._getValueFromCache(frame.func);
		if (func_val) {
			func_name = func_val.inferredName;
			if (!func_name || func_name.length === 0) {
				func_name = func_val.name;
			}
		}
		if (!func_name || func_name.length === 0) {
			func_name = localize('anonymous.function', "(anonymous function)");
		}
		return func_name;
	}

	/**
	 * Returns true if a file exists at path.
	 * If compareContents is true and a script_id is given, _sameFile verifies that the
	 * file's content matches the script's content.
	 */
	private _sameFile(path: string, compareContents: boolean, script_id: number, content?: string) : Promise<boolean> {

		return this._existsFile(path).then(exists => {

			if (exists) {

				if (compareContents && (script_id || content)) {

					return Promise.all([
						this._readFile(path),
						content
							? Promise.resolve(content)
							: this._loadScript(script_id).then(script => script.contents)
					]).then(results => {
						let fileContents = results[0];
						let contents = results[1];

						// normalize EOL sequences
						contents = contents.replace(/\r\n/g, '\n');
						fileContents = fileContents.replace(/\r\n/g, '\n');

						// remove an optional shebang
						fileContents = fileContents.replace(/^#!.*\n/, '');

						// try to locate the file contents in the executed contents
						const pos = contents.indexOf(fileContents);
						return pos >= 0;

					}).catch(err => {
						return false;
					});
				}
				return true;

			}
			return false;
		});
	}

	/**
	 * Returns (and caches) the file contents of path.
	 */
	private _readFile(path: string) : Promise<string>  {

		path= PathUtils.normalizeDriveLetter(path);
		let file = this._files.get(path);

		if (!file) {

			this.log('ls', `__readFile: ${path}`);

			file = new Promise((completeDispatch, errorDispatch) => {
				FS.readFile(path, 'utf8', (err, fileContents) => {
					if (err) {
						errorDispatch(err);
					} else {
						completeDispatch(PathUtils.stripBOM(fileContents));
					}
				});
			});

			this._files.set(path, file);
		}

		return file;
	}

	/**
	 * a Promise based version of 'exists'
	 */
	private _existsFile(path: string) : Promise<boolean> {
		return new Promise((completeDispatch, errorDispatch) => {
			FS.exists(path, completeDispatch);
		});
	}

	//--- scopes request ------------------------------------------------------------------------------------------------------

	private static SCOPE_NAMES = [
		localize({ key: 'scope.global', comment: ['https://github.com/Microsoft/vscode/issues/4569'] }, "Global"),
		localize({ key: 'scope.local', comment: ['https://github.com/Microsoft/vscode/issues/4569'] }, "Local"),
		localize({ key: 'scope.with', comment: ['https://github.com/Microsoft/vscode/issues/4569'] }, "With"),
		localize({ key: 'scope.closure', comment: ['https://github.com/Microsoft/vscode/issues/4569'] }, "Closure"),
		localize({ key: 'scope.catch', comment: ['https://github.com/Microsoft/vscode/issues/4569'] }, "Catch"),
		localize({ key: 'scope.block', comment: ['https://github.com/Microsoft/vscode/issues/4569'] }, "Block"),
		localize({ key: 'scope.script', comment: ['https://github.com/Microsoft/vscode/issues/4569'] }, "Script")
	];

	protected scopesRequest(response: DebugProtocol.ScopesResponse, args: DebugProtocol.ScopesArguments): void {

		const frame = this._frameHandles.get(args.frameId);
		if (!frame) {
			this.sendErrorResponse(response, 2020, 'stack frame not valid', null, ErrorDestination.Telemetry);
			return;
		}
		const frameIx = frame.index;
		const frameThis = <V8Object> this._getValueFromCache(frame.receiver);

		const scopesArgs: any = {
			frame_index: frameIx,
			frameNumber: frameIx
		};
		let cmd = 'scopes';

		if (this._nodeInjectionAvailable) {
			cmd = 'vscode_scopes';
			scopesArgs.maxLocals = this._maxVariablesPerScope;
		}

		this.log('va', `scopesRequest: scope ${frameIx}`);
		this._node.command2(cmd, scopesArgs).then((scopesResponse: V8ScopeResponse) => {

			const scopes : V8Scope[] = scopesResponse.body.scopes;

			return Promise.all(scopes.map(scope => {
				const type = scope.type;
				const extra = type === 1 ? frameThis : undefined;
				let expensive = type === 0;	// global scope is expensive

				let scopeName: string;
				if (type >= 0 && type < NodeDebugSession.SCOPE_NAMES.length) {
					if (type === 1 && typeof scopesResponse.body.vscode_locals === 'number') {
						expensive = true;
						scopeName = localize({ key: 'scope.local.with.count', comment: ['https://github.com/Microsoft/vscode/issues/4569'] },
							"Local ({0} of {1})", scopesArgs.maxLocals, scopesResponse.body.vscode_locals);
					} else {
						scopeName = NodeDebugSession.SCOPE_NAMES[type];
					}
				} else {
					scopeName = localize('scope.unknown', "Unknown Scope Type: {0}", type);
				}

				return this._resolveValues( [ scope.object ] ).then(resolved => {
					const x = resolved[0];
					if (x) {
						return new Scope(scopeName, this._variableHandles.create(new ScopeContainer(scope, x, extra)), expensive);
					}
					return new Scope(scopeName, 0);
				}).catch(error => {
					return new Scope(scopeName, 0);
				});
			}));

		}).then(scopes => {

			// exception scope
			if (frameIx === 0 && this._exception) {
				const scopeName = localize({ key: 'scope.exception', comment: ['https://github.com/Microsoft/vscode/issues/4569'] }, "Exception");
				scopes.unshift(new Scope(scopeName, this._variableHandles.create(new PropertyContainer(undefined, this._exception.exception))));
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
		const variablesContainer = this._variableHandles.get(reference);

		if (variablesContainer) {
			const filter: FilterType = (args.filter === 'indexed' || args.filter === 'named') ? args.filter : 'all';
			variablesContainer.Expand(this, filter, args.start, args.count).then(variables => {
				variables.sort(NodeDebugSession.compareVariableNames);
				response.body = {
					variables: variables
				};
				this.sendResponse(response);
			}).catch(err => {
				// in case of error return empty variables array
				response.body = {
					variables: []
				};
				this.sendResponse(response);
			});
		} else {
			// no container found: return empty variables array
			response.body = {
				variables: []
			};
			this.sendResponse(response);
		}
	}

	/*
	 * Returns indexed or named properties for the given structured object as a variables array.
	 * There are three modes:
	 * 'all': add all properties (indexed and named)
	 * 'indexed': add 'count' indexed properties starting at 'start'
	 * 'named': add only the named properties.
	 */
	public _createProperties(evalName: string | undefined, obj: V8Object, mode: FilterType, start = 0, count?: number) : Promise<Variable[]> {

		if (obj && !obj.properties) {

			// if properties are missing, this is an indication that we are running injected code which doesn't return the properties for large objects

			if (this._nodeInjectionAvailable) {
				const handle = obj.handle;

				if (typeof obj.vscode_indexedCnt === 'number' && typeof handle === 'number' && handle !== 0) {

					if (count === undefined) {
						count = obj.vscode_indexedCnt;
					}

					const args = { handle, mode, start, count };

					return this._node.command2('vscode_slice', args).then(resp => {
						const items = resp.body.result;
						return Promise.all<Variable>(items.map(item => {
							return this._createVariable(evalName, item.name, item.value);
						}));
					});
				}
			}

			// if we end up here, something went wrong...
			return Promise.resolve([]);
		}

		const selectedProperties = new Array<V8Property>();

		let found_proto = false;
		if (obj.properties) {
			count = count || obj.properties.length;
			for (let property of obj.properties) {

				if ('name' in property) {	// bug #19654: only extract properties with a name

					const name = property.name;

					if (name === NodeDebugSession.PROTO) {
						found_proto = true;
					}

					switch (mode) {
						case 'all':
							selectedProperties.push(property);
							break;
						case 'named':
							if (!isIndex(name)) {
								selectedProperties.push(property);
							}
							break;
						case 'indexed':
							if (isIndex(name)) {
								const ix = +name;
								if (ix >= start && ix < start+count) {
									selectedProperties.push(property);
								}
							}
							break;
					}
				}
			}
		}

		// do we have to add the protoObject to the list of properties?
		if (!found_proto && (mode === 'all' || mode === 'named')) {
			const h = obj.handle;
			if (h > 0) {    // only add if not an internal debugger object
				(<any>obj.protoObject).name = NodeDebugSession.PROTO;
				selectedProperties.push(<V8Property>obj.protoObject);
			}
		}

		return this._createPropertyVariables(evalName, obj, selectedProperties);
	}

	/**
	 * Resolves the given properties and returns them as an array of Variables.
	 * If the properties are indexed (opposed to named), a value 'start' is added to the index number.
	 * If a value is undefined it probes for a getter.
	 */
	private _createPropertyVariables(evalName: string | undefined, obj: V8Object | null, properties: V8Property[], doPreview = true, start = 0) : Promise<Variable[]> {

		return this._resolveValues(properties).then(() => {
			return Promise.all<Variable>(properties.map(property => {
				const val = <V8Object> this._getValueFromCache(property);

				// create 'name'
				let name: string;
				if (isIndex(property.name)) {
					const ix = +property.name;
					name = `${start+ix}`;
				} else {
					name = <string> property.name;
				}

				// if value 'undefined' trigger a getter
				if (this._node.v8Version && val.type === 'undefined' && !val.value && obj && obj.handle >= 0) {

					const args = {
						expression: `obj['${name}']`,	// trigger call to getter
						additional_context: [
							{ name: 'obj', handle: obj.handle }
						],
						disable_break: true,
						maxStringLength: NodeDebugSession.MAX_STRING_LENGTH
					};

					this.log('va', `_createPropertyVariables: trigger getter`);
					return this._node.evaluate(args).then(response => {
						return this._createVariable(evalName, name, response.body, doPreview);
					}).catch(err => {
						return this._createVar(this._getEvaluateName(evalName, name), name, 'undefined');
					});

				} else {
					return this._createVariable(evalName, name, val, doPreview);
				}
			}));
		});
	}

	/**
	 * Create a Variable with the given name and value.
	 * For structured values the variable object will have a corresponding expander.
	 */
	public _createVariable(evalName: string | undefined, name: string, val: V8Handle, doPreview: boolean = true) : Promise<DebugProtocol.Variable> {

		/*
		if (!val) {
			return Promise.resolve(null);
		}
		*/

		if (!name) {
			name = '""';
		}

		const simple = <V8Simple> val;

		const en = this._getEvaluateName(evalName, name);

		switch (val.type) {

			case 'undefined':
			case 'null':
				return Promise.resolve(this._createVar(en, name, val.type));

			case 'string':
				return this._createStringVariable(evalName, name, val, doPreview ? undefined : NodeDebugSession.PREVIEW_MAX_STRING_LENGTH);
			case 'number':
				if (typeof simple.value === 'number') {
					return Promise.resolve(this._createVar(en, name, simple.value.toString()));
				}
				break;
			case 'boolean':
				if (typeof simple.value === 'boolean') {
					return Promise.resolve(this._createVar(en, name, simple.value.toString().toLowerCase()));	// node returns these boolean values capitalized
				}
				break;

			case 'set':
			case 'map':
				if (this._node.v8Version) {
					return this._createSetMapVariable(evalName, name, val);
				}
				// fall through and treat sets and maps as objects

			case 'object':
			case 'function':
			case 'regexp':
			case 'promise':
			case 'generator':
			case 'error':

				const object = <V8Object> val;
				let value = <string> object.className;

				switch (value) {

					case 'Array':
					case 'ArrayBuffer':
					case 'Int8Array': case 'Uint8Array': case 'Uint8ClampedArray':
					case 'Int16Array': case 'Uint16Array':
					case 'Int32Array': case 'Uint32Array':
					case 'Float32Array': case 'Float64Array':
						return this._createArrayVariable(evalName, name, val, doPreview);

					case 'RegExp':
						if (typeof object.text === 'string') {
							return Promise.resolve(this._createVar(en, name, object.text, this._variableHandles.create(new PropertyContainer(en, val))));
						}
						break;

					case 'Generator':
					case 'Object':
						return this._resolveValues(object.constructorFunction ? [object.constructorFunction] : [] ).then((resolved: V8Function[]) => {

							if (resolved.length > 0 && resolved[0]) {
								const constructor_name = <string>resolved[0].name;
								if (constructor_name) {
									value = constructor_name;
								}
							}

							if (val.type === 'promise' || val.type === 'generator') {
								if (object.status) {	// promises and generators have a status attribute
									value += ` { ${object.status} }`;
								}
							} else {

								if (object.properties) {
									return this._objectPreview(object, doPreview).then(preview => {
										if (preview) {
											value = `${value} ${preview}`;
										}
										return this._createVar(en, name, value, this._variableHandles.create(new PropertyContainer(en, val)));
									});
								}
							}

							return this._createVar(en, name, value, this._variableHandles.create(new PropertyContainer(en, val)));
						});
						//break;

					case 'Function':
					case 'Error':
					default:
						if (object.text) {
							let text = object.text;
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
				return Promise.resolve(this._createVar(en, name, value, this._variableHandles.create(new PropertyContainer(en, val))));

			case 'frame':
			default:
				break;
		}
		return Promise.resolve(this._createVar(en, name, simple.value ? simple.value.toString() : 'undefined'));
	}

	private _createVar(evalName: string | undefined, name: string, value: string, ref?: number, indexedVariables?: number, namedVariables?: number) {
		const v: DebugProtocol.Variable = new Variable(name, value, ref, indexedVariables, namedVariables);
		if (evalName) {
			v.evaluateName = evalName;
		}
		return v;
	}

	private _getEvaluateName(parentEvaluateName: string | undefined, name: string): string | undefined {

		if (parentEvaluateName === undefined) {
			return undefined;
		}

		if (!parentEvaluateName) {
			return name;
		}

		let nameAccessor: string;
		if (/^[a-zA-Z_$][a-zA-Z_$0-9]*$/.test(name)) {
			nameAccessor = '.' + name;
		} else if (/^\d+$/.test(name)) {
			nameAccessor = `[${name}]`;
		} else {
			nameAccessor = `[${JSON.stringify(name)}]`;
		}

		return parentEvaluateName + nameAccessor;
	}

	/**
	 * creates something like this: {a: 123, b: "hi", c: true …}
	 */
	private _objectPreview(object: V8Object, doPreview: boolean): Promise<string | null> {

		if (doPreview && object && object.properties && object.properties.length > 0) {

			const propcnt = object.properties.length;

			return this._createPropertyVariables(undefined, object, object.properties.slice(0, NodeDebugSession.PREVIEW_PROPERTIES), false).then(props => {

				let preview = '{';
				for (let i = 0; i < props.length; i++) {

					preview += `${props[i].name}: ${props[i].value}`;

					if (i < props.length-1) {
						preview += ', ';
					} else {
						if (propcnt > NodeDebugSession.PREVIEW_PROPERTIES) {
							preview += ' …';
						}
					}
				}
				preview += '}';

				return preview;
			});
		}

		return Promise.resolve(null);
	}

	/**
	 * creates something like this: [ 1, 2, 3 …]
	 */
	private _arrayPreview(array: V8Object, length: number, doPreview: boolean): Promise<string | null> {

		if (doPreview && array && array.properties && length > 0) {

			const previewProps = new Array<V8Property>();
			for (let i = 0; i < array.properties.length; i++) {
				const p = array.properties[i];
				if (isIndex(p.name)) {
					const ix = +p.name;
					if (ix >= 0 && ix < NodeDebugSession.PREVIEW_PROPERTIES) {
						previewProps.push(p);
						if (previewProps.length >= NodeDebugSession.PREVIEW_PROPERTIES) {
							break;
						}
					}
				}
			}

			return this._createPropertyVariables(undefined, array, previewProps, false).then(props => {

				let preview = '[';
				for (let i = 0; i < props.length; i++) {

					preview += `${props[i].value}`;

					if (i < props.length-1) {
						preview += ', ';
					} else {
						if (length > NodeDebugSession.PREVIEW_PROPERTIES) {
							preview += ' …';
						}
					}
				}
				preview += ']';

				return preview;
			});
		}

		return Promise.resolve(null);
	}

	//--- long array support

	private _createArrayVariable(evalName: string | undefined, name: string, array: V8Object, doPreview: boolean) : Promise<Variable> {

		return this._getArraySize(array).then(pair => {

			let indexedSize = 0;
			let namedSize = 0;
			let arraySize = '';

			if (pair.length >= 2) {
				indexedSize = pair[0];
				namedSize = pair[1];
				arraySize = indexedSize.toString();
			}

			return this._arrayPreview(array, indexedSize, doPreview).then(preview => {
				let v = `${array.className}[${arraySize}]`;
				if (preview) {
					v = `${v} ${preview}`;
				}
				const en = this._getEvaluateName(evalName, name);
				return this._createVar(en, name, v, this._variableHandles.create(new PropertyContainer(en, array)), indexedSize, namedSize);
			});
		});
	}

	private _getArraySize(array: V8Object) : Promise<number[]> {

		if (typeof array.vscode_indexedCnt === 'number' && typeof array.vscode_namedCnt === 'number') {
			return Promise.resolve([ array.vscode_indexedCnt, array.vscode_namedCnt ]);
		}

		if (this._node.v8Version) {

			const args = {
				expression: array.className === 'ArrayBuffer' ? `JSON.stringify([ array.byteLength, 1 ])` : `JSON.stringify([ array.length, Object.keys(array).length+1-array.length ])`,
				disable_break: true,
				additional_context: [
					{ name: 'array', handle: array.handle }
				]
			};

			this.log('va', `_getArraySize: array.length`);
			return this._node.evaluate(args).then(response => {
				return JSON.parse(<string>response.body.value);
			});
		}

		return Promise.resolve([]);
	}

	//--- ES6 Set/Map support

	private _createSetMapVariable(evalName: string | undefined, name: string, obj: V8Handle) : Promise<Variable> {

		const args = {
			// initially we need only the size
			expression: `JSON.stringify([ obj.size, Object.keys(obj).length ])`,
			disable_break: true,
			additional_context: [
				{ name: 'obj', handle: obj.handle }
			]
		};

		this.log('va', `_createSetMapVariable: ${obj.type}.size`);
		return this._node.evaluate(args).then(response => {

			const pair = JSON.parse(<string>response.body.value);
			const indexedSize = pair[0];
			const namedSize = pair[1];
			const typename = (obj.type === 'set') ? 'Set' : 'Map';
			const en = this._getEvaluateName(evalName, name);
			return this._createVar(en, name, `${typename}[${indexedSize}]`, this._variableHandles.create(new SetMapContainer(en, obj)), indexedSize, namedSize);
		});
	}

	public _createSetMapProperties(evalName: string | undefined, obj: V8Handle) : Promise<Variable[]> {

		const args = {
			expression: `var r = {}; Object.keys(obj).forEach(k => { r[k] = obj[k] }); r`,
			disable_break: true,
			additional_context: [
				{ name: 'obj', handle: obj.handle }
			]
		};

		return this._node.evaluate(args).then(response => {
			return this._createProperties(evalName, response.body, 'named');
		});
	}

	public _createSetElements(set: V8Handle, start: number, count: number) : Promise<Variable[]> {

		const args = {
			expression: `var r = [], i = 0; set.forEach(v => { if (i >= ${start} && i < ${start+count}) r.push(v); i++; }); r`,
			disable_break: true,
			additional_context: [
				{ name: 'set', handle: set.handle }
			]
		};

		this.log('va', `_createSetElements: set.slice ${start} ${count}`);
		return this._node.evaluate(args).then(response => {

			const properties = response.body.properties || [];
			const selectedProperties = new Array<V8Property>();

			for (let property of properties) {
				if (isIndex(property.name)) {
					selectedProperties.push(property);
				}
			}

			return this._createPropertyVariables(undefined, null, selectedProperties, true, start);
		});
	}

	public _createMapElements(map: V8Handle, start: number, count: number) : Promise<Variable[]> {

		// for each slot of the map we create three slots in a helper array: label, key, value
		const args = {
			expression: `var r=[],i=0; map.forEach((v,k) => { if (i >= ${start} && i < ${start+count}) { r.push(k+' → '+v); r.push(k); r.push(v);} i++; }); r`,
			disable_break: true,
			additional_context: [
				{ name: 'map', handle: map.handle }
			]
		};

		this.log('va', `_createMapElements: map.slice ${start} ${count}`);
		return this._node.evaluate(args).then(response => {

			const properties = response.body.properties || [];
			const selectedProperties = new Array<V8Property>();

			for (let property of properties) {
				if (isIndex(property.name)) {
					selectedProperties.push(property);
				}
			}

			return this._resolveValues(selectedProperties).then(() => {
				const variables = new Array<Variable>();
				for (let i = 0; i < selectedProperties.length; i += 3) {

					const key = <V8Object> this._getValueFromCache(selectedProperties[i+1]);
					const val = <V8Object> this._getValueFromCache(selectedProperties[i+2]);

					const expander = new Expander((start: number, count: number) => {
						return Promise.all<Variable>([
							this._createVariable(undefined, 'key', key),
							this._createVariable(undefined, 'value', val)
						]);
					});

					const x = <V8Object> this._getValueFromCache(selectedProperties[i]);
					variables.push(this._createVar(undefined, (start + (i/3)).toString(), <string> x.value, this._variableHandles.create(expander)));
				}
				return variables;
			});
		});
	}

	//--- long string support

	private _createStringVariable(evalName: string | undefined, name: string, val: V8Simple, maxLength: number | undefined) : Promise<Variable> {

		let str_val = <string>val.value;

		const en = this._getEvaluateName(evalName, name);

		if (typeof maxLength === 'number') {
			if (str_val.length > maxLength) {
				str_val = str_val.substr(0, maxLength) + '…';
			}
			return Promise.resolve(this._createVar(en, name, this._escapeStringValue(str_val)));
		}

		if (this._node.v8Version && NodeDebugSession.LONG_STRING_MATCHER.exec(str_val)) {

			const args = {
				expression: `str`,
				disable_break: true,
				additional_context: [
					{ name: 'str', handle: val.handle }
				],
				maxStringLength: NodeDebugSession.MAX_STRING_LENGTH
			};

			this.log('va', `_createStringVariable: get full string`);
			return this._node.evaluate(args).then(response => {
				str_val = <string> response.body.value;
				return this._createVar(en, name, this._escapeStringValue(str_val));
			});

		} else {
			return Promise.resolve(this._createVar(en, name, this._escapeStringValue(str_val)));
		}
	}

	private _escapeStringValue(s: string) {
		/* disabled for now because chrome dev tools doesn't escape quotes either
		if (s) {
			s = s.replace(/\"/g, '\\"');	// escape quotes because they are used as delimiters for a string
		}
		*/
		return `"${s}"`;
	}

	//--- setVariable request -------------------------------------------------------------------------------------------------

	protected setVariableRequest(response: DebugProtocol.SetVariableResponse, args: DebugProtocol.SetVariableArguments): void {
		const reference = args.variablesReference;
		const name = args.name;
		const value = args.value;
		const variablesContainer = this._variableHandles.get(reference);
		if (variablesContainer) {
			variablesContainer.SetValue(this, name, value).then(newVar => {
				const v: DebugProtocol.Variable = newVar;
				response.body = {
					value: v.value
				};
				if (v.type) {
					response.body.type = v.type;
				}
				if (v.variablesReference) {
					response.body.variablesReference = v.variablesReference;
				}
				if (typeof v.indexedVariables === 'number') {
					response.body.indexedVariables = v.indexedVariables;
				}
				if (typeof v.namedVariables === 'number') {
					response.body.namedVariables = v.namedVariables;
				}
				this.sendResponse(response);
			}).catch(err => {
				this.sendErrorResponse(response, 2004, err.message);
			});
		} else {
			this.sendErrorResponse(response, 2025, Expander.SET_VALUE_ERROR);
		}
	}

	public _setVariableValue(frame: number, scope: number, name: string, value: string) : Promise<Variable> {

		// first we are evaluating the new value

		const evalArgs = {
			expression: value,
			disable_break: true,
			maxStringLength: NodeDebugSession.MAX_STRING_LENGTH,
			frame: frame
		};

		return this._node.evaluate(evalArgs).then(evalResponse => {

			const args: V8SetVariableValueArgs = {
				scope: {
					frameNumber: frame,
					number: scope
				},
				name: name,
				newValue: evalResponse.body
			};

			return this._node.setVariableValue(args).then(response => {
				return this._createVariable(undefined, '_setVariableValue', response.body.newValue);
			});
		});
	}

	public _setPropertyValue(objHandle: number, propName: string, value: string) : Promise<Variable> {

		if (this._node.v8Version) {

			// we are doing the evaluation of the new value and the assignment to an object property in a single evaluate.

			const args = {
				global: true,
				expression: `obj['${propName}'] = ${value}`,
				disable_break: true,
				additional_context: [
					{ name: 'obj', handle: objHandle }
				],
				maxStringLength: NodeDebugSession.MAX_STRING_LENGTH
			};

			return this._node.evaluate(args).then(response => {
				return this._createVariable(undefined, '_setpropertyvalue', response.body);
			});
		}

		return Promise.reject(new Error(Expander.SET_VALUE_ERROR));
	}

	//--- pause request -------------------------------------------------------------------------------------------------------

	protected pauseRequest(response: DebugProtocol.PauseResponse, args: DebugProtocol.PauseArguments) : void {
		this._node.command('suspend', null, (nodeResponse) => {
			if (nodeResponse.success) {
				this._stopped('pause');
				this.sendResponse(response);
				this._sendStoppedEvent('pause');
			} else {
				this._sendNodeResponse(response, nodeResponse);
			}
		});
	}

	//--- continue request ----------------------------------------------------------------------------------------------------

	protected continueRequest(response: DebugProtocol.ContinueResponse, args: DebugProtocol.ContinueArguments): void {
		this._disableSkipFiles = false;
		this._node.command('continue', null, nodeResponse => {
			this._sendNodeResponse(response, nodeResponse);
		});
	}

	//--- step request --------------------------------------------------------------------------------------------------------

	protected nextRequest(response: DebugProtocol.NextResponse, args: DebugProtocol.NextArguments): void {
		this._node.command('continue', { stepaction: 'next' }, nodeResponse => {
			this._sendNodeResponse(response, nodeResponse);
		});
	}

	protected stepInRequest(response: DebugProtocol.StepInResponse, args: DebugProtocol.StepInArguments) : void {
		this._node.command('continue', { stepaction: 'in' }, nodeResponse => {
			this._sendNodeResponse(response, nodeResponse);
		});
	}

	protected stepOutRequest(response: DebugProtocol.StepOutResponse, args: DebugProtocol.StepOutArguments) : void {
		this._disableSkipFiles = false;
		this._node.command('continue', { stepaction: 'out' }, nodeResponse => {
			this._sendNodeResponse(response, nodeResponse);
		});
	}

	protected stepBackRequest(response: DebugProtocol.StepBackResponse, args: DebugProtocol.StepBackArguments) : void {
 		this._node.command('continue', { stepaction: 'back' }, (nodeResponse) => {
 			this._sendNodeResponse(response, nodeResponse);
 		});
 	}

	protected reverseContinueRequest(response: DebugProtocol.ReverseContinueResponse, args: DebugProtocol.ReverseContinueArguments) : void {
		this._disableSkipFiles = false;
 		this._node.command('continue', { stepaction: 'reverse' }, (nodeResponse) => {
 			this._sendNodeResponse(response, nodeResponse);
 		});
 	}

	protected restartFrameRequest(response: DebugProtocol.RestartFrameResponse, args: DebugProtocol.RestartFrameArguments) : void {

		const restartFrameArgs: V8RestartFrameArgs = {
			frame: undefined
		};

		if (args.frameId > 0) {
			const frame = this._frameHandles.get(args.frameId);
			if (!frame) {
				this.sendErrorResponse(response, 2020, 'stack frame not valid', null, ErrorDestination.Telemetry);
				return;
			}
			restartFrameArgs.frame = frame.index;
		}

		this._node.command('restartFrame', restartFrameArgs, restartNodeResponse => {
			this._restartFramePending= true;
			this._node.command('continue', { stepaction: 'in' }, stepInNodeResponse => {
				this._sendNodeResponse(response, stepInNodeResponse);
			});
		});
 	}

	//--- evaluate request ----------------------------------------------------------------------------------------------------

	protected evaluateRequest(response: DebugProtocol.EvaluateResponse, args: DebugProtocol.EvaluateArguments): void {

		const expression = args.expression;

		const evalArgs = {
			expression: expression,
			disable_break: true,
			maxStringLength: NodeDebugSession.MAX_STRING_LENGTH
		};
		if (typeof args.frameId === 'number' && args.frameId > 0) {
			const frame = this._frameHandles.get(args.frameId);
			if (!frame) {
				this.sendErrorResponse(response, 2020, 'stack frame not valid', null, ErrorDestination.Telemetry);
				return;
			}
			const frameIx = frame.index;
			(<any>evalArgs).frame = frameIx;
		} else {
			(<any>evalArgs).global = true;
		}

		this._node.command(this._nodeInjectionAvailable ? 'vscode_evaluate' : 'evaluate', evalArgs, (resp: V8EvaluateResponse) => {
			if (resp.success) {
				this._createVariable(undefined, 'evaluate', resp.body).then(v => {
					if (v) {
						response.body = {
							result: v.value,
							variablesReference: v.variablesReference,
							namedVariables: v.namedVariables,
							indexedVariables: v.indexedVariables
						};
					} else {
						response.success = false;
						response.message = localize('eval.not.available', "not available");
					}
					this.sendResponse(response);
				});
			} else {
				response.success = false;
				if (resp.message.indexOf('ReferenceError: ') === 0 || resp.message === 'No frames') {
					response.message = localize('eval.not.available', "not available");
				} else if (resp.message.indexOf('SyntaxError: ') === 0) {
					const m = resp.message.substring('SyntaxError: '.length).toLowerCase();
					response.message = localize('eval.invalid.expression', "invalid expression: {0}", m);
				} else {
					response.message = resp.message;
				}
				this.sendResponse(response);
			}
		});
	}

	//--- source request ------------------------------------------------------------------------------------------------------

	protected sourceRequest(response: DebugProtocol.SourceResponse, args: DebugProtocol.SourceArguments): void {

		// first try to use 'source.sourceReference'
		if (args.source && args.source.sourceReference) {
			this.sourceRequest2(response, args.source.sourceReference);
			return;
		}

		// then try to use 'source.path'
		if (args.source && args.source.path) {

			this._loadScript(this._pathToScript(args.source.path)).then(script => {
				response.body = {
					content: script.contents,
					mimeType: 'text/javascript'
				};
				this.sendResponse(response);
			}).catch(err => {
				this.sendErrorResponse(response, 2026, localize('source.not.found', "Could not retrieve content."));
			});

			return;
		}

		// try to use 'sourceReference'
		return this.sourceRequest2(response, args.sourceReference);
	}

	private sourceRequest2(response: DebugProtocol.SourceResponse, sourceReference: number): void {

		// try to use 'sourceReference'
		const srcSource = this._sourceHandles.get(sourceReference);
		if (srcSource) {

			if (srcSource.source) {		// script content already cached
				response.body = {
					content: srcSource.source,
					mimeType: 'text/javascript'
				};
				this.sendResponse(response);
				return;
			}

			if (srcSource.scriptId) {	// load script content
				this._loadScript(srcSource.scriptId).then(script => {
					srcSource.source = script.contents;	// store in cache
					response.body = {
						content: srcSource.source,
						mimeType: 'text/javascript'
					};
					this.sendResponse(response);
				}).catch(err => {
					this.sendErrorResponse(response, 2026, localize('source.not.found', "Could not retrieve content."));
				});
				return;
			}
		}

		// give up
		this.sendErrorResponse(response, 2027, 'sourceRequest error: illegal handle', null, ErrorDestination.Telemetry);
	}

	private _loadScript(scriptIdOrPath: number | string) : Promise<Script> {

		if (typeof scriptIdOrPath === 'number') {

			let script = this._scripts.get(scriptIdOrPath);

			if (!script) {

				this.log('ls', `_loadScript: ${scriptIdOrPath}`);

				// not found
				const args = {
					types: 4,
					includeSource: true,
					ids: [ scriptIdOrPath ]
				};

				script = this._node.scripts(args).then(nodeResponse => {
					return new Script(nodeResponse.body[0]);
				});

				this._scripts.set(scriptIdOrPath, script);
			}

			return script;

		} else {
			// scriptIdOrPath is path
			this.log('ls', `_loadScript: ${scriptIdOrPath}`);

			// not found
			const args = {
				types: 4,
				includeSource: true,
				filter: scriptIdOrPath
			};

			return this._node.scripts(args).then(nodeResponse => {
				for (let result of nodeResponse.body) {
					if (result.name === scriptIdOrPath) {	// return the first exact match
						return new Script(result);
					}
				}
				throw new Error(`script ${scriptIdOrPath} not found`);
			});
		}
	}

	//--- completions request -------------------------------------------------------------------------------------------------

	protected completionsRequest(response: DebugProtocol.CompletionsResponse, args: DebugProtocol.CompletionsArguments): void {

		const line = args.text;
		const column = args.column;

		const prefix = line.substring(0, column);

		let expression: string | undefined;
		let dot = prefix.lastIndexOf('.');
		if (dot >= 0) {
			const rest = prefix.substr(dot+1);	// everything between the '.' and the cursor
			if (rest.length === 0 || NodeDebugSession.PROPERTY_NAME_MATCHER.test(rest)) { // empty or proper attribute name
				expression = prefix.substr(0, dot);
			}
		}

		if (expression) {

			const evalArgs = {
				expression: `(function(x){var a=[];for(var o=x;o;o=o.__proto__){a.push(Object.getOwnPropertyNames(o))};return JSON.stringify(a)})(${expression})`,
				disable_break: true,
				maxStringLength: NodeDebugSession.MAX_JSON_LENGTH
			};

			if (typeof args.frameId === 'number' && args.frameId > 0) {

				const frame = this._frameHandles.get(args.frameId);
				if (!frame) {
					this.sendErrorResponse(response, 2020, 'stack frame not valid', null, ErrorDestination.Telemetry);
					return;
				}

				const frameIx = frame.index;
				(<any>evalArgs).frame = frameIx;
			} else {
				(<any>evalArgs).global = true;
			}

			this._node.evaluate(evalArgs).then(resp => {

				const set = new Set<string>();
				const items = new Array<DebugProtocol.CompletionItem>();

				let arrays = <string[]> JSON.parse(<string>resp.body.value);

				for (let i= 0; i < arrays.length; i++) {
					for (let name of arrays[i]) {
						if (!isIndex(name) && !set.has(name)) {
							set.add(name);

							const pi: DebugProtocol.CompletionItem = {
								label: name,
								type: 'property'
							};
							if (!NodeDebugSession.PROPERTY_NAME_MATCHER.test(name)) {
								// we cannot use dot notation
								pi.text = `['${name}']`;
								if (dot > 0) {
									// specify a range starting with the '.' and extending to the end of the line
									// which will be replaced by the completion proposal.
									pi.start = dot;
									pi.length = line.length - dot;
								}
							}

							items.push(pi);
						}
					}
				}

				response.body = {
					targets: items
				};
				this.sendResponse(response);

			}).catch(err => {

				response.body = {
					targets: []
				};
				this.sendResponse(response);
			});

		} else {

			if (prefix[prefix.length-1] === ')') {
				response.body = {
					targets: []
				};
				this.sendResponse(response);
				return;
			}

			let frame: V8Frame | undefined;
			if (typeof args.frameId === 'number' && args.frameId > 0) {
				frame = this._frameHandles.get(args.frameId);
			}
			if (!frame) {
				this.sendErrorResponse(response, 2020, 'stack frame not valid', null, ErrorDestination.Telemetry);
				return;
			}

			this.scopesRequest2(frame).then(targets => {

				response.body = {
					targets: targets
				};
				this.sendResponse(response);

			}).catch(err => {

				response.body = {
					targets: []
				};
				this.sendResponse(response);
			});
		}
	}

	protected scopesRequest2(frame: V8Frame): Promise<DebugProtocol.CompletionItem[]> {

		const frameIx = frame.index;

		const scopesArgs: any = {
			frame_index: frameIx,
			frameNumber: frameIx
		};

		return this._node.command2('scopes', scopesArgs).then(scopesResponse => {

			const scopes = scopesResponse.body.scopes;
			return this._resolveValues( scopes.map(scope => scope.object) ).then(resolved => {

				const set = new Set<string | number>();
				const items = new Array<DebugProtocol.CompletionItem>();
				for (let r of resolved) {
					if (r && r.properties) {
						for (let property of r.properties) {
							if (!isIndex(property.name) && !set.has(property.name)) {
								set.add(property.name);
								items.push({
									label: <string> property.name,
									type: 'function'
								});
							}
						}
					}
				}
				return items;
			});

		}).catch(error => {
			// in case of error return empty array
			return [];
		});
	}

	//--- exception info request ----------------------------------------------------------------------------------------------

	protected exceptionInfoRequest(response: DebugProtocol.ExceptionInfoResponse, args: DebugProtocol.ExceptionInfoArguments): void {

		if (args.threadId !== NodeDebugSession.DUMMY_THREAD_ID) {
			this.sendErrorResponse(response, 2030, 'exceptionInfoRequest error: invalid thread {_thread}.', { _thread: args.threadId }, ErrorDestination.Telemetry);
			return;
		}

		if (this._exception) {

			response.body = {
				exceptionId: 'undefined',
				breakMode: this._exception.uncaught ? 'unhandled' : 'never'
			};

			Promise.resolve(this._exception.exception).then(exception => {

				if (exception) {

					if (exception.className) {
						response.body.exceptionId = exception.className;
					} else if (exception.type) {
						response.body.exceptionId = exception.type;
					}
					if (exception.text) {
						response.body.description = exception.text;
					}

					// try to retrieve the stack trace
					return this._createProperties(undefined, exception, 'named').then(values => {
						if (values.length > 0 && values[0].name === 'stack') {
							const stack = values[0].value;
							return stack === 'undefined' ? undefined : stack;
						}
						return undefined;
					}).catch(_ => {
						return undefined;
					});

				} else {
					return undefined;
				}

			}).then((stack: string | undefined) => {

				if (stack) {

					// remove quotes
					if (stack.length > 1 && stack[0] === '"' && stack[stack.length-1] === '"') {
						stack = stack.substr(1, stack.length-2);
					}

					// don't return description if it is already part of the stack trace.
					if (response.body.description && stack.indexOf(response.body.description) === 0) {
						delete response.body.description;
					}

					response.body.details = {
						stackTrace: stack
					};
				}

				this.sendResponse(response);

			}).catch(resp => {
				this.sendErrorResponse(response, 2031, 'exceptionInfoRequest error', undefined, ErrorDestination.Telemetry);
			});

		} else {
			this.sendErrorResponse(response, 2032, 'exceptionInfoRequest error: no stored exception', undefined, ErrorDestination.Telemetry);
		}
	}

	//--- loaded sources request ----------------------------------------------------------------------------------------------

	protected loadedSourcesRequest(response: DebugProtocol.LoadedSourcesResponse, args: DebugProtocol.LoadedSourcesArguments) {

		this._node.scripts({ types: 4 }).then(resp => {
			const sources = resp.body.map(script => this._scriptToSource(script));
			Promise.all(sources).then(result => {
				response.body = { sources: result };
				this.sendResponse(response);
			});
		}).catch(err => {
			this.sendErrorResponse(response, 9999, `scripts error: ${err}`);
		});
	}

	//--- custom request ------------------------------------------------------------------------------------------------------

	/**
	 * Handle custom requests.
	 */
	protected customRequest(command: string, response: DebugProtocol.Response, args: any): void {

		switch (command) {
			case 'toggleSkipFileStatus':
				this.toggleSkippingResource(response, args.resource);
				break;
			default:
				super.customRequest(command, response, args);
				break;
		}
	}

	//---- private helpers ----------------------------------------------------------------------------------------------------

	public log(traceCategory: string, message: string) {
		if (this._trace && (this._traceAll || this._trace.indexOf(traceCategory) >= 0)) {
			this.outLine(`${process.pid}: ${message}`);
		}
	}

	/**
	 * 'Path does not exist' error
	 */
	private sendNotExistErrorResponse(response: DebugProtocol.Response, attribute: string, path: string) {
		this.sendErrorResponse(response, 2007, localize('attribute.path.not.exist', "Attribute '{0}' does not exist ('{1}').", attribute, '{path}'), { path: path });
	}

	/**
	 * 'Path not absolute' error with 'More Information' link.
	 */
	private sendRelativePathErrorResponse(response: DebugProtocol.Response, attribute: string, path: string) {

		const format = localize('attribute.path.not.absolute', "Attribute '{0}' is not absolute ('{1}'); consider adding '{2}' as a prefix to make it absolute.", attribute, '{path}', '${workspaceFolder}/');
		this.sendErrorResponseWithInfoLink(response, 2008, format, { path: path }, 20003);
	}

	/**
	 * Send error response with 'More Information' link.
	 */
	private sendErrorResponseWithInfoLink(response: DebugProtocol.Response, code: number, format: string, variables: any, infoId: number) {

		this.sendErrorResponse(response, <DebugProtocol.Message> {
			id: code,
			format: format,
			variables: variables,
			showUser: true,
			url: 'http://go.microsoft.com/fwlink/?linkID=534832#_' + infoId.toString(),
			urlLabel: localize('more.information', "More Information")
		});
	}

	/**
	 * send a line of text to the 'console' channel.
	 */
	private outLine(message: string) {
		this.sendEvent(new OutputEvent(message + '\n', 'console'));
	}

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
				this.sendErrorResponse(response, 2015, localize('VSND2015', "Request '{_request}' was cancelled because Node.js is unresponsive."), { _request: nodeResponse.command } );
			} else if (errmsg.indexOf('timeout') >= 0) {
				this.sendErrorResponse(response, 2016, localize('VSND2016', "Node.js did not respond to request '{_request}' in a reasonable amount of time."), { _request: nodeResponse.command } );
			} else {
				this.sendErrorResponse(response, 2013, 'Node.js request \'{_request}\' failed (reason: {_error}).', { _request: nodeResponse.command, _error: errmsg }, ErrorDestination.Telemetry);
			}
		}
	}

	private _cache(handle: number, obj: V8Object): void {
		this._refCache.set(handle, obj);
	}

	private _getValueFromCache(container: V8Ref): V8Handle | null {
		const value = this._refCache.get(container.ref);
		if (value) {
			return value;
		}
		// console.error('ref not found cache');
		return null;
	}

	private _resolveValues(mirrors: V8Ref[]) : Promise<(V8Object | null)[]> {

		const needLookup = new Array<number>();
		for (let mirror of mirrors) {
			if (!mirror.value && mirror.ref) {
				if (needLookup.indexOf(mirror.ref) < 0) {
					needLookup.push(mirror.ref);
				}
			}
		}

		if (needLookup.length > 0) {
			return this._resolveToCache(needLookup).then(() => {
				return mirrors.map(m => this._getCache(m));
			});
		} else {
			//return Promise.resolve(<V8Object[]>mirrors);
			return Promise.resolve(mirrors.map(m => this._getCache(m)));
		}
	}

	private _getCache(m: V8Ref): V8Object | null {
		if (typeof m.ref === 'number') {
			const r = this._refCache.get(m.ref);
			return r === undefined ? null : r;
		}
		if (typeof m.handle === 'number') {
			const r = this._refCache.get(m.handle);
			return r === undefined ? null : r;
		}
		return null;
	}

	private _resolveToCache(handles: number[]) : Promise<(V8Object | undefined)[]> {

		const lookup = new Array<number>();

		for (let handle of handles) {
			const val = this._refCache.get(handle);
			if (!val) {
				if (handle >= 0) {
					lookup.push(handle);
				} else {
					// console.error('shouldn't happen: cannot lookup transient objects');
				}
			}
		}

		if (lookup.length > 0) {
			const cmd = this._nodeInjectionAvailable ? 'vscode_lookup' : 'lookup';
			this.log('va', `_resolveToCache: ${cmd} ${lookup.length} handles`);
			return this._node.command2(cmd, { handles: lookup }).then(resp => {

				for (let key in resp.body) {
					const obj = resp.body[key];
					const handle: number = obj.handle;
					this._cache(handle, obj);
				}

				return handles.map(handle => this._refCache.get(handle));

			}).catch(resp => {

				let val: any;
				if (resp.message.indexOf('timeout') >= 0) {
					val = { type: 'number', value: '<...>' };
				} else {
					val = { type: 'number', value: `<data error: ${resp.message}>` };
				}

				// store error value in cache
				for (let i = 0; i < handles.length; i++) {
					const handle = handles[i];
					const r = this._refCache.get(handle);
					if (!r) {
						this._cache(handle, val);
					}
				}

				return handles.map(handle => this._refCache.get(handle));
			});
		} else {
			return Promise.resolve(handles.map(handle => this._refCache.get(handle)));
		}
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

	/**
	 * Returns script ID for the given script name or ID (or -1 if not found).
	 */
	private _findScript(scriptIdOrPath: number | string) : Promise<number> {

		if (typeof scriptIdOrPath === 'number') {
			return Promise.resolve(scriptIdOrPath);
		}

		const args = {
			types: 4,
			filter: scriptIdOrPath
		};

		return this._node.scripts(args).then(resp => {
			for (let result of resp.body) {
				if (result.name === scriptIdOrPath) {	// return the first exact match
					return result.id;
				}
			}
			return -1;	// not found
		}).catch(err => {
			return -1;	// error
		});
	}

	//---- private static ---------------------------------------------------------------

	private static isJavaScript(path: string): boolean {

		const ext = Path.extname(path).toLowerCase();
		if (ext) {
			if (NodeDebugSession.JS_EXTENSIONS.indexOf(ext) >= 0) {
				return true;
			}
		} else {
			if (Path.basename(path).toLowerCase() === 'www') {
				return true;
			}
		}

		// look inside file
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
			return s.substring(1, s.length - 1);
		}
		return s;
	}

	private static killTree(processId: number): void {

		if (process.platform === 'win32') {

			const TASK_KILL = Path.join(process.env['SystemRoot'] || 'C:\\WINDOWS', 'System32', 'taskkill.exe');

			// when killing a process in Windows its child processes are *not* killed but become root processes.
			// Therefore we use TASKKILL.EXE
			try {
				CP.execSync(`${TASK_KILL} /F /T /PID ${processId}`);
			}
			catch (err) {
			}
		} else {

			// on linux and OS X we kill all direct and indirect child processes as well
			try {
				const cmd = Path.join(__dirname, 'terminateProcess.sh');
				CP.spawnSync(cmd, [ processId.toString() ]);
			} catch (err) {
			}
		}
	}
}

const INDEX_PATTERN = /^(0|[1-9][0-9]*)$/;	// 0, 1, 2, ... are indexes but not 007

function isIndex(name: string | number) {
	switch (typeof name) {
		case 'number':
			return true;
		case 'string':
			return INDEX_PATTERN.test(<string>name);
		default:
			return false;
	}
}

const LOGMESSAGE_VARIABLE_REGEXP = /{(.*?)}/g;

function logMessageToExpression(msg: string) {

	msg = msg.replace(/%/g, '%%');

	let args: string[] = [];
	let format = msg.replace(LOGMESSAGE_VARIABLE_REGEXP, (match, group) => {
		const a = group.trim();
		if (a) {
			args.push(`(${a})`);
			return '%s';
		} else {
			return '';
		}
	});

	format = format.replace(/'/g, '\\\'');

	if (args.length > 0) {
		return `console.log('${format}', ${args.join(', ')})`;
	}
	return `console.log('${format}')`;
}

function findport(): Promise<number> {
	return new Promise((c, e) => {
		let port = 0;
		const server = Net.createServer();
		server.on('listening', _ => {
			const ai = server.address();
			if (typeof ai === 'object') {
				port = ai.port;
			}
			server.close();
		});
		server.on('close', () => c(port));
		server.on('error', err => e(err));
		server.listen(0, '127.0.0.1');
	});
}

DebugSession.run(NodeDebugSession);
