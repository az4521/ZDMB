// @ts-check

/*
	Startup check that the main bot and the puppet bots have the permissions the voice bridge needs in each guild that has a
	bridged voice or stage channel. Problems are only logged, with an invite link that re-authorises the bot. The bot role
	is managed by Discord's integration, so only a new authorisation can change its permissions.
*/

const DiscordTypes = require("discord-api-types/v10")
const {id: mainID, permissions, inviteUrl, voicePermissions, puppetPermissions} = require("../../addbot")
const dUtils = require("../discord/utils")

/**
 * @typedef {Object} PermissionResult
 * @property {string} guildID
 * @property {string} bot "main" for the main bot, otherwise the puppet's user ID
 * @property {string[] | "not-in-guild"} missing names of missing permissions, or "not-in-guild" when the bot isn't in the guild
 */

/**
 * Names of the permission flags in `need` that are not in `have`. A member with Administrator has every permission.
 * @param {bigint} have
 * @param {bigint} need
 * @returns {string[]}
 */
function missingPermissions(have, need) {
	if (have & DiscordTypes.PermissionFlagsBits.Administrator) return []
	/** @type {string[]} */
	const missing = []
	for (const [name, bit] of Object.entries(DiscordTypes.PermissionFlagsBits)) {
		if (need & bit && !(have & bit)) missing.push(name)
	}
	return missing
}

/**
 * Checks the main bot and the puppets in every guild with a bridged voice channel. Never throws: a guild that fails
 * to check is logged and skipped.
 * @param {Object} options
 * @param {any} options.discord the main Discord client
 * @param {any} options.pool the BotPool
 * @param {Iterable<string>} options.bridgedVoiceGuildIDs guilds with at least one bridged voice or stage channel
 * @param {any} [options.puppet] only check this puppet, and skip the main bot (used when a puppet becomes Ready)
 * @returns {PermissionResult[]}
 */
function checkVoicePermissions({discord, pool, bridgedVoiceGuildIDs, puppet}) {
	/** @type {PermissionResult[]} */
	const results = []
	const puppets = puppet ? [puppet] : (pool.puppets ?? [])

	for (const guildID of bridgedVoiceGuildIDs) {
		try {
			const guild = discord.guilds.get(guildID)
			const guildName = guild?.name ?? guildID

			if (!puppet) {
				const member = guild?.members?.find((/** @type {any} */ m) => m.user?.id === discord.user.id)
				if (!member) {
					console.warn(`[voice] the bot isn't in ${guildName} (${guildID}). Invite it: ${inviteUrl(mainID, permissions, guildID)}`)
					results.push({guildID, bot: "main", missing: "not-in-guild"})
				} else {
					const have = dUtils.getPermissions(guildID, member.roles, guild.roles, discord.user.id)
					const missing = missingPermissions(have, voicePermissions)
					if (missing.length) {
						console.warn(`[voice] the bot is missing ${missing.join(", ")} in ${guildName} (${guildID}). Re-authorise it to grant them: ${inviteUrl(mainID, permissions, guildID)}`)
					}
					results.push({guildID, bot: "main", missing})
				}
			}

			for (const bot of puppets) {
				if (!bot.userID) continue
				if (!bot.guildIDs.has(guildID)) {
					console.warn(`[voice] puppet bot ${bot.userID} isn't in ${guildName}. Invite it: ${inviteUrl(bot.userID, puppetPermissions, guildID)}`)
					results.push({guildID, bot: bot.userID, missing: "not-in-guild"})
				} else {
					results.push({guildID, bot: bot.userID, missing: []})
				}
			}
		} catch (e) {
			console.error(`[voice] could not check the bot permissions in ${guildID}:`, e)
		}
	}
	return results
}

module.exports = {missingPermissions, checkVoicePermissions}
