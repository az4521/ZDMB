// @ts-check

/**
 * Discord voice connections for the main bot and the puppet bots.
 *
 * Every bot gets its own @discordjs/voice connection per guild, keyed by `group: bot.userID`.
 * The library is required lazily so that nothing here loads native dependencies unless the
 * voice bridge is actually started.
 */

/**
 * @typedef {Object} VoiceLib
 * @property {(options: any) => any} joinVoiceChannel
 * @property {(connection: any, status: any, timeout: number) => Promise<any>} entersState
 * @property {(guildID: string, group?: string) => any} getVoiceConnection
 * @property {Record<string, any>} VoiceConnectionStatus
 */

/**
 * @typedef {Object} GatewayClient the subset of a cloudstorm client that we use
 * @property {(event: string, listener: (...args: any[]) => void) => any} on
 * @property {(shardID: number, data: any) => any} voiceStateUpdate
 */

/**
 * @typedef {Object} RestClient the subset of a snowtransfer instance that we use
 * @property {{editSelf: (guildID: string, data: {nick?: string | null}) => Promise<any>}} guild
 */

/**
 * @typedef {Object} GatewayMessage
 * @property {string} t
 * @property {any} d
 */

/** Discord gateway voice state change: how long to wait for a bot to become Ready. */
const READY_TIMEOUT_MS = 20_000

/** @returns {VoiceLib} */
function loadVoiceLib() {
	return require("@discordjs/voice")
}

class VoiceBot {
	/**
	 * @param {Object} options
	 * @param {string | null} options.userID the bot's user ID (null until READY for puppets)
	 * @param {boolean} options.isMain
	 * @param {GatewayClient} options.cloud
	 * @param {RestClient} options.snow
	 * @param {() => VoiceLib} [options.voiceLib] injectable for tests
	 * @param {() => void} [options.onReady] called when this bot's READY arrives
	 */
	constructor({userID, isMain, cloud, snow, voiceLib = loadVoiceLib, onReady}) {
		/** @type {string | null} */
		this.userID = userID
		this.isMain = isMain
		/** @type {Set<string>} */
		this.guildIDs = new Set()
		this.cloud = cloud
		this.snow = snow
		this.voiceLib = voiceLib
		this.onReady = onReady
		/** @type {Map<string, {onVoiceStateUpdate: (d: any) => void, onVoiceServerUpdate: (d: any) => void, destroy: () => void}>} */
		this.adapters = new Map()
	}

	/**
	 * Join a voice channel in a guild and wait until the connection is Ready.
	 * @param {string} guildID
	 * @param {string} channelID
	 * @returns {Promise<any>} a VoiceConnection
	 */
	async join(guildID, channelID) {
		if (!this.userID) throw new Error("Voice bot is not ready yet")
		const voice = this.voiceLib()
		const connection = voice.joinVoiceChannel({
			channelId: channelID,
			guildId: guildID,
			group: this.userID,
			selfDeaf: false,
			selfMute: false,
			adapterCreator: this.adapterCreator(guildID),
		})
		try {
			await voice.entersState(connection, voice.VoiceConnectionStatus.Ready, READY_TIMEOUT_MS)
		} catch (e) {
			connection.destroy()
			throw e
		}
		return connection
	}

	/**
	 * Leave the voice channel in a guild, if connected.
	 * @param {string} guildID
	 */
	leave(guildID) {
		const connection = this.connection(guildID)
		if (connection) connection.destroy()
	}

	/**
	 * Change this bot's nickname in a guild. Null resets it. Failures (such as missing permissions) are logged and ignored.
	 * @param {string} guildID
	 * @param {string | null} nick
	 * @returns {Promise<void>}
	 */
	async setNick(guildID, nick) {
		try {
			await this.snow.guild.editSelf(guildID, {nick: nick ?? ""})
		} catch (e) {
			console.error(`[voice] Could not set nickname of bot ${this.userID} in guild ${guildID}:`, e)
		}
	}

	/**
	 * @param {string} guildID
	 * @returns {any} the VoiceConnection for this bot in the guild, or undefined
	 */
	connection(guildID) {
		if (!this.userID) return undefined
		return this.voiceLib().getVoiceConnection(guildID, this.userID)
	}

	/**
	 * Build the adapterCreator for one guild. The library calls it once per connection.
	 * @param {string} guildID
	 * @returns {(methods: any) => any}
	 */
	adapterCreator(guildID) {
		return methods => {
			this.adapters.set(guildID, methods)
			return {
				destroy: () => {
					if (this.adapters.get(guildID) === methods) this.adapters.delete(guildID)
				},
				sendPayload: payload => {
					if (payload.op !== 4) return false
					Promise.resolve(this.cloud.voiceStateUpdate(0, payload.d)).catch(e => {
						console.error(`[voice] Failed to send voice state update for bot ${this.userID}:`, e)
					})
					return true
				},
			}
		}
	}

	/**
	 * Forward a VOICE_STATE_UPDATE to the adapter if it is this bot's own voice state.
	 * @param {any} d
	 */
	handleVoiceStateUpdate(d) {
		if (!this.userID || d.user_id !== this.userID) return
		this.adapters.get(d.guild_id)?.onVoiceStateUpdate(d)
	}

	/**
	 * Forward a VOICE_SERVER_UPDATE to the adapter of its guild.
	 * @param {any} d
	 */
	handleVoiceServerUpdate(d) {
		this.adapters.get(d.guild_id)?.onVoiceServerUpdate(d)
	}

	/**
	 * Handle one gateway dispatch for this bot.
	 * @param {GatewayMessage} message
	 */
	handleGatewayMessage(message) {
		const {t, d} = message
		if (t === "READY") {
			this.userID = d.user.id
			this.guildIDs = new Set((d.guilds || []).map((/** @type {{id: string}} */ g) => g.id))
			this.onReady?.()
		} else if (t === "GUILD_CREATE") {
			this.guildIDs.add(d.id)
		} else if (t === "GUILD_DELETE") {
			this.guildIDs.delete(d.id)
		} else if (t === "VOICE_STATE_UPDATE") {
			this.handleVoiceStateUpdate(d)
		} else if (t === "VOICE_SERVER_UPDATE") {
			this.handleVoiceServerUpdate(d)
		}
	}

	/**
	 * The gateway dropped, so every voice connection of this bot is unusable.
	 */
	handleDisconnect() {
		const adapters = [...this.adapters.values()]
		this.adapters.clear()
		for (const adapter of adapters) adapter.destroy()
	}
}

/**
 * @typedef {Object} BotPoolOptions
 * @property {() => any} [getMain] returns the main Discord client (`passthrough.discord`)
 * @property {() => string[]} [getTokens] returns the puppet bot tokens
 * @property {(token: string) => {cloud: GatewayClient, snow: RestClient}} [createPuppetClient]
 * @property {() => VoiceLib} [voiceLib]
 */

class BotPool {
	/**
	 * @param {BotPoolOptions} [options]
	 */
	constructor({
		getMain = () => require("../passthrough").discord,
		getTokens = () => require("../matrix/read-registration").reg.ooye.voice_puppet_tokens || [],
		createPuppetClient = defaultCreatePuppetClient,
		voiceLib = loadVoiceLib,
	} = {}) {
		this.getMain = getMain
		this.getTokens = getTokens
		this.createPuppetClient = createPuppetClient
		this.voiceLib = voiceLib
		/** @type {VoiceBot | null} */
		this.main = null
		/** @type {VoiceBot[]} puppets that have reached READY */
		this.puppets = []
		/** @type {Map<string, Set<string>>} guildID -> userIDs of bots currently allocated there */
		this.allocations = new Map()
	}

	/**
	 * Set up the main bot and connect the puppet bots from config.
	 * Puppets join the pool when their READY arrives, which can be after this resolves.
	 */
	async init() {
		const discord = this.getMain()
		this.main = new VoiceBot({
			userID: discord.user.id,
			isMain: true,
			cloud: discord.cloud,
			snow: discord.snow,
			voiceLib: this.voiceLib,
		})
		if (typeof discord.cloud.on === "function") {
			discord.cloud.on("disconnected", () => this.main?.handleDisconnect())
		}

		for (const token of this.getTokens()) {
			const {cloud, snow} = this.createPuppetClient(token)
			/** @type {VoiceBot} */
			const bot = new VoiceBot({
				userID: null,
				isMain: false,
				cloud,
				snow,
				voiceLib: this.voiceLib,
				onReady: () => this.registerPuppet(bot),
			})
			cloud.on("event", (/** @type {GatewayMessage} */ message) => bot.handleGatewayMessage(message))
			cloud.on("disconnected", () => bot.handleDisconnect())
			try {
				await cloud.connect()
			} catch (e) {
				console.error("[voice] Puppet bot failed to connect:", e)
			}
		}
	}

	/**
	 * Add a puppet to the pool once it is Ready. Idempotent.
	 * @param {VoiceBot} bot
	 */
	registerPuppet(bot) {
		if (!this.puppets.includes(bot)) this.puppets.push(bot)
	}

	/**
	 * Route a main bot voice packet (VOICE_STATE_UPDATE / VOICE_SERVER_UPDATE) to the main bot's adapters.
	 * @param {GatewayMessage} message
	 */
	onMainBotPacket(message) {
		this.main?.handleGatewayMessage(message)
	}

	/**
	 * @returns {Set<string>} user IDs of the main bot and all puppets that are Ready
	 */
	allBotUserIDs() {
		const ids = new Set()
		if (this.main?.userID) ids.add(this.main.userID)
		for (const bot of this.puppets) {
			if (bot.userID) ids.add(bot.userID)
		}
		return ids
	}

	/**
	 * Take a free bot that is in the guild. One allocation per bot per guild.
	 * @param {string} guildID
	 * @param {{preferMain?: boolean}} [options] preferMain: try the main bot first; otherwise puppets first
	 * @returns {VoiceBot | null}
	 */
	acquire(guildID, {preferMain = false} = {}) {
		this.syncMainGuilds()
		const candidates = preferMain
			? [...(this.main ? [this.main] : []), ...this.puppets]
			: [...this.puppets, ...(this.main ? [this.main] : [])]
		const allocated = this.allocations.get(guildID) || new Set()
		for (const bot of candidates) {
			if (!bot.userID || !bot.guildIDs.has(guildID)) continue
			if (allocated.has(bot.userID)) continue
			allocated.add(bot.userID)
			this.allocations.set(guildID, allocated)
			return bot
		}
		return null
	}

	/**
	 * Leave voice in the guild, reset the nickname for puppets, and free the bot.
	 * @param {VoiceBot} bot
	 * @param {string} guildID
	 * @returns {Promise<void>}
	 */
	async release(bot, guildID) {
		const allocated = this.allocations.get(guildID)
		if (allocated) {
			if (bot.userID) allocated.delete(bot.userID)
			if (allocated.size === 0) this.allocations.delete(guildID)
		}
		bot.leave(guildID)
		if (!bot.isMain) await bot.setNick(guildID, null)
	}

	/**
	 * The main bot's guild list is owned by the Discord client, so read it fresh.
	 */
	syncMainGuilds() {
		if (!this.main) return
		const discord = this.getMain()
		this.main.guildIDs = new Set(discord.guilds.keys())
	}
}

/**
 * Create a puppet's REST and gateway clients. Modules are required here, not at load time.
 * @param {string} token
 * @returns {{cloud: GatewayClient, snow: RestClient}}
 */
function defaultCreatePuppetClient(token) {
	const {SnowTransfer} = require("snowtransfer")
	const {Client: CloudStorm} = require("cloudstorm")
	const snow = new SnowTransfer(token)
	const cloud = new CloudStorm(token, {
		shards: [0],
		intents: ["GUILDS", "GUILD_VOICE_STATES"],
		snowtransferInstance: snow,
		ws: {compress: false, encoding: "json"},
	})
	return {cloud, snow}
}

const pool = new BotPool()

/**
 * Called by discord-packets.js for the main bot's VOICE_STATE_UPDATE and VOICE_SERVER_UPDATE.
 * @param {GatewayMessage} message
 */
function onMainBotPacket(message) {
	pool.onMainBotPacket(message)
}

module.exports = {VoiceBot, BotPool, pool, onMainBotPacket}
