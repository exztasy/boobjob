import { GatewayOpcodes, type Guild } from 'discord.js';
import type { VoiceServer } from './lavalink/protocol.js';

/** Joining a voice channel did not work out. */
export class VoiceJoinError extends Error {
  override name = 'VoiceJoinError';
}

export interface VoiceHandlers {
  /** Discord moved an established connection to another voice server; Lavalink has to follow. */
  serverChanged(guildId: string, voice: VoiceServer): void;
  /**
   * The bot is no longer in the channel it was put in, and not by our doing:
   * someone disconnected it (`channelId` is `null`) or dragged it elsewhere.
   */
  displaced(guildId: string, channelId: string | null): void;
}

interface GatewayAdapter {
  sendPayload(payload: unknown): boolean;
  destroy(): void;
}

interface Connection {
  guildId: string;
  channelId: string;
  adapter: GatewayAdapter;
  sessionId: string | null;
  server: { token: string; endpoint: string } | null;
  /** Present while the join is under way. */
  joining: { resolve: (voice: VoiceServer) => void; reject: (error: Error) => void } | null;
  /** Present while the leave is under way; called once Discord confirms it. */
  left: (() => void) | null;
}

/**
 * Puts one bot account into voice channels and takes it out again.
 *
 * A bot does not connect to voice by itself here. It asks Discord, over its
 * ordinary gateway connection, to be in a channel; Discord answers with a
 * session id (in a voice state update) and the address and token of a voice
 * server (in a voice server update). Those are handed to Lavalink, which makes
 * the actual audio connection. discord.js exposes exactly this exchange
 * through the adapter that its own voice library uses.
 */
export class VoiceLink {
  private readonly connections = new Map<string, Connection>();

  constructor(
    private readonly timings: { joinTimeoutMs: number; leaveTimeoutMs: number },
    private readonly handlers: VoiceHandlers,
  ) {}

  /**
   * Joins a voice channel and resolves with what Lavalink needs to connect.
   * Discord does not say no when the bot may not join; it just stays silent,
   * which is why this gives up after a while.
   */
  async join(guild: Guild, channelId: string): Promise<VoiceServer> {
    if (this.connections.has(guild.id)) {
      throw new VoiceJoinError(`already connected to a voice channel in guild ${guild.id}`);
    }

    const connection: Connection = {
      guildId: guild.id,
      channelId,
      adapter: { sendPayload: () => false, destroy: () => undefined },
      sessionId: null,
      server: null,
      joining: null,
      left: null,
    };
    connection.adapter = guild.voiceAdapterCreator({
      onVoiceStateUpdate: (data) => this.stateUpdate(connection, data.channel_id, data.session_id),
      onVoiceServerUpdate: (data) => this.serverUpdate(connection, data.token, data.endpoint),
      destroy: () => this.adapterGone(connection),
    });
    this.connections.set(guild.id, connection);

    let timer: NodeJS.Timeout | undefined;
    try {
      return await new Promise<VoiceServer>((resolve, reject) => {
        connection.joining = { resolve, reject };
        timer = setTimeout(
          () => reject(new VoiceJoinError(`Discord did not confirm the connection within ${this.timings.joinTimeoutMs} ms`)),
          this.timings.joinTimeoutMs,
        );
        if (!connection.adapter.sendPayload(voiceStateRequest(guild.id, channelId))) {
          reject(new VoiceJoinError('the connection to Discord is not ready'));
        }
      });
    } catch (error) {
      // Do not stay half-way in: if the request did get through after all, take it back.
      connection.joining = null;
      if (this.connections.get(guild.id) === connection) {
        connection.adapter.sendPayload(voiceStateRequest(guild.id, null));
        this.forget(connection);
      }
      throw error;
    } finally {
      clearTimeout(timer);
      connection.joining = null;
    }
  }

  /** Leaves the voice channel in a guild and waits, within reason, for Discord to confirm it. */
  async leave(guildId: string): Promise<void> {
    const connection = this.connections.get(guildId);
    if (!connection) return;

    let timer: NodeJS.Timeout | undefined;
    const confirmed = new Promise<void>((resolve) => {
      connection.left = resolve;
      timer = setTimeout(resolve, this.timings.leaveTimeoutMs);
    });
    // Without a working gateway connection there is nothing to wait for; Discord drops
    // the bot from voice by itself once it notices that the connection is gone.
    if (connection.adapter.sendPayload(voiceStateRequest(guildId, null))) await confirmed;
    clearTimeout(timer);
    connection.left = null;
    this.forget(connection);
  }

  /**
   * Squares what we believe with where Discord says the bot is. To be called
   * whenever a guild (re)appears: at startup, after an outage, and after the
   * gateway connection had to be set up afresh, which are the moments when
   * the bot's place in voice can have changed without us being told.
   */
  reconcile(guild: Guild): void {
    const actual = guild.members.me?.voice.channelId ?? null;
    const connection = this.connections.get(guild.id);

    if (!connection) {
      // Sitting in a channel we know nothing about: a leftover from before a restart.
      // Nothing is playing into it, and as long as the bot is there it looks busy.
      if (actual === null) return;
      const adapter = guild.voiceAdapterCreator({
        onVoiceStateUpdate: () => undefined,
        onVoiceServerUpdate: () => undefined,
        destroy: () => undefined,
      });
      adapter.sendPayload(voiceStateRequest(guild.id, null));
      adapter.destroy();
      return;
    }

    if (connection.joining || connection.left || actual === connection.channelId) return;
    if (actual === null) this.forget(connection);
    this.handlers.displaced(guild.id, actual);
  }

  /** Forgets every connection without telling Discord, for when the bot is shutting down anyway. */
  stop(): void {
    for (const connection of [...this.connections.values()]) {
      connection.joining?.reject(new VoiceJoinError('the bot is shutting down'));
      connection.left?.();
      this.forget(connection);
    }
  }

  // ── what Discord reports ────────────────────────────────────────────────

  private stateUpdate(connection: Connection, channelId: string | null, sessionId: string): void {
    if (this.connections.get(connection.guildId) !== connection) return;

    if (connection.left) {
      if (channelId === null) connection.left();
      return;
    }
    if (connection.joining) {
      // "Not in a channel" while joining is the echo of an earlier leave, not an answer to this join.
      if (channelId === null) return;
      if (channelId !== connection.channelId) {
        connection.joining.reject(new VoiceJoinError('the bot was moved to another channel while joining'));
        return;
      }
      connection.sessionId = sessionId;
      this.offer(connection);
      return;
    }

    if (channelId !== connection.channelId) {
      // Out of the channel for good, or sitting in the wrong one: either way the owner
      // of this connection decides what happens next, and `leave` still works for the latter.
      if (channelId === null) this.forget(connection);
      this.handlers.displaced(connection.guildId, channelId);
      return;
    }
    if (sessionId !== connection.sessionId) {
      connection.sessionId = sessionId;
      this.offer(connection);
    }
  }

  private serverUpdate(connection: Connection, token: string, endpoint: string | null): void {
    if (this.connections.get(connection.guildId) !== connection || connection.left) return;
    // No endpoint means the voice server went away and Discord is allocating another one;
    // a second update with the new address follows.
    connection.server = endpoint ? { token, endpoint } : null;
    this.offer(connection);
  }

  /** discord.js discards the adapter when the guild or the whole gateway connection is gone. */
  private adapterGone(connection: Connection): void {
    if (this.connections.get(connection.guildId) !== connection) return;
    this.forget(connection);
    if (connection.left) connection.left();
    else if (connection.joining) connection.joining.reject(new VoiceJoinError('the connection to Discord was lost'));
    else this.handlers.displaced(connection.guildId, null);
  }

  /** Passes the connection details on once both halves of them are known. */
  private offer(connection: Connection): void {
    if (!connection.sessionId || !connection.server) return;
    const voice: VoiceServer = {
      token: connection.server.token,
      endpoint: connection.server.endpoint,
      sessionId: connection.sessionId,
      channelId: connection.channelId,
    };
    if (connection.joining) connection.joining.resolve(voice);
    else this.handlers.serverChanged(connection.guildId, voice);
  }

  private forget(connection: Connection): void {
    if (this.connections.get(connection.guildId) === connection) this.connections.delete(connection.guildId);
    connection.adapter.destroy();
  }
}

function voiceStateRequest(guildId: string, channelId: string | null): unknown {
  return {
    op: GatewayOpcodes.VoiceStateUpdate,
    // Deafened, because the bot only ever sends audio: it tells people that it is not
    // listening, and saves Discord from sending it everyone's voice.
    d: { guild_id: guildId, channel_id: channelId, self_mute: false, self_deaf: channelId !== null },
  };
}
