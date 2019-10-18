/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import * as fs from 'fs';
import * as child_process from 'child_process';

const isWindows = process.platform === 'win32';
const is64bit = process.arch === 'x64';


export function subsystemLinuxPresent(): boolean {
	if (!isWindows) {
		return false;
	}
	const sysRoot = process.env['SystemRoot'] ||'C:\\WINDOWS';
	const bashPath32bitApp = path.join(sysRoot, 'Sysnative', 'bash.exe');
	const bashPath64bitApp = path.join(sysRoot, 'System32', 'bash.exe');
	const bashPathHost = is64bit ? bashPath64bitApp : bashPath32bitApp;
	return fs.existsSync(bashPathHost);
}

function windowsPathToWSLPath(windowsPath: string | undefined): string | undefined {
	if (!isWindows || !windowsPath) {
		return undefined;
	}
	if (path.isAbsolute(windowsPath)) {
		return `/mnt/${windowsPath.substr(0, 1).toLowerCase()}/${windowsPath.substr(3).replace(/\\/g, '/')}`;
	}
	return windowsPath.replace(/\\/g, '/');
}

export interface ILaunchArgs {
	cwd: string;
	executable: string;
	args: string[];
	combined: string[];
	localRoot?: string;
	remoteRoot?: string;
}

export function createLaunchArg(useSubsytemLinux: boolean | undefined, useExternalConsole: boolean, cwd: string | undefined, executable: string, args?: string[], program?: string): ILaunchArgs {

	if (useSubsytemLinux && subsystemLinuxPresent()) {
		const sysRoot = process.env['SystemRoot'] ||'C:\\WINDOWS';
		const bashPath32bitApp = path.join(sysRoot, 'Sysnative', 'bash.exe');
		const bashPath64bitApp = path.join(sysRoot, 'System32', 'bash.exe');
		const bashPathHost = is64bit ? bashPath64bitApp : bashPath32bitApp;
		const subsystemLinuxPath = useExternalConsole ? bashPath64bitApp : bashPathHost;

		let bashCommand = [executable].concat(args || []).map(element => {
			if (element === program) {	// workaround for issue #35249
				element = element.replace(/\\/g, '/');
			}
			return element.indexOf(' ') > 0 ? `'${element}'` : element;
		}).join(' ');

		return <ILaunchArgs>{
			cwd: cwd,
			executable: subsystemLinuxPath,
			args: ['-c', bashCommand],
			combined: [subsystemLinuxPath].concat(['-c', bashCommand]),
			localRoot: cwd,
			remoteRoot: windowsPathToWSLPath(cwd)
		};

	} else {
		return <ILaunchArgs>{
			cwd: cwd,
			executable: executable,
			args: args || [],
			combined: [executable].concat(args || [])
		};
	}
}

export function spawnSync(useWSL: boolean, executable: string, args?: string[], options?: child_process.SpawnSyncOptions) {
	const launchArgs = createLaunchArg(useWSL, false, undefined, executable, args);
	return child_process.spawnSync(launchArgs.executable, launchArgs.args, useWSL ? undefined : options);
}
