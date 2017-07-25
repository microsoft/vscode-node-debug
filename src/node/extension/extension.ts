/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

'use strict';

import * as vscode from 'vscode';
import { execSync } from 'child_process';
import { join, isAbsolute, dirname } from 'path';
import * as fs from 'fs';

import { log, localize } from './utilities';
import { detectDebugType, detectProtocolForPid, INSPECTOR_PORT_DEFAULT, LEGACY_PORT_DEFAULT } from './protocolDetection';
import { LoadedScriptsProvider, pickLoadedScript, openScript } from './loadedScripts';
import { pickProcess } from './processPicker';

let loadedScriptsProvider: LoadedScriptsProvider;

export function activate(context: vscode.ExtensionContext) {

	// launch config magic
	context.subscriptions.push(vscode.commands.registerCommand('extension.node-debug.provideInitialConfigurations', folderUri => createInitialConfigurations(folderUri)));
	context.subscriptions.push(vscode.commands.registerCommand('extension.node-debug.startSession', (config, folderUri) => startSession(config, folderUri)));

	// toggle skipping file action
	context.subscriptions.push(vscode.commands.registerCommand('extension.node-debug.toggleSkippingFile', toggleSkippingFile));

	// process quickpicker
	context.subscriptions.push(vscode.commands.registerCommand('extension.pickNodeProcess', () => pickProcess()));

	// loaded scripts
	loadedScriptsProvider= new LoadedScriptsProvider(context);
	vscode.window.registerTreeDataProvider('extension.node-debug.loadedScriptsExplorer', loadedScriptsProvider);
	context.subscriptions.push(vscode.commands.registerCommand('extension.node-debug.pickLoadedScript', () => pickLoadedScript()));
	context.subscriptions.push(vscode.commands.registerCommand('extension.node-debug.openScript', (session: vscode.DebugSession, path: string) => openScript(session, path)));
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


//---- extension.node-debug.provideInitialConfigurations

function loadPackage(folder: vscode.WorkspaceFolder): any {
	try {
		const packageJsonPath = join(folder.uri.fsPath, 'package.json');
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
function createInitialConfigurations(folderUri: vscode.Uri): string {

	const folder = getFolder(folderUri);
	const pkg = folder ? loadPackage(folder) : undefined;

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
			program = guessProgramFromPackage(folder, pkg);
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
	config.program = '${workspaceRoot}/index.js';
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
function guessProgramFromPackage(folder: vscode.WorkspaceFolder, jsonObject: any): string | undefined {

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
				path = join(folder.uri.fsPath, program);
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

/**
 * Tried to find a WorkspaceFolder for the given folderUri.
 * If not found, the first WorkspaceFolder is returned.
 * If the workspace has no folders, undefined is returned.
 */
function getFolder(folderUri: vscode.Uri | undefined) : vscode.WorkspaceFolder | undefined {

	let folder: vscode.WorkspaceFolder;
	const folders = vscode.workspace.workspaceFolders;
	if (folders && folders.length > 0) {
		folder = folders[0];
		if (folderUri) {
			const s = folderUri.toString();
			const found = folders.filter(f => f.uri.toString() === s);
			if (found.length > 0) {
				folder = found[0];
			}
		}
	}
	return folder;
}

function startSession(config: any, folderUri: vscode.Uri | undefined): Thenable<StartSessionResult> {

	const folder = getFolder(folderUri);

	if (Object.keys(config).length === 0) { // an empty config represents a missing launch.json
		config = getFreshLaunchConfig(folder);
		if (!config.program) {
			const message = localize('program.not.found.message', "Cannot find a program to debug");
			const action = localize('create.launch.json.action', "Create {0}", 'launch.json');
			return vscode.window.showInformationMessage(message, action).then(a => {
				if (a === action) {
					// let VS Code create an initial configuration
					return <StartSessionResult>{
						status: 'initialConfiguration'
					};
				} else {
					return <StartSessionResult>{
						status: 'ok'
					};
				}
			});
		}
	}

	// make sure that 'launch' configs have a 'cwd' attribute set
	if (config.request === 'launch' && !config.cwd) {
		if (folder) {
			config.cwd = folder.uri.fsPath;
		} else if (config.program) {
			// derive 'cwd' from 'program'
			config.cwd = dirname(config.program);
		}
	}

	// determine which protocol to use
	return determineDebugType(config).then(debugType => {

		if (debugType) {
			config.type = debugType;
			vscode.commands.executeCommand('vscode.startDebug', config, folder.uri);
		}

		return <StartSessionResult>{
			status: 'ok'
		};
	});
}

function getFreshLaunchConfig(folder: vscode.WorkspaceFolder): any {

	const config: any = {
		type: 'node',
		name: 'Launch',
		request: 'launch'
	};

	if (folder) {

		// folder case: try to find more launch info in package.json
		const pkg = loadPackage(folder);
		if (pkg) {
			if (pkg.name === 'mern-starter') {
				configureMern(config);
			} else {
				config.program = guessProgramFromPackage(folder, pkg);
			}
		}
	}

	if (!config.program) {

		// 'no folder' case (or no program found)
		const editor = vscode.window.activeTextEditor;
		if (editor && editor.document.languageId === 'javascript') {
			config.program = editor.document.fileName;
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
	const getPidP = isPickProcessCommand(config.processId) ?
		pickProcess() :
		Promise.resolve(config.processId);

	return getPidP.then(pid => {
		if (pid && pid.match(/^[0-9]+$/)) {
			const pidNum = Number(pid);
			putPidInDebugMode(pidNum);

			return determineDebugTypeForPidInDebugMode(config, pidNum);
		} else {
			throw new Error(localize('VSND2006', "Attach to process: '{0}' doesn't look like a process id.", pid));
		}
	}).then(debugType => {
		if (debugType) {
			// processID is handled, so turn this config into a normal port attach config
			config.processId = undefined;
			config.port = debugType === 'node2' ? INSPECTOR_PORT_DEFAULT : LEGACY_PORT_DEFAULT;
		}

		return debugType;
	});
}

function isPickProcessCommand(configProcessId: string): boolean {
	configProcessId = configProcessId.trim();
	return configProcessId === '${command:PickProcess}' || configProcessId === '${command:extension.pickNodeProcess}';
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
