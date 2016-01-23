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


	setup((done) => {
		dc = new DebugClient('node', DEBUG_ADAPTER, 'node');
		dc.start(done);
   });

   teardown(() => {
	   dc.stop();
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

		test('should return supported features', done => {
			dc.initializeRequest().then(response => {
				assert.equal(response.body.supportsConfigurationDoneRequest, true);
				done();
			}).catch(done);
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
				done();
			});
		});

	});

	suite('launch', () => {

		test('should run program to the end', done => {

			Promise.all([
				dc.configurationSequence(),

				dc.launch({ program: PROGRAM }),

				dc.waitForEvent('terminated')

			]).then((v) => {
				done();
			}).catch(done);
		});

		test('should stop on entry', done => {

			const ENTRY_LINE = 1

			Promise.all([
				dc.configurationSequence(),

				dc.launch({ program: PROGRAM, stopOnEntry: true }),

				dc.assertStoppedLocation('entry', ENTRY_LINE)

			]).then((v) => {
				done();
			}).catch(done);
		});

	});

	suite('setBreakpoints', () => {

		test('should stop on a breakpoint', done => {

			Promise.all([

				dc.waitForEvent('initialized').then(event => {
					return dc.setBreakpointsRequest({
						lines: [ BREAKPOINT_LINE ],
						breakpoints: [ { line: BREAKPOINT_LINE } ],
						source: { path: PROGRAM }
					});
				}).then(response => {
					const bp = response.body.breakpoints[0];
					assert.equal(bp.verified, true);
					assert.equal(bp.line, BREAKPOINT_LINE);
					return dc.configurationDoneRequest();
				}),

				dc.launch({ program: PROGRAM }),

				dc.assertStoppedLocation('breakpoint', BREAKPOINT_LINE)

			]).then((v) => {
				done();
			}).catch(done);
		});

		test('should stop on a conditional breakpoint', done => {

			const COND_BREAKPOINT_LINE = 13;

			Promise.all([

				dc.waitForEvent('initialized').then(event => {
					return dc.setBreakpointsRequest({
						breakpoints: [ { line: COND_BREAKPOINT_LINE, condition: "i === 3" } ],
						source: { path: PROGRAM }
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

			]).then((v) => {
				done();
			}).catch(done);
		});

		test('should stop on a breakpoint in TypeScript source', done => {

			const PROGRAM = Path.join(PROJECT_ROOT, 'src/tests/data/sourcemaps/src/classes.ts');
			const OUT_DIR = Path.join(PROJECT_ROOT, 'src/tests/data/sourcemaps/dist');
			const BREAKPOINT_LINE = 17;

			Promise.all([

				dc.waitForEvent('initialized').then(event => {
					return dc.setBreakpointsRequest({
						lines: [ BREAKPOINT_LINE ],
						breakpoints: [ { line: BREAKPOINT_LINE } ],
						source: { path: PROGRAM }
					});
				}).then(response => {
					const bp = response.body.breakpoints[0];
					assert.equal(bp.verified, true);
					assert.equal(bp.line, BREAKPOINT_LINE);
					return dc.configurationDoneRequest();
				}),

				dc.launch({
					program: PROGRAM,
					sourceMaps: true,
					outDir: OUT_DIR
				}),

				dc.assertStoppedLocation('breakpoint', BREAKPOINT_LINE)

			]).then((v) => {
				done();
			}).catch(done);
		});

	});

	suite('setExceptionBreakpoints', () => {

		const PROGRAM = Path.join(PROJECT_ROOT, 'src/tests/data/programWithException.js');
		const EXCEPTION_LINE = 6;
		const UNCAUGHT_EXCEPTION_LINE = 12;


		test('should stop on a caught exception', done => {

			Promise.all([

				dc.waitForEvent('initialized').then(event => {
					return dc.setExceptionBreakpointsRequest({
						filters: [ 'all' ]
					});
				}).then(response => {
					return dc.configurationDoneRequest();
				}),

				dc.launch({ program: PROGRAM }),

				dc.assertStoppedLocation('exception', EXCEPTION_LINE)

			]).then((v) => {
				done();
			}).catch(done);
		});

		test('should stop on uncaught exception', done => {

			Promise.all([

				dc.waitForEvent('initialized').then(event => {
					return dc.setExceptionBreakpointsRequest({
						filters: [ 'uncaught' ]
					});
				}).then(response => {
					return dc.configurationDoneRequest();
				}),

				dc.launch({ program: PROGRAM }),

				dc.assertStoppedLocation('exception', UNCAUGHT_EXCEPTION_LINE)

			]).then((v) => {
				done();
			}).catch(done);
		});

	});
});