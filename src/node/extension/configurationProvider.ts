/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

'use strict';

import * as nls from 'vscode-nls';
import * as vscode from 'vscode';
import { join, isAbsolute, dirname, relative } from 'path';
import * as fs from 'fs';

import { writeToConsole, mkdirP, Logger } from './utilities';
import { detectDebugType } from './protocolDetection';
import { resolveProcessId } from './processPicker';
import { Cluster } from './cluster';

const DEBUG_SETTINGS = 'debug.node';
const SHOW_USE_WSL_IS_DEPRECATED_WARNING_SETTING = 'showUseWslIsDeprecatedWarning';
const USE_V3_SETTING = 'useV3';
const DEFAULT_JS_PATTERNS: ReadonlyArray<string> = ['*.js', '*.es6', '*.jsx', '*.mjs'];

const localize = nls.loadMessageBundle();
let stopOnEntry = false;

export function startDebuggingAndStopOnEntry() {
	stopOnEntry = true;
	vscode.commands.executeCommand('workbench.action.debug.start');
}

//---- NodeConfigurationProvider

export class NodeConfigurationProvider implements vscode.DebugConfigurationProvider {

	private _logger: Logger;

	constructor(private _extensionContext: vscode.ExtensionContext) {
		this._logger = new Logger();
	}

	/**
	 * Returns an initial debug configuration based on contextual information, e.g. package.json or folder.
	 */
	provideDebugConfigurations(folder: vscode.WorkspaceFolder | undefined, token?: vscode.CancellationToken): vscode.ProviderResult<vscode.DebugConfiguration[]> {

		return [createLaunchConfigFromContext(folder, false)];
	}

	/**
	 * Try to add all missing attributes to the debug configuration being launched.
	 */
	resolveDebugConfiguration(folder: vscode.WorkspaceFolder | undefined, config: vscode.DebugConfiguration, token?: vscode.CancellationToken): vscode.ProviderResult<vscode.DebugConfiguration> {
		return this.resolveConfigAsync(folder, config).catch(err => {
			return vscode.window.showErrorMessage(err.message, { modal: true }).then(_ => undefined); // abort launch
		});
	}

	/**
	 * Try to add all missing attributes to the debug configuration being launched.
	 */
	private async resolveConfigAsync(folder: vscode.WorkspaceFolder | undefined, config: vscode.DebugConfiguration, token?: vscode.CancellationToken): Promise<vscode.DebugConfiguration | undefined> {

		// if launch.json is missing or empty
		if (!config.type && !config.request && !config.name) {

			config = createLaunchConfigFromContext(folder, true, config);

			if (!config.program) {
				throw new Error(localize('program.not.found.message', "Cannot find a program to debug"));
			}
		}

		// make sure that config has a 'cwd' attribute set
		if (!config.cwd) {
			if (folder) {
				config.cwd = folder.uri.fsPath;
			}

			// no folder -> config is a user or workspace launch config
			if (!config.cwd && vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
				config.cwd = vscode.workspace.workspaceFolders[0].uri.fsPath;
			}

			// no folder case
			if (!config.cwd && config.program === '${file}') {
				config.cwd = '${fileDirname}';
			}

			// program is some absolute path
			if (!config.cwd && config.program && isAbsolute(config.program)) {
				// derive 'cwd' from 'program'
				config.cwd = dirname(config.program);
			}

			// last resort
			if (!config.cwd && folder) {
				config.cwd = '${workspaceFolder}';
			}
		}

		// if a 'remoteRoot' is specified without a corresponding 'localRoot', set 'localRoot' to the workspace folder.
		// see https://github.com/Microsoft/vscode/issues/63118
		if (config.remoteRoot && !config.localRoot) {
			config.localRoot = '${workspaceFolder}';
		}

		// warn about deprecated 'useWSL' attribute.
		if (typeof config.useWSL !== 'undefined') {
			this.warnAboutUseWSL();
		}

		// remove 'useWSL' on all platforms but Windows
		if (process.platform !== 'win32' && config.useWSL) {
			this._logger.debug('useWSL attribute ignored on non-Windows OS.');
			delete config.useWSL;
		}

		// "nvm" support
		if (config.request === 'launch' && typeof config.runtimeVersion === 'string' && config.runtimeVersion !== 'default') {
			await this.nvmSupport(config);
		}

		// "auto attach child process" (aka Cluster) support
		if (config.autoAttachChildProcesses) {
			Cluster.prepareAutoAttachChildProcesses(folder, config);
			// if no console is set, use the integrated terminal so that output of all child processes goes to one terminal. See https://github.com/Microsoft/vscode/issues/62420
			if (!config.console) {
				config.console = 'integratedTerminal';
			}
		}

		// when using "integratedTerminal" ensure that debug console doesn't get activated; see https://github.com/Microsoft/vscode/issues/43164
		if (config.console === 'integratedTerminal' && !config.internalConsoleOptions) {
			config.internalConsoleOptions = 'neverOpen';
		}

		// "attach to process via picker" support
		if (config.request === 'attach' && typeof config.processId === 'string') {
			// we resolve Process Picker early (before VS Code) so that we can probe the process for its protocol
			if (await resolveProcessId(config)) {
				return undefined;	// abort launch
			}
		}

		// finally determine which protocol to use
		const debugType = await determineDebugType(config, this._logger);
		if (debugType) {
			config.type = debugType;
		}

		// fixup log parameters
		if (config.trace && !config.logFilePath) {
			const fileName = config.type === 'node' ? 'debugadapter-legacy.txt' : 'debugadapter.txt';

			if (this._extensionContext.logPath) {
				try {
					await mkdirP(this._extensionContext.logPath);
				} catch (e) {
					// Already exists
				}

				config.logFilePath = join(this._extensionContext.logPath, fileName);
			}
		}
		if (stopOnEntry) {
			config.stopOnEntry = true;
			stopOnEntry = false;
		}

		// tell the extension what file patterns can be debugged
		config.__debuggablePatterns = this.getJavaScriptPatterns();

		// everything ok: let VS Code start the debug session
		return config;
	}

	private getJavaScriptPatterns() {
		const associations = vscode.workspace.getConfiguration('files.associations');
		const extension = vscode.extensions.getExtension<{}>('ms-vscode.node-debug');
		if (!extension) {
			throw new Error('Expected to be able to load extension data');
		}

		const handledLanguages = extension.packageJSON.contributes.breakpoints.map(b => b.language);
		return Object.keys(associations)
			.filter(pattern => handledLanguages.indexOf(associations[pattern]) !== -1)
			.concat(DEFAULT_JS_PATTERNS);
	}

	private warnAboutUseWSL() {

		interface MyMessageItem extends vscode.MessageItem {
			id: number;
		}

		if (vscode.workspace.getConfiguration(DEBUG_SETTINGS).get<boolean>(SHOW_USE_WSL_IS_DEPRECATED_WARNING_SETTING, true)) {
			vscode.window.showWarningMessage<MyMessageItem>(
				localize(
					'useWslDeprecationWarning.title',
					"Attribute 'useWSL' is deprecated. Please use the 'Remote WSL' extension instead. Click [here]({0}) to learn more.",
					'https://go.microsoft.com/fwlink/?linkid=2097212'
				), {
					title: localize('useWslDeprecationWarning.doNotShowAgain', "Don't Show Again"),
					id: 1
				}
			).then(selected => {
				if (!selected) {
					return;
				}
				switch (selected.id) {
					case 1:
						vscode.workspace.getConfiguration(DEBUG_SETTINGS).update(SHOW_USE_WSL_IS_DEPRECATED_WARNING_SETTING, false, vscode.ConfigurationTarget.Global);
						break;
				}
			});
		}
	}

	/**
	 * if a runtime version is specified we prepend env.PATH with the folder that corresponds to the version.
	 * Returns false on error
	 */
	private async nvmSupport(config: vscode.DebugConfiguration): Promise<void> {

		let bin: string | undefined = undefined;
		let versionManagerName: string | undefined = undefined;

		// first try the Node Version Switcher 'nvs'
		let nvsHome = process.env['NVS_HOME'];
		if (!nvsHome) {
			// NVS_HOME is not always set. Probe for 'nvs' directory instead
			const nvsDir = process.platform === 'win32' ? join(process.env['LOCALAPPDATA'] || '', 'nvs') : join(process.env['HOME'] || '', '.nvs');
			if (fs.existsSync(nvsDir)) {
				nvsHome = nvsDir;
			}
		}

		const { nvsFormat, remoteName, semanticVersion, arch } = parseVersionString(config.runtimeVersion);

		if (nvsFormat || nvsHome) {
			if (nvsHome) {
				bin = join(nvsHome, remoteName, semanticVersion, arch);
				if (process.platform !== 'win32') {
					bin = join(bin, 'bin');
				}
				versionManagerName = 'nvs';
			} else {
				throw new Error(localize('NVS_HOME.not.found.message', "Attribute 'runtimeVersion' requires Node.js version manager 'nvs'."));
			}
		}

		if (!bin) {

			// now try the Node Version Manager 'nvm'
			if (process.platform === 'win32') {
				const nvmHome = process.env['NVM_HOME'];
				if (!nvmHome) {
					throw new Error(localize('NVM_HOME.not.found.message', "Attribute 'runtimeVersion' requires Node.js version manager 'nvm-windows' or 'nvs'."));
				}
				bin = join(nvmHome, `v${config.runtimeVersion}`);
				versionManagerName = 'nvm-windows';
			} else {	// macOS and linux
				let nvmHome = process.env['NVM_DIR'];
				if (!nvmHome) {
					// if NVM_DIR is not set. Probe for '.nvm' directory instead
					const nvmDir = join(process.env['HOME'] || '', '.nvm');
					if (fs.existsSync(nvmDir)) {
						nvmHome = nvmDir;
					}
				}
				if (!nvmHome) {
					throw new Error(localize('NVM_DIR.not.found.message', "Attribute 'runtimeVersion' requires Node.js version manager 'nvm' or 'nvs'."));
				}
				bin = join(nvmHome, 'versions', 'node', `v${config.runtimeVersion}`, 'bin');
				versionManagerName = 'nvm';
			}
		}

		if (fs.existsSync(bin)) {
			if (!config.env) {
				config.env = {};
			}
			if (process.platform === 'win32') {
				config.env['Path'] = `${bin};${process.env['Path']}`;
			} else {
				config.env['PATH'] = `${bin}:${process.env['PATH']}`;
			}
		} else {
			throw new Error(localize('runtime.version.not.found.message', "Node.js version '{0}' not installed for '{1}'.", config.runtimeVersion, versionManagerName));
		}
	}
}

//---- helpers ----------------------------------------------------------------------------------------------------------------

function createLaunchConfigFromContext(folder: vscode.WorkspaceFolder | undefined, resolve: boolean, existingConfig?: vscode.DebugConfiguration): vscode.DebugConfiguration {

	const config = {
		type: 'node',
		request: 'launch',
		name: localize('node.launch.config.name', "Launch Program"),
		skipFiles: ['<node_internals>/**'],
	};

	if (existingConfig && existingConfig.noDebug) {
		config['noDebug'] = true;
	}

	const pkg = loadJSON(folder, 'package.json');
	if (pkg && pkg.name === 'mern-starter') {

		if (resolve) {
			writeToConsole(localize({ key: 'mern.starter.explanation', comment: ['argument contains product name without translation'] }, "Launch configuration for '{0}' project created.", 'Mern Starter'));
		}
		configureMern(config);

	} else {
		let program: string | undefined;
		let useSourceMaps = false;

		if (pkg) {
			// try to find a value for 'program' by analysing package.json
			program = guessProgramFromPackage(folder, pkg, resolve);
			if (program && resolve) {
				writeToConsole(localize('program.guessed.from.package.json.explanation', "Launch configuration created based on 'package.json'."));
			}
		}

		if (!program) {
			// try to use file open in editor
			const editor = vscode.window.activeTextEditor;
			if (editor) {
				const languageId = editor.document.languageId;
				if (languageId === 'javascript' || isTranspiledLanguage(languageId)) {
					const wf = vscode.workspace.getWorkspaceFolder(editor.document.uri);
					if (wf && wf === folder) {
						program = relative(wf.uri.fsPath || '/', editor.document.uri.fsPath || '/');
						if (program && !isAbsolute(program)) {
							program = join('${workspaceFolder}', program);
						}
					}
				}
				useSourceMaps = isTranspiledLanguage(languageId);
			}
		}

		// if we couldn't find a value for 'program', we just let the launch config use the file open in the editor
		if (!program) {
			program = '${file}';
		}

		if (program) {
			config['program'] = program;
		}

		// prepare for source maps by adding 'outFiles' if typescript or coffeescript is detected
		if (useSourceMaps || vscode.workspace.textDocuments.some(document => isTranspiledLanguage(document.languageId))) {
			if (resolve) {
				writeToConsole(localize('outFiles.explanation', "Adjust glob pattern(s) in the 'outFiles' attribute so that they cover the generated JavaScript."));
			}

			let dir = '';
			const tsConfig = loadJSON(folder, 'tsconfig.json');
			if (tsConfig && tsConfig.compilerOptions && tsConfig.compilerOptions.outDir) {
				const outDir = <string>tsConfig.compilerOptions.outDir;
				if (!isAbsolute(outDir)) {
					dir = outDir;
					if (dir.indexOf('./') === 0) {
						dir = dir.substr(2);
					}
					if (dir[dir.length - 1] !== '/') {
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

function isTranspiledLanguage(languagId: string): boolean {
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

async function determineDebugType(config: any, logger: Logger): Promise<string | null> {
	const useV3 = !!vscode.workspace.getConfiguration(DEBUG_SETTINGS).get(USE_V3_SETTING);
	if (useV3) {
		config['__workspaceFolder'] = '${workspaceFolder}';
		return 'pwa-node';
	} else if (config.protocol === 'legacy') {
		return 'node';
	} else if (config.protocol === 'inspector') {
		return 'node2';
	} else {
		// 'auto', or unspecified
		return detectDebugType(config, logger);
	}
}

function nvsStandardArchName(arch) {
	switch (arch) {
		case '32':
		case 'x86':
		case 'ia32':
			return 'x86';
		case '64':
		case 'x64':
		case 'amd64':
			return 'x64';
		case 'arm':
			const arm_version = (process.config.variables as any).arm_version;
			return arm_version ? 'armv' + arm_version + 'l' : 'arm';
		default:
			return arch;
	}
}

/**
 * Parses a node version string into remote name, semantic version, and architecture
 * components. Infers some unspecified components based on configuration.
 */
function parseVersionString(versionString) {
	const versionRegex = /^(([\w-]+)\/)?(v?(\d+(\.\d+(\.\d+)?)?))(\/((x86)|(32)|((x)?64)|(arm\w*)|(ppc\w*)))?$/i;

	const match = versionRegex.exec(versionString);
	if (!match) {
		throw new Error('Invalid version string: ' + versionString);
	}

	const nvsFormat = !!(match[2] || match[8]);
	const remoteName = match[2] || 'node';
	const semanticVersion = match[4] || '';
	const arch = nvsStandardArchName(match[8] || process.arch);

	return { nvsFormat, remoteName, semanticVersion, arch };
}
