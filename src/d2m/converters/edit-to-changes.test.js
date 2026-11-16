const {test} = require("supertape")
const {editToChanges} = require("./edit-to-changes")
const data = require("../../../test/data")
const Ty = require("../../types")
const {db} = require("../../passthrough")

/**
 * Inserts rows into event_message for a message that only exists in these tests.
 * @param {string} messageID
 * @param {[eventID: string, subtype: string, part: number, reactionPart: number][]} rows
 */
function insertEventMessageRows(messageID, rows) {
	db.prepare("INSERT INTO message_room (message_id, historical_room_index) SELECT ?, historical_room_index FROM historical_channel_room WHERE room_id = '!kLRqKKUQXcibIMtOpl:cadence.moe' LIMIT 1").run(messageID)
	for (const [eventID, subtype, part, reactionPart] of rows) {
		db.prepare("INSERT INTO event_message (event_id, event_type, event_subtype, message_id, part, reaction_part, source) VALUES (?, 'm.room.message', ?, ?, ?, ?, 1)").run(eventID, subtype, messageID, part, reactionPart)
	}
}

const galleryTestAttachments = [{
	filename: "image.png",
	url: "https://cdn.discordapp.com/attachments/497161332244742154/1124628646431297546/image.png",
	content_type: "image/png",
	size: 1000,
	width: 10,
	height: 20
}, {
	filename: "image.png",
	url: "https://cdn.discordapp.com/attachments/122155380120748034/1106366167486038016/image.png",
	content_type: "image/png",
	size: 2000,
	width: 30,
	height: 40
}]

const galleryTestItems = [{
	itemtype: "m.image",
	body: "image.png",
	filename: "image.png",
	external_url: "https://bridge.example.org/download/discordcdn/497161332244742154/1124628646431297546/image.png",
	url: "mxc://cadence.moe/qXoZktDqNtEGuOCZEADAMvhM",
	info: {mimetype: "image/png", w: 10, h: 20, size: 1000}
}, {
	itemtype: "m.image",
	body: "image.png",
	filename: "image.png",
	external_url: "https://bridge.example.org/download/discordcdn/122155380120748034/1106366167486038016/image.png",
	url: "mxc://cadence.moe/ZDCNYnkPszxGKgObUIFmvjus",
	info: {mimetype: "image/png", w: 30, h: 40, size: 2000}
}]

test("edit2changes: edit by webhook", async t => {
	let called = 0
	const {senderMxid, eventsToRedact, eventsToReplace, eventsToSend, promotions} = await editToChanges(data.message_update.edit_by_webhook, data.guild.general, {
		getEvent(roomID, eventID) {
			called++
			t.equal(eventID, "$zXSlyI78DQqQwwfPUSzZ1b-nXzbUrCDljJgnGDdoI10")
			return {content: {body: "dummy"}}
		}
	})
	t.deepEqual(eventsToRedact, [])
	t.deepEqual(eventsToSend, [])
	t.deepEqual(eventsToReplace, [{
		oldID: "$zXSlyI78DQqQwwfPUSzZ1b-nXzbUrCDljJgnGDdoI10",
		newContent: {
			$type: "m.room.message",
			msgtype: "m.text",
			body: "* test 2",
			"m.mentions": {},
			"m.new_content": {
				// *** Replaced With: ***
				msgtype: "m.text",
				body: "test 2",
				"m.mentions": {}
			},
			"m.relates_to": {
				rel_type: "m.replace",
				event_id: "$zXSlyI78DQqQwwfPUSzZ1b-nXzbUrCDljJgnGDdoI10"
			}
		}
	}])
	t.equal(senderMxid, null)
	t.deepEqual(promotions, [])
	t.equal(called, 1)
})

test("edit2changes: bot response", async t => {
	const {senderMxid, eventsToRedact, eventsToReplace, eventsToSend, promotions} = await editToChanges(data.message_update.bot_response, data.guild.general, {
		getEvent(roomID, eventID) {
			t.equal(eventID, "$fdD9OZ55xg3EAsfvLZza5tMhtjUO91Wg3Otuo96TplY")
			return {
				content: {
					"m.mentions": {
						user_ids: ["@cadence:cadence.moe"],
					},
					body: "dummy"
				}
			}
		},
		async getJoinedMembers(roomID) {
			t.equal(roomID, "!hYnGGlPHlbujVVfktC:cadence.moe")
			return new Promise(resolve => {
				setTimeout(() => {
					resolve({
						joined: {
							"@cadence:cadence.moe": {
								displayname: "cadence [they]",
								avatar_url: "whatever"
							},
							"@_ooye_botrac4r:cadence.moe": {
								displayname: "botrac4r",
								avatar_url: "whatever"
							}
						}
					})
				})
			})
		}
	})
	t.deepEqual(eventsToRedact, [])
	t.deepEqual(eventsToSend, [])
	t.deepEqual(eventsToReplace, [{
		oldID: "$fdD9OZ55xg3EAsfvLZza5tMhtjUO91Wg3Otuo96TplY",
		newContent: {
			$type: "m.room.message",
			msgtype: "m.text",
			body: "* :ae_botrac4r: @cadence asked ``­``, I respond: Stop drinking paint. (No)\n\nHit :bn_re: to reroll.",
			format: "org.matrix.custom.html",
			formatted_body: '* <img data-mx-emoticon height="32" src="mxc://cadence.moe/skqfuItqxNmBYekzmVKyoLzs" title=":ae_botrac4r:" alt=":ae_botrac4r:"> <a href="https://matrix.to/#/@cadence:cadence.moe">@cadence</a> asked <code>­</code>, I respond: Stop drinking paint. (No)<br><br>Hit <img data-mx-emoticon height="32" src="mxc://cadence.moe/OIpqpfxTnHKokcsYqDusxkBT" title=":bn_re:" alt=":bn_re:"> to reroll.',
			"m.mentions": {
				// Client-Server API spec 11.37.7: Copy Discord's behaviour by not re-notifying anyone that an *edit occurred*
			},
			// *** Replaced With: ***
			"m.new_content": {
				msgtype: "m.text",
				body: ":ae_botrac4r: @cadence asked ``­``, I respond: Stop drinking paint. (No)\n\nHit :bn_re: to reroll.",
				format: "org.matrix.custom.html",
				formatted_body: '<img data-mx-emoticon height="32" src="mxc://cadence.moe/skqfuItqxNmBYekzmVKyoLzs" title=":ae_botrac4r:" alt=":ae_botrac4r:"> <a href="https://matrix.to/#/@cadence:cadence.moe">@cadence</a> asked <code>­</code>, I respond: Stop drinking paint. (No)<br><br>Hit <img data-mx-emoticon height="32" src="mxc://cadence.moe/OIpqpfxTnHKokcsYqDusxkBT" title=":bn_re:" alt=":bn_re:"> to reroll.',
				"m.mentions": {
					// Client-Server API spec 11.37.7: This should contain the mentions for the final version of the event
					"user_ids": ["@cadence:cadence.moe"]
				}
			},
			"m.relates_to": {
				rel_type: "m.replace",
				event_id: "$fdD9OZ55xg3EAsfvLZza5tMhtjUO91Wg3Otuo96TplY"
			}
		}
	}])
	t.equal(senderMxid, "@_ooye_bojack_horseman:cadence.moe")
	t.deepEqual(promotions, [])
})

test("edit2changes: remove caption from image", async t => {
	const {eventsToRedact, eventsToReplace, eventsToSend, promotions} = await editToChanges(data.message_update.removed_caption_from_image, data.guild.general, {})
	t.deepEqual(eventsToRedact, ["$mtR8cJqM4fKno1bVsm8F4wUVqSntt2sq6jav1lyavuA"])
	t.deepEqual(eventsToSend, [])
	t.deepEqual(eventsToReplace, [])
	t.deepEqual(promotions, [{column: "part", eventID: "$51f4yqHinwnSbPEQ9dCgoyy4qiIJSX0QYYVUnvwyTCI"}])
})

test("edit2changes: change file type", async t => {
	const {eventsToRedact, eventsToReplace, eventsToSend, promotions} = await editToChanges(data.message_update.changed_file_type, data.guild.general, {})
	t.deepEqual(eventsToRedact, ["$51f4yqHinwnSbPEQ9dCgoyy4qiIJSX0QYYVUnvwyTCJ"])
	t.deepEqual(eventsToSend, [{
		$type: "m.room.message",
		body: "📝 Uploaded file: https://bridge.example.org/download/discordcdn/112760669178241024/1141501302497615912/gaze_into_my_dark_mind.txt (20 MB)",
		format: "org.matrix.custom.html",
		formatted_body: "📝 Uploaded file: <a href=\"https://bridge.example.org/download/discordcdn/112760669178241024/1141501302497615912/gaze_into_my_dark_mind.txt\">gaze_into_my_dark_mind.txt</a> (20 MB)",
		"m.mentions": {},
		msgtype: "m.text"
	}])
	t.deepEqual(eventsToReplace, [])
	t.deepEqual(promotions, [{column: "part", nextEvent: true}, {column: "reaction_part", nextEvent: true}])
})

test("edit2changes: add caption back to that image (due to it having a reaction, the reaction_part will not be moved)", async t => {
	const {eventsToRedact, eventsToReplace, eventsToSend, promotions} = await editToChanges(data.message_update.added_caption_to_image, data.guild.general, {})
	t.deepEqual(eventsToRedact, [])
	t.deepEqual(eventsToSend, [{
		$type: "m.room.message",
		msgtype: "m.text",
		body: "some text",
		"m.mentions": {}
	}])
	t.deepEqual(eventsToReplace, [])
	t.deepEqual(promotions, [])
})

test("edit2changes: stickers and attachments are not changed, only the content can be edited", async t => {
	let called = 0
	const {eventsToRedact, eventsToReplace, eventsToSend} = await editToChanges(data.message_update.edited_content_with_sticker_and_attachments, data.guild.general, {
		getEvent(roomID, eventID) {
			called++
			t.equal(eventID, "$lnAF9IosAECTnlv9p2e18FG8rHn-JgYKHEHIh5qdFv4")
			return {content: {body: "dummy"}}
		}
	})
	t.deepEqual(eventsToRedact, [])
	t.deepEqual(eventsToSend, [])
	t.deepEqual(eventsToReplace, [{
		oldID: "$lnAF9IosAECTnlv9p2e18FG8rHn-JgYKHEHIh5qdFv4",
		newContent: {
			$type: "m.room.message",
			msgtype: "m.text",
			body: "* only the content can be edited",
			"m.mentions": {},
			// *** Replaced With: ***
			"m.new_content": {
				msgtype: "m.text",
				body: "only the content can be edited",
				"m.mentions": {}
			},
			"m.relates_to": {
				rel_type: "m.replace",
				event_id: "$lnAF9IosAECTnlv9p2e18FG8rHn-JgYKHEHIh5qdFv4"
			}
		}
	}])
	t.equal(called, 1)
})

test("edit2changes: edit of reply to skull webp attachment with content", async t => {
	const {eventsToRedact, eventsToReplace, eventsToSend} = await editToChanges(data.message_update.edit_of_reply_to_skull_webp_attachment_with_content, data.guild.general, {
		getEvent(roomID, eventID) {
			t.equal(eventID, "$vgTKOR5ZTYNMKaS7XvgEIDaOWZtVCEyzLLi5Pc5Gz4M")
			return {content: {body: "dummy"}}
		}
	})
	t.deepEqual(eventsToRedact, [])
	t.deepEqual(eventsToSend, [])
	t.deepEqual(eventsToReplace, [{
		oldID: "$vgTKOR5ZTYNMKaS7XvgEIDaOWZtVCEyzLLi5Pc5Gz4M",
		newContent: {
			$type: "m.room.message",
			msgtype: "m.text",
			body: "* Edit",
			"m.mentions": {},
			"m.new_content": {
				msgtype: "m.text",
				body: "Edit",
				"m.mentions": {}
			},
			"m.relates_to": {
				rel_type: "m.replace",
				event_id: "$vgTKOR5ZTYNMKaS7XvgEIDaOWZtVCEyzLLi5Pc5Gz4M"
			}
		}
	}])
})

test("edit2changes: edits the text event when multiple rows have part = 0 (should never happen in real life, but make sure the safety net works)", async t => {
	const {eventsToRedact, eventsToReplace, eventsToSend} = await editToChanges(data.message_update.edited_content_with_sticker_and_attachments_but_all_parts_equal_0, data.guild.general, {
		getEvent(roomID, eventID) {
			t.equal(eventID, "$lnAF9IosAECTnlv9p2e18FG8rHn-JgYKHEHIh5qd999")
			return {content: {body: "dummy"}}
		}
	})
	t.deepEqual(eventsToRedact, [])
	t.deepEqual(eventsToSend, [])
	t.deepEqual(eventsToReplace, [{
		oldID: "$lnAF9IosAECTnlv9p2e18FG8rHn-JgYKHEHIh5qd999",
		newContent: {
			$type: "m.room.message",
			msgtype: "m.text",
			body: "* only the content can be edited",
			"m.mentions": {},
			// *** Replaced With: ***
			"m.new_content": {
				msgtype: "m.text",
				body: "only the content can be edited",
				"m.mentions": {}
			},
			"m.relates_to": {
				rel_type: "m.replace",
				event_id: "$lnAF9IosAECTnlv9p2e18FG8rHn-JgYKHEHIh5qd999"
			}
		}
	}])
})

test("edit2changes: promotes the text event when multiple rows have part = 1 (should never happen in real life, but make sure the safety net works)", async t => {
	const {eventsToRedact, eventsToReplace, eventsToSend, promotions} = await editToChanges(data.message_update.edited_content_with_sticker_and_attachments_but_all_parts_equal_1, data.guild.general, {
		getEvent(roomID, eventID) {
			t.equal(eventID, "$lnAF9IosAECTnlv9p2e18FG8rHn-JgYKHEHIh5qd111")
			return {content: {body: "dummy"}}
		}
	})
	t.deepEqual(eventsToRedact, [])
	t.deepEqual(eventsToSend, [])
	t.deepEqual(eventsToReplace, [{
		oldID: "$lnAF9IosAECTnlv9p2e18FG8rHn-JgYKHEHIh5qd111",
		newContent: {
			$type: "m.room.message",
			msgtype: "m.text",
			body: "* only the content can be edited",
			"m.mentions": {},
			// *** Replaced With: ***
			"m.new_content": {
				msgtype: "m.text",
				body: "only the content can be edited",
				"m.mentions": {}
			},
			"m.relates_to": {
				rel_type: "m.replace",
				event_id: "$lnAF9IosAECTnlv9p2e18FG8rHn-JgYKHEHIh5qd111"
			}
		}
	}])
	t.deepEqual(promotions, [
		{
			column: "part",
			eventID: "$lnAF9IosAECTnlv9p2e18FG8rHn-JgYKHEHIh5qd111"
		},
		{
			column: "reaction_part",
			eventID: "$f9cjKiacXI9qPF_nUAckzbiKnJEi0LM399kOkhdd111"
		}
	])
})

test("edit2changes: promotes newly sent event", async t => {
	const {eventsToReplace, eventsToRedact, eventsToSend, promotions} = await editToChanges({
		channel_id: "1160894080998461480",
		id: "1404133238414376971",
		content: "hi",
		attachments: [{
			id: "1157854643037163610",
			filename: "Screenshot_20231001_034036.jpg",
			size: 51981,
			url: "https://cdn.discordapp.com/attachments/176333891320283136/1157854643037163610/Screenshot_20231001_034036.jpg?ex=651a1faa&is=6518ce2a&hm=eb5ca80a3fa7add8765bf404aea2028a28a2341e4a62435986bcdcf058da82f3&",
			proxy_url: "https://media.discordapp.net/attachments/176333891320283136/1157854643037163610/Screenshot_20231001_034036.jpg?ex=651a1faa&is=6518ce2a&hm=eb5ca80a3fa7add8765bf404aea2028a28a2341e4a62435986bcdcf058da82f3&",
			width: 1080,
			height: 1170,
			content_type: "image/jpeg"
		}],
		author: {
			username: "cadence.worm",
			global_name: "Cadence"
		}
	}, data.guild.general, {
		async getEvent(roomID, eventID) {
			t.equal(eventID, "$uUKLcTQvik5tgtTGDKuzn0Ci4zcCvSoUcYn2X7mXm9I")
			return {
				type: "m.room.message",
				sender: "@_ooye_cadence.worm:cadence.moe",
				content: {
					msgtype: "m.text",
					body: "hi"
				}
			}
		}
	})
	t.deepEqual(eventsToRedact, ["$LhmoWWvYyn5_AHkfb6FaXmLI6ZOC1kloql5P40YDmIk"])
	t.deepEqual(eventsToReplace, [])
	t.deepEqual(eventsToSend, [{
		$type: "m.room.message",
		body: "Screenshot_20231001_034036.jpg",
		external_url: "https://bridge.example.org/download/discordcdn/176333891320283136/1157854643037163610/Screenshot_20231001_034036.jpg",
		filename: "Screenshot_20231001_034036.jpg",
		info: {
			mimetype: "image/jpeg",
			size: 51981,
			w: 1080,
			h: 1170
		},
		url: "mxc://cadence.moe/zAXdQriaJuLZohDDmacwWWDR",
		"m.mentions": {},
		msgtype: "m.image"
	}])
	t.deepEqual(promotions, [
		{column: "reaction_part", nextEvent: true}
	])
	// assert that the event parts will be consistent in database after this
})

test("edit2changes: generated embed", async t => {
	let called = 0
	const {senderMxid, eventsToRedact, eventsToReplace, eventsToSend, promotions} = await editToChanges(data.message_update.embed_generated_social_media_image, data.guild.general, {
		async getEvent(roomID, eventID) {
			called++
			t.equal(roomID, "!kLRqKKUQXcibIMtOpl:cadence.moe")
			t.equal(eventID, "$mPSzglkCu-6cZHbYro0RW2u5mHvbH9aXDjO5FCzosc0")
			return {sender: "@_ooye_cadence:cadence.moe"}
		}
	})
	t.deepEqual(eventsToRedact, [])
	t.deepEqual(eventsToReplace, [])
	t.deepEqual(eventsToSend, [{
		$type: "m.room.message",
		msgtype: "m.notice",
		body: "| ## This post nerdsniped me, so here's some RULES FOR REAL-LIFE BALATRO https://cohost.org/jkap/post/4794219-empty"
			+ "\n| \n| 1v1 physical card game. Each player gets one standard deck of cards with a different backing to differentiate. Every turn proceeds as follows:"
			+ "\n| \n|  * Both players draw eight cards"
			+ "\n|  * Both players may choose up to eight cards to discard, then draw that number of cards to put back in their hand"
			+ "\n|  * Both players present their best five-or-less-card pok..."
			+ "\n| via hthrflwrs on cohost",
		format: "org.matrix.custom.html",
		formatted_body: `<blockquote><p><strong><a href="https://cohost.org/jkap/post/4794219-empty">This post nerdsniped me, so here's some RULES FOR REAL-LIFE BALATRO</a></strong>`
			+ `</p><p>1v1 physical card game. Each player gets one standard deck of cards with a different backing to differentiate. Every turn proceeds as follows:`
			+ `<br><br><ul><li>Both players draw eight cards`
			+ `</li><li>Both players may choose up to eight cards to discard, then draw that number of cards to put back in their hand`
			+ `</li><li>Both players present their best five-or-less-card pok...</li></ul></p><sub>hthrflwrs on cohost</sub></blockquote>`,
		"m.mentions": {}
	}])
	t.deepEqual(promotions, [{
		"column": "reaction_part",
		"eventID": "$mPSzglkCu-6cZHbYro0RW2u5mHvbH9aXDjO5FCzosc0",
		"value": 1,
	}, {
		"column": "reaction_part",
		"nextEvent": true,
	}])
	t.equal(senderMxid, "@_ooye_cadence:cadence.moe")
	t.equal(called, 1)
})

test("edit2changes: generated embed on a reply", async t => {
	let called = 0
	data.message_update.embed_generated_on_reply.timestamp = new Date().toISOString()
	const {senderMxid, eventsToRedact, eventsToReplace, eventsToSend, promotions} = await editToChanges(data.message_update.embed_generated_on_reply, data.guild.general, {
		getEvent(roomID, eventID) {
			called++
			t.equal(eventID, "$UTqiL3Zj3FC4qldxRLggN1fhygpKl8sZ7XGY5f9MNbF")
			return {
				type: "m.room.message",
				content: {
					// Unfortunately the edited message doesn't include the message_reference field. Fine. Whatever. It looks normal if you're using a good client.
					body: "> a Discord user: [Replied-to message content wasn't provided by Discord]"
						+ "\n\nhttps://matrix.to/#/!BnKuBPCvyfOkhcUjEu:cadence.moe/$aLVZyiC3HlOu-prCSIaXlQl68I8leUdnPFiCwkgn6qM",
					format: "org.matrix.custom.html",
					formatted_body: "<mx-reply><blockquote><a href=\"https://matrix.to/#/!BnKuBPCvyfOkhcUjEu:cadence.moe/$aLVZyiC3HlOu-prCSIaXlQl68I8leUdnPFiCwkgn6qM\">In reply to</a> a Discord user<br>[Replied-to message content wasn't provided by Discord]</blockquote></mx-reply><a href=\"https://matrix.to/#/!BnKuBPCvyfOkhcUjEu:cadence.moe/$aLVZyiC3HlOu-prCSIaXlQl68I8leUdnPFiCwkgn6qM\">https://matrix.to/#/!BnKuBPCvyfOkhcUjEu:cadence.moe/$aLVZyiC3HlOu-prCSIaXlQl68I8leUdnPFiCwkgn6qM</a>",
					"m.mentions": {},
					"m.relates_to": {
						event_id: "$UTqiL3Zj3FC4qldxRLggN1fhygpKl8sZ7XGY5f9MNbF",
						rel_type: "m.replace",
					},
					msgtype: "m.text",
				}
			}
		}
	})
	t.deepEqual(eventsToRedact, [])
	t.deepEqual(eventsToReplace, [])
	t.deepEqual(eventsToSend, [{
		$type: "m.room.message",
		msgtype: "m.notice",
		body: "| ## Matrix - Decentralised and secure communication https://matrix.to/"
			+ "\n| \n| You're invited to talk on Matrix. If you don't already have a client this link will help you pick one, and join the conversation. If you already have one, this link will help you join the conversation",
		format: "org.matrix.custom.html",
		formatted_body: `<blockquote><p><strong><a href="https://matrix.to/">Matrix - Decentralised and secure communication</a></strong>`
			+ `</p><p>You're invited to talk on Matrix. If you don't already have a client this link will help you pick one, and join the conversation. If you already have one, this link will help you join the conversation</p></blockquote>`,
		"m.mentions": {}
	}])
	t.deepEqual(promotions, [{
		"column": "reaction_part",
		"eventID": "$UTqiL3Zj3FC4qldxRLggN1fhygpKl8sZ7XGY5f9MNbF",
		"value": 1,
	}, {
		"column": "reaction_part",
		"nextEvent": true,
	}])
	t.equal(senderMxid, "@_ooye_cadence:cadence.moe")
	t.equal(called, 1)
})

test("edit2changes: don't generate embed if it's been too long since the message", async t => {
	const {senderMxid, eventsToRedact, eventsToReplace, eventsToSend, promotions} = await editToChanges(data.message_update.embed_generated_social_media_image_for_matrix_user, data.guild.general)
	t.deepEqual(eventsToRedact, [])
	t.deepEqual(eventsToReplace, [])
	t.deepEqual(eventsToSend, [])
	t.deepEqual(promotions, [])
	t.equal(senderMxid, null)
})

test("edit2changes: don't generate new data in situations where m->d(->m) subtypes don't match, like large files", async t => {
	const {senderMxid, eventsToRedact, eventsToReplace, eventsToSend, promotions} = await editToChanges(data.message.large_file_from_matrix)
	t.deepEqual(eventsToRedact, [])
	t.deepEqual(eventsToReplace, [])
	t.deepEqual(eventsToSend, [])
	t.deepEqual(promotions, [])
	t.equal(senderMxid, null)
})

test("edit2changes: message from before galleries existed (text + 2 images) only replaces the text when the text is edited", async t => {
	const messageID = "1500000000000000001"
	insertEventMessageRows(messageID, [
		["$legacyTextEvent1", "m.text", 0, 0],
		["$legacyImageEvent1", "m.image", 1, 1],
		["$legacyImageEvent2", "m.image", 2, 1]
	])
	let called = 0
	const {eventsToRedact, eventsToReplace, eventsToSend, promotions} = await editToChanges({
		id: messageID,
		channel_id: "112760669178241024",
		content: "edited text",
		author: {id: "1000000000000000001", username: "cadence.worm", global_name: "Cadence"},
		attachments: galleryTestAttachments
	}, data.guild.general, {
		getEvent(roomID, eventID) {
			called++
			t.equal(eventID, "$legacyTextEvent1")
			return {content: {body: "old text"}}
		}
	})
	t.deepEqual(eventsToRedact, [])
	t.deepEqual(eventsToSend, [])
	t.deepEqual(eventsToReplace, [{
		oldID: "$legacyTextEvent1",
		newContent: {
			$type: "m.room.message",
			msgtype: "m.text",
			body: "* edited text",
			"m.url_previews": [],
			"m.mentions": {},
			"m.new_content": {
				msgtype: "m.text",
				body: "edited text",
				"m.url_previews": [],
				"m.mentions": {}
			},
			"m.relates_to": {
				rel_type: "m.replace",
				event_id: "$legacyTextEvent1"
			}
		}
	}])
	t.deepEqual(promotions, [])
	t.equal(called, 1)
})

test("edit2changes: gallery caption is edited", async t => {
	const messageID = "1500000000000000002"
	insertEventMessageRows(messageID, [
		["$galleryEvent1", "dm.filament.gallery", 0, 0]
	])
	let called = 0
	const {eventsToRedact, eventsToReplace, eventsToSend, promotions} = await editToChanges({
		id: messageID,
		channel_id: "112760669178241024",
		content: "new caption",
		author: {id: "1000000000000000001", username: "cadence.worm", global_name: "Cadence"},
		attachments: galleryTestAttachments
	}, data.guild.general, {
		getEvent(roomID, eventID) {
			called++
			t.equal(eventID, "$galleryEvent1")
			return {content: {body: "old caption", "m.mentions": {}, itemtypes: [{itemtype: "m.image", url: galleryTestItems[0].url}, {itemtype: "m.image", url: galleryTestItems[1].url}]}}
		}
	})
	t.deepEqual(eventsToRedact, [])
	t.deepEqual(eventsToSend, [])
	t.deepEqual(eventsToReplace, [{
		oldID: "$galleryEvent1",
		newContent: {
			$type: "m.room.message",
			msgtype: "dm.filament.gallery",
			body: "* new caption",
			"m.url_previews": [],
			"m.mentions": {},
			itemtypes: galleryTestItems,
			"m.new_content": {
				msgtype: "dm.filament.gallery",
				body: "new caption",
				"m.url_previews": [],
				"m.mentions": {},
				itemtypes: galleryTestItems
			},
			"m.relates_to": {
				rel_type: "m.replace",
				event_id: "$galleryEvent1"
			}
		}
	}])
	t.deepEqual(promotions, [])
	t.equal(called, 1)
})

test("edit2changes: gallery with unchanged caption and items is not replaced", async t => {
	const messageID = "1500000000000000003"
	insertEventMessageRows(messageID, [
		["$galleryEvent2", "dm.filament.gallery", 0, 0]
	])
	let called = 0
	const {eventsToRedact, eventsToReplace, eventsToSend, promotions} = await editToChanges({
		id: messageID,
		channel_id: "112760669178241024",
		content: "same caption",
		author: {id: "1000000000000000001", username: "cadence.worm", global_name: "Cadence"},
		attachments: galleryTestAttachments
	}, data.guild.general, {
		getEvent(roomID, eventID) {
			called++
			t.equal(eventID, "$galleryEvent2")
			return {content: {body: "same caption", "m.mentions": {}, itemtypes: [{itemtype: "m.image", url: galleryTestItems[0].url}, {itemtype: "m.image", url: galleryTestItems[1].url}]}}
		}
	})
	t.deepEqual(eventsToRedact, [])
	t.deepEqual(eventsToSend, [])
	t.deepEqual(eventsToReplace, [])
	t.deepEqual(promotions, [])
	t.equal(called, 1)
})
