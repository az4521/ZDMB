// @ts-check

const {test} = require("supertape")
const passthrough = require("../../passthrough")
const api = require("../../matrix/api")
const file = require("../../matrix/file")
const syncBanner = require("./sync-banner")
const {discord} = passthrough

const FIELD = "chat.commet.profile_banner"
const MXID = "@_ooye_test_banner:cadence.moe"

/**
 * Replaces the Discord lookup and Matrix calls, and returns a function that restores them.
 * @param {{banner: string | null}[]} users successive results from GET /users/{id}
 * @param {{profile?: Record<string, any>}} [options]
 */
function stub(users, options = {}) {
	const d = /** @type {any} */ (discord)
	const realSnow = d.snow
	const realSetField = api.profileSetField
	const realGetProfile = api.getProfile
	const realUpload = file.uploadDiscordFileToMxc

	const calls = {getUser: [], setField: [], getProfile: [], upload: []}
	d.snow = {user: {getUser: async (/** @type {string} */ id) => {
		calls.getUser.push(id)
		return users[Math.min(calls.getUser.length - 1, users.length - 1)]
	}}}
	// @ts-ignore
	api.profileSetField = async (/** @type {string} */ mxid, /** @type {string} */ key, /** @type {any} */ value) => {
		calls.setField.push({mxid, key, value})
	}
	// @ts-ignore
	api.getProfile = async (/** @type {string} */ mxid) => {
		calls.getProfile.push(mxid)
		return options.profile ?? {}
	}
	// @ts-ignore
	file.uploadDiscordFileToMxc = async (/** @type {string} */ url) => {
		calls.upload.push(url)
		return "mxc://cadence.moe/banner" + calls.upload.length
	}

	return {
		calls,
		restore() {
			d.snow = realSnow
			// @ts-ignore
			api.profileSetField = realSetField
			// @ts-ignore
			api.getProfile = realGetProfile
			// @ts-ignore
			file.uploadDiscordFileToMxc = realUpload
		}
	}
}

test("sync banner: bannerUrl gives png, gif or null", t => {
	t.equal(syncBanner.bannerUrl("123", null), null)
	t.equal(syncBanner.bannerUrl("123", undefined), null)
	t.equal(syncBanner.bannerUrl("123", "abc"), "https://cdn.discordapp.com/banners/123/abc.png?size=1024")
	t.equal(syncBanner.bannerUrl("123", "a_abc"), "https://cdn.discordapp.com/banners/123/a_abc.gif?size=1024")
})

test("sync banner: banner present sets the profile field to the mxc URI", async t => {
	syncBanner._reset()
	syncBanner.politeness.gapMs = 0
	const s = stub([{banner: "abc"}])
	try {
		await syncBanner.maybeSyncBanner("100000000000000001", MXID)
		t.deepEqual(s.calls.getUser, ["100000000000000001"])
		t.deepEqual(s.calls.upload, ["https://cdn.discordapp.com/banners/100000000000000001/abc.png?size=1024"])
		t.deepEqual(s.calls.setField, [{mxid: MXID, key: FIELD, value: "mxc://cadence.moe/banner1"}])
	} finally {
		s.restore()
		syncBanner._reset()
	}
})

test("sync banner: second call within 24 hours does not fetch again", async t => {
	syncBanner._reset()
	syncBanner.politeness.gapMs = 0
	const s = stub([{banner: "abc"}])
	try {
		await syncBanner.maybeSyncBanner("100000000000000002", MXID)
		await syncBanner.maybeSyncBanner("100000000000000002", MXID)
		t.equal(s.calls.getUser.length, 1)
		t.equal(s.calls.setField.length, 1)
	} finally {
		s.restore()
		syncBanner._reset()
	}
})

test("sync banner: no banner and profile has the field deletes it", async t => {
	syncBanner._reset()
	syncBanner.politeness.gapMs = 0
	const s = stub([{banner: null}], {profile: {[FIELD]: "mxc://cadence.moe/old"}})
	try {
		await syncBanner.maybeSyncBanner("100000000000000003", MXID)
		t.deepEqual(s.calls.getProfile, [MXID])
		t.deepEqual(s.calls.setField, [{mxid: MXID, key: FIELD, value: null}])
	} finally {
		s.restore()
		syncBanner._reset()
	}
})

test("sync banner: no banner and profile lacks the field does not delete", async t => {
	syncBanner._reset()
	syncBanner.politeness.gapMs = 0
	const s = stub([{banner: null}], {profile: {displayname: "someone"}})
	try {
		await syncBanner.maybeSyncBanner("100000000000000004", MXID)
		t.deepEqual(s.calls.getProfile, [MXID])
		t.equal(s.calls.setField.length, 0)
	} finally {
		s.restore()
		syncBanner._reset()
	}
})

test("sync banner: non-snowflake IDs are skipped", async t => {
	syncBanner._reset()
	syncBanner.politeness.gapMs = 0
	const s = stub([{banner: "abc"}])
	try {
		await syncBanner.maybeSyncBanner("webhook_abc", MXID)
		t.equal(s.calls.getUser.length, 0)
	} finally {
		s.restore()
		syncBanner._reset()
	}
})

test("sync banner: errors are swallowed", async t => {
	syncBanner._reset()
	syncBanner.politeness.gapMs = 0
	const d = /** @type {any} */ (discord)
	const realSnow = d.snow
	d.snow = {user: {getUser: async () => { throw new Error("rate limited") }}}
	try {
		await syncBanner.maybeSyncBanner("100000000000000005", MXID)
		t.ok(true, "did not reject")
	} finally {
		d.snow = realSnow
		syncBanner._reset()
	}
})
