/** Timings and limits. Defaults suit production; tests shrink them. */
export interface Tuning {
  /** Minimum time between two channel creations by the same member, to stop join/leave spam. */
  createCooldownMs: number;
  /** Changes to a channel within this window are folded into one control panel edit. */
  panelDebounceMs: number;
  /** How often to look for anything a missed gateway event left behind. */
  sweepIntervalMs: number;
  /** How long to wait for the gateway to confirm a mute or deafen before carrying on. */
  voiceSettleMs: number;
  /** Discord allows this many renames of one channel per `renameWindowMs`. */
  renameLimit: number;
  renameWindowMs: number;
  /** At most one "could not create your channel" notice per hub in this window. */
  failureNoticeCooldownMs: number;
  /** How long such a notice stays in the hub's chat before it is removed. */
  failureNoticeTtlMs: number;
  /**
   * How long shutting down may wait for Discord to confirm the disconnect.
   * Has to stay well below the ten seconds a process manager such as Docker
   * typically allows before it kills the process.
   */
  shutdownTimeoutMs: number;

  /** How long a music bot stays in a channel once it has nothing left to play. */
  musicIdleMs: number;
  /** How long a music bot keeps playing to a channel with nobody in it. */
  musicAloneMs: number;
  /** How long Discord gets to confirm that a music bot has joined a voice channel. */
  voiceJoinTimeoutMs: number;
  /**
   * After the audio connection between Lavalink and Discord dropped, how
   * long it gets to come back by itself before the music is called off.
   */
  voiceRecoveryMs: number;
  /** How long to wait before trying again to reach a Lavalink server that is down. */
  lavalinkRetryMs: number;
  /** How long a single request to Lavalink may take. Looking up a long playlist takes a while. */
  lavalinkRequestTimeoutMs: number;
  /** How often the connection to Lavalink is checked for still being alive. */
  lavalinkPingMs: number;
}

export const DEFAULT_TUNING: Tuning = {
  createCooldownMs: 3_000,
  panelDebounceMs: 750,
  sweepIntervalMs: 5 * 60_000,
  voiceSettleMs: 2_000,
  renameLimit: 2,
  renameWindowMs: 10 * 60_000,
  failureNoticeCooldownMs: 60_000,
  failureNoticeTtlMs: 30_000,
  shutdownTimeoutMs: 5_000,
  musicIdleMs: 5 * 60_000,
  musicAloneMs: 60_000,
  voiceJoinTimeoutMs: 10_000,
  voiceRecoveryMs: 10_000,
  lavalinkRetryMs: 5_000,
  lavalinkRequestTimeoutMs: 20_000,
  lavalinkPingMs: 30_000,
};
