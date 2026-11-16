// @ts-check

const DiscordTypes = require("discord-api-types/v10")

const passthrough = require("../../passthrough")
const {sync, db} = passthrough
/** @type {import("../../matrix/file")} */
const file = sync.require("../../matrix/file")

/**
 * @param {DiscordTypes.APIEmoji[]} emojis
 * @param {DiscordTypes.APIGuild} guild
 */
async function emojisToState(emojis, guild) {
	const result = {
		pack: {
			display_name: `${guild.name} (Discord Emojis)`,
			usage: ["emoticon"] // we'll see...
		},
		images: {
		}
	}
	await Promise.all(emojis.map(emoji =>
		// the homeserver can probably cope with doing this in parallel
		file.uploadDiscordFileToMxc(file.emoji(emoji.id, emoji.animated)).then(url => {
			result.images[emoji.name] = {
				info: {
					mimetype: "image/webp"
				},
				url
			}
			db.prepare("INSERT OR IGNORE INTO emoji (emoji_id, name, animated, mxc_url) VALUES (?, ?, ?, ?)").run(emoji.id, emoji.name, +!!emoji.animated, url)
		}).catch(e => {
			if (e.data?.errcode === "M_TOO_LARGE") { // Very unlikely to happen. Only possible for 3x-series emojis uploaded shortly after animated emojis were introduced, when there was no 256 KB size limit.
				return
			}
			e["emoji"] = {
				name: emoji.name,
				id: emoji.id
			}
			throw e
		})
	))
	return result
}

/**
 * @param {DiscordTypes.APISticker[]} stickers
 * @param {DiscordTypes.APIGuild} guild
 */
async function stickersToState(stickers, guild) {
	const result = {
		pack: {
			display_name: `${guild.name} (Discord Stickers)`,
			usage: ["sticker"] // we'll see...
		},
		images: {
		}
	}
	const shortcodes = []
	await Promise.all(stickers.map(sticker =>
		// the homeserver can probably cope with doing this in parallel
		file.uploadDiscordFileToMxc(file.sticker(sticker)).then(url => {

			/** @type {string | undefined} */
			let body = sticker.name
			if (sticker && sticker.description) body += ` - ${sticker.description}`
			if (!body) body = undefined

			let shortcode = sticker.name.toLowerCase().replace(/[^a-zA-Z0-9_-]/g, "-").replace(/^-|-$/g, "").replace(/--+/g, "-")
			while (shortcodes.includes(shortcode)) shortcode = shortcode + "~"
			shortcodes.push(shortcode)

			result.images[shortcode] = {
				info: {
					mimetype: file.stickerFormat.get(sticker.format_type)?.mime || "image/png"
				},
				body,
				url
			}
		})
	))
	return result
}

/**
 * Shortcode grammar from Zam's uniqueSoundName: trim, strip leading/trailing colons, whitespace to "_",
 * drop characters outside [a-zA-Z0-9_-], max 100 characters, fall back to "sound" if empty, then add "_2", "_3"... if taken.
 * @param {string} name
 * @param {Set<string>} taken
 */
function soundShortcode(name, taken) {
	let base = name.trim().replace(/^:+|:+$/g, "").replace(/\s+/g, "_").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 100)
	if (!base) base = "sound"
	let shortcode = base
	for (let n = 2; taken.has(shortcode); n++) {
		const suffix = `_${n}`
		shortcode = base.slice(0, 100 - suffix.length) + suffix
	}
	taken.add(shortcode)
	return shortcode
}

/**
 * The shortcode each available sound gets in the guild's sound pack. Also used by the voice bridge, so that a
 * sound played live has the same shortcode as in the pack.
 * Sorted by sound ID so that shortcodes don't shuffle between syncs, and assigned up front so that a failed upload
 * doesn't change any other sound's shortcode.
 * @param {DiscordTypes.APISoundboardSound[]} sounds
 * @returns {{sound: DiscordTypes.APISoundboardSound, shortcode: string}[]}
 */
function planSoundShortcodes(sounds) {
	const available = sounds
		.filter(sound => sound.available !== false)
		.sort((a, b) => BigInt(a.sound_id) < BigInt(b.sound_id) ? -1 : BigInt(a.sound_id) > BigInt(b.sound_id) ? 1 : 0)
	const taken = new Set()
	return available.map(sound => ({sound, shortcode: soundShortcode(sound.name, taken)}))
}

/**
 * The Zam-specific metadata on a sound. Matrix canonical JSON forbids non-integer numbers, so Discord's 0..1 float
 * volume is sent as an integer percentage, and only when it is a finite number.
 * @param {DiscordTypes.APISoundboardSound} sound
 * @param {DiscordTypes.APIGuild} guild
 */
function discordSoundContent(sound, guild) {
	/** @type {{id: string, guild_id: string, volume_percent?: number, emoji_id: string | null, emoji_name: string | null}} */
	const content = {
		id: sound.sound_id,
		guild_id: guild.id,
		emoji_id: sound.emoji_id ?? null,
		emoji_name: sound.emoji_name ?? null
	}
	if (typeof sound.volume === "number" && Number.isFinite(sound.volume)) {
		content.volume_percent = Math.round(sound.volume * 100)
	}
	return content
}

/**
 * @param {DiscordTypes.APISoundboardSound[]} sounds
 * @param {DiscordTypes.APIGuild} guild
 */
async function soundsToState(sounds, guild) {
	const result = {
		pack: {
			display_name: `${guild.name} (Discord Sounds)`
		},
		sounds: {}
	}
	const planned = planSoundShortcodes(sounds)
	const uploaded = await Promise.all(planned.map(({sound, shortcode}) =>
		file.uploadDiscordFileToMxc(`https://cdn.discordapp.com/soundboard-sounds/${sound.sound_id}`).then(url => ({
			shortcode,
			content: {
				url,
				body: sound.name,
				info: {
					mimetype: "audio/mpeg"
				},
				"moe.crafty.zdmb.discord_sound": discordSoundContent(sound, guild)
			}
		}), e => {
			console.error(`[soundboard] skipping sound ${sound.name} (${sound.sound_id}) in guild ${guild.id}: failed to upload`, e)
			return null
		})
	))
	// Insert in the same stable order regardless of which uploads finished first
	for (const item of uploaded) {
		if (item) result.sounds[item.shortcode] = item.content
	}
	return result
}

module.exports.emojisToState = emojisToState
module.exports.stickersToState = stickersToState
module.exports.soundsToState = soundsToState
module.exports.planSoundShortcodes = planSoundShortcodes
