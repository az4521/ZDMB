// @ts-check
const {test} = require("supertape")
const {
	STEREO_FRAME_BYTES,
	createOpusDecoder,
	createOpusEncoder,
	stereoToMono,
	monoToStereo,
	mixMono,
	JitterBuffer,
	LiveOpusStream,
} = require("./audio")

/** @param {number} ms */
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

/**
 * One 20 ms stereo s16le frame holding a sine tone.
 * @param {number} [freq]
 * @returns {Buffer}
 */
function toneFrame(freq = 440) {
	const pcm = Buffer.alloc(STEREO_FRAME_BYTES)
	for (let i = 0; i < 960; i++) {
		const sample = Math.round(8000 * Math.sin(2 * Math.PI * freq * i / 48000))
		pcm.writeInt16LE(sample, i * 4)
		pcm.writeInt16LE(sample, i * 4 + 2)
	}
	return pcm
}

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

test("audio: JitterBuffer primes once per talk spurt, so a brief gap does not re-prime", t => {
	const jb = new JitterBuffer()
	jb.push(new Int16Array(1920).fill(3))
	t.ok(jb.read(960).every(s => s === 3))
	t.ok(jb.read(960).every(s => s === 3))
	// Empty now: the read is zero-filled, but the buffer stays primed
	t.ok(jb.read(960).every(s => s === 0))
	// A single frame arrives and plays straight away, with no 40 ms wait
	jb.push(new Int16Array(960).fill(9))
	t.ok(jb.read(960).every(s => s === 9), "playing resumes at once after a brief gap")
	t.equal(jb.stats().underrunReads, 1, "the gap is counted as one underrun read")
})

test("audio: JitterBuffer re-primes only after reprimeAfterMs of reads that found it empty", t => {
	const jb = new JitterBuffer()
	jb.push(new Int16Array(1920).fill(3))
	jb.read(960)
	jb.read(960)
	// Nine empty reads are 180 ms: still primed, so a frame plays at once
	for (let i = 0; i < 9; i++) jb.read(960)
	jb.push(new Int16Array(960).fill(9))
	t.ok(jb.read(960).every(s => s === 9), "still primed after 180 ms of silence")

	// Ten empty reads (200 ms) mean the speaker stopped. Now one frame is not enough to play.
	for (let i = 0; i < 10; i++) jb.read(960)
	jb.push(new Int16Array(960).fill(9))
	t.ok(jb.read(960).every(s => s === 0), "silent again until the prime is back")
	t.equal(jb.bufferedMs, 20, "nothing is consumed while unprimed")
	jb.push(new Int16Array(960).fill(9))
	t.ok(jb.read(960).every(s => s === 9), "plays once 40 ms are buffered again")
})

test("audio: JitterBuffer soft cap drops oldest samples down to primeMs when over targetMaxMs", t => {
	const jb = new JitterBuffer()
	const total = 9600 // 200 ms
	const ramp = new Int16Array(total)
	for (let i = 0; i < total; i++) ramp[i] = i
	jb.push(ramp)
	t.equal(jb.bufferedMs, 200)
	const out = jb.read(960)
	// 9600 buffered is over the 100 ms target: 7680 oldest are dropped, leaving 40 ms, then 20 ms is read
	t.equal(out[0], 7680)
	t.equal(out[959], 7680 + 959)
	t.equal(jb.bufferedMs, 20)
	t.equal(jb.stats().droppedSamples, 7680)
})

test("audio: JitterBuffer does not soft-drop at exactly targetMaxMs", t => {
	const jb = new JitterBuffer()
	jb.push(new Int16Array(4800).fill(5)) // 100 ms
	t.ok(jb.read(960).every(s => s === 5))
	t.equal(jb.stats().droppedSamples, 0)
})

test("audio: JitterBuffer hard cap drops oldest samples beyond maxMs", t => {
	const jb = new JitterBuffer({primeMs: 0, targetMaxMs: 200})
	const total = 14400 // 300 ms
	const ramp = new Int16Array(total)
	for (let i = 0; i < total; i++) ramp[i] = i
	jb.push(ramp)
	t.equal(jb.bufferedMs, 200)
	const out = jb.read(960)
	t.equal(out[0], total - 9600)
	t.equal(out[959], total - 9600 + 959)
	t.equal(jb.stats().droppedSamples, 4800)
})

test("audio: JitterBuffer stats() and reset()", t => {
	const jb = new JitterBuffer()
	jb.read(960) // unprimed silence is not an underrun
	jb.push(new Int16Array(1920).fill(1))
	jb.read(960)
	jb.read(960)
	jb.read(960) // empty: underrun
	// Buffered depth at the four reads: 0, 40, 20, 0 ms
	t.deepEqual(jb.stats(), {underrunReads: 1, droppedSamples: 0, bufferedSumMs: 60, bufferedReads: 4, bufferedMaxMs: 40})
	jb.reset()
	t.deepEqual(jb.stats(), {underrunReads: 0, droppedSamples: 0, bufferedSumMs: 0, bufferedReads: 0, bufferedMaxMs: 0})
})

test("audio: createOpusDecoder decodes an Opus packet produced by OpusScript's encoder", t => {
	const OpusScript = require("opusscript")
	const encoder = new OpusScript(48000, 2, OpusScript.Application.VOIP)
	const packet = encoder.encode(toneFrame(), 960)
	encoder.delete()

	const decoder = createOpusDecoder()
	const decoded = decoder.decode(packet)
	t.equal(decoded.length, STEREO_FRAME_BYTES)
	t.ok(decoded.some(b => b !== 0), "decoded audio is not silence")
})

test("audio: createOpusEncoder round-trips a frame through createOpusDecoder", t => {
	const encoder = createOpusEncoder()
	const packet = encoder.encode(toneFrame())
	encoder.delete()
	t.ok(Buffer.isBuffer(packet))
	t.ok(packet.length > 0 && packet.length < STEREO_FRAME_BYTES, "a packet is much smaller than the PCM frame")

	const decoded = createOpusDecoder().decode(packet)
	t.equal(decoded.length, STEREO_FRAME_BYTES)
	t.ok(decoded.some(b => b !== 0), "decoded audio is not silence")
})

test("audio: LiveOpusStream emits one Opus packet per read, with silence for null pulls", async t => {
	const frames = [toneFrame(), toneFrame(880)]
	const stream = new LiveOpusStream(() => frames.shift() ?? null)
	/** @type {Buffer[]} */
	const packets = []
	await new Promise((resolve, reject) => {
		const failsafe = setTimeout(() => {
			stream.stop()
			reject(new Error("LiveOpusStream produced too few packets"))
		}, 2000)
		stream.on("error", reject)
		stream.on("data", packet => {
			packets.push(packet)
			if (packets.length === 4) {
				clearTimeout(failsafe)
				stream.stop()
				resolve(undefined)
			}
		})
	})
	t.ok(packets.every(p => Buffer.isBuffer(p) && p.length > 0), "every read is one non-empty Buffer packet")
	const decoder = createOpusDecoder()
	t.equal(decoder.decode(packets[0]).length, STEREO_FRAME_BYTES)
	t.ok(decoder.decode(packets[0]).some(b => b !== 0), "a pulled frame comes out as audio")
	// Packets already buffered when stop() is called are still delivered, so there can be more than four
	t.ok(packets.length >= 4, "at least the four packets asked for")
})

test("audio: LiveOpusStream keeps at most two packets ahead of the reader", async t => {
	let pulls = 0
	const stream = new LiveOpusStream(() => {
		pulls++
		return toneFrame()
	})
	// Nobody reads yet: production stops once two packets are buffered.
	stream.read(0)
	await wait(50)
	t.equal(pulls, 2, "two frames pulled while unread")

	// One read frees one slot, which produces exactly one more packet.
	const packet = stream.read()
	t.ok(Buffer.isBuffer(packet), "read() returns one packet")
	await wait(10)
	t.equal(pulls, 3, "one more frame pulled after one read")
	stream.stop()
})

test("audio: LiveOpusStream stop() ends the stream and stops pulling", async t => {
	let pulls = 0
	const stream = new LiveOpusStream(() => {
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
	await wait(50)
	t.ok(stream.destroyed || stream.readableEnded, "stream ended")
	t.equal(pulls, pullsAtEnd, "no frames are pulled after stop()")
})

test("audio: LiveOpusStream destroys itself with the error when pull() throws", async t => {
	const stream = new LiveOpusStream(() => {
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
