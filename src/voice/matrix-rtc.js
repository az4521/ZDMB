// @ts-check

const passthrough = require("../passthrough")
const {sync} = passthrough
/** @type {import("../matrix/api")} */
const api = sync.require("../matrix/api")
/** @type {import("../matrix/mreq")} */
const mreq = sync.require("../matrix/mreq")
/** @type {import("../matrix/utils")} */
const mxUtils = sync.require("../matrix/utils")
const {reg} = require("../matrix/read-registration.js")

/*
	MatrixRTC signalling: LiveKit focus discovery, OpenID-backed LiveKit credentials, and call membership state events.
	No LiveKit media code lives here.
*/

const VOICE_DEVICE_ID = "ZDMBVOICE"
const CALL_MEMBER_TYPE = "org.matrix.msc3401.call.member"
const LEGACY_CALL_MEMBER_TYPE = "m.call.member"
const MEMBERSHIP_EXPIRES_MS = 4 * 60 * 60 * 1000
const REFRESH_INTERVAL_MS = 60 * 60 * 1000
const FOCUS_CACHE_MS = 60 * 60 * 1000
const HTTP_TIMEOUT_MS = 15e3

/** @type {{serviceUrl: string, expires: number} | null} */
let focusCache = null

/**
 * Indirection so tests can stub the lk-jwt and .well-known requests.
 * @type {(url: string, init?: RequestInit) => Promise<Response>}
 */
module.exports._fetch = (url, init) => fetch(url, init)

/**
 * Forget the cached LiveKit focus. Intended for tests.
 */
function _resetFocusCache() {
	focusCache = null
}

/**
 * @param {string} type
 * @returns {boolean} true for the call member event types that carry memberships
 */
function isCallMemberEventType(type) {
	return type === CALL_MEMBER_TYPE || type === LEGACY_CALL_MEMBER_TYPE
}

/**
 * @param {string} mxid
 */
function stateKeyFor(mxid) {
	return `_${mxid}_${VOICE_DEVICE_ID}_m.call`
}

/**
 * @param {string} roomID
 * @param {string} mxid
 */
function membershipKey(roomID, mxid) {
	return `${roomID}|${mxid}`
}

/**
 * Room IDs never contain "|", so the first "|" separates the room from the user.
 * @param {string} key
 */
function splitMembershipKey(key) {
	const index = key.indexOf("|")
	return {roomID: key.slice(0, index), mxid: key.slice(index + 1)}
}

/**
 * @param {any} list
 * @returns {string | null}
 */
function pickLiveKitServiceUrl(list) {
	if (!Array.isArray(list)) return null
	const focus = list.find(f => f?.type === "livekit" && typeof f.livekit_service_url === "string")
	return focus?.livekit_service_url ?? null
}

/**
 * @returns {Promise<string | null>}
 */
async function findFocusFromWellKnown() {
	try {
		const res = await module.exports._fetch(`https://${reg.ooye.server_name}/.well-known/matrix/client`, {signal: AbortSignal.timeout(HTTP_TIMEOUT_MS)})
		if (!res.ok) return null
		const json = await res.json()
		return pickLiveKitServiceUrl(json?.["org.matrix.msc4143.rtc_foci"])
	} catch (e) {
		console.error("[voice] .well-known lookup for RTC focus failed:", e)
		return null
	}
}

/**
 * @returns {Promise<string | null>}
 */
async function findFocusFromTransports() {
	try {
		/** @type {any} */
		const root = await mreq.mreq("GET", "/client/v1/rtc/transports")
		return pickLiveKitServiceUrl(root?.rtc_transports)
	} catch (e) {
		console.error("[voice] rtc/transports lookup for RTC focus failed:", e)
		return null
	}
}

/**
 * Find the LiveKit SFU the homeserver advertises. Cached for an hour.
 * @returns {Promise<{serviceUrl: string} | null>} null if the homeserver advertises no LiveKit focus
 */
async function getFocus() {
	if (focusCache && focusCache.expires > Date.now()) {
		return {serviceUrl: focusCache.serviceUrl}
	}
	const serviceUrl = await findFocusFromWellKnown() ?? await findFocusFromTransports()
	if (!serviceUrl) return null
	focusCache = {serviceUrl, expires: Date.now() + FOCUS_CACHE_MS}
	return {serviceUrl}
}

/**
 * Get an OpenID token for the user, acting as that user (appservice masquerade).
 * @param {string} mxid
 * @returns {Promise<{access_token: string, token_type: string, matrix_server_name: string, expires_in: number}>}
 */
function getOpenIdToken(mxid) {
	return mreq.mreq("POST", api.path(api.route`/client/v3/user/${mxid}/openid/request_token`, mxid), {})
}

/**
 * Exchange an OpenID token for LiveKit credentials via lk-jwt-service.
 * @param {string} mxid
 * @param {string} roomID
 * @returns {Promise<{url: string, jwt: string}>}
 */
async function getLiveKitCredentials(mxid, roomID) {
	const focus = await getFocus()
	if (!focus) throw new Error("Homeserver advertises no LiveKit focus (checked .well-known rtc_foci and rtc/transports)")
	const openidToken = await getOpenIdToken(mxid)
	const res = await module.exports._fetch(`${focus.serviceUrl.replace(/\/$/, "")}/sfu/get`, {
		method: "POST",
		headers: {"Content-Type": "application/json"},
		body: JSON.stringify({
			room: roomID,
			device_id: VOICE_DEVICE_ID,
			openid_token: openidToken
		}),
		signal: AbortSignal.timeout(HTTP_TIMEOUT_MS)
	})
	if (!res.ok) {
		const text = await res.text()
		throw new Error(`lk-jwt /sfu/get failed with HTTP ${res.status}: ${text}`)
	}
	/** @type {any} */
	const json = await res.json()
	const jwt = json?.jwt ?? json?.token
	if (typeof json?.url !== "string" || typeof jwt !== "string") {
		throw new Error("lk-jwt /sfu/get response lacked url or jwt")
	}
	return {url: json.url, jwt}
}

/**
 * Pick the call memberships that are live from a list of room state events.
 * @param {any[]} stateEvents state events with type, state_key, sender, content, origin_server_ts
 * @param {number} [now] unix milliseconds
 * @returns {{mxid: string, deviceID: string}[]}
 */
function parseCallMembers(stateEvents, now = Date.now()) {
	/** @type {Set<string>} */
	const seen = new Set()
	/** @type {{mxid: string, deviceID: string}[]} */
	const result = []
	for (const event of stateEvents) {
		if (!event || !isCallMemberEventType(event.type)) continue
		const content = event.content
		if (!content || typeof content !== "object" || Object.keys(content).length === 0) continue
		if (content.membership === "leave") continue
		const deviceID = content.device_id ?? content.member?.device_id
		if (typeof deviceID !== "string" || !deviceID) continue
		const createdTs = content.created_ts ?? event.origin_server_ts
		if (typeof createdTs !== "number" || !Number.isFinite(createdTs)) continue
		const expiresMs = content.expires ?? MEMBERSHIP_EXPIRES_MS
		if (createdTs + expiresMs <= now) continue
		const mxid = event.sender
		const dedupeKey = `${mxid}|${deviceID}`
		if (seen.has(dedupeKey)) continue
		seen.add(dedupeKey)
		result.push({mxid, deviceID})
	}
	return result
}

/**
 * @param {string} roomID
 * @returns {Promise<{mxid: string, deviceID: string}[]>}
 */
async function getRoomCallMembers(roomID) {
	return parseCallMembers(await api.getAllState(roomID))
}

/**
 * Write the membership content for one user, sent as that user.
 * @param {string} roomID
 * @param {string} mxid
 * @param {number} createdTs
 * @param {number} now
 */
async function sendMembership(roomID, mxid, createdTs, now) {
	const focus = await getFocus()
	if (!focus) throw new Error(`[voice] no LiveKit focus available, cannot join call in ${roomID}`)
	await api.sendState(roomID, CALL_MEMBER_TYPE, stateKeyFor(mxid), {
		application: "m.call",
		call_id: "",
		scope: "m.room",
		device_id: VOICE_DEVICE_ID,
		focus_active: {type: "livekit", focus_selection: "oldest_membership"},
		foci_preferred: [{type: "livekit", livekit_service_url: focus.serviceUrl, livekit_alias: roomID}],
		created_ts: createdTs,
		expires: now - createdTs + MEMBERSHIP_EXPIRES_MS
	}, mxid)
}

/**
 * Leave any of our own leftover memberships in a room (e.g. after a crash).
 * Only clears memberships whose sender is the bridge bot or a sim.
 * @param {string} roomID
 * @returns {Promise<number>} how many memberships were cleared
 */
async function clearStaleOwnMemberships(roomID) {
	const state = await api.getAllState(roomID)
	let count = 0
	for (const event of state) {
		if (!isCallMemberEventType(event.type)) continue
		if (!event.content || Object.keys(event.content).length === 0) continue
		const sender = event.sender
		if (!(sender === mxUtils.bot || mxUtils.eventSenderIsFromDiscord(sender))) continue
		try {
			await api.sendState(roomID, event.type, event.state_key, {}, sender)
			count++
		} catch (e) {
			console.error(`[voice] failed to clear stale membership ${event.state_key} in ${roomID}:`, e)
		}
	}
	return count
}

class MembershipManager {
	/**
	 * @param {{now?: () => number}} [options] `now` is injectable for tests
	 */
	constructor(options = {}) {
		/** @type {Map<string, number>} `${roomID}|${mxid}` to created_ts */
		this.active = new Map()
		/** @type {() => number} */
		this.now = options.now ?? (() => Date.now())
		/** @type {NodeJS.Timeout | null} */
		this.timer = null
	}

	/**
	 * Join the call as mxid. Re-joining keeps the original created_ts.
	 * Throws if the send fails.
	 * @param {string} roomID
	 * @param {string} mxid
	 */
	async join(roomID, mxid) {
		const key = membershipKey(roomID, mxid)
		const createdTs = this.active.get(key) ?? this.now()
		await sendMembership(roomID, mxid, createdTs, this.now())
		this.active.set(key, createdTs)
		this.ensureTimer()
	}

	/**
	 * Leave the call as mxid. Best effort: errors are logged.
	 * @param {string} roomID
	 * @param {string} mxid
	 */
	async leave(roomID, mxid) {
		this.active.delete(membershipKey(roomID, mxid))
		try {
			await api.sendState(roomID, CALL_MEMBER_TYPE, stateKeyFor(mxid), {}, mxid)
		} catch (e) {
			console.error(`[voice] failed to leave call ${roomID} as ${mxid}:`, e)
		}
		if (this.active.size === 0) this.stopTimer()
	}

	/**
	 * Re-send every active membership with a fresh expiry. Never throws.
	 */
	async refresh() {
		try {
			const entries = [...this.active.entries()]
			const results = await Promise.allSettled(entries.map(([key, createdTs]) => {
				const {roomID, mxid} = splitMembershipKey(key)
				return sendMembership(roomID, mxid, createdTs, this.now())
			}))
			results.forEach((result, i) => {
				if (result.status === "rejected") {
					const {roomID, mxid} = splitMembershipKey(entries[i][0])
					console.error(`[voice] failed to refresh call membership ${roomID} as ${mxid}:`, result.reason)
				}
			})
		} catch (e) {
			console.error("[voice] failed to refresh call memberships:", e)
		}
	}

	/**
	 * Leave every active membership. Best effort, for shutdown.
	 */
	async leaveAll() {
		const keys = [...this.active.keys()]
		await Promise.allSettled(keys.map(key => {
			const {roomID, mxid} = splitMembershipKey(key)
			return this.leave(roomID, mxid)
		}))
		this.stopTimer()
	}

	ensureTimer() {
		if (this.timer) return
		this.timer = setInterval(() => {
			this.refresh()
		}, REFRESH_INTERVAL_MS)
		this.timer.unref()
	}

	stopTimer() {
		if (this.timer) clearInterval(this.timer)
		this.timer = null
	}
}

const memberships = new MembershipManager()

module.exports.VOICE_DEVICE_ID = VOICE_DEVICE_ID
module.exports.CALL_MEMBER_TYPE = CALL_MEMBER_TYPE
module.exports.isCallMemberEventType = isCallMemberEventType
module.exports.parseCallMembers = parseCallMembers
module.exports.getRoomCallMembers = getRoomCallMembers
module.exports.clearStaleOwnMemberships = clearStaleOwnMemberships
module.exports.getFocus = getFocus
module.exports.getOpenIdToken = getOpenIdToken
module.exports.getLiveKitCredentials = getLiveKitCredentials
module.exports.MembershipManager = MembershipManager
module.exports.memberships = memberships
module.exports._resetFocusCache = _resetFocusCache
