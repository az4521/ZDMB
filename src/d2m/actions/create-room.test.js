// @ts-check

const mixin = require("@cloudrac3r/mixin-deep")
const {channelToKState, _convertNameAndTopic, channelToSpaceOrder, channelToCategoryContent, syncSpaceOrder, threadParentContent, syncRoomMarkers, channelToChannelTag, _syncSpaceMember} = require("./create-room")
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

/** The channel state that every general channel room has, on top of testData.room.general */
const generalTag = {"moe.crafty.zdmb.channel/": {type: "text", name: testData.room.general["m.room.name/"].name}}

test("channel2room: discoverable privacy room", async t => {
	const api = mockAPI(t)
	db.prepare("UPDATE guild_space SET privacy_level = 2").run()
	t.deepEqual(
		kstateStripConditionals(await channelToKState(testData.channel.general, testData.guild.general, {api}).then(x => x.channelKState)),
		Object.assign({}, testData.room.general, generalTag, {
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
		Object.assign({}, testData.room.general, generalTag, {
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
		Object.assign({}, testData.room.general, generalTag, {
			"m.room.power_levels/": mixin({users: {"@example:matrix.org": 50}}, testData.room.general["m.room.power_levels/"])
		})
	)
	t.equal(api.getCalled(), 2)
})

test("channel2room: room where limited people can mention everyone", async t => {
	const api = mockAPI(t)
	const limitedGuild = mixin({}, testData.guild.general)
	limitedGuild.roles[0].permissions = (BigInt(limitedGuild.roles[0].permissions) - 131072n).toString()
	const limitedRoom = mixin({}, testData.room.general, generalTag, {"m.room.power_levels/": {
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
	const expected = mixin({}, testData.room.general, generalTag, {"m.room.power_levels/": {notifications: {room: 20}, users: {"@example:matrix.org": 50}}})
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
		"moe.crafty.zdmb.channel/": {type: "text", name: "updates"},
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
	t.deepEqual(state["moe.crafty.zdmb.channel/"], {type: "voice", name: testData.channel.voice.name})
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
const categoryType = "moe.crafty.zdmb.category"
const channelType = "moe.crafty.zdmb.channel"

test("channelToCategoryContent: channel in a category gets the category", t => {
	const category = {id: "700000000000000041", type: 4, position: 0, name: "Voice Chat"}
	withCachedChannels([category], () => {
		const channel = {id: "700000000000000042", type: 0, parent_id: category.id}
		t.deepEqual(channelToCategoryContent(channel), {id: category.id, name: "Voice Chat"})
	})
})

test("channelToCategoryContent: uncategorised channel has no category", t => {
	t.equal(channelToCategoryContent({id: "700000000000000043", type: 0, parent_id: null}), null)
})

test("channelToCategoryContent: thread has no category, even if its parent is in a category", t => {
	const category = {id: "700000000000000044", type: 4, position: 0, name: "Category"}
	const parent = {id: "700000000000000045", type: 0, position: 0, parent_id: category.id}
	withCachedChannels([category, parent], () => {
		const thread = {id: "700000000000000046", type: 11, parent_id: parent.id}
		t.equal(channelToCategoryContent(thread), null)
	})
})

test("channelToCategoryContent: category that is not cached has no category", t => {
	t.equal(channelToCategoryContent({id: "700000000000000047", type: 0, parent_id: "700000000000000048"}), null)
})

test("channelToCategoryContent: forum channel in a category gets the category", t => {
	const category = {id: "700000000000000049", type: 4, position: 0, name: "Forums"}
	withCachedChannels([category], () => {
		const forum = {id: "700000000000000050", type: 15, parent_id: category.id}
		t.deepEqual(channelToCategoryContent(forum), {id: category.id, name: "Forums"})
	})
})

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
	const categoryContent = {id: category.id, name: category.name}

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
				// A: in the space with via, but no order or category yet
				{type: "m.space.child", state_key: roomA, content: {via: ["cadence.moe"]}},
				// B: in the space with the correct order and category already
				{type: "m.space.child", state_key: roomB, content: {via: ["cadence.moe"], order: orderB, [categoryType]: categoryContent, [channelType]: {type: "text", name: "b"}}},
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
			content: {via: ["cadence.moe"], order: orderA, [categoryType]: categoryContent, [channelType]: {type: "text", name: "a"}}
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

const threadParentKey = "moe.crafty.zdmb.thread_parent/"
const threadParentType = "moe.crafty.zdmb.thread_parent"
const seedParentRoom = "!BnKuBPCvyfOkhcUjEu:cadence.moe" // room of channel 1100319550446252084 in the seed data
const seedThreadID = "1162005314908999790" // thread of that channel in the seed data

/** The thread starter message lives in the parent channel's room, so it needs a message_room row (and its historical room index) before its event_message row. */
function insertStarterMessage() {
	db.prepare("INSERT INTO message_room (message_id, historical_room_index) VALUES (?, (SELECT historical_room_index FROM historical_channel_room WHERE reference_channel_id = '1100319550446252084' LIMIT 1))").run(seedThreadID)
	db.prepare("INSERT INTO event_message (event_id, event_type, event_subtype, message_id, part, reaction_part, source) VALUES (?, 'm.room.message', 'm.text', ?, 0, 0, 1)").run("$threadstarter", seedThreadID)
}
function removeStarterMessage() {
	db.prepare("DELETE FROM event_message WHERE event_id = ?").run("$threadstarter")
	db.prepare("DELETE FROM message_room WHERE message_id = ?").run(seedThreadID)
}

/** Sort helper so that comparisons don't depend on query order. */
function sortSent(list) {
	return [...list].sort((a, b) => `${a.roomID} ${a.stateKey}`.localeCompare(`${b.roomID} ${b.stateKey}`))
}

test("channelToChannelTag: each channel type that has a tag gets its type and the channel name", t => {
	t.deepEqual(channelToChannelTag({type: 0, name: "text"}, null), {type: "text", name: "text"})
	t.deepEqual(channelToChannelTag(testData.channel.voice, null), {type: "voice", name: testData.channel.voice.name})
	t.deepEqual(channelToChannelTag({type: 13, name: "stage"}, null), {type: "stage", name: "stage"})
	t.deepEqual(channelToChannelTag({type: 5, name: "news"}, null), {type: "announcement", name: "news"})
	t.deepEqual(channelToChannelTag({type: 15, name: "forum"}, null), {type: "forum", name: "forum"})
	t.deepEqual(channelToChannelTag({type: 16, name: "media"}, null), {type: "media", name: "media"})
	t.deepEqual(channelToChannelTag({type: 11, name: "thread"}, null), {type: "public_thread", name: "thread"})
	t.deepEqual(channelToChannelTag({type: 12, name: "private"}, null), {type: "private_thread", name: "private"})
	t.deepEqual(channelToChannelTag({type: 10, name: "announce thread"}, null), {type: "announcement_thread", name: "announce thread"})
})

test("channelToChannelTag: custom nick is used as the name", t => {
	t.deepEqual(channelToChannelTag({type: 0, name: "text"}, "Custom"), {type: "text", name: "Custom"})
})

test("channelToChannelTag: channel types without a tag have no tag", t => {
	t.equal(channelToChannelTag({type: 4, name: "category"}, null), null) // category
})

test("threadParentContent: thread gets its parent room and the event of its starter message", t => {
	insertStarterMessage()
	try {
		t.deepEqual(threadParentContent({id: seedThreadID, type: 11, parent_id: "1100319550446252084"}), {
			room_id: seedParentRoom,
			via: ["cadence.moe"],
			event_id: "$threadstarter"
		})
	} finally {
		removeStarterMessage()
	}
})

test("threadParentContent: thread without a starter message omits event_id", t => {
	t.deepEqual(threadParentContent({id: seedThreadID, type: 11, parent_id: "1100319550446252084"}), {
		room_id: seedParentRoom,
		via: ["cadence.moe"]
	})
})

test("channel2room: thread room has the thread parent state", async t => {
	const api = mockAPI(t)
	insertStarterMessage()
	try {
		const thread = {...testData.channel.general, id: seedThreadID, type: 11, parent_id: "1100319550446252084", name: "Hey."}
		const state = await channelToKState(thread, testData.guild.general, {api}).then(x => x.channelKState)
		t.deepEqual(state[threadParentKey], {room_id: seedParentRoom, via: ["cadence.moe"], event_id: "$threadstarter"})
	} finally {
		removeStarterMessage()
	}
})

test("channel2room: non-thread channel has no thread parent state", async t => {
	const api = mockAPI(t)
	const state = await channelToKState(testData.channel.general, testData.guild.general, {api}).then(x => x.channelKState)
	t.equal(state[threadParentKey], undefined)
})

test("channel2room: thread whose parent has no room has no thread parent state", async t => {
	const api = mockAPI(t)
	const thread = {...testData.channel.general, id: "700000000000000301", type: 11, parent_id: "700000000000000399", name: "orphan"}
	const state = await channelToKState(thread, testData.guild.general, {api}).then(x => x.channelKState)
	t.equal(state[threadParentKey], undefined)
})

test("syncRoomMarkers: sends the markers only where they are missing or different, reading only the events each room needs", async t => {
	const guildID = "999000000000000006"
	const parentChannelID = "700000000000000201"
	const parentRoom = "!tpparent:cadence.moe"
	const missingRoom = "!tpmissing:cadence.moe"
	const okRoom = "!tpok:cadence.moe"
	const uncachedRoom = "!tpuncached:cadence.moe"
	const textRoom = "!tptext:cadence.moe"
	const nickRoom = "!tpnick:cadence.moe"
	const uncachedTextRoom = "!tpuncachedtext:cadence.moe"
	const parentChannel = {id: parentChannelID, type: 0, name: "parent", parent_id: null, guild_id: guildID}
	const missingThread = {id: "700000000000000202", type: 11, name: "missing", parent_id: parentChannelID, guild_id: guildID}
	const okThread = {id: "700000000000000203", type: 11, name: "ok", parent_id: parentChannelID, guild_id: guildID}
	const textChannel = {id: "700000000000000205", type: 0, name: "text", parent_id: null, guild_id: guildID}
	const nickChannel = {id: "700000000000000207", type: 0, name: "nicked", parent_id: null, guild_id: guildID}
	const uncachedThreadID = "700000000000000204" // not in the Discord cache, so its parent comes from thread_parent
	const uncachedTextID = "700000000000000206" // not in the Discord cache, and not a thread, so its type is unknown
	const threadContent = {room_id: parentRoom, via: ["cadence.moe"]}
	const parentTag = {type: "text", name: "parent"}
	const threadTag = {type: "public_thread", name: "missing"}

	const realGetStateEvent = api.getStateEvent
	const realSendState = api.sendState
	const sent = []
	/** @type {string[]} */
	const reads = []
	/** @type {Record<string, Record<string, any>>} room ID -> type -> content, for the events that exist */
	const states = {
		[parentRoom]: {},
		[missingRoom]: {},
		[okRoom]: { // both markers already correct
			[threadParentType]: threadContent,
			[channelType]: {type: "public_thread", name: "ok"}
		},
		[uncachedRoom]: {},
		[textRoom]: {[channelType]: {type: "text", name: "text"}},
		[nickRoom]: {}
	}
	db.prepare("INSERT INTO guild_active (guild_id, autocreate) VALUES (?, 1)").run(guildID)
	const insertRoom = db.prepare("INSERT INTO channel_room (channel_id, room_id, name, nick, thread_parent, guild_id) VALUES (?, ?, ?, ?, ?, ?)")
	insertRoom.run(parentChannelID, parentRoom, "parent", null, null, guildID)
	insertRoom.run(missingThread.id, missingRoom, "missing", null, null, guildID)
	insertRoom.run(okThread.id, okRoom, "ok", null, null, guildID)
	insertRoom.run(uncachedThreadID, uncachedRoom, "uncached", null, parentChannelID, guildID)
	insertRoom.run(textChannel.id, textRoom, "text", null, null, guildID)
	insertRoom.run(nickChannel.id, nickRoom, "nicked", "Custom nick", null, guildID)
	insertRoom.run(uncachedTextID, uncachedTextRoom, "uncachedtext", null, null, guildID)
	const cached = [parentChannel, missingThread, okThread, textChannel, nickChannel]
	for (const channel of cached) discord.channels.set(channel.id, channel)
	try {
		// @ts-ignore
		api.getStateEvent = async (roomID, type, key) => {
			t.equal(key, "")
			reads.push(`${roomID} ${type}`)
			const content = states[roomID]?.[type]
			if (content) return content
			throw new Error("M_NOT_FOUND")
		}
		// @ts-ignore
		api.sendState = async (roomID, type, stateKey, content) => {
			sent.push({roomID, type, stateKey, content})
			return "$event"
		}

		await syncRoomMarkers(guildID)

		// only the event types each room needs are read, and none at all for the uncached non-thread row (its type is unknown)
		t.deepEqual(reads.slice().sort(), [
			`${missingRoom} ${channelType}`,
			`${missingRoom} ${threadParentType}`,
			`${nickRoom} ${channelType}`,
			`${okRoom} ${channelType}`,
			`${okRoom} ${threadParentType}`,
			`${parentRoom} ${channelType}`,
			`${textRoom} ${channelType}`,
			`${uncachedRoom} ${channelType}`,
			`${uncachedRoom} ${threadParentType}`
		].sort())
		t.deepEqual(sortSent(sent), sortSent([
			{roomID: parentRoom, type: channelType, stateKey: "", content: parentTag},
			{roomID: missingRoom, type: threadParentType, stateKey: "", content: threadContent},
			{roomID: missingRoom, type: channelType, stateKey: "", content: threadTag},
			{roomID: uncachedRoom, type: threadParentType, stateKey: "", content: threadContent},
			{roomID: uncachedRoom, type: channelType, stateKey: "", content: {type: "public_thread", name: "uncached"}},
			{roomID: nickRoom, type: channelType, stateKey: "", content: {type: "text", name: "Custom nick"}}
		]))
	} finally {
		api.getStateEvent = realGetStateEvent
		api.sendState = realSendState
		for (const channel of cached) discord.channels.delete(channel.id)
		db.prepare("DELETE FROM channel_room WHERE guild_id = ?").run(guildID)
		db.prepare("DELETE FROM guild_active WHERE guild_id = ?").run(guildID)
	}
})

test("_syncSpaceMember: thread child of the space has the thread parent without via", async t => {
	const guildID = "999000000000000007"
	const spaceID = "!tpmemberspace:cadence.moe"
	const threadRoom = "!tpmemberthread:cadence.moe"
	const thread = {id: seedThreadID, type: 11, name: "Hey.", parent_id: "1100319550446252084", guild_id: guildID, thread_metadata: {archived: false}}

	const realGetAllState = api.getAllState
	const realSendState = api.sendState
	const sent = []
	try {
		// @ts-ignore
		api.getAllState = async roomID => {
			t.equal(roomID, spaceID)
			return []
		}
		// @ts-ignore
		api.sendState = async (roomID, type, stateKey, content) => {
			sent.push({roomID, type, stateKey, content})
			return "$event"
		}
		// @ts-ignore
		await _syncSpaceMember(thread, spaceID, threadRoom, guildID)
		t.deepEqual(sent, [{
			roomID: spaceID,
			type: "m.space.child",
			stateKey: threadRoom,
			content: {via: ["cadence.moe"], [threadParentType]: {room_id: seedParentRoom}, [channelType]: {type: "public_thread", name: "Hey."}}
		}])
	} finally {
		api.getAllState = realGetAllState
		api.sendState = realSendState
	}
})

test("syncSpaceOrder: thread children get the thread parent, non-threads and up-to-date children are not re-sent", async t => {
	const guildID = "999000000000000005"
	const guildSpaceID = "!tpguildspace:cadence.moe"
	const category = {id: "700000000000000101", type: 4, position: 3, name: "Category", guild_id: guildID}
	const chanA = {id: "700000000000000111", type: 0, position: 1, parent_id: category.id, guild_id: guildID, name: "a"}
	const thread1 = {id: "700000000000000131", type: 11, parent_id: chanA.id, guild_id: guildID, name: "t1"}
	const thread2 = {id: "700000000000000132", type: 11, parent_id: chanA.id, guild_id: guildID, name: "t2"}
	const forum = {id: "700000000000000150", type: 15, position: 0, parent_id: null, guild_id: guildID, name: "forum"}
	const forumPost = {id: "700000000000000151", type: 11, parent_id: forum.id, guild_id: guildID, name: "post"}
	const roomA = "!tpA:cadence.moe"
	const roomT1 = "!tpT1:cadence.moe"
	const roomT2 = "!tpT2:cadence.moe"
	const roomForum = "!tpForum:cadence.moe"
	const roomPost = "!tpPost:cadence.moe"
	const orderA = "0004" + "0" + "0001" + "00700000000000000111"
	const orderT1 = orderA + "00700000000000000131"
	const orderT2 = orderA + "00700000000000000132"

	const realGetAllState = api.getAllState
	const realSendState = api.sendState
	const sent = []
	db.prepare("INSERT INTO guild_active (guild_id, autocreate) VALUES (?, 1)").run(guildID)
	db.prepare("INSERT INTO guild_space (guild_id, space_id, presence, privacy_level) VALUES (?, ?, 0, 0)").run(guildID, guildSpaceID)
	const insertRoom = db.prepare("INSERT INTO channel_room (channel_id, room_id, name, nick, thread_parent, guild_id) VALUES (?, ?, ?, NULL, NULL, ?)")
	insertRoom.run(chanA.id, roomA, "a", guildID)
	insertRoom.run(thread1.id, roomT1, "t1", guildID)
	insertRoom.run(thread2.id, roomT2, "t2", guildID)
	insertRoom.run(forum.id, roomForum, "forum", guildID)
	insertRoom.run(forumPost.id, roomPost, "post", guildID)
	const cached = [category, chanA, thread1, thread2, forum, forumPost]
	for (const channel of cached) discord.channels.set(channel.id, channel)
	try {
		/** @type {Record<string, any[]>} */
		const spaces = {
			[guildSpaceID]: [
				{type: "m.space.child", state_key: roomA, content: {via: ["cadence.moe"]}}, // no order yet
				{type: "m.space.child", state_key: roomT1, content: {via: ["cadence.moe"]}}, // thread, no order or thread parent yet
				{type: "m.space.child", state_key: roomT2, content: {via: ["cadence.moe"], order: orderT2, [threadParentType]: {room_id: roomA}, [channelType]: {type: "public_thread", name: "t2"}}} // already correct
			],
			// The forum's room is the space for its posts
			[roomForum]: [
				{type: "m.space.child", state_key: roomPost, content: {via: ["cadence.moe"]}} // forum post, no thread parent yet
			]
		}
		// @ts-ignore
		api.getAllState = async roomID => spaces[roomID] || []
		// @ts-ignore
		api.sendState = async (roomID, type, stateKey, content) => {
			sent.push({roomID, type, stateKey, content})
			return "$event"
		}

		await syncSpaceOrder(guildID)

		t.deepEqual(sortSent(sent), sortSent([
			{roomID: guildSpaceID, type: "m.space.child", stateKey: roomA, content: {via: ["cadence.moe"], order: orderA, [categoryType]: {id: category.id, name: category.name}, [channelType]: {type: "text", name: "a"}}},
			{roomID: guildSpaceID, type: "m.space.child", stateKey: roomT1, content: {via: ["cadence.moe"], order: orderT1, [threadParentType]: {room_id: roomA}, [channelType]: {type: "public_thread", name: "t1"}}},
			{roomID: roomForum, type: "m.space.child", stateKey: roomPost, content: {via: ["cadence.moe"], [threadParentType]: {room_id: roomForum}, [channelType]: {type: "public_thread", name: "post"}}}
		]))
	} finally {
		api.getAllState = realGetAllState
		api.sendState = realSendState
		for (const channel of cached) discord.channels.delete(channel.id)
		db.prepare("DELETE FROM channel_room WHERE guild_id = ?").run(guildID)
		db.prepare("DELETE FROM guild_space WHERE guild_id = ?").run(guildID)
		db.prepare("DELETE FROM guild_active WHERE guild_id = ?").run(guildID)
	}
})

test("_syncSpaceMember: channel in a category has the category", async t => {
	const guildID = "999000000000000008"
	const spaceID = "!catmemberspace:cadence.moe"
	const childRoom = "!catmemberchild:cadence.moe"
	const category = {id: "700000000000000071", type: 4, position: 3, name: "Category", guild_id: guildID}
	const child = {id: "700000000000000072", type: 0, position: 1, parent_id: category.id, guild_id: guildID, name: "child"}

	const realGetAllState = api.getAllState
	const realSendState = api.sendState
	const sent = []
	discord.channels.set(category.id, category)
	discord.channels.set(child.id, child)
	try {
		// @ts-ignore
		api.getAllState = async roomID => {
			t.equal(roomID, spaceID)
			return []
		}
		// @ts-ignore
		api.sendState = async (roomID, type, stateKey, content) => {
			sent.push({roomID, type, stateKey, content})
			return "$event"
		}
		// @ts-ignore
		await _syncSpaceMember(child, spaceID, childRoom, guildID)
		t.deepEqual(sent, [{
			roomID: spaceID,
			type: "m.space.child",
			stateKey: childRoom,
			content: {
				via: ["cadence.moe"],
				order: "0004" + "0" + "0001" + "00700000000000000072",
				[categoryType]: {id: category.id, name: "Category"},
				[channelType]: {type: "text", name: "child"}
			}
		}])
	} finally {
		api.getAllState = realGetAllState
		api.sendState = realSendState
		discord.channels.delete(category.id)
		discord.channels.delete(child.id)
	}
})

test("syncSpaceOrder: category key follows the category name, is removed when a channel leaves the category, and correct children are not re-sent", async t => {
	const guildID = "999000000000000009"
	const guildSpaceID = "!catorderspace:cadence.moe"
	const category = {id: "700000000000000401", type: 4, position: 3, name: "New name", guild_id: guildID}
	const outdated = {id: "700000000000000411", type: 0, position: 1, parent_id: category.id, guild_id: guildID, name: "outdated"}
	const uncategorised = {id: "700000000000000412", type: 0, position: 2, parent_id: null, guild_id: guildID, name: "uncategorised"}
	const correct = {id: "700000000000000413", type: 0, position: 3, parent_id: category.id, guild_id: guildID, name: "correct"}
	const thread = {id: "700000000000000414", type: 11, parent_id: correct.id, guild_id: guildID, name: "thread"}
	const roomOutdated = "!catOutdated:cadence.moe"
	const roomUncategorised = "!catUncategorised:cadence.moe"
	const roomCorrect = "!catCorrect:cadence.moe"
	const roomThread = "!catThread:cadence.moe"
	const orderOutdated = "0004" + "0" + "0001" + "00700000000000000411"
	const orderUncategorised = "0000" + "0" + "0002" + "00700000000000000412"
	const orderCorrect = "0004" + "0" + "0003" + "00700000000000000413"
	const orderThread = orderCorrect + "00700000000000000414"
	const categoryContent = {id: category.id, name: "New name"}

	const realGetAllState = api.getAllState
	const realSendState = api.sendState
	const sent = []
	db.prepare("INSERT INTO guild_active (guild_id, autocreate) VALUES (?, 1)").run(guildID)
	db.prepare("INSERT INTO guild_space (guild_id, space_id, presence, privacy_level) VALUES (?, ?, 0, 0)").run(guildID, guildSpaceID)
	const insertRoom = db.prepare("INSERT INTO channel_room (channel_id, room_id, name, nick, thread_parent, guild_id) VALUES (?, ?, ?, NULL, NULL, ?)")
	insertRoom.run(outdated.id, roomOutdated, "outdated", guildID)
	insertRoom.run(uncategorised.id, roomUncategorised, "uncategorised", guildID)
	insertRoom.run(correct.id, roomCorrect, "correct", guildID)
	insertRoom.run(thread.id, roomThread, "thread", guildID)
	const cached = [category, outdated, uncategorised, correct, thread]
	for (const channel of cached) discord.channels.set(channel.id, channel)
	try {
		/** @type {Record<string, any[]>} */
		const spaces = {
			[guildSpaceID]: [
				// the category was renamed, so the key still has the old name
				{type: "m.space.child", state_key: roomOutdated, content: {via: ["cadence.moe"], order: orderOutdated, [categoryType]: {id: category.id, name: "Old name"}}},
				// moved out of the category, so the key has to go
				{type: "m.space.child", state_key: roomUncategorised, content: {via: ["cadence.moe"], order: orderUncategorised, [categoryType]: categoryContent}},
				// already correct
				{type: "m.space.child", state_key: roomCorrect, content: {via: ["cadence.moe"], order: orderCorrect, [categoryType]: categoryContent, [channelType]: {type: "text", name: "correct"}}},
				// threads never get the category
				{type: "m.space.child", state_key: roomThread, content: {via: ["cadence.moe"], order: orderThread, [threadParentType]: {room_id: roomCorrect}, [channelType]: {type: "public_thread", name: "thread"}}}
			]
		}
		// @ts-ignore
		api.getAllState = async roomID => spaces[roomID] || []
		// @ts-ignore
		api.sendState = async (roomID, type, stateKey, content) => {
			sent.push({roomID, type, stateKey, content})
			return "$event"
		}

		await syncSpaceOrder(guildID)

		t.deepEqual(sortSent(sent), sortSent([
			{roomID: guildSpaceID, type: "m.space.child", stateKey: roomOutdated, content: {via: ["cadence.moe"], order: orderOutdated, [categoryType]: categoryContent, [channelType]: {type: "text", name: "outdated"}}},
			{roomID: guildSpaceID, type: "m.space.child", stateKey: roomUncategorised, content: {via: ["cadence.moe"], order: orderUncategorised, [channelType]: {type: "text", name: "uncategorised"}}}
		]))
	} finally {
		api.getAllState = realGetAllState
		api.sendState = realSendState
		for (const channel of cached) discord.channels.delete(channel.id)
		db.prepare("DELETE FROM channel_room WHERE guild_id = ?").run(guildID)
		db.prepare("DELETE FROM guild_space WHERE guild_id = ?").run(guildID)
		db.prepare("DELETE FROM guild_active WHERE guild_id = ?").run(guildID)
	}
})
