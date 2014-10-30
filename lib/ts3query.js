var net = require("net")
var Promise = require("bluebird")
var EventEmitter = require("events")

var util = require("nyutil")
var debug = util.debuglog("ts3query")
var es = require("event-stream")

function ServerQuery() {
	EventEmitter.call(this)

	this.connected = false
	this.socket = null
	this.queue = []
	this.active = null

	if (arguments.length) {
		this.connect.apply(this, arguments)
	}
}
util.object.inherits(ServerQuery, EventEmitter)

ServerQuery.prototype.connect = function () {
	var self = this
	var cb = null
	var args = util.args(arguments)
	if (util.is.function(args[args.length - 1])) {
		cb = args.pop()
	}

	debug("connecting...")
	this.socket = net.connect.apply(net, args)

	// create promise
	var promise = new Promise(function (resolve, reject) {
		self.socket.on("error", function (err) {
			reject(err)
		})
		self.socket.on("close", self.emit.bind(self, "close", self.queue))

		self.socket.on("connect", self.createStream.bind(self, resolve))
	})

	return promise.nodeify(cb)
}

ServerQuery.prototype.createStream = function (resolve) {
	debug("connected, creating stream")
	this.on("connect", resolve)

	this.socket.setEncoding("utf-8")
	this.socket
		.pipe(es.split())
		.on("data", this.processInput.bind(this))
}

ServerQuery.prototype.processInput = function (data) {
	data = data.trim()
	if (data === "TS3") {
		return
	}

	if (data.substr(0, 48) === "Welcome to the TeamSpeak 3 ServerQuery interface") {
		debug("connection established")
		this.emit("connect")
		this.connected = true
		return this.processQueue()
	}

	var type = data.substr(0, 5)

	if (type === "notif") {
		type = data.split(" ")[0]
		debug("emit notification %s", type)
		var params = this.parseResponse(data.substr(type.length + 1))

		return this.emit(type, params)
	}

	if (!this.active) {
		if (!data.length) {
			return this.socket.emit("error", new Error("connection closed"))
		}

		console.log(JSON.stringify(data))

		throw new Error("Unexpected message: " + data)
	}

	if (type !== "error") {
		return this.active.buffer += data + "\n"
	} else {
		var err = this.parseResponse(data.substr(6))

		if (err.id > 0) {
			debug("failed to executed command '%s'", this.active.request)
			var msg = "TS3Error: " + err.msg
			if (err.extra_msg) {
				msg += "\n" + err.extra_msg
			}
			this.active.reject(new Error(msg))
		} else {
			debug("successfully executed command '%s'", this.active.request)
			var res = this.parseResponse(this.active.buffer)
			delete res[""]
			var resolve = this.active.resolve
			this.active = null
			resolve(res)
		}
	}
}

ServerQuery.prototype.processQueue = function() {
	if (!this.connected) {
		return
	}

	if (!this.active && this.queue.length) {
		this.active = this.queue.shift()
		debug("sending '%s'...", this.active.request)
		this.socket.write(this.active.request + "\n")
	}
}

ServerQuery.prototype.parseResponse = function (data) {
	var response = data.trim().split("|").map(function(element) {
		var args = element.split(" ")
		var thisrec = {}

		args.forEach(function(arg) {
			var equals = arg.indexOf("=");
			if (equals >= 0){
				var key = ServerQuery.unescape(arg.substr(0, equals))
				var value = ServerQuery.unescape(arg.substr(equals + 1))
				thisrec[key] = value
			} else {
				thisrec[arg] = true
			}
		}, this);

		return thisrec
	})

	switch (response.length) {
		case 0: return null
		case 1: return response.pop()
		default: return response
	}
}

ServerQuery.prototype.send = function(cmd) {
	var self = this
	// build parameters
	var params = {}
	var options = []
	var callback = null
	util.args(arguments, 1).forEach(function (arg) {
		if (util.is.array(arg)) {
			options = arg
		} else if (util.is.function(arg)) {
			callback = arg
		} else {
			params = arg
		}
	})

	var command = ServerQuery.escape(cmd)

	Object.keys(params).forEach(function (key) {
		var value = params[key]
		key = ServerQuery.escape(key)
		value = ServerQuery.escape(value)
		command += " " + key + "=" + ServerQuery.escape(value)
	})

	options.forEach(function(value) {
		command += " -" + ServerQuery.escape(value)
	})

	debug("adding '%s' to send queue", command)
	var promise = new Promise(function (resolve, reject) {
		self.queue.push({
			request: command,
			callback: callback,
			resolve: resolve,
			reject: reject,
			buffer: ""
		})

		self.processQueue()
	});

	return promise.nodeify(callback)
}

ServerQuery.escape = function (s) {
	return String(s)
		.replace(/\\/g, "\\\\") // Backslash
		.replace(/\//g, "\\/")  // Slash
		.replace(/\|/g, "\\p")  // Pipe
		.replace(/\n/g, "\\n")  // Newline
		.replace(/\r/g, "\\r")  // Carriage Return
		.replace(/\t/g, "\\t")  // Tab
		.replace(/\v/g, "\\v")  // Vertical Tab
		.replace(/\f/g, "\\f")  // Formfeed
		.replace(/ /g,  "\\s")  // Whitespace
}

ServerQuery.unescape = function (s) {
	return String(s)
		.replace(/\\s/g,  " ")  // Whitespace
		.replace(/\\p/g,  "|")  // Pipe
		.replace(/\\n/g,  "\n") // Newline
		.replace(/\\f/g,  "\f") // Formfeed
		.replace(/\\r/g,  "\r") // Carriage Return
		.replace(/\\t/g,  "\t") // Tab
		.replace(/\\v/g,  "\v") // Vertical Tab
		.replace(/\\\//g, "\/") // Slash
		.replace(/\\\\/g, "\\") // Backslash
}

module.exports = ServerQuery
