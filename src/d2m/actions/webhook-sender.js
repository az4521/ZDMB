// @ts-check

const DiscordTypes = require("discord-api-types/v10")

const passthrough = require("../../passthrough")
const {select, sync} = passthrough

/** @type {import("./register-webhook-user")} */
const registerWebhookUser = sync.require("./register-webhook-user")

/**
 * Decide which Matrix user should send a message that was sent by a webhook on Discord.
 * @param {DiscordTypes.APIMessage} message
 * @param {string} guildID
 * @param {string} roomID
 * @returns {Promise<string | null>} mxid of a sim for the webhook's profile, or null to send as the bridge bot
 */
async function getWebhookSenderId(message, guildID, roomID) {
	const isMatrixWebhook = select("webhook", "webhook_id", {webhook_id: message.webhook_id}).pluck().get()
	if (isMatrixWebhook) return null
	const useWebhookProfile = select("guild_space", "webhook_profile", {guild_id: guildID}).pluck().get() ?? 0
	if (useWebhookProfile) {
		return await registerWebhookUser.syncUser(message.author, roomID, true)
	}
	return null
}

module.exports.getWebhookSenderId = getWebhookSenderId
