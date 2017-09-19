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
import { pickProcess } from './processPicker';

//---- NodeConfigurationProvider

export class NodeConfigurationProvider implements vscode.DebugConfigurationProvider {

	/**
	 * Returns an initial debug configurations based on contextual information, e.g. package.json or folder.
	 */
	provideDebugConfigurations(folder: vscode.WorkspaceFolder | undefined, token?: vscode.CancellationToken): vscode.ProviderResult<vscode.DebugConfiguration[]> {

		const pkg = folder ? loadPackage(folder) : undefined;

		const config = {
			type: 'node',
			request: 'launch',
			name: localize('node.launch.config.name', "Launch Program")
		};

		if (pkg && pkg.name === 'mern-starter') {

			log(localize({ key: 'mern.starter.explanation', comment: ['argument contains product name without translation'] }, "Launch configuration for '{0}' project created.", 'Mern Starter'));
			configureMern(config);

		} else {
			let program: string | undefined;

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
				config['outFiles'] = ['${workspaceFolder}/out/**/*.js'];
			}
		}

		return [ config ];
	}

	/**
	 * Try to add all missing attributes to the debug configuration being launched.
	 */
	resolveDebugConfiguration(folder: vscode.WorkspaceFolder | undefined, config: vscode.DebugConfiguration, token?: vscode.CancellationToken): vscode.ProviderResult<vscode.DebugConfiguration> {

		if (!config.type && !config.request && !config.name) {
			// probably a missing launch.json
			config = getFreshLaunchConfig(folder);
			if (!config.program) {
				const message = localize('program.not.found.message', "Cannot find a program to debug");
				return vscode.window.showInformationMessage(message).then(_ => {
					return undefined;	// abort launch
				});
			}
		}

		// make sure that config has a 'cwd' attribute set
		if (!config.cwd) {
			if (folder) {
				config.cwd = folder.uri.fsPath;
			} else if (config.program) {
				// derive 'cwd' from 'program'
				config.cwd = dirname(config.program);
			}
		}

		if (process.platform === 'win32' && config.request === 'launch' && typeof config.useWSL !== 'boolean') {
			const HOME = <string> process.env.HOME;
			if (HOME && HOME.indexOf('/home/') === 0) {
				config.useWSL = true;
			}
		}

		// determine which protocol to use
		return determineDebugType(config).then(debugType => {

			if (debugType) {
				config.type = debugType;
			}

			return config;
		});
	}
}

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

function configureMern(config: any) {
	config.protocol = 'inspector';
	config.runtimeExecutable = 'nodemon';
	config.program = '${workspaceFolder}/index.js';
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
function guessProgramFromPackage(folder: vscode.WorkspaceFolder | undefined, jsonObject: any): string | undefined {

	let program: string | undefined;

	try {
		if (jsonObject.main) {
			program = jsonObject.main;
		} else if (jsonObject.scripts && typeof jsonObject.scripts.start === 'string') {
			// assume a start script of the form 'node server.js'
			program = (<string>jsonObject.scripts.start).split(' ').pop();
		}

		if (program) {
			let path: string | undefined;
			if (isAbsolute(program)) {
				path = program;
			} else {
				path = folder ? join(folder.uri.fsPath, program) : undefined;
				program = join('${workspaceFolder}', program);
			}
			if (path && !fs.existsSync(path) && !fs.existsSync(path + '.js')) {
				return undefined;
			}
		}

	} catch (error) {
		// silently ignore
	}

	return program;
}

function getFreshLaunchConfig(folder: vscode.WorkspaceFolder | undefined): any {

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

function determineDebugType(config: any): Promise<string | null> {
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

function determineDebugTypeForPidConfig(config: any): Promise<string | null> {
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

function determineDebugTypeForPidInDebugMode(config: any, pid: number): Promise<string | null> {
	let debugProtocolP: Promise<string | null>;
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
