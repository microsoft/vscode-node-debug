/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

var gulp = require('gulp');
var path = require('path');
var ts = require('gulp-typescript');
var sourcemaps = require('gulp-sourcemaps');
var log = require('gulp-util').log;
var tslint = require("gulp-tslint");
var filter = require('gulp-filter');
var azure = require('gulp-azure-storage');
var git = require('git-rev-sync');
var del = require('del');
var runSequence = require('run-sequence');
var vzip = require('gulp-vinyl-zip');

var tsProject = ts.createProject('./src/tsconfig.json');

const inlineMap = true;
const inlineSource = false;

var watchedSources = [
	'src/**/*',
	'!src/tests/data/**',
	'typings/**/*.ts'
];

var scripts = [
	'src/node/debugExtension.js',
	'src/node/terminateProcess.sh',
	'src/node/TerminalHelper.scpt'
];

var outDest = 'out';

var BOM = [
	outDest + '/node/*',
	'node_modules/source-map/**/*',
	'node_modules/vscode-debugprotocol/**/*',
	'node_modules/vscode-debugadapter/**/*',
	'node_modules/vscode-nls/**/*',
	'package.json',
	'package.nls.json',
	'ThirdPartyNotices.txt',
	'LICENSE.txt'
];

var uploadDest = 'upload/' + git.short();

gulp.task('default', function(callback) {
	runSequence('build', callback);
});

gulp.task('build', function(callback) {
	runSequence('clean', 'internal-build', callback);
});

gulp.task('zip', function(callback) {
	runSequence('build', 'internal-zip', callback);
});

gulp.task('upload', function(callback) {
	runSequence('zip', 'internal-upload', callback);
});

gulp.task('clean', function() {
	return del(['out/**', 'upload/**']);
})

gulp.task('ts-watch', ['internal-build'], function(cb) {
	log('Watching build sources...');
	gulp.watch(watchedSources, ['internal-compile']);
});

//---- internal

// compile and copy everything to outDest
gulp.task('internal-build', function(callback) {
	runSequence('internal-compile', 'internal-copy-scripts', callback);
});

gulp.task('internal-copy-scripts', function() {
	return gulp.src(scripts)
		.pipe(gulp.dest(outDest + '/node'));
});

gulp.task('internal-compile', function() {
	var r = tsProject.src()
		.pipe(sourcemaps.init())
		.pipe(ts(tsProject)).js;

	if (inlineMap && inlineSource) {
		r = r.pipe(sourcemaps.write());
	} else {
		r = r.pipe(sourcemaps.write("../out", {
			// no inlined source
			includeContent: inlineSource,
			// Return relative source map root directories per file.
			sourceRoot: "../../src"
		}));
	}

	return r.pipe(gulp.dest(outDest));
});

gulp.task('internal-zip', function(callback) {
	return gulp.src(BOM, { base: '.' })
		.pipe(vzip.dest(uploadDest + '/node-debug.zip'));
});

gulp.task('internal-upload', function() {
	return gulp.src('upload/**/*')
		.pipe(azure.upload({
			account: process.env.AZURE_STORAGE_ACCOUNT,
			key: process.env.AZURE_STORAGE_ACCESS_KEY,
			container: 'debuggers'
		}));
});

var allTypeScript = [
	'src/**/*.ts'
];

var tslintFilter = [
	'**',
	'!**/*.d.ts',
	'!**/typings/**'
];

var lintReporter = function (output, file, options) {
	//emits: src/helloWorld.c:5:3: warning: implicit declaration of function ‘prinft’
	var relativeBase = file.base.substring(file.cwd.length + 1).replace('\\', '/');
	output.forEach(function(e) {
		var message = relativeBase + e.name + ':' + (e.startPosition.line + 1) + ':' + (e.startPosition.character + 1) + ': ' + e.failure;
		console.log('[tslint] ' + message);
	});
};

gulp.task('tslint', function () {
	gulp.src(allTypeScript)
	.pipe(filter(tslintFilter))
	.pipe(tslint({
		rulesDirectory: "node_modules/tslint-microsoft-contrib"
	}))
	.pipe(tslint.report(lintReporter, {
		summarizeFailureOutput: false,
		emitError: false
	}))
});
