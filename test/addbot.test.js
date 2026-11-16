// @ts-check

const {addbot, id, permissions, permissionsFor, voicePermissions, puppetPermissions, inviteUrl} = require("../addbot")
const {test} = require("supertape")
const DiscordTypes = require("discord-api-types/v10")

test("addbot: returns message and invite link", t => {
	t.equal(addbot(), `Open this link to add the bot to a Discord server:\nhttps://discord.com/oauth2/authorize?client_id=684280192553844747&scope=bot&permissions=2251801424568320 `)
})

test("addbot: permissions without voice are the original bits", t => {
	t.equal(permissionsFor(false), 2251801424568320n)
})

test("addbot: permissions with voice add the voice bits", t => {
	t.equal(permissionsFor(true), permissionsFor(false) | voicePermissions)
	t.equal((permissionsFor(true) & voicePermissions), voicePermissions)
	t.equal(voicePermissions, 1024n | 1048576n | 2097152n | 33554432n | 4398046511104n | 35184372088832n)
	t.equal(puppetPermissions, voicePermissions | 67108864n)
})

test("addbot: the exported permissions follow reg.ooye.voice_bridge", t => {
	const {reg} = require("../src/matrix/read-registration")
	t.equal(permissions, permissionsFor(!!reg.ooye.voice_bridge))
})

test("inviteUrl: without a guild", t => {
	t.equal(inviteUrl("123", 8n), "https://discord.com/oauth2/authorize?client_id=123&scope=bot&permissions=8")
})

test("inviteUrl: with a guild limits the invite to that guild", t => {
	t.equal(inviteUrl("123", 8n, "456"), "https://discord.com/oauth2/authorize?client_id=123&scope=bot&permissions=8&guild_id=456&disable_guild_select=true")
})

test("addbot: the bot's ID comes from the token", t => {
	t.equal(id, "684280192553844747")
	t.ok(DiscordTypes.PermissionFlagsBits.UseVAD)
})
