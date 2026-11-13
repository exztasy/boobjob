import type { Track } from './lavalink/protocol.js';

/** More than anyone will listen to in one sitting, and few enough to keep in memory without a thought. */
export const MAX_QUEUE_LENGTH = 500;

export const LOOP_MODES = ['off', 'track', 'queue'] as const;
export type LoopMode = (typeof LOOP_MODES)[number];

export interface QueueItem {
  track: Track;
  /** Who asked for it. */
  requesterId: string;
}

/**
 * How a track came to its end: it played through, someone skipped it, or it
 * could not be played.
 */
export type Ending = 'finished' | 'skipped' | 'failed';

/** The tracks waiting for their turn in one voice channel. */
export class TrackQueue {
  private items: QueueItem[] = [];
  loop: LoopMode = 'off';

  constructor(private readonly random: () => number = Math.random) {}

  get length(): number {
    return this.items.length;
  }

  /** The waiting tracks, next one first. */
  get upcoming(): readonly QueueItem[] {
    return this.items;
  }

  /** Appends as many of the tracks as there is room for and says how many that was. */
  add(items: readonly QueueItem[]): number {
    const accepted = items.slice(0, Math.max(0, MAX_QUEUE_LENGTH - this.items.length));
    this.items.push(...accepted);
    return accepted.length;
  }

  /**
   * Picks what to play once `current` has ended, taking it out of the queue.
   *
   * Looping a track repeats it only when it played through: skipping is how
   * people get out of the loop, and a track that cannot be played would fail
   * forever. Looping the queue puts a track back at the end unless it failed.
   */
  next(current: QueueItem | null, ending: Ending): QueueItem | null {
    if (current) {
      if (this.loop === 'track' && ending === 'finished') return current;
      if (this.loop === 'queue' && ending !== 'failed') this.items.push(current);
    }
    return this.items.shift() ?? null;
  }

  shuffle(): void {
    for (let index = this.items.length - 1; index > 0; index--) {
      const other = Math.floor(this.random() * (index + 1));
      [this.items[index], this.items[other]] = [this.items[other]!, this.items[index]!];
    }
  }

  /** Takes out the track at a position, counting from 1 for the next one up. */
  remove(position: number): QueueItem | null {
    if (!Number.isInteger(position) || position < 1 || position > this.items.length) return null;
    return this.items.splice(position - 1, 1)[0] ?? null;
  }

  clear(): void {
    this.items = [];
  }

  /** Total playing time of the waiting tracks in milliseconds. Live streams have no length and count as nothing. */
  get duration(): number {
    return this.items.reduce((total, item) => total + playableLength(item.track), 0);
  }
}

export function playableLength(track: Track): number {
  const { isStream, length } = track.info;
  return isStream || !Number.isFinite(length) || length < 0 ? 0 : length;
}
