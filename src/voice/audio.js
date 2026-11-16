// @ts-check
// Pure audio helpers for the voice bridge. No native modules are loaded at
// require time; opusscript is only required inside createOpusDecoder().

const {Readable} = require("stream")

const FRAME_MS = 20
const SAMPLE_RATE = 48000
/** Mono samples in one 20 ms frame (960). */
const MONO_FRAME_SAMPLES = SAMPLE_RATE * FRAME_MS / 1000
/** Bytes in one 20 ms stereo s16le frame (960 samples x 2 channels x 2 bytes). */
const STEREO_FRAME_BYTES = 3840

/**
 * Stops LivePcmStream from bursting frames to catch up after a long event
 * loop stall: if a tick is more than this many frames late, the timeline is
 * shifted forward instead.
 */
const MAX_LATE_FRAMES = 5

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
 * - push() drops the oldest samples once more than `maxMs` are buffered.
 * - Priming: after construction and after every underrun the buffer does not
 *   emit audio until `primeMs` have accumulated; read() returns silence in the
 *   meantime without consuming samples. This trades ~one prime of latency for
 *   not stuttering on every packet gap.
 * - read(n) always returns exactly n samples, zero-filled on underrun.
 */
class JitterBuffer {
	/** @type {number} */
	#capacity
	/** @type {number} */
	#primeSamples
	/** @type {Int16Array} */
	#buf
	#head = 0
	#length = 0
	#primed = false

	/**
	 * @param {{maxMs?: number, primeMs?: number}} [options]
	 */
	constructor({maxMs = 200, primeMs = 40} = {}) {
		this.#capacity = msToSamples(maxMs)
		this.#primeSamples = msToSamples(primeMs)
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
			input = input.subarray(input.length - this.#capacity)
		}
		const overflow = this.#length + input.length - this.#capacity
		if (overflow > 0) {
			this.#head = (this.#head + overflow) % this.#capacity
			this.#length -= overflow
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
		const take = Math.min(n, this.#length)
		for (let i = 0; i < take; i++) {
			out[i] = this.#buf[(this.#head + i) % this.#capacity]
		}
		this.#head = (this.#head + take) % this.#capacity
		this.#length -= take
		if (take < n) this.#primed = false // underrun: re-prime before emitting again
		return out
	}
}

/**
 * Readable (non-object mode) that emits one 3840-byte stereo s16le frame every
 * 20 ms, pulled from a callback. Designed for @discordjs/voice's
 * StreamType.Raw, which reads every 20 ms and gives up after 5 missed frames.
 *
 * - The timer starts on the first _read() and is aligned to a wall-clock
 *   timeline (each tick is scheduled against start + index * 20 ms), so it
 *   does not drift.
 * - If pull() returns null, a frame of silence is emitted.
 * - When push() returns false the stream pauses producing; the next _read()
 *   resumes it with a fresh timeline.
 * - stop() clears the timer and ends the stream.
 */
class LivePcmStream extends Readable {
	/** @type {() => Buffer | null} */
	#pull
	/** @type {ReturnType<typeof setTimeout> | null} */
	#timer = null
	#anchor = 0
	#index = 0
	#started = false
	#paused = false
	#stopped = false

	/**
	 * @param {() => Buffer | null} pull returns the next 3840-byte stereo frame, or null for silence
	 */
	constructor(pull) {
		// Keep only a few frames buffered ahead of the consumer.
		super({highWaterMark: STEREO_FRAME_BYTES * 4})
		this.#pull = pull
	}

	_read() {
		if (this.#stopped) return
		// Already producing: nothing to do.
		if (this.#started && !this.#paused) return
		this.#started = true
		this.#paused = false
		this.#anchor = Date.now()
		this.#index = 0
		this.#schedule()
	}

	/** @param {Error | null} err @param {(err?: Error | null) => void} callback */
	_destroy(err, callback) {
		this.#halt()
		callback(err)
	}

	/**
	 * Ends the stream: cancels the timer and pushes EOF.
	 */
	stop() {
		if (this.#stopped) return
		this.#halt()
		this.push(null)
	}

	#halt() {
		this.#stopped = true
		if (this.#timer) clearTimeout(this.#timer)
		this.#timer = null
	}

	#schedule() {
		if (this.#timer) clearTimeout(this.#timer)
		const due = this.#anchor + this.#index * FRAME_MS
		const delay = Math.max(0, due - Date.now())
		this.#timer = setTimeout(() => this.#tick(), delay)
	}

	#tick() {
		this.#timer = null
		if (this.#stopped) return

		const due = this.#anchor + this.#index * FRAME_MS
		const lateBy = Date.now() - due
		if (lateBy > MAX_LATE_FRAMES * FRAME_MS) this.#anchor += lateBy

		/** @type {Buffer} */
		let frame
		try {
			frame = this.#nextFrame()
		} catch (err) {
			this.#halt()
			this.destroy(/** @type {Error} */ (err))
			return
		}

		this.#index++
		if (this.push(frame)) {
			this.#schedule()
		} else {
			this.#paused = true
		}
	}

	/** @returns {Buffer} */
	#nextFrame() {
		const data = this.#pull()
		const frame = Buffer.alloc(STEREO_FRAME_BYTES)
		if (data) data.copy(frame, 0, 0, Math.min(data.length, STEREO_FRAME_BYTES))
		return frame
	}
}

module.exports = {
	FRAME_MS,
	SAMPLE_RATE,
	STEREO_FRAME_BYTES,
	createOpusDecoder,
	stereoToMono,
	monoToStereo,
	mixMono,
	JitterBuffer,
	LivePcmStream,
}
