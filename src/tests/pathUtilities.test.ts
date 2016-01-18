/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

'use strict';

import * as assert from 'assert';
import * as PathUtils from '../node/pathUtilities';


describe('pathUtilities', () => {

	describe('normalize(path)', () => {

		it('should return a path with forward slashes and \'..\' removed', () => {
			assert.equal(PathUtils.normalize('/a/b/c'), '/a/b/c');
			assert.equal(PathUtils.normalize('/a/b//c'), '/a/b/c');
			assert.equal(PathUtils.normalize('/a/./b/c'), '/a/b/c');
			assert.equal(PathUtils.normalize('/a/b/../c'), '/a/c');

			assert.equal(PathUtils.normalize('c:\\a\\b'), '/c:/a/b');
			assert.equal(PathUtils.normalize('C:\\a\\b'), '/C:/a/b');
			assert.equal(PathUtils.normalize('C:\\a\\..\\b'), '/C:/b');
			assert.equal(PathUtils.normalize('C:\\a\\.\\b'), '/C:/a/b');
			assert.equal(PathUtils.normalize('c:/a/b'), '/c:/a/b');
			assert.equal(PathUtils.normalize('C:/a/b'), '/C:/a/b');
		});

	});

	describe('join(absPath, relPath)', () => {

		it('should return a path with forward slashes', () => {
			assert.equal(PathUtils.join('/a/b', 'c'), '/a/b/c');
			assert.equal(PathUtils.join('/a/b/', 'c'), '/a/b/c');

			assert.equal(PathUtils.join('c:\\a\\b', 'c'), '/c:/a/b/c');
			assert.equal(PathUtils.join('c:\\a\\b\\', 'c'), '/c:/a/b/c');
			assert.equal(PathUtils.join('C:\\a\\b', 'c'), '/C:/a/b/c');
		});

	});

	describe('isAbsolutePath(path)', () => {

		it('should return true when the path is absolute', () => {
			assert.equal(PathUtils.isAbsolutePath('/x/y'), true);
			assert.equal(PathUtils.isAbsolutePath('c:/x/y'), true);
			assert.equal(PathUtils.isAbsolutePath('C:/x/y'), true);
			assert.equal(PathUtils.isAbsolutePath('c:\\x\\y'), true);
			assert.equal(PathUtils.isAbsolutePath('C:\\x\\y'), true);
		});

		it('should return false when the path is relative', () => {
			assert.equal(PathUtils.isAbsolutePath(null), false);
			assert.equal(PathUtils.isAbsolutePath(''), false);

			assert.equal(PathUtils.isAbsolutePath('x'), false);
			assert.equal(PathUtils.isAbsolutePath('./x'), false);
			assert.equal(PathUtils.isAbsolutePath('../y'), false);

			assert.equal(PathUtils.isAbsolutePath('.\\x'), false);
			assert.equal(PathUtils.isAbsolutePath('..\\y'), false);
		});

	});

	describe('makeRelative(target, path)', () => {

		it('identical paths should return empty string', () => {
			assert.equal(PathUtils.makeRelative('/a/b', '/a/b'), '');
		});

		it('target and path same length', () => {
			assert.equal(PathUtils.makeRelative('/a/b/c/d/e/f', '/a/b/c/g/h/j'), 'g/h/j');
		});

		it('target is longer', () => {
			assert.equal(PathUtils.makeRelative('/a/b/c/d', '/a/b/c'), '');
		});

		it('path is longer', () => {
			assert.equal(PathUtils.makeRelative('/a/b/c/d', '/a/b/c/d/e'), 'e');
		});

	});

	describe('makeRelative2(from, to)', () => {

		it('identical paths should return empty string', () => {
			assert.equal(PathUtils.makeRelative2('/common/a', '/common/a'), '');
		});

		it('from and to same length', () => {
			assert.equal(PathUtils.makeRelative2('/a/b/c/d/e/f','/a/b/c/g/h/j'), '../../g/h/j');
		});

		it('from is longer', () => {
			assert.equal(PathUtils.makeRelative2('/a/b/c/d', '/a/b/d'), '../d');
			assert.equal(PathUtils.makeRelative2('/a/b/c/d/e', '/a/d/e'), '../../d/e');
		});

		it('to is longer', () => {
			assert.equal(PathUtils.makeRelative2('/a/b/c/d', '/a/b/c/d/e'), 'e');
			assert.equal(PathUtils.makeRelative2('/a/b/c/d', '/a/b/c/d/e/f'), 'e/f');
			assert.equal(PathUtils.makeRelative2('/', '/a/b'), 'a/b');
		});

	});

});
