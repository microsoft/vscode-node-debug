/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

"use strict";

import assert = require('assert');
import * as Path from 'path';
import {DebugClient} from './DebugClient';
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
				dc.assertStoppedLocation('entry', ENTRY_LINE)
			]);
		});

		test('should stop on debugger statement', () => {

			const PROGRAM = Path.join(PROJECT_ROOT, 'src/tests/data/programWithDebugger.js');
			const DEBUGGER_LINE = 6;

			return Promise.all([
				dc.configurationSequence(),
				dc.launch({ program: PROGRAM }),
				dc.assertStoppedLocation('debugger statement', DEBUGGER_LINE)
			]);
		});

	});

	suite('setBreakpoints', () => {

		test('should stop on a breakpoint', () => {
			return dc.hitBreakpoint({ program: PROGRAM, }, PROGRAM, BREAKPOINT_LINE);
		});

		test('should stop on a conditional breakpoint', () => {

			const COND_BREAKPOINT_LINE = 13;

			return Promise.all([

				dc.waitForEvent('initialized').then(event => {
					return dc.setBreakpointsRequest({
						breakpoints: [ { line: COND_BREAKPOINT_LINE, condition: "i === 3" } ],
						source: { path: PROGRAM },

					});
				}).then(response => {
					assert.deepEqual(response.body.breakpoints[0], {
						verified: true,
						line: COND_BREAKPOINT_LINE,
						column: 0
					});
					return dc.configurationDoneRequest();
				}),

				dc.launch({ program: PROGRAM }),

				dc.assertStoppedLocation('breakpoint', COND_BREAKPOINT_LINE).then(response => {
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
			}, PROGRAM, BREAKPOINT_LINE);
		});

		test('should stop on a breakpoint in TypeScript source - Microsoft/vscode#2574', () => {

			const PROGRAM = Path.join(PROJECT_ROOT, 'src/tests/data/sourcemaps-2574/out/classes.js');
			const SOURCE = Path.join(PROJECT_ROOT, 'src/tests/data/sourcemaps-2574/src/classes.ts');
			const OUT_DIR = Path.join(PROJECT_ROOT, 'src/tests/data/sourcemaps-2574/out');
			const BREAKPOINT_LINE = 17;

			return dc.hitBreakpoint({
				program: PROGRAM,
				sourceMaps: true,
				outDir: OUT_DIR,
				runtimeArgs: [ "--nolazy" ]
			}, SOURCE, BREAKPOINT_LINE);
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

				dc.assertStoppedLocation('exception', EXCEPTION_LINE)
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

				dc.assertStoppedLocation('exception', UNCAUGHT_EXCEPTION_LINE)
			]);
		});
	});

    suite('output events', () => {

        const PROGRAM = Path.join(PROJECT_ROOT, 'src/tests/data/programWithOutput.js');

        test('stdout and stderr events should be complete and in correct order', () => {
            return Promise.all([
                dc.configurationSequence(),
                dc.launch({ program: PROGRAM }),
                dc.assertOutput('stdout', "Hello stdout 0\nHello stdout 1\nHello stdout 2\n"),
                //dc.assertOutput('stderr', "Hello stderr 0\nHello stderr 1\nHello stderr 2\n")
            ]);
        });
    });
});