/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as Path from 'path';
import * as URL from 'url';
import * as FS from 'fs';


export function makePathAbsolute(absPath: string, relPath: string): string {
	return Path.resolve(Path.dirname(absPath), relPath);
}

export function removeFirstSegment(path: string) {
	const segments = path.split(Path.sep);
	segments.shift();
	if (segments.length > 0) {
		return segments.join(Path.sep);
	}
	return null;
}

export function makeRelative(target: string, path: string) {
	const t = target.split(Path.sep);
	const p = path.split(Path.sep);

	let i = 0;
	for (; i < Math.min(t.length, p.length) && t[i] === p[i]; i++) {
	}

	let result = '';
	for (; i < p.length; i++) {
		result = Path.join(result, p[i]);
	}
	return result;
}

/**
 * Given an absolute, normalized, and existing file path 'realPath' returns the exact path that the file has on disk.
 * On a case insensitive file system, the returned path might differ from the original path by character casing.
 * On a case sensitive file system, the returned path will always be identical to the original path.
 * In case of errors, null is returned. But you cannot use this function to verify that a path exists.
 * realPath does not handle '..' or '.' path segments and it does not take the locale into account.
 */
export function realPath(path: string): string {

	let dir = Path.dirname(path);
	if (path === dir) {	// end recursion
		return path;
	}
	let name = Path.basename(path).toLowerCase();
	try {
		let entries = FS.readdirSync(dir);
		let found = entries.filter((e) => e.toLowerCase() === name);	// use a case insensitive search
		if (found.length == 1) {
			// on a case sensitive filesystem we cannot determine here, whether the file exists or not, hence we need the 'file exists' precondition
			let prefix = realPath(dir);   // recurse
			if (prefix) {
				return Path.join(prefix, found[0]);
			}
		} else if (found.length > 1) {
			// must be a case sensitive filesystem
			let entry = found.find((e) => e === name);	// use a case sensitive search
			if (entry) {
				let prefix = realPath(dir);   // recurse
				if (prefix) {
					return Path.join(prefix, found[0]);
				}
			}
		}
	}
	catch (error) {
		// silently ignore error
	}
	return null;
}
