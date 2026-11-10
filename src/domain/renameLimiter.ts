/**
 * Discord only lets a channel be renamed a couple of times per ten minutes and
 * answers anything beyond that with a rate limit that can last the whole
 * window. This keeps count locally so we know in advance when a rename has to
 * wait, instead of finding out from a failed request.
 */
export class RenameLimiter {
  private readonly history = new Map<string, number[]>();
  private readonly blockedUntil = new Map<string, number>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Milliseconds until the channel can be renamed again; `0` if it can be renamed now. */
  retryAfter(channelId: string): number {
    const now = this.now();

    const recent = (this.history.get(channelId) ?? []).filter((at) => now - at < this.windowMs);
    if (recent.length > 0) this.history.set(channelId, recent);
    else this.history.delete(channelId);

    let wait = 0;
    const oldestCounted = recent[recent.length - this.limit];
    if (oldestCounted !== undefined) wait = oldestCounted + this.windowMs - now;

    const blockedUntil = this.blockedUntil.get(channelId);
    if (blockedUntil !== undefined) {
      if (blockedUntil > now) wait = Math.max(wait, blockedUntil - now);
      else this.blockedUntil.delete(channelId);
    }

    return Math.max(0, wait);
  }

  /** Notes that the channel was just renamed. */
  record(channelId: string): void {
    const renames = this.history.get(channelId) ?? [];
    renames.push(this.now());
    this.history.set(channelId, renames);
  }

  /** Notes that Discord itself refused a rename and said to wait this long. */
  block(channelId: string, forMs: number): void {
    this.blockedUntil.set(channelId, this.now() + forMs);
  }

  forget(channelId: string): void {
    this.history.delete(channelId);
    this.blockedUntil.delete(channelId);
  }
}
