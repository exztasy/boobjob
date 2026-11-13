import { Events, OAuth2Scopes, PermissionFlagsBits, type Client, type Guild } from 'discord.js';
import type { Logger } from '../logger.js';
import { permissionNames } from '../permissions.js';
import type { Tuning } from '../tuning.js';
import { voiceStatesIn } from '../util/discord.js';
import { LavalinkNode, type LavalinkAddress } from './lavalink/node.js';
import { LavalinkError, type PlayerEvent, type PlayerState, type VoiceServer } from './lavalink/protocol.js';
import { VoiceLink } from './voice.js';

/** What a bot needs in a voice channel in order to play there. */
export const PLAYER_PERMISSIONS = PermissionFlagsBits.ViewChannel | PermissionFlagsBits.Connect | PermissionFlagsBits.Speak;

const CLIENT_NAME = 'boobjob/1.0.0';

/** Why a bot cannot join a channel and play there. */
export interface Obstacle {
  /** Names of the permissions it lacks in that channel. */
  missing: string[];
  /** The channel is full and the bot may not squeeze in. */
  full: boolean;
}

export interface PlayerBotHandlers {
  nodeReady(bot: PlayerBot): void;
  nodeDown(bot: PlayerBot, reason: string, wasReady: boolean): void;
  playerEvent(bot: PlayerBot, event: PlayerEvent): void;
  playerState(bot: PlayerBot, guildId: string, state: PlayerState): void;
  voiceServerChanged(bot: PlayerBot, guildId: string, voice: VoiceServer): void;
  displaced(bot: PlayerBot, guildId: string, channelId: string | null): void;
}

export interface PlayerBotDeps {
  address: LavalinkAddress;
  tuning: Tuning;
  log: Logger;
}

/**
 * One bot account that can sit in a voice channel and play music: its
 * connection to Discord, and its own connection to Lavalink. A bot account
 * can be in one voice channel per server, which is why playing in several
 * channels at once takes several of these.
 */
export class PlayerBot {
  readonly voice: VoiceLink;
  /** Discord refused to let this bot log in; it stays out of the pool until a restart. */
  loginFailed = false;
  private lavalink: LavalinkNode | null = null;

  constructor(
    readonly client: Client,
    /** 0 is the main bot, the one people talk to. Helpers count from 1, in the order of their tokens. */
    readonly index: number,
    private readonly deps: PlayerBotDeps,
    private readonly handlers: PlayerBotHandlers,
  ) {
    const { tuning } = deps;
    this.voice = new VoiceLink(
      { joinTimeoutMs: tuning.voiceJoinTimeoutMs, leaveTimeoutMs: tuning.voiceSettleMs },
      {
        serverChanged: (guildId, voice) => handlers.voiceServerChanged(this, guildId, voice),
        displaced: (guildId, channelId) => handlers.displaced(this, guildId, channelId),
      },
    );

    client.once(Events.ClientReady, (ready) => {
      // Servers that arrived while the bot was starting up: Discord takes no voice requests
      // before this point, so a channel left over from before a restart is left only now.
      for (const guild of ready.guilds.cache.values()) {
        if (guild.available) this.voice.reconcile(guild);
      }
      this.connectToLavalink(ready.user.id);
    });
    // A server that comes back after an outage: the bot's place in voice may have changed unseen.
    client.on(Events.GuildAvailable, (guild) => {
      if (client.isReady()) this.voice.reconcile(guild);
    });
  }

  get isMain(): boolean {
    return this.index === 0;
  }

  get userId(): string | null {
    return this.client.user?.id ?? null;
  }

  /** A name for logs and messages, whether or not the bot has logged in yet. */
  get name(): string {
    return this.client.user?.tag ?? (this.isMain ? 'the main bot' : `music bot #${this.index}`);
  }

  /** Logged in to Discord. */
  get online(): boolean {
    return this.client.isReady();
  }

  /** Logged in to Discord and connected to Lavalink: ready to be given a channel. */
  get usable(): boolean {
    return this.online && this.lavalink?.ready === true;
  }

  get node(): LavalinkNode {
    if (!this.lavalink) throw new LavalinkError(0, 'not connected to the music server');
    return this.lavalink;
  }

  /** The server as this bot sees it, if it is a member. */
  guild(guildId: string): Guild | null {
    const guild = this.client.guilds.cache.get(guildId);
    return guild?.available ? guild : null;
  }

  /**
   * What keeps this bot from playing in a channel, judged by what the bot
   * itself can see of it; `null` if it can simply walk in.
   */
  obstacle(guildId: string, channelId: string): Obstacle | null {
    const guild = this.guild(guildId);
    const me = guild?.members.me;
    const channel = guild?.channels.cache.get(channelId);
    // A channel the bot may not see might not even be known to it.
    if (!guild || !me || !channel?.isVoiceBased()) return { missing: permissionNames(PLAYER_PERMISSIONS), full: false };

    const permissions = channel.permissionsFor(me);
    const missing = permissionNames(PLAYER_PERMISSIONS & ~permissions.bitfield);
    if (missing.length > 0) return { missing, full: false };

    // Members who may move others are let into a full channel.
    const others = voiceStatesIn(guild, channelId).filter((state) => state.id !== me.id).length;
    const full = channel.userLimit > 0 && others >= channel.userLimit && !permissions.has(PermissionFlagsBits.MoveMembers);
    return full ? { missing: [], full } : null;
  }

  /** A link for adding this bot to a server with what it needs to play music. */
  inviteLink(): string | null {
    if (!this.client.isReady()) return null;
    return this.client.generateInvite({ scopes: [OAuth2Scopes.Bot], permissions: PLAYER_PERMISSIONS });
  }

  stop(): void {
    this.lavalink?.stop();
    this.voice.stop();
  }

  private connectToLavalink(userId: string): void {
    const { address, tuning } = this.deps;
    this.lavalink = new LavalinkNode(
      {
        address,
        userId,
        clientName: CLIENT_NAME,
        retryMs: tuning.lavalinkRetryMs,
        requestTimeoutMs: tuning.lavalinkRequestTimeoutMs,
        pingIntervalMs: tuning.lavalinkPingMs,
      },
      {
        ready: () => this.handlers.nodeReady(this),
        down: (reason, wasReady) => this.handlers.nodeDown(this, reason, wasReady),
        event: (event) => this.handlers.playerEvent(this, event),
        playerState: (guildId, state) => this.handlers.playerState(this, guildId, state),
      },
    );
    this.lavalink.start();
  }
}
