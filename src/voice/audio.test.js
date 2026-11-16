// @ts-check
const {test} = require("supertape")
const {
	STEREO_FRAME_BYTES,
	createOpusDecoder,
	stereoToMono,
	monoToStereo,
	mixMono,
	JitterBuffer,
	LivePcmStream,
} = require("./audio")

test("audio: stereo -> mono -> stereo round-trips identical mono samples", t => {
	const mono = Int16Array.from([0, 1000, -1000, 32767, -32768])
	const stereo = monoToStereo(mono)
	t.equal(stereo.length, mono.length * 4)
	t.deepEqual(Array.from(stereoToMono(stereo)), Array.from(mono))
})

test("audio: stereoToMono averages left and right", t => {
	const pcm = Buffer.alloc(8)
	pcm.writeInt16LE(100, 0)
	pcm.writeInt16LE(300, 2)
	pcm.writeInt16LE(-100, 4)
	pcm.writeInt16LE(-300, 6)
	t.deepEqual(Array.from(stereoToMono(pcm)), [200, -200])
})

test("audio: monoToStereo duplicates each sample into both channels", t => {
	const stereo = monoToStereo(Int16Array.from([5, -7]))
	t.equal(stereo.readInt16LE(0), 5)
	t.equal(stereo.readInt16LE(2), 5)
	t.equal(stereo.readInt16LE(4), -7)
	t.equal(stereo.readInt16LE(6), -7)
})

test("audio: mixMono sums frames", t => {
	const out = mixMono([Int16Array.from([1000, -500]), Int16Array.from([2000, -500])], 2)
	t.deepEqual(Array.from(out), [3000, -1000])
})

test("audio: mixMono clips positive overflow to int16 max", t => {
	const out = mixMono([Int16Array.from([30000]), Int16Array.from([30000])], 1)
	t.equal(out[0], 32767)
})

test("audio: mixMono clips negative overflow to int16 min", t => {
	const out = mixMono([Int16Array.from([-30000]), Int16Array.from([-30000])], 1)
	t.equal(out[0], -32768)
})

test("audio: mixMono of zero frames is silence of the given length", t => {
	const out = mixMono([], 5)
	t.equal(out.length, 5)
	t.ok(out.every(s => s === 0))
})

test("audio: JitterBuffer primes before emitting, then emits exact-length reads", t => {
	const jb = new JitterBuffer()
	jb.push(new Int16Array(960).fill(7))
	t.equal(jb.bufferedMs, 20)
	// Under the 40 ms prime target: silence, nothing consumed.
	const early = jb.read(960)
	t.equal(early.length, 960)
	t.ok(early.every(s => s === 0))
	t.equal(jb.bufferedMs, 20)

	jb.push(new Int16Array(960).fill(7))
	t.equal(jb.bufferedMs, 40)
	const out = jb.read(960)
	t.equal(out.length, 960)
	t.ok(out.every(s => s === 7))
	t.equal(jb.bufferedMs, 20)
})

test("audio: JitterBuffer zero-fills on underrun and re-primes", t => {
	const jb = new JitterBuffer()
	jb.push(new Int16Array(1920).fill(3))
	t.ok(jb.read(960).every(s => s === 3))
	// Only 960 left, asking for 1920: 960 real samples then zeros.
	const partial = jb.read(1920)
	t.equal(partial.length, 1920)
	t.ok(partial.subarray(0, 960).every(s => s === 3))
	t.ok(partial.subarray(960).every(s => s === 0))
	t.equal(jb.bufferedMs, 0)
	// Re-primed after the underrun: next read is silence until 40 ms again.
	jb.push(new Int16Array(960).fill(9))
	t.ok(jb.read(960).every(s => s === 0))
})

test("audio: JitterBuffer drops oldest samples beyond 200 ms", t => {
	const jb = new JitterBuffer({primeMs: 0})
	const total = 14400 // 300 ms
	const ramp = new Int16Array(total)
	for (let i = 0; i < total; i++) ramp[i] = i
	jb.push(ramp)
	t.equal(jb.bufferedMs, 200)
	const out = jb.read(960)
	t.equal(out[0], total - 9600)
	t.equal(out[959], total - 9600 + 959)
})

test("audio: createOpusDecoder decodes an Opus packet produced by OpusScript's encoder", t => {
	const OpusScript = require("opusscript")
	const encoder = new OpusScript(48000, 2, OpusScript.Application.VOIP)
	const pcm = Buffer.alloc(STEREO_FRAME_BYTES)
	for (let i = 0; i < 960; i++) {
		const sample = Math.round(8000 * Math.sin(2 * Math.PI * 440 * i / 48000))
		pcm.writeInt16LE(sample, i * 4)
		pcm.writeInt16LE(sample, i * 4 + 2)
	}
	const packet = encoder.encode(pcm, 960)
	encoder.delete()

	const decoder = createOpusDecoder()
	const decoded = decoder.decode(packet)
	t.equal(decoded.length, STEREO_FRAME_BYTES)
	t.ok(decoded.some(b => b !== 0), "decoded audio is not silence")
})

test("audio: LivePcmStream emits 3840-byte frames on every read", async t => {
	let n = 0
	const stream = new LivePcmStream(() => (n++ < 2 ? Buffer.alloc(STEREO_FRAME_BYTES, 1) : null))
	/** @type {Buffer[]} */
	const chunks = []
	await new Promise((resolve, reject) => {
		const failsafe = setTimeout(() => {
			stream.stop()
			reject(new Error("LivePcmStream produced too few frames"))
		}, 2000)
		stream.on("error", reject)
		stream.on("data", chunk => {
			chunks.push(chunk)
			if (chunks.length === 6) {
				clearTimeout(failsafe)
				stream.stop()
				resolve(undefined)
			}
		})
	})
	t.ok(chunks.every(c => c.length === STEREO_FRAME_BYTES), "every frame is 3840 bytes")
	t.ok(chunks.slice(2).every(c => c.every(b => b === 0)), "null pulls yield silence")
})

test("audio: LivePcmStream passes pulled frames through in order, with silence for null", async t => {
	let n = 0
	const stream = new LivePcmStream(() => (n < 3 ? Buffer.alloc(STEREO_FRAME_BYTES, ++n) : null))
	/** @type {Buffer[]} */
	const chunks = []
	await new Promise((resolve, reject) => {
		const failsafe = setTimeout(() => {
			stream.stop()
			reject(new Error("timeout"))
		}, 2000)
		stream.on("error", reject)
		stream.on("data", chunk => {
			chunks.push(chunk)
			if (chunks.length === 4) {
				clearTimeout(failsafe)
				stream.stop()
				resolve(undefined)
			}
		})
	})
	t.deepEqual(chunks.slice(0, 4).map(c => c[0]), [1, 2, 3, 0])
})

test("audio: LivePcmStream never produces more than its high-water mark ahead of the reader", async t => {
	let pulls = 0
	const stream = new LivePcmStream(() => {
		pulls++
		return Buffer.alloc(STEREO_FRAME_BYTES, 1)
	})
	// Nobody reads yet: production stops once the buffer holds four frames.
	stream.read(0)
	await new Promise(resolve => setTimeout(resolve, 50))
	t.equal(pulls, 4, "four frames pulled while unread")
	t.ok(stream.readableLength <= STEREO_FRAME_BYTES * 4, "buffer is at most the high-water mark")

	// One read frees one slot, which produces exactly one more frame.
	const frame = stream.read(STEREO_FRAME_BYTES)
	t.equal(frame.length, STEREO_FRAME_BYTES)
	t.equal(pulls, 5, "one more frame pulled after one read")
	stream.stop()
})

test("audio: LivePcmStream stop() ends the stream and stops pulling", async t => {
	let pulls = 0
	const stream = new LivePcmStream(() => {
		pulls++
		return null
	})
	await new Promise((resolve, reject) => {
		const failsafe = setTimeout(() => reject(new Error("stream did not end")), 2000)
		stream.on("error", reject)
		stream.on("end", () => {
			clearTimeout(failsafe)
			resolve(undefined)
		})
		stream.on("data", () => stream.stop())
	})
	const pullsAtEnd = pulls
	await new Promise(resolve => setTimeout(resolve, 50))
	t.ok(stream.destroyed || stream.readableEnded, "stream ended")
	t.equal(pulls, pullsAtEnd, "no frames are pulled after stop()")
})

test("audio: LivePcmStream destroys itself with the error when pull() throws", async t => {
	const stream = new LivePcmStream(() => {
		throw new Error("boom")
	})
	const err = await new Promise((resolve, reject) => {
		const failsafe = setTimeout(() => reject(new Error("no error emitted")), 2000)
		stream.on("error", e => {
			clearTimeout(failsafe)
			resolve(e)
		})
		stream.resume()
	})
	t.equal(/** @type {Error} */ (err).message, "boom")
	t.ok(stream.destroyed, "stream is destroyed")
})
