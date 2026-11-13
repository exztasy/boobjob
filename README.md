# boobjob

A Discord bot for dynamic voice channels. A member joins a hub channel and gets a voice channel of their own: private, hidden, and theirs to run. Whatever they change is remembered and applied again the next time they join the hub.

It also plays music from YouTube, Spotify and SoundCloud, in as many voice channels at once as it has bot accounts to play with.

## What it does

- **Join to create.** Joining a hub channel creates a personal voice channel, moves the member into it and posts a control panel in the channel's chat. The channel is removed when the last person leaves.
- **Private by default.** A new channel is hidden: only its owner (and server administrators) can see or join it.
- **Settings that stick.** Name, user limit, bitrate, voice region, video quality, privacy mode, and the allowed and blocked lists are saved per member, per server.
- **Easy control.** Everything is a button or menu on the control panel, and also available as a `/voice` command.
- **Access.** The owner picks who can see and join the channel, and who is kept out.
- **Moderation.** The owner can kick, mute and deafen people in the channel.
- **Ownership.** The owner can hand the channel over. If the owner leaves, someone still in the channel can claim it.
- **Music.** `/music play` with a link or a search, and a bot joins your voice channel and plays it, with a queue and controls. Extra bot accounts let several channels have music at the same time, all run through the one bot people talk to.

## Requirements

- A Discord application with a bot user, plus one more for each extra voice channel that should be able to play music at the same time (optional)
- Either Docker with the Compose plugin, which also runs the music server, or Node.js 22.13 or newer and a [Lavalink](https://lavalink.dev) 4.2 server for music

Settings are stored in a SQLite file using Node's built-in SQLite, so there is no database server to run and nothing native to compile.

## Setup

### 1. Create the bot

1. Open the [Discord Developer Portal](https://discord.com/developers/applications) and create an application.
2. On the **Bot** page, press **Reset Token** and copy the token.

No privileged gateway intents are needed. Leave them switched off.

### 2. Configure and start

```bash
cp .env.example .env
```

Put the token into `.env` as `DISCORD_TOKEN`.

| Variable | Default | Meaning |
| --- | --- | --- |
| `DISCORD_TOKEN` | (required) | The bot token |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` or `silent` |
| `DATABASE_PATH` | `./data/bot.sqlite` | Where settings are stored; created on first start. Ignored with Docker Compose, which keeps the database in a volume. |
| `LAVALINK_PASSWORD` | (empty: no music) | Password shared by the bot and Lavalink. Make one up. Required with Docker Compose. |
| `MUSIC_BOT_TOKENS` | (empty) | Tokens of extra music bots, separated by commas. See [Music](#music). |
| `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET` | (empty) | For Spotify links and searches. See [Spotify](#spotify). |
| `LAVALINK_HOST`, `LAVALINK_PORT`, `LAVALINK_SECURE` | `localhost`, `2333`, `false` | Where Lavalink is, when you run it yourself. Docker Compose sets these. |

**With Docker** (the easy way to run it on a server):

```bash
docker compose up -d --build
```

That builds the image and starts the bot and its music server in the background. Both come back by themselves after a crash or a reboot, and the bot's settings are kept in a Docker volume. See [Running with Docker](#running-with-docker) for updating, logs and backups.

**Without Docker:**

```bash
npm install
```

```bash
npm run build
```

```bash
npm start
```

### 3. Invite it

On startup the bot logs an invite link with the right permissions already selected (with Docker: `docker compose logs`). Open it and add the bot to your server.

### 4. Create a hub

In the server, run:

```
/voicehub setup
```

This creates a voice channel named "➕ Create a channel". Join it and you have your own channel. To use a channel you already have instead, run `/voicehub add`.

`/voicehub list` shows the hubs and checks the bot's permissions, and says exactly what to fix if something is missing.

## Music

Music needs a [Lavalink](https://lavalink.dev) server: it fetches the audio from YouTube, Spotify and SoundCloud and streams it into Discord. With Docker Compose it runs next to the bot and is set up already. Put a password into `.env`, any long random string:

```
LAVALINK_PASSWORD=change-me-to-something-long-and-random
```

That is all it takes for one channel at a time: the bot itself joins your voice channel and plays.

### More channels at once: extra music bots

A Discord bot can be in one voice channel per server, so every extra voice channel that should have music at the same time needs another bot account. People still only talk to the main bot; the extra ones just play.

1. In the [Developer Portal](https://discord.com/developers/applications), create another application, and on its **Bot** page reset and copy the token. It needs no intents and no special settings. Name it so people can tell, for example "Music 1".
2. Add the token to `MUSIC_BOT_TOKENS` in `.env`. Several are separated by commas:
   ```
   MUSIC_BOT_TOKENS=first-token,second-token
   ```
3. Restart the bot. For each extra bot it logs an invite link asking for View Channels, Connect and Speak. Invite each one to your server. `/music bots` lists them too, with invite links for those not in the server yet (for members with Manage Server).

When someone asks for music, a free extra bot goes first; the main bot plays only when they are all busy. With two extra bots, three voice channels can have music at once.

### Spotify

Spotify does not stream to bots. For a Spotify track, Lavalink plays the same recording from YouTube, matched by its ISRC code, or by artist and title. To read Spotify links and search Spotify it needs an app:

1. Create an app at the [Spotify developer dashboard](https://developer.spotify.com/dashboard). Any name and description; the redirect URI is not used (enter `http://127.0.0.1/` if one is required) and Web API is the API to pick.
2. Copy its client ID and client secret into `.env` as `SPOTIFY_CLIENT_ID` and `SPOTIFY_CLIENT_SECRET`, and restart: `docker compose up -d`.

Without them, Lavalink tries an anonymous token, which Spotify often refuses.

### YouTube

YouTube goes through Lavalink's [YouTube plugin](https://github.com/lavalink-devs/youtube-source). YouTube keeps changing, and blocks servers it takes for bots:

- **Playback stops working for everything.** A newer plugin version is usually the fix. Lavalink logs a warning at startup when one is out. Put the new version number in `lavalink/application.yml` and run `docker compose up -d`.
- **"Sign in to confirm you're not a bot".** YouTube has flagged the server's IP address. The plugin can sign in with a Google account: see the `oauth` lines in `lavalink/application.yml` and [the plugin's guide](https://github.com/lavalink-devs/youtube-source#using-oauth-tokens). Use a throwaway account, never your own.

### Using it

Join a voice channel and run `/music play` with a YouTube, Spotify or SoundCloud link (a song, playlist or album), or with words to search for. A bot joins your channel and plays; more requests queue up behind it. A message in the channel's chat shows what is playing and what comes next, with buttons for pause, skip, stop, loop and shuffle. Replies to commands are only shown to the person who asked.

Anyone in the voice channel can control its music; you have to be in the channel to do so.

| Command | |
| --- | --- |
| `/music play <query> [source]` | Play a link or the first search result, or add it to the queue. Searches go to YouTube unless you pick YouTube Music, Spotify or SoundCloud. |
| `/music pause` · `/music resume` | Pause and carry on |
| `/music skip` | Skip to the next track |
| `/music stop` | Stop, clear the queue and send the bot away |
| `/music queue [page]` | What is playing and what is up next |
| `/music nowplaying` | The current track and how far along it is |
| `/music volume <percent>` | 0 to 150; 100 is normal |
| `/music loop <mode>` | Off, the current track, or the whole queue |
| `/music shuffle` | Shuffle the waiting tracks |
| `/music remove <position>` | Take a track out of the queue |
| `/music bots` | Which music bots there are and what each one is doing |

## Using it

### The control panel

The panel is posted in the chat of each personal channel. Only the owner can use it; everyone else gets a private note saying so.

| Button | What it does |
| --- | --- |
| **Rename** | Opens a form for the name. An empty name goes back to the default ("Name's channel"). |
| **User limit** | 1 to 99, or 0 for no limit. |
| **Bitrate & region** | Menus for bitrate, voice region and video quality. |
| **Hidden / Locked / Public** | The privacy mode, see below. |
| **Allowed users** | A people picker showing who is allowed. Add or remove people in it. |
| **Blocked users** | The same for people who are kept out. Blocking someone who is in the channel also disconnects them. |
| **Kick** | Pick people in the channel to disconnect. |
| **Mute** / **Deafen** | Tick people to mute or deafen them; untick to undo. |
| **Transfer ownership** | Hand the channel to someone in it. |
| **Claim channel** | Take over a channel whose owner has left. |

### Privacy modes

| Mode | Who can see it | Who can join |
| --- | --- | --- |
| **Hidden** (default) | Owner and allowed users | Owner and allowed users |
| **Locked** | Everyone who can see the category | Owner and allowed users |
| **Public** | Everyone who can see the category | Everyone who could join other channels in the category |

Blocked users can neither see nor join the channel, in any mode.

### Commands

Every control also exists as a command. A `/voice` command applies to the channel it is typed in, otherwise to the personal channel you are sitting in, otherwise to the one you own.

| Command | |
| --- | --- |
| `/voice panel` | Post a fresh control panel |
| `/voice name [name]` | Rename; leave the name out to go back to the default |
| `/voice limit <users>` | Set the user limit (0 for none) |
| `/voice bitrate <kbps>` | Set the bitrate |
| `/voice region [region]` | Set the voice region; leave it out for automatic |
| `/voice video <quality>` | Auto or 720p |
| `/voice privacy <mode>` | Hidden, locked or public |
| `/voice allow <user>` · `/voice disallow <user>` | Edit the allowed list |
| `/voice block <user>` · `/voice unblock <user>` | Edit the blocked list |
| `/voice kick <user>` | Disconnect someone |
| `/voice mute <user>` · `/voice unmute <user>` | Mute or unmute someone |
| `/voice deafen <user>` · `/voice undeafen <user>` | Deafen or undeafen someone |
| `/voice transfer <user>` | Hand the channel over |
| `/voice claim` | Take over the channel you are in after its owner left |

For server admins (requires Manage Server by default):

| Command | |
| --- | --- |
| `/voicehub setup [name] [category]` | Create a hub channel |
| `/voicehub add <channel>` | Turn an existing voice channel into a hub |
| `/voicehub remove <channel>` | Stop using a channel as a hub (the channel is kept) |
| `/voicehub list` | Show hubs and check the bot's permissions |

## How it behaves

**Personal channels follow their category.** A new channel is created next to its hub and starts out with the category's permission overrides, so mute roles, verification gates and the like keep working inside personal channels. Privacy, the owner, and the allowed and blocked lists are layered on top. "Public" therefore means "like the other channels in this category", not "open to the whole server".

**Allowed and blocked lists** hold up to 25 people each and belong to the owner, not the channel: they are applied to every channel that member creates. An allowed user is let in even if one of their roles is kept out of the category.

**Mute and deafen only apply inside the channel.** Discord has no per-channel mute: a server mute follows someone into every voice channel. The bot handles that for you. A mute is lifted the moment the person moves to another channel, applies again if they come back, and is lifted the next time they join voice if they disconnected while muted. The bot only ever lifts mutes it applied itself, so a moderator's server mute is never undone by accident, and if a moderator lifts the owner's mute, it stays lifted.

**One channel per member.** An owner who joins the hub while their channel is still in use is moved back into it. Creating channels back to back is slowed down by a few seconds to stop join/leave spam.

**Ownership.** The channel stays with its owner while they are in it. If they leave and others remain, anyone in the channel can claim it. The previous owner keeps access. What a new owner changes is saved for them, not for the previous owner. Members who could manage the channel in Discord itself (Manage Channels) can use the controls too; what they change is saved for the channel's owner.

**Renames.** Discord allows two renames per channel every ten minutes. A third one is saved straight away and applied to the channel as soon as Discord permits; the panel shows when.

**Restarts.** State lives in the database, so channels and their panels keep working across a restart. On startup the bot removes channels that emptied while it was offline, serves anyone waiting in a hub, and lifts mutes that should have ended.

**Music in personal channels.** A personal channel is usually hidden, so the bot that plays in it is let in for as long as it plays there, even if the channel is full, and loses that access afterwards. In other channels a music bot only goes where its own permissions let it; the bot tells you if none of them can.

**When the music stops.** A bot leaves when nobody has been listening for a minute, when the queue has been empty for five minutes, when someone disconnects it or drags it elsewhere, or when its channel is deleted. Bots do not count as listeners, and do not keep a personal channel alive. The "now playing" message then says why the music stopped.

**Queue.** A channel's queue holds up to 500 tracks and lasts as long as the bot stays; it is not kept across restarts. A track that cannot be played is skipped and the message says why. After five failures in a row playback stops rather than work through the rest of the queue, because the source is probably broken; the queue is kept, and `/music skip` carries on.

**When Lavalink is down.** Music that was playing stops, the bot keeps trying to reconnect every few seconds, and `/music play` says that the music server cannot be reached until it is back. Everything else keeps working.

## Permissions

The invite link asks for these. Grant them on the bot's role, server-wide.

| Permission | Why |
| --- | --- |
| View Channels, Connect | To see and manage voice channels, and to hide them from others. |
| Manage Channels | To create, edit and delete the personal channels. |
| Manage Roles | To set who can see and join a channel. Discord files channel permissions under this permission. The bot never touches roles. |
| Move Members | To move people into their channel, and to kick. |
| Mute Members, Deafen Members | For mute and deafen. |
| Send Messages, Read Message History | For the control panel and the music message. |
| Speak | To play music. |
| Video, Add Reactions, Embed Links and other everyday permissions | Not used by the bot. Discord only lets a bot copy a permission into a channel's overrides if the bot holds it, and the bot has to copy the category's restrictions onto each personal channel. |

The bot does not need Administrator. If a category has overrides for permissions the bot lacks (for example Manage Messages for a moderator role), those cannot be carried over to personal channels; `/voicehub list` tells you which ones, and the bot logs it once. Add them to the bot's role if you rely on them.

Moderators without Administrator cannot see hidden channels. Server administrators always can.

If you remove the bot from a server while someone is muted or deafened through it, a moderator has to lift that by hand.

Extra music bots need View Channels, Connect and Speak, which their invite links ask for. They never change anything in the server.

## Running with Docker

`compose.yaml` builds the image from this repository and runs it with a restart policy, a named volume for the database, and log rotation. The image contains only the compiled bot and its runtime dependencies, and the bot runs as an unprivileged user.

Next to it runs Lavalink, the music server, from its official image and with its settings from `lavalink/application.yml`. It is reachable only by the bot, on the network Compose sets up for them; no port is opened on the machine. On every start it downloads its YouTube and Spotify plugins if it does not have them, and checks for newer versions, so it needs to reach `maven.lavalink.dev`; until it can, it keeps restarting.

Follow the logs:

```bash
docker compose logs -f
```

Only the music server's:

```bash
docker compose logs -f lavalink
```

Update to a newer version of the bot (settings are kept):

```bash
git pull
```

```bash
docker compose up -d --build
```

Apply a change to `.env` or `lavalink/application.yml`:

```bash
docker compose up -d
```

Stop the bot. The volume, and with it everyone's settings, stays:

```bash
docker compose down
```

`docker compose down -v` also deletes the volume. Only use it if you want to start from scratch.

If something is wrong, for example a token that was reset, the bot says so in the log and exits, and Docker keeps restarting it until the problem is fixed.

### Backup and restore

The database is the file `/app/data/bot.sqlite` in the volume. Stop the bot before copying it, so that the file is complete.

Back up:

```bash
docker compose stop
```

```bash
docker compose cp bot:/app/data/bot.sqlite ./bot-backup.sqlite
```

```bash
docker compose start
```

Restore:

```bash
docker compose stop
```

```bash
docker compose cp ./bot-backup.sqlite bot:/app/data/bot.sqlite
```

```bash
docker compose run --rm --user root bot sh -c 'rm -f data/bot.sqlite-wal data/bot.sqlite-shm; chown node:node data/bot.sqlite'
```

```bash
docker compose start
```

The third command matters: a file copied into a container belongs to root, and the bot refuses to start on a database it cannot write to. It also clears leftovers of the database that was there before.

### Details

- **Node version.** The image is built on Node 26. To use another release line (22 or newer), change `NODE_VERSION` at the top of the `Dockerfile`.
- **Without Compose.** `docker build -t boobjob .` and then `docker run -d --name boobjob --restart unless-stopped --init --env-file .env -v boobjob-data:/app/data boobjob`.
- **A host folder instead of a volume.** If you mount a folder from the host on `/app/data`, it has to be writable by user id 1000, which is what the bot runs as: `sudo chown 1000:1000 ./data`.
- **Lavalink's memory.** Java takes up to a quarter of the machine's memory by default. To set a limit, uncomment `_JAVA_OPTIONS` in `compose.yaml`.
- **Lavalink without Compose.** It runs anywhere with Java 17 or newer: download `Lavalink.jar` from [its releases](https://github.com/lavalink-devs/Lavalink/releases) (4.2 or newer), put `lavalink/application.yml` next to it, and start it with `LAVALINK_SERVER_PASSWORD` set to the bot's `LAVALINK_PASSWORD` (and the Spotify variables, if you use them) in its environment: `java -jar Lavalink.jar`. Then point the bot at it with `LAVALINK_HOST` and `LAVALINK_PORT`. Do not expose it to the internet: anyone with the password can use it.

## Data

Everything is in one SQLite file: the hubs, each member's saved settings and lists, and the channels currently open. With Docker it lives in the volume (see [Backup and restore](#backup-and-restore)); otherwise it is the file at `DATABASE_PATH`. Back it up to keep your members' settings. Deleting it resets the bot; channels that are open at that moment are no longer managed and have to be removed by hand.

## Development

```bash
npm run dev
```

runs the bot from source and restarts it on changes.

```bash
npm test
```

```bash
npm run typecheck
```

The tests start the real bot against a fake Discord (`test/support/fakeDiscord.ts`): a local gateway plus a REST handler that keeps server state and refuses what Discord would refuse (missing permissions, malformed components, voice changes for members who are not connected). It serves several bot accounts at once and answers voice requests the way Discord does. Music is tested against a fake Lavalink (`test/support/fakeLavalink.ts`), a local HTTP and websocket server speaking Lavalink's protocol, which lets a test decide when a track ends or fails. No token or network access is needed.

```
src/
  index.ts          entry point
  bot.ts            wires the client, storage and services together
  events.ts         Discord events → services
  domain/           pure logic: permission overwrites, settings, rename limit
  services/         channel lifecycle, owner actions, mute/deafen, panel, renames
  music/            music: the bot pool, sessions and queues, voice connections, the Lavalink client
  interactions/     slash commands, buttons, menus, forms
  ui/               the control panel, the music message, menus
  storage/          SQLite schema and queries
test/               unit tests and end-to-end tests against the fake Discord and the fake Lavalink
lavalink/           the music server's configuration
Dockerfile          the image: compiled code, runtime dependencies, unprivileged user
compose.yaml        how to run it: the bot and Lavalink, restart policy, data volume, log rotation
```
