# boobjob

A Discord bot for dynamic voice channels. A member joins a hub channel and gets a voice channel of their own: private, hidden, and theirs to run. Whatever they change is remembered and applied again the next time they join the hub.

## What it does

- **Join to create.** Joining a hub channel creates a personal voice channel, moves the member into it and posts a control panel in the channel's chat. The channel is removed when the last person leaves.
- **Private by default.** A new channel is hidden: only its owner (and server administrators) can see or join it.
- **Settings that stick.** Name, user limit, bitrate, voice region, video quality, privacy mode, and the allowed and blocked lists are saved per member, per server.
- **Easy control.** Everything is a button or menu on the control panel, and also available as a `/voice` command.
- **Access.** The owner picks who can see and join the channel, and who is kept out.
- **Moderation.** The owner can kick, mute and deafen people in the channel.
- **Ownership.** The owner can hand the channel over. If the owner leaves, someone still in the channel can claim it.

## Requirements

- A Discord application with a bot user
- Either Docker with the Compose plugin, or Node.js 22.13 or newer

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

**With Docker** (the easy way to run it on a server):

```bash
docker compose up -d --build
```

That builds the image and starts the bot in the background. It comes back by itself after a crash or a reboot, and its settings are kept in a Docker volume. See [Running with Docker](#running-with-docker) for updating, logs and backups.

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

## Permissions

The invite link asks for these. Grant them on the bot's role, server-wide.

| Permission | Why |
| --- | --- |
| View Channels, Connect | To see and manage voice channels, and to hide them from others. |
| Manage Channels | To create, edit and delete the personal channels. |
| Manage Roles | To set who can see and join a channel. Discord files channel permissions under this permission. The bot never touches roles. |
| Move Members | To move people into their channel, and to kick. |
| Mute Members, Deafen Members | For mute and deafen. |
| Send Messages, Read Message History | For the control panel. |
| Speak, Video, Add Reactions, Embed Links and other everyday permissions | Not used by the bot. Discord only lets a bot copy a permission into a channel's overrides if the bot holds it, and the bot has to copy the category's restrictions onto each personal channel. |

The bot does not need Administrator. If a category has overrides for permissions the bot lacks (for example Manage Messages for a moderator role), those cannot be carried over to personal channels; `/voicehub list` tells you which ones, and the bot logs it once. Add them to the bot's role if you rely on them.

Moderators without Administrator cannot see hidden channels. Server administrators always can.

If you remove the bot from a server while someone is muted or deafened through it, a moderator has to lift that by hand.

## Running with Docker

`compose.yaml` builds the image from this repository and runs it with a restart policy, a named volume for the database, and log rotation. The image contains only the compiled bot and its runtime dependencies, and the bot runs as an unprivileged user.

Follow the log:

```bash
docker compose logs -f
```

Update to a newer version of the bot (settings are kept):

```bash
git pull
```

```bash
docker compose up -d --build
```

Apply a change to `.env`:

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

The tests start the real bot against a fake Discord (`test/support/fakeDiscord.ts`): a local gateway plus a REST handler that keeps server state and refuses what Discord would refuse (missing permissions, malformed components, voice changes for members who are not connected). No token or network access is needed.

```
src/
  index.ts          entry point
  bot.ts            wires the client, storage and services together
  events.ts         Discord events → services
  domain/           pure logic: permission overwrites, settings, rename limit
  services/         channel lifecycle, owner actions, mute/deafen, panel, renames
  interactions/     slash commands, buttons, menus, forms
  ui/               the control panel and its menus
  storage/          SQLite schema and queries
test/               unit tests and end-to-end tests against the fake Discord
Dockerfile          the image: compiled code, runtime dependencies, unprivileged user
compose.yaml        how to run it: restart policy, data volume, log rotation
```
