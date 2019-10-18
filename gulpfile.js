/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

var gulp = require('gulp');
var path = require('path');
var ts = require('gulp-typescript');
var sourcemaps = require('gulp-sourcemaps');
var tslint = require("gulp-tslint");
var filter = require('gulp-filter');
var uglify = require('gulp-uglify');
var del = require('del');
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
var webPackedDest = 'dist';

const transifexProjectName = 'vscode-extensions';
const transifexExtensionName = 'vscode-node-debug';

gulp.task('clean', () => {
	return del(['out/**', 'dist/**', 'package.nls.*.json', 'node-debug-*.vsix']);
});

gulp.task('internal-compile', () => {
	return compile();
});

gulp.task('internal-copy-scripts', () => {
	return gulp.src(scripts)
		.pipe(gulp.dest(outDest + '/node'));
});

gulp.task('internal-minify-scripts', () => {
	return gulp.src(scripts2)
		.pipe(uglify())
		.pipe(gulp.dest(outDest + '/node'));
});

// compile and copy everything to outDest
gulp.task('internal-build', gulp.series('internal-compile', 'internal-copy-scripts', 'internal-minify-scripts', done => {
	done();
}));

gulp.task('build', gulp.series('clean', 'internal-build', done => {
	done();
}));

gulp.task('default', gulp.series('build', done => {
	done();
}));

gulp.task('compile', gulp.series('clean', 'internal-build', done => {
	done();
}));

gulp.task('nls-bundle-create', () => {
	var r = tsProject.src()
		.pipe(sourcemaps.init())
		.pipe(tsProject()).js
		.pipe(nls.createMetaDataFiles())
		.pipe(nls.bundleMetaDataFiles('ms-vscode.node-debug', webPackedDest))
		.pipe(nls.bundleLanguageFiles())
		.pipe(filter('**/nls.*.json'));

	return r.pipe(gulp.dest(webPackedDest));
});

gulp.task('prepare-for-webpack', gulp.series('clean', 'internal-minify-scripts', 'nls-bundle-create', done => {
	done();
}));


gulp.task('watch', gulp.series('internal-build', done => {
	//log('Watching build sources...');
	gulp.watch(watchedSources, gulp.series('internal-build'));
	done();
}));

gulp.task('translations-export', gulp.series('build', 'prepare-for-webpack', () => {
	return gulp.src(['package.nls.json', path.join(webPackedDest, 'nls.metadata.header.json'), path.join(webPackedDest, 'nls.metadata.json')])
		.pipe(nls.createXlfFiles(transifexProjectName, transifexExtensionName))
		.pipe(gulp.dest(path.join('..', 'vscode-translations-export')));
}));

//---- internal

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

var allTypeScript = [
	'src/**/*.ts'
];

var tslintFilter = [
	'**',
	'!**/*.d.ts'
];

gulp.task('tslint', done => {
	gulp.src(allTypeScript)
	.pipe(filter(tslintFilter))
	.pipe(tslint({
		formatter: "prose",
		rulesDirectory: "node_modules/tslint-microsoft-contrib"
	}))
	.pipe(tslint.report( {
		emitError: false
	}));
	done();
});
