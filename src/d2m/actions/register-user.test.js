const {_memberToStateContent, _memberToPowerLevel, memberToColor} = require("./register-user")
const {test} = require("supertape")
const data = require("../../../test/data")
const mixin = require("@cloudrac3r/mixin-deep")
const DiscordTypes = require("discord-api-types/v10")

test("member2state: without member nick or avatar", async t => {
	t.deepEqual(
		await _memberToStateContent(data.member.kumaccino.user, data.member.kumaccino, data.guild.general.id),
		{
			avatar_url: "mxc://cadence.moe/UpAeIqeclhKfeiZNdIWNcXXL",
			displayname: "kumaccino",
			membership: "join",
			"moe.cadence.ooye.member": {
				avatar: "/avatars/113340068197859328/b48302623a12bc7c59a71328f72ccb39.png?size=1024"
			},
			"uk.half-shot.discord.member": {
				bot: false,
				displayColor: 10206929,
				id: "113340068197859328",
				username: "@kumaccino"
			}
		}
	)
})

test("member2state: with global name, without member nick or avatar", async t => {
	t.deepEqual(
		await _memberToStateContent(data.member.papiophidian.user, data.member.papiophidian, data.guild.general.id),
		{
			avatar_url: "mxc://cadence.moe/JPzSmALLirnIprlSMKohSSoX",
			displayname: "PapiOphidian",
			membership: "join",
			"moe.cadence.ooye.member": {
				avatar: "/avatars/320067006521147393/5fc4ad85c1ea876709e9a7d3374a78a1.png?size=1024"
			},
			"uk.half-shot.discord.member": {
				bot: false,
				displayColor: 1579292,
				id: "320067006521147393",
				username: "@papiophidian"
			}
		}
	)
})

test("member2state: with member nick and avatar", async t => {
	t.deepEqual(
		await _memberToStateContent(data.member.sheep.user, data.member.sheep, data.guild.general.id),
		{
			avatar_url: "mxc://cadence.moe/rfemHmAtcprjLEiPiEuzPhpl",
			"eu.she-a.color": {on_dark: "#ff8333", on_light: "#ff8333"},
			displayname: "The Expert's Submarine",
			membership: "join",
			"moe.cadence.ooye.member": {
				avatar: "/guilds/112760669178241024/users/134826546694193153/avatars/38dd359aa12bcd52dd3164126c587f8c.png?size=1024"
			},
			"uk.half-shot.discord.member": {
				bot: false,
				displayColor: null,
				id: "134826546694193153",
				username: "@aprilsong"
			}
		}
	)
})

test("member2color: picks the highest positioned coloured role", t => {
	const color = memberToColor({
		roles: ["217013981053845504", "212762309364285440", "503685967463448616"]
	}, data.guild.general.roles)
	t.equal(color, "#a901ff")
})

test("member2color: ignores roles with colour 0", t => {
	const roles = [
		{id: "100", color: 0, position: 10},
		{id: "200", color: 0x00ff00, position: 5}
	]
	const color = memberToColor({roles: ["100", "200"]}, roles)
	t.equal(color, "#00ff00")
})

test("member2color: null if no member, no roles, or no coloured roles", t => {
	t.equal(memberToColor(undefined, data.guild.general.roles), null)
	t.equal(memberToColor({roles: ["217013981053845504"]}, undefined), null)
	t.equal(memberToColor({roles: []}, data.guild.general.roles), null)
	t.equal(memberToColor({roles: ["503685967463448616"]}, data.guild.general.roles), null)
})

test("member2color: pads hex to six digits", t => {
	const roles = [{id: "100", color: 1, position: 1}]
	t.equal(memberToColor({roles: ["100"]}, roles), "#000001")
})

test("member2color: ties on position go to the higher role ID", t => {
	const roles = [
		{id: "9", color: 0x111111, position: 4},
		{id: "10", color: 0x222222, position: 4}
	]
	t.equal(memberToColor({roles: ["9", "10"]}, roles), "#222222")
})

test("member2color: prefers colors.primary_color when present", t => {
	const roles = [{id: "100", color: 0, position: 1, colors: {primary_color: 0xabcdef}}]
	t.equal(memberToColor({roles: ["100"]}, roles), "#abcdef")
})

test("member2power: default to zero if member roles unknown", async t => {
	const power = _memberToPowerLevel(data.user.clyde_ai, null, data.guild.data_horde, data.channel.saving_the_world)
	t.equal(power, 0)
})

test("member2power: unremarkable = 0", async t => {
	const power = _memberToPowerLevel(data.user.clyde_ai, {
		roles: []
	}, data.guild.data_horde, data.channel.general)
	t.equal(power, 0)
})

test("member2power: can mention everyone = 20", async t => {
	const power = _memberToPowerLevel(data.user.clyde_ai, {
		roles: ["684524730274807911"]
	}, data.guild.data_horde, data.channel.general)
	t.equal(power, 20)
})

test("member2power: can send messages in protected channel due to role = 50", async t => {
	const power = _memberToPowerLevel(data.user.clyde_ai, {
		roles: ["684524730274807911"]
	}, data.guild.data_horde, data.channel.saving_the_world)
	t.equal(power, 50)
})

test("member2power: can send messages in protected channel due to user override = 50", async t => {
	const power = _memberToPowerLevel(data.user.clyde_ai, {
		roles: []
	}, data.guild.data_horde, mixin({}, data.channel.saving_the_world, {
		permission_overwrites: data.channel.saving_the_world.permission_overwrites.concat({
			type: DiscordTypes.OverwriteType.member,
			id: data.user.clyde_ai.id,
			allow: String(DiscordTypes.PermissionFlagsBits.SendMessages),
			deny: "0"
		})
	}))
	t.equal(power, 50)
})

test("member2power: can kick users = 50", async t => {
	const power = _memberToPowerLevel(data.user.clyde_ai, {
		roles: ["682789592390281245"]
	}, data.guild.data_horde, data.channel.general)
	t.equal(power, 50)
})

test("member2power: can manage channels = 100", async t => {
	const power = _memberToPowerLevel(data.user.clyde_ai, {
		roles: ["665290147377578005"]
	}, data.guild.data_horde, data.channel.saving_the_world)
	t.equal(power, 100)
})

test("member2power: pathfinder use case", async t => {
	const power = _memberToPowerLevel(data.user.jerassicore, {
		roles: ["1235396773510647810", "1359752622130593802", "1249165855632265267", "1380768596929806356", "1380756348190462015"]
	}, data.guild.pathfinder, data.channel.character_art)
	t.equal(power, 50)
})
