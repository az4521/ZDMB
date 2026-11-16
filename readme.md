# ZDMB — Zam Discord-Matrix Bridge

<img src="docs/img/icon.png" height="128" width="128">

ZDMB is a fork of [Out Of Your Element](https://gitdab.com/cadence/out-of-your-element) (OOYE), the modern Matrix-to-Discord appservice bridge created by [@cadence:cadence.moe](https://matrix.to/#/@cadence:cadence.moe). It adds the features that the [Zam](https://github.com/az4521/Zam) Matrix client understands.

## Differences from Out Of Your Element

### Profiles

* **Username colours.** A Discord member's role colour is bridged as their username colour (MSC4522, `eu.she-a.color`), both on their room member event and on their global profile.
* **Rich presence.** Discord activities (games, Spotify and other "Listening to" activities, streaming, watching, competing) are bridged to the `xyz.extera.msc4544.rpc` profile field from [MSC4544](https://github.com/matrix-org/matrix-spec-proposals/pull/4544).
* **Custom status.** A Discord custom status is bridged to the `org.matrix.msc4426.status` profile field (MSC4426). Custom Discord emojis can't be shown on Matrix, so only the text is kept for those.
* **In a call.** While someone is in a Discord voice channel, their Matrix profile gets the `org.matrix.msc4426.call` field, which Zam shows as "In a call for N min".
* **Profile banners.** Discord profile banners are bridged to `chat.commet.profile_banner`. Discord only gives bots banners one user at a time, so each user is checked at most once a day, one lookup per second.

Rich presence, custom status and "in a call" follow the same per-server presence setting as normal presence.

### Messages

* **Media galleries.** A Discord message with two or more images, videos or files is bridged as one `dm.filament.gallery` message ([MSC4274](https://github.com/matrix-org/matrix-spec-proposals/pull/4274)) with the message text as its caption, and Matrix galleries are bridged to Discord as one message with several attachments (split into several messages above Discord's 10-attachment limit). Set `ooye.gallery_messages: false` in `registration.yaml` to keep OOYE's one-event-per-attachment behaviour for Discord-to-Matrix.
* **Video thumbnails.** Videos bridged from Discord get a poster frame (`info.thumbnail_url`), taken from Discord's media proxy and scaled to fit 800×800.
* **Voice messages.** Discord voice messages become Matrix voice messages (MSC3245, with the waveform). Matrix voice messages go to Discord as `voice-message.ogg` audio files, because webhooks can't send real Discord voice messages.
* **No PluralKit or /plu/ral support.** Messages from proxy bots are treated like any other webhook message.

### Rooms and spaces

* **Channel order.** Rooms in the space are ordered like the Discord channel list (using `m.space.child` `order`): by category, text channels before voice channels, then position. Threads appear right after their channel.
* **Categories.** Each channel's `m.space.child` event has `moe.crafty.zdmb.category`: `{id, name}` of its Discord category (no key for uncategorised channels or threads), so clients can group rooms by category without nested spaces. It stays up to date when categories are renamed, moved or deleted.
* **Channel tags.** Every bridged room has `moe.crafty.zdmb.channel`: `{type, name}`, both as a room state event and on its `m.space.child` event. `type` is the Discord channel type (`text`, `voice`, `stage`, `announcement`, `forum`, `media`, `public_thread`, `private_thread`, `announcement_thread`) and `name` is the room name without the bridge's prefix ("[🔊] ", "[⛓️] "), or the custom room name if one is set.
* **Thread rooms.** Rooms bridged from Discord threads and forum posts have a `moe.crafty.zdmb.thread_parent` state event: `{room_id, via, event_id?}`, where `room_id` is the parent channel's room and `event_id` is the message the thread was started from (when there is one). The same `{room_id, event_id?}` is on the thread's `m.space.child` event in the parent space. Private and archived threads aren't listed in the space.
* **Voice rooms.** Bridged voice channels let everyone join calls (the `m.call.member`, `org.matrix.msc3401.call.member` and `m.rtc.member` power levels are 0).

Because the category, channel and thread information is on the `m.space.child` events, clients can read it from `/hierarchy` without joining the rooms.

In self-service servers (where rooms are linked by hand), ZDMB leaves your own arrangement of channel rooms in the space alone, so channel order, categories and the space-side channel tags only apply to threads there.

### Voice channels

Bridged voice channels can be bridged live to Matrix calls (MatrixRTC with a LiveKit SFU, as used by Zam and Element Call). Audio only: Discord's bot API can't send or receive video or screen shares.

* Each Discord speaker joins the Matrix call as their own bridged account, with their own audio track.
* Matrix speakers are played into Discord by bots. Each Matrix speaker gets their own "puppet" bot (nicknamed after them) while there are free ones; anyone beyond that is mixed through the main bot.
* A channel is bridged while anyone is in it on either side, and the bots leave when everyone has.

It's off by default. To turn it on, add to the `ooye` section of `registration.yaml`:

```yaml
voice_bridge: true
voice_puppet_tokens: ["<extra bot token>", "<another bot token>"]  # optional
```

Each puppet is a separate Discord bot application; invite every puppet to your servers with the View Channel, Connect, Speak and Change Nickname permissions. With no puppets, the main bot can bridge one voice channel per server at a time and plays all Matrix speakers mixed together. Your homeserver must advertise a LiveKit server (`org.matrix.msc4143.rtc_foci` in `.well-known/matrix/client`). Voice bridging uses native packages (`@discordjs/voice`, `@livekit/rtc-node`), installed by `npm install` as optional dependencies on Linux x64 (glibc) and Windows x64. Stage channels aren't supported yet.

## Requirements

* Everything OOYE needs ([installation instructions](https://docs.ooye.org/for-hosters/install/)).
* For username colours, rich presence, custom status, "in a call" and banners: a homeserver that supports custom profile fields ([MSC4133](https://github.com/matrix-org/matrix-spec-proposals/pull/4133), part of Matrix 1.16). Without it, these are skipped and everything else works.
* ZDMB also asks Discord for the voice states gateway intent. It isn't privileged, so nothing needs to change in the Discord developer portal.

## Drop-in compatibility

ZDMB uses the same `registration.yaml`, the same `ooye.db` database and the same database migrations as OOYE 3.8. You can stop OOYE, put ZDMB in its place, and start it: no data is converted. ZDMB adds no tables or columns, so you can also go back to OOYE later. The PluralKit tables (`sim_proxy`, `channel_speedbump`) are left in place but no longer written to.

On its first start, ZDMB adds the channel order, categories, channel tags and thread markers to rooms and spaces that OOYE created.

### Switching an existing OOYE install to ZDMB

Back up `ooye.db`, then in the OOYE folder:

```sh
git remote set-url origin https://github.com/az4521/ZDMB.git
git remote add upstream https://gitdab.com/cadence/out-of-your-element.git
git pull origin main
```

Then restart the bridge. `npm install` is only needed if `package.json`'s dependencies have changed.

## What works?

Most features you'd expect in both directions: messages, edits, deletions, formatting (including spoilers), reactions, custom emojis, custom emoji reactions, mentions, channel mentions, replies, threads, stickers (all formats: PNG, APNG, GIF, Lottie), attachments, spoiler attachments (compatible with most clients), embeds, URL previews, presence, discord.com hyperlinks, and more.

Metadata is also synced: people's names, avatars, usernames; channel names, icons, topics; spaces containing rooms; custom emoji lists. Syncing Matrix rooms, room icons, and topics is optional: you can keep them different from the Discord ones if you prefer.

New spaces are invite-only, and their rooms can be joined by members of the space. This can be changed per server with `/privacy` or on the bridge website.

For more information about features, [see the OOYE user guide.](https://docs.ooye.org/for-users/user-guide/)

## Caveats

* This bridge is not designed for puppetting.
* Direct Messaging is not supported.
* Encrypted messages are not supported.

## Get started!

For a new install, follow [OOYE's installation instructions](https://docs.ooye.org/for-hosters/install/), but clone `https://github.com/az4521/ZDMB.git` instead of the OOYE repository.

## License

AGPL-3.0-or-later, the same as Out Of Your Element. See `COPYING`.
