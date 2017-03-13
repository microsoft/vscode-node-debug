/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import {
	DebugSession, Thread, Source, StackFrame, Scope, Variable, Breakpoint,
	TerminatedEvent, InitializedEvent, StoppedEvent, OutputEvent,
	Handles, ErrorDestination
} from 'vscode-debugadapter';
import {DebugProtocol} from 'vscode-debugprotocol';

import {
	NodeV8Protocol, NodeV8Event, NodeV8Response,
	V8SetBreakpointArgs, V8SetExceptionBreakArgs, V8SetVariableValueArgs, V8RestartFrameArgs,
	V8BacktraceResponse, V8ScopeResponse, V8EvaluateResponse, V8FrameResponse,
	V8EventBody,
	V8Ref, V8Handle, V8Property, V8Object, V8Simple, V8Function, V8Frame, V8Scope, V8Script
} from './nodeV8Protocol';
import {ISourceMaps, SourceMaps, SourceMap} from './sourceMaps';
import * as PathUtils from './pathUtilities';
import * as CP from 'child_process';
import * as Net from 'net';
import * as URL from 'url';
import * as Path from 'path';
import * as FS from 'fs';
import * as nls from 'vscode-nls';

const localize = nls.config(process.env.VSCODE_NLS_CONFIG)();

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

	private _object: V8Object;
	private _this: V8Object | undefined;

	public constructor(obj: V8Object, ths?: V8Object) {
		this._object = obj;
		this._this = ths;
	}

	public Expand(session: NodeDebugSession, filter: FilterType, start: number, count: number) : Promise<Variable[]> {

		if (filter === 'named') {
			return session._createProperties(this._object, 'named').then(variables => {
				if (this._this) {
					return session._createVariable('this', this._this).then(variable => {
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
			return session._createProperties(this._object, 'indexed', start, count);
		} else {
			return session._createProperties(this._object, 'all').then(variables => {
				if (this._this) {
					return session._createVariable('this', this._this).then(variable => {
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

	private _object: V8Object;

	public constructor(obj: V8Object) {
		this._object = obj;
	}

	public Expand(session: NodeDebugSession, filter: FilterType, start: number, count: number) : Promise<Variable[]> {

		if (filter === 'named') {
			return session._createSetMapProperties(this._object);
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
		return session._createProperties(this._object, filter).then(variables => {
			if (this._this) {
				return session._createVariable('this', this._this).then(variable => {
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

class StoppedEvent2 extends StoppedEvent {

	constructor(reason: ReasonType, threadId: number, exception_text?: string) {
		super(reason, threadId, exception_text);

		switch (reason) {
			case 'step':
				(<DebugProtocol.StoppedEvent>this).body.description = localize('reason.description.step', "Paused on step");
				break;
			case 'breakpoint':
				(<DebugProtocol.StoppedEvent>this).body.description = localize('reason.description.breakpoint', "Paused on breakpoint");
				break;
			case 'exception':
				(<DebugProtocol.StoppedEvent>this).body.description = localize('reason.description.exception', "Paused on exception");
				break;
			case 'pause':
				(<DebugProtocol.StoppedEvent>this).body.description = localize('reason.description.user_request', "Paused on user request");
				break;
			case 'entry':
				(<DebugProtocol.StoppedEvent>this).body.description = localize('reason.description.entry', "Paused on entry");
				break;
			case 'debugger_statement':
				(<DebugProtocol.StoppedEvent>this).body.description = localize('reason.description.debugger_statement', "Paused on debugger statement");
				break;
			case 'frame_entry':
				(<DebugProtocol.StoppedEvent>this).body.description = localize('reason.description.restart', "Paused on frame entry");
				break;
		}
	}
}

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

	constructor(line: number, column: number = 0, condition?: string, hitter?: HitterFunction) {
		this.line = this.orgLine = line;
		this.column = this.orgColumn = column;
		this.condition = condition;
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
	 * 'eh': extensionhost flow
	 * */
	trace?: string;
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

	// unofficial flags

	/** Step back supported. */
	stepBack?: boolean;
	/** Control mapping of node.js scripts to files on disk. */
	mapToFilesOnDisk?: boolean;
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
	env?: { [key: string]: string; };
	/** Optional path to .env file. */
	envFile?: string;
	/** Deprecated: if true launch the target in an external console. */
	externalConsole?: boolean;
	/** Where to launch the debug target. */
	console?: ConsoleType;
}

/**
 * This interface should always match the schema found in the node-debug extension manifest.
 */
interface AttachRequestArguments extends DebugProtocol.AttachRequestArguments, CommonArguments {
	/** Node's root directory. */
	remoteRoot?: string;
	/** VS Code's root directory. */
	localRoot?: string;
	/** Send a USR1 signal to this process. */
	processId?: string;
}


export class NodeDebugSession extends DebugSession {

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

	private static NODE_SHEBANG_MATCHER = new RegExp('#! */usr/bin/env +node');
	private static LONG_STRING_MATCHER = /\.\.\. \(length: [0-9]+\)$/;
	private static HITCOUNT_MATCHER = /(>|>=|=|==|<|<=|%)?\s*([0-9]+)/;
	private static PROPERTY_NAME_MATCHER = /^[$_\w][$_\w0-9]*$/;

	// tracing
	private _trace: string[];
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
	private _adapterID: string;
	private _node: NodeV8Protocol;
	private _nodeProcessId: number = -1; 					// pid of the node runtime
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
	private _localRoot: string;
	private _remoteRoot: string | undefined;
	private _restartMode = false;
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
	private _exception: V8Object | undefined;
	private _lastStoppedEvent: DebugProtocol.StoppedEvent;
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
		super();

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
			this._handleNodeBreakEvent(event.body);
		});

		this._node.on('exception', (event: NodeV8Event) => {
			this._stopped('exception');
			this._handleNodeBreakEvent(event.body);
		});

		/*
		this._node.on('beforeCompile', (event: NodeV8Event) => {
			this.outLine(`beforeCompile ${event.body.name}`);
		});

		this._node.on('afterCompile', (event: NodeV8Event) => {
			this.outLine(`afterCompile ${event.body.name}`);
		});
		*/

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
	private _handleNodeBreakEvent(eventBody: V8EventBody) : void {

		let isEntry = false;
		let reason: ReasonType | undefined;

		// in order to identify reject calls and debugger statements extract source at current location
		let source: string | null = null;
		if (eventBody.sourceLineText && typeof eventBody.sourceColumn === 'number') {
			source = eventBody.sourceLineText.substr(eventBody.sourceColumn);
		}

		// is exception?
		if (eventBody.exception) {

			if (this._skip(eventBody)) {
				this._node.command('continue');
				return;
			}

			// if this exception originates from a 'reject', skip it if 'All Exception' is not set.
			if (this._skipRejects && source && source.indexOf('reject') === 0) {
				if (!this._catchRejects) {
					this._node.command('continue');
					return;
				}
				if (eventBody.exception.text === 'undefined') {
					eventBody.exception.text = 'reject';
				}
			}

			// remember exception
			this._exception = eventBody.exception;
			this._handleNodeBreakEvent2('exception', isEntry, eventBody.exception.text);

			return;
		}

		// is breakpoint?
		if (!reason) {
			const breakpoints = eventBody.breakpoints;
			if (Array.isArray(breakpoints) && breakpoints.length > 0) {

				this._disableSkipFiles = this._skip(eventBody);

				const id = breakpoints[0];
				if (!this._gotEntryEvent && id === 1) {	// 'stop on entry point' is implemented as a breakpoint with id 1
					isEntry = true;
					this.log('la', '_analyzeBreak: suppressed stop-on-entry event');
					reason = 'entry';
					this._rememberEntryLocation(eventBody.script.name, eventBody.sourceLine, eventBody.sourceColumn);
				} else {
					let ibp = this._hitCounts.get(id);
					if (ibp) {
						ibp.hitCount++;
						if (ibp.hitter && !ibp.hitter(ibp.hitCount)) {
							this._node.command('continue');
							return;
						}
					}

					reason = 'breakpoint';
				}
			}
		}

		// is debugger statement?
		if (!reason) {
			if (source && source.indexOf('debugger') === 0) {
				reason = 'debugger_statement';
				this._gotDebuggerEvent = true;
			}
		}

		// no reason yet: must be the result of a 'step'
		if (!reason) {

			if (this._restartFramePending) {
				this._restartFramePending = false;
				reason = 'frame_entry';
			} else {
				reason = 'step';
			}

			if (!this._disableSkipFiles) {
				// should we continue until we find a better place to stop?
				if ((this._smartStep && this._sourceMaps) || this._skipFiles) {
					this._skipGenerated(eventBody).then(r => {
						if (r) {
							this._node.command('continue', { stepaction: 'in' });
							this._smartStepCount++;
						} else {
							this._handleNodeBreakEvent2(<ReasonType>reason, isEntry);
						}
					});
					return;
				}
			}
		}

		this._handleNodeBreakEvent2(reason, isEntry);
	}

	private _handleNodeBreakEvent2(reason: ReasonType, isEntry: boolean, exception_text?: string) {
		this._lastStoppedEvent = new StoppedEvent2(reason, NodeDebugSession.DUMMY_THREAD_ID, exception_text);

		if (!isEntry) {
			if (this._smartStepCount > 0) {
				this.log('ss', `_handleNodeBreakEvent: ${this._smartStepCount} steps skipped`);
				this._smartStepCount = 0;
			}
			this.sendEvent(this._lastStoppedEvent);
		}
	}

	/**
	 * Returns true if a source location of the given event should be skipped.
	 */
	private _skip(event: V8EventBody) : boolean {

		if (this._skipFiles) {

			let path = this._scriptNameToPath(event.script.name);
			if (path) {

				// if launch.json defines localRoot and remoteRoot try to convert remote path back to a local path
				let localPath = this._remoteToLocal(path);

				return PathUtils.multiGlobMatches(this._skipFiles, localPath);
			}
		}
		return false;
	}

	/**
	 * Returns true if a source location of the given event should be skipped.
	 */
	private _skipGenerated(event: V8EventBody) : Promise<boolean> {

		let path = this._scriptNameToPath(event.script.name);
		if (path) {

			// if launch.json defines localRoot and remoteRoot try to convert remote path back to a local path
			let localPath = this._remoteToLocal(path);

			if (this._skipFiles) {
				if (PathUtils.multiGlobMatches(this._skipFiles, localPath)) {
					return Promise.resolve(true);
				}
				return Promise.resolve(false);
			}

			// try to map
			let line = event.sourceLine;
			let column = this._adjustColumn(line, event.sourceColumn);

			return this._sourceMaps.MapToSource(localPath, null, line, column).then(mapresult => {
				return ! mapresult;
			});
		}

		// skip everything
		return Promise.resolve(true);
	}

	/**
	 * Special treatment for internal modules: we prepend '<internal>/'
	 */
	private _scriptNameToPath(scriptName: string): string {
		if (scriptName && !PathUtils.isAbsolutePath(scriptName)) {
			// scriptname is relative -> internal node module
			return `${NodeDebugSession.NODE_INTERNALS}/${scriptName}`;
		}
		return scriptName;
	}

	/**
	 * Special treatment for internal modules: we remove '<internal>/' or '<internal>\'
	 */
	private _pathToScript(path: string): string {
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
			if (this._restartMode && !this._inShutdown) {
				this.sendEvent(new TerminatedEvent(true));
			} else {
				this.sendEvent(new TerminatedEvent());
			}
		}
	}

	//---- initialize request -------------------------------------------------------------------------------------------------

	protected initializeRequest(response: DebugProtocol.InitializeResponse, args: DebugProtocol.InitializeRequestArguments): void {

		this.log('la', `initializeRequest: adapterID: ${args.adapterID}`);

		this._adapterID = args.adapterID;

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

		// This debug adapter supports setting variables
		response.body.supportsSetVariable = true;

		// This debug adapter supports the restartFrame request
		response.body.supportsRestartFrame = true;

		// This debug adapter supports the completions request
		response.body.supportsCompletionsRequest = true;

		this.sendResponse(response);
	}

	//---- launch request -----------------------------------------------------------------------------------------------------

	protected launchRequest(response: DebugProtocol.LaunchResponse, args: LaunchRequestArguments): void {

		if (this._processCommonArgs(response, args)) {
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

		const port = args.port || random(3000, 50000);

		let runtimeExecutable = args.runtimeExecutable;
		if (runtimeExecutable) {
			if (!Path.isAbsolute(runtimeExecutable)) {
				if (!PathUtils.isOnPath(runtimeExecutable)) {
					this.sendErrorResponse(response, 2001, localize('VSND2001', "Cannot find runtime '{0}' on PATH.", '{_runtime}'), { _runtime: runtimeExecutable });
					return;
				}
			} else if (!FS.existsSync(runtimeExecutable)) {
				this.sendNotExistErrorResponse(response, 'runtimeExecutable', runtimeExecutable);
				return;
			}
		} else {
			if (!PathUtils.isOnPath(NodeDebugSession.NODE)) {
				this.sendErrorResponse(response, 2001, localize('VSND2001', "Cannot find runtime '{0}' on PATH.", '{_runtime}'), { _runtime: NodeDebugSession.NODE });
				return;
			}
			runtimeExecutable = NodeDebugSession.NODE;     // use node from PATH
		}

		let runtimeArgs = args.runtimeArgs || [];
		const programArgs = args.args || [];

		// special code for 'extensionHost' debugging
		if (this._adapterID === 'extensionHost') {

			// we always launch in 'debug-brk' mode, but we only show the break event if 'stopOnEntry' attribute is true.
			let launchArgs = [ runtimeExecutable ];
			if (!this._noDebug) {
				if (typeof args.stopOnEntry === 'boolean' && args.stopOnEntry || programArgs.some(a => a.indexOf('--extensionTestsPath=') === 0)) {
					launchArgs.push(`--debugBrkPluginHost=${port}`);
				} else {
					launchArgs.push(`--debugPluginHost=${port}`);
				}
			}
			launchArgs = launchArgs.concat(runtimeArgs, programArgs);

			this.log('eh', `launchRequest: launching extensionhost`);
			this._sendLaunchCommandToConsole(launchArgs);

			let options;
			if (args.env) {
				options = {
					// merge environment variables into a copy of the process.env
					env: PathUtils.extendObject(PathUtils.extendObject( {}, process.env), args.env)
				};
			}

			const cmd = CP.spawn(runtimeExecutable, launchArgs.slice(1), options);
			cmd.on('error', (err) => {
				this._terminated(`failed to launch extensionHost (${err})`);
				this.log('eh', `launchRequest: failed to launch extensionHost: ${err}`);
			});
			this._captureOutput(cmd);

			// we are done!
			this.sendResponse(response);
			return;
		}


		let programPath = args.program;
		if (programPath) {
			if (!Path.isAbsolute(programPath)) {
				this.sendRelativePathErrorResponse(response, 'program', programPath);
				return;
			}
			if (!FS.existsSync(programPath)) {
				this.sendNotExistErrorResponse(response, 'program', programPath);
				return;
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
						this.launchRequest2(response, args, programPath, programArgs, <string> runtimeExecutable, runtimeArgs, port);
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
						this.sendErrorResponse(response, 2003, localize('VSND2003', "Cannot launch program '{0}'; setting the '{1}' attribute might help.", '{path}', 'outFiles'), { path: programPath });
						return;
					}
					this.log('sm', `launchRequest: program '${programPath}' seems to be the source; launch the generated file '${generatedPath}' instead`);
					programPath = generatedPath;
					this.launchRequest2(response, args, programPath, programArgs, <string> runtimeExecutable, runtimeArgs, port);
				});
				return;
			}
		}

		this.launchRequest2(response, args, programPath, programArgs, runtimeExecutable, runtimeArgs, port);
	}

	private launchRequest2(response: DebugProtocol.LaunchResponse, args: LaunchRequestArguments, programPath: string, programArgs: string[], runtimeExecutable: string, runtimeArgs: string[], port: number): void {

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

		// we always break on entry (but if user did not request this, we will not stop in the UI).
		let launchArgs = [ runtimeExecutable ];
		if (! this._noDebug && !args.port) {		// if a port is given, we assume that the '--debug-brk' option is specified elsewhere
			launchArgs.push(`--debug-brk=${port}`);
		}
		launchArgs = launchArgs.concat(runtimeArgs);
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
						let value = r[2] || '';
						if (value.length > 0 && value.charAt(0) === '"' && value.charAt(value.length-1) === '"') {
							value = value.replace(/\\n/gm, '\n');
						}
						env[r[1]] = value.replace(/(^['"]|['"]$)/g, '');
					}
				});
				envVars = PathUtils.extendObject(env, args.env); // launch config env vars overwrite .env vars
			} catch (e) {
				this.sendErrorResponse(response, 2029, localize('VSND2029', "Can't load environment variables from file ({0}).", '{_error}'), { _error: e.message });
				return;
			}
		}

		if (this._supportsRunInTerminalRequest && (this._console === 'externalTerminal' || this._console === 'integratedTerminal')) {

			const termArgs : DebugProtocol.RunInTerminalRequestArguments = {
				kind: this._console === 'integratedTerminal' ? 'integrated' : 'external',
				title: localize('node.console.title', "Node Debug Console"),
				cwd: <string> workingDirectory,
				args: launchArgs,
				env: envVars
			};

			this.runInTerminalRequest(termArgs, NodeDebugSession.RUNINTERMINAL_TIMEOUT, runResponse => {
				if (runResponse.success) {

					// since node starts in a terminal, we cannot track it with an 'exit' handler
					// plan for polling after we have gotten the process pid.
					this._pollForNodeProcess = true;

					if (this._noDebug) {
						this.sendResponse(response);
					} else {
						this._attach(response, port, address, timeout);
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

			const options = {
				cwd: workingDirectory,
				env: envVars
			};

			const nodeProcess = CP.spawn(runtimeExecutable, launchArgs.slice(1), options);
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

			this._nodeProcessId = nodeProcess.pid;

			this._captureOutput(nodeProcess);

			if (this._noDebug) {
				this.sendResponse(response);
			} else {
				this._attach(response, port, address, timeout);
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

		if (typeof args.trace === 'string') {
			this._trace = args.trace.split(',');
			this._traceAll = this._trace.indexOf('all') >= 0;
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
		if (typeof args.skipFiles) {
			this._skipFiles = args.skipFiles;
		}

		if (typeof args.stopOnEntry === 'boolean') {
			this._stopOnEntry = args.stopOnEntry;
		}

		if (typeof args.restart === 'boolean') {
			this._restartMode = args.restart;
		}

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

		if (this._adapterID === 'extensionHost') {
			// in EH mode 'attach' means 'launch' mode
			this._attachMode = false;
			this.log('eh', `attachRequest: args: ${JSON.stringify(args)}`);
		} else {
			this._attachMode = true;
		}

		if (args.localRoot) {
			const localRoot = args.localRoot;
			if (!Path.isAbsolute(localRoot)) {
				this.sendRelativePathErrorResponse(response, 'localRoot', localRoot);
				return;
			}
			if (!FS.existsSync(localRoot)) {
				this.sendNotExistErrorResponse(response, 'localRoot', localRoot);
				return;
			}
			this._localRoot = localRoot;
		}
		this._remoteRoot = args.remoteRoot;

		// if a processId is specified, try to bring the process into debug mode.
		if (typeof args.processId === 'string') {
			const pid_string = args.processId.trim();
			if (/^([0-9]+)$/.test(pid_string)) {
				const pid = Number(pid_string);
				try {
					if (process.platform === 'win32') {
						// regular node has an undocumented API function for forcing another node process into debug mode.
						// 		(<any>process)._debugProcess(pid);
						// But since we are running on Electron's node, process._debugProcess doesn't work (for unknown reasons).
						// So we use a regular node instead:
						const command = `node -e process._debugProcess(${pid})`;
						CP.execSync(command);

					} else {
						process.kill(pid, 'SIGUSR1');
					}
				} catch (e) {
					this.sendErrorResponse(response, 2021, localize('VSND2021', "Attach to process: cannot enable debug mode for process '{0}' ({1}).", pid, e));
					return;
				}
			} else {
				this.sendErrorResponse(response, 2006, localize('VSND2006', "Attach to process: '{0}' doesn't look like a process id.", pid_string));
				return;
			}
		}

		this._attach(response, args.port, args.address, args.timeout);
	}

	/*
	 * shared code used in launchRequest and attachRequest
	 */
	private _attach(response: DebugProtocol.Response, port: number, address: string | undefined, timeout: number | undefined): void {

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

		socket.on('connect', err => {
			this.log('la', '_attach: connected');
			connected = true;
			this._node.startDispatch(<NodeJS.ReadableStream>socket, socket);
			this._initialize(response);
		});

		const endTime = new Date().getTime() + timeout;
		socket.on('error', err => {
			if (connected) {
				// since we are connected this error is fatal
				this._terminated('socket error');
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
						this.sendErrorResponse(response, 2009, localize('VSND2009', "Cannot connect to runtime via 'legacy' protocol; consider using 'inspector' protocol (timeout after {0} ms).", '{_timeout}'), { _timeout: timeout });
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

	private _initialize(response: DebugProtocol.Response, retryCount: number = 0) : void {

		this._node.command('evaluate', { expression: 'process.pid', global: true }, (resp: V8EvaluateResponse) => {

			let ok = resp.success;
			if (resp.success && resp.body.value !== undefined) {
				this._nodeProcessId = +resp.body.value;
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

				setTimeout(() => {
					this._injectDebuggerExtensions().then(_ => {

						if (!this._stepBack) {
							// does runtime support 'step back'?
							const v = this._node.embeddedHostVersion;	// x.y.z version represented as (x*100+y)*100+z
							if (!this._node.v8Version && v >= 70000) {
								this._stepBack = true;
							}
						}

						if (this._stepBack) {
							response.body = {
								supportsStepBack: true
							};
						}

						this.sendResponse(response);
						this._startInitialize(!resp.running);
					});
				}, 10);

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
						global: false,
						disable_break: true
					};

					// first try evaluate against the current stack frame
					return this._node.evaluate(args).then(resp => {
						this.log('la', `_injectDebuggerExtensions: frame based code injection successful`);
						this._nodeInjectionAvailable = true;
						return true;
					}).catch(resp => {

						this.log('la', `_injectDebuggerExtensions: frame based code injection failed with error '${resp.message}'`);

						args.global = true;

						// evaluate globally
						return this._node.evaluate(args).then(resp => {
							this.log('la', `_injectDebuggerExtensions: global code injection successful`);
							this._nodeInjectionAvailable = true;
							return true;
						}).catch(resp => {
							this.log('la', `_injectDebuggerExtensions: global code injection failed with error '${resp.message}'`);
							return true;
						});

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

		// in attach-mode we don't know whether the debuggee has been launched in 'stop on entry' mode
		// so we use the stopped state of the VM
		if (this._attachMode) {
			this.log('la', `_startInitialize2: in attach mode we guess stopOnEntry flag to be '${stopped}''`);
			this._stopOnEntry = stopped;
		}

		if (this._stopOnEntry) {
			// user has requested 'stop on entry' so send out a stop-on-entry event
			this.log('la', '_startInitialize2: fire stop-on-entry event');
			this.sendEvent(new StoppedEvent2('entry', NodeDebugSession.DUMMY_THREAD_ID));
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

	protected disconnectRequest(response: DebugProtocol.DisconnectResponse, args: DebugProtocol.DisconnectArguments): void {

		// special code for 'extensionHost' debugging
		if (this._adapterID === 'extensionHost') {
			// detect whether this disconnect request is part of a restart session
			if (this._nodeProcessId > 0 && args && typeof (<any>args).restart === 'boolean' && (<any>args).restart) {
				// do not kill extensionHost (since vscode will do this for us in a nicer way without killing the window)
				this._nodeProcessId = 0;
				this.log('eh', `disconnectRequest: restart session requested`);
			}
		}

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

				// kill the whole process tree by starting with the node process
				let pid = this._nodeProcessId;
				if (pid > 0) {
					this._nodeProcessId = -1;
					this.log('la', 'shutdown: kill debugee and sub-processes');
					NodeDebugSession.killTree(pid);
				}
			}

			// plan for shutting down this process after a delay of 100ms
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
					b.condition, hitter)
				);
			}
		} else if (args.lines) {
			// deprecated API: convert line number array
			for (let l of args.lines) {
				sbs.push(new InternalSourceBreakpoint(this.convertClientLineToDebugger(l)));
			}
		}

		const source = args.source;

		if (source.path) {
			// as long as node debug doesn't implement 'hot code replacement' we have to mark all breakpoints as unverified.

			let keepUnverified = false;

			if (this._modifiedSources.has(source.path)) {
				keepUnverified = true;
			} else {
				if (typeof args.sourceModified === 'boolean' && args.sourceModified) {
					keepUnverified = true;
					this._modifiedSources.add(source.path);
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

		if (source.path && NodeDebugSession.NODE_INTERNALS_PREFIX.test(source.path)) {
			// a core module
			const path = this._pathToScript(source.path);
			this._findModule(path).then(scriptId => {
				if (scriptId >= 0) {
					this._updateBreakpoints(response, null, scriptId, sbs);
				} else {
					this.sendErrorResponse(response, 2019, localize('VSND2019', "Internal module {0} not found.", '{_module}'), { _module: path });
				}
				return;
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

		if (source.path) {
			let path = this.convertClientPathToDebugger(source.path);
			this._mapSourceAndUpdateBreakpoints(response, path, sbs);
			return;
		}

		if (source.name) {
			// a core module
			this._findModule(source.name).then(scriptId => {
				if (scriptId >= 0) {
					this._updateBreakpoints(response, null, scriptId, sbs);
				} else {
					this.sendErrorResponse(response, 2019, localize('VSND2019', "Internal module {0} not found.", '{_module}'), { _module: source.name });
				}
				return;
			});
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

			if (PathUtils.pathCompare(generated, path)) {   // if generated and source are the same we don't need a sourcemap
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

					path = generated;
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

			if (path && sourcemap) {

				if (actualLine !== args.line || actualColumn !== args.column) {
					// breakpoint location was adjusted by node.js so we have to map the new location back to source

					// first try to map the remote path back to local
					const localpath = this._remoteToLocal(path);

					// then try to map js locations back to source locations
					return this._sourceMaps.MapToSource(localpath, null, actualLine, actualColumn).then(mapresult => {

						if (mapresult) {
							this.log('sm', `_setBreakpoint: bp verification gen: '${localpath}' ${actualLine}:${actualColumn} -> src: '${mapresult.path}' ${mapresult.line}:${mapresult.column}`);
							actualLine = mapresult.line;
							actualColumn = mapresult.column;
						} else {
							actualLine = lb.orgLine;
							actualColumn = lb.orgColumn;
						}

						return this._setBreakpoint2(lb, path, actualLine, actualColumn);
					});

				} else {
					actualLine = lb.orgLine;
					actualColumn = lb.orgColumn;
				}
			}

			return this._setBreakpoint2(lb, path, actualLine, actualColumn);

		}).catch(error => {
			return new Breakpoint(false);
		});
	}

	private _setBreakpoint2(ibp: InternalSourceBreakpoint, path: string | null, actualLine: number, actualColumn: number) : Breakpoint {

		// nasty corner case: since we ignore the break-on-entry event we have to make sure that we
		// stop in the entry point line if the user has an explicit breakpoint there (or if there is a 'debugger' statement).
		// For this we check here whether a breakpoint is at the same location as the 'break-on-entry' location.
		// If yes, then we plan for hitting the breakpoint instead of 'continue' over it!

		if (!this._stopOnEntry && path && PathUtils.pathCompare(this._entryPath, path)) {	// only relevant if we do not stop on entry and have a matching file
			if (this._entryLine === actualLine && this._entryColumn === actualColumn) {
				// we do not have to 'continue' but we have to generate a stopped event instead
				this._needContinue = false;
				this._needBreakpointEvent = true;
				this.log('la', '_setBreakpoint2: remember to fire a breakpoint event later');
			}
		}

		if (ibp.verificationMessage) {
			const bp: DebugProtocol.Breakpoint = new Breakpoint(false, this.convertDebuggerLineToClient(actualLine), this.convertDebuggerColumnToClient(actualColumn));
			bp.message = ibp.verificationMessage;
			return bp;
		} else {
			return new Breakpoint(true, this.convertDebuggerLineToClient(actualLine), this.convertDebuggerColumnToClient(actualColumn));
		}
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

		let nodeArgs: V8SetExceptionBreakArgs = {
			type: 'all',
			enabled: false
		};
		this._catchRejects = false;
		const filters = args.filters;
		if (filters) {
			if (filters.indexOf('all') >= 0) {
				nodeArgs.enabled = true;
				this._catchRejects = true;
			} else if (filters.indexOf('uncaught') >= 0) {
				nodeArgs.type = 'uncaught';
				nodeArgs.enabled = true;
			}
		}

		this._node.setExceptionBreak(nodeArgs).then(nodeResponse => {
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
			this.sendEvent(new StoppedEvent2('breakpoint', NodeDebugSession.DUMMY_THREAD_ID));
		}

		if (this._needDebuggerEvent) {	// we have to break on entry
			this._needDebuggerEvent = false;
			info = 'fire debugger statement event';
			this.sendEvent(new StoppedEvent2('debugger_statement', NodeDebugSession.DUMMY_THREAD_ID));
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

		const backtraceArgs : any = {
			fromFrame: startFrame,
			toFrame: startFrame+maxLevels
		};
		const cmd = 'backtrace'; // this._nodeInjectionAvailable ? 'vscode_backtrace' : 'backtrace';

		this.log('va', `stackTraceRequest: ${cmd} ${startFrame} ${maxLevels}`);
		this._node.command2(cmd, backtraceArgs).then((response: V8BacktraceResponse) => {

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
						path = this._scriptNameToPath(name);
						origin = localize('origin.core.module', "read-only core module");

					} else {
						// do not map the script to a file in the workspace
						// fall through
					}
				}

				if (!name) {
					// if a function is dynamically created from a string, its script has no name.
					name = `VM${script_val.id}`;
				}

				// source not found locally -> prepare to stream source content from node backend.
				const sourceHandle = this._getScriptIdHandle(script_val.id);
				src = this._createSource(false, name, path, sourceHandle, origin);
			}

			return this._createStackFrameFromSource(frame, src, line, column);

		}).catch(err => {

			const func_name = this._getFrameName(frame);
			const name = localize('frame.error', "{0} <error: {1}>", func_name, err.message);
			return new StackFrame(this._frameHandles.create(frame), name);
		});
	}

	private _createSource(hasSource: boolean, name: string, path: string | undefined, sourceHandle: number = 0, origin?: string, data?: any): Source {

		let deemphasize = false;
		if (path && this._skipFiles && PathUtils.multiGlobMatches(this._skipFiles, path)) {
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

					return Promise.all<any>([
						this._readFile(path),
						content
							? Promise.resolve(content)
							: this._loadScript(script_id).then(script => script.contents)
					]).then(results => {
						let fileContents = results[0];
						const contents = results[1];

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
					return new Scope(scopeName, this._variableHandles.create(new ScopeContainer(scope, resolved[0], extra)), expensive);
				}).catch(error => {
					return new Scope(scopeName, 0);
				});
			}));

		}).then(scopes => {

			// exception scope
			if (frameIx === 0 && this._exception) {
				scopes.unshift(new Scope(localize({ key: 'scope.exception', comment: ['https://github.com/Microsoft/vscode/issues/4569'] }, "Exception"), this._variableHandles.create(new PropertyContainer(this._exception))));
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
	public _createProperties(obj: V8Object, mode: FilterType, start = 0, count?: number) : Promise<Variable[]> {

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
							return this._createVariable(item.name, item.value);
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

		return this._createPropertyVariables(obj, selectedProperties);
	}

	/**
	 * Resolves the given properties and returns them as an array of Variables.
	 * If the properties are indexed (opposed to named), a value 'start' is added to the index number.
	 * If a value is undefined it probes for a getter.
	 */
	private _createPropertyVariables(obj: V8Object | null, properties: V8Property[], doPreview = true, start = 0) : Promise<Variable[]> {

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
				if (this._node.v8Version && val.type === 'undefined' && !val.value && obj) {

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
						return this._createVariable(name, response.body, doPreview);
					}).catch(err => {
						return new Variable(name, 'undefined');
					});

				} else {
					return this._createVariable(name, val, doPreview);
				}
			}));
		});
	}

	/**
	 * Create a Variable with the given name and value.
	 * For structured values the variable object will have a corresponding expander.
	 */
	public _createVariable(name: string, val: V8Handle, doPreview: boolean = true) : Promise<DebugProtocol.Variable | null> {

		if (!val) {
			return Promise.resolve(null);
		}

		const simple = <V8Simple> val;

		switch (val.type) {

			case 'undefined':
			case 'null':
				return Promise.resolve(new Variable(name, val.type));

			case 'string':
				return this._createStringVariable(name, val, doPreview ? undefined : NodeDebugSession.PREVIEW_MAX_STRING_LENGTH);
			case 'number':
				if (typeof simple.value === 'number') {
					return Promise.resolve(new Variable(name, simple.value.toString()));
				}
				break;
			case 'boolean':
				if (typeof simple.value === 'boolean') {
					return Promise.resolve(new Variable(name, simple.value.toString().toLowerCase()));	// node returns these boolean values capitalized
				}
				break;

			case 'set':
			case 'map':
				if (this._node.v8Version) {
					return this._createSetMapVariable(name, val);
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
						return this._createArrayVariable(name, val, doPreview);

					case 'RegExp':
						if (typeof object.text === 'string') {
							return Promise.resolve(new Variable(name, object.text, this._variableHandles.create(new PropertyContainer(val))));
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
										return new Variable(name, value, this._variableHandles.create(new PropertyContainer(val)));
									});
								}
							}

							return new Variable(name, value, this._variableHandles.create(new PropertyContainer(val)));
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
				return Promise.resolve(new Variable(name, value, this._variableHandles.create(new PropertyContainer(val))));

			case 'frame':
			default:
				break;
		}
		return Promise.resolve(new Variable(name, simple.value ? simple.value.toString() : 'undefined'));
	}

	/**
	 * creates something like this: {a: 123, b: "hi", c: true …}
	 */
	private _objectPreview(object: V8Object, doPreview: boolean): Promise<string | null> {

		if (doPreview && object && object.properties && object.properties.length > 0) {

			const propcnt = object.properties.length;

			return this._createPropertyVariables(object, object.properties.slice(0, NodeDebugSession.PREVIEW_PROPERTIES), false).then(props => {

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

			return this._createPropertyVariables(array, previewProps, false).then(props => {

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

	private _createArrayVariable(name: string, array: V8Object, doPreview: boolean) : Promise<Variable> {

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
				return new Variable(name, v, this._variableHandles.create(new PropertyContainer(array)), indexedSize, namedSize);
			});
		});
	}

	private _getArraySize(array: V8Object) : Promise<number[]> {

		if (typeof array.vscode_indexedCnt === 'number') {
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

	private _createSetMapVariable(name: string, obj: V8Handle) : Promise<Variable> {

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
			return new Variable(name, `${typename}[${indexedSize}]`, this._variableHandles.create(new SetMapContainer(obj)), indexedSize, namedSize);
		});
	}

	public _createSetMapProperties(obj: V8Handle) : Promise<Variable[]> {

		const args = {
			expression: `var r = {}; Object.keys(obj).forEach(k => { r[k] = obj[k] }); r`,
			disable_break: true,
			additional_context: [
				{ name: 'obj', handle: obj.handle }
			]
		};

		return this._node.evaluate(args).then(response => {
			return this._createProperties(response.body, 'named');
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

			return this._createPropertyVariables(null, selectedProperties, true, start);
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
							this._createVariable('key', key),
							this._createVariable('value', val)
						]);
					});

					const x = <V8Object> this._getValueFromCache(selectedProperties[i]);
					variables.push(new Variable((start + (i/3)).toString(), <string> x.value, this._variableHandles.create(expander)));
				}
				return variables;
			});
		});
	}

	//--- long string support

	private _createStringVariable(name: string, val: V8Simple, maxLength: number | undefined) : Promise<Variable> {

		let str_val = <string>val.value;

		if (typeof maxLength === 'number') {
			if (str_val.length > maxLength) {
				str_val = str_val.substr(0, maxLength) + '…';
			}
			return Promise.resolve(new Variable(name, this._escapeStringValue(str_val)));
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
				return new Variable(name, this._escapeStringValue(str_val));
			});

		} else {
			return Promise.resolve(new Variable(name, this._escapeStringValue(str_val)));
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
				return this._createVariable('_setVariableValue', response.body.newValue);
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
				return this._createVariable('_setpropertyvalue', response.body);
			});
		}

		return Promise.reject(new Error(Expander.SET_VALUE_ERROR));
	}

	//--- pause request -------------------------------------------------------------------------------------------------------

	protected pauseRequest(response: DebugProtocol.PauseResponse, args: DebugProtocol.PauseArguments) : void {
		this._node.command('suspend', null, (nodeResponse) => {
			if (nodeResponse.success) {
				this._stopped('pause');
				this._lastStoppedEvent = new StoppedEvent2('pause', NodeDebugSession.DUMMY_THREAD_ID);
				this.sendResponse(response);
				this.sendEvent(this._lastStoppedEvent);
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
				this._createVariable('evaluate', resp.body).then(v => {
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

		if (args.source && args.source.path) {

			this._loadScriptByPath(this._pathToScript(args.source.path)).then(script => {
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

		const sourceHandle = args.sourceReference;
		const srcSource = this._sourceHandles.get(sourceHandle);

		if (srcSource) {

			if (srcSource.source) {
				response.body = {
					content: srcSource.source
				};
				this.sendResponse(response);
				return;
			}

			if (srcSource.scriptId) {

				this._loadScript(srcSource.scriptId).then(script => {
					srcSource.source = script.contents;
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

		this.sendErrorResponse(response, 2027, 'sourceRequest error: illegal handle', null, ErrorDestination.Telemetry);
	}

	private _loadScript(scriptId: number) : Promise<Script>  {

		let script = this._scripts.get(scriptId);

		if (!script) {

			this.log('ls', `_loadScript: ${scriptId}`);

			// not found
			const args = {
				types: 1+2+4,
				includeSource: true,
				ids: [ scriptId ]
			};

			script = this._node.scripts(args).then(nodeResponse => {
				return new Script(nodeResponse.body[0]);
			});

			this._scripts.set(scriptId, script);
		}

		return script;
	}

	private _loadScriptByPath(name: string) : Promise<Script>  {

		this.log('ls', `_loadScriptByPath: ${name}`);

		// not found
		const args = {
			types: 1+2+4,
			includeSource: true,
			filter: name
		};

		let script = this._node.scripts(args).then(nodeResponse => {
			return new Script(nodeResponse.body[0]);
		});

		return script;
	}

	//--- completions request -------------------------------------------------------------------------------------------------

	protected completionsRequest(response: DebugProtocol.CompletionsResponse, args: DebugProtocol.CompletionsArguments): void {

		const line = args.text;
		const column = args.column;

		const prefix = line.substring(0, column);

		let expression: string | undefined;
		const dot = prefix.lastIndexOf('.');
		if (dot >= 0) {
			expression = prefix.substr(0, dot);
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
					if (r.properties) {
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

	//--- custom request ------------------------------------------------------------------------------------------------------

	/**
	 * Handle custom requests.
	 */
	protected customRequest(command: string, response: DebugProtocol.Response, args: any): void {

		switch (command) {
			case 'getLoadScripts':
				this.allLoadedScriptsRequest(response, args);
				break;
			case 'toggleSkipFileStatus':
				this.outLine(localize('toggleSkipFileStatus.not.implemented', "\"Toggle skipping this file\" is not yet implemented for the legacy protocol debugger."));
				this.sendResponse(response);
				break;
			default:
				super.customRequest(command, response, args);
				break;
		}
	}

	private allLoadedScriptsRequest(response: DebugProtocol.Response, args: any) {

		this._node.scripts( { types: 4 } ).then(resp => {
			let result = Array<any>();
			for (let script of resp.body) {
				if (script.name) {
					script.name = this._scriptNameToPath(script.name);
					const name = Path.basename(script.name);
					result.push({
						label: name,
						description: script.name === name ? '' : script.name,
						source: new Source(name, script.name, this._getScriptIdHandle(script.id))
					});
				}
			}
			result = result.sort((a, b) => a.label.localeCompare(b.label));
			response.body = { loadedScripts: result };
			this.sendResponse(response);
		}).catch(err => {
			this.sendErrorResponse(response, 9999, `scripts error: ${err}`);
		});
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

		const format = localize('attribute.path.not.absolute', "Attribute '{0}' is not absolute ('{1}'); consider adding '{2}' as a prefix to make it absolute.", attribute, '{path}', '${workspaceRoot}/');
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
	 * send a line of text to an output channel.
	 */
	private outLine(message: string, category?: string) {
		this.sendEvent(new OutputEvent(message + '\n', category ? category : 'console'));
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

	private _resolveValues(mirrors: V8Ref[]) : Promise<V8Object[]> {

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
			return this._refCache.get(m.ref);
		}
		if (typeof m.handle === 'number') {
			return this._refCache.get(m.handle);
		}
		return null;
	}

	private _resolveToCache(handles: number[]) : Promise<V8Object[]> {

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
	 * Returns script id for the given script name or -1 if not found.
	 */
	private _findModule(name: string) : Promise<number> {

		const args = {
			types: 1 + 2 + 4,
			filter: name
		};

		return this._node.scripts(args).then(resp => {
			for (let result of resp.body) {
				if (result.name === name) {	// return the first exact match
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
			return s.substring(1, s.length - 1);
		}
		return s;
	}

	private static killTree(processId: number): void {

		if (process.platform === 'win32') {
			const TASK_KILL = 'C:\\Windows\\System32\\taskkill.exe';

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
				const cmd = Path.join(__dirname, './terminateProcess.sh');
				CP.spawnSync(cmd, [ processId.toString() ]);
			} catch (err) {
			}
		}
	}
}

const INDEX_PATTERN = /^[0-9]+$/;

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

function endsWith(str: string, suffix: string): boolean {
	return str.indexOf(suffix, str.length - suffix.length) !== -1;
}

function random(low: number, high: number): number {
	return Math.floor(Math.random() * (high - low) + low);
}

DebugSession.run(NodeDebugSession);
