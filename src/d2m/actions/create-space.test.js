// @ts-check

const mixin = require("@cloudrac3r/mixin-deep")
const {guildToKState, ensureSpace, createSpace} = require("./create-space")
const {DEFAULT_PRIVACY_LEVEL} = require("./create-room")
const {kstateStripConditionals, kstateUploadMxc} = require("../../matrix/kstate")
const api = require("../../matrix/api")
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
