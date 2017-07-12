/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

'use strict';

import * as vscode from 'vscode';
import { TreeDataProvider, TreeItem, EventEmitter, Event, ProviderResult } from 'vscode';
import { localize } from './utilities';
import { join, dirname, basename } from 'path';

let rootUri: vscode.Uri;

function workspaceFolders() : vscode.Uri[] {
	/*
	return vscode.workspace.workspaceFolders || [];
	*/
	if (vscode.workspace.rootPath) {
		if (!rootUri) {
			rootUri = vscode.Uri.file(vscode.workspace.rootPath);
		}
		return [ rootUri ];
	}
	return [];
}

//---- loaded script explorer

export class LoadedScriptsProvider implements TreeDataProvider<BaseTreeItem> {

	private _context: vscode.ExtensionContext;
	private _root: RootTreeItem;

	private _onDidChangeTreeData: EventEmitter<BaseTreeItem> = new EventEmitter<BaseTreeItem>();
	readonly onDidChangeTreeData: Event<BaseTreeItem> = this._onDidChangeTreeData.event;

	constructor(context: vscode.ExtensionContext) {
		this._context = context;
	}

	refresh(session: vscode.DebugSession) {
		if (!this._root) {
			this._root = this.createRoot();
		}
		this._root.add(session);
		this._onDidChangeTreeData.fire(undefined);
	}

	getChildren(node?: BaseTreeItem): ProviderResult<BaseTreeItem[]> {
		if (node === undefined) {	// return root node
			if (!this._root) {
				this._root = this.createRoot();
			}
			node = this._root;
		}
		return node.getChildren();
	}

	getTreeItem(node: BaseTreeItem): TreeItem {
		return node;
	}

	private createRoot(): RootTreeItem {

		const root = new RootTreeItem();

		this._context.subscriptions.push(vscode.debug.onDidChangeActiveDebugSession(session => {
			if (session && (session.type === 'node' || session.type === 'node2')) {
				root.add(session);
				this._onDidChangeTreeData.fire(undefined);
			}
		}));

		this._context.subscriptions.push(vscode.debug.onDidReceiveDebugSessionCustomEvent(event => {
			if (event.event === 'scriptLoaded' && (event.session.type === 'node' || event.session.type === 'node2')) {
				const sessionRoot = root.add(event.session);
				sessionRoot.addPath(event.body.path);
				this._onDidChangeTreeData.fire(undefined);
			}
		}));

		this._context.subscriptions.push(vscode.debug.onDidTerminateDebugSession(session => {
			root.remove(session.id);
			this._onDidChangeTreeData.fire(undefined);
		}));

		return root;
	}
}

class BaseTreeItem extends TreeItem {

	private _children: { [key: string]: BaseTreeItem; };

	constructor(label: string, state: vscode.TreeItemCollapsibleState) {
		super(label ? label : '/', state);
		this._children = {};
	}

	setPath(session: vscode.DebugSession, path: string): void {
		this.command = {
			command: 'extension.node-debug.openScript',
			arguments: [ session, path ],
			title: ''
		};
	}

	getChildren(): ProviderResult<BaseTreeItem[]> {
		const array = Object.keys(this._children).map( key => this._children[key] );
		return array.sort((a, b) => this.compare(a, b));
	}

	createIfNeeded<T extends BaseTreeItem>(key: string, factory: () => T): T {
		let child = <T> this._children[key];
		if (!child) {
			child = factory();
			this._children[key] = child;
		}
		return child;
	}

	remove(key: string): void {
		delete this._children[key];
	}

	protected compare(a: BaseTreeItem, b: BaseTreeItem): number {
		return a.label.localeCompare(b.label);
	}
}

class RootTreeItem extends BaseTreeItem {

	private _showedMoreThanOne: boolean;

	constructor() {
		super('Root', vscode.TreeItemCollapsibleState.Expanded);
		this._showedMoreThanOne = false;
	}

	getChildren(): ProviderResult<BaseTreeItem[]> {

		// skip sessions if there is only one
		const children = super.getChildren();
		if (Array.isArray(children)) {
			const size = children.length;
			if (!this._showedMoreThanOne && size === 1) {
				return children[0].getChildren();
			}
			this._showedMoreThanOne = size > 1;
		}
		return children;
	}

	add(session: vscode.DebugSession): SessionTreeItem {
		return this.createIfNeeded(session.id, () => new SessionTreeItem(session));
	}
}

class SessionTreeItem extends BaseTreeItem {

	private _session: vscode.DebugSession;
	private _initialized: boolean;

	constructor(session: vscode.DebugSession) {
		super(session.name, vscode.TreeItemCollapsibleState.Expanded);
		this._initialized = false;
		this._session = session;
		const dir = dirname(__filename);
		this.iconPath = {
			light: join(dir, '..', '..', '..', 'images', 'debug-light.svg'),
			dark: join(dir, '..', '..', '..', 'images', 'debug-dark.svg')
		};
	}

	getChildren(): ProviderResult<BaseTreeItem[]> {

		if (!this._initialized) {
			this._initialized = true;
			return listLoadedScripts(this._session).then(scripts => {
				if (scripts) {
					scripts.forEach(path => this.addPath(path.description));
				}
				return super.getChildren();
			});
		}

		return super.getChildren();
	}

	protected compare(a: BaseTreeItem, b: BaseTreeItem): number {
		const acat = this.category(a);
		const bcat = this.category(b);
		if (acat !== bcat) {
			return acat - bcat;
		}
		return super.compare(a, b);
	}

	/**
	 * Return an ordinal number for folders
	 */
	private category(item: BaseTreeItem): number {

		// workspace scripts come at the beginning in "folder" order
		if (item instanceof FolderTreeItem) {
			const folders = workspaceFolders();
			const x = folders.indexOf(item.folder);
			if (x >= 0) {
				return x;
			}
		}

		// <node_internals> come at the very end
		if (item.label === '<node_internals>') {
			return 1000;
		}

		// everything else in between
		return 999;
	}

	addPath(path: string): void {

		const fullPath = path;

		// map to root folders
		const folderUris = workspaceFolders();
		let found = folderUris.filter( uri => path.indexOf(uri.fsPath) === 0);
		if (found.length > 0) {
			const folderPath = found[0].fsPath;
			path = path.replace(folderPath, basename(folderPath));
		}

		let x: BaseTreeItem = this;
		path.split(/[\/\\]/).forEach(segment => {
			let initialExpandState = segment === '<node_internals>' ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.Expanded;
			if (found && found.length > 0) {
				x = x.createIfNeeded(segment, () => new FolderTreeItem(segment, initialExpandState, found[0]));
				found = undefined;
			} else {
				x = x.createIfNeeded(segment, () => new BaseTreeItem(segment, initialExpandState));
			}
		});
		x.setPath(this._session, fullPath);
		x.collapsibleState = vscode.TreeItemCollapsibleState.None;
	}
}

class FolderTreeItem extends BaseTreeItem {

	folder: vscode.Uri;

	constructor(label: string, state: vscode.TreeItemCollapsibleState, uri: vscode.Uri) {
		super(label, state);
		this.folder = uri;
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
				openScript(session, item.source.path);
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

export function openScript(session: vscode.DebugSession, path: string) {
	let uri = vscode.Uri.parse(`debug:${path}?session=${session.id}`);
	vscode.workspace.openTextDocument(uri).then(doc => vscode.window.showTextDocument(doc));
}
