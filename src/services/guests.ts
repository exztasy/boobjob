/**
 * Bots of ours that are at work in a personal channel, such as a music bot
 * playing there. They have to get in whatever the channel's privacy says,
 * for exactly as long as they are needed.
 */
export class GuestList {
  private readonly byChannel = new Map<string, Set<string>>();

  /** Returns whether this changed anything. */
  add(channelId: string, userId: string): boolean {
    const guests = this.byChannel.get(channelId) ?? new Set<string>();
    this.byChannel.set(channelId, guests);
    if (guests.has(userId)) return false;
    guests.add(userId);
    return true;
  }

  /** Returns whether this changed anything. */
  remove(channelId: string, userId: string): boolean {
    const guests = this.byChannel.get(channelId);
    if (!guests?.delete(userId)) return false;
    if (guests.size === 0) this.byChannel.delete(channelId);
    return true;
  }

  of(channelId: string): string[] {
    return [...(this.byChannel.get(channelId) ?? [])];
  }

  forget(channelId: string): void {
    this.byChannel.delete(channelId);
  }
}
