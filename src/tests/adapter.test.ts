/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

"use strict";

import assert = require('assert');
import * as Path from 'path';
import {DebugClient} from './debugClient';
import {DebugProtocol} from 'vscode-debugprotocol';

suite('Node Debug Adapter', () => {

	const DEBUG_ADAPTER = './out/node/nodeDebug.js';

	const PROJECT_ROOT = Path.join(__dirname, '../../');
	const PROGRAM = Path.join(PROJECT_ROOT, 'src/tests/data/program.js');

	const BREAKPOINT_LINE = 2;

	let dc: DebugClient;


	setup(done => {
		dc = new DebugClient('node', DEBUG_ADAPTER, 'node');
		dc.start(done);
	});

	teardown(done => {
		dc.stop(done);
	});

	suite('basic', () => {

		test('unknown request should produce error', done => {
			dc.send('illegal_request').then(() => {
				done(new Error("does not report error on unknown request"));
			}).catch(() => {
				done();
			});
		});
	});

	suite('initialize', () => {

		test('should return supported features', () => {
			return dc.initializeRequest().then(response => {
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
				done(new Error("does not report error on invalid 'pathFormat' attribute"));
			}).catch(err => {
				// error expected
				done();
			});
		});
	});

	suite('launch', () => {

		test('should run program to the end', () => {

			return Promise.all([
				dc.configurationSequence(),
				dc.launch({ program: PROGRAM }),
				dc.waitForEvent('terminated')
			]);
		});

		test('should stop on entry', () => {

			const ENTRY_LINE = 1;

			return Promise.all([
				dc.configurationSequence(),
				dc.launch({ program: PROGRAM, stopOnEntry: true }),
				dc.assertStoppedLocation('entry', { path: PROGRAM, line: ENTRY_LINE } )
			]);
		});

		test('should stop on debugger statement', () => {

			const PROGRAM = Path.join(PROJECT_ROOT, 'src/tests/data/programWithDebugger.js');
			const DEBUGGER_LINE = 6;

			return Promise.all([
				dc.configurationSequence(),
				dc.launch({ program: PROGRAM }),
				dc.assertStoppedLocation('debugger statement', { path: PROGRAM, line: DEBUGGER_LINE } )
			]);
		});

	});

	suite('setBreakpoints', () => {

		const ENTRY_LINE = 1;
		const SINGLE_LINE_PROGRAM = Path.join(PROJECT_ROOT, 'src/tests/data/programSingleLine.js');

		test('should stop on a breakpoint', () => {
			return dc.hitBreakpoint({ program: PROGRAM }, { path: PROGRAM, line: BREAKPOINT_LINE} );
		});

		test('should stop on a breakpoint identical to the entrypoint', () => {		// verifies the 'hide break on entry point' logic
			return dc.hitBreakpoint({ program: PROGRAM }, { path: PROGRAM, line: ENTRY_LINE } );
		});

		test('should break on a specific column in a single line program', () => {
			const LINE = 1;
			const COLUMN = 55;
			return dc.hitBreakpoint({ program: SINGLE_LINE_PROGRAM }, { path: SINGLE_LINE_PROGRAM, line: LINE, column: COLUMN } );
		});

		test('should stop on a conditional breakpoint', () => {

			const COND_BREAKPOINT_LINE = 13;

			return Promise.all([

				dc.waitForEvent('initialized').then(event => {
					return dc.setBreakpointsRequest({
						breakpoints: [ { line: COND_BREAKPOINT_LINE, condition: "i === 3" } ],
						source: { path: PROGRAM }
					});
				}).then(response => {
					const bp = response.body.breakpoints[0];
					assert.equal(bp.verified, true, "breakpoint verification mismatch: verified");
					assert.equal(bp.line, COND_BREAKPOINT_LINE, "breakpoint verification mismatch: line");
					assert.equal(bp.column, 2, "breakpoint verification mismatch: column");
					return dc.configurationDoneRequest();
				}),

				dc.launch({ program: PROGRAM }),

				dc.assertStoppedLocation('breakpoint', { path: PROGRAM, line: COND_BREAKPOINT_LINE } ).then(response => {
					const frame = response.body.stackFrames[0];
					return dc.evaluateRequest({ context: "watch", frameId: frame.id, expression: "x" }).then(response => {
						assert.equal(response.body.result, 9, "x !== 9");
						return response;
					});
				})
			]);
		});

		test('should stop on a breakpoint in TypeScript source', () => {

			const PROGRAM = Path.join(PROJECT_ROOT, 'src/tests/data/sourcemaps-inline/src/classes.ts');
			const OUT_DIR = Path.join(PROJECT_ROOT, 'src/tests/data/sourcemaps-inline/dist');
			const BREAKPOINT_LINE = 17;

			return dc.hitBreakpoint({
				program: PROGRAM,
				sourceMaps: true,
				outDir: OUT_DIR,
				runtimeArgs: [ "--nolazy" ]
			}, { path: PROGRAM, line: BREAKPOINT_LINE } );
		});

		test('should stop on a breakpoint in TypeScript source - Microsoft/vscode#2574', () => {

			const PROGRAM = Path.join(PROJECT_ROOT, 'src/tests/data/sourcemaps-2574/out/classes.js');
			const OUT_DIR = Path.join(PROJECT_ROOT, 'src/tests/data/sourcemaps-2574/out');
			const TS_SOURCE = Path.join(PROJECT_ROOT, 'src/tests/data/sourcemaps-2574/src/classes.ts');
			const TS_LINE = 17;

			return dc.hitBreakpoint({
				program: PROGRAM,
				sourceMaps: true,
				outDir: OUT_DIR,
				runtimeArgs: [ "--nolazy" ]
			}, { path: TS_SOURCE, line: TS_LINE } );
		});

		test('should stop on a breakpoint in TypeScript even if breakpoint was set in JavaScript - Microsoft/vscode-node-debug#43', () => {

			const PROGRAM = Path.join(PROJECT_ROOT, 'src/tests/data/sourcemaps-2574/out/classes.js');
			const OUT_DIR = Path.join(PROJECT_ROOT, 'src/tests/data/sourcemaps-2574/out');
			const JS_SOURCE = PROGRAM;
			const JS_LINE = 21;
			const TS_SOURCE = Path.join(PROJECT_ROOT, 'src/tests/data/sourcemaps-2574/src/classes.ts');
			const TS_LINE = 17;

			return dc.hitBreakpoint({
				program: PROGRAM,
				sourceMaps: true,
				outDir: OUT_DIR,
				runtimeArgs: [ "--nolazy" ]
			}, { path: JS_SOURCE, line: JS_LINE}, { path: TS_SOURCE, line: TS_LINE } );
		});

		test('should stop on a breakpoint in TypeScript even if program\'s entry point is in JavaScript', () => {

			const PROGRAM = Path.join(PROJECT_ROOT, 'src/tests/data/sourcemaps-js-entrypoint/out/entry.js');
			const OUT_DIR = Path.join(PROJECT_ROOT, 'src/tests/data/sourcemaps-js-entrypoint/out');
			const TS_SOURCE = Path.join(PROJECT_ROOT, 'src/tests/data/sourcemaps-js-entrypoint/src/classes.ts');
			const TS_LINE = 17;

			return dc.hitBreakpoint({
				program: PROGRAM,
				sourceMaps: true,
				outDir: OUT_DIR,
				runtimeArgs: [ "--nolazy" ]
			}, { path: TS_SOURCE, line: TS_LINE } );
		});
	});

	suite('function setBreakpoints', () => {

		const PROGRAM = Path.join(PROJECT_ROOT, 'src/tests/data/programWithFunction.js');
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

		const PROGRAM = Path.join(PROJECT_ROOT, 'src/tests/data/programWithException.js');

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

		const PROGRAM = Path.join(PROJECT_ROOT, 'src/tests/data/programWithOutput.js');

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