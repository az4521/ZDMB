// @ts-check

const mixin = require("@cloudrac3r/mixin-deep")
const {channelToKState, _convertNameAndTopic, channelToSpaceOrder, syncSpaceOrder} = require("./create-room")
const api = require("../../matrix/api")
const {kstateStripConditionals} = require("../../matrix/kstate")
const {test} = require("supertape")
const testData = require("../../../test/data")

const passthrough = require("../../passthrough")
const {db, discord} = passthrough

function mockAPI(t) {
	let called = 0
	return {
		getCalled() {
			return called
		},
		async getStateEvent(roomID, type, key) { // getting power levels from space to apply to room
			called++
			t.equal(roomID, "!jjmvBegULiLucuWEHU:cadence.moe")
			t.equal(type, "m.room.power_levels")
			t.equal(key, "")
			return {users: {"@example:matrix.org": 50}, events: {"m.room.tombstone": 100}}
		},
		async getStateEventOuter(roomID, type, key) {
			called++
			t.equal(roomID, "!jjmvBegULiLucuWEHU:cadence.moe")
			t.equal(type, "m.room.create")
			t.equal(key, "")
			return {
				type: "m.room.create",
				state_key: "",
				content: {
					room_version: "11"
				},
				event_id: "$create",
				origin_server_ts: 0,
				room_id: "!jjmvBegULiLucuWEHU:cadence.moe",
				sender: "@_ooye_bot:cadence.moe"
			}
		}
	}
}

test("channel2room: discoverable privacy room", async t => {
	const api = mockAPI(t)
	db.prepare("UPDATE guild_space SET privacy_level = 2").run()
	t.deepEqual(
		kstateStripConditionals(await channelToKState(testData.channel.general, testData.guild.general, {api}).then(x => x.channelKState)),
		Object.assign({}, testData.room.general, {
			"m.room.guest_access/": {guest_access: "forbidden"},
			"m.room.join_rules/": {join_rule: "public"},
			"m.room.history_visibility/": {history_visibility: "world_readable"},
			"m.room.power_levels/": mixin({users: {"@example:matrix.org": 50}}, testData.room.general["m.room.power_levels/"])
		})
	)
	t.equal(api.getCalled(), 2)
})

test("channel2room: linkable privacy room", async t => {
	const api = mockAPI(t)
	db.prepare("UPDATE guild_space SET privacy_level = 1").run()
	t.deepEqual(
		kstateStripConditionals(await channelToKState(testData.channel.general, testData.guild.general, {api}).then(x => x.channelKState)),
		Object.assign({}, testData.room.general, {
			"m.room.guest_access/": {guest_access: "forbidden"},
			"m.room.join_rules/": {join_rule: "public"},
			"m.room.power_levels/": mixin({users: {"@example:matrix.org": 50}}, testData.room.general["m.room.power_levels/"])
		})
	)
	t.equal(api.getCalled(), 2)
})

test("channel2room: invite-only privacy room", async t => {
	const api = mockAPI(t)
	db.prepare("UPDATE guild_space SET privacy_level = 0").run()
	t.deepEqual(
		kstateStripConditionals(await channelToKState(testData.channel.general, testData.guild.general, {api}).then(x => x.channelKState)),
		Object.assign({}, testData.room.general, {
			"m.room.power_levels/": mixin({users: {"@example:matrix.org": 50}}, testData.room.general["m.room.power_levels/"])
		})
	)
	t.equal(api.getCalled(), 2)
})

test("channel2room: room where limited people can mention everyone", async t => {
	const api = mockAPI(t)
	const limitedGuild = mixin({}, testData.guild.general)
	limitedGuild.roles[0].permissions = (BigInt(limitedGuild.roles[0].permissions) - 131072n).toString()
	const limitedRoom = mixin({}, testData.room.general, {"m.room.power_levels/": {
		notifications: {room: 20},
		users: {"@example:matrix.org": 50}
	}})
	t.deepEqual(
		kstateStripConditionals(await channelToKState(testData.channel.general, limitedGuild, {api}).then(x => x.channelKState)),
		limitedRoom
	)
	t.equal(api.getCalled(), 2)
})

test("channel2room: matrix room that already has a custom topic set", async t => {
	const api = mockAPI(t)
	db.prepare("UPDATE channel_room SET custom_topic = 1 WHERE channel_id = ?").run(testData.channel.general.id)
	const expected = mixin({}, testData.room.general, {"m.room.power_levels/": {notifications: {room: 20}, users: {"@example:matrix.org": 50}}})
	// @ts-ignore
	delete expected["m.room.topic/"]
	t.deepEqual(
		kstateStripConditionals(await channelToKState(testData.channel.general, testData.guild.general, {api}).then(x => x.channelKState)),
		expected
	)
	t.equal(api.getCalled(), 2)
})

test("channel2room: read-only discord channel", async t => {
	const api = mockAPI(t)
	const expected = {
		"m.room.create/": {
			additional_creators: ["@test_auto_invite:example.org"],
		},
		"m.room.avatar/": {
			url: {
				$url: "/icons/112760669178241024/a_f83622e09ead74f0c5c527fe241f8f8c.png?size=1024",
			},
		},
		"m.room.guest_access/": {
			guest_access: "can_join",
		},
		"m.room.history_visibility/": {
			history_visibility: "shared",
		},
		"m.room.join_rules/": {
			allow: [
				{
					room_id: "!jjmvBegULiLucuWEHU:cadence.moe",
					type: "m.room_membership",
				},
			],
			join_rule: "restricted",
		},
		"m.room.name/": {
			name: "updates",
		},
		"m.room.topic/": {
      	topic: "Updates and release announcements for Out Of Your Element.\n\nChannel ID: 1161864271370666075\nGuild ID: 112760669178241024"
		},
		"m.room.power_levels/": {
			events_default: 50, // <-- it should be read-only!
			events: {
				"m.reaction": 0,
				"org.matrix.msc3381.poll.response": 0,
				"m.room.redaction": 0
			},
			notifications: {
				room: 20,
			},
			users: {
				"@test_auto_invite:example.org": 150,
				"@example:matrix.org": 50
			},
		},
		"m.space.parent/!jjmvBegULiLucuWEHU:cadence.moe": {
			canonical: true,
			via: [
				"cadence.moe",
			],
		},
		"uk.half-shot.bridge/moe.cadence.ooye://discord/112760669178241024/1161864271370666075": {
			bridgebot: "@_ooye_bot:cadence.moe",
			channel: {
				displayname: "updates",
				external_url: "https://discord.com/channels/112760669178241024/1161864271370666075",
				id: "1161864271370666075",
			},
			network: {
				avatar_url: {
					"$url": "/icons/112760669178241024/a_f83622e09ead74f0c5c527fe241f8f8c.png?size=1024",
				},
				displayname: "Psychonauts 3",
				id: "112760669178241024",
			},
			protocol: {
				displayname: "Discord",
				id: "discord",
			}
		}
	}
	t.deepEqual(
		kstateStripConditionals(await channelToKState(testData.channel.updates, testData.guild.general, {api}).then(x => x.channelKState)),
		expected
	)
	t.equal(api.getCalled(), 2)
})

test("channel2room: voice channel", async t => {
	const api = mockAPI(t)
	const state = kstateStripConditionals(await channelToKState(testData.channel.voice, testData.guild.general, {api}).then(x => x.channelKState))
	t.equal(state["m.room.create/"].type, "org.matrix.msc3417.call")
	t.deepEqual(state["org.matrix.msc3401.call/"], {
		"m.intent": "m.room",
		"m.name": "🍞丨[8user] Piece",
		"m.type": "m.voice"
	})
	// anybody can join calls
	const events = state["m.room.power_levels/"].events
	t.equal(events["org.matrix.msc3401.call.member"], 0)
	t.equal(events["m.call.member"], 0)
	t.equal(events["m.rtc.member"], 0)
})

test("convertNameAndTopic: custom name and topic", t => {
	t.deepEqual(
		_convertNameAndTopic({id: "123", name: "the-twilight-zone", topic: "Spooky stuff here. :ghost:", type: 0}, {id: "456"}, "hauntings"),
		["hauntings", "#the-twilight-zone | Spooky stuff here. :ghost:\n\nChannel ID: 123\nGuild ID: 456"]
	)
})

test("convertNameAndTopic: custom name, no topic", t => {
	t.deepEqual(
		_convertNameAndTopic({id: "123", name: "the-twilight-zone", type: 0}, {id: "456"}, "hauntings"),
		["hauntings", "#the-twilight-zone\n\nChannel ID: 123\nGuild ID: 456"]
	)
})

test("convertNameAndTopic: original name and topic", t => {
	t.deepEqual(
		_convertNameAndTopic({id: "123", name: "the-twilight-zone", topic: "Spooky stuff here. :ghost:", type: 0}, {id: "456"}, null),
		["the-twilight-zone", "Spooky stuff here. :ghost:\n\nChannel ID: 123\nGuild ID: 456"]
	)
})

test("convertNameAndTopic: original name, no topic", t => {
	t.deepEqual(
		_convertNameAndTopic({id: "123", name: "the-twilight-zone", type: 0}, {id: "456"}, null),
		["the-twilight-zone", "Channel ID: 123\nGuild ID: 456"]
	)
})

test("convertNameAndTopic: public thread icon", t => {
	t.deepEqual(
		_convertNameAndTopic({id: "123", name: "the-twilight-zone", topic: "Spooky stuff here. :ghost:", type: 11}, {id: "456"}, null),
		["[⛓️] the-twilight-zone", "Spooky stuff here. :ghost:\n\nChannel ID: 123\nGuild ID: 456"]
	)
})

test("convertNameAndTopic: private thread icon", t => {
	t.deepEqual(
		_convertNameAndTopic({id: "123", name: "the-twilight-zone", topic: "Spooky stuff here. :ghost:", type: 12}, {id: "456"}, null),
		["[🔒⛓️] the-twilight-zone", "Spooky stuff here. :ghost:\n\nChannel ID: 123\nGuild ID: 456"]
	)
})

test("convertNameAndTopic: voice channel icon", t => {
	t.deepEqual(
		_convertNameAndTopic({id: "123", name: "the-twilight-zone", topic: "Spooky stuff here. :ghost:", type: 2}, {id: "456"}, null),
		["[🔊] the-twilight-zone", "Spooky stuff here. :ghost:\n\nChannel ID: 123\nGuild ID: 456"]
	)
})

/** Temporarily puts channels in the Discord cache while the callback runs. */
function withCachedChannels(channels, callback) {
	for (const channel of channels) discord.channels.set(channel.id, channel)
	try {
		return callback()
	} finally {
		for (const channel of channels) discord.channels.delete(channel.id)
	}
}

const orderCategory = {id: "700000000000000001", type: 4, position: 3, name: "Category"} // GuildCategory, so its children are shown at position 4

test("channelToSpaceOrder: uncategorised text channel sorts before categorised channels", t => {
	const uncategorised = {id: "112760669178241024", type: 0, position: 0, parent_id: null}
	t.equal(channelToSpaceOrder(uncategorised), "0000" + "0" + "0000" + "00112760669178241024")
	withCachedChannels([orderCategory], () => {
		const categorised = {id: "700000000000000011", type: 0, position: 0, parent_id: orderCategory.id}
		t.ok(channelToSpaceOrder(uncategorised) < channelToSpaceOrder(categorised))
	})
})

test("channelToSpaceOrder: text channels come before voice channels in the same category", t => {
	withCachedChannels([orderCategory], () => {
		const text = {id: "700000000000000011", type: 0, position: 5, parent_id: orderCategory.id}
		const voice = {id: "700000000000000012", type: 2, position: 0, parent_id: orderCategory.id}
		const textOrder = channelToSpaceOrder(text)
		const voiceOrder = channelToSpaceOrder(voice)
		t.equal(textOrder, "0004" + "0" + "0005" + "00700000000000000011")
		t.equal(voiceOrder, "0004" + "1" + "0000" + "00700000000000000012")
		t.ok(textOrder < voiceOrder)
	})
})

test("channelToSpaceOrder: channel position within category", t => {
	withCachedChannels([orderCategory], () => {
		const first = {id: "700000000000000011", type: 0, position: 9, parent_id: orderCategory.id}
		const second = {id: "700000000000000012", type: 0, position: 10, parent_id: orderCategory.id}
		t.ok(channelToSpaceOrder(first) < channelToSpaceOrder(second), "position 9 sorts before position 10")
	})
})

test("channelToSpaceOrder: thread sorts after its parent and before the next channel", t => {
	withCachedChannels([orderCategory], () => {
		const parent = {id: "700000000000000011", type: 0, position: 5, parent_id: orderCategory.id}
		const thread = {id: "700000000000000013", type: 11, parent_id: parent.id} // PublicThread
		const next = {id: "700000000000000014", type: 0, position: 6, parent_id: orderCategory.id}
		withCachedChannels([parent], () => {
			const parentOrder = channelToSpaceOrder(parent)
			const threadOrder = channelToSpaceOrder(thread)
			const nextOrder = channelToSpaceOrder(next)
			t.equal(threadOrder, parentOrder + "00700000000000000013")
			t.ok(parentOrder < threadOrder)
			t.ok(threadOrder < nextOrder)
		})
	})
})

test("channelToSpaceOrder: thread whose parent is not cached has no order", t => {
	const thread = {id: "700000000000000013", type: 11, parent_id: "700000000000000099"}
	t.equal(channelToSpaceOrder(thread), undefined)
})

test("channelToSpaceOrder: forum and media threads have no order", t => {
	const forum = {id: "700000000000000021", type: 15, position: 0, parent_id: null} // GuildForum
	const media = {id: "700000000000000022", type: 16, position: 0, parent_id: null} // GuildMedia
	withCachedChannels([forum, media], () => {
		t.equal(channelToSpaceOrder({id: "700000000000000031", type: 11, parent_id: forum.id}), undefined)
		t.equal(channelToSpaceOrder({id: "700000000000000032", type: 11, parent_id: media.id}), undefined)
	})
})

test("syncSpaceOrder: fills in a missing order, leaves correct and removed children alone", async t => {
	const guildID = "999000000000000003"
	const spaceID = "!syncorderspace:cadence.moe"
	const category = {id: "700000000000000101", type: 4, position: 3, name: "Category", guild_id: guildID}
	const chanA = {id: "700000000000000111", type: 0, position: 1, parent_id: category.id, guild_id: guildID, name: "a"}
	const chanB = {id: "700000000000000112", type: 0, position: 2, parent_id: category.id, guild_id: guildID, name: "b"}
	const chanD = {id: "700000000000000113", type: 0, position: 3, parent_id: category.id, guild_id: guildID, name: "d"}
	const roomA = "!roomA:cadence.moe"
	const roomB = "!roomB:cadence.moe"
	const roomD = "!roomD:cadence.moe"
	const orderA = "0004" + "0" + "0001" + "00700000000000000111"
	const orderB = "0004" + "0" + "0002" + "00700000000000000112"

	const realGetAllState = api.getAllState
	const realSendState = api.sendState
	const sent = []
	db.prepare("INSERT INTO guild_active (guild_id, autocreate) VALUES (?, 1)").run(guildID)
	db.prepare("INSERT INTO guild_space (guild_id, space_id, presence, privacy_level) VALUES (?, ?, 0, 0)").run(guildID, spaceID)
	const insertRoom = db.prepare("INSERT INTO channel_room (channel_id, room_id, name, nick, thread_parent, guild_id) VALUES (?, ?, ?, NULL, NULL, ?)")
	insertRoom.run(chanA.id, roomA, "a", guildID)
	insertRoom.run(chanB.id, roomB, "b", guildID)
	insertRoom.run(chanD.id, roomD, "d", guildID)
	discord.channels.set(category.id, category)
	discord.channels.set(chanA.id, chanA)
	discord.channels.set(chanB.id, chanB)
	discord.channels.set(chanD.id, chanD)
	try {
		// @ts-ignore
		api.getAllState = async roomID => {
			t.equal(roomID, spaceID)
			return [
				// A: in the space with via, but no order yet
				{type: "m.space.child", state_key: roomA, content: {via: ["cadence.moe"]}},
				// B: in the space with the correct order already
				{type: "m.space.child", state_key: roomB, content: {via: ["cadence.moe"], order: orderB}},
				// D: removed from the space (empty content)
				{type: "m.space.child", state_key: roomD, content: {}}
			]
		}
		// @ts-ignore
		api.sendState = async (roomID, type, stateKey, content) => {
			sent.push({roomID, type, stateKey, content})
			return "$event"
		}

		await syncSpaceOrder(guildID)

		t.deepEqual(sent, [{
			roomID: spaceID,
			type: "m.space.child",
			stateKey: roomA,
			content: {via: ["cadence.moe"], order: orderA}
		}])
	} finally {
		api.getAllState = realGetAllState
		api.sendState = realSendState
		for (const channel of [category, chanA, chanB, chanD]) discord.channels.delete(channel.id)
		db.prepare("DELETE FROM channel_room WHERE guild_id = ?").run(guildID)
		db.prepare("DELETE FROM guild_space WHERE guild_id = ?").run(guildID)
		db.prepare("DELETE FROM guild_active WHERE guild_id = ?").run(guildID)
	}
})

test("channelToSpaceOrder: order strings are at most 50 characters", t => {
	withCachedChannels([orderCategory], () => {
		const channel = {id: "12345678901234567890", type: 2, position: 9999, parent_id: orderCategory.id}
		const order = channelToSpaceOrder(channel)
		t.ok(order)
		t.ok(order.length <= 50)
		const parent = {id: "12345678901234567890", type: 0, position: 9999, parent_id: orderCategory.id}
		withCachedChannels([parent], () => {
			const thread = {id: "12345678901234567891", type: 11, parent_id: parent.id}
			const threadOrder = channelToSpaceOrder(thread)
			t.ok(threadOrder)
			t.ok(threadOrder.length <= 50)
		})
	})
})
