# ZDMB — Zam Discord-Matrix Bridge

<img src="docs/img/icon.png" height="128" width="128">

ZDMB is a fork of [Out Of Your Element](https://gitdab.com/cadence/out-of-your-element) (OOYE), the modern Matrix-to-Discord appservice bridge created by [@cadence:cadence.moe](https://matrix.to/#/@cadence:cadence.moe). It adds the features that the [Zam](https://github.com/az4521/Zam) Matrix client understands.

## Differences from Out Of Your Element

* **Username colours.** A Discord member's role colour is bridged as their username colour (MSC4522, `eu.she-a.color`), both on their room member event and on their global profile.
* **Rich presence.** Discord activities (games, Spotify and other "Listening to" activities, streaming, watching, competing) are bridged to the `xyz.extera.msc4544.rpc` profile field from [MSC4544](https://github.com/matrix-org/matrix-spec-proposals/pull/4544). This uses the same per-server presence setting as normal presence.
* **Custom status.** A Discord custom status is bridged to the `org.matrix.msc4426.status` profile field (MSC4426). Custom Discord emojis can't be shown on Matrix, so only the text is kept for those.
* **In a call.** While someone is in a Discord voice channel, their Matrix profile gets the `org.matrix.msc4426.call` field, which Zam shows as "In a call for N min". Status and calls use the same per-server presence setting as normal presence. ZDMB asks Discord for the (non-privileged) voice states intent for this.
* **Profile banners.** Discord profile banners are bridged to `chat.commet.profile_banner`. Discord only gives bots banners one user at a time, so each user is checked at most once a day, one lookup per second.
* **Voice messages.** Discord voice messages become Matrix voice messages (MSC3245, with the waveform). Matrix voice messages go to Discord as `voice-message.ogg` audio files, because webhooks can't send real Discord voice messages.
* **Media galleries.** A Discord message with several attachments is bridged as one `dm.filament.gallery` message ([MSC4274](https://github.com/matrix-org/matrix-spec-proposals/pull/4274)) with the message text as its caption, and Matrix galleries are bridged to Discord as one message with several attachments. Set `ooye.gallery_messages: false` in `registration.yaml` to keep OOYE's one-event-per-attachment behaviour for Discord-to-Matrix.
* **Channel order.** Rooms in the space are ordered like the Discord channel list (using `m.space.child` `order`): by category, text channels before voice channels, then position. Threads appear right after their channel.
* **Voice rooms.** Bridged voice channels let everyone join calls (the `m.call.member`, `org.matrix.msc3401.call.member` and `m.rtc.member` power levels are 0).
* **No PluralKit or /plu/ral support.** Messages from proxy bots are treated like any other webhook message.

### Drop-in compatibility

ZDMB uses the same `registration.yaml`, the same `ooye.db` database and the same database migrations as OOYE 3.8. You can stop OOYE, put ZDMB in its place, and start it: no data is converted. ZDMB adds no tables or columns, so you can also go back to OOYE later. The PluralKit tables (`sim_proxy`, `channel_speedbump`) are left in place but no longer written to.

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

Installation is the same as for OOYE: [read the installation instructions →](https://docs.ooye.org/for-hosters/install/)

## License

AGPL-3.0-or-later, the same as Out Of Your Element. See `COPYING`.
