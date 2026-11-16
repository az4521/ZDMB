// @ts-check

const {test} = require("supertape")
const {EventEmitter} = require("events")
const bridge = require("./bridge")

const GUILD = "800"
const CHANNEL = "900"
const STAGE = "901"
const ROOM = "!call:cadence.moe"
const ROOM2 = "!stage:cadence.moe"
const BOT_MAIN = "100"
const BOT_PUPPET = "200"
const OURS_BOT = "@_ooye:cadence.moe"
const ALICE = "@alice:example.org"
const BOB = "@bob:example.org"
const SIM_MXID = "@_ooye_sim_speaker:cadence.moe"
const CALL = "org.matrix.msc3401.call.member"
const CHANNEL_KEY = `${GUILD}|${CHANNEL}`
const STAGE_KEY = `${GUILD}|${STAGE}`

/** @param {string} userID */
const simFor = userID => `@_ooye_sim_${userID}:cadence.moe`

/** A fake @discordjs/voice connection. Its receiver's speaking events are a plain EventEmitter. */
function fakeConnection() {
	const speaking = new EventEmitter()
	/** @type {{userID: string, options: any, stream: any}[]} */
	const subscriptions = []
	return {
		speaking,
		subscriptions,
		/** @type {any[]} */
		players: [],
		receiver: {
			speaking,
			subscribe(/** @type {string} */ userID, /** @type {any} */ options) {
				const stream = new EventEmitter()
				Object.assign(stream, {destroyed: false, destroy() { this.destroyed = true }})
				subscriptions.push({userID, options, stream})
				return stream
			},
		},
		subscribe(/** @type {any} */ player) {
			this.players.push(player)
		},
	}
}

/**
 * A fake bot. Joins succeed unless `failJoin` is set.
 * @param {string} userID
 * @param {boolean} isMain
 */
function fakeBot(userID, isMain) {
	return {
		userID,
		isMain,
		/** @type {{guildID: string, channelID: string, connection: any}[]} */
		joins: [],
		nicks: /** @type {(string | null)[]} */ ([]),
		failJoin: false,
		soundFailure: false,
		sounds: /** @type {{channelID: string, soundID: string, sourceGuildID: string | null}[]} */ ([]),
		async join(/** @type {string} */ guildID, /** @type {string} */ channelID) {
			if (this.failJoin) throw new Error("join failed")
			const connection = fakeConnection()
			this.joins.push({guildID, channelID, connection})
			return connection
		},
		async setNick(/** @type {string} */ _guildID, /** @type {string | null} */ nick) {
			this.nicks.push(nick)
		},
		leave() {},
		/**
		 * @param {string} channelID
		 * @param {string} soundID
		 * @param {string | null} [sourceGuildID]
		 */
		async sendSoundboardSound(channelID, soundID, sourceGuildID = null) {
			if (this.soundFailure) throw new Error("Missing Permissions")
			this.sounds.push({channelID, soundID, sourceGuildID})
		},
	}
}

/**
 * Builds the set of fakes used by every test.
 * @param {{voiceBridge?: boolean, puppets?: any[], callMembers?: any[], rooms?: Map<string, string>}} [options]
 */
function makeEnv({voiceBridge = true, puppets = [], callMembers = [], rooms = new Map([[CHANNEL, ROOM]])} = {}) {
	bridge._resetSoundState()
	const main = fakeBot(BOT_MAIN, true)
	const allocated = new Set()
	const pool = {
		main,
		puppets,
		initCalls: 0,
		/** @type {{bot: any, guildID: string, preferMain: boolean}[]} */
		acquired: [],
		/** @type {{bot: any, guildID: string}[]} */
		released: [],
		init() {
			this.initCalls++
			return Promise.resolve()
		},
		allBotUserIDs() {
			return new Set([main.userID, ...puppets.map(p => p.userID)])
		},
		/** @param {string} guildID @param {{preferMain?: boolean}} [opts] */
		acquire(guildID, {preferMain = false} = {}) {
			const candidates = preferMain ? [main, ...puppets] : [...puppets, main]
			for (const bot of candidates) {
				const key = `${guildID}|${bot.userID}`
				if (allocated.has(key)) continue
				allocated.add(key)
				this.acquired.push({bot, guildID, preferMain})
				return bot
			}
			return null
		},
		/** @param {any} bot @param {string} guildID */
		release(bot, guildID) {
			allocated.delete(`${guildID}|${bot.userID}`)
			this.released.push({bot, guildID})
			return Promise.resolve()
		},
	}

	/** @type {any[]} */
	const publishers = []
	class FakePublisher {
		/** @param {any} creds */
		constructor(creds) {
			this.creds = creds
			this.connected = false
			this.closed = false
			/** @type {any[]} */
			this.frames = []
			this.dataPackets = /** @type {{bytes: any, opts: any}[]} */ ([])
			publishers.push(this)
		}
		async connect() {
			this.connected = true
		}
		/** @param {any} samples */
		pushMono(samples) {
			this.frames.push(samples)
		}
		/** @param {any} bytes @param {any} opts */
		async publishData(bytes, opts) {
			this.dataPackets.push({bytes, opts})
			return true
		}
		async close() {
			this.closed = true
		}
	}
	/** @type {any[]} */
	const listeners = []
	class FakeListener extends EventEmitter {
		/** @param {any} options */
		constructor(options) {
			super()
			this.options = options
			this.dataPackets = /** @type {{bytes: any, opts: any}[]} */ ([])
			this.connected = false
			this.closed = false
			listeners.push(this)
		}
		async connect() {
			this.connected = true
		}
		async close() {
			this.closed = true
		}
		/** @param {any} bytes @param {any} opts */
		async publishData(bytes, opts) {
			this.dataPackets.push({bytes, opts})
			return true
		}
	}

	const memberships = {
		/** @type {string[][]} */
		joins: [],
		/** @type {string[][]} */
		leaves: [],
		all: false,
		async join(/** @type {string} */ roomID, /** @type {string} */ mxid) {
			this.joins.push([roomID, mxid])
		},
		async leave(/** @type {string} */ roomID, /** @type {string} */ mxid) {
			this.leaves.push([roomID, mxid])
		},
		async leaveAll() {
			this.all = true
		},
	}

	const voiceLib = {
		EndBehaviorType: {AfterSilence: "AfterSilence"},
		NoSubscriberBehavior: {Play: "Play"},
		StreamType: {Raw: "Raw"},
		/** @type {any[]} */
		players: [],
		createAudioPlayer() {
			const player = {
				/** @type {any} */
				resource: null,
				stopped: false,
				play(/** @type {any} */ resource) {
					player.resource = resource
				},
				stop() {
					player.stopped = true
				},
			}
			voiceLib.players.push(player)
			return player
		},
		createAudioResource(/** @type {any} */ stream, /** @type {any} */ options) {
			return {stream, options}
		},
	}

	const registerUser = {
		/** @type {string[]} */
		synced: [],
		/** @type {string[]} */
		ensured: [],
		async syncUser(/** @type {any} */ user) {
			this.synced.push(user.id)
			return simFor(user.id)
		},
		async ensureSimJoined(/** @type {any} */ user) {
			this.ensured.push(user.id)
			return simFor(user.id)
		},
	}

	const discord = {
		channels: new Map([
			[CHANNEL, {id: CHANNEL, type: 2, guild_id: GUILD}],
			[STAGE, {id: STAGE, type: 13, guild_id: GUILD}],
			["950", {id: "950", type: 0, guild_id: GUILD}],
		]),
		guilds: new Map([[GUILD, {
			id: GUILD,
			voice_states: [],
			soundboard_sounds: [{sound_id: "111", name: "Air Horn"}],
		}]]),
	}

	const rtc = {
		memberships,
		isCallMemberEventType: (/** @type {string} */ type) => type === CALL || type === "m.call.member",
		parseCallMembers: (/** @type {any[]} */ events) => events
			.filter(e => e.content && Object.keys(e.content).length > 0 && e.content.membership !== "leave")
			.map(e => ({mxid: e.sender, deviceID: e.content.device_id})),
		getLiveKitCredentials: async (/** @type {string} */ mxid) => ({url: "wss://lk.example", jwt: `jwt:${mxid}`}),
		getRoomCallMembers: async () => callMembers,
		clearStaleOwnMemberships: async () => 0,
	}

	const media = {
		/** @type {string[]} Discord URLs uploaded this test */
		uploads: /** @type {string[]} */ ([]),
		/** @type {string[]} mxc URLs downloaded this test */
		downloads: /** @type {string[]} */ ([]),
		/** @type {Map<string, string>} mxc URL to Discord URL, like the file table */
		rows: new Map(),
		decodes: 0,
		decodeSeconds: 1,
		declaredSize: 16,
		noFfmpeg: false,
	}
	const fileFake = {
		/** @param {string} url */
		async uploadDiscordFileToMxc(url) {
			const mxc = `mxc://cadence.moe/${url.split("/").pop()}`
			if (!media.rows.has(mxc)) {
				media.uploads.push(url)
				media.rows.set(mxc, url)
			}
			return mxc
		},
	}

	const deps = {
		reg: () => ({ooye: {voice_bridge: voiceBridge}}),
		pool: () => pool,
		voiceLib: () => voiceLib,
		matrixRTC: () => rtc,
		livekit: () => ({
			Publisher: FakePublisher,
			Listener: FakeListener,
			mxidFromIdentity: (/** @type {string} */ identity) => identity.slice(0, identity.lastIndexOf(":")),
		}),
		registerUser: () => registerUser,
		api: () => ({
			getStateEvent: async () => ({displayname: "Alice Example"}),
			/** @param {string} mxc */
			getMedia: async mxc => {
				media.downloads.push(mxc)
				return new Response(Buffer.alloc(16, 1), {status: 200, headers: {"content-length": String(media.declaredSize)}})
			},
		}),
		mxUtils: () => ({
			bot: OURS_BOT,
			eventSenderIsFromDiscord: (/** @type {string} */ sender) => sender.startsWith("@_ooye_"),
		}),
		discord: () => discord,
		createOpusDecoder: () => ({decode: () => Buffer.alloc(3840, 1)}),
		waitForGuilds: async () => {},
		roomIDForChannel: (/** @type {string} */ channelID) => rooms.get(channelID) ?? null,
		channelIDForRoom: (/** @type {string} */ roomID) => [...rooms].find(([, r]) => r === roomID)?.[0] ?? null,
		bridgedChannelRows: () => [...rooms].map(([channel_id, room_id]) => ({channel_id, room_id})),
		simMxid: () => null,
		file: () => fileFake,
		discordURLsForMxc: (/** @type {string} */ mxc) => media.rows.has(mxc) ? [/** @type {string} */ (media.rows.get(mxc))] : [],
		decodeToPcm: async () => {
			media.decodes++
			if (media.noFfmpeg) throw Object.assign(new Error("ffmpeg was not found"), {code: "FFMPEG_NOT_FOUND"})
			return new Int16Array(48000 * media.decodeSeconds).fill(500)
		},
	}

	/** Installs the fakes and returns a function that puts the real collaborators back. */
	const saved = {...bridge._deps}
	Object.assign(bridge._deps, deps)
	const restore = () => Object.assign(bridge._deps, saved)

	return {pool, main, publishers, listeners, memberships, registerUser, voiceLib, restore, media}
}

/**
 * @param {string} userID
 * @param {string | null} channelID
 * @param {string} [guildID]
 */
function voiceState(userID, channelID, guildID = GUILD) {
	return {
		guild_id: guildID,
		channel_id: channelID,
		user_id: userID,
		member: {user: {id: userID, username: `user${userID}`}, roles: []},
	}
}

/**
 * @param {string} sender
 * @param {any} content
 * @param {string} [roomID]
 */
function callEvent(sender, content, roomID = ROOM) {
	return {type: CALL, sender, room_id: roomID, state_key: `_${sender}_ZDMBVOICE_m.call`, content}
}

const JOIN_CONTENT = {device_id: "ZDMBVOICE", created_ts: 1_800_000_000_000, expires: 4 * 60 * 60 * 1000}

test("voice bridge: start does nothing when voice_bridge is off", async t => {
	const env = makeEnv({voiceBridge: false})
	try {
		await bridge.start()
		bridge.onDiscordVoiceState(voiceState("555", CHANNEL))
		bridge.onMatrixCallMemberEvent(callEvent(ALICE, JOIN_CONTENT))
		await bridge._idle()
		t.equal(env.pool.initCalls, 0)
		t.equal(bridge._channelBridges.size, 0)
		t.equal(env.pool.acquired.length, 0)
		t.equal(env.publishers.length, 0)
		t.end()
	} finally {
		await bridge.stop()
		env.restore()
	}
})

test("voice bridge: a Discord human joining activates the call", async t => {
	const env = makeEnv()
	try {
		await bridge.start()
		bridge.onDiscordVoiceState(voiceState("555", CHANNEL))
		await bridge._idle()

		t.equal(env.pool.acquired.length, 1)
		t.equal(env.pool.acquired[0].preferMain, true, "anchor is preferably the main bot")
		const anchor = env.main
		t.equal(anchor.joins.length, 1)
		t.equal(anchor.joins[0].guildID, GUILD)
		t.equal(anchor.joins[0].channelID, CHANNEL)

		t.equal(env.listeners.length, 1)
		t.ok(env.listeners[0].connected, "listener connected")
		t.equal(env.listeners[0].options.jwt, `jwt:${OURS_BOT}`, "listener uses the bridge bot's credentials")

		t.equal(env.registerUser.synced.length, 1, "full profile is synced")
		t.deepEqual(env.memberships.joins, [[ROOM, simFor("555")]])
		t.equal(env.publishers.length, 1)
		t.ok(env.publishers[0].connected, "publisher connected")
		t.equal(env.publishers[0].creds.jwt, `jwt:${simFor("555")}`)
		t.end()
	} finally {
		await bridge.stop()
		env.restore()
	}
})

test("voice bridge: bots in the pool are never humans", async t => {
	const env = makeEnv({puppets: [fakeBot(BOT_PUPPET, false)]})
	try {
		await bridge.start()
		bridge.onDiscordVoiceState(voiceState(BOT_MAIN, CHANNEL))
		bridge.onDiscordVoiceState(voiceState(BOT_PUPPET, CHANNEL))
		await bridge._idle()
		t.equal(env.pool.acquired.length, 0)
		t.equal(env.listeners.length, 0)
		t.equal(env.publishers.length, 0)
		t.end()
	} finally {
		await bridge.stop()
		env.restore()
	}
})

test("voice bridge: a Matrix human joining activates the call, and leaving deactivates it", async t => {
	const env = makeEnv()
	try {
		await bridge.start()
		bridge.onMatrixCallMemberEvent(callEvent(ALICE, JOIN_CONTENT))
		await bridge._idle()
		t.equal(env.pool.acquired.length, 1)
		t.equal(env.listeners.length, 1)
		t.ok(env.listeners[0].connected)
		t.equal(env.publishers.length, 0, "no Discord humans, so no publishers")

		bridge.onMatrixCallMemberEvent(callEvent(ALICE, {}))
		await bridge._idle()
		t.ok(env.listeners[0].closed, "listener closed")
		t.equal(env.pool.released.length, 1)
		t.equal(env.pool.released[0].bot, env.main, "anchor released")
		t.end()
	} finally {
		await bridge.stop()
		env.restore()
	}
})

test("voice bridge: Matrix tracks get a dedicated puppet when one is free, otherwise the overflow mix", async t => {
	const puppet = fakeBot(BOT_PUPPET, false)
	const env = makeEnv({puppets: [puppet]})
	try {
		await bridge.start()
		bridge.onMatrixCallMemberEvent(callEvent(ALICE, JOIN_CONTENT))
		bridge.onMatrixCallMemberEvent(callEvent(BOB, JOIN_CONTENT))
		await bridge._idle()

		const listener = env.listeners[0]
		listener.emit("trackStart", `${ALICE}:ZDMBVOICE`, ALICE)
		listener.emit("trackStart", `${BOB}:ZDMBVOICE`, BOB)
		await bridge._idle()

		t.equal(puppet.joins.length, 1, "first track takes the free puppet")
		t.equal(puppet.joins[0].channelID, CHANNEL)
		t.deepEqual(puppet.nicks, ["Alice Example"], "puppet is named after the Matrix display name")
		t.equal(env.voiceLib.players.length, 2, "anchor player and puppet player")

		const cb = bridge._channelBridges.get(CHANNEL_KEY)
		t.equal(cb.overflow.size, 1, "second track is mixed into the anchor")
		t.ok(cb.overflow.has(`${BOB}:ZDMBVOICE`))

		// Prime Bob's jitter buffer (40 ms = 1920 samples) with 1000s, then pull the overflow mix
		listener.emit("audio", `${BOB}:ZDMBVOICE`, new Int16Array(960).fill(1000))
		listener.emit("audio", `${BOB}:ZDMBVOICE`, new Int16Array(960).fill(1000))
		listener.emit("audio", `${BOB}:ZDMBVOICE`, new Int16Array(960).fill(1000))
		const frame = cb.pullOverflow()
		t.ok(frame, "overflow produces a frame")
		t.equal(frame.length, 3840)
		t.equal(frame.readInt16LE(0), 1000)

		// Alice leaves: her puppet is given back
		listener.emit("trackEnd", `${ALICE}:ZDMBVOICE`)
		await bridge._idle()
		t.equal(env.pool.released.length, 1, "only the puppet is released; the anchor is still held")
		t.equal(env.pool.released[0].bot, puppet, "puppet released when its track ended")
		t.end()
	} finally {
		await bridge.stop()
		env.restore()
	}
})

test("voice bridge: a Discord human leaving closes their publisher and membership, and the call stays up for others", async t => {
	const env = makeEnv()
	try {
		await bridge.start()
		bridge.onDiscordVoiceState(voiceState("555", CHANNEL))
		bridge.onDiscordVoiceState(voiceState("556", CHANNEL))
		await bridge._idle()
		t.equal(env.publishers.length, 2)

		bridge.onDiscordVoiceState(voiceState("555", null))
		await bridge._idle()
		t.ok(env.publishers[0].closed, "leaver's publisher closed")
		t.notOk(env.publishers[1].closed)
		t.deepEqual(env.memberships.leaves, [[ROOM, simFor("555")]])
		t.notOk(env.listeners[0].closed, "listener still up")
		t.equal(env.pool.released.length, 0, "anchor still held")
		t.end()
	} finally {
		await bridge.stop()
		env.restore()
	}
})

test("voice bridge: everyone leaving deactivates and releases the bots", async t => {
	const puppet = fakeBot(BOT_PUPPET, false)
	const env = makeEnv({puppets: [puppet]})
	try {
		await bridge.start()
		bridge.onDiscordVoiceState(voiceState("555", CHANNEL))
		bridge.onMatrixCallMemberEvent(callEvent(ALICE, JOIN_CONTENT))
		await bridge._idle()
		env.listeners[0].emit("trackStart", `${ALICE}:ZDMBVOICE`, ALICE)
		await bridge._idle()
		t.equal(puppet.joins.length, 1)

		bridge.onDiscordVoiceState(voiceState("555", null))
		bridge.onMatrixCallMemberEvent(callEvent(ALICE, {}))
		await bridge._idle()

		const cb = bridge._channelBridges.get(CHANNEL_KEY)
		t.notOk(cb.active, "channel is inactive")
		t.ok(env.listeners[0].closed)
		t.ok(env.publishers[0].closed)
		t.deepEqual(env.memberships.leaves, [[ROOM, simFor("555")]])
		const releasedBots = env.pool.released.map(r => r.bot)
		t.ok(releasedBots.includes(env.main), "anchor released")
		t.ok(releasedBots.includes(puppet), "puppet released")
		t.equal(cb.overflow.size, 0)
		t.end()
	} finally {
		await bridge.stop()
		env.restore()
	}
})

test("voice bridge: Matrix events from the bridge bot and sims are ignored", async t => {
	const env = makeEnv()
	try {
		await bridge.start()
		bridge.onMatrixCallMemberEvent(callEvent(OURS_BOT, JOIN_CONTENT))
		bridge.onMatrixCallMemberEvent(callEvent(SIM_MXID, JOIN_CONTENT))
		await bridge._idle()
		t.equal(env.pool.acquired.length, 0)
		t.equal(env.listeners.length, 0)
		t.end()
	} finally {
		await bridge.stop()
		env.restore()
	}
})

test("voice bridge: overlapping events activate a channel only once", async t => {
	const env = makeEnv()
	try {
		await bridge.start()
		bridge.onDiscordVoiceState(voiceState("555", CHANNEL))
		bridge.onDiscordVoiceState(voiceState("556", CHANNEL))
		bridge.onMatrixCallMemberEvent(callEvent(ALICE, JOIN_CONTENT))
		bridge.onDiscordVoiceState(voiceState("557", CHANNEL))
		await bridge._idle()

		t.equal(env.pool.acquired.length, 1, "one anchor")
		t.equal(env.main.joins.length, 1, "one join")
		t.equal(env.listeners.length, 1, "one listener")
		t.equal(env.publishers.length, 3, "one publisher per Discord human")
		t.equal(env.registerUser.synced.length + env.registerUser.ensured.length, 3)
		t.end()
	} finally {
		await bridge.stop()
		env.restore()
	}
})

test("voice bridge: moving between bridged channels leaves one and joins the other", async t => {
	const env = makeEnv({rooms: new Map([[CHANNEL, ROOM], [STAGE, ROOM2]])})
	try {
		await bridge.start()
		bridge.onDiscordVoiceState(voiceState("555", CHANNEL))
		await bridge._idle()
		bridge.onDiscordVoiceState(voiceState("555", STAGE))
		await bridge._idle()

		t.notOk(bridge._channelBridges.get(CHANNEL_KEY).active, "old channel inactive")
		t.ok(bridge._channelBridges.get(STAGE_KEY).active, "new channel active")
		t.deepEqual(env.memberships.leaves, [[ROOM, simFor("555")]])
		t.deepEqual(env.memberships.joins, [[ROOM, simFor("555")], [ROOM2, simFor("555")]])
		t.end()
	} finally {
		await bridge.stop()
		env.restore()
	}
})

test("voice bridge: a voice state in an unbridged channel is ignored", async t => {
	const env = makeEnv()
	try {
		await bridge.start()
		bridge.onDiscordVoiceState(voiceState("555", "950"))
		await bridge._idle()
		t.equal(env.pool.acquired.length, 0)
		t.equal(bridge._channelBridges.size, 1, "only the bridged channel has a bridge")
		t.end()
	} finally {
		await bridge.stop()
		env.restore()
	}
})

test("voice bridge: speech from a Discord human is decoded and pushed to their publisher", async t => {
	const env = makeEnv()
	try {
		await bridge.start()
		bridge.onDiscordVoiceState(voiceState("555", CHANNEL))
		await bridge._idle()

		const connection = env.main.joins[0].connection
		connection.speaking.emit("start", "555")
		t.equal(connection.subscriptions.length, 1)
		t.equal(connection.subscriptions[0].userID, "555")
		t.equal(connection.subscriptions[0].options.end.duration, 300)

		connection.subscriptions[0].stream.emit("data", Buffer.alloc(40))
		t.equal(env.publishers[0].frames.length, 1)
		t.equal(env.publishers[0].frames[0].length, 960, "one 20 ms mono frame")

		// Already subscribed: a second start does not subscribe again
		connection.speaking.emit("start", "555")
		t.equal(connection.subscriptions.length, 1)

		// Bots are never subscribed to
		connection.speaking.emit("start", BOT_MAIN)
		t.equal(connection.subscriptions.length, 1)
		t.end()
	} finally {
		await bridge.stop()
		env.restore()
	}
})

test("voice bridge: seeding at start picks up existing call members", async t => {
	const env = makeEnv({callMembers: [{mxid: ALICE, deviceID: "D"}, {mxid: OURS_BOT, deviceID: "D"}]})
	try {
		await bridge.start()
		await bridge._idle()
		t.equal(env.listeners.length, 1, "Alice in the call activates it")
		t.equal(env.pool.acquired.length, 1)
		t.end()
	} finally {
		await bridge.stop()
		env.restore()
	}
})

test("voice bridge: stop tears everything down and ignores later events", async t => {
	const env = makeEnv()
	try {
		await bridge.start()
		bridge.onDiscordVoiceState(voiceState("555", CHANNEL))
		await bridge._idle()
		await bridge.stop()

		t.ok(env.listeners[0].closed)
		t.ok(env.publishers[0].closed)
		t.ok(env.main && env.pool.released.some(r => r.bot === env.main), "anchor released")
		t.ok(env.memberships.all, "leaveAll called")

		bridge.onDiscordVoiceState(voiceState("556", CHANNEL))
		await bridge._idle()
		t.equal(env.pool.acquired.length, 1, "no activation after stop")
		t.end()
	} finally {
		env.restore()
	}
})

const DISCORD_USER = "555"
const MXC_AIRHORN = "mxc://cadence.moe/111"
const DISCORD_AIRHORN = "https://cdn.discordapp.com/soundboard-sounds/111"
const MXC_OTHER = "mxc://cadence.moe/otherfile"

/**
 * Runs fn with console.error collected rather than printed. Returns what was logged.
 * @param {() => Promise<void>} fn
 * @returns {Promise<any[][]>}
 */
async function quietErrors(fn) {
	/** @type {any[][]} */
	const logged = []
	const saved = console.error
	console.error = (...args) => { logged.push(args) }
	try {
		await fn()
	} finally {
		console.error = saved
	}
	return logged
}

/**
 * Puts one Matrix human in the call with their track started. Returns the Listener that carries their audio.
 * @param {any} env
 * @param {string} mxid
 */
async function startMatrixSpeaker(env, mxid) {
	bridge.onMatrixCallMemberEvent(callEvent(mxid, JOIN_CONTENT))
	await bridge._idle()
	const listener = env.listeners[0]
	listener.emit("trackStart", `${mxid}:ZDMBVOICE`, mxid)
	await bridge._idle()
	return listener
}

test("voice bridge: a Discord soundboard sound is uploaded once and sent as a packet from the speaker's publisher", async t => {
	const env = makeEnv()
	try {
		await bridge.start()
		bridge.onDiscordVoiceState(voiceState(DISCORD_USER, CHANNEL))
		await bridge._idle()
		const effect = {guild_id: GUILD, channel_id: CHANNEL, user_id: DISCORD_USER, sound_id: "111", sound_volume: 1}
		bridge.onDiscordSoundboard(effect)
		bridge.onDiscordSoundboard(effect)
		await bridge._idle()

		t.deepEqual(env.media.uploads, [DISCORD_AIRHORN], "the sound is uploaded once")
		const publisher = env.publishers[0]
		t.equal(publisher.dataPackets.length, 2)
		t.deepEqual(publisher.dataPackets[0].opts, {topic: "moe.crafty.soundboard", reliable: true})
		t.equal(Buffer.from(publisher.dataPackets[0].bytes).toString(), `{"url":"${MXC_AIRHORN}","shortcode":"Air_Horn","v":1,"name":"Air_Horn"}`)
		t.equal(env.listeners[0].dataPackets.length, 0, "the bridge bot sends nothing")
	} finally {
		await bridge.stop()
		env.restore()
	}
})

test("voice bridge: a Discord soundboard sound from someone without a publisher is sent from the bridge bot", async t => {
	const env = makeEnv()
	try {
		await bridge.start()
		bridge.onDiscordVoiceState(voiceState(DISCORD_USER, CHANNEL))
		await bridge._idle()
		bridge.onDiscordSoundboard({guild_id: GUILD, channel_id: CHANNEL, user_id: "777", sound_id: "111"})
		await bridge._idle()
		t.equal(env.listeners[0].dataPackets.length, 1)
		t.equal(Buffer.from(env.listeners[0].dataPackets[0].bytes).toString(), `{"url":"${MXC_AIRHORN}","shortcode":"Air_Horn","v":1,"name":"Air_Horn"}`)
	} finally {
		await bridge.stop()
		env.restore()
	}
})

test("voice bridge: Discord effects without a sound, and sounds in channels that are not active, are ignored", async t => {
	const env = makeEnv()
	try {
		await bridge.start()
		bridge.onDiscordSoundboard({guild_id: GUILD, channel_id: CHANNEL, user_id: DISCORD_USER, sound_id: "111"})
		await bridge._idle()
		t.equal(env.media.uploads.length, 0, "a channel with nobody in it is not active")

		bridge.onDiscordVoiceState(voiceState(DISCORD_USER, CHANNEL))
		await bridge._idle()
		bridge.onDiscordSoundboard({guild_id: GUILD, channel_id: CHANNEL, user_id: DISCORD_USER, emoji: {name: "wave"}})
		bridge.onDiscordSoundboard({guild_id: GUILD, channel_id: "950", user_id: DISCORD_USER, sound_id: "111"})
		await bridge._idle()
		t.equal(env.media.uploads.length, 0, "emoji-only effects and text channels are ignored")
		t.equal(env.listeners[0].dataPackets.length, 0)
	} finally {
		await bridge.stop()
		env.restore()
	}
})

test("voice bridge: a Matrix soundboard for a Discord sound is played natively by the speaker's puppet", async t => {
	const puppet = fakeBot(BOT_PUPPET, false)
	const env = makeEnv({puppets: [puppet]})
	try {
		await bridge.start()
		const listener = await startMatrixSpeaker(env, ALICE)
		env.media.rows.set(MXC_AIRHORN, DISCORD_AIRHORN)
		listener.emit("soundboard", `${ALICE}:ZDMBVOICE`, {url: MXC_AIRHORN, shortcode: "airhorn", name: "airhorn"})
		await bridge._idle()

		t.deepEqual(puppet.sounds, [{channelID: CHANNEL, soundID: "111", sourceGuildID: GUILD}])
		t.equal(env.main.sounds.length, 0, "the anchor does not play it")
		t.equal(env.media.downloads.length, 0, "nothing is downloaded when it is played natively")
	} finally {
		await bridge.stop()
		env.restore()
	}
})

test("voice bridge: a Matrix soundboard for a Discord sound goes through the anchor when the speaker has no puppet", async t => {
	const env = makeEnv()
	try {
		await bridge.start()
		const listener = await startMatrixSpeaker(env, ALICE)
		env.media.rows.set(MXC_AIRHORN, DISCORD_AIRHORN)
		listener.emit("soundboard", `${ALICE}:ZDMBVOICE`, {url: MXC_AIRHORN, shortcode: "airhorn", name: "airhorn"})
		await bridge._idle()
		t.deepEqual(env.main.sounds, [{channelID: CHANNEL, soundID: "111", sourceGuildID: GUILD}])
	} finally {
		await bridge.stop()
		env.restore()
	}
})

test("voice bridge: when Discord refuses a native sound, it is downloaded and mixed into the speaker's puppet", async t => {
	const puppet = fakeBot(BOT_PUPPET, false)
	puppet.soundFailure = true
	const env = makeEnv({puppets: [puppet]})
	try {
		await bridge.start()
		const listener = await startMatrixSpeaker(env, ALICE)
		env.media.rows.set(MXC_AIRHORN, DISCORD_AIRHORN)
		const logged = await quietErrors(async () => {
			listener.emit("soundboard", `${ALICE}:ZDMBVOICE`, {url: MXC_AIRHORN, shortcode: "airhorn", name: "airhorn"})
			await bridge._idle()
		})
		t.equal(logged.length, 1, "the refusal is logged")
		t.equal(puppet.sounds.length, 0)
		t.deepEqual(env.media.downloads, [MXC_AIRHORN])
		t.equal(env.media.decodes, 1)
		const cb = bridge._channelBridges.get(CHANNEL_KEY)
		t.equal(cb.participants.get(`${ALICE}:ZDMBVOICE`).clips.active, true, "the sound plays on the puppet's stream")
	} finally {
		await bridge.stop()
		env.restore()
	}
})

test("voice bridge: a Matrix sound that is not from Discord is downloaded, decoded and mixed into a silent speaker's output", async t => {
	const env = makeEnv()
	try {
		await bridge.start()
		const listener = await startMatrixSpeaker(env, ALICE) // Alice has no puppet, so she is in the overflow mix and silent
		listener.emit("soundboard", `${BOB}:ZDMBVOICE`, {url: MXC_OTHER, shortcode: "wow", name: "wow"})
		await bridge._idle()

		t.deepEqual(env.media.downloads, [MXC_OTHER])
		t.equal(env.media.decodes, 1)
		const cb = bridge._channelBridges.get(CHANNEL_KEY)
		const frame = cb.pullOverflow()
		t.ok(frame)
		t.equal(frame.length, 3840, "one stereo 20 ms frame")
		t.equal(frame.readInt16LE(0), 500, "the sound is in the output even though nobody spoke")
	} finally {
		await bridge.stop()
		env.restore()
	}
})

test("voice bridge: a Matrix sound from a sender with no track is mixed into the anchor's output", async t => {
	const env = makeEnv()
	try {
		await bridge.start()
		const listener = await startMatrixSpeaker(env, ALICE)
		await bridge._idle()
		listener.emit("soundboard", `${BOB}:ZDMBVOICE`, {url: MXC_OTHER, shortcode: "wow", name: "wow"})
		await bridge._idle()
		const cb = bridge._channelBridges.get(CHANNEL_KEY)
		t.equal(cb.soundClips.active, true)
		t.equal(cb.pullOverflow().readInt16LE(0), 500)
	} finally {
		await bridge.stop()
		env.restore()
	}
})

test("voice bridge: a downloaded sound is cached, so the same mxc is not downloaded again", async t => {
	const env = makeEnv()
	try {
		await bridge.start()
		const listener = await startMatrixSpeaker(env, ALICE)
		listener.emit("soundboard", `${ALICE}:ZDMBVOICE`, {url: MXC_OTHER, shortcode: "wow", name: "wow"})
		await bridge._idle()
		listener.emit("soundboard", `${BOB}:ZDMBVOICE`, {url: MXC_OTHER, shortcode: "wow", name: "wow"})
		await bridge._idle()
		t.deepEqual(env.media.downloads, [MXC_OTHER])
		t.equal(env.media.decodes, 1)
	} finally {
		await bridge.stop()
		env.restore()
	}
})

test("voice bridge: a sender's sounds closer than 250 ms apart are dropped, and other senders are not affected", async t => {
	const env = makeEnv()
	const realNow = Date.now
	let now = 1_800_000_000_000
	Date.now = () => now
	try {
		await bridge.start()
		const listener = await startMatrixSpeaker(env, ALICE)
		const bobIdentity = `${BOB}:ZDMBVOICE`
		listener.emit("soundboard", bobIdentity, {url: "mxc://cadence.moe/a", shortcode: "a", name: "a"})
		await bridge._idle()
		now += 100
		listener.emit("soundboard", bobIdentity, {url: "mxc://cadence.moe/b", shortcode: "b", name: "b"})
		await bridge._idle()
		now += 200 // 300 ms after the first
		listener.emit("soundboard", bobIdentity, {url: "mxc://cadence.moe/c", shortcode: "c", name: "c"})
		await bridge._idle()
		listener.emit("soundboard", `${ALICE}:ZDMBVOICE`, {url: "mxc://cadence.moe/d", shortcode: "d", name: "d"})
		await bridge._idle()
		t.deepEqual(env.media.downloads, ["mxc://cadence.moe/a", "mxc://cadence.moe/c", "mxc://cadence.moe/d"])
	} finally {
		Date.now = realNow
		await bridge.stop()
		env.restore()
	}
})

test("voice bridge: at most three sounds from one sender play at once", async t => {
	const env = makeEnv()
	env.media.decodeSeconds = 5
	const realNow = Date.now
	let now = 1_800_000_000_000
	Date.now = () => now
	try {
		await bridge.start()
		const listener = await startMatrixSpeaker(env, ALICE)
		const identity = `${BOB}:ZDMBVOICE`
		for (let i = 0; i < 4; i++) {
			listener.emit("soundboard", identity, {url: `mxc://cadence.moe/s${i}`, shortcode: "s", name: "s"})
			await bridge._idle()
			now += 300
		}
		t.deepEqual(env.media.downloads, ["mxc://cadence.moe/s0", "mxc://cadence.moe/s1", "mxc://cadence.moe/s2"], "the fourth is dropped")

		now += 5000 // the first three have finished by now
		listener.emit("soundboard", identity, {url: "mxc://cadence.moe/s4", shortcode: "s", name: "s"})
		await bridge._idle()
		t.equal(env.media.downloads.length, 4, "a slot is free again")
	} finally {
		Date.now = realNow
		await bridge.stop()
		env.restore()
	}
})

test("voice bridge: soundboard packets are ignored once the speaker has left and the channel is down", async t => {
	const env = makeEnv()
	try {
		await bridge.start()
		const listener = await startMatrixSpeaker(env, ALICE)
		bridge.onMatrixCallMemberEvent(callEvent(ALICE, {}))
		await bridge._idle()
		listener.emit("soundboard", `${BOB}:ZDMBVOICE`, {url: MXC_OTHER, shortcode: "wow", name: "wow"})
		await bridge._idle()
		t.equal(env.media.downloads.length, 0)
	} finally {
		await bridge.stop()
		env.restore()
	}
})

test("voice bridge: without ffmpeg the problem is logged once and later Matrix sounds are skipped", async t => {
	const env = makeEnv()
	env.media.noFfmpeg = true
	try {
		await bridge.start()
		const listener = await startMatrixSpeaker(env, ALICE)
		const logged = await quietErrors(async () => {
			listener.emit("soundboard", `${ALICE}:ZDMBVOICE`, {url: MXC_OTHER, shortcode: "wow", name: "wow"})
			await bridge._idle()
			listener.emit("soundboard", `${BOB}:ZDMBVOICE`, {url: "mxc://cadence.moe/second", shortcode: "x", name: "x"})
			await bridge._idle()
		})
		t.equal(logged.filter(args => String(args[0]).includes("ffmpeg")).length, 1, "logged once")
		t.equal(env.media.downloads.length, 1, "the second sound is skipped before downloading")
		t.equal(env.media.decodes, 1)
	} finally {
		await bridge.stop()
		env.restore()
	}
})

test("voice bridge: a Matrix sound over 1 MiB is refused without being decoded", async t => {
	const env = makeEnv()
	env.media.declaredSize = 2 * 1024 * 1024
	try {
		await bridge.start()
		const listener = await startMatrixSpeaker(env, ALICE)
		const logged = await quietErrors(async () => {
			listener.emit("soundboard", `${BOB}:ZDMBVOICE`, {url: MXC_OTHER, shortcode: "wow", name: "wow"})
			await bridge._idle()
		})
		t.equal(logged.length, 1)
		t.equal(env.media.downloads.length, 1)
		t.equal(env.media.decodes, 0)
		const cb = bridge._channelBridges.get(CHANNEL_KEY)
		t.equal(cb.soundClips.active, false)
	} finally {
		await bridge.stop()
		env.restore()
	}
})
