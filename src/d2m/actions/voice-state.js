// @ts-check

const passthrough = require("../../passthrough")
const {sync, select} = passthrough
/** @type {import("../../matrix/api")} */
const api = sync.require("../../matrix/api")
/** @type {import("./set-presence")} */
const setPresence = sync.require("./set-presence")

/*
	Voice channel presence. A user who is in a voice channel in a guild with presence enabled gets the MSC4426 call field,
	which the Zam client shows as "In a call for N min".
	Discord does not say when someone joined a voice channel, so the join time is the time we first saw them in voice.
	The field is only written when the user joins, moves to another guild, or leaves. Moving between channels in the same guild keeps the join time.
*/

const CALL_FIELD = "org.matrix.msc4426.call"

// Delay between the writes for the users already in voice when a guild is loaded, so that a big guild doesn't burst requests
const guildSpacing = 100

const voiceStateTracker = new class {
	/** @private @type {Map<string, {guildID: string, channelID: string, joinedAt: number, mxid: string}>} Discord user ID -> voice state */
	users = sync.remember(() => new Map())
	/** @private @type {Map<string, Promise<void>>} Discord user ID -> last write, so that writes for one user are serialised */
	queues = sync.remember(() => new Map())

	/**
	 * Called for each Discord VOICE_STATE_UPDATE event. A null channel means the user has left voice.
	 * @param {{guild_id?: string, channel_id?: string | null, user_id: string}} state
	 * @param {string} [botUserID] Discord user ID of the bridge bot, which is ignored
	 */
	onVoiceState(state, botUserID) {
		if (!state.guild_id || state.user_id === botUserID) return
		if (state.channel_id) {
			this.setVoiceState(state.user_id, state.guild_id, state.channel_id)
		} else {
			this.leave(state.user_id, state.guild_id)
		}
	}

	/**
	 * Called for each GUILD_CREATE. Discord does not say when the users already in voice joined, so their join time is now.
	 * Writes are spaced out one user at a time.
	 * @param {{id: string, voice_states?: {user_id: string, channel_id?: string | null}[]}} guild
	 * @param {string} [botUserID] Discord user ID of the bridge bot, which is ignored
	 * @returns {Promise<void>}
	 */
	async onGuildCreate(guild, botUserID) {
		if (!setPresence.guildPresenceSetting.isEnabled(guild.id)) return
		for (const state of guild.voice_states ?? []) {
			if (!state.channel_id || state.user_id === botUserID) continue
			// Already known from an earlier GUILD_CREATE (e.g. after a reconnect), so keep the original join time
			if (this.users.get(state.user_id)?.guildID === guild.id) continue
			await this.setVoiceState(state.user_id, guild.id, state.channel_id)
			await new Promise(resolve => setTimeout(resolve, guildSpacing).unref())
		}
	}

	/**
	 * Starts tracking a user in a voice channel, or moves them within the same guild, or forgets them if they should not show a call.
	 * @private
	 * @param {string} userID
	 * @param {string} guildID
	 * @param {string} channelID
	 * @returns {Promise<void>} resolves once any write for this change has been made
	 */
	setVoiceState(userID, guildID, channelID) {
		const tracked = this.users.get(userID)
		if (tracked && tracked.guildID === guildID) {
			// Moving between channels in the same guild keeps the original join time
			tracked.channelID = channelID
			return Promise.resolve()
		}
		// Joined a guild that doesn't show presence (or moved there from one that did): the old call no longer applies
		if (!setPresence.guildPresenceSetting.isEnabled(guildID)) return this.forget(userID)

		// Only users with sims get anything published
		const mxid = select("sim", "mxid", {user_id: userID}).pluck().get()
		if (!mxid) return this.forget(userID)

		const joinedAt = Date.now()
		this.users.set(userID, {guildID, channelID, joinedAt, mxid})
		return this.write(userID, mxid, {call_joined_ts: Math.floor(joinedAt / 1000)})
	}

	/**
	 * Called when a user leaves voice. Ignored if the user is currently tracked in a different guild.
	 * @private
	 * @param {string} userID
	 * @param {string} guildID
	 * @returns {Promise<void>}
	 */
	leave(userID, guildID) {
		if (this.users.get(userID)?.guildID !== guildID) return Promise.resolve()
		return this.forget(userID)
	}

	/**
	 * Stops tracking a user and deletes the call field, if it was set.
	 * @private
	 * @param {string} userID
	 * @returns {Promise<void>}
	 */
	forget(userID) {
		const tracked = this.users.get(userID)
		if (!tracked) return Promise.resolve()
		this.users.delete(userID)
		return this.write(userID, tracked.mxid, null)
	}

	/**
	 * Writes are chained so that only one PUT or DELETE per user is in flight at a time. Errors are ignored, since the server may not support extended profile fields.
	 * @private
	 * @param {string} userID
	 * @param {string} mxid
	 * @param {{call_joined_ts: number} | null} value the call field to set, or null to delete it
	 * @returns {Promise<void>}
	 */
	write(userID, mxid, value) {
		const previous = this.queues.get(userID) ?? Promise.resolve()
		const next = previous
			.then(() => api.profileSetField(mxid, CALL_FIELD, value))
			.catch(() => {})
		this.queues.set(userID, next)
		next.then(() => {
			if (this.queues.get(userID) === next) this.queues.delete(userID)
		})
		return next
	}
}

module.exports.voiceStateTracker = voiceStateTracker
