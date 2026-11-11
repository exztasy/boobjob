import { RateLimitError, type VoiceChannel } from 'discord.js';
import type { RenameLimiter } from '../domain/renameLimiter.js';
import type { Logger } from '../logger.js';
import { isVoiceChannel } from '../util/discord.js';

export type RenameOutcome =
  | { status: 'renamed' | 'unchanged' }
  /** Discord's rename limit is in the way; the name will be applied at the given time. */
  | { status: 'deferred'; at: number };

interface PendingRename {
  name: string;
  at: number;
  timer: NodeJS.Timeout;
}

/**
 * Renames channels without ever leaving a request hanging on Discord's rename
 * limit: a rename that has to wait is scheduled and applied once the limit clears.
 */
export class RenameService {
  private readonly pending = new Map<string, PendingRename>();
  /** Called after a deferred rename has gone through. */
  onApplied: (channelId: string) => void = () => undefined;

  constructor(
    private readonly limiter: RenameLimiter,
    private readonly log: Logger,
  ) {}

  async request(channel: VoiceChannel, name: string, reason: string): Promise<RenameOutcome> {
    this.cancel(channel.id);
    if (channel.name === name) return { status: 'unchanged' };

    let wait = this.limiter.retryAfter(channel.id);
    if (wait === 0) {
      try {
        await channel.setName(name, reason);
        this.limiter.record(channel.id);
        return { status: 'renamed' };
      } catch (error) {
        // Our own count can be off (a restart, or someone renaming the channel by hand).
        if (!(error instanceof RateLimitError)) throw error;
        wait = Math.max(error.retryAfter, 1_000);
        this.limiter.block(channel.id, wait);
      }
    }
    return this.defer(channel, name, reason, wait);
  }

  /** The rename a channel is waiting for, if any. */
  pendingFor(channelId: string): { name: string; at: number } | null {
    const pending = this.pending.get(channelId);
    return pending ? { name: pending.name, at: pending.at } : null;
  }

  /** Drops everything known about a channel that no longer exists. */
  forget(channelId: string): void {
    this.cancel(channelId);
    this.limiter.forget(channelId);
  }

  /** Cancels all scheduled renames, for shutdown. */
  stop(): void {
    for (const channelId of [...this.pending.keys()]) this.cancel(channelId);
  }

  private cancel(channelId: string): void {
    const pending = this.pending.get(channelId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(channelId);
  }

  private defer(channel: VoiceChannel, name: string, reason: string, wait: number): RenameOutcome {
    const at = Date.now() + wait;
    const timer = setTimeout(() => {
      this.pending.delete(channel.id);
      const current = channel.guild.channels.cache.get(channel.id);
      if (!isVoiceChannel(current)) return;
      this.request(current, name, reason).then(
        (outcome) => {
          if (outcome.status === 'renamed') this.onApplied(channel.id);
        },
        (error: unknown) => this.log.warn(`Could not apply the delayed rename of channel ${channel.id}`, error),
      );
    }, wait + 250);
    timer.unref();
    this.pending.set(channel.id, { name, at, timer });
    return { status: 'deferred', at };
  }
}
