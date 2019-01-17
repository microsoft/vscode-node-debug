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
var typescript = require('typescript');

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

const transifexApiHostname = 'www.transifex.com';
const transifexApiName = 'api';
const transifexApiToken = process.env.TRANSIFEX_API_TOKEN;
const transifexProjectName = 'vscode-extensions';
const transifexExtensionName = 'vscode-node-debug';


gulp.task('default', function(callback) {
	runSequence('build', callback);
});

gulp.task('compile', function(callback) {
	runSequence('clean', 'internal-build', callback);
});

gulp.task('build', function(callback) {
	runSequence('clean', 'internal-build', callback);
});

gulp.task('clean', function() {
	return del(['out/**', 'dist/**', 'package.nls.*.json', 'node-debug-*.vsix']);
});

gulp.task('prepare-for-webpack', function(callback) {
	runSequence('clean', 'internal-minify-scripts', 'nls-bundle-create', callback);
});

gulp.task('watch', ['internal-build'], function(cb) {
	log('Watching build sources...');
	gulp.watch(watchedSources, ['internal-build']);
});

//---- internal

// compile and copy everything to outDest
gulp.task('internal-build', function(callback) {
	runSequence('internal-compile', 'internal-copy-scripts', 'internal-minify-scripts', callback);
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

function compile() {
	var r = tsProject.src()
		.pipe(sourcemaps.init())
		.pipe(tsProject()).js;

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
	return compile();
});

gulp.task('nls-bundle-create', function () {
	var r = tsProject.src()
		.pipe(sourcemaps.init())
		.pipe(tsProject()).js
		.pipe(nls.createMetaDataFiles())
		.pipe(nls.bundleMetaDataFiles('ms-vscode.node-debug', 'out'))
		.pipe(nls.bundleLanguageFiles())
		.pipe(filter('**/nls.*.json'));

	return r.pipe(gulp.dest('dist'));
});

gulp.task('translations-export', ['build'], function() {
	return gulp.src(['package.nls.json', 'out/nls.metadata.header.json','out/nls.metadata.json'])
		.pipe(nls.createXlfFiles(transifexProjectName, transifexExtensionName))
		.pipe(gulp.dest(path.join('..', 'vscode-translations-export')));
});

var allTypeScript = [
	'src/**/*.ts'
];

var tslintFilter = [
	'**',
	'!**/*.d.ts'
];

gulp.task('tslint', function () {
	gulp.src(allTypeScript)
	.pipe(filter(tslintFilter))
	.pipe(tslint({
		formatter: "prose",
		rulesDirectory: "node_modules/tslint-microsoft-contrib"
	}))
	.pipe(tslint.report( {
		emitError: false
	}))
});
