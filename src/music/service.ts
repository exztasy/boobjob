import {
  Client,
  DiscordAPIError,
  Events,
  GatewayIntentBits,
  PermissionFlagsBits,
  RESTJSONErrorCodes,
  channelMention,
  escapeMarkdown,
  userMention,
  type Channel,
  type ClientOptions,
  type Guild,
  type GuildMember,
  type VoiceChannel,
  type VoiceState,
} from 'discord.js';
import type { MusicConfig } from '../config.js';
import { UserError } from '../errors.js';
import type { Logger } from '../logger.js';
import type { ChannelService } from '../services/channels.js';
import type { Store } from '../storage/store.js';
import type { Tuning } from '../tuning.js';
import { renderEndedMusicPanel, renderMusicPanel, type MusicPanelView } from '../ui/musicPanel.js';
import type { PanelMessage } from '../ui/panel.js';
import { describeError, hasApiCode, humanCount, isInvalidToken, isVoiceChannel } from '../util/discord.js';
import type { KeyedQueue } from '../util/keyedQueue.js';
import { compactLine, describeException, formatDuration, plainText, trackLine, trackTitle } from './format.js';
import {
  LavalinkError,
  type LoadResult,
  type PlayerEvent,
  type PlayerState,
  type Track,
  type VoiceServer,
} from './lavalink/protocol.js';
import { PlayerBot, type PlayerBotHandlers } from './playerBot.js';
import { parseRequest, SEARCH_SOURCES, type MusicRequest, type SearchSource } from './query.js';
import { LOOP_MODES, MAX_QUEUE_LENGTH, type Ending, type LoopMode, type QueueItem } from './queue.js';
import { MusicSession, SessionEndedError, type EndReason } from './session.js';
import { VoiceJoinError } from './voice.js';

export const MAX_VOLUME = 150;
/** How many waiting tracks `/music queue` lists per page. */
export const QUEUE_PAGE_SIZE = 10;
/**
 * After this many tracks in a row could not be played, playback stops. When
 * a source is broken altogether, working through a queue of hundreds helps
 * nobody.
 */
export const MAX_FAILURES_IN_A_ROW = 5;

/** Close code of the audio connection that says Discord itself took the bot out of the channel. */
const VOICE_CLOSE_DISCONNECTED = 4014;

/** The sources the bot is meant to support; anything else Lavalink offers comes on top. */
const EXPECTED_SOURCES = [
  ['youtube', 'YouTube'],
  ['spotify', 'Spotify'],
  ['soundcloud', 'SoundCloud'],
] as const;

const NO_MENTIONS = { parse: [] } as const;

export interface MusicDeps {
  /** The main bot's connection to Discord: the one people talk to. */
  client: Client;
  store: Store;
  queue: KeyedQueue;
  channels: ChannelService;
  log: Logger;
  tuning: Tuning;
  config: MusicConfig;
  /** Overrides for the helper bots' Discord clients; tests point them at a fake Discord. */
  clientOptions?: Partial<ClientOptions>;
}

interface Loaded {
  tracks: Track[];
  /** Name of the playlist or album the tracks came from, if they did. */
  playlist: string | null;
}

/**
 * Plays music in voice channels.
 *
 * People only ever talk to the main bot. Behind it is a pool of bot accounts,
 * the main one included, each of which can sit in one voice channel per
 * server. Whoever asks for music gets a free bot from the pool sent to their
 * channel; if one is already playing there, the request joins its queue.
 * Fetching and streaming the audio is Lavalink's job. This class decides
 * which bot goes where and what it plays next.
 */
export class MusicService {
  /** The pool, in the order bots are handed out: the main bot first. */
  readonly bots: PlayerBot[];
  private readonly sessions = new Map<string, MusicSession>();
  /** Which session a bot is tied up in, per server. */
  private readonly busy = new Map<string, MusicSession>();
  /** Bots whose failure to reach Lavalink has been logged, so it is said once per outage. */
  private readonly unreachable = new Set<number>();
  private nextPlayId = 1;
  private stopped = false;

  constructor(private readonly deps: MusicDeps) {
    const { config, tuning, log } = deps;
    const handlers: PlayerBotHandlers = {
      nodeReady: (bot) => this.nodeReady(bot),
      nodeDown: (bot, reason, wasReady) => this.nodeDown(bot, reason, wasReady),
      playerEvent: (bot, event) => this.playerEvent(bot, event),
      playerState: (bot, guildId, state) => this.playerState(bot, guildId, state),
      voiceServerChanged: (bot, guildId, voice) => this.voiceServerChanged(bot, guildId, voice),
      displaced: (bot, guildId, channelId) => this.displaced(bot, guildId, channelId),
    };
    const botDeps = { address: config.lavalink, tuning, log };

    this.bots = [new PlayerBot(deps.client, 0, botDeps, handlers)];
    for (let index = 1; index <= config.botTokens.length; index++) {
      const client = new Client({
        // Which servers it is in, and its own place in voice. A helper needs nothing else.
        intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
        allowedMentions: { parse: [] },
        ...deps.clientOptions,
      });
      const bot = new PlayerBot(client, index, botDeps, handlers);
      this.watchHelper(bot);
      this.bots.push(bot);
    }
  }

  // ── starting and stopping ───────────────────────────────────────────────

  /**
   * Logs the helper bots in. One that cannot log in is reported and left
   * out; the rest of the bot does not depend on it.
   */
  async start(): Promise<void> {
    const { log, config } = this.deps;
    await Promise.all(
      this.bots.slice(1).map(async (bot) => {
        try {
          await bot.client.login(config.botTokens[bot.index - 1]!);
        } catch (error) {
          if (isInvalidToken(error)) {
            log.error(
              `Discord rejected the token of music bot #${bot.index} (entry ${bot.index} of MUSIC_BOT_TOKENS). Carrying on without it.`,
            );
          } else {
            log.error(`Music bot #${bot.index} could not connect to Discord. Carrying on without it.`, error);
          }
        }
      }),
    );
  }

  /**
   * Drops everything. Lavalink stops a bot's players when the bot's
   * connection to it closes, and Discord takes a bot out of voice when it
   * logs off, so nothing needs to be wound down one by one.
   */
  async stop(): Promise<void> {
    this.stopped = true;
    for (const session of this.sessions.values()) {
      session.state = 'ended';
      session.clearTimers();
    }
    this.sessions.clear();
    this.busy.clear();
    for (const bot of this.bots) bot.stop();
    await Promise.all(
      this.bots.slice(1).map((bot) =>
        bot.client.destroy().catch((error: unknown) => this.deps.log.warn(`Could not log ${bot.name} off cleanly`, error)),
      ),
    );
  }

  private watchHelper(bot: PlayerBot): void {
    const { log } = this.deps;
    bot.client.once(Events.ClientReady, (ready) => {
      log.info(`Music bot #${bot.index} logged in as ${ready.user.tag}, in ${ready.guilds.cache.size} server(s)`);
      log.info(`Invite link for ${ready.user.tag}: ${bot.inviteLink()}`);
    });
    bot.client.on(Events.Error, (error) => log.error(`Discord client error of ${bot.name}`, error));
    bot.client.on(Events.Warn, (message) => log.warn(`${bot.name}: ${message}`));
    bot.client.on(Events.ShardDisconnect, (closeEvent) => {
      if (this.stopped) return;
      log.error(
        `${bot.name} was disconnected by Discord and will not reconnect (close code ${closeEvent.code}). ` +
          'If its token was reset, update MUSIC_BOT_TOKENS and restart.',
      );
    });
  }

  // ── what people ask for ─────────────────────────────────────────────────

  /** Plays a link or the first result of a search in the member's voice channel, or queues it there. */
  async play(member: GuildMember, input: string, source?: SearchSource): Promise<string> {
    const channel = this.voiceChannelOf(member);
    const request = parseRequest(input, source);
    const loaded = await this.load(request);
    const items = loaded.tracks.map((track) => ({ track, requesterId: member.id }));

    if (member.voice.channelId !== channel.id) {
      throw new UserError('You left the voice channel while I was looking that up, so I did not start it.');
    }

    for (let attempt = 1; ; attempt++) {
      const joining = !this.sessions.has(channel.id);
      const session = this.sessionFor(channel);
      try {
        await session.ready;
        return await this.run(session, () => this.enqueue(session, items, loaded.playlist, joining));
      } catch (error) {
        // A session can end between being found and being used, by its idle timer for
        // instance. The request is still good, so start afresh, once.
        if (error instanceof SessionEndedError && attempt === 1) continue;
        throw error;
      }
    }
  }

  pause(member: GuildMember): Promise<string> {
    const session = this.sessionOf(member);
    return this.run(session, async () => {
      if (!session.current) throw new UserError('Nothing is playing right now.');
      if (session.paused) return 'The music is already paused.';
      await this.command(session, () => session.bot.node.updatePlayer(session.guildId, { paused: true }));
      session.progress = { at: Date.now(), position: session.position };
      session.paused = true;
      this.panel(session);
      return '⏸️ Paused.';
    });
  }

  resume(member: GuildMember): Promise<string> {
    const session = this.sessionOf(member);
    return this.run(session, async () => {
      if (!session.current) throw new UserError('Nothing is playing right now.');
      if (!session.paused) return 'The music is not paused.';
      await this.command(session, () => session.bot.node.updatePlayer(session.guildId, { paused: false }));
      session.progress = { at: Date.now(), position: session.position };
      session.paused = false;
      this.panel(session);
      return '▶️ Resumed.';
    });
  }

  /** What the pause button does: whichever of the two applies. */
  togglePause(member: GuildMember): Promise<string> {
    return this.sessionOf(member).paused ? this.resume(member) : this.pause(member);
  }

  skip(member: GuildMember): Promise<string> {
    const session = this.sessionOf(member);
    return this.run(session, async () => {
      const skipped = session.current?.item;
      if (!skipped && session.queue.length === 0) throw new UserError('There is nothing to skip.');
      await this.advance(session, 'skipped');
      this.panel(session);

      const next = session.current
        ? `▶️ Now playing ${trackLine(session.current.item.track)}`
        : 'That was the last track in the queue.';
      return skipped ? `⏭️ Skipped ${trackTitle(skipped.track)}.\n${next}` : next;
    });
  }

  /** Ends the music in the member's channel and sends the bot away. */
  stopPlaying(member: GuildMember): Promise<string> {
    const session = this.sessionOf(member);
    return this.run(session, async () => {
      await this.finish(session, { kind: 'stopped', by: member.id });
      return `⏹️ Stopped the music in ${channelMention(session.channelId)}.`;
    });
  }

  setVolume(member: GuildMember, percent: number): Promise<string> {
    const session = this.sessionOf(member);
    if (!Number.isInteger(percent) || percent < 0 || percent > MAX_VOLUME) {
      throw new UserError(`The volume is a number from 0 to ${MAX_VOLUME}; 100 is normal.`);
    }
    return this.run(session, async () => {
      await this.command(session, () => session.bot.node.updatePlayer(session.guildId, { volume: percent }));
      session.volume = percent;
      this.panel(session);
      return `🔊 Volume set to ${percent}%.`;
    });
  }

  setLoop(member: GuildMember, mode: LoopMode): Promise<string> {
    const session = this.sessionOf(member);
    return this.run(session, () => {
      session.queue.loop = mode;
      this.panel(session);
      if (mode === 'track') return '🔁 Repeating the current track until you skip it or turn looping off.';
      if (mode === 'queue') return '🔁 Repeating the whole queue: every track goes back to the end when it has played.';
      return '🔁 Looping is off.';
    });
  }

  /** What the loop button does: off, then track, then queue, then off again. */
  cycleLoop(member: GuildMember): Promise<string> {
    const session = this.sessionOf(member);
    const next = LOOP_MODES[(LOOP_MODES.indexOf(session.queue.loop) + 1) % LOOP_MODES.length]!;
    return this.setLoop(member, next);
  }

  shuffle(member: GuildMember): Promise<string> {
    const session = this.sessionOf(member);
    return this.run(session, () => {
      if (session.queue.length < 2) throw new UserError('There are not enough tracks waiting to shuffle them.');
      session.queue.shuffle();
      this.panel(session);
      return `🔀 Shuffled the ${session.queue.length} waiting tracks.`;
    });
  }

  remove(member: GuildMember, position: number): Promise<string> {
    const session = this.sessionOf(member);
    return this.run(session, () => {
      const removed = session.queue.remove(position);
      if (!removed) {
        const waiting = session.queue.length;
        throw new UserError(
          waiting === 0
            ? 'No tracks are waiting in the queue.'
            : `There is no track at position ${position}. ${waiting === 1 ? 'One track is' : `${waiting} tracks are`} waiting; \`/music queue\` lists them.`,
        );
      }
      this.panel(session);
      return `🗑️ Removed ${trackTitle(removed.track)} from the queue.`;
    });
  }

  /** The current track and one page of what is waiting. */
  describeQueue(member: GuildMember, page = 1): string {
    const session = this.sessionOf(member);
    const waiting = session.queue.upcoming;
    const pages = Math.max(1, Math.ceil(waiting.length / QUEUE_PAGE_SIZE));
    const shown = Math.min(Math.max(1, Math.trunc(page)), pages);

    const lines = [
      session.current
        ? `**Now playing** · ${compactLine(session.current.item.track)}`
        : '**Nothing is playing right now.**',
    ];
    if (waiting.length === 0) {
      lines.push('No tracks are waiting. Add some with `/music play`.');
    } else {
      const first = (shown - 1) * QUEUE_PAGE_SIZE;
      lines.push(
        `**Up next** · ${countOf(waiting.length, 'track')} · \`${formatDuration(session.queue.duration)}\``,
        ...waiting.slice(first, first + QUEUE_PAGE_SIZE).map((item, index) => `${first + index + 1}. ${compactLine(item.track)}`),
      );
      if (pages > 1) lines.push(`-# Page ${shown} of ${pages}. \`/music queue page:<number>\` shows another one.`);
    }
    return lines.join('\n');
  }

  nowPlaying(member: GuildMember): string {
    const session = this.sessionOf(member);
    const current = session.current;
    if (!current) {
      return session.queue.length > 0
        ? `Nothing is playing right now. ${countOf(session.queue.length, 'track')} waiting; \`/music skip\` starts the next one.`
        : 'Nothing is playing right now. Add music with `/music play`.';
    }

    const { track } = current.item;
    const progress = track.info.isStream
      ? 'live'
      : `${formatDuration(session.position)} / ${formatDuration(track.info.length)}`;
    const details = [`Requested by ${userMention(current.item.requesterId)}`];
    if (session.queue.loop === 'track') details.push('🔁 repeating this track');
    if (session.queue.loop === 'queue') details.push('🔁 repeating the queue');
    if (session.volume !== 100) details.push(`🔊 ${session.volume}%`);
    details.push(session.queue.length === 0 ? 'nothing queued after it' : `${countOf(session.queue.length, 'track')} queued after it`);

    return [
      `${session.paused ? '⏸️' : '▶️'} ${trackLine(track)} · \`${progress}\``,
      details.join(' · '),
      `-# Played by ${userMention(session.bot.userId ?? '0')} in ${channelMention(session.channelId)}`,
    ].join('\n');
  }

  /** Which bots there are, and what each of them is doing in this server. */
  status(guild: Guild, showInvites: boolean): string {
    const lines = ['**Music bots**'];
    for (const bot of this.bots) {
      const name = `**${escapeMarkdown(bot.name)}**`;
      const session = this.busy.get(busyKey(bot, guild.id));
      if (!bot.online) {
        lines.push(`🔴 ${name} is not logged in to Discord.`);
      } else if (!bot.guild(guild.id)) {
        const invite = showInvites ? bot.inviteLink() : null;
        lines.push(`⚪ ${name} is not in this server.${invite ? ` [Invite it](<${invite}>)` : ''}`);
      } else if (!bot.usable) {
        lines.push(`🟠 ${name} cannot reach the music server right now.`);
      } else if (session) {
        const waiting = session.queue.length;
        lines.push(`🎵 ${name} is playing in ${channelMention(session.channelId)}${waiting > 0 ? ` (${waiting} queued)` : ''}.`);
      } else {
        lines.push(`🟢 ${name} is free.`);
      }
    }
    const here = this.bots.filter((bot) => bot.guild(guild.id)).length;
    lines.push(
      `-# Each bot plays in one voice channel at a time, so this server can have music in ${countOf(here, 'channel')} at once.`,
    );
    return lines.join('\n');
  }

  // ── the "now playing" message ───────────────────────────────────────────

  /** The session playing in a voice channel, if there is one. */
  sessionIn(channelId: string): MusicSession | undefined {
    return this.sessions.get(channelId);
  }

  /**
   * The "now playing" message of a channel as it should look at this moment,
   * for a caller that is about to show exactly that; the update that was
   * pending for it is dropped. `null` if no music is playing there.
   */
  takePanel(channelId: string): PanelMessage | null {
    const session = this.sessions.get(channelId);
    if (!session) return null;
    if (session.panelTimer) clearTimeout(session.panelTimer);
    session.panelTimer = null;
    return renderMusicPanel(this.view(session));
  }

  private view(session: MusicSession): MusicPanelView {
    return {
      botId: session.bot.userId ?? '0',
      current: session.current?.item ?? null,
      paused: session.paused,
      loop: session.queue.loop,
      volume: session.volume,
      upcoming: session.queue.upcoming,
      upcomingDuration: session.queue.duration,
      problem: session.problem,
    };
  }

  /** Asks for the message to be brought up to date soon; changes in quick succession cost one edit. */
  private panel(session: MusicSession): void {
    if (session.state === 'ended' || session.panelBlocked || session.panelTimer) return;
    session.panelTimer = setTimeout(() => {
      session.panelTimer = null;
      this.refreshPanel(session).catch((error: unknown) =>
        this.deps.log.warn(`Could not update the music message in channel ${session.channelId}`, error),
      );
    }, this.deps.tuning.panelDebounceMs);
    session.panelTimer.unref();
  }

  private refreshPanel(session: MusicSession): Promise<void> {
    return this.deps.queue.run(panelKey(session), async () => {
      if (session.state === 'ended' || session.panelBlocked) return;
      const channel = this.deps.client.channels.cache.get(session.channelId);
      if (!isVoiceChannel(channel)) return;

      const message = { ...renderMusicPanel(this.view(session)), allowedMentions: NO_MENTIONS };
      try {
        if (session.panelMessageId) {
          try {
            await channel.messages.edit(session.panelMessageId, message);
            return;
          } catch (error) {
            // Someone deleted it: post a new one.
            if (!hasApiCode(error, RESTJSONErrorCodes.UnknownMessage)) throw error;
            session.panelMessageId = null;
          }
        }
        session.panelMessageId = (await channel.send(message)).id;
      } catch (error) {
        if (hasApiCode(error, RESTJSONErrorCodes.MissingAccess, RESTJSONErrorCodes.MissingPermissions)) {
          // Not allowed to write in this channel's chat. The commands work all the same.
          session.panelBlocked = true;
          this.deps.log.debug(`No permission to post the music message in channel ${session.channelId}`);
        } else if (!hasApiCode(error, RESTJSONErrorCodes.UnknownChannel)) {
          throw error;
        }
      }
    });
  }

  /** Turns the message into a note on why the music ended, without controls. */
  private closePanel(session: MusicSession, reason: string): Promise<void> {
    return this.deps.queue.run(panelKey(session), async () => {
      if (!session.panelMessageId) return;
      const channel = this.deps.client.channels.cache.get(session.channelId);
      if (!isVoiceChannel(channel)) return;
      await channel.messages
        .edit(session.panelMessageId, { ...renderEndedMusicPanel(reason), allowedMentions: NO_MENTIONS })
        .catch(() => undefined);
    });
  }

  // ── finding and starting sessions ───────────────────────────────────────

  private voiceChannelOf(member: GuildMember): VoiceChannel {
    const channel = member.voice.channel;
    if (!channel) throw new UserError('Join a voice channel first, then ask me for music.');
    if (!isVoiceChannel(channel)) throw new UserError('I can only play music in voice channels, not on stages.');
    return channel;
  }

  /** The session a member may control: the one in the voice channel they are in. */
  private sessionOf(member: GuildMember): MusicSession {
    const channelId = member.voice.channelId;
    const session = channelId ? this.sessions.get(channelId) : undefined;
    if (session) return session;

    const elsewhere = [...this.sessions.values()].some((other) => other.guildId === member.guild.id);
    if (!channelId) {
      throw new UserError(
        elsewhere
          ? 'Join the voice channel the music is playing in to control it.'
          : 'Nothing is playing right now. Join a voice channel and start with `/music play`.',
      );
    }
    throw new UserError(`Nothing is playing in ${channelMention(channelId)}. Start with \`/music play\`.`);
  }

  /**
   * The session of a voice channel, started if there is none. Picking the
   * bot and marking it as taken happens in one go, without waiting for
   * anything, so that two requests arriving together cannot get the same bot.
   */
  private sessionFor(channel: VoiceChannel): MusicSession {
    const existing = this.sessions.get(channel.id);
    if (existing) return existing;

    const managed = this.deps.store.getTempChannel(channel.id) !== undefined;
    const bot = this.assign(channel, managed);
    const session = new MusicSession(channel.guild.id, channel.id, bot, managed);
    this.sessions.set(channel.id, session);
    this.busy.set(busyKey(bot, channel.guild.id), session);

    session.ready = this.deps.queue.run(sessionKey(session), () => this.connect(session, channel));
    // Whoever started the session waits for this and hears about a failure; nobody else has to.
    session.ready.catch(() => undefined);
    return session;
  }

  /** Picks a bot from the pool for a channel that has no music yet. */
  private assign(channel: VoiceChannel, managed: boolean): PlayerBot {
    const guildId = channel.guild.id;
    const members = this.bots.filter((bot) => bot.guild(guildId));
    const connected = members.filter((bot) => bot.usable);
    if (connected.length === 0) {
      throw new UserError("I can't reach the music server right now. Please try again in a moment.");
    }

    const free = connected.filter((bot) => !this.busy.has(busyKey(bot, guildId)));
    if (free.length === 0) {
      const playing = members.flatMap((bot) => this.busy.get(busyKey(bot, guildId))?.channelId ?? []);
      throw new UserError(
        members.length === 1
          ? `I am already playing in ${channelMention(playing[0] ?? channel.id)}, and I can only be in one voice channel at a time. Join me there, or wait until I am done.`
          : `All ${members.length} of my music bots are busy (in ${playing.map((id) => channelMention(id)).join(', ')}). Join one of those channels, or try again when one is free.`,
      );
    }

    // A personal channel is ours to open up, so any free bot will do there. Elsewhere
    // the bot has to get by on the permissions the server gave it.
    let refusal: string | undefined;
    for (const bot of free) {
      const obstacle = managed ? null : bot.obstacle(guildId, channel.id);
      if (!obstacle) return bot;
      refusal ??= obstacle.full
        ? `${channelMention(channel.id)} is full, and ${userMention(bot.userId ?? '0')} may not join a full channel.`
        : `${userMention(bot.userId ?? '0')} is missing **${obstacle.missing.join('**, **')}** in ${channelMention(channel.id)}.`;
    }
    throw new UserError(`I can't play there. ${refusal}`);
  }

  /** Gets the session's bot into the channel and gives it a player on Lavalink. */
  private async connect(session: MusicSession, channel: VoiceChannel): Promise<void> {
    const { bot, guildId, channelId } = session;
    const { queue, channels } = this.deps;
    try {
      const botId = bot.userId;
      if (session.managed && botId && bot.obstacle(guildId, channelId)) {
        // A personal channel is usually hidden or locked, and may be full. Its owner asked for
        // music, though, so the bot is let in for as long as it plays there.
        await channels.setGuest(channel, botId, true, `Letting ${bot.name} in to play music`);
        session.admitted = true;
      }

      await queue.run(voiceKey(bot, guildId), async () => {
        const guild = bot.guild(guildId);
        if (!guild) throw new VoiceJoinError('the bot is not a member of this server');
        const voice = await bot.voice.join(guild, channelId);
        await bot.node.updatePlayer(guildId, { voice, volume: session.volume });
      });

      session.state = 'active';
      this.watchAudience(session);
      this.armIdle(session);
    } catch (error) {
      await this.finish(session, { kind: 'failed' });
      throw this.explainConnectFailure(session, error);
    }
  }

  private explainConnectFailure(session: MusicSession, error: unknown): UserError {
    const { log } = this.deps;
    const bot = userMention(session.bot.userId ?? '0');
    const channel = channelMention(session.channelId);
    if (error instanceof UserError) return error;

    log.warn(`${session.bot.name} could not start playing in channel ${session.channelId} of guild ${session.guildId}`, error);
    if (error instanceof VoiceJoinError) {
      return new UserError(
        `${bot} couldn't join ${channel}: Discord did not let it in. Check that it may see and join the channel, then try again.`,
      );
    }
    if (error instanceof LavalinkError) {
      return new UserError('The music server could not set up the audio connection. Please try again in a moment.');
    }
    if (error instanceof DiscordAPIError) {
      return new UserError(`I couldn't let ${bot} into ${channel}. ${describeError(error)}`);
    }
    return new UserError(describeError(error));
  }

  // ── loading ─────────────────────────────────────────────────────────────

  private async load(request: MusicRequest): Promise<Loaded> {
    const { log } = this.deps;
    // Looking something up is not tied to a player, so any bot's connection will do.
    const bot = this.bots.find((candidate) => candidate.usable);
    if (!bot) throw new UserError("I can't reach the music server right now. Please try again in a moment.");

    let result: LoadResult;
    try {
      result = await bot.node.loadTracks(request.identifier);
    } catch (error) {
      log.warn(`Looking up "${request.identifier}" on the music server failed`, error);
      throw new UserError('The music server did not answer. Please try again in a moment.');
    }

    const nothing =
      request.kind === 'link'
        ? "I couldn't find anything to play at that link."
        : `I couldn't find anything for "${escapeMarkdown(request.text)}" on ${SEARCH_SOURCES[request.source].label}.`;

    switch (result.loadType) {
      case 'track':
        if (!isTrack(result.data)) break;
        return { tracks: [result.data], playlist: null };
      case 'search': {
        // The first hit is what the search engine thinks was meant.
        const first = Array.isArray(result.data) ? result.data.find(isTrack) : undefined;
        if (!first) throw new UserError(nothing);
        return { tracks: [first], playlist: null };
      }
      case 'playlist': {
        const tracks = Array.isArray(result.data?.tracks) ? result.data.tracks.filter(isTrack) : [];
        if (tracks.length === 0) throw new UserError('That playlist has nothing in it that I can play.');
        // A link to one track within a playlist: start with that track and go on from there.
        const selected = result.data.info?.selectedTrack ?? -1;
        const start = Number.isInteger(selected) && selected > 0 && selected < tracks.length ? selected : 0;
        return {
          tracks: [...tracks.slice(start), ...tracks.slice(0, start)],
          playlist: plainText(result.data.info?.name, 80) || 'a playlist',
        };
      }
      case 'empty':
        throw new UserError(nothing);
      case 'error':
        log.warn(`The music server could not load "${request.identifier}": ${result.data?.message} (${result.data?.cause})`);
        throw new UserError(`I couldn't load that: ${describeException(result.data)}.`);
      default:
    }
    log.warn(`The music server gave an answer to "${request.identifier}" that makes no sense`, result);
    throw new UserError('The music server gave an answer I do not understand. Please try something else.');
  }

  private async enqueue(
    session: MusicSession,
    items: QueueItem[],
    playlist: string | null,
    joined: boolean,
  ): Promise<string> {
    const first = items[0]!;
    const idle = session.current === null;
    const position = session.queue.length + 1;
    const added = session.queue.add(items);
    if (added === 0) {
      throw new UserError(`The queue is full: it holds ${MAX_QUEUE_LENGTH} tracks. Skip or remove some first.`);
    }
    if (idle) await this.advance(session, 'finished');
    this.panel(session);

    const lines: string[] = [];
    if (joined) lines.push(`🎵 ${userMention(session.bot.userId ?? '0')} joined ${channelMention(session.channelId)}.`);
    const startedIt = idle && session.current?.item === first;
    if (playlist !== null) lines.push(`➕ Added ${countOf(added, 'track')} from **${playlist}** to the queue.`);
    if (startedIt) lines.push(`▶️ Now playing ${trackLine(first.track)}`);
    else if (playlist === null) lines.push(`➕ Added ${trackLine(first.track)} to the queue at position ${position}.`);
    if (added < items.length) {
      lines.push(`${countOf(items.length - added, 'track')} did not fit: the queue holds ${MAX_QUEUE_LENGTH}.`);
    }
    if (idle && !startedIt && session.problem) lines.push(`⚠️ ${session.problem}`);
    return lines.join('\n');
  }

  // ── playback ────────────────────────────────────────────────────────────

  /**
   * Runs something on a session after everything queued for it before, and
   * only if the session is still going by then.
   */
  private run<T>(session: MusicSession, task: () => Promise<T> | T): Promise<T> {
    return this.deps.queue.run(sessionKey(session), () => {
      if (session.state === 'ended') throw new SessionEndedError();
      return task();
    });
  }

  /** Sends Lavalink an instruction on someone's behalf, turning a failure into something they can read. */
  private async command<T>(session: MusicSession, send: () => Promise<T>): Promise<T> {
    try {
      return await send();
    } catch (error) {
      if (!(error instanceof LavalinkError)) throw error;
      this.deps.log.warn(`The music server refused an instruction for guild ${session.guildId}`, error);
      throw new UserError('The music server did not accept that. Please try again in a moment.');
    }
  }

  /**
   * Moves on from the current track, which ended the given way, to whatever
   * is next, and leaves the session silent if nothing is.
   */
  private async advance(session: MusicSession, ending: Ending): Promise<void> {
    const { bot, guildId } = session;
    const next = session.queue.next(session.current?.item ?? null, ending);
    session.paused = false;
    session.progress = null;

    if (!next) {
      session.current = null;
      if (ending !== 'finished') {
        // A skipped track is still sounding, and a failed one may be stuck rather than gone.
        const silence = async (): Promise<unknown> => bot.node.updatePlayer(guildId, { track: { encoded: null } });
        if (ending === 'skipped') await this.command(session, silence);
        else await silence().catch(() => undefined);
      }
      this.armIdle(session);
      return;
    }

    const playId = this.nextPlayId++;
    session.current = { item: next, playId, failure: null };
    this.disarmIdle(session);
    try {
      // Starting a track replaces whatever is playing, and Lavalink un-pauses for it.
      await bot.node.updatePlayer(guildId, { track: { encoded: next.track.encoded, userData: { playId } } });
    } catch (error) {
      if (!(error instanceof LavalinkError)) throw error;
      this.deps.log.warn(`The music server refused to play "${next.track.info.title}" in guild ${guildId}`, error);
      await this.trackFailed(session, next, 'the music server refused it');
    }
  }

  /** Notes that a track could not be played, and carries on with the next unless too many have failed. */
  private async trackFailed(session: MusicSession, item: QueueItem, why: string): Promise<void> {
    session.failures++;
    session.problem = `Skipped ${trackTitle(item.track)}: ${why}.`;

    if (session.failures < MAX_FAILURES_IN_A_ROW) {
      await this.advance(session, 'failed');
      return;
    }
    // Something is wrong beyond this one track. Keep what is queued, but stop trying.
    session.failures = 0;
    session.current = null;
    session.paused = false;
    session.progress = null;
    session.problem =
      `Stopped after ${MAX_FAILURES_IN_A_ROW} tracks in a row could not be played, the last one because ${why}. ` +
      'The music server may be having trouble with this source.';
    await (async () => session.bot.node.updatePlayer(session.guildId, { track: { encoded: null } }))().catch(() => undefined);
    this.armIdle(session);
  }

  private playerEvent(bot: PlayerBot, event: PlayerEvent): void {
    const session = this.busy.get(busyKey(bot, event.guildId));
    if (!session) return;
    this.run(session, () => this.handlePlayerEvent(session, event)).catch((error: unknown) => {
      if (!(error instanceof SessionEndedError)) {
        this.deps.log.error(`Could not handle ${event.type} for guild ${event.guildId}`, error);
      }
    });
  }

  private async handlePlayerEvent(session: MusicSession, event: PlayerEvent): Promise<void> {
    const { log } = this.deps;
    if (event.type === 'WebSocketClosedEvent') {
      this.audioConnectionClosed(session, event.code, event.reason);
      return;
    }

    // Events also arrive for tracks we have long moved on from: the one a skip replaced, for instance.
    const current = session.current;
    if (!current || event.track?.userData?.playId !== current.playId) return;
    const { item } = current;

    switch (event.type) {
      case 'TrackStartEvent':
        session.progress = { at: Date.now(), position: 0 };
        break;

      case 'TrackExceptionEvent':
        // The track's end is reported separately; this says why it will not be a happy one.
        current.failure = describeException(event.exception);
        log.warn(
          `"${item.track.info.title}" failed to play in guild ${session.guildId}: ${event.exception?.message} (${event.exception?.cause})`,
        );
        break;

      case 'TrackStuckEvent':
        log.warn(`"${item.track.info.title}" got stuck in guild ${session.guildId}`);
        await this.trackFailed(session, item, 'it stopped sending audio');
        break;

      case 'TrackEndEvent':
        if (event.reason === 'finished' && current.failure === null) {
          session.failures = 0;
          session.problem = null;
          await this.advance(session, 'finished');
        } else if (event.reason === 'finished' || event.reason === 'loadFailed') {
          await this.trackFailed(session, item, current.failure ?? 'the music server could not load it');
        } else if (event.reason === 'cleanup') {
          // Lavalink gave the track up without being asked to.
          session.current = null;
          session.progress = null;
          this.armIdle(session);
        }
        // `stopped` and `replaced` are answers to our own instructions; nothing is news there.
        break;

      default:
    }
    this.panel(session);
  }

  private playerState(bot: PlayerBot, guildId: string, state: PlayerState): void {
    const session = this.busy.get(busyKey(bot, guildId));
    if (!session?.current || typeof state?.position !== 'number') return;
    session.progress = { at: Date.now(), position: state.position };
  }

  // ── when things change around a session ─────────────────────────────────

  /** To be called for every voice state change the main bot sees. */
  handleVoiceStateUpdate(oldState: VoiceState, newState: VoiceState): void {
    if (oldState.channelId === newState.channelId) return;
    for (const channelId of [oldState.channelId, newState.channelId]) {
      const session = channelId ? this.sessions.get(channelId) : undefined;
      if (session) this.watchAudience(session);
    }
  }

  handleChannelDelete(channel: Channel): void {
    const session = this.sessions.get(channel.id);
    if (session) this.end(session, { kind: 'channelDeleted' });
  }

  /** The main bot is no longer in a server (or the server is unreachable): nobody can control the music there. */
  handleGuildGone(guild: Guild): void {
    for (const session of [...this.sessions.values()]) {
      if (session.guildId === guild.id) this.end(session, { kind: 'guildGone' });
    }
  }

  /** Starts or stops the countdown to leaving, depending on whether anyone is listening. */
  private watchAudience(session: MusicSession): void {
    const guild = this.deps.client.guilds.cache.get(session.guildId);
    if (!guild || session.state !== 'active') return;

    if (humanCount(guild, session.channelId) > 0) {
      if (session.aloneTimer) clearTimeout(session.aloneTimer);
      session.aloneTimer = null;
    } else if (!session.aloneTimer) {
      session.aloneTimer = setTimeout(() => {
        session.aloneTimer = null;
        this.end(session, { kind: 'alone' });
      }, this.deps.tuning.musicAloneMs);
      session.aloneTimer.unref();
    }
  }

  private armIdle(session: MusicSession): void {
    if (session.idleTimer || session.state === 'ended') return;
    session.idleTimer = setTimeout(() => {
      session.idleTimer = null;
      if (!session.current) this.end(session, { kind: 'idle' });
    }, this.deps.tuning.musicIdleMs);
    session.idleTimer.unref();
  }

  private disarmIdle(session: MusicSession): void {
    if (session.idleTimer) clearTimeout(session.idleTimer);
    session.idleTimer = null;
  }

  private displaced(bot: PlayerBot, guildId: string, channelId: string | null): void {
    const session = this.busy.get(busyKey(bot, guildId));
    if (session) this.end(session, { kind: channelId === null ? 'disconnected' : 'moved' });
  }

  private voiceServerChanged(bot: PlayerBot, guildId: string, voice: VoiceServer): void {
    const session = this.busy.get(busyKey(bot, guildId));
    if (!session) return;
    this.run(session, async () => {
      try {
        await bot.node.updatePlayer(guildId, { voice });
      } catch (error) {
        this.deps.log.warn(`${bot.name} could not follow Discord to a new voice server in guild ${guildId}`, error);
        await this.finish(session, { kind: 'voice' });
      }
    }).catch(() => undefined);
  }

  /**
   * Lavalink's audio connection to Discord closed. If Discord threw the bot
   * out, the bot's voice state says so and that is handled there. Anything
   * else may well mend itself (Lavalink reconnects, or Discord hands out a
   * new voice server), so the connection gets a moment before the music is
   * called off rather than left playing to nobody.
   */
  private audioConnectionClosed(session: MusicSession, code: number, reason: string): void {
    const { log, tuning } = this.deps;
    log.debug(`Audio connection of ${session.bot.name} in guild ${session.guildId} closed: ${code} ${reason}`);
    if (code === VOICE_CLOSE_DISCONNECTED || session.recoveryTimer) return;

    session.recoveryTimer = setTimeout(() => {
      session.recoveryTimer = null;
      this.run(session, async () => {
        const player = await session.bot.node.getPlayer(session.guildId);
        if (player.state?.connected) return;
        log.warn(`The audio connection of ${session.bot.name} in guild ${session.guildId} did not come back (close code ${code})`);
        await this.finish(session, { kind: 'voice' });
      }).catch((error: unknown) => {
        if (!(error instanceof SessionEndedError)) log.warn('Could not check on an audio connection', error);
      });
    }, tuning.voiceRecoveryMs);
    session.recoveryTimer.unref();
  }

  // ── the connection to Lavalink ──────────────────────────────────────────

  private nodeReady(bot: PlayerBot): void {
    this.unreachable.delete(bot.index);
    this.deps.log.info(`${bot.name} is connected to the music server`);
    if (bot.isMain) void this.inspectServer(bot);
  }

  private nodeDown(bot: PlayerBot, reason: string, wasReady: boolean): void {
    const { log, config, tuning } = this.deps;
    if (this.stopped) return;
    const where = `${config.lavalink.host}:${config.lavalink.port}`;

    if (wasReady) {
      log.warn(`${bot.name} lost its connection to the music server at ${where}: ${reason}. Reconnecting.`);
      // Lavalink forgets a connection's players the moment the connection closes.
      for (const session of [...this.sessions.values()]) {
        if (session.bot === bot) this.end(session, { kind: 'lavalink' });
      }
    } else if (!this.unreachable.has(bot.index)) {
      this.unreachable.add(bot.index);
      const hint =
        reason === 'the password was rejected'
          ? ' LAVALINK_PASSWORD has to be the password that Lavalink itself is configured with.'
          : '';
      log.warn(
        `${bot.name} cannot connect to the music server at ${where}: ${reason}.${hint} ` +
          `Trying again every ${Math.round(tuning.lavalinkRetryMs / 1000)} s until it works.`,
      );
    }
  }

  /** Says in the log what the Lavalink server is, and what it is missing for what the bot promises. */
  private async inspectServer(bot: PlayerBot): Promise<void> {
    const { log } = this.deps;
    try {
      const info = await bot.node.info();
      const sources = (info.sourceManagers ?? []).map((name) => String(name).toLowerCase());
      log.info(`Music server: Lavalink ${info.version?.semver ?? '(unknown version)'}, sources: ${sources.join(', ') || 'none'}`);
      const missing = EXPECTED_SOURCES.filter(([name]) => !sources.includes(name)).map(([, label]) => label);
      if (missing.length > 0) {
        log.warn(
          `The music server has no source for ${missing.join(', ')}, so links and searches there will not work. ` +
            "Check the plugins in Lavalink's application.yml, and Lavalink's own log for why they did not load.",
        );
      }
    } catch (error) {
      log.debug('Could not ask the music server about itself', error);
    }
  }

  // ── ending ──────────────────────────────────────────────────────────────

  /** Ends a session from outside its own queue of work: after an event or a timer. */
  private end(session: MusicSession, reason: EndReason): void {
    this.run(session, () => this.finish(session, reason)).catch((error: unknown) => {
      if (!(error instanceof SessionEndedError)) {
        this.deps.log.error(`Could not end the music in channel ${session.channelId} cleanly`, error);
      }
    });
  }

  /** Ends a session: the bot leaves, Lavalink lets go of the audio, and the channel is told why. */
  private async finish(session: MusicSession, reason: EndReason): Promise<void> {
    if (session.state === 'ended') return;
    const { log, queue, client, channels } = this.deps;
    const { bot, guildId, channelId } = session;

    session.state = 'ended';
    if (this.sessions.get(channelId) === session) this.sessions.delete(channelId);
    if (this.busy.get(busyKey(bot, guildId)) === session) this.busy.delete(busyKey(bot, guildId));
    session.clearTimers();

    // Queued before anything is waited for: from here on the bot counts as free, and whatever
    // sends it into a channel next must not overtake its way out of this one.
    const departure = queue.run(voiceKey(bot, guildId), async () => {
      if (reason.kind !== 'lavalink') {
        // Lavalink first, so that nothing is left streaming into a connection nobody owns.
        try {
          await bot.node.destroyPlayer(guildId);
        } catch (error) {
          log.debug(`Could not remove the player of ${bot.name} for guild ${guildId}`, error);
        }
      }
      await bot.voice.leave(guildId);
    });
    await departure.catch((error: unknown) => log.warn(`${bot.name} could not leave channel ${channelId} cleanly`, error));

    const gone = reason.kind === 'channelDeleted' || reason.kind === 'guildGone';
    const channel = client.channels.cache.get(channelId);
    if (session.admitted && bot.userId && !gone && isVoiceChannel(channel)) {
      await channels
        .setGuest(channel, bot.userId, false, `${bot.name} is done playing music`)
        .catch((error: unknown) => log.warn(`Could not take back the access of ${bot.name} to channel ${channelId}`, error));
    }
    if (!gone) await this.closePanel(session, this.describeEnd(session, reason));
    log.debug(`Music in channel ${channelId} of guild ${guildId} ended (${reason.kind})`);
  }

  private describeEnd(session: MusicSession, reason: EndReason): string {
    const bot = userMention(session.bot.userId ?? '0');
    switch (reason.kind) {
      case 'stopped':
        return `Stopped by ${userMention(reason.by)}.`;
      case 'idle':
        return `${bot} left after ${formatDuration(this.deps.tuning.musicIdleMs)} with nothing to play.`;
      case 'alone':
        return `${bot} left because nobody was listening any more.`;
      case 'disconnected':
        return `${bot} was disconnected from the channel.`;
      case 'moved':
        return `${bot} was moved to another channel. Run \`/music play\` there to carry on.`;
      case 'lavalink':
        return 'The connection to the music server was lost.';
      case 'voice':
        return 'The audio connection to Discord was lost.';
      default:
        return 'The music has stopped.';
    }
  }
}

function sessionKey(session: MusicSession): string {
  return `music:${session.channelId}`;
}

function panelKey(session: MusicSession): string {
  return `music-panel:${session.channelId}`;
}

function busyKey(bot: PlayerBot, guildId: string): string {
  return `${bot.index}:${guildId}`;
}

/** Serialises a bot's way into and out of voice channels in one server. */
function voiceKey(bot: PlayerBot, guildId: string): string {
  return `music-voice:${bot.index}:${guildId}`;
}

function isTrack(value: unknown): value is Track {
  if (typeof value !== 'object' || value === null) return false;
  const track = value as Partial<Track>;
  return typeof track.encoded === 'string' && typeof track.info === 'object' && track.info !== null;
}

function countOf(count: number, noun: string): string {
  return count === 1 ? `1 ${noun}` : `${count} ${noun}s`;
}

/** Whether a member may be shown invite links for the helper bots. */
export function mayManageBots(member: GuildMember): boolean {
  return member.permissions.has(PermissionFlagsBits.ManageGuild);
}
