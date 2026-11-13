import { UserError } from '../errors.js';

/** Where a search for something that is not a link is carried out. */
export const SEARCH_SOURCES = {
  youtube: { label: 'YouTube', prefix: 'ytsearch' },
  youtubemusic: { label: 'YouTube Music', prefix: 'ytmsearch' },
  spotify: { label: 'Spotify', prefix: 'spsearch' },
  soundcloud: { label: 'SoundCloud', prefix: 'scsearch' },
} as const;

export type SearchSource = keyof typeof SEARCH_SOURCES;

export const DEFAULT_SEARCH_SOURCE: SearchSource = 'youtube';

export const MAX_QUERY_LENGTH = 300;

export function isSearchSource(value: string): value is SearchSource {
  return Object.hasOwn(SEARCH_SOURCES, value);
}

export interface MusicRequest {
  /** What to hand to Lavalink. */
  identifier: string;
  kind: 'link' | 'search';
  /** The link or the search words, cleaned up, for telling the person what was looked for. */
  text: string;
  source: SearchSource;
}

/**
 * Turns what someone typed after `/music play` into a request for Lavalink.
 *
 * A web link is passed on as it is; Lavalink recognises the YouTube, Spotify
 * and SoundCloud links (and whatever else it is set up for) by itself.
 * Everything else is a search, and always marked as one: an unmarked request
 * would let people hand Lavalink arbitrary identifiers, such as file paths on
 * the machine it runs on.
 */
export function parseRequest(input: string, source: SearchSource = DEFAULT_SEARCH_SOURCE): MusicRequest {
  let text = input.replace(/\s+/gu, ' ').trim();
  // Discord users wrap a link in <> to stop it from being previewed.
  const wrapped = /^<(\S+)>$/u.exec(text);
  if (wrapped) text = wrapped[1]!;

  if (!text) throw new UserError('Tell me what to play: a link, or the name of a song to search for.');
  if (text.length > MAX_QUERY_LENGTH) {
    throw new UserError(`That is too long. A link or search can have at most ${MAX_QUERY_LENGTH} characters.`);
  }

  if (isWebLink(text)) return { identifier: text, kind: 'link', text, source };
  return { identifier: `${SEARCH_SOURCES[source].prefix}:${text}`, kind: 'search', text, source };
}

function isWebLink(text: string): boolean {
  if (/\s/u.test(text) || !/^https?:\/\//iu.test(text)) return false;
  return URL.canParse(text);
}
