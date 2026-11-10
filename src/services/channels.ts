import {
  ChannelType,
  RESTJSONErrorCodes,
  userMention,
  type CategoryChannel,
  type Channel,
  type Client,
  type Guild,
  type GuildBasedChannel,
  type GuildMember,
  type VoiceChannel,
} from 'discord.js';
import { buildOverwrites, type Overwrite } from '../domain/overwrites.js';
import { FALLBACK_CHANNEL_NAME, MAX_LIST_SIZE, defaultChannelName, resolveSettings } from '../domain/settings.js';
import { UserError } from '../errors.js';
import type { Logger } from '../logger.js';
import { REQUIRED_PERMISSIONS, missingPermissions } from '../permissions.js';
import type { AccessLists, Privacy, Store } from '../storage/store.js';
import type { Tuning } from '../tuning.js';
import { describeError, hasApiCode, humanCount, isVoiceChannel, sleep, voiceStatesIn } from '../util/discord.js';
import type { KeyedQueue } from '../util/keyedQueue.js';
import type { PanelService } from './panels.js';
import type { RenameService } from './renames.js';
import type { SanctionService } from './sanctions.js';

export interface ChannelDeps {
  client: Client;
  store: Store;
  queue: KeyedQueue;
  panels: PanelService;
  sanctions: SanctionService;
  renames: RenameService;
  log: Logger;
  tuning: Tuning;
}

interface OverwriteSubject extends AccessLists {
  ownerId: string;
  privacy: Privacy;
}

/** Creates, secures and removes the personal voice channels. */
export class ChannelService {
  /** When each member last had a channel created, to enforce the cooldown. */
  private readonly lastCreated = new Map<string, number>();
  /** Channels whose deletion is under way; they must not be handed back to their owner. */
  private readonly deleting = new Set<string>();
  private readonly lastFailureNotice = new Map<string, number>();

  constructor(private readonly deps: ChannelDeps) {}

  // ── joining a hub ───────────────────────────────────────────────────────

  /**
   * Gives a member who is sitting in a hub their channel. Safe to call any
   * number of times: calls for the same member run one at a time and each one
   * starts from where the member actually is by then.
   */
  handleHubJoin(member: GuildMember): Promise<void> {
    return this.deps.queue.run(`member:${member.guild.id}:${member.id}`, () => this.provide(member));
  }

  private async provide(member: GuildMember): Promise<void> {
    const { tuning } = this.deps;
    const guild = member.guild;
    let hub = this.hubOf(guild, member.id);
    if (!hub) return;

    // A member owns one channel at a time. If theirs is still in use, that is where they go.
    const existing = this.channelInUseOwnedBy(guild, member.id);
    if (existing) {
      try {
        await member.voice.setChannel(existing, 'Returning the owner to their voice channel');
        return;
      } catch (error) {
        if (hasApiCode(error, RESTJSONErrorCodes.TargetUserIsNotConnectedToVoice)) return;
        // The channel emptied and was removed while we were moving them: make a new one instead.
        if (!hasApiCode(error, RESTJSONErrorCodes.UnknownChannel)) throw error;
        this.forget(existing.id);
      }
    }

    const key = `${guild.id}:${member.id}`;
    const wait = (this.lastCreated.get(key) ?? 0) + tuning.createCooldownMs - Date.now();
    if (wait > 0) {
      await sleep(wait);
      hub = this.hubOf(guild, member.id);
      if (!hub) return;
    }
    this.lastCreated.set(key, Date.now());

    try {
      await this.create(member, hub);
    } catch (error) {
      await this.reportFailure(hub, member, error);
    }
  }

  private async create(member: GuildMember, hub: VoiceChannel): Promise<void> {
    const { store, log, panels } = this.deps;
    const guild = member.guild;
    const me = await this.me(guild);
    this.assertCanSecureChannels(me);

    const saved = store.getProfileAccess(guild.id, member.id);
    const access: AccessLists = {
      allowed: saved.allowed.slice(0, MAX_LIST_SIZE),
      blocked: saved.blocked.slice(0, MAX_LIST_SIZE),
    };
    const settings = resolveSettings(store.getProfile(guild.id, member.id), {
      displayName: member.displayName,
      hubBitrate: hub.bitrate,
      maxBitrate: guild.maximumBitrate,
    });

    const reason = `Temporary voice channel for ${member.user.tag}`;
    const fixed = {
      type: ChannelType.GuildVoice as const,
      parent: hub.parentId,
      permissionOverwrites: this.overwritesFor(guild, me, hub.parent, {
        ownerId: member.id,
        privacy: settings.privacy,
        ...access,
      }),
      reason,
    };
    // Something a member saved earlier can stop being acceptable: a name the server now
    // filters, a region Discord retired, a bitrate above the current boost level. Getting
    // a channel matters more than any one setting, so fall back to plainer ones.
    const attempts = [
      {
        name: settings.name,
        userLimit: settings.userLimit,
        bitrate: settings.bitrate,
        videoQualityMode: settings.videoQuality,
        ...(settings.rtcRegion ? { rtcRegion: settings.rtcRegion } : {}),
      },
      { name: defaultChannelName(member.displayName) },
      { name: FALLBACK_CHANNEL_NAME },
    ];

    let channel: VoiceChannel | undefined;
    for (const [index, attempt] of attempts.entries()) {
      try {
        channel = await guild.channels.create({ ...fixed, ...attempt });
        break;
      } catch (error) {
        const last = index === attempts.length - 1;
        if (last || !hasApiCode(error, RESTJSONErrorCodes.InvalidFormBodyOrContentType)) throw error;
        log.warn(`Discord rejected the saved settings of ${member.user.tag} in guild ${guild.id}; retrying with defaults`, error);
      }
    }
    if (!channel) return;

    store.createTempChannel(
      {
        channelId: channel.id,
        guildId: guild.id,
        hubId: hub.id,
        ownerId: member.id,
        privacy: settings.privacy,
        createdAt: Date.now(),
      },
      access,
    );

    // Only pull them out of the hub: if they wandered off meanwhile, leave them where they are.
    if (guild.voiceStates.cache.get(member.id)?.channelId !== hub.id) {
      await this.remove(channel, 'Owner left before the channel was ready');
      return;
    }
    try {
      await member.voice.setChannel(channel, reason);
    } catch (error) {
      await this.remove(channel, 'Could not move the owner into the channel');
      if (hasApiCode(error, RESTJSONErrorCodes.TargetUserIsNotConnectedToVoice)) return;
      throw error;
    }

    await panels
      .post(channel, { mentionOwner: true })
      .catch((error: unknown) => log.warn(`Could not post the control panel in channel ${channel.id}`, error));
  }

  private hubOf(guild: Guild, userId: string): VoiceChannel | null {
    const channelId = guild.voiceStates.cache.get(userId)?.channelId;
    if (!channelId || !this.deps.store.getHub(channelId)) return null;
    const channel = guild.channels.cache.get(channelId);
    return isVoiceChannel(channel) ? channel : null;
  }

  private channelInUseOwnedBy(guild: Guild, userId: string): VoiceChannel | null {
    const record = this.deps.store.getTempChannelByOwner(guild.id, userId);
    if (!record || this.deleting.has(record.channelId)) return null;
    const channel = guild.channels.cache.get(record.channelId);
    if (!isVoiceChannel(channel)) return null;
    // An empty one is about to be cleaned up; handing it back would race its deletion.
    return humanCount(guild, channel.id) > 0 ? channel : null;
  }

  private async reportFailure(hub: VoiceChannel, member: GuildMember, error: unknown): Promise<void> {
    const { log, tuning } = this.deps;
    log.error(`Could not create a voice channel for ${member.user.tag} in guild ${member.guild.id}`, error);

    const now = Date.now();
    if (now - (this.lastFailureNotice.get(hub.id) ?? 0) < tuning.failureNoticeCooldownMs) return;
    this.lastFailureNotice.set(hub.id, now);

    try {
      const notice = await hub.send({
        content: `${userMention(member.id)} I couldn't create your voice channel. ${explainCreateFailure(error)}`,
        allowedMentions: { parse: [], users: [member.id] },
      });
      setTimeout(() => void notice.delete().catch(() => undefined), tuning.failureNoticeTtlMs).unref();
    } catch {
      // Not being able to say so either leaves only the log.
    }
  }

  // ── permissions ─────────────────────────────────────────────────────────

  /** Rewrites a channel's permission overwrites from its current owner, privacy and access lists. */
  async applyOverwrites(channel: VoiceChannel, reason: string): Promise<void> {
    const { store } = this.deps;
    const record = store.getTempChannel(channel.id);
    if (!record) return;
    const me = await this.me(channel.guild);
    this.assertCanSecureChannels(me);

    const overwrites = this.overwritesFor(channel.guild, me, channel.parent, {
      ownerId: record.ownerId,
      privacy: record.privacy,
      ...store.getChannelAccess(channel.id),
    });
    await channel.permissionOverwrites.set(overwrites, reason);
  }

  private overwritesFor(
    guild: Guild,
    me: GuildMember,
    category: CategoryChannel | null,
    subject: OverwriteSubject,
  ): Overwrite[] {
    const base =
      category?.permissionOverwrites.cache.map((overwrite) => ({
        id: overwrite.id,
        type: overwrite.type,
        allow: overwrite.allow.bitfield,
        deny: overwrite.deny.bitfield,
      })) ?? [];

    return buildOverwrites({
      everyoneId: guild.id,
      botId: me.id,
      botPermissions: me.permissions.bitfield,
      base,
      ...subject,
    });
  }

  /**
   * Refuses to go on when the bot lacks a permission it needs server-wide.
   * Without View Channel and Connect, for instance, Discord would not let it
   * deny those to anyone, and a "private" channel would silently be public.
   */
  private assertCanSecureChannels(me: GuildMember): void {
    const missing = missingPermissions(me, REQUIRED_PERMISSIONS);
    if (missing.length > 0) {
      throw new UserError(
        `My role is missing these permissions: **${missing.join('**, **')}**. A server admin needs to grant them in Server Settings → Roles.`,
      );
    }
  }

  private async me(guild: Guild): Promise<GuildMember> {
    return guild.members.me ?? (await guild.members.fetchMe());
  }

  // ── leaving and clean-up ────────────────────────────────────────────────

  /** Someone left a channel: remove it if nobody is left. */
  handleLeave(guild: Guild, channelId: string): Promise<void> {
    return this.removeIfEmpty(guild, channelId, 0);
  }

  private removeIfEmpty(guild: Guild, channelId: string, minAgeMs: number): Promise<void> {
    return this.deps.queue.run(`channel:${channelId}`, async () => {
      const record = this.deps.store.getTempChannel(channelId);
      if (!record || Date.now() - record.createdAt < minAgeMs) return;
      const channel = guild.channels.cache.get(channelId);
      if (!isVoiceChannel(channel)) return;
      if (humanCount(guild, channelId) > 0) return;
      await this.remove(channel, 'Temporary voice channel is empty');
    });
  }

  private async remove(channel: VoiceChannel, reason: string): Promise<void> {
    this.deleting.add(channel.id);
    try {
      await channel.delete(reason);
    } catch (error) {
      if (!hasApiCode(error, RESTJSONErrorCodes.UnknownChannel)) {
        // Keep the record so the next sweep tries again.
        this.deleting.delete(channel.id);
        throw error;
      }
    }
    this.forget(channel.id);
  }

  /** Drops all state for a channel that is gone. */
  private forget(channelId: string): void {
    const { store, panels, renames } = this.deps;
    store.deleteTempChannel(channelId);
    panels.forget(channelId);
    renames.forget(channelId);
    this.deleting.delete(channelId);
  }

  handleChannelDelete(channel: Channel): void {
    const { store, log } = this.deps;
    if (store.removeHub(channel.id)) log.info(`Hub ${channel.id} was deleted and is no longer tracked`);
    if (store.getTempChannel(channel.id)) this.forget(channel.id);
  }

  // ── catching up ─────────────────────────────────────────────────────────

  /**
   * Brings a guild back in line with reality: after a restart, an outage or a
   * missed event there can be people waiting in a hub, empty channels left
   * behind, records of channels that are gone, and mutes that need lifting.
   */
  async reconcileGuild(guild: Guild): Promise<void> {
    const { store, log, sanctions, tuning } = this.deps;

    for (const hub of store.listHubs(guild.id)) {
      const channel = await this.resolve(guild, hub.channelId);
      if (channel === null) {
        store.removeHub(hub.channelId);
        continue;
      }
      if (!isVoiceChannel(channel)) continue;
      for (const state of voiceStatesIn(guild, channel.id)) {
        const member = state.member;
        if (!member || member.user.bot) continue;
        this.handleHubJoin(member).catch((error: unknown) =>
          log.error(`Could not give ${member.user.tag} a channel in guild ${guild.id}`, error),
        );
      }
    }

    for (const record of store.listTempChannels(guild.id)) {
      const channel = await this.resolve(guild, record.channelId);
      if (channel === null) {
        this.forget(record.channelId);
        continue;
      }
      if (!channel) continue;
      await this.removeIfEmpty(guild, record.channelId, tuning.emptyGraceMs).catch((error: unknown) =>
        log.warn(`Could not remove the empty channel ${record.channelId} in guild ${guild.id}`, error),
      );
    }

    await sanctions.reconcileGuild(guild);
  }

  /** Reconciles every guild and trims bookkeeping that is no longer needed. */
  async sweep(): Promise<void> {
    const { client, log, tuning } = this.deps;
    const now = Date.now();
    for (const [key, at] of this.lastCreated) {
      if (now - at > tuning.createCooldownMs) this.lastCreated.delete(key);
    }
    for (const [hubId, at] of this.lastFailureNotice) {
      if (now - at > tuning.failureNoticeCooldownMs) this.lastFailureNotice.delete(hubId);
    }
    for (const guild of client.guilds.cache.values()) {
      if (!guild.available) continue;
      await this.reconcileGuild(guild).catch((error: unknown) => log.error(`Could not reconcile guild ${guild.id}`, error));
    }
  }

  /** The channel, `null` if Discord confirms it no longer exists, `undefined` if we could not tell. */
  private async resolve(guild: Guild, channelId: string): Promise<GuildBasedChannel | null | undefined> {
    const cached = guild.channels.cache.get(channelId);
    if (cached) return cached;
    try {
      return await guild.channels.fetch(channelId);
    } catch (error) {
      if (hasApiCode(error, RESTJSONErrorCodes.UnknownChannel)) return null;
      this.deps.log.warn(`Could not look up channel ${channelId} in guild ${guild.id}`, error);
      return undefined;
    }
  }
}

function explainCreateFailure(error: unknown): string {
  if (error instanceof UserError) return error.message;
  if (hasApiCode(error, RESTJSONErrorCodes.MaximumNumberOfGuildChannelsReached)) {
    return 'This server has reached the maximum number of channels.';
  }
  if (hasApiCode(error, RESTJSONErrorCodes.InvalidFormBodyOrContentType)) {
    return 'Discord rejected the new channel. The category may be full (a category holds at most 50 channels).';
  }
  return describeError(error);
}
