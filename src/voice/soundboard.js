// @ts-check

/*
	Soundboard support for the voice bridge: the wire format for LiveKit soundboard packets (the same packets Zam sends),
	decoding of Matrix sound files to PCM with ffmpeg, mixing of decoded sounds into a participant's output, and small helpers.

	Nothing here loads native modules. ffmpeg is a child process, and it is only started by decodeToPcm().
*/

/** LiveKit data topic that Zam uses for soundboard plays */
const SOUNDBOARD_TOPIC = "moe.crafty.soundboard"
/** Largest data packet that will be sent or accepted */
const MAX_PACKET_BYTES = 1024
/** Largest sound file that will be downloaded and decoded */
const MAX_SOUND_BYTES = 1024 * 1024
/** Longest sound that will be decoded, in seconds */
const MAX_SOUND_SECONDS = 15
/** How long ffmpeg may run before it is killed */
const FFMPEG_TIMEOUT_MS = 10_000
/** Sample rate of the decoded PCM and of the bridge's audio */
const SAMPLE_RATE = 48000
/** Mono samples in one 20 ms frame */
const FRAME_SAMPLES = 960
/** Zam's name field is the shortcode cut to this many characters */
const NAME_MAX_CHARS = 48
const MXC_PATTERN = /^mxc:\/\/[^/\s]+\/[^/\s]+$/
/** Discord soundboard sounds are cached under this URL, and the sound ID is the first capture group */
const DISCORD_SOUND_URL = /^https:\/\/cdn\.discordapp\.com\/soundboard-sounds\/(\d+)/

/**
 * Collaborators. Replace entries in tests.
 */
const _deps = {
	/** @type {(command: string, args: string[], options: any) => any} */
	spawn: (command, args, options) => require("child_process").spawn(command, args, options),
}

/**
 * @typedef {Object} SoundPacket
 * @property {string} url mxc URL of the sound file
 * @property {string} shortcode
 * @property {string} name
 */

/**
 * Makes the JSON payload of a soundboard data packet. Throws if it would be larger than 1024 bytes.
 * @param {{url: string, shortcode: string}} sound
 * @returns {Buffer}
 */
function encodeSoundboardPacket({url, shortcode}) {
	const name = Array.from(shortcode).slice(0, NAME_MAX_CHARS).join("")
	const bytes = Buffer.from(JSON.stringify({url, shortcode, v: 1, name}), "utf8")
	if (bytes.length > MAX_PACKET_BYTES) throw new Error(`soundboard packet is ${bytes.length} bytes, over the ${MAX_PACKET_BYTES} byte limit`)
	return bytes
}

/**
 * Parses a soundboard data packet defensively. Returns null for anything that isn't a usable play.
 * @param {Uint8Array} bytes
 * @returns {SoundPacket | null}
 */
function parseSoundboardPacket(bytes) {
	if (!bytes || bytes.byteLength > MAX_PACKET_BYTES) return null
	/** @type {any} */
	let parsed
	try {
		parsed = JSON.parse(new TextDecoder("utf-8", {fatal: true}).decode(bytes))
	} catch (e) {
		return null
	}
	if (!parsed || typeof parsed !== "object") return null
	if (typeof parsed.url !== "string" || !MXC_PATTERN.test(parsed.url)) return null
	const shortcode = typeof parsed.shortcode === "string" ? parsed.shortcode : ""
	const name = typeof parsed.name === "string" ? parsed.name : shortcode
	return {url: parsed.url, shortcode, name}
}

/**
 * Shortcode for a Discord soundboard sound. Same grammar as the first step of expression.js's soundShortcode:
 * trim, strip colons, whitespace to "_", drop characters outside [a-zA-Z0-9_-], max 100 characters, "sound" if empty.
 * @param {string} name
 * @returns {string}
 */
function shortcodeForName(name) {
	const base = name.trim().replace(/^:+|:+$/g, "").replace(/\s+/g, "_").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 100)
	return base || "sound"
}

/**
 * Converts a little-endian s16 byte buffer to samples. An odd trailing byte is dropped.
 * @param {Buffer} buffer
 * @returns {Int16Array}
 */
function bufferToInt16(buffer) {
	const out = new Int16Array(buffer.length >> 1)
	for (let i = 0; i < out.length; i++) out[i] = buffer.readInt16LE(i * 2)
	return out
}

/**
 * Decodes any audio file ffmpeg understands to 48 kHz mono s16 PCM, at most `maxSeconds` long.
 * Rejects with an error whose `code` is "FFMPEG_NOT_FOUND" when ffmpeg can't be started.
 * @param {Buffer} buffer the encoded sound file
 * @param {{maxSeconds?: number}} [options]
 * @returns {Promise<Int16Array>}
 */
function decodeToPcm(buffer, {maxSeconds = MAX_SOUND_SECONDS} = {}) {
	return new Promise((resolve, reject) => {
		const args = ["-hide_banner", "-loglevel", "error", "-i", "pipe:0", "-t", String(maxSeconds), "-f", "s16le", "-ac", "1", "-ar", String(SAMPLE_RATE), "pipe:1"]
		/** @type {any} */
		let child
		try {
			child = _deps.spawn("ffmpeg", args, {stdio: ["pipe", "pipe", "pipe"]})
		} catch (e) {
			reject(e)
			return
		}

		/** @type {Buffer[]} */
		const output = []
		/** @type {Buffer[]} */
		const errors = []
		let errorBytes = 0
		let settled = false
		const finish = (/** @type {Error | null} */ err, /** @type {Int16Array} */ value) => {
			if (settled) return
			settled = true
			clearTimeout(timer)
			if (err) reject(err)
			else resolve(value)
		}
		const timer = setTimeout(() => {
			try { child.kill() } catch (e) {}
			finish(new Error(`ffmpeg did not finish decoding within ${FFMPEG_TIMEOUT_MS} ms`), new Int16Array(0))
		}, FFMPEG_TIMEOUT_MS)

		child.stdout.on("data", (/** @type {Buffer} */ chunk) => output.push(chunk))
		child.stderr.on("data", (/** @type {Buffer} */ chunk) => {
			if (errorBytes < 4096) {
				errors.push(chunk)
				errorBytes += chunk.length
			}
		})
		// If ffmpeg stops reading early (for example after -t), writing to stdin fails. The exit code explains why.
		child.stdin.on("error", () => {})
		child.on("error", (/** @type {NodeJS.ErrnoException} */ e) => {
			if (e.code === "ENOENT") {
				const missing = /** @type {Error & {code?: string}} */ (new Error("ffmpeg was not found on PATH, so soundboard sounds can't be decoded"))
				missing.code = "FFMPEG_NOT_FOUND"
				finish(missing, new Int16Array(0))
			} else {
				finish(e, new Int16Array(0))
			}
		})
		child.on("close", (/** @type {number | null} */ code) => {
			if (code === 0) {
				finish(null, bufferToInt16(Buffer.concat(output)))
			} else {
				const stderr = Buffer.concat(errors).toString("utf8").trim()
				finish(new Error(`ffmpeg exited with code ${code}${stderr ? `: ${stderr}` : ""}`), new Int16Array(0))
			}
		})
		child.stdin.end(buffer)
	})
}

/**
 * Queue of decoded sounds that are mixed into one output. Each clip is played once from start to end.
 */
class SoundClips {
	constructor() {
		/** @type {{samples: Int16Array, offset: number}[]} */
		this.clips = []
	}

	/**
	 * @param {Int16Array} samples mono 48 kHz
	 */
	add(samples) {
		if (samples.length > 0) this.clips.push({samples, offset: 0})
	}

	/** @returns {boolean} true while any clip is still playing */
	get active() {
		return this.clips.length > 0
	}

	clear() {
		this.clips = []
	}

	/**
	 * The next `n` samples of all clips mixed together. Clips that run out are removed.
	 * @param {number} n
	 * @returns {Int16Array | null} null when no clip is playing
	 */
	read(n) {
		if (this.clips.length === 0) return null
		/** @type {Int16Array[]} */
		const pieces = []
		for (const clip of this.clips) {
			const take = Math.min(n, clip.samples.length - clip.offset)
			pieces.push(clip.samples.subarray(clip.offset, clip.offset + take))
			clip.offset += take
		}
		this.clips = this.clips.filter(clip => clip.offset < clip.samples.length)
		return mixClipFrames(pieces, n)
	}
}

/**
 * Sums clip pieces with clipping to int16. Shorter pieces are zero-padded.
 * @param {Int16Array[]} pieces
 * @param {number} n
 * @returns {Int16Array}
 */
function mixClipFrames(pieces, n) {
	const sum = new Int32Array(n)
	for (const piece of pieces) {
		for (let i = 0; i < piece.length; i++) sum[i] += piece[i]
	}
	const out = new Int16Array(n)
	for (let i = 0; i < n; i++) out[i] = Math.max(-32768, Math.min(32767, sum[i]))
	return out
}

/**
 * Small least-recently-used cache.
 * @template V
 */
class LruCache {
	/** @param {number} limit */
	constructor(limit) {
		this.limit = limit
		/** @type {Map<string, V>} */
		this.map = new Map()
	}

	/**
	 * @param {string} key
	 * @returns {V | undefined}
	 */
	get(key) {
		if (!this.map.has(key)) return undefined
		const value = /** @type {V} */ (this.map.get(key))
		this.map.delete(key)
		this.map.set(key, value)
		return value
	}

	/**
	 * @param {string} key
	 * @param {V} value
	 */
	set(key, value) {
		this.map.delete(key)
		this.map.set(key, value)
		while (this.map.size > this.limit) {
			const oldest = this.map.keys().next().value
			if (oldest === undefined) break
			this.map.delete(oldest)
		}
	}

	clear() {
		this.map.clear()
	}

	get size() {
		return this.map.size
	}
}

module.exports = {
	SOUNDBOARD_TOPIC,
	MAX_PACKET_BYTES,
	MAX_SOUND_BYTES,
	MAX_SOUND_SECONDS,
	SAMPLE_RATE,
	FRAME_SAMPLES,
	DISCORD_SOUND_URL,
	encodeSoundboardPacket,
	parseSoundboardPacket,
	shortcodeForName,
	decodeToPcm,
	SoundClips,
	LruCache,
	_deps,
}
