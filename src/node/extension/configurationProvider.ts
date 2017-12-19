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
import { prepareAutoAttachChildProcesses } from './childProcesses';

//---- NodeConfigurationProvider

export class NodeConfigurationProvider implements vscode.DebugConfigurationProvider {

	/**
	 * Returns an initial debug configuration based on contextual information, e.g. package.json or folder.
	 */
	provideDebugConfigurations(folder: vscode.WorkspaceFolder | undefined, token?: vscode.CancellationToken): vscode.ProviderResult<vscode.DebugConfiguration[]> {

		return [ createLaunchConfigFromContext(folder, false) ];
	}

	/**
	 * Try to add all missing attributes to the debug configuration being launched.
	 */
	resolveDebugConfiguration(folder: vscode.WorkspaceFolder | undefined, config: vscode.DebugConfiguration, token?: vscode.CancellationToken): vscode.ProviderResult<vscode.DebugConfiguration> {

		// if launch.json is missing or empty
		if (!config.type && !config.request && !config.name) {

			config = createLaunchConfigFromContext(folder, true);

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

		if (config.runtimeVersion) {
			const dir = process.env['NVM_DIR'];
			if (dir) {
				const bin = join(dir, 'versions', 'node', `v${config.runtimeVersion}`, 'bin');
				if (fs.existsSync(bin)) {
					if (!config.env) {
						config.env = {};
					}
					// config.env['PATH'] = `${bin}:${process.env['PATH']}`;
					config.runtimeExecutable = join(bin, 'node');
				} else {
					return vscode.window.showInformationMessage(`nvm version ${config.runtimeVersion} not available`).then(_ => {
						return undefined;	// abort launch
					});
				}
			} else {
				// C:\Users\weinand\AppData\Roaming\nvm
				const home = process.env['NVM_HOME'];
				if (home) {
					const bin = join(home, `v${config.runtimeVersion}`);
					if (fs.existsSync(bin)) {
						if (!config.env) {
							config.env = {};
						}
						// config.env['Path'] = `${bin}:${process.env['Path']}`;
						config.runtimeExecutable = join(bin, 'node.exe');
					} else {
						return vscode.window.showInformationMessage(`nvm version ${config.runtimeVersion} not available`).then(_ => {
							return undefined;	// abort launch
						});
					}
				} else {
					return vscode.window.showInformationMessage(`nvm not available (environment available 'NVM_DIR' not found)`).then(_ => {
						return undefined;	// abort launch
					});
				}
			}
		}

		// is "auto attach child process" mode enabled?
		if (config.autoAttachChildProcesses) {
			prepareAutoAttachChildProcesses(config);
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

//---- helpers ----------------------------------------------------------------------------------------------------------------

function createLaunchConfigFromContext(folder: vscode.WorkspaceFolder | undefined, resolve: boolean): vscode.DebugConfiguration {

	const config = {
		type: 'node',
		request: 'launch',
		name: localize('node.launch.config.name', "Launch Program")
	};

	const pkg = loadJSON(folder, 'package.json');
	if (pkg && pkg.name === 'mern-starter') {

		if (resolve) {
			log(localize({ key: 'mern.starter.explanation', comment: ['argument contains product name without translation'] }, "Launch configuration for '{0}' project created.", 'Mern Starter'));
		}
		configureMern(config);

	} else {
		let program: string | undefined;
		let useSourceMaps = false;

		if (pkg) {
			// try to find a value for 'program' by analysing package.json
			program = guessProgramFromPackage(folder, pkg, resolve);
			if (program && resolve) {
				log(localize('program.guessed.from.package.json.explanation', "Launch configuration created based on 'package.json'."));
			}
		}

		if (!program) {
			// try to use file open in editor
			const editor = vscode.window.activeTextEditor;
			if (editor) {
				const languageId = editor.document.languageId;
				if (languageId === 'javascript' || isTranspiledLanguage(languageId)) {
					const wf = vscode.workspace.getWorkspaceFolder(editor.document.uri);
					if (wf === folder) {
						program = vscode.workspace.asRelativePath(editor.document.uri);
						if (!isAbsolute(program)) {
							program = '${workspaceFolder}/' + program;
						}
					}
				}
				useSourceMaps = isTranspiledLanguage(languageId);
			}
		}

		// if we couldn't find a value for 'program', we just let the launch config use the file open in the editor
		if (!resolve && !program) {
			program = '${file}';
		}

		if (program) {
			config['program'] = program;
		}

		// prepare for source maps by adding 'outFiles' if typescript or coffeescript is detected
		if (useSourceMaps || vscode.workspace.textDocuments.some(document => isTranspiledLanguage(document.languageId))) {
			if (resolve) {
				log(localize('outFiles.explanation', "Adjust glob pattern(s) in the 'outFiles' attribute so that they cover the generated JavaScript."));
			}

			let dir = '';
			const tsConfig = loadJSON(folder, 'tsconfig.json');
			if (tsConfig && tsConfig.compilerOptions && tsConfig.compilerOptions.outDir) {
				const outDir = <string> tsConfig.compilerOptions.outDir;
				if (!isAbsolute(outDir)) {
					dir = outDir;
					if (dir.indexOf('./') === 0) {
						dir = dir.substr(2);
					}
					if (dir[dir.length-1] !== '/') {
						dir += '/';
					}
				}
				config['preLaunchTask'] = 'tsc: build - tsconfig.json';
			}
			config['outFiles'] = ['${workspaceFolder}/' + dir + '**/*.js'];
		}
	}

	return config;
}

function loadJSON(folder: vscode.WorkspaceFolder | undefined, file: string): any {
	if (folder) {
		try {
			const path = join(folder.uri.fsPath, file);
			const content = fs.readFileSync(path, 'utf8');
			return JSON.parse(content);
		} catch (error) {
			// silently ignore
		}
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

function isTranspiledLanguage(languagId: string) : boolean {
	return languagId === 'typescript' || languagId === 'coffeescript';
}

/*
 * try to find the entry point ('main') from the package.json
 */
function guessProgramFromPackage(folder: vscode.WorkspaceFolder | undefined, packageJson: any, resolve: boolean): string | undefined {

	let program: string | undefined;

	try {
		if (packageJson.main) {
			program = packageJson.main;
		} else if (packageJson.scripts && typeof packageJson.scripts.start === 'string') {
			// assume a start script of the form 'node server.js'
			program = (<string>packageJson.scripts.start).split(' ').pop();
		}

		if (program) {
			let path: string | undefined;
			if (isAbsolute(program)) {
				path = program;
			} else {
				path = folder ? join(folder.uri.fsPath, program) : undefined;
				program = join('${workspaceFolder}', program);
			}
			if (resolve && path && !fs.existsSync(path) && !fs.existsSync(path + '.js')) {
				return undefined;
			}
		}

	} catch (error) {
		// silently ignore
	}

	return program;
}

//---- debug type -------------------------------------------------------------------------------------------------------------

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
