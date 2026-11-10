import { RESTJSONErrorCodes, type Guild, type VoiceChannel, type VoiceState } from 'discord.js';
import type { Logger } from '../logger.js';
import type { Sanction, Store } from '../storage/store.js';
import type { Tuning } from '../tuning.js';
import { hasApiCode } from '../util/discord.js';
import type { KeyedQueue } from '../util/keyedQueue.js';

export interface SanctionDeps {
  store: Store;
  queue: KeyedQueue;
  log: Logger;
  tuning: Tuning;
}

const REASON = 'Muted or deafened by the owner of a temporary voice channel';

/**
 * Mute and deafen for channel owners.
 *
 * Discord has no per-channel mute: muting or deafening someone is server-wide
 * and follows them into every other voice channel until somebody lifts it. So
 * this service treats a channel owner's mute as "muted while in my channel"
 * and takes care of the rest:
 *
 * - the server mute is applied when the member is in that channel and lifted
 *   the moment they move elsewhere (and applied again if they come back);
 * - if they disconnect instead, Discord no longer accepts changes, so the
 *   mute is lifted when they next join any voice channel;
 * - it only ever lifts what it applied itself, so a moderator's server mute
 *   is never undone by accident.
 */
export class SanctionService {
  private readonly waiters = new Map<string, Set<() => void>>();

  constructor(private readonly deps: SanctionDeps) {}

  /** Changes whether a member is muted/deafened in a channel and applies it right away. */
  async set(channel: VoiceChannel, userId: string, patch: Partial<Sanction>): Promise<void> {
    const { store } = this.deps;
    const before = store.getSanction(channel.id, userId);
    store.setSanction(channel.id, userId, patch);
    try {
      await this.sync(channel.guild, userId);
    } catch (error) {
      store.setSanction(channel.id, userId, before);
      throw error;
    }
  }

  /** Makes a member's server mute/deafen match the channel they are in right now. */
  sync(guild: Guild, userId: string): Promise<void> {
    return this.deps.queue.run(`voice:${guild.id}:${userId}`, () => this.syncNow(guild, userId));
  }

  /** Corrects everyone in a guild who might be out of step, e.g. after downtime. */
  async reconcileGuild(guild: Guild): Promise<void> {
    for (const userId of this.deps.store.listSanctionedUsers(guild.id)) {
      await this.sync(guild, userId).catch((error: unknown) =>
        this.deps.log.warn(`Could not correct the voice state of member ${userId} in guild ${guild.id}`, error),
      );
    }
  }

  handleVoiceStateUpdate(oldState: VoiceState, newState: VoiceState): void {
    const { store, log } = this.deps;
    const guild = newState.guild;
    const userId = newState.id;

    for (const check of [...(this.waiters.get(waiterKey(guild.id, userId)) ?? [])]) check();

    if (oldState.channelId !== newState.channelId) {
      if (newState.channelId) {
        this.sync(guild, userId).catch((error: unknown) =>
          log.warn(`Could not update the voice state of member ${userId} in guild ${guild.id}`, error),
        );
      }
      return;
    }
    if (!newState.channelId) return;

    // Same channel, but someone lifted a mute or deafen. We only ever lift ours after the
    // owner asked for it (by which time the sanction is gone), so if the channel still calls
    // for it, a moderator stepped in, and their decision stands.
    const unmuted = oldState.serverMute === true && newState.serverMute === false;
    const undeafened = oldState.serverDeaf === true && newState.serverDeaf === false;
    if (!unmuted && !undeafened) return;

    const wanted = store.getSanction(newState.channelId, userId);
    const overridden: Partial<Sanction> = {};
    if (unmuted && wanted.muted) overridden.muted = false;
    if (undeafened && wanted.deafened) overridden.deafened = false;
    if (overridden.muted === undefined && overridden.deafened === undefined) return;

    store.setSanction(newState.channelId, userId, overridden);
    store.setApplied(guild.id, userId, { ...store.getApplied(guild.id, userId), ...overridden });
    log.debug(`A moderator lifted a channel sanction on member ${userId} in channel ${newState.channelId}`);
  }

  private async syncNow(guild: Guild, userId: string): Promise<void> {
    const { store } = this.deps;
    const state = guild.voiceStates.cache.get(userId);
    // Discord rejects voice changes for members who are not connected; this runs again when they join.
    if (!state?.channelId) return;

    const wanted = store.getSanction(state.channelId, userId);
    const applied = store.getApplied(guild.id, userId);
    const mute = plan(wanted.muted, applied.muted, state.serverMute === true);
    const deafen = plan(wanted.deafened, applied.deafened, state.serverDeaf === true);

    // Recorded before the request so that the voice state event it causes is read correctly.
    store.setApplied(guild.id, userId, { muted: mute.ours, deafened: deafen.ours });
    if (mute.change === undefined && deafen.change === undefined) return;

    const patch = { mute: mute.change, deaf: deafen.change };
    try {
      await guild.members.edit(userId, { ...patch, reason: REASON });
    } catch (error) {
      // Still ours to sort out; the next sync tries again.
      store.setApplied(guild.id, userId, applied);
      if (hasApiCode(error, RESTJSONErrorCodes.TargetUserIsNotConnectedToVoice, RESTJSONErrorCodes.UnknownMember)) {
        return;
      }
      throw error;
    }
    await this.settled(guild, userId, patch);
  }

  /**
   * Waits until the cached voice state shows the change we just made. The
   * cache only updates when the gateway reports it, and deciding the next
   * change from a stale state would misjudge who muted whom.
   */
  private settled(guild: Guild, userId: string, patch: { mute?: boolean; deaf?: boolean }): Promise<void> {
    const matches = (): boolean => {
      const state = guild.voiceStates.cache.get(userId);
      if (!state?.channelId) return true;
      return (
        (patch.mute === undefined || state.serverMute === patch.mute) &&
        (patch.deaf === undefined || state.serverDeaf === patch.deaf)
      );
    };
    if (matches()) return Promise.resolve();

    return new Promise((resolve) => {
      const key = waiterKey(guild.id, userId);
      const checks = this.waiters.get(key) ?? new Set();
      this.waiters.set(key, checks);

      const finish = (): void => {
        clearTimeout(timer);
        checks.delete(check);
        if (checks.size === 0) this.waiters.delete(key);
        resolve();
      };
      const check = (): void => {
        if (matches()) finish();
      };
      const timer = setTimeout(finish, this.deps.tuning.voiceSettleMs);
      checks.add(check);
    });
  }
}

/**
 * Decides what to do about one flag (mute or deafen).
 *
 * @param wanted  the channel the member is in calls for it
 * @param ours    we applied the member's current server-wide flag
 * @param active  the member's server-wide flag is currently set
 */
function plan(wanted: boolean, ours: boolean, active: boolean): { change: boolean | undefined; ours: boolean } {
  if (wanted) {
    if (!active) return { change: true, ours: true };
    // Already set: either by us earlier, or by a moderator, in which case it is not ours to lift later.
    return { change: undefined, ours };
  }
  if (ours && active) return { change: false, ours: false };
  return { change: undefined, ours: false };
}

function waiterKey(guildId: string, userId: string): string {
  return `${guildId}:${userId}`;
}
