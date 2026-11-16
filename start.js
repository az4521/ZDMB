#!/usr/bin/env node
// @ts-check

// Name the process and the main thread
process.title = "ooye"

// Backport the Intl and Temporal API to Node.js versions older than 26
require("temporal-polyfill-lite/global")

const fs = require("fs")
const sqlite = require("better-sqlite3")
const migrate = require("./src/db/migrate")
const HeatSync = require("heatsync")

const {reg} = require("./src/matrix/read-registration")
const passthrough = require("./src/passthrough")
const db = new sqlite("ooye.db")

const sync = new HeatSync({
	watchFunction(path, options, cb) {
		return fs.watchFile(path, options, (curr, prev) => {
			if (curr.mtimeMs !== prev.mtimeMs || curr.size !== prev.size) cb()
		})
	}
})

Object.assign(passthrough, {sync, db})

const orm = sync.require("./src/db/orm")
passthrough.from = orm.from
passthrough.select = orm.select

const DiscordClient = require("./src/d2m/discord-client")

const discord = new DiscordClient(reg.ooye.discord_token)
passthrough.discord = discord

const {as} = require("./src/matrix/appservice")
passthrough.as = as

const power = require("./src/matrix/power.js")
sync.require("./src/m2d/event-dispatcher")

;(async () => {
	await migrate.migrate(db)
	process.stdout.write("Connecting to Discord... ")
	await discord.cloud.connect()
	console.log("ok.")
	sync.require("./src/web/server")
	await power.applyPower()

	discord.cloud.once("ready", () => {
		as.listen()

		if (reg.ooye.voice_bridge) {
			const voiceBridge = require("./src/voice/bridge")
			voiceBridge.start().catch(e => console.error("[voice] failed to start:", e))
			// Tear down the calls cleanly, then exit as the signal would have
			for (const signal of ["SIGINT", "SIGTERM"]) {
				process.once(signal, () => {
					const timeout = setTimeout(() => process.exit(), 3000)
					voiceBridge.stop().catch(e => console.error("[voice] failed to stop:", e)).finally(() => {
						clearTimeout(timeout)
						process.exit()
					})
				})
			}
		}
	})

	require("./src/stdin")
})()
