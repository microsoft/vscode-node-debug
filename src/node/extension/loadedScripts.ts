/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

'use strict';

import * as vscode from 'vscode';
import { TreeDataProvider, TreeItem, EventEmitter, Event } from 'vscode';
import { localize } from './utilities';


//---- loaded script explorer

export class LoadedScriptsProvider implements TreeDataProvider<ScriptTreeItem> {

	private _context: vscode.ExtensionContext;
	private _root: ScriptTreeItem;

	//private _disposables: Map<ScriptTreeItem, Disposable[]> = new Map<ScriptTreeItem, Disposable[]>();

	private _onDidChangeTreeData: EventEmitter<ScriptTreeItem> = new EventEmitter<ScriptTreeItem>();
	readonly onDidChangeTreeData: Event<ScriptTreeItem> = this._onDidChangeTreeData.event;

	constructor(context: vscode.ExtensionContext) {
		this._context = context;
	}

	getChildren(node?: ScriptTreeItem): Thenable<ScriptTreeItem[]> {
		if (node === undefined) {	// return root node
			if (!this._root) {
				this._root = this.createRoot();
			}
			node = this._root;
		}
		return node.getChildren();
	}

	getTreeItem(node: ScriptTreeItem): TreeItem {
		return node;
	}

	private createRoot(): ScriptTreeItem {

		const root = new ScriptTreeItem('Root');

		this._context.subscriptions.push(vscode.debug.onDidTerminateDebugSession(session => {
			root.remove(session);
			this._onDidChangeTreeData.fire(undefined);
		}));

		this._context.subscriptions.push(vscode.debug.onDidChangeActiveDebugSession(session => {
			if (session && (session.type === 'node' || session.type === 'node2')) {
				const sessionRoot = root.add(session);
				this._onDidChangeTreeData.fire(undefined);

				session.onCustomEvent(event => {
					if (event.event === 'scriptLoaded') {
						sessionRoot.addPath(event.body.path);
					}
				});
			}
		}));

		return root;
	}
}

class ScriptTreeItem extends TreeItem {

	children?: { [key: string]: ScriptTreeItem; };
	session?: vscode.DebugSession;

	constructor(label: string, state: vscode.TreeItemCollapsibleState = vscode.TreeItemCollapsibleState.None) {
		super(label ? label : '/', state);
	}

	setPath(path: string) {
		if (path) {
			this.command = {
				command: 'extension.node-debug.openScript',
				arguments: [ path ],
				title: ''
			};
			this.collapsibleState = vscode.TreeItemCollapsibleState.None;
		}
	}

	getChildren(): Thenable<ScriptTreeItem[]> {

		if (!this.children) {
			this.children = {};
			if (this.session) {
				return listLoadedScripts(this.session).then(scripts => {
					if (scripts) {
						scripts.forEach(path => this.addPath(path.description));
					}
					return Object.keys(this.children).map(key => this.children[key]);
				});
			}
		}

		return Promise.resolve(Object.keys(this.children).map( key => this.children[key] ));
	}

	addPath(path: string): void {
		let x: ScriptTreeItem = this;
		path.split('/').forEach(segment => {
			if (!x.children) {
				x.children = {};
			}
			if (!x.children[segment]) {
				x.children[segment] = new ScriptTreeItem(segment, vscode.TreeItemCollapsibleState.Collapsed);
			}
			x = x.children[segment];
		});
		x.setPath(path);
	}

	add(session: vscode.DebugSession): ScriptTreeItem {
		if (!this.children) {
			this.children = {};
		}
		let child = this.children[session.name];
		if (!child) {
			child = new ScriptTreeItem(session.name);
			this.children[session.name] = child;
		}
		child.session = session;
		child.collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;
		return child;
	}

	remove(session: vscode.DebugSession) {
		if (this.children) {
			delete this.children[session.name];
		}
	}
}


//---- loaded script picker

interface ScriptItem extends vscode.QuickPickItem {
	source?: any;	// Source
}

export function pickLoadedScript() {

	const session = vscode.debug.activeDebugSession;

	return listLoadedScripts(session).then(items => {

		let options : vscode.QuickPickOptions = {
			placeHolder: localize('select.script', "Select a script"),
			matchOnDescription: true,
			matchOnDetail: true,
			ignoreFocusOut: true
		};

		if (items === undefined) {
			items = [ { label: localize('no.loaded.scripts', "No loaded scripts available"), description: '' } ];
		}

		vscode.window.showQuickPick(items, options).then(item => {
			if (item && item.source) {
				let uri = vscode.Uri.parse(`debug:${item.source.path}`);
				vscode.workspace.openTextDocument(uri).then(doc => vscode.window.showTextDocument(doc));
			}
		});
	});
}

function listLoadedScripts(session: vscode.DebugSession | undefined) : Thenable<ScriptItem[] | undefined> {

	if (session) {
		return session.customRequest('getLoadedScripts').then(reply => {
			return reply.loadedScripts;
		}, err => {
			return undefined;
		});
	} else {
		return Promise.resolve(undefined);
	}
}

export function openScript(path: string) {
	let uri = vscode.Uri.parse(`debug:${path}`);
	vscode.workspace.openTextDocument(uri).then(doc => vscode.window.showTextDocument(doc));
}
