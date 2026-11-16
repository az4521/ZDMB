// @ts-check

/*
LiveKit media for the voice bridge.

- Publisher: one per Discord speaker. Pushes their 20 ms mono PCM into a LiveKit room as a microphone track.
- Listener: one per bridged room, joined as the bridge bot. Emits the audio of each Matrix participant's microphone track.

@livekit/rtc-node is required lazily so this file can be loaded when the package is not installed.
*/

const {EventEmitter} = require("events")

const SAMPLE_RATE = 48000
const CHANNELS = 1
const CHUNK_SAMPLES = 960 // 20 ms at 48 kHz mono
const HALF_CHUNK_SAMPLES = 480 // 10 ms
const MAX_BEHIND_MS = 200
const MAX_PENDING_FRAMES = MAX_BEHIND_MS / 10

/** @returns {any} */
function loadRtc() {
	return require("@livekit/rtc-node")
}

/**
 * LiveKit identities are issued as `${mxid}:${deviceID}`, and device IDs never contain ":".
 * @param {string} identity
 * @returns {string}
 */
function mxidFromIdentity(identity) {
	const index = identity.lastIndexOf(":")
	return index === -1 ? identity : identity.slice(0, index)
}

/**
 * Turns arbitrarily sized mono Int16Array pieces into exact fixed-size chunks.
 * Keeps the remainder between pushes. Returned chunks are copies.
 */
class Rechunker {
	/** @param {number} [chunkSize] */
	constructor(chunkSize = CHUNK_SAMPLES) {
		this.chunkSize = chunkSize
		/** @type {Int16Array} */
		this.remainder = new Int16Array(0)
	}

	/**
	 * @param {Int16Array} samples
	 * @returns {Int16Array[]}
	 */
	push(samples) {
		const merged = new Int16Array(this.remainder.length + samples.length)
		merged.set(this.remainder)
		merged.set(samples, this.remainder.length)
		/** @type {Int16Array[]} */
		const chunks = []
		let offset = 0
		while (merged.length - offset >= this.chunkSize) {
			chunks.push(merged.slice(offset, offset + this.chunkSize))
			offset += this.chunkSize
		}
		this.remainder = merged.slice(offset)
		return chunks
	}
}

class Publisher {
	/**
	 * @param {{url: string, jwt: string}} credentials
	 * @param {{rtc?: any}} [options] `rtc` replaces the @livekit/rtc-node module (tests only)
	 */
	constructor({url, jwt}, {rtc} = {}) {
		this.url = url
		this.jwt = jwt
		this.rtc = rtc || loadRtc()
		/** @type {any} */
		this.room = null
		/** @type {any} */
		this.source = null
		/** @type {any} */
		this.track = null
		this.connected = false
		this.closed = false
		/** Frames handed to captureFrame or waiting to be, in 10 ms units. */
		this.pending = 0
		/** @type {Promise<void>} */
		this.queue = Promise.resolve()
	}

	async connect() {
		if (this.closed) return
		const rtc = this.rtc
		const room = new rtc.Room()
		this.room = room
		await room.connect(this.url, this.jwt, {autoSubscribe: false, dynacast: false})
		if (this.closed) return

		const source = new rtc.AudioSource(SAMPLE_RATE, CHANNELS)
		this.source = source
		const track = rtc.LocalAudioTrack.createAudioTrack("discord-audio", source)
		this.track = track
		const local = room.localParticipant
		if (!local) throw new Error("LiveKit room has no local participant after connect")
		await local.publishTrack(track, new rtc.TrackPublishOptions({source: rtc.TrackSource.SOURCE_MICROPHONE}))
		if (this.closed) return
		this.connected = true
	}

	/**
	 * Queues one 20 ms frame. Does not wait for LiveKit. Frames are dropped when more than ~200 ms are queued.
	 * @param {Int16Array} samples mono, exactly 960 samples
	 */
	pushMono(samples) {
		if (samples.length !== CHUNK_SAMPLES) throw new Error(`pushMono expects ${CHUNK_SAMPLES} samples, got ${samples.length}`)
		const source = this.source
		if (!this.connected || this.closed || !source) return
		if (this.pending >= MAX_PENDING_FRAMES) return
		if (typeof source.queuedDuration === "number" && source.queuedDuration > MAX_BEHIND_MS) return

		const rtc = this.rtc
		for (let half = 0; half < 2; half++) {
			const data = samples.slice(half * HALF_CHUNK_SAMPLES, (half + 1) * HALF_CHUNK_SAMPLES)
			const frame = new rtc.AudioFrame(data, SAMPLE_RATE, CHANNELS, HALF_CHUNK_SAMPLES)
			this.pending++
			this.queue = this.queue
				.then(() => source.captureFrame(frame))
				.catch(() => {}) // source closed or errored: nothing useful to do with this frame
				.finally(() => { this.pending-- })
		}
	}

	/**
	 * Resolves once every frame queued so far has been handed to LiveKit.
	 * @returns {Promise<void>}
	 */
	drain() {
		return this.queue
	}

	async close() {
		if (this.closed) return
		this.closed = true
		this.connected = false
		const {room, source, track} = this
		this.room = this.source = this.track = null
		if (source) {
			try { source.clearQueue() } catch (e) {}
		}
		if (track) {
			try { await track.close() } catch (e) {}
		}
		if (source) {
			try { await source.close() } catch (e) {}
		}
		if (room) {
			try { await room.disconnect() } catch (e) {}
		}
	}
}

class Listener extends EventEmitter {
	/**
	 * @param {{url: string, jwt: string, isOurs?: (identity: string) => boolean}} credentials
	 * @param {{rtc?: any}} [options] `rtc` replaces the @livekit/rtc-node module (tests only)
	 */
	constructor({url, jwt, isOurs}, {rtc} = {}) {
		super()
		this.url = url
		this.jwt = jwt
		this.isOurs = isOurs || (() => false)
		this.rtc = rtc || loadRtc()
		/** @type {any} */
		this.room = null
		this.closed = false
		/** @type {Map<string, {track: any, reader: any, rechunker: Rechunker, ended: boolean}>} */
		this.entries = new Map()
	}

	async connect() {
		if (this.closed) return
		const rtc = this.rtc
		const room = new rtc.Room()
		this.room = room
		room.on(rtc.RoomEvent.TrackSubscribed, (/** @type {any} */ track, /** @type {any} */ publication, /** @type {any} */ participant) => {
			this._onSubscribed(track, publication, participant)
		})
		room.on(rtc.RoomEvent.TrackUnsubscribed, (/** @type {any} */ track, /** @type {any} */ publication, /** @type {any} */ participant) => {
			this._onUnsubscribed(track, participant)
		})
		room.on(rtc.RoomEvent.ParticipantDisconnected, (/** @type {any} */ participant) => {
			this._endIdentity(participant.identity)
		})
		room.on(rtc.RoomEvent.Disconnected, (/** @type {any} */ reason) => {
			this._endAll()
			this.emit("disconnected", reason)
		})
		await room.connect(this.url, this.jwt, {autoSubscribe: true, dynacast: false})
		if (this.closed) {
			try { await room.disconnect() } catch (e) {}
		}
	}

	/**
	 * @param {any} track
	 * @param {any} publication
	 * @param {any} participant
	 */
	_onSubscribed(track, publication, participant) {
		if (this.closed) return
		const rtc = this.rtc
		if (track.kind !== rtc.TrackKind.KIND_AUDIO) return
		const source = publication?.source ?? track.source
		if (source !== rtc.TrackSource.SOURCE_MICROPHONE) return
		const identity = participant.identity
		if (this.isOurs(identity)) return

		// A second microphone track for the same identity replaces the first one
		this._endIdentity(identity)
		const stream = new rtc.AudioStream(track, SAMPLE_RATE, CHANNELS)
		const reader = stream.getReader()
		const entry = {track, reader, rechunker: new Rechunker(), ended: false}
		this.entries.set(identity, entry)
		this.emit("trackStart", identity, mxidFromIdentity(identity))
		this._pump(identity, entry)
	}

	/**
	 * @param {any} track
	 * @param {any} participant
	 */
	_onUnsubscribed(track, participant) {
		const identity = participant.identity
		const entry = this.entries.get(identity)
		if (entry && entry.track === track) this._endEntry(identity, entry)
	}

	/**
	 * @param {string} identity
	 * @param {{track: any, reader: any, rechunker: Rechunker, ended: boolean}} entry
	 */
	async _pump(identity, entry) {
		try {
			for (;;) {
				const {done, value} = await entry.reader.read()
				if (done || entry.ended) break
				for (const chunk of entry.rechunker.push(value.data)) {
					this.emit("audio", identity, chunk)
				}
			}
		} catch (e) {
			// Stream errored or was cancelled. Ending the entry below covers both.
		} finally {
			this._endEntry(identity, entry)
		}
	}

	/**
	 * @param {string} identity
	 */
	_endIdentity(identity) {
		const entry = this.entries.get(identity)
		if (entry) this._endEntry(identity, entry)
	}

	_endAll() {
		for (const [identity, entry] of [...this.entries]) this._endEntry(identity, entry)
	}

	/**
	 * Cancels the stream and emits trackEnd. Safe to call repeatedly; trackEnd is emitted once.
	 * @param {string} identity
	 * @param {{track: any, reader: any, rechunker: Rechunker, ended: boolean}} entry
	 */
	_endEntry(identity, entry) {
		if (entry.ended) return
		entry.ended = true
		if (this.entries.get(identity) === entry) this.entries.delete(identity)
		try {
			Promise.resolve(entry.reader.cancel()).catch(() => {})
		} catch (e) {}
		this.emit("trackEnd", identity)
	}

	async close() {
		if (this.closed) return
		this.closed = true
		this._endAll()
		const room = this.room
		this.room = null
		if (room) {
			try { await room.disconnect() } catch (e) {}
		}
	}
}

module.exports = {Publisher, Listener, Rechunker, mxidFromIdentity}
