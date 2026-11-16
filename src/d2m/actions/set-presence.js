// @ts-check

const assert = require("assert").strict

const passthrough = require("../../passthrough")
const {sync, select} = passthrough
/** @type {import("../../matrix/api")} */
const api = sync.require("../../matrix/api")
/** @type {import("../../matrix/file")} */
const file = sync.require("../../matrix/file")
/** @type {import("../converters/activity-to-rpc")} */
const activityToRpc = sync.require("../converters/activity-to-rpc")

/*
	We do this in two phases for optimisation reasons.
	Discord sends us an event when the presence *changes.*
	We need to keep the event data in memory because we need to *repeatedly* send it to Matrix using a long-lived loop.

	There are two phases to get it from Discord to Matrix.
	The first phase stores Discord presence data in memory.
	The second phase loops over the memory and sends it on to Matrix.

	Optimisations:
	* Presence can be deactivated per-guild in OOYE settings. If the user doesn't share any presence-enabled-guilds with us, we don't need to do anything.
	* Presence can be sent for users without sims. In this case, they will be discarded from memory when the next loop begins.
	* Matrix ID is cached in memory on the Presence class. The alternative to this is querying it every time we receive a presence change event in a valid guild.
	* Presence can be sent multiple times in a row for the same user for each guild we share. The loop timer prevents these "changes" from individually reaching the homeserver.
*/

// Synapse expires each user's presence after 30 seconds and makes them offline, so we have to loop every 28 seconds and update each user again.
const presenceLoopInterval = 28e3

// Rich presence (activities) is published as an MSC4544 profile field. Each publish expires after 5 minutes,
// and entries that are still active are re-published every 4 minutes so they never expire while Discord shows them.
const rpcExpiryDuration = 5 * 60e3
const rpcRefreshInterval = 4 * 60e3

// Cache the list of enabled guilds rather than accessing it like multiple times per second when any user changes presence
const guildPresenceSetting = new class {
	/** @private @type {Set<string>} */ guilds = new Set()
	constructor() {
		this.update()
	}
	update() {
		this.guilds = new Set(select("guild_space", "guild_id", {presence: 1}).pluck().all())
	}
	isEnabled(guildID) {
		return this.guilds.has(guildID)
	}
}

/**
 * Discord image URL -> mxc URL, or undefined if the upload failed. Shared between all users so the same image is only uploaded once.
 * @type {Map<string, string | undefined>}
 */
const iconCache = sync.remember(() => new Map())

/**
 * Uploads a Discord image to Matrix, or returns undefined if that is not possible (the entry is still published without the icon).
 * @param {string} url
 * @returns {Promise<string | undefined>}
 */
async function uploadIcon(url) {
	if (iconCache.has(url)) return iconCache.get(url)
	try {
		const mxc = await file.uploadDiscordFileToMxc(url)
		iconCache.set(url, mxc)
		return mxc
	} catch (e) {
		// Remember the failure so that we don't retry the same image on every presence change
		iconCache.set(url, undefined)
		return undefined
	}
}

/**
 * Uploads every image used by these activities.
 * @param {import("discord-api-types/v10").GatewayActivity[]} activities
 * @returns {Promise<Map<string, string>>} Discord image URL -> mxc URL, for the images that were uploaded
 */
async function resolveIcons(activities) {
	const urls = new Set()
	for (const activity of activities) {
		const images = activityToRpc.activityImageUrls(activity)
		if (images.large) urls.add(images.large)
		if (images.small) urls.add(images.small)
	}
	/** @type {Map<string, string>} */
	const mxcByUrl = new Map()
	await Promise.all([...urls].map(async url => {
		const mxc = await uploadIcon(url)
		if (mxc) mxcByUrl.set(url, mxc)
	}))
	return mxcByUrl
}

class Presence extends sync.reloadClassMethods(() => Presence) {
	/** @type {string} */ userID
	/** @type {{presence: "online" | "offline" | "unavailable", status_msg?: string} | undefined} */ data
	/** @private @type {?string | undefined} */ mxid
	/** @private @type {number} */ delay = Math.random()
	/** @private @type {import("discord-api-types/v10").GatewayActivity[]} */ activities = []
	/** @private @type {Record<string, any>[]} entries for the rich presence field, without expiry */ rpcEntries = []
	/** @private @type {string | null} JSON of the entries last published, or null if the field is currently empty */ rpcPublished = null
	/** @private @type {number} */ rpcLastPut = 0
	/** @private @type {Promise<void>} serialises writes to the rich presence field */ rpcQueue = Promise.resolve()
	/** @private @type {boolean} set once this user has gone offline and the Presence is discarded */ dropped = false

	constructor(userID) {
		super()
		this.userID = userID
	}

	/**
	 * @param {string} status status field from Discord's PRESENCE_UPDATE event
	 * @param {import("discord-api-types/v10").GatewayActivity[] | undefined} activities Discord activities from the same event
	 */
	setData(status, activities) {
		const presence =
			( status === "online" ? "online"
			: status === "offline" ? "offline"
			: "unavailable")
		this.data = {presence}
		this.activities = activities ?? []
		// rpcEntries are replaced once icons have been uploaded, so that an icon-less version is never published first
		this.updateRpc()
	}

	/**
	 * Uploads any new icons, converts the latest activities, and publishes if they changed.
	 * @private
	 */
	updateRpc() {
		// Only users with sims get anything published, so don't upload icons for anyone else
		if (!this.lookupMxid()) return
		const activities = this.activities
		resolveIcons(activities).then(mxcByUrl => {
			// A newer presence arrived while the icons were uploading, and its own update will handle it
			if (activities !== this.activities) return
			this.rpcEntries = activityToRpc.activitiesToRpc(activities, undefined, mxcByUrl)
			this.publishRpc(false)
		}).catch(() => {})
	}

	/**
	 * Publishes the rich presence field if it changed, or if it is due a refresh.
	 * @param {boolean} refreshing true when called from the sync loop, which re-publishes entries before they expire
	 * @private
	 */
	publishRpc(refreshing) {
		const mxid = this.lookupMxid()
		if (!mxid || this.dropped) return

		if (this.rpcEntries.length === 0) {
			if (this.rpcPublished !== null) this.clearRpc(mxid)
			return
		}

		const json = JSON.stringify(this.rpcEntries)
		const now = Date.now()
		const changed = json !== this.rpcPublished
		const due = refreshing && now - this.rpcLastPut > rpcRefreshInterval
		if (!changed && !due) return

		this.rpcPublished = json
		this.rpcLastPut = now
		const expiry = now + rpcExpiryDuration
		this.enqueueRpc(mxid, this.rpcEntries.map(entry => ({...entry, expiry})))
	}

	/**
	 * Deletes the rich presence field, if a non-empty value was published. Sends at most one DELETE until something is published again.
	 * @private
	 * @param {string} mxid
	 */
	clearRpc(mxid) {
		this.rpcPublished = null
		this.enqueueRpc(mxid, null)
	}

	/**
	 * Called when this user goes offline, right before the Presence is discarded.
	 */
	dropRpc() {
		this.dropped = true
		if (this.rpcPublished === null) return
		const mxid = this.lookupMxid()
		if (mxid) this.clearRpc(mxid)
	}

	/**
	 * Writes are chained so that only one PUT or DELETE per user is in flight at a time.
	 * Errors are ignored, since the server may not support extended profile fields.
	 * @private
	 * @param {string} mxid
	 * @param {Record<string, any>[] | null} value entries to set, or null to delete the field
	 */
	enqueueRpc(mxid, value) {
		this.rpcQueue = this.rpcQueue
			.then(() => api.profileSetField(mxid, activityToRpc.RPC_FIELD, value))
			.catch(() => {})
	}

	/** @private */
	lookupMxid() {
		return this.mxid ??= select("sim", "mxid", {user_id: this.userID}).pluck().get()
	}

	sync(presences) {
		const mxid = this.lookupMxid()
		if (!mxid) return presences.delete(this.userID)
		// I haven't tried, but I assume Synapse explodes if you try to update too many presences at the same time.
		// This random delay will space them out over the whole 28 second cycle.
		setTimeout(() => {
			assert(this.data)
			api.setPresence(this.data, mxid).catch(() => {})
		}, this.delay * presenceLoopInterval).unref()
		this.publishRpc(true)
	}
}

const presenceTracker = new class {
	/** @private @type {Map<string, Presence>} userID -> Presence */ presences = sync.remember(() => new Map())

	constructor() {
		sync.addTemporaryInterval(() => this.syncPresences(), presenceLoopInterval)
	}

	/**
	 * This function is called for each Discord presence packet.
	 * @param {string} userID Discord user ID
	 * @param {string} guildID Discord guild ID that this presence applies to (really, the same presence applies to every single guild, but is delivered separately by Discord for some reason)
	 * @param {string} status status field from Discord's PRESENCE_UPDATE event
	 * @param {import("discord-api-types/v10").GatewayActivity[] | undefined} activities Discord activities (rich presence) from the same event
	 */
	incomingPresence(userID, guildID, status, activities) {
		// stop tracking offline presence objects - they will naturally expire and fall offline on the homeserver
		if (status === "offline") {
			this.presences.get(userID)?.dropRpc()
			return this.presences.delete(userID)
		}
		// check if we care about this guild
		if (!guildPresenceSetting.isEnabled(guildID)) return
		// start tracking presence for user (we'll check if they have a sim in the next sync loop)
		this.getOrCreatePresence(userID).setData(status, activities)
	}

	/** @private */
	getOrCreatePresence(userID) {
		return this.presences.get(userID) || (() => {
			const presence = new Presence(userID)
			this.presences.set(userID, presence)
			return presence
		})()
	}

	/** @private */
	syncPresences() {
		for (const presence of this.presences.values()) {
			presence.sync(this.presences)
		}
	}
}

module.exports.presenceTracker = presenceTracker
module.exports.guildPresenceSetting = guildPresenceSetting
