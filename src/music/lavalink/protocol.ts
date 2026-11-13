/**
 * The parts of Lavalink's v4 protocol that the bot uses, as documented at
 * https://lavalink.dev/api/. Lavalink does the actual work of fetching and
 * streaming audio; the bot only tells it what to play and where.
 */

export interface TrackInfo {
  identifier: string;
  isSeekable: boolean;
  author: string;
  /** Length in milliseconds. Meaningless for live streams. */
  length: number;
  isStream: boolean;
  position: number;
  title: string;
  uri: string | null;
  artworkUrl: string | null;
  isrc: string | null;
  /** Where the track comes from: `youtube`, `soundcloud`, `spotify` and so on. */
  sourceName: string;
}

export interface Track {
  /** The track in the form Lavalink wants it back in order to play it. */
  encoded: string;
  info: TrackInfo;
  pluginInfo?: unknown;
  /** Whatever was attached when the track was handed to a player; comes back in events. */
  userData?: Record<string, unknown>;
}

export type Severity = 'common' | 'suspicious' | 'fault';

export interface LavalinkException {
  message: string | null;
  /** `common` means the cause is known and the message is fit to show to a person. */
  severity: Severity;
  cause: string;
}

export type LoadResult =
  | { loadType: 'track'; data: Track }
  | { loadType: 'playlist'; data: { info: { name: string; selectedTrack: number }; tracks: Track[] } }
  | { loadType: 'search'; data: Track[] }
  | { loadType: 'empty'; data: unknown }
  | { loadType: 'error'; data: LavalinkException };

/** What Lavalink needs to join a voice channel on the bot's behalf. */
export interface VoiceServer {
  token: string;
  endpoint: string;
  sessionId: string;
  channelId: string;
}

export interface PlayerUpdate {
  track?: { encoded: string | null; userData?: Record<string, unknown> };
  /** Position to start from or seek to, in milliseconds. */
  position?: number;
  /** Percentage, 0 to 1000. */
  volume?: number;
  paused?: boolean;
  voice?: VoiceServer;
}

export interface PlayerState {
  time: number;
  position: number;
  /** Whether Lavalink is connected to Discord's voice server. */
  connected: boolean;
  ping: number;
}

export interface Player {
  guildId: string;
  track: Track | null;
  volume: number;
  paused: boolean;
  state: PlayerState;
}

export type TrackEndReason = 'finished' | 'loadFailed' | 'stopped' | 'replaced' | 'cleanup';

export type PlayerEvent =
  | { type: 'TrackStartEvent'; guildId: string; track: Track }
  | { type: 'TrackEndEvent'; guildId: string; track: Track; reason: TrackEndReason }
  | { type: 'TrackExceptionEvent'; guildId: string; track: Track; exception: LavalinkException }
  | { type: 'TrackStuckEvent'; guildId: string; track: Track; thresholdMs: number }
  | { type: 'WebSocketClosedEvent'; guildId: string; code: number; reason: string; byRemote: boolean };

export interface ServerInfo {
  version: { semver: string };
  sourceManagers: string[];
  plugins: { name: string; version: string }[];
}

/** A request Lavalink answered with an error status. */
export class LavalinkError extends Error {
  override name = 'LavalinkError';

  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
