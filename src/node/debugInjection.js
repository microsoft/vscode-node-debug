/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'status: '+function() {

	var status = '';

	var CHUNK_SIZE = 100;
	var ARGUMENT_COUNT_INDEX = 3;	// index of Argument count field in FrameDetails
	var LOCAL_COUNT_INDEX = 4;		// index of Local count field in FrameDetails

	var vm;
	if (process.mainModule) {
		vm = process.mainModule.require('vm');
		status += 'require from mainModule, ';
	} else {
		vm = require('vm');
		status += 'require as argument, ';
	}
	var LookupMirror = vm.runInDebugContext('LookupMirror');
	var DebugCommandProcessor = vm.runInDebugContext('DebugCommandProcessor');

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
		status += 'PropertyKind available, ';
	} catch (error) {
		indexedPropertyCount = function(mirror) {
			var n = 0;
			const names = mirror.propertyNames();
			for (var name of names) {
				if (name[0] >= '0' && name[0] <= '9') {
					n++;
				}
			}
			return n;
		};
		namedProperties = function(mirror) {
			var named = [];
			const names = mirror.propertyNames();
			for (var name of names) {
				if (name[0] < '0' || name[0] > '9') {
					named.push(name);
				}
			}
			return named;
		};
		status += 'PropertyKind not available, ';
	}

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
		status += 'JSONProtocolSerializer available\n';
	} catch (error) {
		status += 'JSONProtocolSerializer not available\n';
	}

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

	DebugCommandProcessor.prototype.dispatch_['vscode_slice'] = function(request, response) {
		var handle = request.arguments.handle;
		var start = request.arguments.start;
		var length = request.arguments.length;
		var mirror = LookupMirror(handle);
		if (!mirror) {
			return response.failed('Object #' + handle + '# not found');
		}
		var result = new Array();
		if (typeof start === 'number') {
			if (mirror.isArray()) {
				var a = mirror.indexedPropertiesFromRange(start, start+length-1);
				for (var i = 0; i < a.length; i++) {
					result.push({ name: (start+i).toString(), value: a[i].value() });
				}
			} else if (mirror.isObject()) {
				for (var i = 0, j = start; i < length; i++, j++) {
					var p = mirror.property(j.toString());
					result.push({ name: j.toString(), value: p.value() });
				}
			}
		} else {
			if (mirror.isArray() || mirror.isObject()) {
				var names = namedProperties(mirror);
				for (var name of names) {
					var p = mirror.property(name);
					result.push({ name: name, value: p.value() });
				}
			}
		}
		response.body = {
			result: result
		};
	};

	DebugCommandProcessor.prototype.vscode_dehydrate = function(mirror) {
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

	DebugCommandProcessor.prototype.dispatch_['vscode_lookup'] = function(request, response) {
		var result = this.lookupRequest_(request, response);
		if (!result) {
			var handles = request.arguments.handles;
			for (var i = 0; i < handles.length; i++) {
				var handle = handles[i];
				response.body[handle] = this.vscode_dehydrate(response.body[handle]);
			}
		}
		return result;
	};

	DebugCommandProcessor.prototype.dispatch_['vscode_evaluate'] = function(request, response) {
		var result = this.evaluateRequest_(request, response);
		if (!result) {
			response.body = this.vscode_dehydrate(response.body);
		}
		return result;
	};

	return status + 'OK';
}()