// @ts-check

/*
	Voice bridge orchestrator.

	One ChannelBridge per bridged Discord voice or stage channel (a channel_room row). A ChannelBridge is active while
	at least one human is present on either side:

	- Discord humans: each gets a ghost sim joined to the Matrix call, a LiveKit publisher, and a membership.
	  The anchor bot in the Discord channel receives their speech and feeds it to their publisher.
	- Matrix humans: the bridge bot listens to their LiveKit microphone tracks. Each track gets a dedicated puppet
	  if one is free, otherwise it is mixed into the anchor bot's output.

	Changes to a channel's humans and connections run through that channel's promise queue, so overlapping events can't race.
	Collaborators are read through `_deps` so that tests can replace them. Native voice libraries are only required
	when a voice connection is actually made.
*/

const passthrough = require("../passthrough")
const audio = require("./audio")
const livekit = require("./livekit")
const discordBots = require("./discord-bots")

/** Discord channel types that can be bridged: GuildVoice and GuildStageVoice */
const VOICE_CHANNEL_TYPES = new Set([2, 13])
/** How long a Discord speaker can be silent before their Opus subscription ends */
const SPEAKING_SILENCE_MS = 300
/** Mono samples in one 20 ms frame */
const MONO_FRAME_SAMPLES = 960
/** Jitter buffer settings for each Matrix participant */
const PARTICIPANT_BUFFER = {maxMs: 200, primeMs: 40}
/** Discord nickname length limit */
const MAX_NICK_LENGTH = 32

/**
 * Collaborators. Replace entries in tests. Each one is resolved when it is first used, so that loading this module
 * does not load any other module.
 */
const _deps = {
	/** @type {() => any} */
	reg: () => require("../matrix/read-registration").reg,
	/** @type {() => any} */
	pool: () => discordBots.pool,
	/** @type {() => any} */
	voiceLib: () => require("@discordjs/voice"),
	/** @type {() => any} */
	matrixRTC: () => require("./matrix-rtc"),
	/** @type {() => any} */
	livekit: () => livekit,
	/** @type {() => any} */
	registerUser: () => passthrough.sync.require("../d2m/actions/register-user"),
	/** @type {() => any} */
	api: () => passthrough.sync.require("../matrix/api"),
	/** @type {() => any} */
	mxUtils: () => passthrough.sync.require("../matrix/utils"),
	/** @type {() => any} */
	discord: () => passthrough.discord,
	/** @type {() => any} */
	createOpusDecoder: () => audio.createOpusDecoder(),
	/** @type {() => Promise<void>} */
	waitForGuilds: async () => {
		const {guildReadyStatus} = require("../d2m/discord-packets")
		if (guildReadyStatus.unavailableGuilds && !guildReadyStatus.allReady()) {
			await guildReadyStatus.waitForAllReady()
		}
	},
	/** @type {(channelID: string) => string | null} */
	roomIDForChannel: channelID => passthrough.select("channel_room", "room_id", {channel_id: channelID}).pluck().get() ?? null,
	/** @type {(roomID: string) => string | null} */
	channelIDForRoom: roomID => passthrough.select("channel_room", "channel_id", {room_id: roomID}).pluck().get() ?? null,
	/** @type {() => {channel_id: string, room_id: string}[]} */
	bridgedChannelRows: () => passthrough.select("channel_room", ["channel_id", "room_id"]).all(),
	/** @type {(userID: string) => string | null} */
	simMxid: userID => passthrough.select("sim", "mxid", {user_id: userID}).pluck().get() ?? null,
}

/**
 * @typedef {Object} Participant a Matrix user whose LiveKit microphone track is being bridged
 * @property {string} identity LiveKit identity, `${mxid}:${deviceID}`
 * @property {string} mxid
 * @property {import("./audio").JitterBuffer} buffer
 * @property {boolean} ended
 * @property {boolean} joining the dedicated puppet is still joining the channel
 * @property {any} bot dedicated puppet, if any
 * @property {any} player
 * @property {import("./audio").LivePcmStream | null} stream
 */

/**
 * @typedef {Object} PublisherEntry
 * @property {any} publisher
 * @property {string} mxid
 * @property {any} decoder Opus decoder for this speaker, created on first use
 */

/** @type {Map<string, ChannelBridge>} `${guildID}|${channelID}` to bridge */
const channelBridges = new Map()
/** @type {Map<string, {guildID: string, channelID: string}>} Discord user ID to the voice channel they are in */
const voiceByUser = new Map()
let started = false
/** @type {NodeJS.Timeout | null} */
let sweepTimer = null
let rejectionGuardInstalled = false

// How often to re-read the Matrix call members of active channels, so that a client that crashed without leaving the call
// (its membership just expires) doesn't keep the bridge in the Discord voice channel forever
const MATRIX_SWEEP_MS = 60e3

/**
 * Re-reads the call members of every channel with Matrix humans and drops the ones whose membership has gone or expired.
 */
async function sweepMatrixMembers() {
	const rtc = _deps.matrixRTC()
	for (const bridge of channelBridges.values()) {
		if (!bridge.matrixHumans.size) continue
		try {
			const current = new Set((await rtc.getRoomCallMembers(bridge.roomID)).map(member => member.mxid))
			for (const mxid of [...bridge.matrixHumans]) {
				if (!current.has(mxid)) bridge.setMatrixHuman(mxid, false)
			}
		} catch (e) {
			console.error(`[voice] could not re-read call members of ${bridge.roomID}:`, e)
		}
	}
}

/**
 * @param {string} guildID
 * @param {string} channelID
 */
function bridgeKey(guildID, channelID) {
	return `${guildID}|${channelID}`
}

/**
 * Ours: the bridge bot, or any sim (a Discord user's ghost).
 * @param {string} mxid
 * @returns {boolean}
 */
function isOursMxid(mxid) {
	const mxUtils = _deps.mxUtils()
	return mxid === mxUtils.bot || mxUtils.eventSenderIsFromDiscord(mxid)
}

/**
 * @param {string} channelID
 * @returns {boolean} true if the channel is cached and is a voice or stage channel
 */
function isVoiceChannel(channelID) {
	const channel = _deps.discord().channels.get(channelID)
	return !!channel && VOICE_CHANNEL_TYPES.has(channel.type)
}

/**
 * Play a live PCM stream through a voice connection.
 * @param {any} connection
 * @param {import("./audio").LivePcmStream} stream
 * @returns {any} the audio player
 */
function playStream(connection, stream) {
	const voice = _deps.voiceLib()
	const player = voice.createAudioPlayer({behaviors: {noSubscriber: voice.NoSubscriberBehavior.Play}})
	player.play(voice.createAudioResource(stream, {inputType: voice.StreamType.Raw}))
	connection.subscribe(player)
	return player
}

class ChannelBridge {
	/**
	 * @param {{guildID: string, channelID: string, roomID: string}} ids
	 */
	constructor({guildID, channelID, roomID}) {
		this.guildID = guildID
		this.channelID = channelID
		this.roomID = roomID
		/** @type {Map<string, any>} Discord user ID to APIUser, or {id} when the full user is not known */
		this.discordHumans = new Map()
		/** @type {Map<string, any>} Discord user ID to guild member from the voice state, when known */
		this.discordMembers = new Map()
		/** @type {Set<string>} Matrix mxids that are in the call (ours excluded) */
		this.matrixHumans = new Set()
		/** @type {Map<string, PublisherEntry>} Discord user ID to their ghost publisher */
		this.publishers = new Map()
		/** @type {Map<string, {stream: any}>} Discord user ID to their live Opus subscription */
		this.speakers = new Map()
		/** @type {Map<string, Participant>} LiveKit identity to Matrix participant */
		this.participants = new Map()
		/** @type {Map<string, Participant>} participants mixed into the anchor's output */
		this.overflow = new Map()
		/** @type {Set<Promise<any>>} background work for participants, awaited by idle() */
		this.pending = new Set()
		/** @type {Promise<void>} */
		this.queue = Promise.resolve()

		this.active = false
		/** @type {any} the bot that holds the channel's voice connection */
		this.anchor = null
		/** @type {any} */
		this.connection = null
		/** @type {import("./audio").LivePcmStream | null} */
		this.anchorStream = null
		/** @type {any} */
		this.anchorPlayer = null
		/** @type {((userID: string) => void) | null} */
		this.onStart = null
		/** @type {any} the LiveKit listener */
		this.listener = null
	}

	/**
	 * Run a task after everything already queued for this channel.
	 * @param {() => any} task
	 * @returns {Promise<void>}
	 */
	enqueue(task) {
		const run = this.queue.then(task)
		this.queue = run.catch(e => {
			console.error(`[voice] channel ${this.channelID} failed:`, e)
		})
		return this.queue
	}

	/**
	 * Track background work so that idle() can wait for it.
	 * @param {Promise<any>} promise
	 */
	track(promise) {
		const tracked = promise.catch(e => {
			console.error(`[voice] channel ${this.channelID} failed:`, e)
		})
		this.pending.add(tracked)
		tracked.then(() => this.pending.delete(tracked))
		return tracked
	}

	/**
	 * Resolves once the queue and all participant work are finished. Intended for tests.
	 */
	async idle() {
		let last = null
		while (last !== this.queue || this.pending.size > 0) {
			last = this.queue
			await last
			await Promise.all([...this.pending])
		}
	}

	/**
	 * @param {any} user APIUser, or {id} if the full user is not known
	 * @param {any} [member] guild member from the voice state
	 * @param {Promise<void>} [after] resolves once the user has left their previous channel, so that a bot isn't double-booked
	 */
	addDiscordHuman(user, member, after) {
		if (user.bot) return // bot accounts are never bridged
		const existing = this.discordHumans.get(user.id)
		if (!existing || user.username) this.discordHumans.set(user.id, user)
		if (member) this.discordMembers.set(user.id, member)
		this.enqueue(async () => {
			await after
			await this.reconcile()
		})
	}

	/**
	 * @param {string} userID
	 * @returns {Promise<void>} resolves once the channel has reconciled the departure
	 */
	removeDiscordHuman(userID) {
		this.discordHumans.delete(userID)
		this.discordMembers.delete(userID)
		return this.enqueue(() => this.reconcile())
	}

	/**
	 * @param {string} mxid
	 * @param {boolean} present whether the user is in the Matrix call
	 */
	setMatrixHuman(mxid, present) {
		if (present) {
			this.matrixHumans.add(mxid)
		} else {
			this.matrixHumans.delete(mxid)
			this.enqueue(() => this.endMatrixParticipants(mxid))
		}
		this.enqueue(() => this.reconcile())
	}

	/**
	 * Forget every human and tear the channel down.
	 * @returns {Promise<void>}
	 */
	shutdown() {
		this.discordHumans.clear()
		this.discordMembers.clear()
		this.matrixHumans.clear()
		return this.enqueue(() => this.reconcile())
	}

	/**
	 * Brings the channel in line with its humans. Only run from the queue.
	 */
	async reconcile() {
		const wanted = this.discordHumans.size + this.matrixHumans.size > 0
		if (!wanted) {
			await this.teardown()
			return
		}
		if (!this.active) {
			const activated = await this.activate()
			if (!activated) return
		}
		await this.syncDiscordHumans()
	}

	/**
	 * Takes the anchor bot into the channel and connects the listener. Only run from the queue.
	 * @returns {Promise<boolean>} false if the channel could not be activated
	 */
	async activate() {
		const anchor = _deps.pool().acquire(this.guildID, {preferMain: true})
		if (!anchor) {
			console.error(`[voice] no free bot in guild ${this.guildID} to join channel ${this.channelID}, so it is not bridged yet`)
			return false
		}
		this.anchor = anchor
		try {
			const connection = await anchor.join(this.guildID, this.channelID)
			this.connection = connection
			this.onStart = userID => {
				try {
					this.onSpeakingStart(userID)
				} catch (e) {
					console.error(`[voice] failed to handle speech from ${userID}:`, e)
				}
			}
			connection.receiver.speaking.on("start", this.onStart)
			this.anchorStream = new audio.LivePcmStream(() => this.pullOverflow())
			this.anchorPlayer = playStream(connection, this.anchorStream)
			this.active = true

			const lk = _deps.livekit()
			const credentials = await _deps.matrixRTC().getLiveKitCredentials(_deps.mxUtils().bot, this.roomID)
			const listener = new lk.Listener({
				...credentials,
				isOurs: (/** @type {string} */ identity) => isOursMxid(lk.mxidFromIdentity(identity)),
			})
			this.listener = listener
			listener.on("trackStart", (/** @type {string} */ identity, /** @type {string} */ mxid) => {
				if (this.listener === listener) this.onTrackStart(identity, mxid)
			})
			listener.on("audio", (/** @type {string} */ identity, /** @type {Int16Array} */ samples) => {
				if (this.listener === listener) this.onAudio(identity, samples)
			})
			listener.on("trackEnd", (/** @type {string} */ identity) => {
				if (this.listener === listener) this.onTrackEnd(identity)
			})
			listener.on("disconnected", (/** @type {any} */ reason) => {
				console.error(`[voice] listener for ${this.roomID} disconnected:`, reason)
			})
			await listener.connect()
			return true
		} catch (e) {
			console.error(`[voice] could not start bridging channel ${this.channelID}:`, e)
			await this.teardown()
			return false
		}
	}

	/**
	 * Undoes whatever activate() set up. Safe to call when nothing is active. Only run from the queue.
	 */
	async teardown() {
		const {anchor, connection, onStart, anchorPlayer, anchorStream, listener} = this
		this.active = false
		this.anchor = null
		this.connection = null
		this.onStart = null
		this.anchorPlayer = null
		this.anchorStream = null
		this.listener = null

		if (listener) {
			try {
				await listener.close()
			} catch (e) {
				console.error(`[voice] failed to close listener for ${this.roomID}:`, e)
			}
		}
		for (const userID of [...this.speakers.keys()]) this.stopSpeaker(userID)
		for (const userID of [...this.publishers.keys()]) await this.teardownDiscordHuman(userID)
		for (const participant of [...this.participants.values()]) await this.endParticipant(participant)

		if (connection && onStart) connection.receiver?.speaking?.off?.("start", onStart)
		try { anchorPlayer?.stop() } catch (e) {}
		try { anchorStream?.stop() } catch (e) {}
		if (anchor) await _deps.pool().release(anchor, this.guildID)
	}

	/**
	 * Makes publishers match the Discord humans. Only run from the queue.
	 */
	async syncDiscordHumans() {
		for (const userID of [...this.publishers.keys()]) {
			if (!this.discordHumans.has(userID)) await this.teardownDiscordHuman(userID)
		}
		for (const userID of [...this.discordHumans.keys()]) {
			if (!this.publishers.has(userID)) await this.setupDiscordHuman(userID)
		}
	}

	/**
	 * Gives a Discord human a sim in the room, a membership, and a publisher. Failures are logged. Only run from the queue.
	 * @param {string} userID
	 */
	async setupDiscordHuman(userID) {
		const user = this.discordHumans.get(userID)
		const member = this.discordMembers.get(userID)
		const rtc = _deps.matrixRTC()
		/** @type {string | null} */
		let mxid = null
		try {
			const discord = _deps.discord()
			const channel = discord.channels.get(this.channelID)
			const guild = discord.guilds.get(this.guildID)
			if (member && guild && channel) {
				mxid = await _deps.registerUser().syncUser(user, member, channel, guild, this.roomID)
			} else {
				if (!user.username && !_deps.simMxid(userID)) {
					console.error(`[voice] cannot make a sim for Discord user ${userID} without their profile`)
					return
				}
				mxid = await _deps.registerUser().ensureSimJoined(user, this.roomID)
			}
			await rtc.memberships.join(this.roomID, mxid)
			const credentials = await rtc.getLiveKitCredentials(mxid, this.roomID)
			const publisher = new (_deps.livekit().Publisher)(credentials)
			try {
				await publisher.connect()
			} catch (e) {
				await publisher.close()
				throw e
			}
			this.publishers.set(userID, {publisher, mxid, decoder: null})
		} catch (e) {
			console.error(`[voice] could not bridge Discord user ${userID} into ${this.roomID}:`, e)
			if (mxid) await rtc.memberships.leave(this.roomID, mxid)
		}
	}

	/**
	 * @param {string} userID
	 */
	async teardownDiscordHuman(userID) {
		const entry = this.publishers.get(userID)
		if (!entry) return
		this.publishers.delete(userID)
		this.stopSpeaker(userID)
		try {
			await entry.publisher.close()
		} catch (e) {
			console.error(`[voice] failed to close publisher for ${userID}:`, e)
		}
		await _deps.matrixRTC().memberships.leave(this.roomID, entry.mxid)
	}

	/**
	 * Called when the anchor's receiver sees someone start speaking. Subscribes to their Opus packets and feeds
	 * the decoded audio to their publisher.
	 * @param {string} userID
	 */
	onSpeakingStart(userID) {
		const connection = this.connection
		const entry = this.publishers.get(userID)
		if (!this.active || !connection || !entry || this.speakers.has(userID)) return
		if (!entry.decoder) entry.decoder = _deps.createOpusDecoder()
		const voice = _deps.voiceLib()
		const opus = connection.receiver.subscribe(userID, {
			end: {behavior: voice.EndBehaviorType.AfterSilence, duration: SPEAKING_SILENCE_MS},
		})
		const speaker = {stream: opus}
		this.speakers.set(userID, speaker)
		const cleanup = () => {
			if (this.speakers.get(userID) === speaker) this.speakers.delete(userID)
		}
		opus.on("data", (/** @type {Buffer} */ packet) => {
			try {
				entry.publisher.pushMono(audio.stereoToMono(entry.decoder.decode(packet)))
			} catch (e) {
				// A single bad packet is dropped
			}
		})
		opus.on("end", cleanup)
		opus.on("close", cleanup)
		opus.on("error", cleanup)
	}

	/**
	 * @param {string} userID
	 */
	stopSpeaker(userID) {
		const speaker = this.speakers.get(userID)
		if (!speaker) return
		this.speakers.delete(userID)
		try { speaker.stream.destroy() } catch (e) {}
	}

	/**
	 * A Matrix participant started publishing. Their audio goes to a dedicated puppet if one is free, otherwise into the overflow mix.
	 * @param {string} identity
	 * @param {string} mxid
	 */
	onTrackStart(identity, mxid) {
		if (this.participants.has(identity)) return
		/** @type {Participant} */
		const participant = {
			identity,
			mxid,
			buffer: new audio.JitterBuffer(PARTICIPANT_BUFFER),
			ended: false,
			joining: false,
			bot: null,
			player: null,
			stream: null,
		}
		this.participants.set(identity, participant)
		this.track(this.attachParticipant(participant))
	}

	/**
	 * @param {Participant} participant
	 */
	async attachParticipant(participant) {
		const pool = _deps.pool()
		const bot = pool.acquire(this.guildID)
		if (bot) {
			participant.bot = bot
			participant.joining = true
			/** @type {any} */
			let connection = null
			try {
				connection = await bot.join(this.guildID, this.channelID)
				await bot.setNick(this.guildID, await this.nickFor(participant.mxid))
			} catch (e) {
				console.error(`[voice] dedicated bot could not join for ${participant.mxid}, so it is mixed in instead:`, e)
			}
			participant.joining = false
			if (connection && !participant.ended) {
				const stream = new audio.LivePcmStream(() => audio.monoToStereo(participant.buffer.read(MONO_FRAME_SAMPLES)))
				participant.stream = stream
				participant.player = playStream(connection, stream)
				return
			}
			// Failed, or the participant left while joining: give the bot back
			participant.bot = null
			await pool.release(bot, this.guildID)
		}
		if (!participant.ended) this.overflow.set(participant.identity, participant)
	}

	/**
	 * Display name for a puppet: the Matrix display name, or the localpart.
	 * @param {string} mxid
	 * @returns {Promise<string>}
	 */
	async nickFor(mxid) {
		const localpart = mxid.slice(1).split(":")[0]
		let name = localpart
		try {
			const content = await _deps.api().getStateEvent(this.roomID, "m.room.member", mxid)
			if (typeof content?.displayname === "string" && content.displayname) name = content.displayname
		} catch (e) {
			// Use the localpart
		}
		return Array.from(name).slice(0, MAX_NICK_LENGTH).join("")
	}

	/**
	 * @param {string} identity
	 * @param {Int16Array} samples
	 */
	onAudio(identity, samples) {
		const participant = this.participants.get(identity)
		if (participant) participant.buffer.push(samples)
	}

	/**
	 * @param {string} identity
	 */
	onTrackEnd(identity) {
		const participant = this.participants.get(identity)
		if (participant) this.track(this.endParticipant(participant))
	}

	/**
	 * Stops a participant's audio and gives their puppet back. Idempotent.
	 * @param {Participant} participant
	 */
	async endParticipant(participant) {
		if (participant.ended) return
		participant.ended = true
		if (this.participants.get(participant.identity) === participant) this.participants.delete(participant.identity)
		this.overflow.delete(participant.identity)
		try { participant.stream?.stop() } catch (e) {}
		try { participant.player?.stop() } catch (e) {}
		participant.stream = null
		participant.player = null
		// While the puppet is still joining, attachParticipant gives it back once the join finishes
		if (participant.bot && !participant.joining) {
			const bot = participant.bot
			participant.bot = null
			await _deps.pool().release(bot, this.guildID)
		}
	}

	/**
	 * @param {string} mxid
	 */
	async endMatrixParticipants(mxid) {
		for (const participant of [...this.participants.values()]) {
			if (participant.mxid === mxid) await this.endParticipant(participant)
		}
	}

	/**
	 * Mixes the overflow participants for the anchor's output.
	 * @returns {Buffer | null} one stereo frame, or null for silence when nobody is overflowing
	 */
	pullOverflow() {
		if (this.overflow.size === 0) return null
		const frames = [...this.overflow.values()].map(participant => participant.buffer.read(MONO_FRAME_SAMPLES))
		return audio.monoToStereo(audio.mixMono(frames, MONO_FRAME_SAMPLES))
	}
}

/**
 * @param {string} guildID
 * @param {string} channelID
 * @param {string} roomID
 * @returns {ChannelBridge}
 */
function getOrCreateBridge(guildID, channelID, roomID) {
	const key = bridgeKey(guildID, channelID)
	let bridge = channelBridges.get(key)
	if (!bridge) {
		bridge = new ChannelBridge({guildID, channelID, roomID})
		channelBridges.set(key, bridge)
	}
	return bridge
}

/**
 * @param {string} channelID
 * @returns {string | null} the room ID if the channel is a bridged voice channel
 */
function bridgedRoomForChannel(channelID) {
	if (!isVoiceChannel(channelID)) return null
	return _deps.roomIDForChannel(channelID)
}

/**
 * @param {any} data a VOICE_STATE_UPDATE payload
 */
function handleVoiceState(data) {
	const userID = data.user_id
	const guildID = data.guild_id
	if (!userID || !guildID) return
	if (_deps.pool().allBotUserIDs().has(userID)) return

	const channelID = data.channel_id ?? null
	const previous = voiceByUser.get(userID)
	/** @type {Promise<void> | undefined} */
	let left
	if (previous && (previous.channelID !== channelID || previous.guildID !== guildID)) {
		voiceByUser.delete(userID)
		left = channelBridges.get(bridgeKey(previous.guildID, previous.channelID))?.removeDiscordHuman(userID)
	}
	if (!channelID) return

	voiceByUser.set(userID, {guildID, channelID})
	const roomID = bridgedRoomForChannel(channelID)
	if (!roomID) return
	const member = data.member
	const user = member?.user ?? {id: userID}
	getOrCreateBridge(guildID, channelID, roomID).addDiscordHuman(user, member, left)
}

/**
 * @param {any} event a call member state event
 */
function handleMatrixCallMember(event) {
	const rtc = _deps.matrixRTC()
	if (!rtc.isCallMemberEventType(event.type)) return
	const sender = event.sender
	if (isOursMxid(sender)) return
	const roomID = event.room_id
	const channelID = _deps.channelIDForRoom(roomID)
	if (!channelID || !isVoiceChannel(channelID)) return
	const guildID = _deps.discord().channels.get(channelID).guild_id
	const inCall = rtc.parseCallMembers([event]).some((/** @type {{mxid: string}} */ m) => m.mxid === sender)
	getOrCreateBridge(guildID, channelID, roomID).setMatrixHuman(sender, inCall)
}

/**
 * Starts the bridge. Does nothing unless `reg.ooye.voice_bridge` is set.
 * @returns {Promise<void>}
 */
async function start() {
	if (!_deps.reg().ooye.voice_bridge) return
	if (started) return
	await _deps.waitForGuilds()
	const pool = _deps.pool()
	await pool.init()
	started = true

	channelBridges.clear()
	voiceByUser.clear()
	const discord = _deps.discord()
	const bots = pool.allBotUserIDs()

	// Everyone already in voice, so that moves and leaves are tracked from now on
	/** @type {{userID: string, channelID: string, member: any}[]} */
	const inVoice = []
	for (const [guildID, guild] of discord.guilds) {
		for (const state of guild.voice_states ?? []) {
			if (!state.channel_id || bots.has(state.user_id)) continue
			voiceByUser.set(state.user_id, {guildID, channelID: state.channel_id})
			inVoice.push({userID: state.user_id, channelID: state.channel_id, member: state.member})
		}
	}

	const rtc = _deps.matrixRTC()
	for (const row of _deps.bridgedChannelRows()) {
		const channel = discord.channels.get(row.channel_id)
		if (!channel || !VOICE_CHANNEL_TYPES.has(channel.type)) continue
		const bridge = getOrCreateBridge(channel.guild_id, row.channel_id, row.room_id)

		try {
			await rtc.clearStaleOwnMemberships(row.room_id)
		} catch (e) {
			console.error(`[voice] could not clear stale memberships in ${row.room_id}:`, e)
		}
		for (const seed of inVoice) {
			if (seed.channelID === row.channel_id) bridge.addDiscordHuman(seed.member?.user ?? {id: seed.userID}, seed.member)
		}
		try {
			for (const member of await rtc.getRoomCallMembers(row.room_id)) {
				if (!isOursMxid(member.mxid)) bridge.setMatrixHuman(member.mxid, true)
			}
		} catch (e) {
			console.error(`[voice] could not read call members of ${row.room_id}:`, e)
		}
	}

	sweepTimer = setInterval(() => {
		sweepMatrixMembers().catch(e => console.error("[voice] call member sweep failed:", e))
	}, MATRIX_SWEEP_MS)
	sweepTimer.unref()

	// The voice code talks to native libraries and live services that can fail in ways the tests can't cover.
	// Node exits on an unhandled rejection, which would also take down text bridging, so while the voice bridge is on, log them instead.
	if (!rejectionGuardInstalled) {
		rejectionGuardInstalled = true
		process.on("unhandledRejection", reason => {
			console.error("[voice] unhandled promise rejection (logged instead of exiting because the voice bridge is on):", reason)
		})
	}

	console.log(`[voice] voice bridge started with ${pool.puppets?.length ?? 0} puppet bot(s)`)
}

/**
 * Hook for every VOICE_STATE_UPDATE. Never throws.
 * @param {any} data the gateway payload: guild_id, channel_id (null when leaving), user_id, member
 */
function onDiscordVoiceState(data) {
	if (!started) return
	try {
		handleVoiceState(data)
	} catch (e) {
		console.error("[voice] failed to handle a voice state update:", e)
	}
}

/**
 * Hook for call member state events in any room. Never throws.
 * @param {any} event
 */
function onMatrixCallMemberEvent(event) {
	if (!started) return
	try {
		handleMatrixCallMember(event)
	} catch (e) {
		console.error("[voice] failed to handle a call member event:", e)
	}
}

/**
 * Tears down every bridged call and leaves all ghost memberships. Best effort.
 * @returns {Promise<void>}
 */
async function stop() {
	if (!started) return
	started = false
	if (sweepTimer) clearInterval(sweepTimer)
	sweepTimer = null
	const bridges = [...channelBridges.values()]
	await Promise.allSettled(bridges.map(bridge => bridge.shutdown()))
	channelBridges.clear()
	voiceByUser.clear()
	try {
		await _deps.matrixRTC().memberships.leaveAll()
	} catch (e) {
		console.error("[voice] failed to leave calls on shutdown:", e)
	}
}

/**
 * Waits for all queued channel work. Intended for tests.
 */
async function _idle() {
	await Promise.all([...channelBridges.values()].map(bridge => bridge.idle()))
}

module.exports = {
	start,
	stop,
	onDiscordVoiceState,
	onMatrixCallMemberEvent,
	ChannelBridge,
	_channelBridges: channelBridges,
	_deps,
	_idle,
	_sweepMatrixMembers: sweepMatrixMembers,
}
