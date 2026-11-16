// @ts-check

const passthrough = require("../../passthrough")
const {discord, sync} = passthrough
/** @type {import("../../matrix/api")} */
const api = sync.require("../../matrix/api")
/** @type {import("../../matrix/file")} */
const file = sync.require("../../matrix/file")

/*
	Profile banners are bridged to the profile field read by the Zam client.
	Discord only sends the banner hash from GET /users/{id}, which is rate-limited, so this runs lazily and in the background.
	State is kept in memory only, so no database changes are needed.
*/

const PROFILE_FIELD = "chat.commet.profile_banner"
const CHECK_INTERVAL = 24 * 60 * 60e3

// Tunable for tests
const politeness = {
	/** minimum gap between the starts of two Discord user lookups, in milliseconds */
	gapMs: 1e3
}

/**
 * Discord user ID -> when they were last checked, and the banner hash seen by the last successful sync.
 * bannerHash is undefined if no check has succeeded in this process yet, and null if the user has no banner.
 * @type {Map<string, {checkedAt: number, bannerHash?: string | null}>}
 */
const bannerState = sync.remember(() => new Map())

/** @type {Promise<void>} runs one check at a time */
let queue = Promise.resolve()
let lastRequestAt = 0

/**
 * @param {string} userID
 * @param {string | null | undefined} bannerHash
 * @returns {string | null}
 */
function bannerUrl(userID, bannerHash) {
	if (!bannerHash) return null
	const extension = bannerHash.startsWith("a_") ? "gif" : "png"
	return `https://cdn.discordapp.com/banners/${userID}/${bannerHash}.${extension}?size=1024`
}

/**
 * Runs the task after the previous queued task has finished, waiting for the politeness gap first.
 * @template T
 * @param {() => Promise<T>} task
 * @returns {Promise<T>}
 */
function enqueue(task) {
	const run = queue.then(async () => {
		const wait = lastRequestAt + politeness.gapMs - Date.now()
		if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait).unref())
		lastRequestAt = Date.now()
		return task()
	})
	queue = run.then(() => {}, () => {})
	return run
}

/**
 * @param {string} userID
 * @param {string | null} bannerHash
 */
function recordState(userID, bannerHash) {
	const checkedAt = bannerState.get(userID)?.checkedAt ?? Date.now()
	bannerState.set(userID, {checkedAt, bannerHash})
}

/**
 * Looks up the user and brings their profile banner field up to date. Runs inside the queue.
 * @param {string} userID
 * @param {string} mxid
 */
async function checkUser(userID, mxid) {
	const user = await discord.snow.user.getUser(userID)
	/** @type {string | null} */
	const bannerHash = user.banner ?? null
	const known = bannerState.get(userID)?.bannerHash

	// Unchanged since the last successful sync in this process
	if (known !== undefined && known === bannerHash) return

	if (bannerHash) {
		const mxc = await file.uploadDiscordFileToMxc(/** @type {string} */ (bannerUrl(userID, bannerHash)))
		await api.profileSetField(mxid, PROFILE_FIELD, mxc)
	} else {
		// If we don't know what this sim had before, only delete the field if it's actually there
		let shouldDelete = known !== undefined
		if (known === undefined) {
			const profile = await api.getProfile(mxid)
			shouldDelete = profile?.[PROFILE_FIELD] != null
		}
		if (shouldDelete) await api.profileSetField(mxid, PROFILE_FIELD, null)
	}
	recordState(userID, bannerHash)
}

/**
 * Bridges the Discord user's profile banner to their sim's profile. Checks each user at most once per 24 hours.
 * Never throws or rejects. Callers should not await it, but the returned promise resolves once the check has finished.
 * @param {string} userID Discord user ID
 * @param {string} mxid the sim's Matrix ID
 * @returns {Promise<void>}
 */
async function maybeSyncBanner(userID, mxid) {
	try {
		// Webhook sims use other IDs, which are not Discord users
		if (!/^[0-9]+$/.test(userID)) return
		const state = bannerState.get(userID)
		// Marking as checked before the queue runs means concurrent calls for the same user do not start a second check
		if (state && Date.now() - state.checkedAt < CHECK_INTERVAL) return
		bannerState.set(userID, {checkedAt: Date.now(), bannerHash: state?.bannerHash})
		await enqueue(() => checkUser(userID, mxid))
	} catch (e) {
		// Errors are ignored. The next check is 24 hours after this one.
	}
}

/**
 * Test-only: forgets all state and clears the queue.
 */
function _reset() {
	bannerState.clear()
	queue = Promise.resolve()
	lastRequestAt = 0
}

module.exports.bannerUrl = bannerUrl
module.exports.maybeSyncBanner = maybeSyncBanner
module.exports.politeness = politeness
module.exports._reset = _reset
