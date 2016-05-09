/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

!function() {
	var vm = require('vm');
	var LookupMirror = vm.runInDebugContext('LookupMirror');
	var PropertyKindIndexed;
	try {
		var PropertyKind = vm.runInDebugContext('PropertyKind'); // https://github.com/electron/electron/issues/5295
		PropertyKindIndexed = PropertyKind.Indexed;
	} catch (error) {
		PropertyKindIndexed = 1;
	}
	var DebugCommandProcessor = vm.runInDebugContext('DebugCommandProcessor');

	DebugCommandProcessor.prototype.dispatch_['vscode_backtrace'] = function(request, response) {
		var result = this.backtraceRequest_(request, response);
		if (!result && response.body.frames) {
			var frames = response.body.frames;
			for (var i = 0; i < frames.length; i++) {
				const d = frames[i].details_.details_;
				d[3]= 0;
				d[4]= 0;
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
		var result;
		if (mirror.isArray()) {
			result = new Array(length);
			var a = mirror.indexedPropertiesFromRange(start, start+length-1);
			for (var i = 0; i < length; i++) {
				result[i] = a[i].value();
			}
		} else if (mirror.isObject()) {
			result = new Array(length);
			for (var i = 0, j = start; i < length; i++, j++) {
				var p = mirror.property(j.toString());
				result[i] = p.value();
			}
		} else {
			result = new Array(length);
		}
		response.body = {
			result: result
		};
	};

	DebugCommandProcessor.prototype.vscode_dehydrate = function(mirror) {
		var className = null;
		var size = -1;
		if (mirror.isArray()) {
			className = "Array";
			size = mirror.length();
		} else if (mirror.isObject()) {
			switch (mirror.toText()) {
			case "#<Buffer>":
				className = "Buffer";
				size = mirror.propertyNames(PropertyKindIndexed).length;
				break;
			case "#<Int8Array>":
			case "#<Uint8Array>":
			case "#<Uint8ClampedArray>":
			case "#<Int16Array>":
			case "#<Uint16Array>":
			case "#<Int32Array>":
			case "#<Uint32Array>":
			case "#<Float32Array>":
			case "#<Float64Array>":
				className = mirror.className();
				size = mirror.propertyNames(PropertyKindIndexed).length;
				break;
			default:
				break;
			}
		}
		if (size > 1000) {
			return {
				handle: mirror.handle(),
				type: "object",
				className: className,
				vscode_size: size,
				value: className
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
}()