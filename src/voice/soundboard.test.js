// @ts-check

const {test} = require("supertape")
const {EventEmitter} = require("events")
const {spawnSync} = require("child_process")
const soundboard = require("./soundboard")

/**
 * A fake ffmpeg child process. Tests push output and exit codes through its events.
 * @returns {any}
 */
function fakeChild() {
	const stdin = Object.assign(new EventEmitter(), {
		/** @type {Buffer[]} */
		written: /** @type {Buffer[]} */ ([]),
		/** @param {Buffer} data */
		end(data) {
			this.written.push(data)
		},
	})
	return Object.assign(new EventEmitter(), {
		stdin,
		stdout: new EventEmitter(),
		stderr: new EventEmitter(),
		killed: false,
		kill() {
			this.killed = true
		},
	})
}

/**
 * Runs `fn` with the spawn collaborator replaced.
 * @param {any} child
 * @param {(calls: any[]) => Promise<void>} fn
 */
async function withSpawn(child, fn) {
	/** @type {any[]} */
	const calls = []
	const saved = soundboard._deps.spawn
	soundboard._deps.spawn = (command, args, options) => {
		calls.push({command, args, options})
		return child
	}
	try {
		await fn(calls)
	} finally {
		soundboard._deps.spawn = saved
	}
}

/**
 * A 16-bit mono 48 kHz WAV file holding the given samples.
 * @param {Int16Array} samples
 */
function makeWav(samples) {
	const data = Buffer.alloc(samples.length * 2)
	for (let i = 0; i < samples.length; i++) data.writeInt16LE(samples[i], i * 2)
	const header = Buffer.alloc(44)
	header.write("RIFF", 0)
	header.writeUInt32LE(36 + data.length, 4)
	header.write("WAVE", 8)
	header.write("fmt ", 12)
	header.writeUInt32LE(16, 16)
	header.writeUInt16LE(1, 20) // PCM
	header.writeUInt16LE(1, 22) // mono
	header.writeUInt32LE(48000, 24)
	header.writeUInt32LE(96000, 28)
	header.writeUInt16LE(2, 32)
	header.writeUInt16LE(16, 34)
	header.write("data", 36)
	header.writeUInt32LE(data.length, 40)
	return Buffer.concat([header, data])
}

const ffmpegOnPath = (() => {
	try {
		return spawnSync("ffmpeg", ["-version"]).status === 0
	} catch (e) {
		return false
	}
})()

test("decodeToPcm: sends the file to ffmpeg on stdin and reads 48 kHz mono s16le from stdout", async t => {
	const child = fakeChild()
	await withSpawn(child, async calls => {
		const promise = soundboard.decodeToPcm(Buffer.from("encoded sound"), {maxSeconds: 7})
		child.stdout.emit("data", Buffer.from([1, 0, 255, 127]))
		child.emit("close", 0)
		const samples = await promise

		t.equal(calls.length, 1)
		t.equal(calls[0].command, "ffmpeg")
		const args = calls[0].args
		t.deepEqual(args.slice(args.indexOf("-t"), args.indexOf("-t") + 2), ["-t", "7"], "maxSeconds limits the length")
		t.deepEqual(args.slice(args.indexOf("-f"), args.indexOf("-f") + 2), ["-f", "s16le"])
		t.deepEqual(args.slice(args.indexOf("-ac"), args.indexOf("-ac") + 2), ["-ac", "1"])
		t.deepEqual(args.slice(args.indexOf("-ar"), args.indexOf("-ar") + 2), ["-ar", "48000"])
		t.equal(args[args.indexOf("-i") + 1], "pipe:0")
		t.equal(args[args.length - 1], "pipe:1")
		t.equal(child.stdin.written[0].toString(), "encoded sound")
		t.deepEqual(Array.from(samples), [1, 32767])
	})
	t.end()
})

test("decodeToPcm: a missing ffmpeg rejects with the FFMPEG_NOT_FOUND code", async t => {
	const child = fakeChild()
	await withSpawn(child, async () => {
		const promise = soundboard.decodeToPcm(Buffer.from("x")).catch(e => e)
		child.emit("error", Object.assign(new Error("spawn ffmpeg ENOENT"), {code: "ENOENT"}))
		const error = await promise
		t.equal(error.code, "FFMPEG_NOT_FOUND")
	})
	t.end()
})

test("decodeToPcm: a non-zero exit rejects with ffmpeg's own message", async t => {
	const child = fakeChild()
	await withSpawn(child, async () => {
		const promise = soundboard.decodeToPcm(Buffer.from("x")).catch(e => e)
		child.stderr.emit("data", Buffer.from("Invalid data found"))
		child.emit("close", 1)
		const error = await promise
		t.ok(error instanceof Error)
		t.ok(error.message.includes("code 1"))
		t.ok(error.message.includes("Invalid data found"))
	})
	t.end()
})

test("decodeToPcm: a spawn that throws synchronously rejects", async t => {
	const saved = soundboard._deps.spawn
	soundboard._deps.spawn = () => {
		throw new Error("spawn exploded")
	}
	try {
		const error = await soundboard.decodeToPcm(Buffer.from("x")).catch(e => e)
		t.equal(error.message, "spawn exploded")
	} finally {
		soundboard._deps.spawn = saved
	}
	t.end()
})

test("decodeToPcm: real ffmpeg decodes a WAV and stops at maxSeconds (skipped without ffmpeg on PATH)", async t => {
	if (!ffmpegOnPath) {
		t.pass("ffmpeg is not on PATH, so the real decode check is skipped")
		t.end()
		return
	}
	const samples = new Int16Array(96000).fill(1000) // 2 seconds
	const pcm = await soundboard.decodeToPcm(makeWav(samples), {maxSeconds: 1})
	t.ok(Math.abs(pcm.length - 48000) < 480, `one second of audio, got ${pcm.length} samples`)
	t.ok(Math.abs(pcm[1000] - 1000) < 50, "the level survives decoding")
	t.end()
})

test("SoundClips: nothing to read when empty", t => {
	const clips = new soundboard.SoundClips()
	t.equal(clips.read(960), null)
	t.equal(clips.active, false)
	t.end()
})

test("SoundClips: mixes overlapping clips, and removes each clip once it has played", t => {
	const clips = new soundboard.SoundClips()
	clips.add(new Int16Array(1000).fill(100))
	clips.add(new Int16Array(500).fill(200))
	const first = clips.read(960)
	t.ok(first)
	t.equal(first[0], 300, "both clips sound together")
	t.equal(first[499], 300)
	t.equal(first[500], 100, "only the long clip after the short one ends")
	t.equal(first[959], 100)
	t.equal(clips.active, true)

	const second = clips.read(960)
	t.ok(second)
	t.equal(second[39], 100, "the last 40 samples of the long clip")
	t.equal(second[40], 0, "zero after it ends")
	t.equal(clips.active, false, "finished clips are removed")
	t.equal(clips.read(960), null)
	t.end()
})

test("SoundClips: a clip shorter than a frame is zero-padded and clipping is limited to int16", t => {
	const clips = new soundboard.SoundClips()
	clips.add(new Int16Array(10).fill(30000))
	clips.add(new Int16Array(960).fill(30000))
	const frame = clips.read(960)
	t.ok(frame)
	t.equal(frame[0], 32767, "loud overlap clips at the int16 maximum")
	t.equal(frame[10], 30000, "after the short clip, only the long one plays")
	t.end()
})

test("encodeSoundboardPacket: the packet has Zam's keys in order and a name cut to 48 characters", t => {
	const bytes = soundboard.encodeSoundboardPacket({url: "mxc://cadence.moe/abc", shortcode: "air_horn"})
	t.equal(Buffer.from(bytes).toString(), `{"url":"mxc://cadence.moe/abc","shortcode":"air_horn","v":1,"name":"air_horn"}`)

	const long = soundboard.encodeSoundboardPacket({url: "mxc://cadence.moe/abc", shortcode: "a".repeat(100)})
	t.equal(JSON.parse(Buffer.from(long).toString()).name.length, 48)
	t.equal(JSON.parse(Buffer.from(long).toString()).shortcode.length, 100)
	t.end()
})

test("encodeSoundboardPacket: a packet over 1024 bytes is refused", t => {
	let error = null
	try {
		soundboard.encodeSoundboardPacket({url: "mxc://cadence.moe/abc", shortcode: "é".repeat(600)})
	} catch (e) {
		error = e
	}
	t.ok(error instanceof Error && error.message.includes("1024 byte limit"))
	t.end()
})

test("parseSoundboardPacket: reads a valid packet", t => {
	const bytes = Buffer.from(`{"url":"mxc://cadence.moe/abc","shortcode":"air_horn","v":1,"name":"Air horn"}`)
	t.deepEqual(soundboard.parseSoundboardPacket(bytes), {url: "mxc://cadence.moe/abc", shortcode: "air_horn", name: "Air horn"})
	const noName = Buffer.from(`{"url":"mxc://cadence.moe/abc","shortcode":"air_horn"}`)
	t.deepEqual(soundboard.parseSoundboardPacket(noName), {url: "mxc://cadence.moe/abc", shortcode: "air_horn", name: "air_horn"}, "name falls back to the shortcode")
	t.end()
})

test("parseSoundboardPacket: rejects anything that is not a usable play", t => {
	const bad = [
		"not json",
		`["mxc://cadence.moe/abc"]`,
		`42`,
		`{"shortcode":"air_horn"}`,
		`{"url":"https://cdn.discordapp.com/x/y","shortcode":"a"}`,
		`{"url":"mxc://cadence.moe/a b","shortcode":"a"}`,
		`{"url":"mxc://cadence.moe/a/b","shortcode":"a"}`,
		`{"url":"mxc://cadence.moe/abc","shortcode":"a","pad":"${"x".repeat(1000)}"}`,
	]
	for (const text of bad) {
		t.equal(soundboard.parseSoundboardPacket(Buffer.from(text)), null, text.slice(0, 40))
	}
	t.equal(soundboard.parseSoundboardPacket(Buffer.from([0xff, 0xfe, 0x00])), null, "invalid UTF-8 is rejected")
	t.end()
})

test("shortcodeForName: follows the sound shortcode grammar", t => {
	t.equal(soundboard.shortcodeForName("  :Air Horn!: "), "Air_Horn")
	t.equal(soundboard.shortcodeForName("!!!"), "sound")
	t.equal(soundboard.shortcodeForName(""), "sound")
	t.equal(soundboard.shortcodeForName("a".repeat(150)).length, 100)
	t.end()
})

test("LruCache: evicts the least recently used entry", t => {
	const cache = new soundboard.LruCache(2)
	cache.set("a", 1)
	cache.set("b", 2)
	t.equal(cache.get("a"), 1, "reading a makes it the most recent")
	cache.set("c", 3)
	t.equal(cache.get("b"), undefined, "b was the least recently used")
	t.equal(cache.get("a"), 1)
	t.equal(cache.get("c"), 3)
	t.equal(cache.size, 2)
	cache.clear()
	t.equal(cache.size, 0)
	t.end()
})
