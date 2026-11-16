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
const soundboard = require("./soundboard")
const voicePermissions = require("./permissions")

/** Discord channel types that can be bridged: GuildVoice and GuildStageVoice */
const VOICE_CHANNEL_TYPES = new Set([2, 13])
/** How long a Discord speaker can be silent before their Opus subscription ends */
const SPEAKING_SILENCE_MS = 300
/** Mono samples in one 20 ms frame */
const MONO_FRAME_SAMPLES = 960
/** Jitter buffer settings for each Matrix participant */
const PARTICIPANT_BUFFER = {maxMs: 200, primeMs: 40}
/** How often each active channel logs its one-line voice summary */
const STATS_INTERVAL_MS = 10e3
/** Discord nickname length limit */
const MAX_NICK_LENGTH = 32
/** Sounds from one Matrix sender closer together than this are dropped, as Zam does */
const SOUND_MIN_GAP_MS = 250
/** At most this many sounds from one Matrix sender play at once, as Zam does */
const SOUND_MAX_CONCURRENT = 3
/** Assumed length of a native Discord soundboard sound (Discord caps them at 5 s), for the concurrency limit */
const NATIVE_SOUND_MS = 5000
/** Players give up (go Idle) after this many 20 ms frames in a row with nothing to play. The library default is 5. */
const MAX_MISSED_FRAMES = 50
/** A player that went Idle while still wanted is restarted, but no more often than this */
const RESTART_MIN_MS = 1000
/** Decoded sounds, by mxc URL */
const soundCache = new soundboard.LruCache(16)
/** Set after ffmpeg is found to be missing, so that it is reported once and Matrix sounds are then skipped */
let ffmpegMissing = false
/** Discord soundboard sounds being bridged, so that _idle() can wait for them */
const pendingDiscordSounds = new Set()
/** Voice connections whose state changes are already logged */
const loggedConnections = new WeakSet()

/**
 * Per-channel counters for the summary line, reset every STATS_INTERVAL_MS.
 * @returns {{matrixAudio: number, discordFrames: number, anchor: {nonSilent: number, silent: number}, puppet: {nonSilent: number, silent: number}}}
 */
function newStats() {
	return {matrixAudio: 0, discordFrames: 0, anchor: {nonSilent: 0, silent: 0}, puppet: {nonSilent: 0, silent: 0}}
}

/**
 * @param {Int16Array} samples
 * @returns {boolean} true when every sample is zero
 */
function isSilentSamples(samples) {
	for (let i = 0; i < samples.length; i++) {
		if (samples[i] !== 0) return false
	}
	return true
}

/**
 * Runs logging-only setup. Logging must never break audio, so any failure is ignored.
 * @param {() => void} attach
 */
function attachLogging(attach) {
	try {
		attach()
	} catch (e) {}
}

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
	/** @type {() => any} */
	file: () => passthrough.sync.require("../matrix/file"),
	/** @type {(mxc: string) => string[]} */
	discordURLsForMxc: mxc => passthrough.select("file", "discord_url", {mxc_url: mxc}).pluck().all(),
	/** @type {(buffer: Buffer) => Promise<Int16Array>} */
	decodeToPcm: buffer => soundboard.decodeToPcm(buffer),
}

/**
 * @typedef {Object} Participant a Matrix user whose LiveKit microphone track is being bridged
 * @property {string} identity LiveKit identity, `${mxid}:${deviceID}`
 * @property {string} mxid
 * @property {import("./audio").JitterBuffer} buffer
 * @property {boolean} ended
 * @property {boolean} joining the dedicated puppet is still joining the channel
 * @property {any} bot dedicated puppet, if any
 * @property {PcmPlayback | null} playback the puppet's audio, once it is playing
 * @property {import("./soundboard").SoundClips} clips sounds playing on top of this participant's audio
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
 * @typedef {Object} PcmPlayback a live PCM feed playing through a voice connection
 * @property {() => void} stop ends the feed and its player. Never restarts it.
 */

/**
 * Plays a live PCM feed through a voice connection. If the player goes Idle while `isWanted()` still holds, the feed is
 * started again with a fresh player and stream that pull from the same source, at most once per RESTART_MIN_MS.
 * @param {any} connection
 * @param {() => Buffer | null} pull returns the next 3840-byte stereo frame, or null for silence. Must not block.
 * @param {string} label who this audio is for, used in log lines
 * @param {() => boolean} isWanted whether the owner still wants this audio playing
 * @returns {PcmPlayback}
 */
function playPcm(connection, pull, label, isWanted) {
	const voice = _deps.voiceLib()
	let stopped = false
	/** @type {any} the current player */
	let player = null
	/** @type {import("./audio").LiveOpusStream | null} the current stream */
	let stream = null
	/** @type {ReturnType<typeof setTimeout> | null} */
	let restartTimer = null
	let startedAt = -Infinity

	/** Creates a player and a stream for `pull`, and starts them. */
	function start() {
		startedAt = Date.now()
		const currentPlayer = voice.createAudioPlayer({behaviors: {noSubscriber: voice.NoSubscriberBehavior.Play, maxMissedFrames: MAX_MISSED_FRAMES}})
		const currentStream = new audio.LiveOpusStream(pull)
		player = currentPlayer
		stream = currentStream
		attachLogging(() => {
			currentPlayer.on("error", (/** @type {any} */ e) => console.error(`[voice] ${label} player error:`, e))
			currentPlayer.on("stateChange", (/** @type {any} */ oldState, /** @type {any} */ newState) => {
				console.log(`[voice] ${label} player: ${oldState?.status} -> ${newState?.status}`)
				if (newState?.status === "idle" && oldState?.status !== "idle") onIdle(currentPlayer)
			})
		})
		attachLogging(() => {
			if (loggedConnections.has(connection)) return
			loggedConnections.add(connection)
			connection.on("stateChange", (/** @type {any} */ oldState, /** @type {any} */ newState) => {
				console.log(`[voice] voice connection to channel ${connection.joinConfig?.channelId}: ${oldState?.status} -> ${newState?.status}`)
			})
		})
		// The packets are already Opus, so the library plays them as they are with no encoder buffering frames ahead
		currentPlayer.play(voice.createAudioResource(currentStream, {inputType: voice.StreamType.Opus}))
		const subscription = connection.subscribe(currentPlayer)
		if (subscription) {
			console.log(`[voice] ${label} player subscribed to its voice connection`)
		} else {
			console.error(`[voice] ${label} player is NOT subscribed: connection.subscribe(player) returned undefined`)
		}
	}

	/** @param {any} went the player that just went Idle */
	function onIdle(went) {
		if (stopped || went !== player || restartTimer || !isWanted()) return
		console.error(`[voice] ${label} player went Idle while its audio is still wanted, so it is started again`)
		restartTimer = setTimeout(restart, Math.max(0, startedAt + RESTART_MIN_MS - Date.now()))
	}

	function restart() {
		restartTimer = null
		if (stopped || !isWanted()) return
		try { stream?.stop() } catch (e) {}
		start()
	}

	start()
	return {
		stop() {
			stopped = true
			if (restartTimer) clearTimeout(restartTimer)
			restartTimer = null
			const oldPlayer = player
			const oldStream = stream
			player = null
			stream = null
			try { oldPlayer?.stop() } catch (e) {}
			try { oldStream?.stop() } catch (e) {}
		},
	}
}

/**
 * One mono frame of a Matrix participant: their voice, with any sound clips mixed on top.
 * @param {Participant} participant
 * @returns {Int16Array}
 */
function participantFrame(participant) {
	const voice = participant.buffer.read(MONO_FRAME_SAMPLES)
	const clip = participant.clips.read(MONO_FRAME_SAMPLES)
	return clip ? audio.mixMono([voice, clip], MONO_FRAME_SAMPLES) : voice
}

/**
 * @param {string} mxc
 * @returns {string | null} the Discord soundboard sound ID if this mxc is a sound we uploaded from Discord
 */
function discordSoundIDForMxc(mxc) {
	for (const url of _deps.discordURLsForMxc(mxc)) {
		const match = soundboard.DISCORD_SOUND_URL.exec(url)
		if (match) return match[1]
	}
	return null
}

/**
 * @param {string} soundID
 * @returns {string | null} the cached guild that owns this Discord soundboard sound, or null if none does
 */
function guildIDForSound(soundID) {
	for (const [guildID, guild] of _deps.discord().guilds) {
		if (guild.soundboard_sounds?.some((/** @type {{sound_id: string}} */ sound) => String(sound.sound_id) === soundID)) return guildID
	}
	return null
}

/**
 * Downloads a Matrix sound and decodes it to 48 kHz mono PCM. Cached by mxc URL.
 * @param {string} mxc
 * @returns {Promise<Int16Array | null>} null when ffmpeg is missing, so the sound is skipped
 */
async function loadSoundPcm(mxc) {
	const cached = soundCache.get(mxc)
	if (cached) return cached
	if (ffmpegMissing) return null

	const response = await _deps.api().getMedia(mxc)
	if (!response.ok) throw new Error(`could not download ${mxc}: HTTP ${response.status}`)
	const declared = Number(response.headers.get("content-length") ?? 0)
	if (declared > soundboard.MAX_SOUND_BYTES) throw new Error(`${mxc} is ${declared} bytes, over the ${soundboard.MAX_SOUND_BYTES} byte limit`)
	const buffer = Buffer.from(await response.arrayBuffer())
	if (buffer.length > soundboard.MAX_SOUND_BYTES) throw new Error(`${mxc} is ${buffer.length} bytes, over the ${soundboard.MAX_SOUND_BYTES} byte limit`)

	let samples
	try {
		samples = await _deps.decodeToPcm(buffer)
	} catch (e) {
		if (e?.code === "FFMPEG_NOT_FOUND") {
			if (!ffmpegMissing) {
				ffmpegMissing = true
				console.error("[voice] soundboard sounds from Matrix can't be mixed in without ffmpeg, so they are skipped:", e.message)
			}
			return null
		}
		throw e
	}
	soundCache.set(mxc, samples)
	return samples
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
		/** @type {PcmPlayback | null} the anchor's output */
		this.anchorPlayback = null
		/** @type {((userID: string) => void) | null} */
		this.onStart = null
		/** @type {any} the LiveKit listener */
		this.listener = null
		/** @type {import("./soundboard").SoundClips} sounds from senders that have no track of their own, mixed into the anchor's output */
		this.soundClips = new soundboard.SoundClips()
		/** @type {Map<string, {lastAt: number, slots: {endsAt: number}[]}>} LiveKit identity to that sender's recent sounds */
		this.soundSenders = new Map()
		/** @type {ReturnType<typeof newStats>} counters for the summary line */
		this.stats = newStats()
		/** @type {NodeJS.Timeout | null} */
		this.statsTimer = null
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
			this.anchorPlayback = playPcm(connection, () => this.pullOverflow(), `anchor ${anchor.userID} in ${this.channelID}`, () => this.active && this.connection === connection)
			this.active = true
			this.startStatsTimer()

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
			listener.on("soundboard", (/** @type {string} */ identity, /** @type {{url: string, shortcode: string}} */ sound) => {
				if (this.listener === listener) this.onSoundboard(identity, sound)
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
		const {anchor, connection, onStart, anchorPlayback, listener} = this
		this.active = false
		this.stopStatsTimer()
		this.anchor = null
		this.soundClips.clear()
		this.connection = null
		this.onStart = null
		this.anchorPlayback = null
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
		try { anchorPlayback?.stop() } catch (e) {}
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
				this.stats.discordFrames++
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
		console.log(`[voice] ${mxid} started a microphone track (${identity}) in ${this.channelID}`)
		/** @type {Participant} */
		const participant = {
			identity,
			mxid,
			buffer: new audio.JitterBuffer(PARTICIPANT_BUFFER),
			ended: false,
			joining: false,
			bot: null,
			playback: null,
			clips: new soundboard.SoundClips(),
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
			console.log(`[voice] ${participant.mxid} is joining ${this.channelID} on dedicated puppet ${bot.userID}`)
			/** @type {any} */
			let connection = null
			try {
				connection = await bot.join(this.guildID, this.channelID)
				await bot.setNick(this.guildID, await this.nickFor(participant.mxid))
			} catch (e) {
				console.error(`[voice] dedicated bot ${bot.userID} could not join for ${participant.mxid}, so it is mixed in instead:`, e)
			}
			participant.joining = false
			if (connection && !participant.ended) {
				participant.playback = playPcm(connection, () => {
					const mono = participantFrame(participant)
					this.countFrame("puppet", mono)
					return audio.monoToStereo(mono)
				}, `puppet ${bot.userID} for ${participant.mxid}`, () => !participant.ended)
				console.log(`[voice] ${participant.mxid} is on dedicated puppet ${bot.userID}`)
				return
			}
			// Failed, or the participant left while joining: give the bot back
			console.log(`[voice] puppet ${bot.userID} for ${participant.mxid} is released without playing (${connection ? "participant left" : "join failed"})`)
			participant.bot = null
			await pool.release(bot, this.guildID)
		} else {
			console.log(`[voice] no free puppet for ${participant.mxid} in guild ${this.guildID}, so it is mixed into the anchor's output`)
		}
		if (!participant.ended) {
			this.overflow.set(participant.identity, participant)
			console.log(`[voice] ${participant.mxid} is in the anchor's overflow mix`)
		}
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
		this.stats.matrixAudio++
		const participant = this.participants.get(identity)
		if (participant) participant.buffer.push(samples)
	}

	/**
	 * @param {string} identity
	 */
	onTrackEnd(identity) {
		const participant = this.participants.get(identity)
		console.log(`[voice] microphone track of ${identity} ended in ${this.channelID}${participant ? "" : " (not a bridged participant)"}`)
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
		try { participant.playback?.stop() } catch (e) {}
		participant.playback = null
		participant.clips.clear()
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
	 * A soundboard packet from a Matrix participant's LiveKit identity. Discord sounds are played natively when possible,
	 * and anything else is decoded and mixed in. Never throws.
	 * @param {string} identity
	 * @param {{url: string, shortcode: string}} sound
	 */
	onSoundboard(identity, sound) {
		try {
			if (!this.active) return
			const slot = this.reserveSoundSlot(identity, Date.now())
			if (slot) this.track(this.playMatrixSound(identity, sound, slot))
		} catch (e) {
			console.error(`[voice] failed to handle a soundboard sound in ${this.channelID}:`, e)
		}
	}

	/**
	 * Applies the per-sender limits. A sound less than 250 ms after the sender's previous one is dropped, and so is one
	 * that would be a fourth playing at once.
	 * @param {string} identity
	 * @param {number} now
	 * @returns {{endsAt: number} | null} a slot to record when the sound stops, or null to drop the sound
	 */
	reserveSoundSlot(identity, now) {
		let sender = this.soundSenders.get(identity)
		if (!sender) {
			sender = {lastAt: -Infinity, slots: []}
			this.soundSenders.set(identity, sender)
		}
		if (now - sender.lastAt < SOUND_MIN_GAP_MS) return null
		sender.slots = sender.slots.filter(slot => slot.endsAt > now)
		if (sender.slots.length >= SOUND_MAX_CONCURRENT) return null
		sender.lastAt = now
		const slot = {endsAt: Infinity}
		sender.slots.push(slot)
		return slot
	}

	/**
	 * @param {string} identity
	 * @param {{url: string, shortcode: string}} sound
	 * @param {{endsAt: number}} slot
	 */
	async playMatrixSound(identity, sound, slot) {
		/** @type {number} */
		let endsAt = 0
		try {
			endsAt = await this.startMatrixSound(identity, sound)
		} catch (e) {
			console.error(`[voice] could not play soundboard sound ${sound.url} in ${this.channelID}:`, e)
		} finally {
			slot.endsAt = endsAt
		}
	}

	/**
	 * @param {string} identity
	 * @param {{url: string, shortcode: string}} sound
	 * @returns {Promise<number>} when the sound is expected to stop (ms since the epoch), or 0 if nothing is playing
	 */
	async startMatrixSound(identity, sound) {
		const owner = this.participants.get(identity)
		const discordSoundID = discordSoundIDForMxc(sound.url)
		if (discordSoundID && this.anchor) {
			// Play it as the sender's own puppet if they have one that is in the channel, so that Discord shows it from them
			const bot = owner && owner.bot && !owner.joining ? owner.bot : this.anchor
			try {
				await bot.sendSoundboardSound(this.channelID, discordSoundID, guildIDForSound(discordSoundID))
				return Date.now() + NATIVE_SOUND_MS
			} catch (e) {
				console.error(`[voice] Discord would not play sound ${discordSoundID} in ${this.channelID}, so it is mixed in instead:`, e)
			}
		}

		const samples = await loadSoundPcm(sound.url)
		if (!samples || !this.active) return 0
		// Look the participant up again, since they may have left while the sound was downloading
		const current = this.participants.get(identity)
		const target = current && !current.ended ? current.clips : this.soundClips
		target.add(samples)
		return Date.now() + samples.length * 1000 / soundboard.SAMPLE_RATE
	}

	/**
	 * Mixes the overflow participants, and any loose sound clips, for the anchor's output.
	 * @returns {Buffer | null} one stereo frame, or null for silence when nothing is playing
	 */
	pullOverflow() {
		const frames = [...this.overflow.values()].map(participantFrame)
		const loose = this.soundClips.read(MONO_FRAME_SAMPLES)
		if (loose) frames.push(loose)
		if (frames.length === 0) {
			this.stats.anchor.silent++
			return null
		}
		const mixed = audio.mixMono(frames, MONO_FRAME_SAMPLES)
		this.countFrame("anchor", mixed)
		return audio.monoToStereo(mixed)
	}

	/**
	 * Counts one 20 ms mono frame emitted by an anchor or puppet stream. Never throws.
	 * @param {"anchor" | "puppet"} kind
	 * @param {Int16Array} mono
	 */
	countFrame(kind, mono) {
		try {
			const counts = this.stats[kind]
			if (isSilentSamples(mono)) counts.silent++
			else counts.nonSilent++
		} catch (e) {}
	}

	startStatsTimer() {
		this.stopStatsTimer()
		this.statsTimer = setInterval(() => this.logStats(), STATS_INTERVAL_MS)
		this.statsTimer.unref()
	}

	stopStatsTimer() {
		if (this.statsTimer) clearInterval(this.statsTimer)
		this.statsTimer = null
	}

	/**
	 * Logs one summary line for this channel and resets the counters. Never throws.
	 */
	logStats() {
		try {
			const stats = this.stats
			this.stats = newStats()
			let underrunReads = 0
			let droppedSamples = 0
			for (const participant of this.participants.values()) {
				const buffer = participant.buffer.stats()
				underrunReads += buffer.underrunReads
				droppedSamples += buffer.droppedSamples
				participant.buffer.reset()
			}
			const seconds = STATS_INTERVAL_MS / 1000
			console.log(`[voice] ${this.channelID} last ${seconds}s: matrixParticipants=${this.participants.size} matrixAudioFrames=${stats.matrixAudio} jitterUnderrunReads=${underrunReads} jitterDroppedSamples=${droppedSamples} anchor(nonSilent=${stats.anchor.nonSilent} silent=${stats.anchor.silent}) puppets(nonSilent=${stats.puppet.nonSilent} silent=${stats.puppet.silent}) discordFramesToPublishers=${stats.discordFrames}`)
		} catch (e) {}
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
 * Plays or mixes a soundboard sound that was played in a bridged Discord channel. Only Discord sounds we can give an mxc are sent.
 * @param {any} data a VOICE_CHANNEL_EFFECT_SEND payload
 */
async function handleDiscordSoundboard(data) {
	const where = `channel ${data.channel_id} in guild ${data.guild_id}`
	if (!data.sound_id) {
		console.log(`[soundboard] not bridged: the effect in ${where} has no sound_id (an emoji-only effect)`)
		return
	}
	const soundID = String(data.sound_id)
	// A sound our own bot played natively is reported back by Discord as an effect from that bot. Bridging it again would double it.
	const senderID = String(data.user_id)
	if (_deps.pool().allBotUserIDs().has(senderID)) {
		console.log(`[soundboard] not bridged: sent by our own bot ${senderID} (sound ${soundID} in ${where})`)
		return
	}
	const bridge = channelBridges.get(bridgeKey(data.guild_id, data.channel_id))
	if (!bridge) {
		console.log(`[soundboard] not bridged: sound ${soundID} was played in ${where}, which is not a bridged channel`)
		return
	}
	if (!bridge.active) {
		console.log(`[soundboard] not bridged: sound ${soundID} was played in ${where}, whose bridge is not active`)
		return
	}
	if (!bridge.listener) {
		console.log(`[soundboard] not bridged: sound ${soundID} was played in ${where}, which has no listener`)
		return
	}

	// Same shortcode as in the guild's synced sound pack (including the _2 suffixes for duplicate names)
	const guildSounds = _deps.discord().guilds.get(data.guild_id)?.soundboard_sounds ?? []
	const planned = require("../d2m/actions/expression").planSoundShortcodes(guildSounds).find(p => String(p.sound.sound_id) === soundID)
	const shortcode = planned ? planned.shortcode : soundboard.shortcodeForName("sound")
	const url = `https://cdn.discordapp.com/soundboard-sounds/${soundID}`
	/** @type {string} */
	let mxc
	try {
		mxc = await _deps.file().uploadDiscordFileToMxc(url)
	} catch (e) {
		console.error(`[soundboard] could not upload sound ${soundID} from Discord to Matrix, so it is not bridged:`, e)
		return
	}
	const bytes = soundboard.encodeSoundboardPacket({url: mxc, shortcode})

	// Zam attributes the sound to whoever sends it, so send it from the speaker's own publisher when they have one
	const entry = bridge.publishers.get(String(data.user_id))
	const sender = entry && entry.publisher.connected ? entry.publisher : bridge.listener
	const identity = entry && sender === entry.publisher ? entry.mxid : "the bridge bot"
	const sent = await sender.publishData(bytes, {topic: soundboard.SOUNDBOARD_TOPIC, reliable: true})
	if (sent === false) {
		console.error(`[soundboard] LiveKit did not send sound ${soundID} (${mxc}) from ${identity} in ${where}`)
		return
	}
	console.log(`[soundboard] sent sound ${soundID} as ${mxc} from ${identity} in ${where}`)
}

/**
 * Hook for VOICE_CHANNEL_EFFECT_SEND from the main bot. Only effects with a sound are bridged. Never throws.
 * @param {any} data the gateway payload: guild_id, channel_id, user_id, sound_id, sound_volume, emoji
 */
function onDiscordSoundboard(data) {
	try {
		console.log(`[soundboard] VOICE_CHANNEL_EFFECT_SEND from Discord: guild=${data?.guild_id} channel=${data?.channel_id} user=${data?.user_id} sound_id=${data?.sound_id ?? "none"} emoji=${data?.emoji?.name ?? "none"}`)
		if (!started) {
			console.log("[soundboard] not bridged: the voice bridge has not started")
			return
		}
		const work = handleDiscordSoundboard(data).catch(e => console.error("[soundboard] failed to bridge a soundboard sound from Discord:", e))
		pendingDiscordSounds.add(work)
		work.then(() => pendingDiscordSounds.delete(work))
	} catch (e) {
		console.error("[soundboard] failed to handle a soundboard sound from Discord:", e)
	}
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
	/** @type {Set<string>} guilds with at least one bridged voice or stage channel */
	const bridgedVoiceGuildIDs = new Set()
	for (const row of _deps.bridgedChannelRows()) {
		const channel = discord.channels.get(row.channel_id)
		if (!channel || !VOICE_CHANNEL_TYPES.has(channel.type)) continue
		bridgedVoiceGuildIDs.add(channel.guild_id)
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

	// Puppets that were already Ready are checked now. Puppets that become Ready later are checked by the hook, which is set
	// only after this check, so that no puppet is checked twice.
	voicePermissions.checkVoicePermissions({discord, pool, bridgedVoiceGuildIDs})
	pool.onPuppetReady = bot => voicePermissions.checkVoicePermissions({discord, pool, bridgedVoiceGuildIDs, puppet: bot})

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
	while (pendingDiscordSounds.size > 0) await Promise.all([...pendingDiscordSounds])
	await Promise.all([...channelBridges.values()].map(bridge => bridge.idle()))
}

module.exports = {
	start,
	stop,
	onDiscordVoiceState,
	onMatrixCallMemberEvent,
	onDiscordSoundboard,
	ChannelBridge,
	_channelBridges: channelBridges,
	_deps,
	_idle,
	_sweepMatrixMembers: sweepMatrixMembers,
	_resetSoundState() {
		soundCache.clear()
		ffmpegMissing = false
	},
}
