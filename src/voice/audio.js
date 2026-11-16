// @ts-check
// Pure audio helpers for the voice bridge. No native modules are loaded at
// require time; opusscript is only required inside createOpusDecoder() and createOpusEncoder().

const {Readable} = require("stream")

const FRAME_MS = 20
const SAMPLE_RATE = 48000
/** Mono samples in one 20 ms frame (960). */
const MONO_FRAME_SAMPLES = SAMPLE_RATE * FRAME_MS / 1000
/** Bytes in one 20 ms stereo s16le frame (960 samples x 2 channels x 2 bytes). */
const STEREO_FRAME_BYTES = 3840

/**
 * @param {number} ms
 * @returns {number}
 */
const msToSamples = ms => Math.round(ms * SAMPLE_RATE / 1000)

/**
 * Creates a stateful Opus decoder for Discord voice packets (48 kHz stereo).
 * @returns {{decode: (opusPacket: Buffer) => Buffer}} decode() returns 48 kHz stereo s16le PCM (3840 bytes per 20 ms packet)
 */
const createOpusDecoder = () => {
	const OpusScript = require("opusscript")
	const decoder = new OpusScript(SAMPLE_RATE, 2, OpusScript.Application.VOIP)
	return {
		/** @param {Buffer} opusPacket */
		decode(opusPacket) {
			return decoder.decode(opusPacket)
		},
	}
}

/**
 * @typedef {Object} OpusEncoder
 * @property {(pcm: Buffer) => Buffer} encode one 20 ms stereo frame (3840 bytes) to one Opus packet
 * @property {() => void} delete frees the native encoder. Call once, after the last encode().
 */

/**
 * Creates a stateful Opus encoder for 48 kHz stereo music-quality audio. Each encode() takes one 20 ms frame.
 * @returns {OpusEncoder}
 */
const createOpusEncoder = () => {
	const OpusScript = require("opusscript")
	const encoder = new OpusScript(SAMPLE_RATE, 2, OpusScript.Application.AUDIO)
	return {
		/** @param {Buffer} pcm */
		encode(pcm) {
			return encoder.encode(pcm, MONO_FRAME_SAMPLES)
		},
		delete() {
			encoder.delete()
		},
	}
}

/**
 * Downmixes 48 kHz stereo s16le PCM to mono by averaging L and R.
 * @param {Buffer} pcm
 * @returns {Int16Array}
 */
const stereoToMono = pcm => {
	const frames = pcm.length >> 2
	const mono = new Int16Array(frames)
	for (let i = 0; i < frames; i++) {
		const left = pcm.readInt16LE(i * 4)
		const right = pcm.readInt16LE(i * 4 + 2)
		mono[i] = (left + right) >> 1
	}
	return mono
}

/**
 * Upmixes mono samples to stereo s16le PCM by duplicating each sample.
 * @param {Int16Array} mono
 * @returns {Buffer}
 */
const monoToStereo = mono => {
	const out = Buffer.alloc(mono.length * 4)
	for (let i = 0; i < mono.length; i++) {
		out.writeInt16LE(mono[i], i * 4)
		out.writeInt16LE(mono[i], i * 4 + 2)
	}
	return out
}

/**
 * Sums equal-length mono frames with clipping to int16. Frames shorter than
 * `length` are treated as zero-padded. An empty list yields silence.
 * @param {Int16Array[]} frames
 * @param {number} length
 * @returns {Int16Array}
 */
const mixMono = (frames, length) => {
	const sum = new Int32Array(length)
	for (const frame of frames) {
		const n = Math.min(length, frame.length)
		for (let i = 0; i < n; i++) sum[i] += frame[i]
	}
	const out = new Int16Array(length)
	for (let i = 0; i < length; i++) {
		out[i] = Math.max(-32768, Math.min(32767, sum[i]))
	}
	return out
}

/**
 * Bounded ring buffer of mono Int16 samples at 48 kHz, used to smooth out
 * network jitter between a Matrix participant's audio and the bridge output.
 *
 * - Priming: the buffer does not emit audio until `primeMs` have accumulated, once at the start of a talk spurt.
 *   Until then read() returns silence without consuming samples.
 * - Brief gaps: once primed, a read that finds fewer samples than asked for returns what is there, zero-filled after
 *   that, and stays primed. Frames arrive unevenly, so this is the normal case and must not stutter.
 * - Re-priming: after `reprimeAfterMs` of consecutive reads that found the buffer empty, the speaker has stopped. The
 *   buffer goes back to the unprimed state and waits for `primeMs` again.
 * - Hard cap: push() drops the oldest samples once more than `maxMs` are buffered.
 * - Soft cap: when a read finds more than `targetMaxMs` buffered (clock drift built up delay), the oldest samples are
 *   dropped down to `primeMs` before the read, so delay can't accumulate.
 * - read(n) always returns exactly n samples, zero-filled where the buffer ran dry.
 * - stats() counts underrun reads and dropped samples since the last reset().
 */
class JitterBuffer {
	/** @type {number} */
	#capacity
	/** @type {number} */
	#primeSamples
	/** @type {number} */
	#targetSamples
	/** @type {number} */
	#reprimeSamples
	/** @type {Int16Array} */
	#buf
	#head = 0
	#length = 0
	#primed = false
	/** Samples in a row, from reads that found the buffer empty */
	#starvedSamples = 0
	#underrunReads = 0
	#droppedSamples = 0

	/**
	 * @param {{maxMs?: number, primeMs?: number, targetMaxMs?: number, reprimeAfterMs?: number}} [options]
	 */
	constructor({maxMs = 200, primeMs = 40, targetMaxMs = 100, reprimeAfterMs = 200} = {}) {
		this.#capacity = msToSamples(maxMs)
		this.#primeSamples = msToSamples(primeMs)
		this.#targetSamples = msToSamples(targetMaxMs)
		this.#reprimeSamples = msToSamples(reprimeAfterMs)
		this.#buf = new Int16Array(this.#capacity)
	}

	/** Milliseconds of audio currently buffered. */
	get bufferedMs() {
		return this.#length * 1000 / SAMPLE_RATE
	}

	/**
	 * @param {Int16Array} samples
	 */
	push(samples) {
		let input = samples
		if (input.length > this.#capacity) {
			this.#droppedSamples += input.length - this.#capacity
			input = input.subarray(input.length - this.#capacity)
		}
		const overflow = this.#length + input.length - this.#capacity
		if (overflow > 0) {
			this.#head = (this.#head + overflow) % this.#capacity
			this.#length -= overflow
			this.#droppedSamples += overflow
		}
		for (let i = 0; i < input.length; i++) {
			this.#buf[(this.#head + this.#length + i) % this.#capacity] = input[i]
		}
		this.#length += input.length
	}

	/**
	 * @param {number} n number of samples wanted
	 * @returns {Int16Array} exactly n samples, zero-filled where the buffer ran dry
	 */
	read(n) {
		const out = new Int16Array(n)
		if (!this.#primed) {
			if (this.#length < this.#primeSamples) return out
			this.#primed = true
		}
		if (this.#length > this.#targetSamples) {
			const excess = this.#length - this.#primeSamples
			this.#head = (this.#head + excess) % this.#capacity
			this.#length = this.#primeSamples
			this.#droppedSamples += excess
		}
		const take = Math.min(n, this.#length)
		for (let i = 0; i < take; i++) {
			out[i] = this.#buf[(this.#head + i) % this.#capacity]
		}
		this.#head = (this.#head + take) % this.#capacity
		this.#length -= take

		if (take < n) this.#underrunReads++
		if (take === 0) {
			this.#starvedSamples += n
			if (this.#starvedSamples >= this.#reprimeSamples) {
				this.#primed = false // the speaker has stopped: wait for a full prime before playing again
				this.#starvedSamples = 0
			}
		} else {
			this.#starvedSamples = 0
		}
		return out
	}

	/**
	 * @returns {{underrunReads: number, droppedSamples: number}} counts since the last reset()
	 */
	stats() {
		return {underrunReads: this.#underrunReads, droppedSamples: this.#droppedSamples}
	}

	reset() {
		this.#underrunReads = 0
		this.#droppedSamples = 0
	}
}

/**
 * Readable in object mode that produces one Opus packet per read. Each packet is one 20 ms frame pulled from a
 * callback and encoded here. Designed for @discordjs/voice's StreamType.Opus, which plays the packets as they are, with
 * no encoder in between that would hold frames back.
 *
 * Production is demand-driven and has no timer. The player reads one packet every 20 ms, so backpressure makes this
 * stream produce exactly as fast as the player consumes. A timer tied to wall-clock time would underrun on ordinary jitter,
 * and the player goes Idle for good after a few missed frames.
 *
 * - highWaterMark is 2 packets, so at most two packets (40 ms) are ever produced ahead of the player.
 * - _read() pushes packets synchronously until push() returns false.
 * - If pull() returns null, a frame of silence is encoded and sent.
 * - If pull() or the encoder throws, the stream is destroyed with that error.
 * - stop() ends the stream (push(null)) and stops producing. Destroying the stream frees the encoder.
 */
class LiveOpusStream extends Readable {
	/** @type {() => Buffer | null} */
	#pull
	/** @type {OpusEncoder} */
	#encoder
	#stopped = false

	/**
	 * @param {() => Buffer | null} pull returns the next 3840-byte stereo frame, or null for silence. Must not block.
	 */
	constructor(pull) {
		super({objectMode: true, highWaterMark: 2})
		this.#pull = pull
		this.#encoder = createOpusEncoder()
	}

	_read() {
		try {
			while (!this.#stopped && this.push(this.#nextPacket())) {
				// Keep producing until the buffer is at its high-water mark
			}
		} catch (err) {
			this.#stopped = true
			this.destroy(/** @type {Error} */ (err))
		}
	}

	/** @param {Error | null} err @param {(err?: Error | null) => void} callback */
	_destroy(err, callback) {
		this.#stopped = true
		try {
			this.#encoder.delete()
		} catch (e) {
			// Already freed, or never fully created: nothing else to release
		}
		callback(err)
	}

	/**
	 * Ends the stream. Packets already buffered are still delivered, then EOF.
	 */
	stop() {
		if (this.#stopped) return
		this.#stopped = true
		this.push(null)
	}

	/** @returns {Buffer} */
	#nextPacket() {
		const data = this.#pull()
		const frame = Buffer.alloc(STEREO_FRAME_BYTES)
		if (data) data.copy(frame, 0, 0, Math.min(data.length, STEREO_FRAME_BYTES))
		return this.#encoder.encode(frame)
	}
}

module.exports = {
	FRAME_MS,
	SAMPLE_RATE,
	STEREO_FRAME_BYTES,
	createOpusDecoder,
	createOpusEncoder,
	stereoToMono,
	monoToStereo,
	mixMono,
	JitterBuffer,
	LiveOpusStream,
}
