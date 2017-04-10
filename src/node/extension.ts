/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

'use strict';

import * as net from 'net';
import * as vscode from 'vscode';
import { spawn, spawnSync, exec } from 'child_process';
import { basename, join, isAbsolute, dirname } from 'path';
import * as nls from 'vscode-nls';
import * as fs from 'fs';

const localize = nls.config(process.env.VSCODE_NLS_CONFIG)();


export function activate(context: vscode.ExtensionContext) {

	context.subscriptions.push(vscode.commands.registerCommand('extension.node-debug.pickLoadedScript', () => pickLoadedScript()));

	context.subscriptions.push(vscode.commands.registerCommand('extension.pickNodeProcess', () => pickProcess()));

	context.subscriptions.push(vscode.commands.registerCommand('extension.node-debug.provideInitialConfigurations', () => createInitialConfigurations()));

	context.subscriptions.push(vscode.commands.registerCommand('extension.node-debug.startSession', config => startSession(config)));
}

export function deactivate() {
}

//---- loaded script picker

interface ScriptItem extends vscode.QuickPickItem {
	source?: any;	// Source
}

function pickLoadedScript() {

	return listLoadedScripts().then(items => {

		let options : vscode.QuickPickOptions = {
			placeHolder: localize('select.script', "Select a script"),
			matchOnDescription: true,
			matchOnDetail: true
		};

		if (items === undefined) {
			items = [ { label: localize('no.loaded.scripts', "No loaded scripts available"), description: '' } ];
		}

		vscode.window.showQuickPick(items, options).then(item => {
			if (item && item.source) {
				let uri = vscode.Uri.parse(`debug:${item.source.path}`);
				vscode.workspace.openTextDocument(uri).then(doc => vscode.window.showTextDocument(doc));
			}
		});
	});
}

function listLoadedScripts() : Thenable<ScriptItem[] | undefined> {
	return vscode.commands.executeCommand<string[]>('workbench.customDebugRequest', 'getLoadedScripts', {} ).then((reply: any) => {
		if (reply && reply.success) {
			return reply.body.loadedScripts;
		} else {
			return undefined;
		}
	});
}

//---- extension.pickNodeProcess

interface ProcessItem extends vscode.QuickPickItem {
	pid: string;	// payload for the QuickPick UI
}

function pickProcess() {

	return listProcesses().then(items => {

		let options : vscode.QuickPickOptions = {
			placeHolder: localize('pickNodeProcess', "Pick the node.js or gulp process to attach to"),
			matchOnDescription: true,
			matchOnDetail: true
		};

		return vscode.window.showQuickPick(items, options).then(item => {
			return item ? item.pid : null;
		});
	});
}

function listProcesses() : Promise<ProcessItem[]> {

	return new Promise((resolve, reject) => {

		const NODE = new RegExp('^(?:node|iojs|gulp)$', 'i');

		if (process.platform === 'win32') {

			const CMD_PID = new RegExp('^(.+) ([0-9]+)$');
			const EXECUTABLE_ARGS = new RegExp('^(?:"([^"]+)"|([^ ]+))(?: (.+))?$');

			let stdout = '';
			let stderr = '';

			const cmd = spawn('cmd');

			cmd.stdout.on('data', data => {
				stdout += data.toString();
			});
			cmd.stderr.on('data', data => {
				stderr += data.toString();
			});

			cmd.on('exit', () => {

				if (stderr.length > 0) {
					reject(stderr);
				} else {
					const items : ProcessItem[]= [];

					const lines = stdout.split('\r\n');
					for (const line of lines) {
						const matches = CMD_PID.exec(line.trim());
						if (matches && matches.length === 3) {

							let cmd = matches[1].trim();
							const pid = matches[2];

							// remove leading device specifier
							if (cmd.indexOf('\\??\\') === 0) {
								cmd = cmd.replace('\\??\\', '');
							}

							let executable_path: string | undefined;
							let args : string;
							const matches2 = EXECUTABLE_ARGS.exec(cmd);
							if (matches2 && matches2.length >= 2) {
								if (matches2.length >= 3) {
									executable_path = matches2[1] || matches2[2];
								} else {
									executable_path = matches2[1];
								}
								if (matches2.length === 4) {
									args = matches2[3];
								}
							}

							if (executable_path) {

								const executable_name = basename(executable_path);
								if (!NODE.test(executable_name)) {
									continue;
								}

								items.push({
									label: executable_name,
									description: pid,
									detail: cmd,
									pid: pid
								});
							}
						}
					};

					resolve(items);
				}
			});

			cmd.stdin.write('wmic process get ProcessId,CommandLine \n');
			cmd.stdin.end();

		} else {	// OS X & Linux

			const PID_CMD = new RegExp('^\\s*([0-9]+)\\s+(.+)$');
			const MAC_APPS = new RegExp('^.*/(.*).(?:app|bundle)/Contents/.*$');

			exec('ps -ax -o pid=,command=', { maxBuffer: 1000*1024 }, (err, stdout, stderr) => {

				if (err || stderr) {
					reject(err || stderr.toString());
				} else {
					const items : ProcessItem[]= [];

					const lines = stdout.toString().split('\n');
					for (const line of lines) {

						const matches = PID_CMD.exec(line);
						if (matches && matches.length === 3) {

							const pid = matches[1];
							const cmd = matches[2];
							const parts = cmd.split(' '); // this will break paths with spaces
							const executable_path = parts[0];
							const executable_name = basename(executable_path);

							if (!NODE.test(executable_name)) {
								continue;
							}

							let application = cmd;
							// try to show the correct name for OS X applications and bundles
							const matches2 = MAC_APPS.exec(cmd);
							if (matches2 && matches2.length === 2) {
								application = matches2[1];
							} else {
								application = executable_name;
							}

							items.unshift({		// build up list reverted
								label: application,
								description: pid,
								detail: cmd,
								pid: pid
							});
						}
					}

					resolve(items);
				}
			});
		}
	});
}

//---- extension.node-debug.provideInitialConfigurations

function loadPackage(folderPath: string): any {
	try {
		const packageJsonPath = join(folderPath, 'package.json');
		const jsonContent = fs.readFileSync(packageJsonPath, 'utf8');
		return JSON.parse(jsonContent);
	} catch (error) {
		// silently ignore
	}
	return undefined;
}

/**
 * returns an initial configuration json as a string
 */
function createInitialConfigurations(): string {

	const pkg = vscode.workspace.rootPath ? loadPackage(vscode.workspace.rootPath) : undefined;

	const config = {
		type: 'node',
		request: 'launch',
		name: localize('node.launch.config.name', "Launch Program")
	};

	const initialConfigurations = [ config ];

	if (pkg && pkg.name === 'mern-starter') {

		log(localize('mern.starter.explanation', "launch configuration for 'mern starter' project created."));
		configureMern(config);

	} else {
		let program: string | undefined = undefined;

		// try to find a better value for 'program' by analysing package.json
		if (pkg) {
			program = guessProgramFromPackage(pkg);
			if (program) {
				log(localize('program.guessed.from.package.json.explanation', "launch configuration created uses 'program' attribute guessed from package.json."));
			}
		}

		if (!program) {
			log(localize('program.fall.back.explanation', "launch configuration created will debug the file in the active editor."));
			program = '${file}';
		}
		config['program'] = program;

		// prepare for source maps by adding 'outFiles' if typescript or coffeescript is detected
		if (vscode.workspace.textDocuments.some(document => document.languageId === 'typescript' || document.languageId === 'coffeescript')) {
			log(localize('outFiles.explanation', "adjust the glob pattern in the 'outFiles' attribute so that it covers the generated JavaScript."));
			config['outFiles'] = [ '${workspaceRoot}/out/**/*.js' ];
		}
	}

	// Massage the configuration string, add an aditional tab and comment out processId.
	// Add an aditional empty line between attributes which the user should not edit.
	const configurationsMassaged = JSON.stringify(initialConfigurations, null, '\t').split('\n').map(line => '\t' + line).join('\n').trim();

	const comment1 = localize('launch.config.comment1', "Use IntelliSense to learn about possible Node.js debug attributes.");
	const comment2 = localize('launch.config.comment2', "Hover to view descriptions of existing attributes.");
	const comment3 = localize('launch.config.comment3', "For more information, visit: {0}", 'https://go.microsoft.com/fwlink/?linkid=830387');
	return [
		'{',
		`\t// ${comment1}`,
		`\t// ${comment2}`,
		`\t// ${comment3}`,
		'\t"version": "0.2.0",',
		'\t"configurations": ' + configurationsMassaged,
		'}'
	].join('\n');
}

function configureMern(config: any) {
	config.protocol = 'inspector';
	config.runtimeExecutable = 'nodemon';
	config.program = '${workspaceRoot}/index.js',
	config.port = 5858;
	config.timeout = 20000;
	config.restart = true;
	config.env = {
		BABEL_DISABLE_CACHE: '1',
		NODE_ENV: 'development'
	};
	config.console = 'integratedTerminal';
	config.internalConsoleOptions = "neverOpen";
}

/*
 * try to find the entry point ('main') from the package.json
 */
function guessProgramFromPackage(jsonObject: any): string | undefined {

	let program: string | undefined;

	try {
		if (jsonObject.main) {
			program = jsonObject.main;
		} else if (jsonObject.scripts && typeof jsonObject.scripts.start === 'string') {
			// assume a start script of the form 'node server.js'
			program = (<string>jsonObject.scripts.start).split(' ').pop();
		}

		if (program) {
			let path;
			if (isAbsolute(program)) {
				path = program;
			} else {
				path = join(<string>vscode.workspace.rootPath, program);
				program = join('${workspaceRoot}', program);
			}
			if (!fs.existsSync(path) && !fs.existsSync(path + '.js')) {
				return undefined;
			}
		}

	} catch (error) {
		// silently ignore
	}

	return program;
}

//---- extension.node-debug.startSession

// For launch, use inspector protocol starting with v8 because it's stable after that version.
const InspectorMinNodeVersionLaunch = 80000;

/**
 * The result type of the startSession command.
 */
class StartSessionResult {
	status: 'ok' | 'initialConfiguration' | 'saveConfiguration';
	content?: string;	// launch.json content for 'save'
};

function startSession(config: any): StartSessionResult {

	if (Object.keys(config).length === 0) { // an empty config represents a missing launch.json

		config.type = 'node';
		config.name = 'Launch';
		config.request = 'launch';

		if (vscode.workspace.rootPath) {

			// folder case: try to find more launch info in package.json
			const pkg = loadPackage(vscode.workspace.rootPath);
			if (pkg) {
				if (pkg.name === 'mern-starter') {
					configureMern(config);
				} else {
					config.program = guessProgramFromPackage(pkg);
				}
			}
		}

		if (!config.program) {

			// 'no folder' case (or no program found)
			const editor = vscode.window.activeTextEditor;
			if (editor && editor.document.languageId === 'javascript') {
				config.program = editor.document.fileName;
			} else {
				return {
					status: 'initialConfiguration'	// let VS Code create an initial configuration
				};
			}
		}
	}

	// make sure that 'launch' configs have a 'cwd' attribute set
	if (config.request === 'launch' && !config.cwd) {
		if (vscode.workspace.rootPath) {
			config.cwd = vscode.workspace.rootPath;
		} else if (config.program) {
			// derive 'cwd' from 'program'
			config.cwd = dirname(config.program);
		}
	}

	// determine what protocol to use

	let fixConfig = Promise.resolve<any>();

	switch (config.protocol) {
		case 'legacy':
			config.type = 'node';
			break;
		case 'inspector':
			config.type = 'node2';
			break;
		case 'auto':
		default:
			config.type = 'node';

			switch (config.request) {

				case 'attach':
					fixConfig = getProtocolForAttach(config).then(protocol => {
						if (protocol === 'inspector') {
							config.type = 'node2';
						}
					});
					break;

				case 'launch':
					if (config.runtimeExecutable) {
						log(localize('protocol.switch.runtime.set', "Debugging with legacy protocol because a runtime executable is set."));
					} else {
						// only determine version if no runtimeExecutable is set (and 'node' on PATH is used)
						const result = spawnSync('node', [ '--version' ]);
						const semVerString = result.stdout.toString();
						if (semVerString) {
							if (semVerStringToInt(semVerString) >= InspectorMinNodeVersionLaunch) {
								config.type = 'node2';
								log(localize('protocol.switch.inspector.version', "Debugging with inspector protocol because Node.js {0} was detected.", semVerString.trim()));
							} else {
								log(localize('protocol.switch.legacy.version', "Debugging with legacy protocol because Node.js {0} was detected.", semVerString.trim()));
							}
						} else {
							log(localize('protocol.switch.unknown.version', "Debugging with legacy protocol because Node.js version could not be determined."));
						}
					}
					break;

				default:
					// should not happen
					break;
			}
			break;
	}

	fixConfig.then(() => {
		vscode.commands.executeCommand('vscode.startDebug', config);
	});

	return {
		status: 'ok'
	};
}

function log(message: string) {
	vscode.commands.executeCommand('debug.logToDebugConsole', message + '\n');
}

/**
 * Detect which debug protocol is being used for a running node process.
 */
function getProtocolForAttach(config: any): Promise<string|undefined> {
	const address = config.address || '127.0.0.1';
	const port = config.port;

	if (config.processId) {
		// this is only supported for legacy protocol
		log(localize('protocol.switch.attach.process', "Debugging with legacy protocol because attaching to a process by ID is only supported for legacy protocol."));
		return Promise.resolve('legacy');
	}

	const socket = new net.Socket();
	const cleanup = () => {
		try {
			socket.write(`"Content-Length: 50\r\n\r\n{"command":"disconnect","type":"request","seq":2}"`);
			socket.end();
		} catch (e) {
			// ignore failure
		}
	};

	return new Promise<{reason: string, protocol: string}>((resolve, reject) => {
		socket.once('data', data => {
			let reason: string;
			let protocol: string;
			const dataStr = data.toString();
			if (dataStr.indexOf('WebSockets request was expected') >= 0) {
				reason = localize('protocol.switch.inspector.detected', "Debugging with inspector protocol because it was detected.");
				protocol = 'inspector';
			} else {
				reason = localize('protocol.switch.legacy.detected', "Debugging with legacy protocol because it was detected.");
				protocol = 'legacy';
			}

			resolve({ reason, protocol });
		});

		socket.once('error', err => {
			reject(err);
		});

		socket.connect(port, address);
		socket.on('connect', () => {
			// Send a safe request to trigger a response from the inspector protocol
			socket.write(`Content-Length: 102\r\n\r\n{"command":"evaluate","arguments":{"expression":"process.pid","global":true},"type":"request","seq":1}`);
		});

		setTimeout(() => {
			// No data or error received? Bail and let the debug adapter handle it.
			reject(new Error('timeout'));
		}, 2000);
	}).catch(err => {
		return {
			reason: localize('protocol.switch.unknown.error', "Debugging with legacy protocol because Node.js version could not be determined: {0}", err.toString()),
			protocol: 'legacy'
		};
	}).then(result => {
		cleanup();
		log(result.reason);

		return result.protocol;
	});
}

/**
 * convert the 3 parts of a semVer string into a single number
 */
function semVerStringToInt(vString: string): number {
	const match = vString.match(/v(\d+)\.(\d+)\.(\d+)/);
	if (match && match.length === 4) {
		return (parseInt(match[1])*100 + parseInt(match[2]))*100 + parseInt(match[3]);
	}
	return -1;
}
