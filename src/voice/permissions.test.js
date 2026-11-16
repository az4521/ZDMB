// @ts-check

const {test} = require("supertape")
const DiscordTypes = require("discord-api-types/v10")
const {id: mainID, permissions, inviteUrl, voicePermissions, puppetPermissions} = require("../../addbot")
const {missingPermissions, checkVoicePermissions} = require("./permissions")

const P = DiscordTypes.PermissionFlagsBits
const GUILD = "800"
const GUILD_NAME = "Guild Name"
const BOT = "100"
const PUPPET = "200"

/**
 * Runs fn while capturing console.warn lines.
 * @param {() => any} fn
 * @returns {{result: any, warnings: string[]}}
 */
function captureWarnings(fn) {
	const original = console.warn
	/** @type {string[]} */
	const warnings = []
	console.warn = (...args) => warnings.push(args.join(" "))
	try {
		return {result: fn(), warnings}
	} finally {
		console.warn = original
	}
}

/**
 * A guild where the bot's member has @everyone with the given permissions.
 * @param {bigint} everyonePermissions
 * @param {{withMember?: boolean}} [options]
 */
function fakeGuild(everyonePermissions, {withMember = true} = {}) {
	return {
		id: GUILD,
		name: GUILD_NAME,
		roles: [{id: GUILD, permissions: everyonePermissions.toString()}],
		members: withMember ? [{user: {id: BOT}, roles: []}] : [],
	}
}

/** @param {any} guild */
function fakeDiscord(...guilds) {
	return {
		user: {id: BOT},
		guilds: new Map(guilds.map(g => [g.id, g])),
	}
}

/**
 * @param {string} userID
 * @param {Set<string>} guildIDs
 */
const fakePuppet = (userID, guildIDs) => ({userID, guildIDs})

test("missingPermissions: names the flags that are not in have", t => {
	const missing = missingPermissions(0n, voicePermissions)
	t.deepEqual(missing.sort(), ["Connect", "Speak", "UseExternalSounds", "UseSoundboard", "UseVAD", "ViewChannel"])
})

test("missingPermissions: only the flags that are really missing", t => {
	t.deepEqual(missingPermissions(P.Speak, P.Speak | P.Connect), ["Connect"])
	t.deepEqual(missingPermissions(P.Speak | P.Connect, P.Speak | P.Connect), [])
	t.deepEqual(missingPermissions(P.Speak, 0n), [])
})

test("missingPermissions: Administrator has everything", t => {
	t.deepEqual(missingPermissions(P.Administrator, voicePermissions), [])
})

test("checkVoicePermissions: main bot missing Speak gets a warning with the re-authorise link", t => {
	const have = voicePermissions & ~P.Speak
	const discord = fakeDiscord(fakeGuild(have))
	const {result, warnings} = captureWarnings(() => checkVoicePermissions({discord, pool: {puppets: []}, bridgedVoiceGuildIDs: [GUILD]}))
	t.deepEqual(warnings, [`[voice] the bot is missing Speak in ${GUILD_NAME} (${GUILD}). Re-authorise it to grant them: ${inviteUrl(mainID, permissions, GUILD)}`])
	t.deepEqual(result, [{guildID: GUILD, bot: "main", missing: ["Speak"]}])
})

test("checkVoicePermissions: no warning when the main bot has everything", t => {
	const discord = fakeDiscord(fakeGuild(voicePermissions))
	const {result, warnings} = captureWarnings(() => checkVoicePermissions({discord, pool: {puppets: []}, bridgedVoiceGuildIDs: [GUILD]}))
	t.deepEqual(warnings, [])
	t.deepEqual(result, [{guildID: GUILD, bot: "main", missing: []}])
})

test("checkVoicePermissions: puppet not in the guild gets an invite link with the puppet permissions", t => {
	const discord = fakeDiscord(fakeGuild(voicePermissions))
	const pool = {puppets: [fakePuppet(PUPPET, new Set())]}
	const {result, warnings} = captureWarnings(() => checkVoicePermissions({discord, pool, bridgedVoiceGuildIDs: [GUILD]}))
	t.deepEqual(warnings, [`[voice] puppet bot ${PUPPET} isn't in ${GUILD_NAME}. Invite it: ${inviteUrl(PUPPET, puppetPermissions, GUILD)}`])
	t.deepEqual(result, [
		{guildID: GUILD, bot: "main", missing: []},
		{guildID: GUILD, bot: PUPPET, missing: "not-in-guild"},
	])
})

test("checkVoicePermissions: puppet in the guild gets no warning", t => {
	const discord = fakeDiscord(fakeGuild(voicePermissions))
	const pool = {puppets: [fakePuppet(PUPPET, new Set([GUILD]))]}
	const {result, warnings} = captureWarnings(() => checkVoicePermissions({discord, pool, bridgedVoiceGuildIDs: [GUILD]}))
	t.deepEqual(warnings, [])
	t.deepEqual(result.find(r => r.bot === PUPPET), {guildID: GUILD, bot: PUPPET, missing: []})
})

test("checkVoicePermissions: only guilds with bridged voice channels are checked", t => {
	const discord = fakeDiscord(fakeGuild(0n), {...fakeGuild(0n), id: "801", name: "Other"})
	const pool = {puppets: [fakePuppet(PUPPET, new Set())]}
	const {result, warnings} = captureWarnings(() => checkVoicePermissions({discord, pool, bridgedVoiceGuildIDs: []}))
	t.deepEqual(result, [])
	t.deepEqual(warnings, [])
})

test("checkVoicePermissions: puppet check alone skips the main bot", t => {
	const discord = fakeDiscord(fakeGuild(0n))
	const puppet = fakePuppet(PUPPET, new Set())
	const {result, warnings} = captureWarnings(() => checkVoicePermissions({discord, pool: {puppets: [puppet]}, bridgedVoiceGuildIDs: [GUILD], puppet}))
	t.equal(warnings.length, 1)
	t.ok(warnings[0].startsWith(`[voice] puppet bot ${PUPPET}`))
	t.deepEqual(result, [{guildID: GUILD, bot: PUPPET, missing: "not-in-guild"}])
})

test("checkVoicePermissions: main bot not in the guild gets an invite link", t => {
	const discord = fakeDiscord(fakeGuild(0n, {withMember: false}))
	const {result, warnings} = captureWarnings(() => checkVoicePermissions({discord, pool: {puppets: []}, bridgedVoiceGuildIDs: [GUILD]}))
	t.deepEqual(warnings, [`[voice] the bot isn't in ${GUILD_NAME} (${GUILD}). Invite it: ${inviteUrl(mainID, permissions, GUILD)}`])
	t.deepEqual(result, [{guildID: GUILD, bot: "main", missing: "not-in-guild"}])
})

test("checkVoicePermissions: a broken guild is logged and skipped without throwing", t => {
	const broken = {id: GUILD, name: GUILD_NAME, members: [{user: {id: BOT}, roles: []}]} // no roles array
	const discord = fakeDiscord(broken)
	const originalError = console.error
	console.error = () => {}
	try {
		const {result, warnings} = captureWarnings(() => checkVoicePermissions({discord, pool: {puppets: []}, bridgedVoiceGuildIDs: [GUILD]}))
		t.deepEqual(result, [])
		t.deepEqual(warnings, [])
	} finally {
		console.error = originalError
	}
})
