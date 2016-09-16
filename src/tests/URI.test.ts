/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

import * as assert from 'assert';
import {URI} from '../node/URI';

suite('URI', () => {

	suite('file', () => {

		test('absolute unix paths', () => {
			assert.equal(URI.file('/foo/bar/test.js').uri(), 'file:///foo/bar/test.js', 'simple unix path');
			assert.equal(URI.file('/foo/bär/test.js').uri(), 'file:///foo/b%C3%A4r/test.js', 'unix path with umlaut');
			assert.equal(URI.file('/foo/b\\r/test.js').uri(), 'file:///foo/b%5Cr/test.js', 'unix path with backslash');
		});

		test('absolute windows paths', () => {
			assert.equal(URI.file('c:\\foo\\bar\\test.js').uri(), 'file:///c:/foo/bar/test.js');
			assert.equal(URI.file('c:\\foo\\bär\\test.js').uri(), 'file:///c:/foo/b%C3%A4r/test.js');
		});

		test('relative unix paths', () => {
			assert.throws(() => { URI.file('test.js'); }, /base path missing/);
			assert.equal(URI.file('test.js', '/foo/bar').uri(), 'file:///foo/bar/test.js');
			assert.equal(URI.file('abc/test.js', '/foo/bar').uri(), 'file:///foo/bar/abc/test.js');
			assert.equal(URI.file('./test.js', '/foo/bar').uri(), 'file:///foo/bar/test.js');
			assert.equal(URI.file('./abc/test.js', '/foo/bar').uri(), 'file:///foo/bar/abc/test.js');
			//assert.equal(URI.file('../test.js', '/foo/bar').uri(), 'file:///foo/test.js');
		});

		test('relative windows paths', () => {
			assert.equal(URI.file('test.js', 'c:\\foo\\bar').uri(), 'file:///c:/foo/bar/test.js');
			assert.equal(URI.file('abc/test.js', 'c:\\foo\\bar').uri(), 'file:///c:/foo/bar/abc/test.js');
			assert.equal(URI.file('./test.js', 'c:\\foo\\bar').uri(), 'file:///c:/foo/bar/test.js');
			assert.equal(URI.file('./abc/test.js', 'c:\\foo\\bar').uri(), 'file:///c:/foo/bar/abc/test.js');
			//assert.equal(URI.file('../test.js', 'c:\\foo\\bar').uri(), 'file:///c:/foo/test.js');
		});

		test('filePath', () => {
			assert.equal(URI.file('c:\\foo\\bar\\test.js').filePath(), 'c:\\foo\\bar\\test.js');
			assert.equal(URI.file('/foo/bar/test.js').filePath(), '/foo/bar/test.js');
		});

	});

});
