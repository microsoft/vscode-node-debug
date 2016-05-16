/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

!function() {

	var CHUNK_SIZE = 100;			// break large objects into chunks of this size
	var ARGUMENT_COUNT_INDEX = 3;	// index of Argument count field in FrameDetails
	var LOCAL_COUNT_INDEX = 4;		// index of Local count field in FrameDetails

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
	var namedProperties;
	try {
		var PropertyKind = vm.runInDebugContext('PropertyKind');
		indexedPropertyCount = function(mirror) {
			return mirror.propertyNames(PropertyKind.Indexed).length;
		};
		namedProperties = function(mirror) {
			return mirror.propertyNames(PropertyKind.Named);
		};
	} catch (error) {
		indexedPropertyCount = function(mirror) {
			var n = 0;
			const names = mirror.propertyNames();
			for (var i = 0; i < names.length; i++) {
				var name = names[i];
				if (name[0] >= '0' && name[0] <= '9') {
					n++;
				}
			}
			return n;
		};
		namedProperties = function(mirror) {
			var named = [];
			const names = mirror.propertyNames();
			for (var i = 0; i < names.length; i++) {
				var name = names[i];
				if (name[0] < '0' || name[0] > '9') {
					named.push(name);
				}
			}
			return named;
		};
	}

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
						if (m.propertyNames(PropertyKind.Indexed | PropertyKind.Named, CHUNK_SIZE).length >= CHUNK_SIZE) continue;
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
	 * The original backtrace request returns unsolicited arguments and local variables for all stack frames.
	 * If these arguments or local variables are large, they blow up the backtrace response which slows down
	 * stepping speed.
	 * This override clears the argument and local variable count in the FrameDetails structure
	 * which prevents arguments and local variables from being included in the backtrace response.
	 */
	DebugCommandProcessor.prototype.dispatch_['vscode_backtrace'] = function(request, response) {
		var result = this.backtraceRequest_(request, response);
		if (!result && response.body.frames) {
			var frames = response.body.frames;
			for (var i = 0; i < frames.length; i++) {
				const d = frames[i].details_.details_;
				d[ARGUMENT_COUNT_INDEX]= 0;		// don't include any Arguments in stack frame
				d[LOCAL_COUNT_INDEX]= 0;		// don't include any Locals in stack frame
			}
		}
		return result;
	}

	/**
	 * This new protocol request makes it possible to retrieve a range of values from a
	 * large object.
	 * If 'start' is specified, 'count' indexed properties are returned.
	 * If 'start' is omitted, the first 'count' named properties are returned.
 	 */
	DebugCommandProcessor.prototype.dispatch_['vscode_slice'] = function(request, response) {
		var handle = request.arguments.handle;
		var start = request.arguments.start;
		var count = request.arguments.count;
		var mirror = LookupMirror(handle);
		if (!mirror) {
			return response.failed('Object #' + handle + '# not found');
		}
		var result = [];
		if (typeof start === 'number') {
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
		} else {
			if (mirror.isArray() || mirror.isObject()) {
				var names = namedProperties(mirror);
				for (var i = 0; i < names.length; i++) {
					var name = names[i];
					var p = mirror.property(name);
					result.push({ name: name, value: p.value() });
				}
			}
		}
		response.body = {
			result: result
		};
	};

	/**
	 * If the passed mirror object is a large array or object this function
	 * returns the mirror without its properties but with a size attribute ('vscode_size') instead.
 	 */
	var dehydrate = function(mirror) {
		var size = -1;

		if (mirror.isArray()) {
			size = mirror.length();
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
				size = indexedPropertyCount(mirror);
				break;
			default:
				break;
			}
		}

		if (size > CHUNK_SIZE) {
			return {
				handle: mirror.handle(),
				type: 'object',
				className: mirror.className(),
				vscode_size: size
				//value: mirror.className()
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
		if (!result) {
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
				const details = scopes[i].details_.details_;
				if (details[0] === 1) {	// locals
					const locals = details[1];
					const names = Object.keys(locals);
					if (names.length > maxLocals) {
						var locals2 = {};
						for (var j = 0; j < maxLocals; j++) {
							var name = names[j];
							locals2[name] = locals[name];
						}
						details[1] = locals2;
					}
					response.body.vscode_locals = names.length;	// remember original number of locals
				}
			}
		}
		return result;
	};
}()
