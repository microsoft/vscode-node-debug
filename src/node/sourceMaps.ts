/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as Path from 'path';
import * as FS from 'fs';
import * as CRYPTO from 'crypto';
import * as OS from 'os';
import * as XHR from 'request-light';

import * as SM from 'source-map';
import * as PathUtils from './pathUtilities';
import { NodeDebugSession } from './nodeDebug';
import { URI } from './URI';
const util = require('../../node_modules/source-map/lib/util.js');


export interface MappingResult {
	path: string;		// absolute path
	content?: string;	// optional content of source (source inlined in source map)
	line: number;
	column: number;
}

export enum Bias {
	GREATEST_LOWER_BOUND = 1,
	LEAST_UPPER_BOUND = 2
}

export interface ISourceMaps {
	/*
	 * Map source language path to generated path.
	 * Returns null if not found.
	 */
	MapPathFromSource(path: string): Promise<string | null>;

	/*
	 * Map location in source language to location in generated code.
	 * line and column are 0 based.
	 */
	MapFromSource(path: string, line: number, column: number, bias?: Bias): Promise<MappingResult | null>;

	/*
	 * Map location in generated code to location in source language.
	 * line and column are 0 based.
	 */
	MapToSource(pathToGenerated: string, content: string | null, line: number, column: number): Promise<MappingResult | null>;

	/*
	 * Returns true if generated code has a source map but the given line and column cannot be mapped.
	 * line and column are 0 based.
	 */
	CannotMapLine(pathToGenerated: string, content: string | null, line: number, column: number): Promise<boolean>;

	/*
	 * Returns all source paths for the generated path.
	 */
	AllSources(pathToGenerated: string): Promise<string[] | undefined>;
}

export class SourceMaps implements ISourceMaps {

	private static SOURCE_MAPPING_MATCHER = new RegExp('^//[#@] ?sourceMappingURL=(.+)$');

	private _session: NodeDebugSession;
	private _sourceMapCache = new Map<string, Promise<SourceMap>>();	// all cached source maps
	private _generatedToSourceMaps = new Map<string, SourceMap>();	// generated file -> SourceMap
	private _sourceToGeneratedMaps = new Map<string, SourceMap>();	// source file -> SourceMap
	private _preLoad: Promise<void>;


	public constructor(session: NodeDebugSession, generatedCodeDirectory?: string, generatedCodeGlobs?: string[]) {
		this._session = session;

		generatedCodeGlobs = generatedCodeGlobs || [];
		if (generatedCodeDirectory) {
			generatedCodeGlobs.push(generatedCodeDirectory + '/**/*.js');	// backward compatibility: turn old outDir into a glob pattern
		}

		// try to find all source files upfront asynchroneously
		if (generatedCodeGlobs.length > 0) {
			this._preLoad = PathUtils.multiGlob(generatedCodeGlobs).then(paths => {
				return Promise.all(paths.map(path => {
					return this._findSourceMapUrlInFile(path).then(uri => {
						return this._getSourceMap(uri, path);
					}).catch(err => {
						return null;
					});
				})).then(results => {
					return void 0;
				}).catch( err => {
					// silently ignore errors
					return void 0;
				});
			});
		} else {
			this._preLoad = Promise.resolve(void 0);
		}
	}

	public MapPathFromSource(pathToSource: string): Promise<string | null> {
		return this._preLoad.then(() => {
			return this._findSourceToGeneratedMapping(pathToSource).then(map => {
				return map ? map.generatedPath() : null;
			});
		});
	}

	public MapFromSource(pathToSource: string, line: number, column: number, bias?: Bias): Promise<MappingResult | null> {
		return this._preLoad.then(() => {
			return this._findSourceToGeneratedMapping(pathToSource).then(map => {
				if (map) {
					line += 1;	// source map impl is 1 based
					const mr = map.generatedPositionFor(pathToSource, line, column, bias);
					if (mr && mr.line !== null && mr.column !== null) {
						return {
							path: map.generatedPath(),
							line: mr.line-1,
							column: mr.column
						};
					}
				}
				return null;
			});
		});
	}

	public CannotMapLine(pathToGenerated: string, content: string, line: number, column: number): Promise<boolean> {
		return this._preLoad.then(() => {
			return this._findGeneratedToSourceMapping(pathToGenerated, content).then(map => {
				if (map) {
					line += 1;	// source map impl is 1 based
					let mr = map.originalPositionFor(line, column,  Bias.GREATEST_LOWER_BOUND);
					if (!mr) {
						mr = map.originalPositionFor(line, column, Bias.LEAST_UPPER_BOUND);
					}
					if (mr && mr.source && mr.line !== null && mr.column !== null) {
						return false;	// we have a corresponding source and could map line to it -> stop
					}
					return true;	// we have a corresponding source but could not map line to it -> skip
				}
				return false; // no corresponding source -> stop
			});
		});
	}

	public MapToSource(pathToGenerated: string, content: string, line: number, column: number): Promise<MappingResult | null> {
		return this._preLoad.then(() => {
			return this._findGeneratedToSourceMapping(pathToGenerated, content).then(map => {
				if (map) {
					line += 1;	// source map impl is 1 based
					let mr = map.originalPositionFor(line, column,  Bias.GREATEST_LOWER_BOUND);
					if (!mr) {
						mr = map.originalPositionFor(line, column, Bias.LEAST_UPPER_BOUND);
					}
					if (mr && mr.source && mr.line !== null && mr.column !== null) {
						return {
							path: mr.source,
							content: (<any>mr).content,
							line: mr.line-1,
							column: mr.column
						};
					}
					return null;	// we have a corresponding source but could not map line to it.
				}
				// no corresponding source.
				return null;
			});
		});
	}

	AllSources(pathToGenerated: string): Promise<string[] | undefined> {

		return this._findGeneratedToSourceMapping(pathToGenerated).then(map => {
			if (map) {
				return map.allSourcePaths();
			} else {
				return undefined;
			}
		}).catch(err => {
			return undefined;
		});
	}

	//---- private -----------------------------------------------------------------------

	/**
	 * Tries to find a SourceMap for the given source.
	 * This is a bit tricky because the source does not contain any information about where
	 * the generated code or the source map is located.
	 * The code relies on the source cache populated by the exhaustive search over the 'outFiles' glob patterns
	 * and some heuristics.
	 */
	private _findSourceToGeneratedMapping(pathToSource: string): Promise<SourceMap | null> {

		if (!pathToSource) {
			return Promise.resolve(null);
		}

		// try to find in cache by source path
		const pathToSourceKey = PathUtils.pathNormalize(pathToSource);
		const map = this._sourceToGeneratedMaps.get(pathToSourceKey);
		if (map) {
			return Promise.resolve(map);
		}

		let pathToGenerated = pathToSource;

		return Promise.resolve(null).then(map => {

			// heuristic: try to find the generated code side by side to the source
			const ext = Path.extname(pathToSource);
			if (ext !== '.js') {
				// use heuristic: change extension to ".js" and find a map for it
				const pos = pathToSource.lastIndexOf('.');
				if (pos >= 0) {
					pathToGenerated = pathToSource.substr(0, pos) + '.js';
					return this._findGeneratedToSourceMapping(pathToGenerated);
				}
			}
			return map;

		}).then(map => {

			if (!map) {
				// heuristic for VSCode extension host support:
				// we know that the plugin has an "out" directory next to the "src" directory
				// TODO: get rid of this and use glob patterns instead
				let srcSegment = Path.sep + 'src' + Path.sep;
				if (pathToGenerated.indexOf(srcSegment) >= 0) {
					const outSegment = Path.sep + 'out' + Path.sep;
					return this._findGeneratedToSourceMapping(pathToGenerated.replace(srcSegment, outSegment));
				}
			}
			return map;

		}).then(map => {

			if (map) {
				// remember found map for source key
				this._sourceToGeneratedMaps.set(pathToSourceKey, map);
			}
			return map;
		});
	}

	/**
	 * Tries to find a SourceMap for the given path to a generated file.
	 * This is simple if the generated file has the 'sourceMappingURL' at the end.
	 * If not, we are using some heuristics...
	 */
	private _findGeneratedToSourceMapping(pathToGenerated: string, content?: string): Promise<SourceMap | null> {

		if (!pathToGenerated) {
			return Promise.resolve(null);
		}

		const pathToGeneratedKey = PathUtils.pathNormalize(pathToGenerated);
		const map = this._generatedToSourceMaps.get(pathToGeneratedKey);
		if (map) {
			return Promise.resolve(map);
		}

		// try to find a source map URL in the generated file
		return this._findSourceMapUrlInFile(pathToGenerated, content).then(uri => {

			if (uri) {
				return this._getSourceMap(uri, pathToGenerated);
			}

			// heuristic: try to find map file side-by-side to the generated source
			let map_path = pathToGenerated + '.map';
			if (FS.existsSync(map_path)) {
				return this._getSourceMap(URI.file(map_path), pathToGenerated);
			}

			return Promise.resolve(null);
		});
	}

	/**
	 * Try to find the 'sourceMappingURL' in content or the file with the given path.
	 * Returns null if no source map url is found or if an error occured.
	 */
	private _findSourceMapUrlInFile(pathToGenerated: string, content?: string): Promise<URI | null> {

		if (content) {
			return Promise.resolve(this._findSourceMapUrl(content, pathToGenerated));
		}

		return this._readFile(pathToGenerated).then(content => {
			return this._findSourceMapUrl(content, pathToGenerated);
		}).catch(err => {
			return null;
		});
	}

	/**
	 * Try to find the 'sourceMappingURL' at the end of the given contents.
	 * Relative file paths are converted into absolute paths.
	 * Returns null if no source map url is found.
	 */
	private _findSourceMapUrl(contents: string, pathToGenerated: string): URI | null {

		const lines = contents.split('\n');
		for (let l = lines.length-1; l >= Math.max(lines.length-10, 0); l--) {	// only search for url in the last 10 lines
			const line = lines[l].trim();
			const matches = SourceMaps.SOURCE_MAPPING_MATCHER.exec(line);
			if (matches && matches.length === 2) {
				let uri = matches[1].trim();
				if (pathToGenerated) {
					this._log(`_findSourceMapUrl: source map url found at end of generated file '${pathToGenerated}'`);
					return URI.parse(uri, Path.dirname(pathToGenerated));
				} else {
					this._log(`_findSourceMapUrl: source map url found at end of generated content`);
					return URI.parse(uri);
				}
			}
		}
		return null;
	}

	/**
	 * Returns a (cached) SourceMap specified via the given uri.
	 */
	private _getSourceMap(uri: URI | null, pathToGenerated: string) : Promise<SourceMap | null> {

		if (!uri) {
			return Promise.resolve(null);
		}

		// use sha256 to ensure the hash value can be used in filenames
		const hash = CRYPTO.createHash('sha256').update(uri.uri()).digest('hex');
		let promise = this._sourceMapCache.get(hash);
		if (!promise) {
			try {
				promise = this._loadSourceMap(uri, pathToGenerated, hash);
				this._sourceMapCache.set(hash, promise);
			} catch (err) {
				this._log(`_loadSourceMap: loading source map '${uri.uri()}' failed with exception: ${err}`);
				return Promise.resolve(null);
			}
		}

		return promise;
	}

	private registerSourceMap(map_path: string, pathToGenerated: string, content: string) : Promise<SourceMap> {
		return SourceMap.newSourceMap(map_path, pathToGenerated, content).then(sm => {
			this._registerSourceMap(sm);
			return sm;
		});
	}

	/**
	 * Loads a SourceMap specified by the given uri.
	 */
	private _loadSourceMap(uri: URI, pathToGenerated: string, hash: string) : Promise<SourceMap> {

		if (uri.isFile()) {

			const map_path = uri.filePath();
			return this._readFile(map_path).then(content => {
				return this.registerSourceMap(map_path, pathToGenerated, content);
			});
		}

		if (uri.isData()) {

			const data = uri.data();
			if (data) {
				try {
					const buffer = new Buffer(data, 'base64');
					const json = buffer.toString();
					if (json) {
						return this.registerSourceMap(pathToGenerated, pathToGenerated, json);
					}
				}
				catch (e) {
					throw new Error(`exception while processing data url`);
				}
			}
			throw new Error(`exception while processing data url`);
		}

		if (uri.isHTTP()) {

			const cache_path = Path.join(OS.tmpdir(), 'com.microsoft.VSCode', 'node-debug', 'sm-cache');
			const path = Path.join(cache_path, hash);

			return Promise.resolve(FS.existsSync(path)).then(exists => {

				if (exists) {
					return this._readFile(path).then(content => {
						return this.registerSourceMap(pathToGenerated, pathToGenerated, content);
					});
				}

				const options: XHR.XHROptions = {
					url: uri.uri(),
					followRedirects: 5
				};

				return XHR.xhr(options).then(response => {
					return this._writeFile(path, response.responseText).then(content => {
						return this.registerSourceMap(pathToGenerated, pathToGenerated, content);
					});
				}).catch((error: XHR.XHRResponse) => {
					return Promise.reject(XHR.getErrorStatusDescription(error.status) || error.toString());
				});
			});
		}

		throw new Error(`url is not a valid source map`);
	}

	/**
	 * Register the given source map in all maps.
	 */
	private _registerSourceMap(map: SourceMap): SourceMap {
		if (map) {
			const genPath = PathUtils.pathNormalize(map.generatedPath());
			this._generatedToSourceMaps.set(genPath, map);
			const sourcePaths = map.allSourcePaths();
			for (let path of sourcePaths) {
				const key = PathUtils.pathNormalize(path);
				this._sourceToGeneratedMaps.set(key, map);
				this._log(`_registerSourceMap: ${key} -> ${genPath}`);
			}
		}
		return map;
	}

	private _readFile(path: string, encoding: string = 'utf8'): Promise<string> {
		return new Promise((resolve, reject) => {
			FS.readFile(path, encoding, (err, fileContents) => {
				if (err) {
					reject(err);
				} else {
					resolve(PathUtils.stripBOM(fileContents));
				}
			});
		});
	}

	private _writeFile(path: string, data: string): Promise<string> {
		return new Promise((resolve, reject) => {
			PathUtils.mkdirs(Path.dirname(path));
			FS.writeFile(path, data, err => {
				if (err) {
					// ignore error
					// reject(err);
				}
				resolve(data);
			});
		});
	}

	private _log(message: string): void {
		this._session.log('sm', message);
	}
}

export class SourceMap {

	private _sourcemapLocation: string | undefined;	// the directory where this sourcemap lives
	private _generatedFile: string;		// the generated file to which this source map belongs to
	private _sources: string[];			// the sources of the generated file (relative to sourceRoot)
	private _sourceRoot: string;		// the common prefix for the source (can be a URL)
	private _smc: SM.SourceMapConsumer;	// the internal source map


	public static newSourceMap(mapPath: string, generatedPath: string, json: string): Promise<SourceMap> {
		const sm = new SourceMap();
		return sm.init(mapPath, generatedPath, json);
	}

	private constructor() {
	}

	private init(mapPath: string, generatedPath: string, json: string): Promise<SourceMap> {

		this._sourcemapLocation = this.fixPath(Path.dirname(mapPath));

		const sm = JSON.parse(json);

		if (!generatedPath) {
			let file = sm.file;
			if (!PathUtils.isAbsolutePath(file)) {
				generatedPath = PathUtils.makePathAbsolute(mapPath, file);
			}
		}

		generatedPath = PathUtils.pathToNative(generatedPath);

		this._generatedFile = generatedPath;

		// fix all paths for use with the source-map npm module.
		sm.sourceRoot = this.fixPath(sm.sourceRoot, '');

		for (let i = 0; i < sm.sources.length; i++) {
			sm.sources[i] = this.fixPath(sm.sources[i]);
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


		// source-map@0.6.1
		try {
			this._smc = new SM.SourceMapConsumer(sm);
		} catch (e) {
			// ignore exception and leave _smc undefined
		}
		return Promise.resolve(this);

		/*
		// source-map@0.7.3
		return new SM.SourceMapConsumer(sm).then(x => {
			this._smc = x;
			return this;
		}).catch(err => {
			// ignore exception and leave _smc undefined
			return this;
		});
		*/
	}

	/*
	 * The generated file this source map belongs to.
	 */
	public generatedPath(): string {
		return this._generatedFile;
	}

	public allSourcePaths(): string[] {
		const paths = new Array<string>();
		for (let name of this._sources) {
			if (!util.isAbsolute(name)) {
				name = util.join(this._sourceRoot, name);
			}
			let path = this.absolutePath(name);
			paths.push(path);
		}
		return paths;
	}

	/*
	 * Finds the nearest source location for the given location in the generated file.
	 * Returns null if sourcemap is invalid.
	 */
	public originalPositionFor(line: number, column: number, bias: Bias): SM./*Nullable*/MappedPosition | null {

		if (!this._smc) {
			return null;
		}

		const needle = {
			line: line,
			column: column,
			bias: bias || Bias.LEAST_UPPER_BOUND
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
			mp.source =  PathUtils.pathToNative(mp.source);
		}

		return mp;
	}

	/*
	 * Finds the nearest location in the generated file for the given source location.
	 * Returns null if sourcemap is invalid.
	 */
	public generatedPositionFor(absPath: string, line: number, column: number, bias?: Bias): SM./*Nullable*/Position | null {

		if (!this._smc) {
			return null;
		}

		// make sure that we use an entry from the "sources" array that matches the passed absolute path
		const source = this.findSource(absPath);
		if (source) {
			const needle = {
				source: source,
				line: line,
				column: column,
				bias: bias || Bias.LEAST_UPPER_BOUND
			};

			return this._smc.generatedPositionFor(needle);
		}

		return null;
	}

	/**
	 * fix a path for use with the source-map npm module because:
	 * - source map sources are URLs, so even on Windows they should be using forward slashes.
	 * - the source-map library expects forward slashes and their relative path logic
	 *   (specifically the "normalize" function) gives incorrect results when passing in backslashes.
	 * - paths starting with drive letters are not recognized as absolute by the source-map library.
	 */
	private fixPath(path: string, dflt?: string) : string | undefined {
		if (path) {
			path = path.replace(/\\/g, '/');

			// if path starts with a drive letter convert path to a file url so that the source-map library can handle it
			if (/^[a-zA-Z]\:\//.test(path)) {
				// Windows drive letter must be prefixed with a slash
				path = encodeURI('file:///' + path);
			}
			return path;
		}
		return dflt;
	}

	/**
	 * undo the fix
	 */
	private unfixPath(path: string) : string {
		const prefix = 'file://';
		if (path.indexOf(prefix) === 0) {
			path = path.substr(prefix.length);
			path = decodeURI(path);
			if (/^\/[a-zA-Z]\:\//.test(path)) {
				path = path.substr(1);	// remove additional '/'
			}
		}
		return path;
	}

	/**
	 * returns the first entry from the sources array that matches the given absPath
	 * or null otherwise.
	 */
	private findSource(absPath: string): string | null {
		absPath = PathUtils.pathNormalize(absPath);
		for (let name of this._sources) {
			if (!util.isAbsolute(name)) {
				name = util.join(this._sourceRoot, name);
			}
			let path = this.absolutePath(name);
			path = PathUtils.pathNormalize(path);
			if (absPath === path) {
				return name;
			}
		}
		return null;
	}

	/**
	 * Tries to make the given path absolute by prefixing it with the source map's location.
	 * Any url schemes are removed.
	 */
	private absolutePath(path: string): string {
		if (!util.isAbsolute(path)) {
			path = util.join(this._sourcemapLocation, path);
		}
		return this.unfixPath(path);
	}
}
