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
var uglify = require('gulp-uglify');
var del = require('del');
var runSequence = require('run-sequence');
var es = require('event-stream');
var typescript = require('typescript');
var cp = require('child_process');

var tsProject = ts.createProject('./src/tsconfig.json', { typescript });
var nls = require('vscode-nls-dev');

var inlineMap = true;
var inlineSource = false;

var watchedSources = [
	'src/**/*',
	'!src/tests/data/**'
];

var scripts = [
	'src/node/terminateProcess.sh'
];

var scripts2 = [
	'src/node/debugInjection.js'
];

var outDest = 'out';


gulp.task('default', function(callback) {
	runSequence('build', callback);
});

gulp.task('compile', function(callback) {
	runSequence('clean', 'internal-build', callback);
});

gulp.task('build', function(callback) {
	runSequence('clean', 'internal-nls-build', callback);
});

gulp.task('publish', function(callback) {
	runSequence('build', 'add-i18n', 'vsce-publish', callback);
});

gulp.task('package', function(callback) {
	runSequence('build', 'add-i18n', 'vsce-package', callback);
});

gulp.task('clean', function() {
	return del(['out/**', 'package.nls.*.json', 'node-debug-*.vsix']);
})

gulp.task('ts-watch', ['internal-build'], function(cb) {
	log('Watching build sources...');
	gulp.watch(watchedSources, ['internal-build']);
});

//---- internal

// compile and copy everything to outDest
gulp.task('internal-build', function(callback) {
	runSequence('internal-compile', 'internal-copy-scripts', 'internal-minify-scripts', callback);
});

gulp.task('internal-nls-build', function(callback) {
	runSequence('internal-nls-compile', 'internal-copy-scripts', 'internal-minify-scripts', callback);
});

gulp.task('internal-copy-scripts', function() {
	return gulp.src(scripts)
		.pipe(gulp.dest(outDest + '/node'));
});

gulp.task('internal-minify-scripts', function() {
	return gulp.src(scripts2)
		.pipe(uglify())
		.pipe(gulp.dest(outDest + '/node'));
});

function compile(buildNls) {
	var r = tsProject.src()
		.pipe(sourcemaps.init())
		.pipe(tsProject()).js
		.pipe(buildNls ? nls.rewriteLocalizeCalls() : es.through())
		.pipe(buildNls ? nls.createAdditionalLanguageFiles(nls.coreLanguages, 'i18n', 'out') : es.through());

	if (inlineMap && inlineSource) {
		r = r.pipe(sourcemaps.write());
	} else {
		r = r.pipe(sourcemaps.write("../out", {
			// no inlined source
			includeContent: inlineSource,
			// Return relative source map root directories per file.
			sourceRoot: "../src"
		}));
	}

	return r.pipe(gulp.dest(outDest));
}

gulp.task('internal-compile', function() {
	return compile(false);
});

gulp.task('internal-nls-compile', function() {
	return compile(true);
});

gulp.task('add-i18n', function() {
	return gulp.src(['package.nls.json'])
		.pipe(nls.createAdditionalLanguageFiles(nls.coreLanguages, 'i18n'))
		.pipe(gulp.dest('.'));
});

gulp.task('vsce-publish', function(cb) {
	var cmd = cp.spawn('./node_modules/.bin/vsce', [ 'publish' ], { stdio: 'inherit' });
	cmd.on('close', code => {
		log(`vsce exited with ${code}`);
		cb(code);
	});
});

gulp.task('vsce-package', function(cb) {
	var cmd = cp.spawn('./node_modules/.bin/vsce', [ 'package' ], { stdio: 'inherit' });
	cmd.on('close', code => {
		log(`vsce exited with ${code}`);
		cb(code);
	});
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
