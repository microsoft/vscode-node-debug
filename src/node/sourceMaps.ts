/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as Path from 'path';
import * as FS from 'fs';
import * as URL from 'url';
import {SourceMapConsumer} from 'source-map';
import * as PathUtils from './pathUtilities';

var util = require('../../node_modules/source-map/lib/util.js');


export interface MappingResult {
	path: string;		// absolute path
	content?: string;	// optional content of source (source inlined in source map)
	line: number;
	column: number;
}

export interface ISourceMaps {
	/*
	 * Map source language path to generated path.
	 * Returns null if not found.
	 */
	MapPathFromSource(path: string): string;

	/*
	 * Map location in source language to location in generated code.
	 * line and column are 0 based.
	 */
	MapFromSource(path: string, line: number, column: number): MappingResult;

	/*
	 * Map location in generated code to location in source language.
	 * line and column are 0 based.
	 */
	MapToSource(path: string, line: number, column: number): MappingResult;
}


export class SourceMaps implements ISourceMaps {

	public static TRACE = false;

	private static SOURCE_MAPPING_MATCHER = new RegExp("//[#@] ?sourceMappingURL=(.+)$");

	private _generatedToSourceMaps:  { [id: string] : SourceMap; } = {};		// generated -> source file
	private _sourceToGeneratedMaps:  { [id: string] : SourceMap; } = {};		// source file -> generated
	private _generatedCodeDirectory: string;


	public constructor(generatedCodeDirectory: string) {
		this._generatedCodeDirectory = generatedCodeDirectory;
	}

	public MapPathFromSource(pathToSource: string): string {
		var map = this._findSourceToGeneratedMapping(pathToSource);
		if (map)
			return map.generatedPath();
		return null;
	}

	public MapFromSource(pathToSource: string, line: number, column: number): MappingResult {
		const map = this._findSourceToGeneratedMapping(pathToSource);
		if (map) {
			line += 1;	// source map impl is 1 based
			const mr = map.generatedPositionFor(pathToSource, line, column);
			if (mr && typeof mr.line === 'number') {
				if (SourceMaps.TRACE) console.error(`${Path.basename(pathToSource)} ${line}:${column} -> ${mr.line}:${mr.column}`);
				return { path: map.generatedPath(), line: mr.line-1, column: mr.column};
			}
		}
		return null;
	}

	public MapToSource(pathToGenerated: string, line: number, column: number): MappingResult {
		const map = this._findGeneratedToSourceMapping(pathToGenerated);
		if (map) {
			line += 1;	// source map impl is 1 based
			const mr = map.originalPositionFor(line, column);
			if (mr && mr.source) {
				if (SourceMaps.TRACE) console.error(`${Path.basename(pathToGenerated)} ${line}:${column} -> ${mr.line}:${mr.column}`);
				return { path: mr.source, content: (<any>mr).content, line: mr.line-1, column: mr.column};
			}
		}
		return null;
	}

	//---- private -----------------------------------------------------------------------

	private _findSourceToGeneratedMapping(pathToSource: string): SourceMap {

		if (pathToSource) {

			if (pathToSource in this._sourceToGeneratedMaps) {
				return this._sourceToGeneratedMaps[pathToSource];
			}

			for (let key in this._generatedToSourceMaps) {
				const m = this._generatedToSourceMaps[key];
				if (m.doesOriginateFrom(pathToSource)) {
					this._sourceToGeneratedMaps[pathToSource] = m;
					return m;
				}
			}
			// not found in existing maps

			// use heuristic: change extension to ".js" and find a map for it
			let pathToGenerated = pathToSource;
			const pos = pathToSource.lastIndexOf('.');
			if (pos >= 0) {
				pathToGenerated = pathToSource.substr(0, pos) + '.js';
			}

			let map = null;

			// first look into the generated code directory
			if (this._generatedCodeDirectory) {
				let rest = PathUtils.makeRelative(this._generatedCodeDirectory, pathToGenerated);
				while (rest) {
					const path = Path.join(this._generatedCodeDirectory, rest);
					map = this._findGeneratedToSourceMapping(path);
					if (map) {
						break;
					}
					rest = PathUtils.removeFirstSegment(rest)
				}
			}

			// VSCode extension host support:
			// we know that the plugin has an "out" directory next to the "src" directory
			if (map === null) {
				let srcSegment = Path.sep + 'src' + Path.sep;
				if (pathToGenerated.indexOf(srcSegment) >= 0) {
					let outSegment = Path.sep + 'out' + Path.sep;
					pathToGenerated = pathToGenerated.replace(srcSegment, outSegment);
					map = this._findGeneratedToSourceMapping(pathToGenerated);
				}
			}

			// if not found look in the same directory as the source
			if (map === null && pathToGenerated !== pathToSource) {
				map = this._findGeneratedToSourceMapping(pathToGenerated);
			}

			if (map) {
				this._sourceToGeneratedMaps[pathToSource] = map;
				return map;
			}
		}
		return null;
	}

	private _findGeneratedToSourceMapping(pathToGenerated: string): SourceMap {

		if (pathToGenerated) {

			if (pathToGenerated in this._generatedToSourceMaps) {
				return this._generatedToSourceMaps[pathToGenerated];
			}

			let map: SourceMap = null;

			// try to find a source map URL in the generated source
			let map_path: string = null;
			const uri = this._findSourceMapInGeneratedSource(pathToGenerated);
			if (uri) {
				if (uri.indexOf("data:application/json;base64,") >= 0) {
					const pos = uri.indexOf(',');
					if (pos > 0) {
						const data = uri.substr(pos+1);
						try {
							const buffer = new Buffer(data, 'base64');
							const json = buffer.toString();
							if (json) {
								map = new SourceMap(pathToGenerated, pathToGenerated, json);
								this._generatedToSourceMaps[pathToGenerated] = map;
								return map;
							}
						}
						catch (e) {
							console.error(`FindGeneratedToSourceMapping: exception while processing data url (${e})`);
						}
					}
				} else {
					map_path = uri;
				}
			}

			// if path is relative make it absolute
            if (map_path && !Path.isAbsolute(map_path)) {
 				map_path = PathUtils.makePathAbsolute(pathToGenerated, map_path);
            }

			if (map_path === null || !FS.existsSync(map_path)) {
				// try to find map file next to the generated source
				map_path = pathToGenerated + ".map";
			}

			if (FS.existsSync(map_path)) {
				map = this._createSourceMap(map_path, pathToGenerated);
				if (map) {
					this._generatedToSourceMaps[pathToGenerated] = map;
					return map;
				}
			}
		}
		return null;
	}

	private _createSourceMap(map_path: string, path: string): SourceMap {
		try {
			const mp = Path.join(map_path);
			const contents = FS.readFileSync(mp).toString();
			return new SourceMap(mp, path, contents);
		}
		catch (e) {
			console.error(`CreateSourceMap: {e}`);
		}
		return null;
	}

	//  find "//# sourceMappingURL=<url>"
	private _findSourceMapInGeneratedSource(pathToGenerated: string): string {

		try {
			const contents = FS.readFileSync(pathToGenerated).toString();
			const lines = contents.split('\n');
			for (let line of lines) {
				const matches = SourceMaps.SOURCE_MAPPING_MATCHER.exec(line);
				if (matches && matches.length === 2) {
					const uri = matches[1].trim();
					return uri;
				}
			}
		} catch (e) {
			// ignore exception
		}
		return null;
	}
}

enum Bias {
	GREATEST_LOWER_BOUND = 1,
	LEAST_UPPER_BOUND = 2
}

class SourceMap {

	private _sourcemapLocation: string;	// the directory where this sourcemap lives
	private _generatedFile: string;		// the generated file for this sourcemap
	private _sources: string[];			// the sources of generated file (relative to sourceRoot)
	private _sourceRoot: string;		// the common prefix for the source (can be a URL)
	private _smc: SourceMapConsumer;	// the source map


	public constructor(mapPath: string, generatedPath: string, json: string) {

		this._sourcemapLocation = this.toUrl(Path.dirname(mapPath));
		this._generatedFile = generatedPath;

		const sm = JSON.parse(json);

		// try to fix all embedded paths because:
		// - source map sources are URLs, so even on Windows they should be using forward slashes.
		// - the source-map library expects forward slashes and their relative path logic
		//   (specifically the "normalize" function) gives incorrect results when passing in backslashes.
		// - paths starting with drive letters are not recognized as absolute by the source-map library

		sm.sourceRoot = this.toUrl(sm.sourceRoot, '');

		for (let i = 0; i < sm.sources.length; i++) {
			sm.sources[i] = this.toUrl(sm.sources[i]);
		}

		this._sourceRoot = sm.sourceRoot;

		// use source-map utilities to normalize sources entries
	    this._sources = sm.sources
			.map(util.normalize)
			.map((source) => {
				return this._sourceRoot && util.isAbsolute(this._sourceRoot) && util.isAbsolute(source)
					? util.relative(this._sourceRoot, source)
					: source;
			});
		try {
			this._smc = new SourceMapConsumer(sm);
		} catch (e) {
			// ignore exception and leave _smc undefined
		}
	}

	private toUrl(path: string, dflt?: string) : string {
		if (path) {
			path = path.replace(/\\/g, '/');
			if (/^[a-zA-Z]:\//.test(path)) {
				path = 'file:///' + path;
			}
			return path;
		}
		return dflt;
	}

	/*
	 * the generated file of this source map.
	 */
	public generatedPath(): string {
		return this._generatedFile;
	}

	/*
	 * returns true if this source map originates from the given source.
	 */
	public doesOriginateFrom(absPath: string): boolean {
		return this.findSource(absPath) !== null;
	}

	/**
	 * returns the first entry from the sources array that matches the given absPath
	 * or null otherwise.
	 */
	private findSource(absPath: string): string {
		for (let name of this._sources) {
			if (this.pathMatches(absPath, name)) {
				return name;
			}
		}
		return null;
	}

	/**
	 * returns true if the given absolute path matches name.
	 */
	private pathMatches(absPath: string, name: string) : boolean {
		// on Windows change back slashes to forward slashes because the source-map library requires this
		if (process.platform === 'win32') {
			absPath = absPath.replace(/\\/g, '/');
		}
		let url = this.absolutePath(name);
		return absPath === url;
	}

	/**
	 * Tries to make the given path absolute by prefixing it with the source root and/or the source maps location.
	 * Any url schemes are removed.
	 */
	private absolutePath(name: string): string {
		let path: string = util.join(this._sourceRoot, name);
		if (!util.isAbsolute(path)) {
			path = util.join(this._sourcemapLocation, path);
		}
		const prefix = 'file://';
		if (path.indexOf(prefix) === 0) {
			path = path.substr(prefix.length);
			if (/^\/[a-zA-Z]\:\//.test(path)) {
				path = path.substr(1);
			}
		}
	    return path;
	}

	/*
	 * Finds the nearest source location for the given location in the generated file.
	 * Returns null if sourcemap is invalid.
	 */
	public originalPositionFor(line: number, column: number, bias: Bias = Bias.LEAST_UPPER_BOUND): SourceMap.MappedPosition {

		if (!this._smc) {
			return null;
		}

		var needle = {
			line: line,
			column: column,
			bias: bias
		};

		const mp = this._smc.originalPositionFor(needle);
		if (mp.source) {

			// if source map has inlined source, return it
			const src = this._smc.sourceContentFor(mp.source);
			if (src) {
				(<any>mp).content = src;
			}

			// map result back to absolute path
			mp.source = this.absolutePath(mp.source);

			// on Windows change forward slashes back to back slashes
 			if (process.platform === 'win32') {
				mp.source = mp.source.replace(/\//g, '\\');
			}
		}

		return mp;
	}

	/*
	 * Finds the nearest location in the generated file for the given source location.
	 * Returns null if sourcemap is invalid.
	 */
	public generatedPositionFor(absPath: string, line: number, column: number, bias = Bias.LEAST_UPPER_BOUND): SourceMap.Position {

		if (!this._smc) {
			return null;
		}

		// make sure that we use an entry from the "sources" array that matches the passed absolute path
		const source = this.findSource(absPath);

		const needle = {
			source: source,
			line: line,
			column: column,
			bias: bias
		};

		return this._smc.generatedPositionFor(needle);
	}
}
