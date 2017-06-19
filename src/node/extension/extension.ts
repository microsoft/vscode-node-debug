/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

'use strict';

import * as vscode from 'vscode';
import { spawn, exec, execSync } from 'child_process';
import { basename, join, isAbsolute, dirname } from 'path';
import * as fs from 'fs';
import { log, localize } from './utilities';
import { detectDebugType, detectProtocolForPid, INSPECTOR_PORT_DEFAULT, LEGACY_PORT_DEFAULT } from './protocolDetection';

export function activate(context: vscode.ExtensionContext) {

	context.subscriptions.push(vscode.commands.registerCommand('extension.node-debug.toggleSkippingFile', toggleSkippingFile));
	context.subscriptions.push(vscode.commands.registerCommand('extension.node-debug.pickLoadedScript', () => pickLoadedScript()));
	context.subscriptions.push(vscode.commands.registerCommand('extension.node-debug.provideInitialConfigurations', () => createInitialConfigurations()));
	context.subscriptions.push(vscode.commands.registerCommand('extension.node-debug.startSession', config => startSession(config)));
	context.subscriptions.push(vscode.commands.registerCommand('extension.pickNodeProcess', () => pickProcess()));
}

export function deactivate() {
}

//---- toggle skipped files

function toggleSkippingFile(res: string | number): void {

	let resource: string | number | undefined = res;

	if (!resource) {
		const activeEditor = vscode.window.activeTextEditor;
		resource = activeEditor && activeEditor.document.fileName;
	}

	if (resource) {
		const args = typeof resource === 'string' ? { resource } : { sourceReference: resource };
		vscode.commands.executeCommand('workbench.customDebugRequest', 'toggleSkipFileStatus', args);
	}
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
			matchOnDetail: true,
			ignoreFocusOut: true
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

function pickProcess(): Promise<string|null> {
	return listProcesses().then(items => {
		let options : vscode.QuickPickOptions = {
			placeHolder: localize('pickNodeProcess', "Pick the node.js or gulp process to attach to"),
			matchOnDescription: true,
			matchOnDetail: true,
			ignoreFocusOut: true
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

								let executable_name = basename(executable_path);
								executable_name = executable_name.split('.')[0];
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
					}

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

		log(localize({ key: 'mern.starter.explanation', comment: [ 'argument contains product name without translation' ]}, "Launch configuration for '{0}' project created.", 'Mern Starter'));
		configureMern(config);

	} else {
		let program: string | undefined = undefined;

		// try to find a better value for 'program' by analysing package.json
		if (pkg) {
			program = guessProgramFromPackage(pkg);
			if (program) {
				log(localize('program.guessed.from.package.json.explanation', "Launch configuration created based on 'package.json'."));
			}
		}

		if (!program) {
			log(localize('program.fall.back.explanation', "Launch configuration created will debug file in the active editor."));
			program = '${file}';
		}
		config['program'] = program;

		// prepare for source maps by adding 'outFiles' if typescript or coffeescript is detected
		if (vscode.workspace.textDocuments.some(document => document.languageId === 'typescript' || document.languageId === 'coffeescript')) {
			log(localize('outFiles.explanation', "Adjust glob pattern(s) in the 'outFiles' attribute so that they cover the generated JavaScript."));
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
	config.runtimeArgs = [ '--inspect=9222' ];
	config.program = '${workspaceRoot}/index.js';
	config.port = 9222;
	config.restart = true;
	config.env = {
		BABEL_DISABLE_CACHE: '1',
		NODE_ENV: 'development'
	};
	config.console = 'integratedTerminal';
	config.internalConsoleOptions = 'neverOpen';
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

/**
 * The result type of the startSession command.
 */
class StartSessionResult {
	status: 'ok' | 'initialConfiguration' | 'saveConfiguration';
	content?: string;	// launch.json content for 'save'
}

function startSession(config: any): Promise<StartSessionResult> {
	if (Object.keys(config).length === 0) { // an empty config represents a missing launch.json
		config = getFreshLaunchConfig();
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

	// determine which protocol to use
	return determineDebugType(config).then(debugType => {
		if (debugType) {
			config.type = debugType;
			vscode.commands.executeCommand('vscode.startDebug', config);
		}

		return <StartSessionResult>{
			status: 'ok'
		};
	});
}

function getFreshLaunchConfig(): any {
	const config: any = {
		type: 'node',
		name: 'Launch',
		request: 'launch'
	};

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

	return config;
}

function determineDebugType(config: any): Promise<string|null> {
	if (config.request === 'attach' && typeof config.processId === 'string') {
		return determineDebugTypeForPidConfig(config);
	} else if (config.protocol === 'legacy') {
		return Promise.resolve('node');
	} else if (config.protocol === 'inspector') {
		return Promise.resolve('node2');
	} else {
		// 'auto', or unspecified
		return detectDebugType(config);
	}
}

function determineDebugTypeForPidConfig(config: any): Promise<string|null> {
	const getPidP = config.processId.trim() === '${command:PickProcess}' ?
		pickProcess() :
		Promise.resolve(config.processId);

	return getPidP.then(pid => {
		if (pid && pid.match(/[0-9]+/)) {
			const pidNum = Number(pid);
			putPidInDebugMode(pidNum); // TODO catch and save error for later

			return determineDebugTypeForPidInDebugMode(config, pidNum);
		}

		return null;
	}).then(debugType => {
		if (debugType) {
			// processID is handled, so turn this config into a normal port attach config
			config.processId = undefined;
			config.port = debugType === 'node2' ? INSPECTOR_PORT_DEFAULT : LEGACY_PORT_DEFAULT;
		}

		return debugType;
	});
}

function putPidInDebugMode(pid: number): void {
	try {
		if (process.platform === 'win32') {
			// regular node has an undocumented API function for forcing another node process into debug mode.
			// 		(<any>process)._debugProcess(pid);
			// But since we are running on Electron's node, process._debugProcess doesn't work (for unknown reasons).
			// So we use a regular node instead:
			const command = `node -e process._debugProcess(${pid})`;
			execSync(command);
		} else {
			process.kill(pid, 'SIGUSR1');
		}
	} catch (e) {
		throw new Error(localize('VSND2021', "Attach to process: cannot enable debug mode for process '{0}' ({1}).", pid, e));
	}
}

function determineDebugTypeForPidInDebugMode(config: any, pid: number): Promise<string|null> {
	let debugProtocolP: Promise<string|null>;
	if (config.port === INSPECTOR_PORT_DEFAULT) {
		debugProtocolP = Promise.resolve('inspector');
	} else if (config.port === LEGACY_PORT_DEFAULT) {
		debugProtocolP = Promise.resolve('legacy');
	} else if (config.protocol) {
		debugProtocolP = Promise.resolve(config.protocol);
	} else {
		debugProtocolP = detectProtocolForPid(pid);
	}

	return debugProtocolP.then(debugProtocol => {
		return debugProtocol === 'inspector' ? 'node2' :
			debugProtocol === 'legacy' ? 'node' :
			null;
	});
}
