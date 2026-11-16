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
 * Readable (non-object mode) that produces one 3840-byte stereo s16le frame per read, pulled from a callback.
 * Designed for @discordjs/voice's StreamType.Raw.
 *
 * Production is demand-driven and has no timer. The voice library pipes this stream into an Opus encoder, and the
 * player reads one packet every 20 ms from that encoder, so backpressure makes this stream produce exactly as fast as
 * the player consumes. A timer tied to wall-clock time would underrun on ordinary jitter, and the player goes Idle
 * for good after a few missed frames.
 *
 * - _read() pushes frames synchronously until push() returns false, so at most highWaterMark bytes are ever produced ahead.
 * - If pull() returns null, a frame of silence is emitted.
 * - If pull() throws, the stream is destroyed with that error.
 * - stop() ends the stream (push(null)) and stops producing.
 */
class LivePcmStream extends Readable {
	/** @type {() => Buffer | null} */
	#pull
	#stopped = false

	/**
	 * @param {() => Buffer | null} pull returns the next 3840-byte stereo frame, or null for silence. Must not block.
	 */
	constructor(pull) {
		// Keep only a few frames buffered ahead of the consumer.
		super({highWaterMark: STEREO_FRAME_BYTES * 4})
		this.#pull = pull
	}

	_read() {
		try {
			while (!this.#stopped && this.push(this.#nextFrame())) {
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
		callback(err)
	}

	/**
	 * Ends the stream. Frames already buffered are still delivered, then EOF.
	 */
	stop() {
		if (this.#stopped) return
		this.#stopped = true
		this.push(null)
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
