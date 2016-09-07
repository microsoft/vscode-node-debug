/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as Path from 'path';
import * as FS from 'fs';
import * as CP from 'child_process';


export class Terminal
{
	private static WHICH = '/usr/bin/which';
	private static WHERE = 'C:\\Windows\\System32\\where.exe';
	private static TASK_KILL = 'C:\\Windows\\System32\\taskkill.exe';

	public static killTree(processId: number): void {

		if (process.platform === 'win32') {

			// when killing a process in Windows its child processes are *not* killed but become root processes.
			// Therefore we use TASKKILL.EXE
			try {
				CP.execSync(`${this.TASK_KILL} /F /T /PID ${processId}`);
			}
			catch (err) {
			}
		} else {

			// on linux and OS X we kill all direct and indirect child processes as well
			try {
				const cmd = Path.join(__dirname, './terminateProcess.sh');
				CP.spawnSync(cmd, [ processId.toString() ]);
			} catch (err) {
			}
		}
	}

	/*
	 * Is the given runtime executable on the PATH.
	 */
	public static isOnPath(program: string): boolean {

		if (process.platform === 'win32') {
			try {
				if (FS.existsSync(this.WHERE)) {
					CP.execSync(`${this.WHERE} ${program}`);
				} else {
					// do not report error if 'where' doesn't exist
				}
				return true;
			}
			catch (Exception) {
				// ignore
			}
		} else {
			try {
				if (FS.existsSync(this.WHICH)) {
					CP.execSync(`${this.WHICH} '${program}'`);
				} else {
					// do not report error if 'which' doesn't exist
				}
				return true;
			}
			catch (Exception) {
			}
		}
		return false;
	}
}
