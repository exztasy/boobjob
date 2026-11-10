import { VideoQualityMode } from 'discord.js';
import type { Privacy, ProfileSettings } from '../storage/store.js';

export const MAX_NAME_LENGTH = 100;
export const MAX_USER_LIMIT = 99;
export const MIN_BITRATE = 8_000;
/** Bitrates offered in the control panel, in kbps. Servers unlock the higher ones with boosts. */
export const BITRATE_CHOICES_KBPS: readonly number[] = [8, 16, 32, 64, 96, 128, 256, 384];
/** Select menus hold at most 25 entries, which is what the allow and block lists are edited with. */
export const MAX_LIST_SIZE = 25;
export const DEFAULT_PRIVACY: Privacy = 'hidden';
export const FALLBACK_CHANNEL_NAME = 'Voice channel';

export interface ResolvedSettings {
  name: string;
  userLimit: number;
  bitrate: number;
  rtcRegion: string | null;
  videoQuality: VideoQualityMode;
  privacy: Privacy;
}

export interface SettingsContext {
  /** Display name of the channel's owner, used when they have not picked a name. */
  displayName: string;
  /** Bitrate of the hub channel, used when the owner has not picked one. */
  hubBitrate: number;
  /** Highest bitrate the server currently allows. */
  maxBitrate: number;
}

/** Tidies a name typed by a user. Returns `null` when nothing usable is left. */
export function sanitizeName(input: string): string | null {
  const collapsed = input.replace(/\s+/gu, ' ').trim();
  if (!collapsed) return null;
  return truncate(collapsed, MAX_NAME_LENGTH);
}

export function defaultChannelName(displayName: string): string {
  const suffix = "'s channel";
  const owner = sanitizeName(displayName);
  if (!owner) return FALLBACK_CHANNEL_NAME;
  return `${truncate(owner, MAX_NAME_LENGTH - suffix.length)}${suffix}`;
}

/** Parses what a user typed for the user limit. `0` means unlimited; `null` means it made no sense. */
export function parseUserLimit(input: string): number | null {
  const text = input.trim().toLowerCase();
  if (text === '' || text === 'none' || text === 'off' || text === 'unlimited' || text === 'no limit') return 0;
  if (!/^\d{1,3}$/u.test(text)) return null;
  const value = Number(text);
  return value <= MAX_USER_LIMIT ? value : null;
}

export function clampBitrate(bitrate: number, maxBitrate: number): number {
  return Math.min(Math.max(Math.round(bitrate), MIN_BITRATE), Math.max(maxBitrate, MIN_BITRATE));
}

export function isVideoQuality(value: number): value is VideoQualityMode {
  return value === VideoQualityMode.Auto || value === VideoQualityMode.Full;
}

/** Turns a saved profile (which may be missing or partial) into concrete channel settings. */
export function resolveSettings(profile: Partial<ProfileSettings> | undefined, context: SettingsContext): ResolvedSettings {
  const savedName = profile?.name ? sanitizeName(profile.name) : null;
  const limit = profile?.userLimit;
  const video = profile?.videoQuality;

  return {
    name: savedName ?? defaultChannelName(context.displayName),
    userLimit: typeof limit === 'number' && limit >= 0 && limit <= MAX_USER_LIMIT ? Math.trunc(limit) : 0,
    bitrate: clampBitrate(profile?.bitrate ?? context.hubBitrate, context.maxBitrate),
    rtcRegion: profile?.rtcRegion || null,
    videoQuality: typeof video === 'number' && isVideoQuality(video) ? video : VideoQualityMode.Auto,
    privacy: profile?.privacy ?? DEFAULT_PRIVACY,
  };
}

export function formatBitrate(bitrate: number): string {
  return `${Math.round(bitrate / 1000)} kbps`;
}

export function formatUserLimit(limit: number): string {
  if (limit <= 0) return 'No limit';
  return limit === 1 ? '1 user' : `${limit} users`;
}

export function formatVideoQuality(mode: VideoQualityMode | null): string {
  return mode === VideoQualityMode.Full ? '720p' : 'Auto';
}

/**
 * Shortens text so its length is at most `max`, without cutting an emoji or
 * other astral character in half. Length is counted the conservative way
 * (UTF-16 units), so the result fits Discord's limits however it counts.
 */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  let result = '';
  for (const character of text) {
    if (result.length + character.length > max) break;
    result += character;
  }
  return result.trimEnd();
}
