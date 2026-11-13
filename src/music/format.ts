import { escapeMarkdown } from 'discord.js';
import { truncate } from '../domain/settings.js';
import type { LavalinkException, Track } from './lavalink/protocol.js';

const MAX_TITLE_LENGTH = 80;
const MAX_AUTHOR_LENGTH = 40;
const MAX_PROBLEM_LENGTH = 200;
/** Links longer than this are left out: a handful of them must fit into one message. */
const MAX_LINK_LENGTH = 200;

/** `3:07`, or `1:02:45` from an hour up. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, '0');
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}` : `${minutes}:${seconds}`;
}

export function trackLength(track: Track): string {
  return track.info.isStream ? 'live' : formatDuration(track.info.length);
}

/**
 * A track's title as bold text that links to where it comes from. Titles
 * are written by whoever uploaded the track, so everything in them that
 * Discord would treat as formatting is defused.
 */
export function trackTitle(track: Track): string {
  const title = plainText(track.info.title, MAX_TITLE_LENGTH) || 'Untitled';
  const link = safeLink(track.info.uri);
  return link ? `**[${title}](${link})**` : `**${title}**`;
}

/** Title, uploader and length on one line. */
export function trackLine(track: Track): string {
  const author = plainText(track.info.author, MAX_AUTHOR_LENGTH);
  return `${trackTitle(track)}${author ? ` · ${author}` : ''} · \`${trackLength(track)}\``;
}

/**
 * The same without the link and cut shorter, for long lists: ten of these
 * fit into an ordinary message whatever the titles are.
 */
export function compactLine(track: Track): string {
  const author = plainText(track.info.author, 25);
  return `**${plainText(track.info.title, 45) || 'Untitled'}**${author ? ` · ${author}` : ''} · \`${trackLength(track)}\``;
}

/** Why a track could not be played, in words fit for the people listening. */
export function describeException(exception: LavalinkException | undefined): string {
  // Only what Lavalink marks as an ordinary, expected failure is written for people to read
  // ("This video is not available"); the rest is stack-trace material and goes to the log.
  if (exception?.severity === 'common' && exception.message) {
    return truncate(escapeMarkdown(exception.message.replace(/\s+/gu, ' ').trim()), MAX_PROBLEM_LENGTH);
  }
  return 'the music server could not play it';
}

/** Text from outside (a title, a playlist name) cut to length and made safe to put into a message. */
export function plainText(text: string | null | undefined, max: number): string {
  const collapsed = (text ?? '').replace(/\s+/gu, ' ').trim();
  // Square brackets would end the link text early; the rest is ordinary Markdown.
  return escapeMarkdown(truncate(collapsed, max)).replace(/[[\]]/gu, (bracket) => (bracket === '[' ? '(' : ')'));
}

/** The link in a form that cannot break out of Markdown's `(...)`, or `null` if it is not a web link. */
function safeLink(uri: string | null | undefined): string | null {
  if (!uri || uri.length > MAX_LINK_LENGTH) return null;
  if (!/^https?:\/\//iu.test(uri) || /\s/u.test(uri) || !URL.canParse(uri)) return null;
  return uri.replace(/[()<>]/gu, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}
