/** Timings and limits. Defaults suit production; tests shrink them. */
export interface Tuning {
  /** Minimum time between two channel creations by the same member, to stop join/leave spam. */
  createCooldownMs: number;
  /** The periodic sweep ignores channels younger than this so it cannot race a creation in progress. */
  emptyGraceMs: number;
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
}

export const DEFAULT_TUNING: Tuning = {
  createCooldownMs: 3_000,
  emptyGraceMs: 30_000,
  panelDebounceMs: 750,
  sweepIntervalMs: 5 * 60_000,
  voiceSettleMs: 2_000,
  renameLimit: 2,
  renameWindowMs: 10 * 60_000,
  failureNoticeCooldownMs: 60_000,
  failureNoticeTtlMs: 30_000,
};
