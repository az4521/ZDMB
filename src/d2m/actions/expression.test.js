// @ts-check

const {test} = require("supertape")
const file = require("../../matrix/file")
const {soundsToState} = require("./expression")

/**
 * Replace uploadDiscordFileToMxc for the duration of a callback.
 * @param {(url: string) => Promise<string>} stub
 * @param {() => Promise<void>} fn
 */
async function withUploadStub(stub, fn) {
	const real = file.uploadDiscordFileToMxc
	// @ts-ignore
	file.uploadDiscordFileToMxc = stub
	try {
		await fn()
	} finally {
		file.uploadDiscordFileToMxc = real
	}
}

/** @type {any} */
const guild = {id: "999000000000000010", name: "Sound Guild"}

/**
 * @param {Partial<any>} overrides
 */
function sound(overrides) {
	return {
		sound_id: "100",
		name: "wow",
		volume: 1,
		emoji_id: null,
		emoji_name: null,
		guild_id: guild.id,
		available: true,
		...overrides
	}
}

/** Uploads succeed and return a predictable mxc URL derived from the sound ID. */
async function okUpload(url) {
	const id = url.split("/").pop()
	return `mxc://cadence.moe/${id}`
}

test("soundsToState: builds the pack with display name and sound metadata", async t => {
	await withUploadStub(okUpload, async () => {
		const result = await soundsToState([sound({sound_id: "100", name: "airhorn", volume: 0.5, emoji_id: "42", emoji_name: "📯"})], guild)
		t.deepEqual(result, {
			pack: {display_name: "Sound Guild (Discord Sounds)"},
			sounds: {
				airhorn: {
					url: "mxc://cadence.moe/100",
					body: "airhorn",
					info: {mimetype: "audio/mpeg"},
					"moe.crafty.zdmb.discord_sound": {
						id: "100",
						guild_id: guild.id,
						volume: 0.5,
						emoji_id: "42",
						emoji_name: "📯"
					}
				}
			}
		})
	})
})

test("soundsToState: shortcode grammar strips colons, turns whitespace into underscores, drops other characters", async t => {
	await withUploadStub(okUpload, async () => {
		const result = await soundsToState([sound({sound_id: "1", name: "  :Hello World!: "})], guild)
		t.deepEqual(Object.keys(result.sounds), ["Hello_World"])
	})
})

test("soundsToState: shortcode falls back to 'sound' when nothing is left and is capped at 100 characters", async t => {
	await withUploadStub(okUpload, async () => {
		const result = await soundsToState([
			sound({sound_id: "1", name: "!!!"}),
			sound({sound_id: "2", name: "a".repeat(150)})
		], guild)
		t.deepEqual(Object.keys(result.sounds).sort(), ["a".repeat(100), "sound"].sort())
	})
})

test("soundsToState: duplicate shortcodes get _2, _3 suffixes in sound ID order", async t => {
	await withUploadStub(okUpload, async () => {
		// Passed in reverse order; the lower sound ID should keep the plain name
		const result = await soundsToState([
			sound({sound_id: "300", name: "wow"}),
			sound({sound_id: "200", name: "wow"}),
			sound({sound_id: "100", name: "wow"})
		], guild)
		t.deepEqual(Object.entries(result.sounds).map(([k, v]) => [k, v.url]), [
			["wow", "mxc://cadence.moe/100"],
			["wow_2", "mxc://cadence.moe/200"],
			["wow_3", "mxc://cadence.moe/300"]
		])
	})
})

test("soundsToState: shortcodes are stable when the input order changes", async t => {
	await withUploadStub(okUpload, async () => {
		const a = await soundsToState([sound({sound_id: "2", name: "dup"}), sound({sound_id: "1", name: "dup"})], guild)
		const b = await soundsToState([sound({sound_id: "1", name: "dup"}), sound({sound_id: "2", name: "dup"})], guild)
		t.deepEqual(a, b)
	})
})

test("soundsToState: unavailable sounds are skipped and not uploaded", async t => {
	/** @type {string[]} */
	const uploaded = []
	await withUploadStub(async url => {
		uploaded.push(url)
		return okUpload(url)
	}, async () => {
		const result = await soundsToState([
			sound({sound_id: "1", name: "gone", available: false}),
			sound({sound_id: "2", name: "here"})
		], guild)
		t.deepEqual({keys: Object.keys(result.sounds), uploaded}, {keys: ["here"], uploaded: ["https://cdn.discordapp.com/soundboard-sounds/2"]})
	})
})

test("soundsToState: a failed upload skips only that sound and does not shift other shortcodes", async t => {
	const realError = console.error
	console.error = () => {}
	try {
		await withUploadStub(async url => {
			if (url.endsWith("/1")) throw new Error("upload failed")
			return okUpload(url)
		}, async () => {
			const result = await soundsToState([
				sound({sound_id: "1", name: "dup"}),
				sound({sound_id: "2", name: "dup"})
			], guild)
			t.deepEqual(Object.entries(result.sounds).map(([k, v]) => [k, v.url]), [["dup_2", "mxc://cadence.moe/2"]])
		})
	} finally {
		console.error = realError
	}
})
