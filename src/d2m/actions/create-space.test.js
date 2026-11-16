// @ts-check

const mixin = require("@cloudrac3r/mixin-deep")
const {guildToKState, ensureSpace, createSpace, syncSpaceExpressions} = require("./create-space")
const {DEFAULT_PRIVACY_LEVEL} = require("./create-room")
const {kstateStripConditionals, kstateUploadMxc} = require("../../matrix/kstate")
const api = require("../../matrix/api")
const file = require("../../matrix/file")
const mreq = require("../../matrix/mreq")
const {test} = require("supertape")
const testData = require("../../../test/data")

const passthrough = require("../../passthrough")
const {db, select} = passthrough

test("createSpace: new space is stored with the default privacy level", async t => {
	const guildID = "999000000000000001"
	const realCreateRoom = api.createRoom
	const realGetStateEventOuter = api.getStateEventOuter
	db.prepare("INSERT INTO guild_active (guild_id, autocreate) VALUES (?, 1)").run(guildID) // guild_space references guild_active
	// @ts-ignore
	api.createRoom = async () => "!newspace:cadence.moe"
	// @ts-ignore
	api.getStateEventOuter = async (roomID, type, key) => ({type, state_key: key, content: {}, event_id: "$create", origin_server_ts: 0, room_id: roomID, sender: "@_ooye_bot:cadence.moe"})
	try {
		// @ts-ignore
		await createSpace({id: guildID, name: "Privacy test", member_count: 2}, {"m.room.name/": {name: "Privacy test"}})
		t.equal(select("guild_space", "privacy_level", {guild_id: guildID}).pluck().get(), DEFAULT_PRIVACY_LEVEL)
	} finally {
		api.createRoom = realCreateRoom
		api.getStateEventOuter = realGetStateEventOuter
		db.prepare("DELETE FROM guild_space WHERE guild_id = ?").run(guildID)
		db.prepare("DELETE FROM guild_active WHERE guild_id = ?").run(guildID)
	}
})

test("guild2space: can generate kstate for a guild, passing privacy level 0", async t => {
	t.deepEqual(
		await kstateUploadMxc(kstateStripConditionals(await guildToKState(testData.guild.general, 0))),
		{
			"m.room.create/": {
				additional_creators: ["@test_auto_invite:example.org"],
				type: "m.space"
			},
			"m.room.avatar/": {
				url: "mxc://cadence.moe/zKXGZhmImMHuGQZWJEFKJbsF"
			},
			"m.room.guest_access/": {
				guest_access: "can_join"
			},
			"m.room.history_visibility/": {
				history_visibility: "invited"
			},
			"m.room.join_rules/": {
				join_rule: "invite"
			},
			"m.room.name/": {
				name: "Psychonauts 3"
			},
			"m.room.power_levels/": {
				users: {
					"@test_auto_invite:example.org": 150
				},
			},
		}
	)
})

test("syncSpaceExpressions: sends the soundboard pack with the moe.crafty state type and state key", async t => {
	const guildID = "999000000000000003"
	const spaceID = "!soundspace:cadence.moe"
	const passthroughDiscord = require("../../passthrough").discord
	const realSendState = api.sendState
	const realGetStateEvent = api.getStateEvent
	const realUpload = file.uploadDiscordFileToMxc
	/** @type {any[][]} */
	const sent = []
	db.prepare("INSERT INTO guild_active (guild_id, autocreate) VALUES (?, 1)").run(guildID) // guild_space references guild_active
	db.prepare("INSERT INTO guild_space (guild_id, space_id, privacy_level) VALUES (?, ?, ?)").run(guildID, spaceID, 0)
	passthroughDiscord.guilds.set(guildID, {id: guildID, name: "Sound space"})
	// @ts-ignore
	api.sendState = async (...args) => { sent.push(args) }
	// @ts-ignore
	api.getStateEvent = async () => { throw new mreq.MatrixServerError({errcode: "M_NOT_FOUND"}, 404) }
	// @ts-ignore
	file.uploadDiscordFileToMxc = async url => `mxc://cadence.moe/${url.split("/").pop()}`
	try {
		// @ts-ignore
		await syncSpaceExpressions({guild_id: guildID, soundboard_sounds: [{sound_id: "5", name: "boop", volume: 1, emoji_id: null, emoji_name: null, guild_id: guildID, available: true}]}, false)
		t.deepEqual(sent.map(([space, type, key, content]) => [space, type, key, Object.keys(content.sounds)]), [[spaceID, "moe.crafty.room_soundboard", "moe.crafty.zdmb.pack.sounds", ["boop"]]])
	} finally {
		api.sendState = realSendState
		api.getStateEvent = realGetStateEvent
		file.uploadDiscordFileToMxc = realUpload
		passthroughDiscord.guilds.delete(guildID)
		db.prepare("DELETE FROM guild_space WHERE guild_id = ?").run(guildID)
		db.prepare("DELETE FROM guild_active WHERE guild_id = ?").run(guildID)
	}
})

test("syncSpaceExpressions: deleting the last soundboard sound sends an empty pack when a pack exists", async t => {
	const guildID = "999000000000000004"
	const spaceID = "!soundspace2:cadence.moe"
	const passthroughDiscord = require("../../passthrough").discord
	const realSendState = api.sendState
	const realGetStateEvent = api.getStateEvent
	/** @type {any[][]} */
	const sent = []
	db.prepare("INSERT INTO guild_active (guild_id, autocreate) VALUES (?, 1)").run(guildID)
	db.prepare("INSERT INTO guild_space (guild_id, space_id, privacy_level) VALUES (?, ?, ?)").run(guildID, spaceID, 0)
	passthroughDiscord.guilds.set(guildID, {id: guildID, name: "Sound space"})
	// @ts-ignore
	api.sendState = async (...args) => { sent.push(args) }
	// Existing pack has one sound in it
	// @ts-ignore
	api.getStateEvent = async () => ({pack: {display_name: "Sound space (Discord Sounds)"}, sounds: {boop: {url: "mxc://cadence.moe/5", body: "boop", info: {mimetype: "audio/mpeg"}}}})
	try {
		// @ts-ignore
		await syncSpaceExpressions({guild_id: guildID, soundboard_sounds: []}, true)
		t.deepEqual(sent, [[spaceID, "moe.crafty.room_soundboard", "moe.crafty.zdmb.pack.sounds", {pack: {display_name: "Sound space (Discord Sounds)"}, sounds: {}}]])
	} finally {
		api.sendState = realSendState
		api.getStateEvent = realGetStateEvent
		passthroughDiscord.guilds.delete(guildID)
		db.prepare("DELETE FROM guild_space WHERE guild_id = ?").run(guildID)
		db.prepare("DELETE FROM guild_active WHERE guild_id = ?").run(guildID)
	}
})

test("syncSpaceExpressions: an empty soundboard list does nothing when no pack exists yet", async t => {
	const guildID = "999000000000000005"
	const spaceID = "!soundspace3:cadence.moe"
	const passthroughDiscord = require("../../passthrough").discord
	const realSendState = api.sendState
	const realGetStateEvent = api.getStateEvent
	/** @type {any[][]} */
	const sent = []
	db.prepare("INSERT INTO guild_active (guild_id, autocreate) VALUES (?, 1)").run(guildID)
	db.prepare("INSERT INTO guild_space (guild_id, space_id, privacy_level) VALUES (?, ?, ?)").run(guildID, spaceID, 0)
	passthroughDiscord.guilds.set(guildID, {id: guildID, name: "Sound space"})
	// @ts-ignore
	api.sendState = async (...args) => { sent.push(args) }
	// @ts-ignore
	api.getStateEvent = async () => { throw new mreq.MatrixServerError({errcode: "M_NOT_FOUND"}, 404) }
	try {
		// @ts-ignore
		await syncSpaceExpressions({guild_id: guildID, soundboard_sounds: []}, true)
		t.deepEqual(sent, [])
	} finally {
		api.sendState = realSendState
		api.getStateEvent = realGetStateEvent
		passthroughDiscord.guilds.delete(guildID)
		db.prepare("DELETE FROM guild_space WHERE guild_id = ?").run(guildID)
		db.prepare("DELETE FROM guild_active WHERE guild_id = ?").run(guildID)
	}
})
