/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

!function() {

	var CHUNK_SIZE = 100;			// break large objects into chunks of this size
	var INDEX_PATTERN = /^(0|[1-9][0-9]*)$/;

	// try to load 'vm' even if 'require' isn't available in the current context
	var vm = process.mainModule ? process.mainModule.require('vm') : require('vm');

	// the following objects should be available in all versions of node.js
	var LookupMirror = vm.runInDebugContext('LookupMirror');
	var DebugCommandProcessor = vm.runInDebugContext('DebugCommandProcessor');

	/*
	 * Retrieving index and named properties of an object requires some work in recent versions of node
	 * because 'propertyNames' no longer takes a filter argument.
	 */
	var indexedPropertyCount;
	var namedPropertyCount;
	var hasManyProperties;
	var namedProperties;
	try {
		var PropertyKind = vm.runInDebugContext('PropertyKind');
		if (!PropertyKind) {
			throw new Error("undef");
		}
		indexedPropertyCount = function(mirror) {
			return mirror.propertyNames(PropertyKind.Indexed).length;
		};
		namedPropertyCount = function(mirror) {
			return mirror.propertyNames(PropertyKind.Named).length;
		};
		hasManyProperties = function(mirror, limit) {
			return mirror.propertyNames(PropertyKind.Named | PropertyKind.Indexed, limit).length >= limit;
		};
		namedProperties = function(mirror) {
			return mirror.propertyNames(PropertyKind.Named);
		};
	} catch (error) {
		indexedPropertyCount = function(mirror) {
			var n = 0;
			var names = mirror.propertyNames();
			for (var i = 0; i < names.length; i++) {
				if (isIndex(names[i])) {
					n++;
				}
			}
			return n;
		};
		namedPropertyCount = function(mirror) {
			var n = 0;
			var names = mirror.propertyNames();
			for (var i = 0; i < names.length; i++) {
				if (!isIndex(names[i])) {
					n++;
				}
			}
			return n;
		};
		hasManyProperties = function(mirror, limit) {
			return mirror.propertyNames().length >= limit;
		};
		namedProperties = function(mirror) {
			var named = [];
			var names = mirror.propertyNames();
			for (var i = 0; i < names.length; i++) {
				var name = names[i];
				if (!isIndex(name)) {
					named.push(name);
				}
			}
			return named;
		};
	}

	var isIndex = function(name) {
		switch (typeof name) {
			case 'number':
				return true;
			case 'string':
				return INDEX_PATTERN.test(name);
			default:
				return false;
		}
	};

	/**
	 * In old versions of node it was possible to monkey patch the JSON response serializer.
	 * This made it possible to drop large objects from the 'refs' array (that is part of every protocol response).
	 */
	try {
		var JSONProtocolSerializer = vm.runInDebugContext('JSONProtocolSerializer');

		JSONProtocolSerializer.prototype.serializeReferencedObjects = function () {
			var content = [];
			for (var i = 0; i < this.mirrors_.length; i++) {
				var m = this.mirrors_[i];

				if (m.isArray()) continue;

				if (m.isObject()) {
					if (m.handle() < 0) {
						// we cannot drop transient objects from 'refs' because they cannot be looked up later
					} else {
						if (hasManyProperties(m, CHUNK_SIZE)) {
							continue;
						}
					}
				}

				content.push(this.serialize_(m, false, false));
			}
			return content;
		};
	} catch (error) {
		// since overriding 'serializeReferencedObjects' is optional, we can silently ignore the error.
	}

	/**
	 * This new protocol request makes it possible to retrieve a range of values from a large object.
	 * 'mode' controls whether 'named' or 'indexed' or 'all' types of properties are returned.
	 * For 'indexed' or 'all' mode 'start' and 'count' specify the range of properties to return.
 	 */
	DebugCommandProcessor.prototype.dispatch_['vscode_slice'] = function(request, response) {
		var handle = request.arguments.handle;
		var start = request.arguments.start;
		var count = request.arguments.count;
		var mode = request.arguments.mode;
		var mirror = LookupMirror(handle);
		if (!mirror) {
			return response.failed('Object #' + handle + '# not found');
		}
		var result = [];
		if (mode === 'named' || mode === 'all') {
			if (mirror.isArray() || mirror.isObject()) {
				var names = namedProperties(mirror);
				for (var i = 0; i < names.length; i++) {
					var name = names[i];
					var p = mirror.property(name);
					result.push({ name: name, value: p.value() });
				}
			}
		}
		if (mode === 'indexed' || mode === 'all') {
			if (mirror.isArray()) {
				var a = mirror.indexedPropertiesFromRange(start, start+count-1);
				for (var i = 0; i < a.length; i++) {
					result.push({ name: (start+i).toString(), value: a[i].value() });
				}
			} else if (mirror.isObject()) {
				for (var i = 0, j = start; i < count; i++, j++) {
					var p = mirror.property(j.toString());
					result.push({ name: j.toString(), value: p.value() });
				}
			}
		}
		response.body = {
			result: result
		};
	};

	/**
	 * If the passed mirror object is a large array or object this function
	 * returns the mirror without its properties but with two size attributes ('vscode_namedCnt', 'vscode_indexedCnt') instead.
 	 */
	var dehydrate = function(mirror) {
		var namedCnt = -1;
		var indexedCnt = -1;

		if (mirror.isArray()) {
			namedCnt = namedPropertyCount(mirror);
			indexedCnt = mirror.length();
		} else if (mirror.isObject()) {
			switch (mirror.className()) {
			case 'ArrayBuffer':
			case 'Int8Array':
			case 'Uint8Array':
			case 'Uint8ClampedArray':
			case 'Int16Array':
			case 'Uint16Array':
			case 'Int32Array':
			case 'Uint32Array':
			case 'Float32Array':
			case 'Float64Array':
				namedCnt = namedPropertyCount(mirror);
				indexedCnt = indexedPropertyCount(mirror);
				break;
			default:
				break;
			}
		}

		if (indexedCnt > CHUNK_SIZE) {
			return {
				type: 'object',
				handle: mirror.handle(),
				className: mirror.className(),
				vscode_namedCnt: namedCnt,
				vscode_indexedCnt: indexedCnt
			};
		}
		return mirror;
	};

	/**
	 * This override removes the properties of large data structures from the lookup response
	 * and returns the size of the data structure instead.
 	 */
	DebugCommandProcessor.prototype.dispatch_['vscode_lookup'] = function(request, response) {
		var result = this.lookupRequest_(request, response);
		if (!result && response.body) {
			var handles = request.arguments.handles;
			for (var i = 0; i < handles.length; i++) {
				var handle = handles[i];
				response.body[handle] = dehydrate(response.body[handle]);
			}
		}
		return result;
	};

	/**
	 * This override removes the properties of large data structures from the lookup response
	 * and returns the size of the data structure instead.
 	 */
	DebugCommandProcessor.prototype.dispatch_['vscode_evaluate'] = function(request, response) {
		var result = this.evaluateRequest_(request, response);
		if (!result) {
			response.body = dehydrate(response.body);
		}
		return result;
	};

	/**
	 * This override trims the maximum number of local variables to 'maxLocals'.
	 */
	DebugCommandProcessor.prototype.dispatch_['vscode_scopes'] = function(request, response) {
		var result = this.scopesRequest_(request, response);
		if (!result) {
			var maxLocals = request.arguments.maxLocals;
			var scopes = response.body.scopes;
			for (var i = 0; i < scopes.length-1; i++) {
				var details = scopes[i].details_.details_;
				if (details && details[0] === 1) {	// locals
					var locals = details[1];
					var names = Object.keys(locals);
					if (names.length > maxLocals) {
						var locals2 = {};
						for (var j = 0; j < maxLocals; j++) {
							var name = names[j];
							locals2[name] = locals[name];
						}
						details[1] = locals2;
						response.body.vscode_locals = names.length;	// remember original number of locals
					}
				}
			}
		}
		return result;
	};
}()
