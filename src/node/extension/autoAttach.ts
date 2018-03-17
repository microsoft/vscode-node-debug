/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

import * as vscode from 'vscode';
import * as nls from 'vscode-nls';
import { pollProcesses, attachToProcess } from './nodeProcessTree';

const localize = nls.loadMessageBundle();

export function startAutoAttach(rootPid: number) : vscode.Disposable {

	return pollProcesses(rootPid, (pid, cmd) => {
		if (cmd.indexOf('node ') >= 0) {
			const name = localize('process.with.pid.label', "Process {0}", pid);
			attachToProcess(undefined, name, pid, cmd);
		}
	});
}
