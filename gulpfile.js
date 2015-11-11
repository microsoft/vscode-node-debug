/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

var gulp = require('gulp');
var path = require('path');
var tsb = require('gulp-tsb');
var log = require('gulp-util').log;
var azure = require('gulp-azure-storage');
var git = require('git-rev-sync');
var del = require('del');
var runSequence = require('run-sequence');
var vzip = require('gulp-vinyl-zip');

var compilation = tsb.create(path.join(__dirname, 'tsconfig.json'), true);

var sources = [
	'common/**/*.ts',
	'node/**/*.ts',
	'typings/**/*.ts',
	'test/**/*.ts'
];

var outDest = 'out';
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
    gulp.watch(sources, ['internal-compile']);
});

//---- internal

// compile and copy everything to outDest
gulp.task('internal-build', function(callback) {
	runSequence('internal-compile', 'internal-copy-scripts', callback);
});

gulp.task('internal-copy-scripts', function() {
	return gulp.src(['node/terminateProcess.sh', 'node/TerminalHelper.scpt'])
		.pipe(gulp.dest(outDest + '/node'));
});

gulp.task('internal-compile', function() {
	return gulp.src(sources, { base: '.' })
		.pipe(compilation())
		.pipe(gulp.dest(outDest));
});

gulp.task('internal-zip', function(callback) {
	return gulp.src([outDest + '/**/*', 'node_modules/source-map/**/*'], { base: '.' }).pipe(vzip.dest(uploadDest + '/node-debug.zip'));
});

gulp.task('internal-upload', function() {
	return gulp.src('upload/**/*')
		.pipe(azure.upload({
			account: process.env.AZURE_STORAGE_ACCOUNT,
			key: process.env.AZURE_STORAGE_ACCESS_KEY,
			container: 'debuggers'
		}));
});
