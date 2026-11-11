import {
  PermissionFlagsBits,
  RESTJSONErrorCodes,
  channelMention,
  escapeMarkdown,
  userMention,
  type Guild,
  type GuildMember,
  type VoiceChannel,
} from 'discord.js';
import {
  MAX_LIST_SIZE,
  MAX_USER_LIMIT,
  MIN_BITRATE,
  defaultChannelName,
  formatVideoQuality,
  isVideoQuality,
  sanitizeName,
} from '../domain/settings.js';
import { UserError } from '../errors.js';
import type { Logger } from '../logger.js';
import { PRIVACY_MODES, type AccessKind, type Privacy, type Store, type TempChannel } from '../storage/store.js';
import { PRIVACY_INFO } from '../ui/panel.js';
import type { SanctionKind } from '../ui/prompts.js';
import { hasApiCode, humanCount, isVoiceChannel, relativeTime } from '../util/discord.js';
import type { KeyedQueue } from '../util/keyedQueue.js';
import type { ChannelService } from './channels.js';
import type { PanelService } from './panels.js';
import type { RegionService } from './regions.js';
import type { RenameService } from './renames.js';
import type { SanctionService } from './sanctions.js';

export interface ActionDeps {
  store: Store;
  queue: KeyedQueue;
  channels: ChannelService;
  panels: PanelService;
  sanctions: SanctionService;
  renames: RenameService;
  regions: RegionService;
  log: Logger;
}

/**
 * Everything an owner can do to their channel. Each action checks that the
 * person asking may do it, applies the change to the live channel, saves it
 * to the owner's profile so it comes back next time, and returns a sentence
 * describing what happened. Problems are thrown as `UserError`.
 */
export class ActionService {
  constructor(private readonly deps: ActionDeps) {}

  /** The owner runs their channel; so can anyone who could manage the channel in Discord itself. */
  isManager(record: TempChannel, actor: GuildMember, channel: VoiceChannel): boolean {
    return record.ownerId === actor.id || actor.permissionsIn(channel).has(PermissionFlagsBits.ManageChannels);
  }

  // ── channel settings ────────────────────────────────────────────────────

  /** Renames the channel. An empty name goes back to the default one. */
  async rename(channel: VoiceChannel, actor: GuildMember, input: string | null): Promise<string> {
    return this.change(channel, actor, async (record) => {
      const { store, renames } = this.deps;
      const custom = input ? sanitizeName(input) : null;
      const name = custom ?? defaultChannelName(await this.displayName(channel.guild, record.ownerId));
      const shown = `**${escapeMarkdown(name)}**`;

      const outcome = await renames.request(channel, name, `Renamed by ${actor.user.tag}`);
      store.updateProfile(record.guildId, record.ownerId, { name: custom });

      switch (outcome.status) {
        case 'renamed':
          return custom ? `✏️ Renamed the channel to ${shown}.` : `✏️ Back to the default name, ${shown}.`;
        case 'unchanged':
          return `✏️ The channel is already called ${shown}.`;
        case 'deferred':
          return `⏳ Discord only allows two renames per channel every 10 minutes. ${shown} is saved, and this channel will be renamed ${relativeTime(outcome.at)}.`;
      }
    });
  }

  /** Sets how many people fit in the channel; `0` removes the limit. */
  async setUserLimit(channel: VoiceChannel, actor: GuildMember, limit: number): Promise<string> {
    if (!Number.isInteger(limit) || limit < 0 || limit > MAX_USER_LIMIT) {
      throw new UserError(`The user limit has to be a number from 1 to ${MAX_USER_LIMIT}, or 0 for no limit.`);
    }
    return this.change(channel, actor, async (record) => {
      if (channel.userLimit !== limit) await channel.setUserLimit(limit, `User limit set by ${actor.user.tag}`);
      this.deps.store.updateProfile(record.guildId, record.ownerId, { userLimit: limit });
      return limit === 0 ? '👥 Removed the user limit.' : `👥 User limit set to **${limit}**.`;
    });
  }

  async setBitrate(channel: VoiceChannel, actor: GuildMember, kbps: number): Promise<string> {
    const bitrate = kbps * 1000;
    const max = channel.guild.maximumBitrate;
    if (!Number.isInteger(kbps) || bitrate < MIN_BITRATE || bitrate > max) {
      throw new UserError(
        `The bitrate has to be between ${MIN_BITRATE / 1000} and ${Math.floor(max / 1000)} kbps on this server.`,
      );
    }
    return this.change(channel, actor, async (record) => {
      if (channel.bitrate !== bitrate) await channel.setBitrate(bitrate, `Bitrate set by ${actor.user.tag}`);
      this.deps.store.updateProfile(record.guildId, record.ownerId, { bitrate });
      return `🎚️ Bitrate set to **${kbps} kbps**.`;
    });
  }

  /** Sets the voice region; `null` lets Discord choose. */
  async setRegion(channel: VoiceChannel, actor: GuildMember, regionId: string | null): Promise<string> {
    const { regions, store } = this.deps;
    let label = 'Automatic';
    if (regionId !== null) {
      const known = await regions.list();
      const match = known.find((region) => region.id === regionId);
      if (known.length > 0 && !match) throw new UserError("I don't know that voice region. Pick one from the list.");
      label = match?.name ?? regionId;
    }
    return this.change(channel, actor, async (record) => {
      if (channel.rtcRegion !== regionId) await channel.setRTCRegion(regionId, `Region set by ${actor.user.tag}`);
      store.updateProfile(record.guildId, record.ownerId, { rtcRegion: regionId });
      return `🌍 Voice region set to **${escapeMarkdown(label)}**.`;
    });
  }

  async setVideoQuality(channel: VoiceChannel, actor: GuildMember, mode: number): Promise<string> {
    if (!isVideoQuality(mode)) throw new UserError('Video quality is either Auto or 720p.');
    return this.change(channel, actor, async (record) => {
      if (channel.videoQualityMode !== mode) {
        await channel.setVideoQualityMode(mode, `Video quality set by ${actor.user.tag}`);
      }
      this.deps.store.updateProfile(record.guildId, record.ownerId, { videoQuality: mode });
      return `📹 Video quality set to **${formatVideoQuality(mode)}**.`;
    });
  }

  // ── privacy and access ──────────────────────────────────────────────────

  async setPrivacy(channel: VoiceChannel, actor: GuildMember, privacy: string): Promise<string> {
    if (!isPrivacy(privacy)) throw new UserError('Privacy is one of hidden, locked or public.');
    return this.change(channel, actor, async (record) => {
      const { store, channels } = this.deps;
      if (record.privacy !== privacy) {
        store.setPrivacy(channel.id, privacy);
        try {
          await channels.applyOverwrites(channel, `Privacy set to ${privacy} by ${actor.user.tag}`);
        } catch (error) {
          store.setPrivacy(channel.id, record.privacy);
          throw error;
        }
      }
      store.updateProfile(record.guildId, record.ownerId, { privacy });
      const info = PRIVACY_INFO[privacy];
      return `${info.emoji} Privacy set to **${info.label}**: ${info.summary}`;
    });
  }

  /**
   * Adds people to and removes people from the allow or block list. Someone
   * can only be on one of the two, so adding to one takes them off the other.
   */
  async updateAccess(
    channel: VoiceChannel,
    actor: GuildMember,
    kind: AccessKind,
    add: readonly string[],
    remove: readonly string[],
  ): Promise<string> {
    return this.change(channel, actor, async (record) => {
      const { store, channels, log } = this.deps;
      const guild = channel.guild;
      const before = store.getChannelAccess(channel.id);
      const current = kind === 'allow' ? before.allowed : before.blocked;
      const notes: string[] = [];

      const listName = kind === 'allow' ? 'allowed' : 'blocked';
      const protectedIds = new Set([record.ownerId, guild.client.user.id]);
      const requested = unique(add);
      if (requested.includes(record.ownerId)) {
        notes.push(kind === 'allow' ? 'The owner always has access.' : "The owner can't be blocked.");
      }
      if (requested.includes(guild.client.user.id)) {
        notes.push(kind === 'allow' ? 'I always have access.' : "I can't be blocked, I run this channel.");
      }
      const alreadyListed = requested.filter((id) => current.includes(id));
      if (alreadyListed.length > 0) notes.push(`${mentions(alreadyListed)} ${plural(alreadyListed, 'is', 'are')} already ${listName}.`);
      const notListed = unique(remove).filter((id) => !current.includes(id));
      if (notListed.length > 0) notes.push(`${mentions(notListed)} ${plural(notListed, 'is', 'are')} not ${listName}.`);

      let adding = requested.filter((id) => !protectedIds.has(id) && !current.includes(id));
      const removing = unique(remove).filter((id) => current.includes(id));

      const room = Math.max(MAX_LIST_SIZE - (current.length - removing.length), 0);
      if (adding.length > room) {
        notes.push(`The list holds ${MAX_LIST_SIZE} people at most, so ${mentions(adding.slice(room))} did not fit.`);
        adding = adding.slice(0, room);
      }

      if (adding.length > 0 || removing.length > 0) {
        store.changeChannelAccess(channel.id, kind, adding, removing);
        try {
          await channels.applyOverwrites(channel, `Access changed by ${actor.user.tag}`);
        } catch (error) {
          store.setChannelAccess(channel.id, before);
          throw error;
        }
        this.saveAccessToProfile(record, kind, adding, removing);
      }

      if (kind === 'block') {
        // Being blocked while inside means being shown out as well.
        for (const id of adding) {
          const state = guild.voiceStates.cache.get(id);
          if (state?.channelId !== channel.id) continue;
          await state
            .disconnect(`Blocked by ${actor.user.tag}`)
            .catch((error: unknown) => log.warn(`Could not disconnect blocked member ${id}`, error));
        }
      }

      const done: string[] = [];
      if (kind === 'allow') {
        if (adding.length > 0) done.push(`✅ ${mentions(adding)} can now see and join ${channelMention(channel.id)}.`);
        if (removing.length > 0) done.push(`Removed ${mentions(removing)} from the allowed list.`);
      } else {
        if (adding.length > 0) done.push(`🚫 Blocked ${mentions(adding)}.`);
        if (removing.length > 0) done.push(`Unblocked ${mentions(removing)}.`);
      }
      if (done.length === 0 && notes.length === 0) return 'Nothing to change.';
      return [...done, ...notes].join('\n');
    });
  }

  /** The owner's saved lists get the same change, as far as it fits. */
  private saveAccessToProfile(record: TempChannel, kind: AccessKind, adding: readonly string[], removing: readonly string[]): void {
    const { store } = this.deps;
    const saved = store.getProfileAccess(record.guildId, record.ownerId);
    const list = kind === 'allow' ? saved.allowed : saved.blocked;
    const room = Math.max(MAX_LIST_SIZE - list.filter((id) => !removing.includes(id)).length, 0);
    const fitting = adding.filter((id) => !list.includes(id)).slice(0, room);
    store.changeProfileAccess(record.guildId, record.ownerId, kind, fitting, removing);
  }

  // ── people in the channel ───────────────────────────────────────────────

  /** Disconnects people from the channel. */
  async kick(channel: VoiceChannel, actor: GuildMember, userIds: readonly string[]): Promise<string> {
    return this.change(channel, actor, async () => {
      const guild = channel.guild;
      const kicked: string[] = [];
      const notes: string[] = [];

      for (const id of unique(userIds)) {
        if (id === actor.id) {
          notes.push("You can't kick yourself. Just leave the channel.");
          continue;
        }
        const state = guild.voiceStates.cache.get(id);
        if (state?.channelId !== channel.id) {
          notes.push(`${userMention(id)} is not in the channel.`);
          continue;
        }
        try {
          await state.disconnect(`Kicked by ${actor.user.tag}`);
          kicked.push(id);
        } catch (error) {
          if (!hasApiCode(error, RESTJSONErrorCodes.TargetUserIsNotConnectedToVoice)) throw error;
          notes.push(`${userMention(id)} had already left.`);
        }
      }

      const done = kicked.length > 0 ? [`👢 Kicked ${mentions(kicked)}.`] : [];
      if (done.length === 0 && notes.length === 0) return 'Nobody to kick.';
      return [...done, ...notes].join('\n');
    });
  }

  /**
   * Mutes or deafens people (`add`) and undoes it (`remove`). It applies only
   * while they are in this channel.
   */
  async setSanctions(
    channel: VoiceChannel,
    actor: GuildMember,
    kind: SanctionKind,
    add: readonly string[],
    remove: readonly string[],
  ): Promise<string> {
    return this.change(channel, actor, async () => {
      const { store, sanctions } = this.deps;
      const guild = channel.guild;
      const flag = kind === 'mute' ? 'muted' : 'deafened';
      const applied: string[] = [];
      const lifted: string[] = [];
      const notes: string[] = [];

      for (const id of unique(remove)) {
        if (!store.getSanction(channel.id, id)[flag]) {
          notes.push(`${userMention(id)} is not ${flag} in this channel.`);
          continue;
        }
        await sanctions.set(channel, id, { [flag]: false });
        lifted.push(id);
      }

      for (const id of unique(add)) {
        if (id === actor.id) {
          notes.push(`You can't ${kind} yourself here. Use your own ${kind} button instead.`);
          continue;
        }
        if (store.getSanction(channel.id, id)[flag]) {
          notes.push(`${userMention(id)} is already ${flag}.`);
          continue;
        }
        const state = guild.voiceStates.cache.get(id);
        if (state?.channelId !== channel.id) {
          notes.push(`${userMention(id)} is not in the channel.`);
          continue;
        }
        const alreadyByModerator =
          (kind === 'mute' ? state.serverMute : state.serverDeaf) === true && !store.getApplied(guild.id, id)[flag];
        await sanctions.set(channel, id, { [flag]: true });
        applied.push(id);
        if (alreadyByModerator) {
          notes.push(`${userMention(id)} was already server-${flag} by a moderator, and I will leave that in place.`);
        }
      }

      const done: string[] = [];
      if (applied.length > 0) done.push(`${kind === 'mute' ? '🔇 Muted' : '🙉 Deafened'} ${mentions(applied)}.`);
      if (lifted.length > 0) done.push(`${kind === 'mute' ? '🔊 Unmuted' : '👂 Undeafened'} ${mentions(lifted)}.`);
      if (done.length === 0 && notes.length === 0) return 'Nothing to change.';
      return [...done, ...notes].join('\n');
    });
  }

  // ── ownership ───────────────────────────────────────────────────────────

  /** Hands the channel to someone else who is in it. */
  async transfer(channel: VoiceChannel, actor: GuildMember, targetId: string): Promise<string> {
    return this.change(channel, actor, async (record) => {
      const guild = channel.guild;
      if (targetId === record.ownerId) throw new UserError(`${userMention(targetId)} already owns this channel.`);
      const state = guild.voiceStates.cache.get(targetId);
      if (state?.channelId !== channel.id) {
        throw new UserError(`${userMention(targetId)} has to be in the channel to take it over.`);
      }
      if (state.member?.user.bot) throw new UserError("A bot can't own a channel.");

      await this.handOver(channel, record, targetId, `Ownership transferred by ${actor.user.tag}`);
      return `👑 ${userMention(targetId)} now owns ${channelMention(channel.id)}.`;
    });
  }

  /** Lets someone in the channel take it over once the owner has left. */
  async claim(channel: VoiceChannel, actor: GuildMember): Promise<string> {
    return this.deps.queue.run(`channel:${channel.id}`, async () => {
      const record = this.requireRecord(channel);
      const guild = channel.guild;
      if (record.ownerId === actor.id) throw new UserError('You already own this channel.');
      if (actor.user.bot) throw new UserError("A bot can't own a channel.");
      if (guild.voiceStates.cache.get(actor.id)?.channelId !== channel.id) {
        throw new UserError('Join the channel first, then claim it.');
      }
      if (guild.voiceStates.cache.get(record.ownerId)?.channelId === channel.id) {
        throw new UserError(
          `${userMention(record.ownerId)} is still here, so the channel stays theirs. They can transfer it to you.`,
        );
      }

      await this.handOver(channel, record, actor.id, `Claimed by ${actor.user.tag}`);
      this.deps.panels.schedule(channel.id);
      return `👑 You now own ${channelMention(channel.id)}.`;
    });
  }

  private async handOver(channel: VoiceChannel, record: TempChannel, newOwnerId: string, reason: string): Promise<void> {
    const { store, channels, sanctions, log } = this.deps;
    const guild = channel.guild;

    const other = store.getTempChannelByOwner(record.guildId, newOwnerId);
    if (other && other.channelId !== channel.id) {
      const otherChannel = guild.channels.cache.get(other.channelId);
      if (isVoiceChannel(otherChannel) && humanCount(guild, otherChannel.id) > 0) {
        throw new UserError(
          `${userMention(newOwnerId)} already owns ${channelMention(other.channelId)}, and one channel per person is the limit.`,
        );
      }
    }

    const before = store.getChannelAccess(channel.id);
    const stillFits = before.allowed.filter((id) => id !== newOwnerId).length < MAX_LIST_SIZE;
    const keepPreviousOwner = stillFits && !before.blocked.includes(record.ownerId);

    store.transferOwnership(channel.id, newOwnerId, keepPreviousOwner);
    try {
      await channels.applyOverwrites(channel, reason);
    } catch (error) {
      store.transferOwnership(channel.id, record.ownerId, false);
      store.setChannelAccess(channel.id, before);
      throw error;
    }

    // Nobody should be stuck muted or deafened in a channel they now run.
    await sanctions
      .set(channel, newOwnerId, { muted: false, deafened: false })
      .catch((error: unknown) => log.warn(`Could not clear the sanctions of new owner ${newOwnerId}`, error));

    await channel
      .send({
        content: `👑 ${userMention(newOwnerId)} now owns this channel.`,
        allowedMentions: { parse: [], users: [newOwnerId] },
      })
      .catch(() => undefined);
  }

  // ── panel ───────────────────────────────────────────────────────────────

  /** Posts a fresh control panel, for when the old one was deleted or has scrolled away. */
  async repostPanel(channel: VoiceChannel, actor: GuildMember): Promise<string> {
    const record = this.requireRecord(channel);
    this.requireManager(record, actor, channel);
    await this.deps.panels.post(channel, { mentionOwner: false });
    return `📋 Posted a fresh control panel in ${channelMention(channel.id)}.`;
  }

  // ── plumbing ────────────────────────────────────────────────────────────

  /**
   * Runs a change to a channel. Changes to the same channel run one at a
   * time, so each one sees the result of the one before, and the control
   * panel is refreshed afterwards.
   */
  private change<T>(channel: VoiceChannel, actor: GuildMember, work: (record: TempChannel) => Promise<T>): Promise<T> {
    return this.deps.queue.run(`channel:${channel.id}`, async () => {
      const record = this.requireRecord(channel);
      this.requireManager(record, actor, channel);
      try {
        return await work(record);
      } finally {
        this.deps.panels.schedule(channel.id);
      }
    });
  }

  private requireRecord(channel: VoiceChannel): TempChannel {
    const record = this.deps.store.getTempChannel(channel.id);
    if (!record) throw new UserError('This is not a temporary voice channel that I manage.');
    return record;
  }

  private requireManager(record: TempChannel, actor: GuildMember, channel: VoiceChannel): void {
    if (!this.isManager(record, actor, channel)) {
      throw new UserError(`Only the owner of this channel, ${userMention(record.ownerId)}, can do that.`);
    }
  }

  private async displayName(guild: Guild, userId: string): Promise<string> {
    const member = guild.members.cache.get(userId) ?? (await guild.members.fetch(userId).catch(() => null));
    return member?.displayName ?? '';
  }
}

function isPrivacy(value: string): value is Privacy {
  return (PRIVACY_MODES as readonly string[]).includes(value);
}

function unique(ids: readonly string[]): string[] {
  return [...new Set(ids)];
}

function mentions(ids: readonly string[]): string {
  return ids.map((id) => userMention(id)).join(', ');
}

function plural(items: readonly unknown[], one: string, many: string): string {
  return items.length === 1 ? one : many;
}
