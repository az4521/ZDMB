// @ts-check

const {EventEmitter} = require("events")
const {test} = require("supertape")
const {Publisher, Listener, Rechunker, mxidFromIdentity} = require("./livekit")
const soundboard = require("./soundboard")

// Fake @livekit/rtc-node. Constants mirror the real enum values. Nothing here touches the network.

const TrackSource = {SOURCE_UNKNOWN: 0, SOURCE_CAMERA: 1, SOURCE_MICROPHONE: 2, SOURCE_SCREENSHARE: 3, SOURCE_SCREENSHARE_AUDIO: 4}
const TrackKind = {KIND_UNKNOWN: 0, KIND_AUDIO: 1, KIND_VIDEO: 2}
const RoomEvent = {
	TrackSubscribed: "trackSubscribed",
	DataReceived: "dataReceived",
	TrackUnsubscribed: "trackUnsubscribed",
	ParticipantDisconnected: "participantDisconnected",
	Disconnected: "disconnected"
}

class FakeAudioFrame {
	/** @param {Int16Array} data @param {number} sampleRate @param {number} channels @param {number} samplesPerChannel */
	constructor(data, sampleRate, channels, samplesPerChannel) {
		this.data = data
		this.sampleRate = sampleRate
		this.channels = channels
		this.samplesPerChannel = samplesPerChannel
	}
}

class FakeTrackPublishOptions {
	/** @param {object} options */
	constructor(options) {
		Object.assign(this, options)
	}
}

/** Creates a fake rtc module plus arrays that record every instance created through it. */
function makeFakeRtc() {
	const rooms = /** @type {FakeRoom[]} */ ([])
	const sources = /** @type {FakeAudioSource[]} */ ([])
	const streams = /** @type {FakeStreamRecord[]} */ ([])

	class FakeRoom extends EventEmitter {
		constructor() {
			super()
			/** @type {any} */
			this.localParticipant = undefined
			this.connectArgs = /** @type {any} */ (null)
			this.disconnected = false
			this.published = /** @type {any[]} */ ([])
			/** @type {{data: any, opts: any}[]} */
			this.dataPackets = []
			this.failData = false
			rooms.push(this)
		}

		/** @param {string} url @param {string} token @param {object} options */
		async connect(url, token, options) {
			this.connectArgs = {url, token, options}
			this.localParticipant = {
				publishTrack: async (/** @type {any} */ track, /** @type {any} */ opts) => {
					this.published.push({track, opts})
				},
				publishData: async (/** @type {any} */ data, /** @type {any} */ opts) => {
					if (this.failData) throw new Error("publish failed")
					this.dataPackets.push({data, opts})
				}
			}
		}

		async disconnect() {
			this.disconnected = true
		}
	}

	class FakeAudioSource {
		/** @param {number} sampleRate @param {number} numChannels */
		constructor(sampleRate, numChannels) {
			this.sampleRate = sampleRate
			this.numChannels = numChannels
			/** @type {FakeAudioFrame[]} */
			this.captured = []
			this.closed = false
			this.cleared = 0
			this.blocking = false
			/** @type {number|undefined} */
			this.queuedDuration = undefined
			/** @type {Array<() => void>} */
			this.resolvers = []
			sources.push(this)
		}

		/** @param {FakeAudioFrame} frame */
		captureFrame(frame) {
			if (this.closed) return Promise.reject(new Error("AudioSource is closed"))
			this.captured.push(frame)
			if (!this.blocking) return Promise.resolve()
			return new Promise(resolve => this.resolvers.push(resolve))
		}

		/** Unblocks every pending capture and any that follow. */
		release() {
			this.blocking = false
			for (const resolve of this.resolvers.splice(0)) resolve()
		}

		clearQueue() {
			this.cleared++
		}

		async close() {
			this.closed = true
		}
	}

	const FakeLocalAudioTrack = {
		/** @param {string} name @param {any} source */
		createAudioTrack(name, source) {
			return {
				name,
				source,
				closed: false,
				async close() {
					this.closed = true
				}
			}
		}
	}

	/**
	 * Fake AudioStream: a real ReadableStream whose frames are pushed by the test via `rec.push`.
	 * @typedef {{track: any, sampleRate: number, numChannels: number, controller: any, cancelled: boolean, push: (samples: Int16Array) => void}} FakeStreamRecord
	 */
	class FakeAudioStream extends ReadableStream {
		/** @param {any} track @param {number} sampleRate @param {number} numChannels */
		constructor(track, sampleRate, numChannels) {
			/** @type {FakeStreamRecord} */
			const rec = {
				track,
				sampleRate,
				numChannels,
				controller: null,
				cancelled: false,
				push(samples) {
					this.controller.enqueue(new FakeAudioFrame(samples, sampleRate, numChannels, samples.length / numChannels))
				}
			}
			super({
				start(controller) {
					rec.controller = controller
				},
				cancel() {
					rec.cancelled = true
				}
			})
			streams.push(rec)
		}
	}

	const rtc = {
		Room: FakeRoom,
		AudioSource: FakeAudioSource,
		LocalAudioTrack: FakeLocalAudioTrack,
		AudioFrame: FakeAudioFrame,
		AudioStream: FakeAudioStream,
		TrackPublishOptions: FakeTrackPublishOptions,
		TrackSource,
		TrackKind,
		RoomEvent
	}
	return {rtc, rooms, sources, streams}
}

/** Lets pending promise callbacks and reads run. */
function flush() {
	return new Promise(resolve => setTimeout(resolve, 0))
}

/** @param {number} length @param {number} [offset] */
function ramp(length, offset = 0) {
	const out = new Int16Array(length)
	for (let i = 0; i < length; i++) out[i] = (i + offset) % 30000
	return out
}

test("mxidFromIdentity: strips the device ID after the last colon", t => {
	t.equal(mxidFromIdentity("@user:server:DEVICE"), "@user:server")
	t.equal(mxidFromIdentity("@user:example.org:ZDMBVOICE"), "@user:example.org")
	t.equal(mxidFromIdentity("@user:example.org:port:DEV"), "@user:example.org:port")
	t.equal(mxidFromIdentity("nocolon"), "nocolon")
	t.end()
})

test("Rechunker: emits exact 960-sample chunks from arbitrary piece sizes", t => {
	const rechunker = new Rechunker()
	const input = ramp(3000)
	const pieces = [500, 500, 920, 1, 1079]
	/** @type {Int16Array[]} */
	const chunks = []
	let offset = 0
	for (const size of pieces) {
		chunks.push(...rechunker.push(input.slice(offset, offset + size)))
		offset += size
	}
	t.equal(offset, 3000)
	t.equal(chunks.length, 3)
	for (const chunk of chunks) t.equal(chunk.length, 960)
	const joined = new Int16Array(chunks.length * 960)
	chunks.forEach((chunk, i) => joined.set(chunk, i * 960))
	t.deepEqual(Array.from(joined), Array.from(input.slice(0, 2880)))
	t.end()
})

test("Rechunker: returns nothing until a full chunk is available", t => {
	const rechunker = new Rechunker()
	t.equal(rechunker.push(new Int16Array(959)).length, 0)
	t.equal(rechunker.push(new Int16Array(1)).length, 1)
	t.end()
})

test("Rechunker: returned chunks are copies, not views of the input", t => {
	const rechunker = new Rechunker()
	const input = ramp(960)
	const [chunk] = rechunker.push(input)
	input.fill(0)
	t.equal(chunk[5], 5)
	t.end()
})

test("Publisher: splits each 20 ms push into two 10 ms frames in order", async t => {
	const {rtc, sources} = makeFakeRtc()
	const publisher = new Publisher({url: "wss://lk.example", jwt: "jwt"}, {rtc})
	await publisher.connect()
	const samples = ramp(960, 7)
	publisher.pushMono(samples)
	await publisher.drain()

	const source = sources[0]
	t.equal(source.captured.length, 2)
	for (const frame of source.captured) {
		t.equal(frame.samplesPerChannel, 480)
		t.equal(frame.sampleRate, 48000)
		t.equal(frame.channels, 1)
		t.equal(frame.data.length, 480)
	}
	t.deepEqual(Array.from(source.captured[0].data), Array.from(samples.slice(0, 480)))
	t.deepEqual(Array.from(source.captured[1].data), Array.from(samples.slice(480, 960)))
	await publisher.close()
	t.end()
})

test("Publisher: connect uses no autoSubscribe, publishes a microphone track", async t => {
	const {rtc, rooms} = makeFakeRtc()
	const publisher = new Publisher({url: "wss://lk.example", jwt: "jwt"}, {rtc})
	await publisher.connect()
	const room = rooms[0]
	t.deepEqual(room.connectArgs, {url: "wss://lk.example", token: "jwt", options: {autoSubscribe: false, dynacast: false}})
	t.equal(room.published.length, 1)
	t.equal(room.published[0].track.name, "discord-audio")
	t.equal(room.published[0].opts.source, TrackSource.SOURCE_MICROPHONE)
	await publisher.close()
	t.end()
})

test("Publisher: pushes before connect and after close are ignored", async t => {
	const {rtc, sources} = makeFakeRtc()
	const publisher = new Publisher({url: "wss://lk.example", jwt: "jwt"}, {rtc})
	publisher.pushMono(ramp(960))
	t.equal(sources.length, 0)

	await publisher.connect()
	await publisher.close()
	publisher.pushMono(ramp(960))
	await publisher.drain()
	t.equal(sources[0].captured.length, 0)
	t.end()
})

test("Publisher: drops frames instead of queuing more than ~200 ms behind", async t => {
	const {rtc, sources} = makeFakeRtc()
	const publisher = new Publisher({url: "wss://lk.example", jwt: "jwt"}, {rtc})
	await publisher.connect()
	const source = sources[0]
	source.blocking = true
	for (let i = 0; i < 50; i++) publisher.pushMono(ramp(960, i))
	// 200 ms = 20 frames of 10 ms, and every push adds two frames
	t.equal(publisher.pending, 20)
	source.release()
	await publisher.drain()
	t.equal(source.captured.length, 20)
	await publisher.close()
	t.end()
})

test("Publisher: drops a push when the source reports more than 200 ms queued", async t => {
	const {rtc, sources} = makeFakeRtc()
	const publisher = new Publisher({url: "wss://lk.example", jwt: "jwt"}, {rtc})
	await publisher.connect()
	const source = sources[0]
	source.queuedDuration = 250
	publisher.pushMono(ramp(960))
	await publisher.drain()
	t.equal(source.captured.length, 0)

	source.queuedDuration = 100
	publisher.pushMono(ramp(960))
	await publisher.drain()
	t.equal(source.captured.length, 2)
	await publisher.close()
	t.end()
})

test("Publisher: close is idempotent and tears down track, source and room", async t => {
	const {rtc, rooms, sources} = makeFakeRtc()
	const publisher = new Publisher({url: "wss://lk.example", jwt: "jwt"}, {rtc})
	await publisher.connect()
	await publisher.close()
	await publisher.close()
	t.equal(sources[0].closed, true)
	t.equal(sources[0].cleared, 1)
	t.equal(rooms[0].disconnected, true)
	t.equal(rooms[0].published[0].track.closed, true)
	t.end()
})

test("Listener: emits trackStart, rechunked audio, and one trackEnd for a microphone track", async t => {
	const {rtc, rooms, streams} = makeFakeRtc()
	const listener = new Listener({url: "wss://lk.example", jwt: "jwt", isOurs: () => false}, {rtc})
	/** @type {any[]} */
	const events = []
	listener.on("trackStart", (identity, mxid) => events.push(["trackStart", identity, mxid]))
	listener.on("audio", (identity, samples) => events.push(["audio", identity, samples.length]))
	listener.on("trackEnd", identity => events.push(["trackEnd", identity]))
	await listener.connect()

	const identity = "@alice:example.org:ABCDEF"
	const publication = {source: TrackSource.SOURCE_MICROPHONE}
	const track = {kind: TrackKind.KIND_AUDIO, source: TrackSource.SOURCE_MICROPHONE}
	rooms[0].emit(RoomEvent.TrackSubscribed, track, publication, {identity})
	t.equal(streams.length, 1)
	t.equal(streams[0].sampleRate, 48000)
	t.equal(streams[0].numChannels, 1)

	streams[0].push(ramp(500))
	streams[0].push(ramp(1000))
	await flush()
	await flush()
	t.deepEqual(events.slice(0, 2), [["trackStart", identity, "@alice:example.org"], ["audio", identity, 960]])
	t.equal(events.filter(e => e[0] === "audio").length, 1, "1500 samples gives one full chunk so far")

	rooms[0].emit(RoomEvent.ParticipantDisconnected, {identity})
	rooms[0].emit(RoomEvent.TrackUnsubscribed, track, publication, {identity})
	await flush()
	await listener.close()
	t.deepEqual(events.filter(e => e[0] === "trackEnd"), [["trackEnd", identity]])
	t.equal(streams[0].cancelled, true)
	t.end()
})

test("Listener: ignores identities for which isOurs is true", async t => {
	const {rtc, rooms, streams} = makeFakeRtc()
	const listener = new Listener({
		url: "wss://lk.example",
		jwt: "jwt",
		isOurs: identity => identity.startsWith("@bridge:")
	}, {rtc})
	/** @type {string[]} */
	const started = []
	listener.on("trackStart", identity => started.push(identity))
	await listener.connect()

	const publication = {source: TrackSource.SOURCE_MICROPHONE}
	const track = {kind: TrackKind.KIND_AUDIO, source: TrackSource.SOURCE_MICROPHONE}
	rooms[0].emit(RoomEvent.TrackSubscribed, track, publication, {identity: "@bridge:example.org:ZDMB"})
	t.equal(streams.length, 0)
	t.deepEqual(started, [])

	rooms[0].emit(RoomEvent.TrackSubscribed, track, publication, {identity: "@bob:example.org:ABCDEF"})
	t.equal(streams.length, 1)
	t.deepEqual(started, ["@bob:example.org:ABCDEF"])
	await listener.close()
	t.end()
})

test("Listener: ignores non-microphone sources and non-audio tracks", async t => {
	const {rtc, rooms, streams} = makeFakeRtc()
	const listener = new Listener({url: "wss://lk.example", jwt: "jwt", isOurs: () => false}, {rtc})
	/** @type {string[]} */
	const started = []
	listener.on("trackStart", identity => started.push(identity))
	await listener.connect()

	const participant = {identity: "@carol:example.org:ABCDEF"}
	const screenShareAudio = {kind: TrackKind.KIND_AUDIO, source: TrackSource.SOURCE_SCREENSHARE_AUDIO}
	rooms[0].emit(RoomEvent.TrackSubscribed, screenShareAudio, {source: TrackSource.SOURCE_SCREENSHARE_AUDIO}, participant)
	const video = {kind: TrackKind.KIND_VIDEO, source: TrackSource.SOURCE_MICROPHONE}
	rooms[0].emit(RoomEvent.TrackSubscribed, video, {source: TrackSource.SOURCE_MICROPHONE}, participant)
	t.equal(streams.length, 0)
	t.deepEqual(started, [])
	await listener.close()
	t.end()
})

test("Listener: close is idempotent and ends every open track once", async t => {
	const {rtc, rooms, streams} = makeFakeRtc()
	const listener = new Listener({url: "wss://lk.example", jwt: "jwt", isOurs: () => false}, {rtc})
	/** @type {string[]} */
	const ended = []
	listener.on("trackEnd", identity => ended.push(identity))
	await listener.connect()

	const publication = {source: TrackSource.SOURCE_MICROPHONE}
	const track = {kind: TrackKind.KIND_AUDIO, source: TrackSource.SOURCE_MICROPHONE}
	rooms[0].emit(RoomEvent.TrackSubscribed, track, publication, {identity: "@dave:example.org:ABCDEF"})
	await listener.close()
	await listener.close()
	await flush()
	t.deepEqual(ended, ["@dave:example.org:ABCDEF"])
	t.equal(streams[0].cancelled, true)
	t.equal(rooms[0].disconnected, true)
	t.end()
})

test("Listener: an unsubscribe for a different track does not end the current one", async t => {
	const {rtc, rooms, streams} = makeFakeRtc()
	const listener = new Listener({url: "wss://lk.example", jwt: "jwt", isOurs: () => false}, {rtc})
	/** @type {string[]} */
	const ended = []
	listener.on("trackEnd", identity => ended.push(identity))
	await listener.connect()

	const participant = {identity: "@erin:example.org:ABCDEF"}
	const publication = {source: TrackSource.SOURCE_MICROPHONE}
	const track = {kind: TrackKind.KIND_AUDIO, source: TrackSource.SOURCE_MICROPHONE}
	const oldTrack = {kind: TrackKind.KIND_AUDIO, source: TrackSource.SOURCE_MICROPHONE}
	rooms[0].emit(RoomEvent.TrackSubscribed, track, publication, participant)
	rooms[0].emit(RoomEvent.TrackUnsubscribed, oldTrack, publication, participant)
	await flush()
	t.deepEqual(ended, [])
	t.equal(streams[0].cancelled, false)
	await listener.close()
	t.end()
})

const SOUND_URL = "mxc://cadence.moe/airhorn"

test("Publisher: publishData sends a reliable packet with its topic, and is ignored before connect and after close", async t => {
	const {rtc, rooms} = makeFakeRtc()
	const publisher = new Publisher({url: "wss://lk.example", jwt: "jwt"}, {rtc})
	const bytes = soundboard.encodeSoundboardPacket({url: SOUND_URL, shortcode: "airhorn"})
	t.equal(await publisher.publishData(bytes, {topic: soundboard.SOUNDBOARD_TOPIC}), false, "not connected yet")
	await publisher.connect()
	t.equal(await publisher.publishData(bytes, {topic: soundboard.SOUNDBOARD_TOPIC}), true)
	t.equal(rooms[0].dataPackets.length, 1)
	t.equal(rooms[0].dataPackets[0].data, bytes)
	t.deepEqual(rooms[0].dataPackets[0].opts, {reliable: true, topic: "moe.crafty.soundboard"})
	await publisher.close()
	t.equal(await publisher.publishData(bytes, {topic: soundboard.SOUNDBOARD_TOPIC}), false, "closed")
	t.equal(rooms[0].dataPackets.length, 1)
	t.end()
})

test("Publisher: a failed publishData is logged and reported as false, never thrown", async t => {
	const {rtc, rooms} = makeFakeRtc()
	const publisher = new Publisher({url: "wss://lk.example", jwt: "jwt"}, {rtc})
	await publisher.connect()
	rooms[0].failData = true
	/** @type {any[][]} */
	const logged = []
	const savedError = console.error
	console.error = (...args) => { logged.push(args) }
	try {
		t.equal(await publisher.publishData(new Uint8Array(3), {topic: "moe.crafty.soundboard"}), false)
	} finally {
		console.error = savedError
	}
	t.equal(logged.length, 1)
	await publisher.close()
	t.end()
})

test("Listener: publishData is ignored until connected, then sends from the bridge bot's identity", async t => {
	const {rtc, rooms} = makeFakeRtc()
	const listener = new Listener({url: "wss://lk.example", jwt: "jwt", isOurs: () => true}, {rtc})
	const bytes = new Uint8Array([1, 2, 3])
	t.equal(await listener.publishData(bytes, {topic: "moe.crafty.soundboard"}), false, "not connected yet")
	await listener.connect()
	t.equal(await listener.publishData(bytes, {topic: "moe.crafty.soundboard", reliable: false}), true)
	t.deepEqual(rooms[0].dataPackets[0].opts, {reliable: false, topic: "moe.crafty.soundboard"})
	await listener.close()
	t.equal(await listener.publishData(bytes, {topic: "moe.crafty.soundboard"}), false, "closed")
	t.end()
})

test("Listener: emits soundboard for a valid packet from someone who is not ours", async t => {
	const {rtc, rooms} = makeFakeRtc()
	const listener = new Listener({url: "wss://lk.example", jwt: "jwt", isOurs: identity => identity.startsWith("@_ooye_")}, {rtc})
	/** @type {any[]} */
	const sounds = []
	listener.on("soundboard", (identity, sound) => sounds.push([identity, sound]))
	await listener.connect()
	const packet = soundboard.encodeSoundboardPacket({url: SOUND_URL, shortcode: "airhorn"})
	rooms[0].emit(RoomEvent.DataReceived, packet, {identity: "@alice:example.org:ABCDEF"}, 0, "moe.crafty.soundboard")
	t.deepEqual(sounds, [["@alice:example.org:ABCDEF", {url: SOUND_URL, shortcode: "airhorn", name: "airhorn"}]])
	await listener.close()
	t.end()
})

test("Listener: ignores soundboard packets from our identities, other topics, and invalid packets", async t => {
	const {rtc, rooms} = makeFakeRtc()
	const listener = new Listener({url: "wss://lk.example", jwt: "jwt", isOurs: identity => identity.startsWith("@_ooye_")}, {rtc})
	/** @type {any[]} */
	const sounds = []
	listener.on("soundboard", (identity, sound) => sounds.push([identity, sound]))
	await listener.connect()
	const room = rooms[0]
	const good = soundboard.encodeSoundboardPacket({url: SOUND_URL, shortcode: "airhorn"})
	const alice = {identity: "@alice:example.org:ABCDEF"}
	const ours = {identity: "@_ooye_sim_555:cadence.moe:DEVICE"}
	room.emit(RoomEvent.DataReceived, good, ours, 0, "moe.crafty.soundboard")
	room.emit(RoomEvent.DataReceived, good, alice, 0, "some.other.topic")
	room.emit(RoomEvent.DataReceived, good, alice, 0, undefined)
	room.emit(RoomEvent.DataReceived, Buffer.from("not json"), alice, 0, "moe.crafty.soundboard")
	room.emit(RoomEvent.DataReceived, Buffer.from(`{"url":"https://example.org/x.mp3","shortcode":"a"}`), alice, 0, "moe.crafty.soundboard")
	room.emit(RoomEvent.DataReceived, Buffer.alloc(2000, 32), alice, 0, "moe.crafty.soundboard")
	room.emit(RoomEvent.DataReceived, good, null, 0, "moe.crafty.soundboard")
	t.equal(sounds.length, 0, "nothing was emitted")

	room.emit(RoomEvent.DataReceived, good, alice, 0, "moe.crafty.soundboard")
	t.equal(sounds.length, 1, "a good packet from someone else still gets through")
	await listener.close()
	t.end()
})
