import { UserError } from '../errors.js';
import type { PlayerBot } from './playerBot.js';
import { TrackQueue, type QueueItem } from './queue.js';

/** The track a session is playing at the moment. */
export interface NowPlaying {
  item: QueueItem;
  /**
   * Travels to Lavalink with the track and comes back with every event about
   * it, which is how an event about a track we have already moved on from is
   * told apart from one about the current track, even if it is the same song.
   */
  playId: number;
  /**
   * Set once Lavalink reports an error for the track: why it could not be
   * played. The track's end is reported separately, and with this set it was
   * not a normal ending.
   */
  failure: string | null;
}

/** Why the music in a channel came to an end. */
export type EndReason =
  | { kind: 'stopped'; by: string }
  | { kind: 'idle' }
  | { kind: 'alone' }
  | { kind: 'disconnected' }
  | { kind: 'moved' }
  | { kind: 'lavalink' }
  | { kind: 'voice' }
  | { kind: 'channelDeleted' }
  | { kind: 'guildGone' }
  | { kind: 'failed' };

/** Thrown at whatever was still waiting to act on a session when it ended. */
export class SessionEndedError extends UserError {
  constructor() {
    super('The music stopped just now. Run `/music play` to start it again.');
  }
}

/**
 * Music in one voice channel: the bot that plays it, what is playing and
 * what comes next. It lasts from the first `/music play` in the channel until
 * the bot leaves again, and nothing of it is kept afterwards.
 */
export class MusicSession {
  readonly queue = new TrackQueue();
  /** `connecting` until the bot is in the channel and Lavalink has a player for it. */
  state: 'connecting' | 'active' | 'ended' = 'connecting';
  /** Settles when the session is ready for tracks; rejects with the reason if it never got there. */
  ready: Promise<void> = Promise.resolve();
  current: NowPlaying | null = null;
  paused = false;
  /** Percent; 100 is normal. */
  volume = 100;
  /** How many tracks in a row could not be played. */
  failures = 0;
  /** The latest thing that went wrong, shown with the controls until something plays through again. */
  problem: string | null = null;
  /** Where in the track Lavalink last said it was, and when that was. */
  progress: { at: number; position: number } | null = null;
  /** Whether the bot was let into a personal channel for this, which has to be undone afterwards. */
  admitted = false;
  /** The "now playing" message in the channel's chat. */
  panelMessageId: string | null = null;
  /** The bot may not post in the channel's chat, so there is no point in trying again. */
  panelBlocked = false;

  idleTimer: NodeJS.Timeout | null = null;
  aloneTimer: NodeJS.Timeout | null = null;
  recoveryTimer: NodeJS.Timeout | null = null;
  panelTimer: NodeJS.Timeout | null = null;

  constructor(
    readonly guildId: string,
    readonly channelId: string,
    readonly bot: PlayerBot,
    /** Whether the channel is one of the personal channels this bot creates. */
    readonly managed: boolean,
  ) {}

  /** How far into the current track playback is, in milliseconds. */
  get position(): number {
    if (!this.current || !this.progress) return 0;
    const elapsed = this.paused ? 0 : Date.now() - this.progress.at;
    const position = this.progress.position + elapsed;
    const { isStream, length } = this.current.item.track.info;
    return isStream ? position : Math.min(position, length);
  }

  clearTimers(): void {
    for (const timer of [this.idleTimer, this.aloneTimer, this.recoveryTimer, this.panelTimer]) {
      if (timer) clearTimeout(timer);
    }
    this.idleTimer = this.aloneTimer = this.recoveryTimer = this.panelTimer = null;
  }
}
