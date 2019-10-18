/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert = require('assert');
import * as Path from 'path';
import * as FS from 'fs';
import * as CP from 'child_process';
import * as PathUtils from '../node/pathUtilities';
import {DebugProtocol} from 'vscode-debugprotocol';
import {DebugClient} from 'vscode-debugadapter-testsupport';

suite('Node Debug Adapter', () => {

	const DEBUG_ADAPTER = './out/node/nodeDebug.js';

	const PROJECT_ROOT = Path.join(__dirname, '../../');
	const DATA_ROOT = Path.join(PROJECT_ROOT, 'testdata/');


	let env;
	let dc: DebugClient;

	setup( () => {

		if (!env) {
			env = process.env;
			// make sure that the debug adapter finds a version of node on the PATH
			// that supports the "legacy" protocol.
			// If not, we use the LEGACY_NODE_PATH from the environment.
			const result = CP.spawnSync('node', ['--version']);
			const semVerString = result.stdout ? result.stdout.toString() : undefined;
			if (semVerString) {
				const match = semVerString.trim().match(/v(\d+)\.(\d+)\.(\d+)/);
				if (match && match.length === 4 && parseInt(match[1]) >= 8) {
					env = PathUtils.extendObject({}, process.env);
					if (process.platform === 'win32') {
						env.Path = env.LEGACY_NODE_PATH || `${env.NVM_HOME}\\v7.9.0;${env.Path}`;
					} else {
						env.PATH = env.LEGACY_NODE_PATH || `${env.NVM_DIR}/versions/node/v7.9.0/bin:${env.PATH}`;
					}
				}
			}
		}

		dc = new DebugClient('node', DEBUG_ADAPTER, 'node', { env: env });
		return dc.start();	// add port to run as server
	});

	teardown( () => dc.stop() );

	suite('basic', () => {

		test('unknown request should produce error', done => {
			dc.send('illegal_request').then(() => {
				done(new Error('does not report error on unknown request'));
			}).catch(() => {
				done();
			});
		});
	});

	suite('initialize', () => {

		test('should return supported features', () => {
			return dc.initializeRequest().then(response => {
				response.body = response.body || {};
				assert.equal(response.body.supportsConfigurationDoneRequest, true);
			});
		});

		test('should produce error for invalid \'pathFormat\'', done => {
			dc.initializeRequest({
				adapterID: 'mock',
				linesStartAt1: true,
				columnsStartAt1: true,
				pathFormat: 'url'
			}).then(response => {
				done(new Error('does not report error on invalid \'pathFormat\' attribute'));
			}).catch(err => {
				// error expected
				done();
			});
		});
	});

	suite('launch', () => {

		test('should run program to the end', () => {

			const PROGRAM = Path.join(DATA_ROOT, 'program.js');

			return Promise.all([
				dc.configurationSequence(),
				dc.launch({ program: PROGRAM }),
				dc.waitForEvent('terminated')
			]);
		});

		if (process.platform === 'win32') {
			const sysRoot = process.env['SystemRoot'] ||'C:\\WINDOWS';
			const bash32bitPath = Path.join(sysRoot, 'SYSNATIVE', 'bash.exe');
			const bash64bitPath = Path.join(sysRoot, 'System32', 'bash.exe');
			if (FS.existsSync(bash32bitPath) || FS.existsSync(bash64bitPath)) {

				test('should run program using WSL', () => {
					const PROGRAM = Path.join(DATA_ROOT, 'program.js');
					return Promise.all([
						dc.configurationSequence(),
						dc.launch({ program: PROGRAM, useWSL: true }),
						dc.waitForEvent('terminated')
					]);
				});
			}
		}

		test('should stop on entry', () => {

			const PROGRAM = Path.join(DATA_ROOT, 'program.js');
			const ENTRY_LINE = 1;

			return Promise.all([
				dc.configurationSequence(),
				dc.launch({ program: PROGRAM, stopOnEntry: true }),
				dc.assertStoppedLocation('entry', { path: PROGRAM, line: ENTRY_LINE } )
			]);
		});

		test('should stop on debugger statement', () => {

			const PROGRAM = Path.join(DATA_ROOT, 'programWithDebugger.js');
			const DEBUGGER_LINE = 6;

			return Promise.all([
				dc.configurationSequence(),
				dc.launch({ program: PROGRAM }),
				dc.assertStoppedLocation('debugger_statement', { path: PROGRAM, line: DEBUGGER_LINE } )
			]);
		});

		test('should stop on debugger statement in first line', () => {

			const PROGRAM = Path.join(DATA_ROOT, 'programWithDebugger1.js');
			const DEBUGGER_LINE = 1;

			return Promise.all([
				dc.configurationSequence(),
				dc.launch({ program: PROGRAM }),
				dc.assertStoppedLocation('debugger_statement', { path: PROGRAM, line: DEBUGGER_LINE } )
			]);
		});

	});

	suite('setBreakpoints', () => {

		test('should stop on a breakpoint', () => {

			const PROGRAM = Path.join(DATA_ROOT, 'program.js');
			const BREAKPOINT_LINE = 2;

			return dc.hitBreakpoint({ program: PROGRAM }, { path: PROGRAM, line: BREAKPOINT_LINE} );
		});

		test('should stop on a breakpoint in file with spaces in its name', () => {

			const PROGRAM = Path.join(DATA_ROOT, 'folder with spaces', 'file with spaces.js');
			const BREAKPOINT_LINE = 2;

			return dc.hitBreakpoint({ program: PROGRAM }, { path: PROGRAM, line: BREAKPOINT_LINE} );
		});

		test('should stop on a breakpoint identical to the entrypoint', () => {		// verifies the 'hide break on entry point' logic

			const PROGRAM = Path.join(DATA_ROOT, 'program.js');
			const ENTRY_LINE = 1;

			return dc.hitBreakpoint({ program: PROGRAM }, { path: PROGRAM, line: ENTRY_LINE } );
		});

		test('should break on a specific column in a single line program', () => {

			const SINGLE_LINE_PROGRAM = Path.join(DATA_ROOT, 'programSingleLine.js');
			const LINE = 1;
			const COLUMN = 55;

			return dc.hitBreakpoint({ program: SINGLE_LINE_PROGRAM }, { path: SINGLE_LINE_PROGRAM, line: LINE, column: COLUMN } );
		});

		test('should stop on a conditional breakpoint', () => {

			const PROGRAM = Path.join(DATA_ROOT, 'program.js');
			const COND_BREAKPOINT_LINE = 13;
			const COND_BREAKPOINT_COLUMN = 2;

			return Promise.all([

				dc.waitForEvent('initialized').then(event => {
					return dc.setBreakpointsRequest({
						breakpoints: [ { line: COND_BREAKPOINT_LINE, condition: 'i === 3' } ],
						source: { path: PROGRAM }
					});
				}).then(response => {
					const bp = response.body.breakpoints[0];
					assert.equal(bp.verified, true, 'breakpoint verification mismatch: verified');
					assert.equal(bp.line, COND_BREAKPOINT_LINE, 'breakpoint verification mismatch: line');
					assert.equal(bp.column, COND_BREAKPOINT_COLUMN, 'breakpoint verification mismatch: column');
					return dc.configurationDoneRequest();
				}),

				dc.launch({ program: PROGRAM }),

				dc.assertStoppedLocation('breakpoint', { path: PROGRAM, line: COND_BREAKPOINT_LINE } ).then(response => {
					const frame = response.body.stackFrames[0];
					return dc.evaluateRequest({ context: 'watch', frameId: frame.id, expression: 'x' }).then(response => {
						assert.equal(response.body.result, 9, 'x !== 9');
						return response;
					});
				})
			]);
		});

		test('should stop on <node_internals> module', () => {

			const PROGRAM = Path.join(DATA_ROOT, 'programWithInternal.js');

			return dc.hitBreakpoint({ program: PROGRAM }, { path: '<node_internals>/assert.js', line: 110 });
		});

		test('should stop on debugger statement in eval', () => {

			const PROGRAM = Path.join(DATA_ROOT, 'programWithDebuggerEval.js');
			const DEBUGGER_LINE = 2;

			return Promise.all([
				dc.configurationSequence(),
				dc.launch({ program: PROGRAM }),
				dc.assertStoppedLocation('debugger_statement', { path: /^<node_internals>\/VM[0-9]+$/, line: DEBUGGER_LINE } )
			]);
		});
	});

	suite('setBreakpoints in TypeScript', () => {

		test('should stop at entry point', () => {

			const PROGRAM = Path.join(DATA_ROOT, 'sourcemaps-entrypoint/index.ts');
			const TS_LINE = 3;

			return Promise.all([
				dc.configurationSequence(),
				dc.launch({ program: PROGRAM, stopOnEntry: true }),
				dc.assertStoppedLocation('entry', { path: PROGRAM, line: TS_LINE } )
			]);
		});

		test('should stop on a breakpoint in source (all files top level)', () => {

			const PROGRAM = Path.join(DATA_ROOT, 'sourcemaps-simple/classes.js');
			const TS_SOURCE = Path.join(DATA_ROOT, 'sourcemaps-simple/classes.ts');
			const TS_LINE = 17;

			return dc.hitBreakpoint({
				program: PROGRAM,
				runtimeArgs: [ '--nolazy' ]
			}, {
				path: TS_SOURCE,
				line: TS_LINE
			});
		});

		test('should stop on a breakpoint in source (all files top level, missing sourceMappingURL)', () => {

			const PROGRAM = Path.join(DATA_ROOT, 'sourcemaps-simple-no-sourceMappingURL/classes.js');
			const TS_SOURCE = Path.join(DATA_ROOT, 'sourcemaps-simple-no-sourceMappingURL/classes.ts');
			const TS_LINE = 17;

			return dc.hitBreakpoint({
				program: PROGRAM,
				runtimeArgs: [ '--nolazy' ]
			}, {
				path: TS_SOURCE,
				line: TS_LINE
			});
		});

		test('should stop on a breakpoint in source (outDir)', () => {

			const PROGRAM = Path.join(DATA_ROOT, 'sourcemaps-inline/src/classes.ts');
			const OUT_DIR = Path.join(DATA_ROOT, 'sourcemaps-inline/dist');
			const BREAKPOINT_LINE = 17;

			return dc.hitBreakpoint({
				program: PROGRAM,
				outDir: OUT_DIR,
				runtimeArgs: [ '--nolazy' ]
			}, {
				path: PROGRAM,
				line: BREAKPOINT_LINE
			});
		});

		test('should stop on a breakpoint in source (outFiles)', () => {

			const PROGRAM = Path.join(DATA_ROOT, 'sourcemaps-inline/src/classes.ts');
			const OUT_FILES = Path.join(DATA_ROOT, 'sourcemaps-inline/dist/**/*.js');
			const BREAKPOINT_LINE = 17;

			return dc.hitBreakpoint({
				program: PROGRAM,
				outFiles: [ OUT_FILES ],
				runtimeArgs: [ '--nolazy' ]
			}, {
				path: PROGRAM,
				line: BREAKPOINT_LINE
			});
		});

		test('should stop on a breakpoint in source with spaces in paths (outDir)', () => {

			const PROGRAM = Path.join(DATA_ROOT, 'sourcemaps with spaces', 'the source/classes.ts');
			const OUT_DIR = Path.join(DATA_ROOT, 'sourcemaps with spaces/the distribution');
			const BREAKPOINT_LINE = 17;

			return dc.hitBreakpoint({
				program: PROGRAM,
				outDir: OUT_DIR,
				runtimeArgs: [ '--nolazy' ]
			}, {
				path: PROGRAM,
				line: BREAKPOINT_LINE
			});
		});

		test('should stop on a breakpoint in source with spaces in paths (outFiles)', () => {

			const PROGRAM = Path.join(DATA_ROOT, 'sourcemaps with spaces', 'the source/classes.ts');
			const OUT_FILES = Path.join(DATA_ROOT, 'sourcemaps with spaces/the distribution/**/*.js');
			const BREAKPOINT_LINE = 17;

			return dc.hitBreakpoint({
				program: PROGRAM,
				outFiles: [ OUT_FILES ],
				runtimeArgs: [ '--nolazy' ]
			}, {
				path: PROGRAM,
				line: BREAKPOINT_LINE
			});
		});


		test('should stop on a breakpoint in source - Microsoft/vscode#2574', () => {

			const PROGRAM = Path.join(DATA_ROOT, 'sourcemaps-2574/out/classes.js');
			const OUT_DIR = Path.join(DATA_ROOT, 'sourcemaps-2574/out');
			const TS_SOURCE = Path.join(DATA_ROOT, 'sourcemaps-2574/src/classes.ts');
			const TS_LINE = 17;

			return dc.hitBreakpoint({
				program: PROGRAM,
				outDir: OUT_DIR,
				runtimeArgs: [ '--nolazy' ]
			}, {
				path: TS_SOURCE,
				line: TS_LINE
			});
		});

		test('should stop on a breakpoint in source (sourceMappingURL missing)', () => {

			const PROGRAM = Path.join(DATA_ROOT, 'sourcemap-no-sourceMappingURL/out/classes.js');
			const OUT_DIR = Path.join(DATA_ROOT, 'sourcemap-no-sourceMappingURL/out');
			const TS_SOURCE = Path.join(DATA_ROOT, 'sourcemap-no-sourceMappingURL/src/classes.ts');
			const TS_LINE = 17;

			return dc.hitBreakpoint({
				program: PROGRAM,
				outDir: OUT_DIR,
				runtimeArgs: [ '--nolazy' ]
			}, {
				path: TS_SOURCE,
				line: TS_LINE
			});
		});

		test('should stop on a breakpoint in source even if breakpoint was set in JavaScript - Microsoft/vscode-node-debug#43', () => {

			const PROGRAM = Path.join(DATA_ROOT, 'sourcemaps-2574/out/classes.js');
			const OUT_DIR = Path.join(DATA_ROOT, 'sourcemaps-2574/out');
			const JS_SOURCE = PROGRAM;
			const JS_LINE = 21;
			const TS_SOURCE = Path.join(DATA_ROOT, 'sourcemaps-2574/src/classes.ts');
			const TS_LINE = 17;

			return dc.hitBreakpoint({
				program: PROGRAM,
				outDir: OUT_DIR,
				runtimeArgs: [ '--nolazy' ]
			}, {
				path: JS_SOURCE,
				line: JS_LINE
			}, {
				path: TS_SOURCE,
				line: TS_LINE
			});
		});

		test('should stop on a breakpoint in source even if program\'s entry point is in JavaScript', () => {

			const PROGRAM = Path.join(DATA_ROOT, 'sourcemaps-js-entrypoint/out/entry.js');
			const OUT_DIR = Path.join(DATA_ROOT, 'sourcemaps-js-entrypoint/out');
			const TS_SOURCE = Path.join(DATA_ROOT, 'sourcemaps-js-entrypoint/src/classes.ts');
			const TS_LINE = 17;

			return dc.hitBreakpoint({
				program: PROGRAM,
				sourceMaps: true,
				outDir: OUT_DIR,
				runtimeArgs: [ '--nolazy' ]
			}, { path: TS_SOURCE, line: TS_LINE } );
		});

		test('should stop on an explicit breakpoint at entry point', () => {

			const PROGRAM = Path.join(DATA_ROOT, 'sourcemaps-entrypoint/index.ts');
			const TS_LINE = 3;

			return dc.hitBreakpoint({
				program: PROGRAM,
				sourceMaps: true,
				outFiles: [],
				runtimeArgs: [ '--nolazy' ]
			}, { path: PROGRAM, line: TS_LINE } );
		});

	});

	suite('function setBreakpoints', () => {

		const PROGRAM = Path.join(DATA_ROOT, 'programWithFunction.js');
		const FUNCTION_NAME_1 = 'foo';
		const FUNCTION_LINE_1 = 4;
		const FUNCTION_NAME_2 = 'bar';
		const FUNCTION_LINE_2 = 8;
		const FUNCTION_NAME_3 = 'xyz';

		test('should stop on a function breakpoint', () => {

			return Promise.all<DebugProtocol.ProtocolMessage>([

				dc.launch({ program: PROGRAM }),

				dc.configurationSequence(),

				// since we can only set a function breakpoint for *known* functions,
				// we use the program output as an indication that function 'foo' has been defined.
				dc.assertOutput('stdout', 'foo defined').then(event => {

					return dc.setFunctionBreakpointsRequest({
							breakpoints: [ { name: FUNCTION_NAME_2 } ]
						}).then(() => {
							return dc.setFunctionBreakpointsRequest({
									breakpoints: [ { name: FUNCTION_NAME_1 }, { name: FUNCTION_NAME_2 }, { name: FUNCTION_NAME_3 } ]
								}).then(response => {
									const bp1 = response.body.breakpoints[0];
									assert.equal(bp1.verified, true);
									assert.equal(bp1.line, FUNCTION_LINE_1);

									const bp2 = response.body.breakpoints[1];
									assert.equal(bp2.verified, true);
									assert.equal(bp2.line, FUNCTION_LINE_2);

									const bp3 = response.body.breakpoints[2];
									assert.equal(bp3.verified, false);
									return response;
								});
						});
				}),

				dc.assertStoppedLocation('breakpoint', { path: PROGRAM, line: FUNCTION_LINE_1 } )
			]);
		});
	});

	suite('setExceptionBreakpoints', () => {

		const PROGRAM = Path.join(DATA_ROOT, 'programWithException.js');

		test('should not stop on an exception', () => {

			return Promise.all<DebugProtocol.ProtocolMessage>([

				dc.waitForEvent('initialized').then(event => {
					return dc.setExceptionBreakpointsRequest({
						filters: [ ]
					});
				}).then(response => {
					return dc.configurationDoneRequest();
				}),

				dc.launch({ program: PROGRAM }),

				dc.waitForEvent('terminated')
			]);
		});

		test('should stop on a caught exception', () => {

			const EXCEPTION_LINE = 6;

			return Promise.all([

				dc.waitForEvent('initialized').then(event => {
					return dc.setExceptionBreakpointsRequest({
						filters: [ 'all' ]
					});
				}).then(response => {
					return dc.configurationDoneRequest();
				}),

				dc.launch({ program: PROGRAM }),

				dc.assertStoppedLocation('exception', { path: PROGRAM, line: EXCEPTION_LINE } )
			]);
		});

		test('should stop on uncaught exception', () => {

			const UNCAUGHT_EXCEPTION_LINE = 12;

			return Promise.all([

				dc.waitForEvent('initialized').then(event => {
					return dc.setExceptionBreakpointsRequest({
						filters: [ 'uncaught' ]
					});
				}).then(response => {
					return dc.configurationDoneRequest();
				}),

				dc.launch({ program: PROGRAM }),

				dc.assertStoppedLocation('exception', { path: PROGRAM, line: UNCAUGHT_EXCEPTION_LINE } )
			]);
		});
	});

	suite('output events', () => {

		const PROGRAM = Path.join(DATA_ROOT, 'programWithOutput.js');

		test('stdout and stderr events should be complete and in correct order', () => {
			return Promise.all([
				dc.configurationSequence(),
				dc.launch({ program: PROGRAM }),
				dc.assertOutput('stdout', 'Hello stdout 0\nHello stdout 1\nHello stdout 2\n'),
				//dc.assertOutput('stderr', 'Hello stderr 0\nHello stderr 1\nHello stderr 2\n')
			]);
		});
	});
});