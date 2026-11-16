#!/usr/bin/env node
// @ts-check

const DiscordTypes = require("discord-api-types/v10")

const {reg} = require("./src/matrix/read-registration")
const token = reg.ooye.discord_token
const id = Buffer.from(token.split(".")[0], "base64").toString()
const basePermissions =
( DiscordTypes.PermissionFlagsBits.ManageWebhooks
| DiscordTypes.PermissionFlagsBits.ManageGuildExpressions
| DiscordTypes.PermissionFlagsBits.ManageMessages
| DiscordTypes.PermissionFlagsBits.PinMessages
| DiscordTypes.PermissionFlagsBits.UseExternalEmojis)

/** What the voice bridge needs the main bot to have in a bridged guild */
const voicePermissions =
( DiscordTypes.PermissionFlagsBits.ViewChannel
| DiscordTypes.PermissionFlagsBits.Connect
| DiscordTypes.PermissionFlagsBits.Speak
| DiscordTypes.PermissionFlagsBits.UseVAD
| DiscordTypes.PermissionFlagsBits.UseSoundboard
| DiscordTypes.PermissionFlagsBits.UseExternalSounds)

/** What the voice bridge needs each puppet bot to have: the voice permissions, and changing its own nickname */
const puppetPermissions = voicePermissions | DiscordTypes.PermissionFlagsBits.ChangeNickname

/**
 * The permissions to put in the invite link.
 * @param {boolean} voice whether the voice bridge is enabled
 * @returns {bigint}
 */
function permissionsFor(voice) {
	return voice ? basePermissions | voicePermissions : basePermissions
}

const permissions = permissionsFor(!!reg.ooye.voice_bridge)

/**
 * An OAuth link that adds a bot to Discord, optionally to one guild only.
 * @param {string} clientID the bot's application ID
 * @param {bigint} permissions
 * @param {string} [guildID]
 * @returns {string}
 */
function inviteUrl(clientID, permissions, guildID) {
	const guildParams = guildID ? `&guild_id=${guildID}&disable_guild_select=true` : ""
	return `https://discord.com/oauth2/authorize?client_id=${clientID}&scope=bot&permissions=${permissions}${guildParams}`
}

function addbot() {
	return `Open this link to add the bot to a Discord server:\n${inviteUrl(id, permissions)} `
}

/* c8 ignore next 3 */
if (process.argv.find(a => a.endsWith("addbot") || a.endsWith("addbot.js"))) {
	console.log(addbot())
}

module.exports.id = id
module.exports.addbot = addbot
module.exports.permissions = permissions
module.exports.permissionsFor = permissionsFor
module.exports.voicePermissions = voicePermissions
module.exports.puppetPermissions = puppetPermissions
module.exports.inviteUrl = inviteUrl
