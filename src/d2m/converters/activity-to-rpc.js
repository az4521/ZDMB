// @ts-check

/*
	Converts Discord gateway activities (rich presence) into MSC4544 presence entries,
	which are published as the `xyz.extera.msc4544.rpc` profile field.
	This module is pure: image uploads happen in d2m/actions/set-presence.js, which passes
	the resulting mxc URLs in through the `mxcByUrl` map.
	The conversion mirrors how the Zam client converts Discord activities itself.
*/

const RPC_FIELD = "xyz.extera.msc4544.rpc"
const ACTIVITY_TYPE = "xyz.extera.msc4544.rpc.activity"
const MUSIC_TYPE = "xyz.extera.msc4544.rpc.music"

const MAX_ENTRIES = 4
const MAX_TEXT_LENGTH = 128

// Custom status is published as an MSC4426 profile field, which the Zam client reads
const STATUS_FIELD = "org.matrix.msc4426.status"
const STATUS_TEXT_LENGTH = 64

// Discord activity types (https://discord.com/developers/docs/events/gateway-events#activity-object-activity-types)
const TYPE_PLAYING = 0
const TYPE_STREAMING = 1
const TYPE_LISTENING = 2
const TYPE_WATCHING = 3
const TYPE_CUSTOM_STATUS = 4
const TYPE_COMPETING = 5

/** Verb shown before the state for activity types that have one. */
const verbs = new Map([
	[TYPE_STREAMING, "Streaming"],
	[TYPE_WATCHING, "Watching"],
	[TYPE_COMPETING, "Competing"],
])

const activityTypesShown = new Set([TYPE_PLAYING, TYPE_STREAMING, TYPE_WATCHING, TYPE_COMPETING])

/**
 * @param {string} value
 * @returns {string}
 */
function truncate(value) {
	const chars = Array.from(value)
	return chars.length > MAX_TEXT_LENGTH ? chars.slice(0, MAX_TEXT_LENGTH).join("") : value
}

/**
 * Returns a trimmed, truncated string, or undefined if there is no usable text.
 * @param {unknown} value
 * @returns {string | undefined}
 */
function text(value) {
	if (typeof value !== "string") return undefined
	const trimmed = value.trim()
	if (!trimmed) return undefined
	return truncate(trimmed)
}

/**
 * @param {unknown} value
 * @returns {number | undefined}
 */
function number(value) {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

/**
 * Removes keys whose value is undefined, so they are omitted from the JSON.
 * @param {Record<string, any>} object
 */
function compact(object) {
	for (const key of Object.keys(object)) {
		if (object[key] === undefined) delete object[key]
	}
	return object
}

/**
 * Builds the MSC4544 presence entry object with the common fields.
 * @param {any} activity
 * @param {string} type
 * @param {number | undefined} expiry
 */
function common(activity, type, expiry) {
	const id = truncate(typeof activity.id === "string" ? activity.id : `${activity.type}:${activity.application_id ?? activity.name}`)
	return compact({id, type, expiry})
}

/**
 * Turns a Discord party size of [current, max] into "(current of max)".
 * @param {unknown} size
 * @returns {string | undefined}
 */
function partyText(size) {
	if (!Array.isArray(size) || size.length !== 2) return undefined
	const [current, max] = size
	const isPositiveInteger = (/** @type {unknown} */ n) => Number.isInteger(n) && n > 0
	if (!isPositiveInteger(current) || !isPositiveInteger(max) || current > max) return undefined
	return `(${current} of ${max})`
}

/**
 * Converts a Discord asset image reference into an HTTPS URL.
 * @param {unknown} asset
 * @param {unknown} applicationID
 * @returns {string | undefined}
 */
function assetUrl(asset, applicationID) {
	if (typeof asset !== "string" || !asset) return undefined
	if (asset.startsWith("spotify:")) {
		const id = asset.slice("spotify:".length)
		return /^[A-Za-z0-9]+$/.test(id) ? `https://i.scdn.co/image/${id}` : undefined
	}
	if (asset.startsWith("mp:")) {
		const rest = asset.slice("mp:".length)
		return /^[\w\-./]+$/.test(rest) ? `https://media.discordapp.net/${rest}` : undefined
	}
	if (/^\d+$/.test(asset) && (typeof applicationID === "string" || typeof applicationID === "number")) {
		return `https://cdn.discordapp.com/app-assets/${applicationID}/${asset}.png`
	}
	return undefined
}

/**
 * Lists the HTTPS URLs of the large and small images of an activity, so they can be uploaded to Matrix.
 * @param {any} activity Discord gateway activity
 * @returns {{large?: string, small?: string}}
 */
function activityImageUrls(activity) {
	if (!activity) return {}
	const assets = activity.assets
	return compact({
		large: assetUrl(assets?.large_image, activity.application_id),
		small: assetUrl(assets?.small_image, activity.application_id),
	})
}

/**
 * Listening to a song (Spotify etc.) becomes a music entry.
 * @param {any} activity
 * @param {number | undefined} expiry
 * @param {Map<string, string>} mxcByUrl
 */
function musicEntry(activity, expiry, mxcByUrl) {
	const track = text(activity.details)
	if (!track) return null
	const artist = text(text(activity.state)?.replace(/^by /i, ""))
	const images = activityImageUrls(activity)
	const start = number(activity.timestamps?.start)
	const end = number(activity.timestamps?.end)
	const progress = start !== undefined && end !== undefined && end > start ? {since: start, until: end} : undefined

	return compact({
		...common(activity, MUSIC_TYPE, expiry),
		track,
		artist,
		album: text(activity.assets?.large_text),
		player_name: text(activity.name),
		cover_url: images.large ? mxcByUrl.get(images.large) : undefined,
		progress,
	})
}

/**
 * Playing, streaming, watching and competing become activity entries.
 * @param {any} activity
 * @param {number | undefined} expiry
 * @param {Map<string, string>} mxcByUrl
 */
function regularActivityEntry(activity, expiry, mxcByUrl) {
	const name = text(activity.name)
	if (!name) return null

	const verb = verbs.get(activity.type)
	const stateText = text(activity.state)
	let state = verb && stateText ? `${verb} · ${stateText}` : verb ?? stateText
	const party = partyText(activity.party?.size)
	if (party) state = state ? `${state} ${party}` : party

	const assets = activity.assets
	const images = activityImageUrls(activity)
	// Small icons are only sent alongside a large icon
	const large = images.large ? mxcByUrl.get(images.large) : undefined
	const small = large && images.small ? mxcByUrl.get(images.small) : undefined

	return compact({
		...common(activity, ACTIVITY_TYPE, expiry),
		name,
		details: text(activity.details),
		state: text(state),
		since: number(activity.timestamps?.start),
		until: number(activity.timestamps?.end),
		large_icon_url: large,
		large_icon_tooltip: large ? text(assets?.large_text) : undefined,
		small_icon_url: small,
		small_icon_tooltip: small ? text(assets?.small_text) : undefined,
	})
}

/**
 * Converts one Discord activity into an MSC4544 presence entry.
 * Returns null for activities that should not be shown (custom statuses, unknown types, or activities without a name).
 * @param {import("discord-api-types/v10").GatewayActivity} activity
 * @param {number | undefined} expiry unix ms; undefined leaves the key out (set-presence adds it when publishing)
 * @param {Map<string, string>} [mxcByUrl] Discord image URL (see activityImageUrls) -> mxc URL, for images that were uploaded
 * @returns {Record<string, any> | null}
 */
function activityToRpcEntry(activity, expiry, mxcByUrl = new Map()) {
	if (!activity) return null
	const type = /** @type {number} */ (activity.type)
	if (type === TYPE_CUSTOM_STATUS) return null
	if (type === TYPE_LISTENING) {
		return musicEntry(activity, expiry, mxcByUrl)
	}
	if (!activityTypesShown.has(type)) return null
	return regularActivityEntry(activity, expiry, mxcByUrl)
}

/**
 * Converts a list of Discord activities into MSC4544 presence entries.
 * Skips activities that have no entry, and returns at most 4 entries.
 * @param {import("discord-api-types/v10").GatewayActivity[] | undefined} activities
 * @param {number | undefined} expiry unix ms, or undefined to leave it out
 * @param {Map<string, string>} [mxcByUrl] Discord image URL -> mxc URL
 * @returns {Record<string, any>[]}
 */
function activitiesToRpc(activities, expiry, mxcByUrl = new Map()) {
	if (!Array.isArray(activities)) return []
	/** @type {Record<string, any>[]} */
	const entries = []
	for (const activity of activities) {
		const entry = activityToRpcEntry(activity, expiry, mxcByUrl)
		if (entry) entries.push(entry)
		if (entries.length >= MAX_ENTRIES) break
	}
	return entries
}

/**
 * Finds the custom status (activity type 4) and converts it into the MSC4426 status value.
 * Custom Discord emoji (with an id) cannot be shown on Matrix, so they are left out.
 * @param {import("discord-api-types/v10").GatewayActivity[] | undefined} activities
 * @returns {{text: string, emoji: string} | null} null if there is nothing to show
 */
function activitiesToStatus(activities) {
	if (!Array.isArray(activities)) return null
	const custom = /** @type {any} */ (activities.find(activity => activity?.type === TYPE_CUSTOM_STATUS))
	if (!custom) return null
	const rawText = typeof custom.state === "string" ? custom.state.trim() : ""
	const text = Array.from(rawText).slice(0, STATUS_TEXT_LENGTH).join("")
	const rawEmoji = custom.emoji && !custom.emoji.id && typeof custom.emoji.name === "string" ? custom.emoji.name.trim() : ""
	// One whole grapheme, so that multi-codepoint emojis (ZWJ sequences, flags, skin tones) are never cut in half
	const firstGrapheme = new Intl.Segmenter(undefined, {granularity: "grapheme"}).segment(rawEmoji)[Symbol.iterator]().next().value?.segment ?? ""
	const emoji = firstGrapheme.length <= 32 ? firstGrapheme : ""
	if (!text && !emoji) return null
	return {text, emoji}
}

module.exports.RPC_FIELD = RPC_FIELD
module.exports.STATUS_FIELD = STATUS_FIELD
module.exports.activitiesToStatus = activitiesToStatus
module.exports.ACTIVITY_TYPE = ACTIVITY_TYPE
module.exports.MUSIC_TYPE = MUSIC_TYPE
module.exports.activityToRpcEntry = activityToRpcEntry
module.exports.activitiesToRpc = activitiesToRpc
module.exports.activityImageUrls = activityImageUrls
