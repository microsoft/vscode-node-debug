import * as path from 'path';
import * as fs from 'fs';
import * as child_process from 'child_process';

const isWindows = process.platform === 'win32';
const is64bit = process.arch === 'x64';

const bashPath32bitApp = path.join(process.env['SystemRoot'], 'Sysnative', 'bash.exe');
const bashPath64bitApp = path.join(process.env['SystemRoot'], 'System32', 'bash.exe');
const bashPathHost = is64bit ? bashPath64bitApp : bashPath32bitApp;

export function subsystemLinuxPresent() : boolean {
	const bashPath = is64bit ? bashPath64bitApp : bashPath32bitApp;
	if (!isWindows) {
		return false;
	}
	return fs.existsSync(bashPath);
}

function windowsPathToWSLPath(windowsPath: string) : string {
	if (!windowsPath || !isWindows) {
		return undefined;
	} else if (path.isAbsolute(windowsPath)) {
		return `/mnt/${windowsPath.substr(0,1).toLowerCase()}/${windowsPath.substr(3).replace(/\\/g, '/')}`;
	} else {
		return windowsPath.replace(/\\/g, '/');
	}
}

export interface ILaunchArgs {
	cwd: string;
	executable: string;
	args: string[];
	combined: string[];
	localRoot?: string;
	remoteRoot?: string;
}

export function createLaunchArg(useSubsytemLinux: boolean, useExternalConsole: boolean, cwd: string | undefined, executable: string, args?: string[]): ILaunchArgs {
	const subsystemLinuxPath = useExternalConsole ? bashPath64bitApp : bashPathHost;

	if (useSubsytemLinux) {
		let bashCommand = [executable].concat(args || []).map((element) => {
			return element.indexOf(' ') > 0 ? `'${element}'` : element;
		}).join(' ');
		return <ILaunchArgs>{
			cwd: cwd,
			executable: subsystemLinuxPath,
			args: ['-ic', bashCommand],
			combined: [subsystemLinuxPath].concat(['-ic', bashCommand]),
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

export function spawn(useWSL: boolean, executable: string, args?: string[], options? : child_process.SpawnOptions) {
	const launchArgs = createLaunchArg(useWSL, false, undefined, executable, args);
	return child_process.spawn(launchArgs.executable, launchArgs.args, options);
}

export function spawnSync(useWSL: boolean, executable: string, args?: string[], options? : child_process.SpawnSyncOptions) {
	const launchArgs = createLaunchArg(useWSL, false, undefined, executable, args);
	return child_process.spawnSync(launchArgs.executable, launchArgs.args, options);
}
