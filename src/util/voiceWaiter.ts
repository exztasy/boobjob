/**
 * Lets code wait until the cached voice state of a member reflects a change
 * it has just made.
 *
 * Moving, muting or deafening someone goes through the REST API, but the
 * cache of who is where only changes when the gateway reports it a moment
 * later. Deciding the next step from the cache in between means deciding from
 * a state that is already out of date.
 */
export class VoiceStateWaiter {
  private readonly checks = new Map<string, Set<() => void>>();

  /** To be called for every voice state update, before anything acts on it. */
  notify(guildId: string, userId: string): void {
    for (const check of [...(this.checks.get(key(guildId, userId)) ?? [])]) check();
  }

  /**
   * Resolves as soon as `settled` holds, checking again whenever the member's
   * voice state changes, and after `timeoutMs` at the latest: a lost gateway
   * event must not hold things up for good.
   */
  until(guildId: string, userId: string, settled: () => boolean, timeoutMs: number): Promise<void> {
    if (settled()) return Promise.resolve();

    return new Promise((resolve) => {
      const id = key(guildId, userId);
      const checks = this.checks.get(id) ?? new Set();
      this.checks.set(id, checks);

      const finish = (): void => {
        clearTimeout(timer);
        checks.delete(check);
        if (checks.size === 0) this.checks.delete(id);
        resolve();
      };
      const check = (): void => {
        if (settled()) finish();
      };
      const timer = setTimeout(finish, timeoutMs);
      checks.add(check);
    });
  }
}

function key(guildId: string, userId: string): string {
  return `${guildId}:${userId}`;
}
