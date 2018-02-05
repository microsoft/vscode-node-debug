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
var vsce = require('vsce');

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

const transifexApiHostname = 'www.transifex.com'
const transifexApiName = 'api';
const transifexApiToken = process.env.TRANSIFEX_API_TOKEN;
const transifexProjectName = 'vscode-extensions';
const transifexExtensionName = 'vscode-node-debug';

const defaultLanguages = [
	{ id: 'zh-tw', folderName: 'cht', transifexId: 'zh-hant' },
	{ id: 'zh-cn', folderName: 'chs', transifexId: 'zh-hans' },
	{ id: 'ja', folderName: 'jpn' },
	{ id: 'ko', folderName: 'kor' },
	{ id: 'de', folderName: 'deu' },
	{ id: 'fr', folderName: 'fra' },
	{ id: 'es', folderName: 'esn' },
	{ id: 'ru', folderName: 'rus' },
	{ id: 'it', folderName: 'ita' }
];

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

gulp.task('watch', ['internal-build'], function(cb) {
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
		.pipe(buildNls ? nls.createAdditionalLanguageFiles(defaultLanguages, 'i18n', 'out') : es.through())
		.pipe(buildNls ? nls.bundleMetaDataFiles('ms-vscode.node-debug', 'out') : es.through())
		.pipe(buildNls ? nls.bundleLanguageFiles() : es.through());

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
		.pipe(nls.createAdditionalLanguageFiles(defaultLanguages, 'i18n'))
		.pipe(gulp.dest('.'));
});

gulp.task('transifex-push', ['build'], function() {
	return gulp.src(['package.nls.json', 'out/nls.metadata.header.json','out/nls.metadata.json'])
		.pipe(nls.createXlfFiles(transifexProjectName, transifexExtensionName))
		.pipe(nls.pushXlfFiles(transifexApiHostname, transifexApiName, transifexApiToken));
});

gulp.task('transifex-push-test', ['build'], function() {
	return gulp.src(['package.nls.json', 'out/nls.metadata.header.json','out/nls.metadata.json'])
		.pipe(nls.createXlfFiles(transifexProjectName, transifexExtensionName))
		.pipe(gulp.dest(path.join('..', `${transifexExtensionName}-push-test`)));
});


gulp.task('transifex-pull', function() {
	return es.merge(defaultLanguages.map(function(language) {
		return nls.pullXlfFiles(transifexApiHostname, transifexApiName, transifexApiToken, language, [{ name: transifexExtensionName, project: transifexProjectName }]).
			pipe(gulp.dest(`../${transifexExtensionName}-localization/${language.folderName}`));
	}));
});

gulp.task('i18n-import', function() {
	return es.merge(defaultLanguages.map(function(language) {
		return gulp.src(`../${transifexExtensionName}-localization/${language.folderName}/**/*.xlf`)
			.pipe(nls.prepareJsonFiles())
			.pipe(gulp.dest(path.join('./i18n', language.folderName)));
	}));
});

gulp.task('vsce-publish', function() {
	return vsce.publish();
});

gulp.task('vsce-package', function() {
	return vsce.createVSIX();
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
