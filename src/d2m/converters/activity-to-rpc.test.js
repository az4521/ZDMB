// @ts-check

const {test} = require("supertape")
const {RPC_FIELD, ACTIVITY_TYPE, MUSIC_TYPE, activityToRpcEntry, activitiesToRpc, activityImageUrls} = require("./activity-to-rpc")

test("activity2rpc: field name is the unstable MSC4544 name", t => {
	t.equal(RPC_FIELD, "xyz.extera.msc4544.rpc")
})

test("activity2rpc: Spotify listening becomes a music entry with progress and no 'by' prefix", t => {
	const result = activityToRpcEntry({
		name: "Spotify",
		type: 2,
		details: "Song Title",
		state: "by Some Artist",
		assets: {large_image: "spotify:abc123", large_text: "The Album"},
		timestamps: {start: 1000, end: 4000},
	}, 99, new Map([["https://i.scdn.co/image/abc123", "mxc://example.org/cover"]]))
	t.deepEqual(result, {
		id: "2:Spotify",
		type: MUSIC_TYPE,
		expiry: 99,
		track: "Song Title",
		artist: "Some Artist",
		album: "The Album",
		player_name: "Spotify",
		cover_url: "mxc://example.org/cover",
		progress: {since: 1000, until: 4000},
	})
})

test("activity2rpc: 'By' prefix is removed case-insensitively and music progress needs end > start", t => {
	const result = activityToRpcEntry({
		name: "Spotify",
		type: 2,
		details: "Track",
		state: "BY Artist",
		timestamps: {start: 5000, end: 5000},
	}, undefined)
	t.deepEqual(result, {
		id: "2:Spotify",
		type: MUSIC_TYPE,
		track: "Track",
		artist: "Artist",
		player_name: "Spotify",
	})
})

test("activity2rpc: game with timestamps, party and icons", t => {
	const mxcByUrl = new Map([
		["https://media.discordapp.net/external/x.png", "mxc://example.org/large"],
		["https://cdn.discordapp.com/app-assets/42/123.png", "mxc://example.org/small"],
	])
	const result = activityToRpcEntry({
		id: "abc",
		name: "Game",
		type: 0,
		application_id: "42",
		details: "Level 3",
		state: "In menu",
		party: {id: "party", size: [2, 4]},
		timestamps: {start: 5, end: 10},
		assets: {large_image: "mp:external/x.png", large_text: "Big", small_image: "123", small_text: "Small"},
	}, 7, mxcByUrl)
	t.deepEqual(result, {
		id: "abc",
		type: ACTIVITY_TYPE,
		expiry: 7,
		name: "Game",
		details: "Level 3",
		state: "In menu (2 of 4)",
		since: 5,
		until: 10,
		large_icon_url: "mxc://example.org/large",
		large_icon_tooltip: "Big",
		small_icon_url: "mxc://example.org/small",
		small_icon_tooltip: "Small",
	})
})

test("activity2rpc: small icon is dropped when there is no large icon", t => {
	const result = activityToRpcEntry({
		name: "Game",
		type: 0,
		application_id: "42",
		assets: {small_image: "123", small_text: "Small"},
	}, undefined, new Map([["https://cdn.discordapp.com/app-assets/42/123.png", "mxc://example.org/small"]]))
	t.deepEqual(result, {id: "0:42", type: ACTIVITY_TYPE, name: "Game"})
})

test("activity2rpc: custom status is skipped", t => {
	const result = activityToRpcEntry({name: "Custom Status", type: 4, state: "hello"}, undefined)
	t.equal(result, null)
})

test("activity2rpc: streaming, watching and competing verbs", t => {
	const streaming = activityToRpcEntry({name: "Twitch", type: 1, state: "Chill stream"}, undefined)
	t.equal(streaming?.state, "Streaming · Chill stream")

	const watching = activityToRpcEntry({name: "YouTube", type: 3}, undefined)
	t.equal(watching?.state, "Watching")

	const competing = activityToRpcEntry({name: "Chess", type: 5, state: "Ranked", party: {size: [1, 2]}}, undefined)
	t.equal(competing?.state, "Competing · Ranked (1 of 2)")
})

test("activity2rpc: invalid party sizes are ignored", t => {
	const result = activityToRpcEntry({name: "Game", type: 0, state: "Lobby", party: {size: [5, 2]}}, undefined)
	t.equal(result?.state, "Lobby")
})

test("activity2rpc: text is truncated to 128 characters", t => {
	const long = "x".repeat(200)
	const result = activityToRpcEntry({id: long, name: long, type: 0}, undefined)
	t.equal(result?.name.length, 128)
	t.equal(result?.id.length, 128)
})

test("activity2rpc: a list is capped at 4 entries and skips entries that have none", t => {
	const activities = [
		{name: "Custom", type: 4},
		{name: "A", type: 0},
		{name: "B", type: 0},
		{name: "C", type: 0},
		{name: "D", type: 0},
		{name: "E", type: 0},
		{name: "F", type: 0},
	]
	const result = activitiesToRpc(activities, 1)
	t.equal(result.length, 4)
	t.deepEqual(result.map(entry => entry.name), ["A", "B", "C", "D"])
	t.equal(result.every(entry => entry.expiry === 1), true)
})

test("activity2rpc: expiry is omitted when undefined", t => {
	const [entry] = activitiesToRpc([{name: "A", type: 0}], undefined)
	t.equal("expiry" in entry, false)
})

test("activity2rpc: image URLs for Spotify, media proxy, app assets and unknown references", t => {
	t.deepEqual(activityImageUrls({
		application_id: "42",
		assets: {large_image: "spotify:abc123", small_image: "mp:external/y.png"},
	}), {large: "https://i.scdn.co/image/abc123", small: "https://media.discordapp.net/external/y.png"})

	t.deepEqual(activityImageUrls({
		application_id: "42",
		assets: {large_image: "987", small_image: "foo:bar"},
	}), {large: "https://cdn.discordapp.com/app-assets/42/987.png"})

	t.deepEqual(activityImageUrls({
		assets: {large_image: "987"},
	}), {})
})
