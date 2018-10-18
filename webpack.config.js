/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

//@ts-check

'use strict';

const path = require('path');
const CopyWebpackPlugin = require('copy-webpack-plugin');

/**@type {import('webpack').Configuration}*/
const config = {
	target: 'node', // vscode extensions run in a Node.js-context
	mode: 'none',
	entry: {
		extension: './src/node/extension/extension.ts',
		nodeDebug: './src/node/nodeDebug.ts'
	},
	output: {
		filename: '[name].js',
		path: path.resolve(__dirname, 'dist'),
		libraryTarget: "commonjs2",
		devtoolModuleFilenameTemplate: "../[resource-path]",
	},
	devtool: 'source-map',
	externals: {
		vscode: "commonjs vscode" // the vscode-module is created on-the-fly and must be excluded. Add other modules that cannot be webpack'ed
	},
	resolve: { // support reading TypeScript and JavaScript files
		extensions: ['.ts', '.js']
	},
	module: {
		rules: [{
			loader: 'vscode-nls-dev/lib/webpack-loader',
			options: {
				base: path.join(__dirname, 'src')
			}
		}, {
			test: /\.ts$/,
			exclude: /node_modules/,
			use: [{
				loader: 'ts-loader',
			}]
		}]
	},
	plugins: [
		new CopyWebpackPlugin([
			{ from: './src/node/debugInjection.js', to: '.' }
		])
	],
}

module.exports = config;
