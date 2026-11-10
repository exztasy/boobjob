import {
  ChannelType,
  DiscordAPIError,
  RateLimitError,
  RESTJSONErrorCodes,
  TimestampStyles,
  time,
  type Channel,
  type Guild,
  type VoiceChannel,
  type VoiceState,
} from 'discord.js';
import { UserError } from '../errors.js';

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Whether an error is Discord rejecting a request with one of the given error codes. */
export function hasApiCode(error: unknown, ...codes: RESTJSONErrorCodes[]): boolean {
  return error instanceof DiscordAPIError && codes.includes(Number(error.code));
}

export function isVoiceChannel(channel: Channel | null | undefined): channel is VoiceChannel {
  return channel?.type === ChannelType.GuildVoice;
}

/** Voice states of everyone connected to a channel, including members that are not cached. */
export function voiceStatesIn(guild: Guild, channelId: string): VoiceState[] {
  return [...guild.voiceStates.cache.values()].filter((state) => state.channelId === channelId);
}

/**
 * How many people are in a channel. Only members known to be bots are left
 * out, so a music bot alone does not keep a channel alive, while someone we
 * cannot identify still does.
 */
export function humanCount(guild: Guild, channelId: string): number {
  return voiceStatesIn(guild, channelId).filter((state) => state.member?.user.bot !== true).length;
}

/** "in 5 minutes"-style timestamp that Discord renders live for each reader. */
export function relativeTime(timestampMs: number): string {
  return time(Math.ceil(timestampMs / 1000), TimestampStyles.RelativeTime);
}

/** Turns anything thrown while handling a request into a sentence for the person who made it. */
export function describeError(error: unknown): string {
  if (error instanceof UserError) return error.message;
  if (error instanceof RateLimitError) {
    return `Discord is limiting how fast this channel can be changed. Try again ${relativeTime(Date.now() + error.retryAfter)}.`;
  }
  if (hasApiCode(error, RESTJSONErrorCodes.MissingPermissions, RESTJSONErrorCodes.MissingAccess)) {
    return "I don't have the permissions for that. A server admin can run `/voicehub list` to see what my role is missing.";
  }
  if (hasApiCode(error, RESTJSONErrorCodes.TargetUserIsNotConnectedToVoice)) {
    return 'That member is not connected to voice any more.';
  }
  if (hasApiCode(error, RESTJSONErrorCodes.UnknownChannel)) {
    return 'This channel no longer exists.';
  }
  if (hasApiCode(error, RESTJSONErrorCodes.InvalidFormBodyOrContentType)) {
    return "Discord didn't accept that value. If this server filters channel names, try a different one.";
  }
  return 'Something went wrong on my side. Please try again.';
}
