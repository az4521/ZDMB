// @ts-check

const {test} = require("supertape")
const {VoiceBot, BotPool} = require("./discord-bots")

/** A fake cloudstorm client that records calls. */
function fakeCloud() {
	/** @type {any[]} */
	const sent = []
	return {
		sent,
		on() {},
		voiceStateUpdate(/** @type {number} */ shard, /** @type {any} */ data) {
			sent.push({shard, data})
			return Promise.resolve()
		},
	}
}

/** A fake snowtransfer client that records nickname changes. */
function fakeSnow(/** @type {{fail?: boolean}} */ options = {}) {
	/** @type {any[]} */
	const edits = []
	return {
		edits,
		guild: {
			editSelf(/** @type {string} */ guildID, /** @type {any} */ data) {
				edits.push({guildID, data})
				if (options.fail) return Promise.reject(new Error("Missing Permissions"))
				return Promise.resolve({})
			},
		},
	}
}

/** A fake @discordjs/voice module. */
function fakeVoiceLib() {
	/** @type {any[]} */
	const joins = []
	/** @type {Map<string, any>} */
	const connections = new Map()
	const lib = {
		joins,
		connections,
		VoiceConnectionStatus: {Ready: "ready"},
		joinVoiceChannel(/** @type {any} */ options) {
			joins.push(options)
			const connection = {
				options,
				destroyed: false,
				destroy() {
					this.destroyed = true
					connections.delete(`${options.guildId}/${options.group}`)
					// Mirror the real library: the implementer adapter is told to destroy.
					// Our fake adapter is captured on creation, so this is a no-op for tests.
				},
			}
			connections.set(`${options.guildId}/${options.group}`, connection)
			options.adapterCreator({
				destroy() {},
				onVoiceServerUpdate() {},
				onVoiceStateUpdate() {},
			})
			return connection
		},
		entersState() {
			return Promise.resolve()
		},
		getVoiceConnection(/** @type {string} */ guildID, /** @type {string} */ group) {
			return connections.get(`${guildID}/${group}`)
		},
	}
	return lib
}

/**
 * Build a pool with a fake main bot (user 100, in guilds A and B) and no real puppet connections.
 * @param {ReturnType<typeof fakeVoiceLib>} voice
 */
function makePool(voice) {
	const mainCloud = fakeCloud()
	const mainSnow = fakeSnow()
	const discord = {
		user: {id: "100"},
		cloud: mainCloud,
		snow: mainSnow,
		guilds: new Map([["A", {}], ["B", {}]]),
	}
	const pool = new BotPool({
		getMain: () => discord,
		getTokens: () => [],
		createPuppetClient: () => { throw new Error("no puppets in tests") },
		voiceLib: () => voice,
	})
	pool.main = new VoiceBot({userID: "100", isMain: true, cloud: mainCloud, snow: mainSnow, voiceLib: () => voice})
	return {pool, discord, mainCloud, mainSnow}
}

/**
 * Make a Ready puppet that is in the given guilds.
 * @param {BotPool} pool
 * @param {string} userID
 * @param {string[]} guildIDs
 * @param {ReturnType<typeof fakeVoiceLib>} voice
 */
function addPuppet(pool, userID, guildIDs, voice) {
	const cloud = fakeCloud()
	const snow = fakeSnow()
	const bot = new VoiceBot({userID, isMain: false, cloud, snow, voiceLib: () => voice})
	bot.guildIDs = new Set(guildIDs)
	pool.registerPuppet(bot)
	return {bot, cloud, snow}
}

test("voicebot pool: onPuppetReady runs once per puppet", t => {
	const pool = new BotPool()
	/** @type {VoiceBot[]} */
	const seen = []
	pool.onPuppetReady = bot => seen.push(bot)
	const bot = new VoiceBot({userID: "200", isMain: false, cloud: fakeCloud(), snow: fakeSnow()})
	pool.registerPuppet(bot)
	pool.registerPuppet(bot)
	t.deepEqual(seen, [bot])
	t.equal(pool.puppets.length, 1)
})

test("voicebot adapter: forwards only own voice state and matching guild server update", t => {
	const voice = fakeVoiceLib()
	const bot = new VoiceBot({userID: "200", isMain: false, cloud: fakeCloud(), snow: fakeSnow(), voiceLib: () => voice})
	/** @type {any[]} */
	const stateSeen = []
	/** @type {any[]} */
	const serverSeen = []
	const adapterCreator = bot.adapterCreator("A")
	adapterCreator({
		destroy() {},
		onVoiceStateUpdate: d => stateSeen.push(d),
		onVoiceServerUpdate: d => serverSeen.push(d),
	})

	bot.handleGatewayMessage({t: "VOICE_STATE_UPDATE", d: {user_id: "200", guild_id: "A", channel_id: "c1"}})
	bot.handleGatewayMessage({t: "VOICE_STATE_UPDATE", d: {user_id: "999", guild_id: "A", channel_id: "c1"}})
	bot.handleGatewayMessage({t: "VOICE_STATE_UPDATE", d: {user_id: "200", guild_id: "B", channel_id: "c2"}})
	bot.handleGatewayMessage({t: "VOICE_SERVER_UPDATE", d: {guild_id: "A", endpoint: "e1", token: "t1"}})
	bot.handleGatewayMessage({t: "VOICE_SERVER_UPDATE", d: {guild_id: "B", endpoint: "e2", token: "t2"}})

	t.deepEqual(stateSeen, [{user_id: "200", guild_id: "A", channel_id: "c1"}])
	t.deepEqual(serverSeen, [{guild_id: "A", endpoint: "e1", token: "t1"}])
})

test("voicebot adapter: forwarding ignores bots without a user ID", t => {
	const voice = fakeVoiceLib()
	const bot = new VoiceBot({userID: null, isMain: false, cloud: fakeCloud(), snow: fakeSnow(), voiceLib: () => voice})
	/** @type {any[]} */
	const seen = []
	bot.adapterCreator("A")({destroy() {}, onVoiceStateUpdate: d => seen.push(d), onVoiceServerUpdate() {}})
	bot.handleGatewayMessage({t: "VOICE_STATE_UPDATE", d: {user_id: "200", guild_id: "A"}})
	t.equal(seen.length, 0)
})

test("voicebot adapter: sendPayload sends op 4 data through voiceStateUpdate", t => {
	const voice = fakeVoiceLib()
	const cloud = fakeCloud()
	const bot = new VoiceBot({userID: "200", isMain: false, cloud, snow: fakeSnow(), voiceLib: () => voice})
	const adapter = bot.adapterCreator("A")({destroy() {}, onVoiceStateUpdate() {}, onVoiceServerUpdate() {}})
	const d = {guild_id: "A", channel_id: "c1", self_deaf: false, self_mute: false}
	const ok = adapter.sendPayload({op: 4, d})
	t.equal(ok, true)
	t.equal(cloud.sent.length, 1)
	t.equal(cloud.sent[0].shard, 0)
	t.deepEqual(cloud.sent[0].data, d)
})

test("voicebot adapter: gateway disconnect destroys adapters", t => {
	const voice = fakeVoiceLib()
	const bot = new VoiceBot({userID: "200", isMain: false, cloud: fakeCloud(), snow: fakeSnow(), voiceLib: () => voice})
	let destroyed = 0
	bot.adapterCreator("A")({destroy() { destroyed++ }, onVoiceStateUpdate() {}, onVoiceServerUpdate() {}})
	bot.handleDisconnect()
	t.equal(destroyed, 1)
	bot.handleVoiceServerUpdate({guild_id: "A", endpoint: "x", token: "y"})
	t.equal(destroyed, 1)
})

test("voicebot join: uses per-bot group, selfDeaf false, and the guild's adapter", async t => {
	const voice = fakeVoiceLib()
	const bot = new VoiceBot({userID: "200", isMain: false, cloud: fakeCloud(), snow: fakeSnow(), voiceLib: () => voice})
	const connection = await bot.join("A", "c1")
	t.equal(voice.joins.length, 1)
	const opts = voice.joins[0]
	t.equal(opts.channelId, "c1")
	t.equal(opts.guildId, "A")
	t.equal(opts.group, "200")
	t.equal(opts.selfDeaf, false)
	t.equal(opts.selfMute, false)
	t.equal(bot.connection("A"), connection)
})

test("voicebot setNick: sends editSelf and swallows permission errors", async t => {
	const voice = fakeVoiceLib()
	const snow = fakeSnow({fail: true})
	const bot = new VoiceBot({userID: "200", isMain: false, cloud: fakeCloud(), snow, voiceLib: () => voice})
	await bot.setNick("A", "Alice")
	t.deepEqual(snow.edits, [{guildID: "A", data: {nick: "Alice"}}])
})

test("botpool acquire: bot must be in the guild", t => {
	const voice = fakeVoiceLib()
	const {pool} = makePool(voice)
	addPuppet(pool, "201", ["B"], voice)
	pool.main.guildIDs = new Set() // will be re-synced from discord.guilds
	const bot = pool.acquire("A", {})
	t.equal(bot?.userID, "100", "main is in guild A, puppet 201 is not")
})

test("botpool acquire: one allocation per bot per guild", t => {
	const voice = fakeVoiceLib()
	const {pool} = makePool(voice)
	addPuppet(pool, "201", ["A"], voice)
	const first = pool.acquire("A", {})
	const second = pool.acquire("A", {})
	const third = pool.acquire("A", {})
	t.equal(first?.userID, "201")
	t.equal(second?.userID, "100")
	t.equal(third, null, "no bot free in guild A")
})

test("botpool acquire: puppets first unless preferMain", t => {
	const voice = fakeVoiceLib()
	const {pool} = makePool(voice)
	addPuppet(pool, "201", ["A"], voice)
	t.equal(pool.acquire("A", {preferMain: false})?.userID, "201")
	t.equal(pool.acquire("A", {preferMain: true})?.userID, "100")

	const second = makePool(fakeVoiceLib())
	addPuppet(second.pool, "301", ["A"], voice)
	t.equal(second.pool.acquire("A", {preferMain: true})?.userID, "100")
	t.equal(second.pool.acquire("A", {preferMain: true})?.userID, "301")
})

test("botpool acquire: bots in another guild are skipped, different guilds are independent", t => {
	const voice = fakeVoiceLib()
	const {pool} = makePool(voice)
	addPuppet(pool, "201", ["A", "B"], voice)
	t.equal(pool.acquire("A", {})?.userID, "201")
	t.equal(pool.acquire("B", {})?.userID, "201", "puppet is free in guild B")
	t.equal(pool.acquire("B", {})?.userID, "100", "main takes the second slot in B")
	t.equal(pool.acquire("B", {}), null)
})

test("botpool acquire: unready puppets are skipped", t => {
	const voice = fakeVoiceLib()
	const {pool} = makePool(voice)
	const {bot} = addPuppet(pool, "201", ["A"], voice)
	bot.userID = null
	t.equal(pool.acquire("A", {})?.userID, "100")
})

test("botpool release: frees the bot and leaves voice", async t => {
	const voice = fakeVoiceLib()
	const {pool} = makePool(voice)
	const {bot, snow} = addPuppet(pool, "201", ["A"], voice)
	const got = pool.acquire("A", {})
	t.equal(got?.userID, "201")
	await bot.join("A", "c1")
	t.ok(voice.connections.has("A/201"))

	await pool.release(bot, "A")
	t.notOk(voice.connections.has("A/201"), "left voice")
	t.deepEqual(snow.edits, [{guildID: "A", data: {nick: ""}}], "nickname reset")
	t.equal(pool.acquire("A", {})?.userID, "201", "freed for reuse")
})

test("botpool release: main bot is not renamed", async t => {
	const voice = fakeVoiceLib()
	const {pool, mainSnow} = makePool(voice)
	const got = pool.acquire("A", {preferMain: true})
	t.equal(got?.userID, "100")
	await pool.release(got, "A")
	t.deepEqual(mainSnow.edits, [])
	t.equal(pool.acquire("A", {preferMain: true})?.userID, "100")
})

test("botpool allBotUserIDs: main plus ready puppets", t => {
	const voice = fakeVoiceLib()
	const {pool} = makePool(voice)
	addPuppet(pool, "201", ["A"], voice)
	addPuppet(pool, "202", [], voice)
	const unready = addPuppet(pool, "203", [], voice)
	unready.bot.userID = null
	const ids = pool.allBotUserIDs()
	t.deepEqual([...ids].sort(), ["100", "201", "202"])
})

test("botpool onMainBotPacket: forwards main voice packets to the main bot adapter", t => {
	const voice = fakeVoiceLib()
	const {pool} = makePool(voice)
	/** @type {any[]} */
	const seen = []
	pool.main.adapterCreator("A")({destroy() {}, onVoiceStateUpdate: d => seen.push(d), onVoiceServerUpdate() {}})
	pool.onMainBotPacket({t: "VOICE_STATE_UPDATE", d: {user_id: "100", guild_id: "A", channel_id: "c1"}})
	pool.onMainBotPacket({t: "VOICE_STATE_UPDATE", d: {user_id: "5", guild_id: "A", channel_id: "c1"}})
	t.equal(seen.length, 1)
	t.equal(seen[0].user_id, "100")
})

test("voicebot sendSoundboardSound: posts to the channel with the sound and its source guild", async t => {
	/** @type {any[]} */
	const requests = []
	const snow = {
		guild: {editSelf: () => Promise.resolve({})},
		requestHandler: {
			request(/** @type {string} */ endpoint, /** @type {any} */ params, /** @type {string} */ method, /** @type {string} */ dataType, /** @type {any} */ data) {
				requests.push({endpoint, params, method, dataType, data})
				return Promise.resolve({})
			},
		},
	}
	const bot = new VoiceBot({userID: "200", isMain: false, cloud: fakeCloud(), snow: /** @type {any} */ (snow), voiceLib: () => /** @type {any} */ ({})})
	await bot.sendSoundboardSound("900", "111", "800")
	await bot.sendSoundboardSound("900", "1")
	t.deepEqual(requests, [
		{endpoint: "/channels/900/send-soundboard-sound", params: undefined, method: "post", dataType: "json", data: {sound_id: "111", source_guild_id: "800"}},
		{endpoint: "/channels/900/send-soundboard-sound", params: undefined, method: "post", dataType: "json", data: {sound_id: "1"}},
	], "the source guild is only sent when known")
	t.end()
})

test("voicebot sendSoundboardSound: Discord refusing the request rejects the call", async t => {
	const snow = {
		guild: {editSelf: () => Promise.resolve({})},
		requestHandler: {request: () => Promise.reject(new Error("Missing Permissions"))},
	}
	const bot = new VoiceBot({userID: "200", isMain: false, cloud: fakeCloud(), snow: /** @type {any} */ (snow), voiceLib: () => /** @type {any} */ ({})})
	const error = await bot.sendSoundboardSound("900", "111", null).catch(e => e)
	t.equal(error.message, "Missing Permissions")
	t.end()
})
