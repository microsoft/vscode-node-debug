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
var uglify = require('gulp-uglify');
var git = require('git-rev-sync');
var del = require('del');
var runSequence = require('run-sequence');
var vzip = require('gulp-vinyl-zip');
var es = require('event-stream');

var tsProject = ts.createProject('./src/tsconfig.json');
var nls = require('vscode-nls-dev');

var inlineMap = true;
var inlineSource = false;

var watchedSources = [
	'src/**/*',
	'!src/tests/data/**',
	'typings/**/*.ts'
];

var scripts = [
	'src/node/terminateProcess.sh'
];

var scripts2 = [
	'src/node/debugInjection.js'
];

var outDest = 'out';

var BOM = [
	outDest + '/node/*',
	'node_modules/agent-base/**/*',
	'node_modules/balanced-match/**/*',
	'node_modules/brace-expansion/**/*',
	'node_modules/concat-map/**/*',
	'node_modules/debug/**/*',
	'node_modules/extend/**/*',
	'node_modules/fs.realpath/**/*',
	'node_modules/glob/**/*',
	'node_modules/http-proxy-agent/**/*',
	'node_modules/https-proxy-agent/**/*',
	'node_modules/inflight/**/*',
	'node_modules/inherits/**/*',
	'node_modules/minimatch/**/*',
	'node_modules/ms/**/*',
	'node_modules/once/**/*',
	'node_modules/path-is-absolute/**/*',
	'node_modules/request-light/**/*',
	'node_modules/source-map/**/*',
	'node_modules/vscode-debugadapter/**/*',
	'node_modules/vscode-debugprotocol/**/*',
	'node_modules/vscode-nls/**/*',
	'node_modules/wrappy/**/*',
	'package.json',
	'package.nls.json',
	'npm-shrinkwrap.json'
];

var uploadDest = 'upload';

gulp.task('default', function(callback) {
	runSequence('build', callback);
});

gulp.task('compile', function(callback) {
	runSequence('clean', 'internal-build', callback);
});

gulp.task('build', function(callback) {
	runSequence('clean', 'internal-nls-build', callback);
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
		.pipe(ts(tsProject)).js
		.pipe(buildNls ? nls.rewriteLocalizeCalls() : es.through())
		.pipe(buildNls ? nls.createAdditionalLanguageFiles(nls.coreLanguages, 'i18n', 'out') : es.through());

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
}

gulp.task('internal-compile', function() {
	return compile(false);
});

gulp.task('internal-nls-compile', function() {
	return compile(true);
});

gulp.task('internal-zip', function(callback) {
	var dest = uploadDest;
	try {
		dest += '/' + git.short();
	}
	catch(e) {
		// silently ignore
	}
	var f = filter(['package.nls.json'], { restore: true });
	return gulp.src(BOM, { base: '.' })
		.pipe(f)
		.pipe(nls.createAdditionalLanguageFiles(nls.coreLanguages, 'i18n'))
		.pipe(f.restore)
		.pipe(vzip.dest(dest + '/node-debug.zip'));
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
