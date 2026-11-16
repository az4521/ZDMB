// @ts-check

const {test} = require("supertape")
const passthrough = require("../passthrough")
const {sync} = passthrough
const api = sync.require("../matrix/api")
const mreq = sync.require("../matrix/mreq")
const mxUtils = sync.require("../matrix/utils")
const matrixRTC = require("./matrix-rtc")

const ROOM = "!voicetest:cadence.moe"
const MXID = "@_ooye_speaker:cadence.moe"
const SIM = "@_ooye_sim_speaker:cadence.moe"
const HUMAN = "@alice:example.org"
const SERVICE = "https://livekit.example.org"
const HOUR = 60 * 60 * 1000
const T0 = 1_800_000_000_000
const WELL_KNOWN = `https://cadence.moe/.well-known/matrix/client`

/**
 * Replaces fetch, mreq and the state-sending API. Returns a function that restores them.
 * @param {{wellKnown?: any, transports?: any, sfuResponse?: any, openid?: any, allState?: any[]}} [options]
 */
function stub(options = {}) {
	const realFetch = matrixRTC._fetch
	const realMreq = mreq.mreq
	const realSendState = api.sendState
	const realGetAllState = api.getAllState

	const calls = {fetch: /** @type {{url: string, init: any}[]} */ ([]), mreq: /** @type {any[][]} */ ([]), sendState: /** @type {any[]} */ ([])}

	matrixRTC._fetch = async (url, init) => {
		calls.fetch.push({url, init})
		if (url === WELL_KNOWN) {
			if (options.wellKnown === undefined) return /** @type {any} */ ({ok: false, status: 404})
			return /** @type {any} */ ({ok: true, status: 200, json: async () => options.wellKnown})
		}
		if (url.endsWith("/sfu/get")) {
			const r = options.sfuResponse ?? {ok: true, status: 200, json: async () => ({url: "wss://lk.example/room", jwt: "jwt-value"})}
			return /** @type {any} */ (r)
		}
		throw new Error("unexpected fetch " + url)
	}
	// @ts-ignore
	mreq.mreq = async (method, path, body) => {
		calls.mreq.push([method, path, body])
		if (path === "/client/v1/rtc/transports") {
			if (options.transports === undefined) throw new Error("no transports")
			return options.transports
		}
		if (path.includes("/openid/request_token")) {
			return options.openid ?? {access_token: "tok", token_type: "Bearer", matrix_server_name: "cadence.moe", expires_in: 3600}
		}
		throw new Error("unexpected mreq " + path)
	}
	// @ts-ignore
	api.sendState = async (roomID, type, stateKey, content, mxid) => {
		calls.sendState.push({roomID, type, stateKey, content, mxid})
		return "$event"
	}
	// @ts-ignore
	api.getAllState = async () => options.allState ?? []

	return {
		calls,
		restore() {
			matrixRTC._fetch = realFetch
			mreq.mreq = realMreq
			// @ts-ignore
			api.sendState = realSendState
			// @ts-ignore
			api.getAllState = realGetAllState
			matrixRTC._resetFocusCache()
		}
	}
}

const LIVEKIT_WELL_KNOWN = {"org.matrix.msc4143.rtc_foci": [{type: "livekit", livekit_service_url: SERVICE}]}

test("rtc: parseCallMembers keeps live memberships of both event types", t => {
	const members = matrixRTC.parseCallMembers([
		{type: "org.matrix.msc3401.call.member", state_key: "_a", sender: HUMAN, content: {device_id: "PHONE", created_ts: T0, expires: 4 * HOUR}, origin_server_ts: T0},
		{type: "m.call.member", state_key: "_b", sender: "@bob:example.org", content: {device_id: "DESK", created_ts: T0}, origin_server_ts: T0},
	], T0 + HOUR)
	t.deepEqual(members, [{mxid: HUMAN, deviceID: "PHONE"}, {mxid: "@bob:example.org", deviceID: "DESK"}])
})

test("rtc: parseCallMembers drops expired memberships", t => {
	const members = matrixRTC.parseCallMembers([
		{type: "org.matrix.msc3401.call.member", state_key: "_a", sender: HUMAN, content: {device_id: "PHONE", created_ts: T0, expires: HOUR}, origin_server_ts: T0},
		{type: "org.matrix.msc3401.call.member", state_key: "_b", sender: "@bob:example.org", content: {device_id: "DESK", created_ts: T0 + HOUR, expires: HOUR}, origin_server_ts: T0},
	], T0 + 90 * 60 * 1000)
	t.deepEqual(members, [{mxid: "@bob:example.org", deviceID: "DESK"}])
})

test("rtc: parseCallMembers uses origin_server_ts and default 4h expiry when created_ts is missing", t => {
	const members = matrixRTC.parseCallMembers([
		{type: "org.matrix.msc3401.call.member", state_key: "_a", sender: HUMAN, content: {device_id: "PHONE"}, origin_server_ts: T0},
	], T0 + 3 * HOUR)
	t.deepEqual(members, [{mxid: HUMAN, deviceID: "PHONE"}])
	const expired = matrixRTC.parseCallMembers([
		{type: "org.matrix.msc3401.call.member", state_key: "_a", sender: HUMAN, content: {device_id: "PHONE"}, origin_server_ts: T0},
	], T0 + 5 * HOUR)
	t.deepEqual(expired, [])
})

test("rtc: parseCallMembers ignores leave, empty content, missing device and m.rtc.member", t => {
	const members = matrixRTC.parseCallMembers([
		{type: "org.matrix.msc3401.call.member", state_key: "_a", sender: HUMAN, content: {device_id: "PHONE", membership: "leave", created_ts: T0}, origin_server_ts: T0},
		{type: "org.matrix.msc3401.call.member", state_key: "_b", sender: "@bob:example.org", content: {}, origin_server_ts: T0},
		{type: "org.matrix.msc3401.call.member", state_key: "_c", sender: "@carol:example.org", content: {created_ts: T0}, origin_server_ts: T0},
		{type: "org.matrix.msc4143.rtc.member", state_key: "_d", sender: "@dan:example.org", content: {device_id: "X", created_ts: T0}, origin_server_ts: T0},
		{type: "m.room.member", state_key: "@eve:example.org", sender: "@eve:example.org", content: {device_id: "Y", created_ts: T0}, origin_server_ts: T0},
	], T0)
	t.deepEqual(members, [])
})

test("rtc: parseCallMembers reads device_id from content.member and deduplicates", t => {
	const members = matrixRTC.parseCallMembers([
		{type: "org.matrix.msc3401.call.member", state_key: "_a", sender: HUMAN, content: {member: {device_id: "PHONE"}, created_ts: T0}, origin_server_ts: T0},
		{type: "org.matrix.msc3401.call.member", state_key: "_a2", sender: HUMAN, content: {device_id: "PHONE", created_ts: T0}, origin_server_ts: T0},
		{type: "org.matrix.msc3401.call.member", state_key: "_a3", sender: HUMAN, content: {device_id: "OTHER", created_ts: T0}, origin_server_ts: T0},
	], T0)
	t.deepEqual(members, [{mxid: HUMAN, deviceID: "PHONE"}, {mxid: HUMAN, deviceID: "OTHER"}])
})

test("rtc: join sends membership content with the expected state key and sender", async t => {
	matrixRTC._resetFocusCache()
	const s = stub({wellKnown: LIVEKIT_WELL_KNOWN})
	try {
		const m = new matrixRTC.MembershipManager({now: () => T0})
		await m.join(ROOM, MXID)
		t.equal(s.calls.sendState.length, 1)
		const call = s.calls.sendState[0]
		t.equal(call.roomID, ROOM)
		t.equal(call.type, "org.matrix.msc3401.call.member")
		t.equal(call.stateKey, `_${MXID}_ZDMBVOICE_m.call`)
		t.equal(call.mxid, MXID)
		t.deepEqual(call.content, {
			application: "m.call",
			call_id: "",
			scope: "m.room",
			device_id: "ZDMBVOICE",
			focus_active: {type: "livekit", focus_selection: "oldest_membership"},
			foci_preferred: [{type: "livekit", livekit_service_url: SERVICE, livekit_alias: ROOM}],
			created_ts: T0,
			expires: 4 * HOUR
		})
		m.stopTimer()
	} finally {
		s.restore()
	}
})

test("rtc: rejoining keeps created_ts", async t => {
	matrixRTC._resetFocusCache()
	const s = stub({wellKnown: LIVEKIT_WELL_KNOWN})
	try {
		const m = new matrixRTC.MembershipManager({now: () => T0})
		await m.join(ROOM, MXID)
		m.now = () => T0 + HOUR
		await m.join(ROOM, MXID)
		t.equal(s.calls.sendState[1].content.created_ts, T0)
		t.equal(s.calls.sendState[1].content.expires, HOUR + 4 * HOUR)
		m.stopTimer()
	} finally {
		s.restore()
	}
})

test("rtc: refresh keeps created_ts and grows expires", async t => {
	matrixRTC._resetFocusCache()
	const s = stub({wellKnown: LIVEKIT_WELL_KNOWN})
	try {
		const m = new matrixRTC.MembershipManager({now: () => T0})
		await m.join(ROOM, MXID)
		m.now = () => T0 + 2 * HOUR
		await m.refresh()
		t.equal(s.calls.sendState.length, 2)
		const refreshed = s.calls.sendState[1].content
		t.equal(refreshed.created_ts, T0)
		t.equal(refreshed.expires, 2 * HOUR + 4 * HOUR)
		// expiry time (created + expires) is now + 4h
		t.equal(refreshed.created_ts + refreshed.expires, T0 + 6 * HOUR)
		m.stopTimer()
	} finally {
		s.restore()
	}
})

test("rtc: refresh swallows errors", async t => {
	matrixRTC._resetFocusCache()
	const s = stub({wellKnown: LIVEKIT_WELL_KNOWN})
	const realConsoleError = console.error
	console.error = () => {}
	try {
		const m = new matrixRTC.MembershipManager({now: () => T0})
		await m.join(ROOM, MXID)
		// @ts-ignore
		api.sendState = async () => { throw new Error("homeserver down") }
		await m.refresh()
		t.ok(true, "did not reject")
		m.stopTimer()
	} finally {
		console.error = realConsoleError
		s.restore()
	}
})

test("rtc: leave sends an empty membership on the same state key and forgets it", async t => {
	matrixRTC._resetFocusCache()
	const s = stub({wellKnown: LIVEKIT_WELL_KNOWN})
	try {
		const m = new matrixRTC.MembershipManager({now: () => T0})
		await m.join(ROOM, MXID)
		await m.leave(ROOM, MXID)
		const leave = s.calls.sendState[1]
		t.deepEqual(leave.content, {})
		t.equal(leave.stateKey, `_${MXID}_ZDMBVOICE_m.call`)
		t.equal(leave.mxid, MXID)
		t.equal(m.active.size, 0)
		// refresh after leave sends nothing
		await m.refresh()
		t.equal(s.calls.sendState.length, 2)
	} finally {
		s.restore()
	}
})

test("rtc: leaveAll leaves everything", async t => {
	matrixRTC._resetFocusCache()
	const s = stub({wellKnown: LIVEKIT_WELL_KNOWN})
	try {
		const m = new matrixRTC.MembershipManager({now: () => T0})
		await m.join(ROOM, MXID)
		await m.join(ROOM, SIM)
		await m.leaveAll()
		t.equal(m.active.size, 0)
		const leaves = s.calls.sendState.slice(2).map(c => [c.mxid, c.content])
		t.deepEqual(leaves.sort(), [[MXID, {}], [SIM, {}]].sort())
	} finally {
		s.restore()
	}
})

test("rtc: getFocus reads .well-known, falls back to transports, and caches", async t => {
	matrixRTC._resetFocusCache()
	const s = stub({wellKnown: LIVEKIT_WELL_KNOWN})
	try {
		const first = await matrixRTC.getFocus()
		const second = await matrixRTC.getFocus()
		t.deepEqual(first, {serviceUrl: SERVICE})
		t.deepEqual(second, {serviceUrl: SERVICE})
		t.equal(s.calls.fetch.filter(c => c.url === WELL_KNOWN).length, 1, "well-known fetched once")
	} finally {
		s.restore()
	}

	matrixRTC._resetFocusCache()
	const s2 = stub({wellKnown: {}, transports: {rtc_transports: [{type: "livekit", livekit_service_url: "https://other.example"}]}})
	try {
		t.deepEqual(await matrixRTC.getFocus(), {serviceUrl: "https://other.example"})
	} finally {
		s2.restore()
	}

	matrixRTC._resetFocusCache()
	const s3 = stub({wellKnown: {}})
	try {
		t.equal(await matrixRTC.getFocus(), null)
	} finally {
		s3.restore()
	}
})

test("rtc: getLiveKitCredentials posts the legacy body without member and returns url and jwt", async t => {
	matrixRTC._resetFocusCache()
	const openid = {access_token: "openid-abc", token_type: "Bearer", matrix_server_name: "cadence.moe", expires_in: 3600}
	const s = stub({wellKnown: LIVEKIT_WELL_KNOWN, openid})
	try {
		const result = await matrixRTC.getLiveKitCredentials(MXID, ROOM)
		t.deepEqual(result, {url: "wss://lk.example/room", jwt: "jwt-value"})

		const openidCall = s.calls.mreq.find(c => c[1].includes("/openid/request_token"))
		t.equal(openidCall[0], "POST")
		t.equal(openidCall[1], api.path(api.route`/client/v3/user/${MXID}/openid/request_token`, MXID))
		t.deepEqual(openidCall[2], {})

		const sfu = s.calls.fetch.find(c => c.url.endsWith("/sfu/get"))
		t.equal(sfu.url, `${SERVICE}/sfu/get`)
		t.equal(sfu.init.method, "POST")
		const body = JSON.parse(sfu.init.body)
		t.deepEqual(Object.keys(body).sort(), ["device_id", "openid_token", "room"])
		t.equal(body.room, ROOM)
		t.equal(body.device_id, "ZDMBVOICE")
		t.deepEqual(body.openid_token, openid)
		t.equal("member" in body, false)
	} finally {
		s.restore()
	}
})

test("rtc: getLiveKitCredentials accepts token as alias and strips trailing slash", async t => {
	matrixRTC._resetFocusCache()
	const s = stub({
		wellKnown: {"org.matrix.msc4143.rtc_foci": [{type: "livekit", livekit_service_url: SERVICE + "/"}]},
		sfuResponse: {ok: true, status: 200, json: async () => ({url: "wss://x", token: "t"})}
	})
	try {
		t.deepEqual(await matrixRTC.getLiveKitCredentials(MXID, ROOM), {url: "wss://x", jwt: "t"})
		t.equal(s.calls.fetch.find(c => c.url.endsWith("/sfu/get")).url, `${SERVICE}/sfu/get`)
	} finally {
		s.restore()
	}
})

test("rtc: getLiveKitCredentials throws with status and body on non-2xx", async t => {
	matrixRTC._resetFocusCache()
	const s = stub({
		wellKnown: LIVEKIT_WELL_KNOWN,
		sfuResponse: {ok: false, status: 403, text: async () => "forbidden by policy"}
	})
	try {
		await matrixRTC.getLiveKitCredentials(MXID, ROOM)
		t.fail("should have thrown")
	} catch (e) {
		t.ok(e.message.includes("403"), "message includes status")
		t.ok(e.message.includes("forbidden by policy"), "message includes body")
	} finally {
		s.restore()
	}
})

test("rtc: getLiveKitCredentials throws a clear error when there is no focus", async t => {
	matrixRTC._resetFocusCache()
	const s = stub({wellKnown: {}})
	try {
		await matrixRTC.getLiveKitCredentials(MXID, ROOM)
		t.fail("should have thrown")
	} catch (e) {
		t.ok(e.message.includes("LiveKit focus"))
	} finally {
		s.restore()
	}
})

test("rtc: clearStaleOwnMemberships only clears bot and sim memberships", async t => {
	matrixRTC._resetFocusCache()
	const allState = [
		{type: "org.matrix.msc3401.call.member", state_key: `_${mxUtils.bot}_ZDMBVOICE_m.call`, sender: mxUtils.bot, content: {device_id: "ZDMBVOICE", created_ts: T0}, origin_server_ts: T0},
		{type: "org.matrix.msc3401.call.member", state_key: `_${SIM}_ZDMBVOICE_m.call`, sender: SIM, content: {device_id: "ZDMBVOICE", created_ts: T0}, origin_server_ts: T0},
		{type: "org.matrix.msc3401.call.member", state_key: `_${HUMAN}_PHONE_m.call`, sender: HUMAN, content: {device_id: "PHONE", created_ts: T0}, origin_server_ts: T0},
		{type: "org.matrix.msc3401.call.member", state_key: `_${SIM}_OLD_m.call`, sender: SIM, content: {}, origin_server_ts: T0},
		{type: "m.room.member", state_key: SIM, sender: SIM, content: {membership: "join"}, origin_server_ts: T0},
	]
	const s = stub({allState})
	try {
		const count = await matrixRTC.clearStaleOwnMemberships(ROOM)
		t.equal(count, 2)
		t.deepEqual(s.calls.sendState, [
			{roomID: ROOM, type: "org.matrix.msc3401.call.member", stateKey: `_${mxUtils.bot}_ZDMBVOICE_m.call`, content: {}, mxid: mxUtils.bot},
			{roomID: ROOM, type: "org.matrix.msc3401.call.member", stateKey: `_${SIM}_ZDMBVOICE_m.call`, content: {}, mxid: SIM},
		])
	} finally {
		s.restore()
	}
})
