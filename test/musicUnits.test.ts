import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { PermissionFlagsBits as P } from 'discord.js';
import { ConfigError, readConfig } from '../src/config.js';
import { GUEST_PERMISSIONS, MAX_OVERWRITES, buildOverwrites } from '../src/domain/overwrites.js';
import { UserError } from '../src/errors.js';
import { describeException, fitLines, formatDuration, trackLine } from '../src/music/format.js';
import type { Track } from '../src/music/lavalink/protocol.js';
import { parseRequest } from '../src/music/query.js';
import { MAX_QUEUE_LENGTH, TrackQueue, type QueueItem } from '../src/music/queue.js';
import { renderEndedMusicPanel, renderMusicPanel } from '../src/ui/musicPanel.js';
import { INVITE_PERMISSIONS } from '../src/permissions.js';
import { resolvePermissions, validateMessage } from './support/fakeDiscord.js';

function track(title: string, overrides: Partial<Track['info']> = {}): Track {
  return {
    encoded: `encoded-${title}`,
    info: {
      identifier: title,
      isSeekable: true,
      author: 'Artist',
      length: 60_000,
      isStream: false,
      position: 0,
      title,
      uri: `https://www.youtube.com/watch?v=${encodeURIComponent(title)}`,
      artworkUrl: null,
      isrc: null,
      sourceName: 'youtube',
      ...overrides,
    },
  };
}

function items(...titles: string[]): QueueItem[] {
  return titles.map((title) => ({ track: track(title), requesterId: '1' }));
}

function titles(queue: TrackQueue): string[] {
  return queue.upcoming.map((item) => item.track.info.title);
}

describe('the queue', () => {
  test('plays in order and takes no more than it can hold', () => {
    const queue = new TrackQueue();
    assert.equal(queue.add(items('a', 'b')), 2);
    assert.equal(queue.next(null, 'finished')?.track.info.title, 'a');
    assert.deepEqual(titles(queue), ['b']);

    const many = Array.from({ length: MAX_QUEUE_LENGTH + 10 }, (_, index) => `t${index}`);
    assert.equal(queue.add(items(...many)), MAX_QUEUE_LENGTH - 1, 'only what fits is taken');
    assert.equal(queue.length, MAX_QUEUE_LENGTH);
    assert.equal(queue.add(items('x')), 0);
  });

  test('looping a track repeats it only when it played through', () => {
    const queue = new TrackQueue();
    queue.add(items('a', 'b', 'c'));
    queue.loop = 'track';
    const a = queue.next(null, 'finished')!;
    assert.equal(queue.next(a, 'finished'), a);
    assert.equal(queue.next(a, 'skipped')?.track.info.title, 'b', 'skipping gets out of the loop');
    const c = queue.next(queue.next(a, 'failed')!, 'failed');
    assert.equal(c, null, 'a failing track is not repeated, and neither is the one after it');
  });

  test('looping the queue sends played and skipped tracks to the back, but not failed ones', () => {
    const queue = new TrackQueue();
    queue.add(items('a', 'b', 'c'));
    queue.loop = 'queue';
    const a = queue.next(null, 'finished')!;
    const b = queue.next(a, 'finished')!;
    assert.deepEqual(titles(queue), ['c', 'a']);
    const c = queue.next(b, 'skipped')!;
    assert.deepEqual(titles(queue), ['a', 'b']);
    queue.next(c, 'failed');
    assert.deepEqual(titles(queue), ['b'], 'c failed and is gone, a is playing');
  });

  test('shuffles without losing anything, and removes by position', () => {
    const values = [0.9, 0.1, 0.5, 0.3];
    const queue = new TrackQueue(() => values.shift() ?? 0);
    queue.add(items('a', 'b', 'c', 'd', 'e'));
    queue.shuffle();
    assert.deepEqual([...titles(queue)].sort(), ['a', 'b', 'c', 'd', 'e']);
    assert.notDeepEqual(titles(queue), ['a', 'b', 'c', 'd', 'e']);

    const second = titles(queue)[1];
    assert.equal(queue.remove(2)?.track.info.title, second);
    assert.equal(queue.remove(0), null);
    assert.equal(queue.remove(5), null);
    assert.equal(queue.remove(1.5), null);
    assert.equal(queue.length, 4);
  });

  test('counts the playing time of what is waiting, live streams as nothing', () => {
    const queue = new TrackQueue();
    queue.add([
      { track: track('song', { length: 90_000 }), requesterId: '1' },
      { track: track('radio', { isStream: true, length: Number.MAX_SAFE_INTEGER }), requesterId: '1' },
      { track: track('other', { length: 30_000 }), requesterId: '1' },
    ]);
    assert.equal(queue.duration, 120_000);
  });
});

describe('what to play', () => {
  test('words are a search, on YouTube unless another source is picked', () => {
    assert.deepEqual(parseRequest('  never   gonna\tgive '), {
      identifier: 'ytsearch:never gonna give',
      kind: 'search',
      text: 'never gonna give',
      source: 'youtube',
    });
    assert.equal(parseRequest('x', 'soundcloud').identifier, 'scsearch:x');
    assert.equal(parseRequest('x', 'spotify').identifier, 'spsearch:x');
    assert.equal(parseRequest('x', 'youtubemusic').identifier, 'ytmsearch:x');
  });

  test('web links go to Lavalink as they are, nothing else does', () => {
    const spotify = 'https://open.spotify.com/intl-de/track/0eG08cBeKk0mzykKjw4hcQ?si=abc';
    assert.deepEqual(parseRequest(spotify), { identifier: spotify, kind: 'link', text: spotify, source: 'youtube' });
    assert.equal(parseRequest('<https://soundcloud.com/a/b>').identifier, 'https://soundcloud.com/a/b', 'Discord-style <link>');
    // Anything else could make Lavalink open files or reach places it should not.
    assert.equal(parseRequest('file:///etc/passwd').identifier, 'ytsearch:file:///etc/passwd');
    assert.equal(parseRequest('/opt/Lavalink/application.yml').identifier, 'ytsearch:/opt/Lavalink/application.yml');
    assert.equal(parseRequest('scsearch:sneaky').identifier, 'ytsearch:scsearch:sneaky');
    assert.equal(parseRequest('https://a.example/x y').kind, 'search', 'a link with spaces in it is not a link');
  });

  test('nothing, or too much, is refused', () => {
    assert.throws(() => parseRequest('   '), UserError);
    assert.throws(() => parseRequest('a'.repeat(301)), UserError);
    assert.equal(parseRequest('a'.repeat(300)).kind, 'search');
  });
});

describe('showing tracks', () => {
  test('durations', () => {
    assert.equal(formatDuration(0), '0:00');
    assert.equal(formatDuration(59_999), '0:59');
    assert.equal(formatDuration(61_000), '1:01');
    assert.equal(formatDuration(3_723_000), '1:02:03');
    assert.equal(formatDuration(-5), '0:00');
  });

  test('titles cannot break out of their formatting or their link', () => {
    const line = trackLine(
      track('**Bold** [click](https://evil.example) `code`', {
        author: '__under__',
        uri: 'https://www.youtube.com/watch?v=a(b)c',
      }),
    );
    assert.equal(
      line,
      '**[\\*\\*Bold\\*\\* (click)(https://evil.example) \\`code\\`](https://www.youtube.com/watch?v=a%28b%29c)** · \\_\\_under\\_\\_ · `1:00`',
    );
    assert.equal(trackLine(track('a', { uri: 'javascript:alert(1)' })), '**a** · Artist · `1:00`', 'only web links become links');
    assert.equal(trackLine(track('a', { uri: `https://x.example/${'a'.repeat(300)}` })), '**a** · Artist · `1:00`');
    assert.equal(trackLine(track('radio', { isStream: true, uri: null })), '**radio** · Artist · `live`');
  });

  test('only failures Lavalink calls ordinary are shown as they are', () => {
    assert.equal(describeException({ message: 'This video is *private*.', severity: 'common', cause: '' }), 'This video is \\*private\\*.');
    assert.equal(describeException({ message: 'NPE at Foo.java:42', severity: 'fault', cause: '' }), 'the music server could not play it');
    assert.equal(describeException(undefined), 'the music server could not play it');
  });

  test('long lists are cut down to whole lines', () => {
    assert.equal(fitLines(['a', 'b']), 'a\nb');
    const lines = Array.from({ length: 50 }, (_, index) => `${index} ${'x'.repeat(95)}`);
    const fitted = fitLines(lines);
    assert.ok(fitted.length <= 2000);
    assert.match(fitted, /\n…and \d+ more\.$/u);
    assert.ok(fitted.split('\n').slice(0, -1).every((line) => lines.includes(line)), 'no line is cut in half');
  });

  test('the music message stays within what Discord accepts, however long and odd the titles', () => {
    const nasty = (index: number): QueueItem => ({
      track: track(`${'*_`|'.repeat(30)} ${index}`, { author: '\\'.repeat(60), uri: `https://x.example/${'(a)'.repeat(60)}` }),
      requesterId: '1',
    });
    const panel = renderMusicPanel({
      botId: '2',
      current: nasty(0),
      paused: true,
      loop: 'queue',
      volume: 150,
      upcoming: Array.from({ length: MAX_QUEUE_LENGTH }, (_, index) => nasty(index + 1)),
      upcomingDuration: 123_456_789,
      problem: `Skipped ${'*'.repeat(80)}: ${'This is not available. '.repeat(20)}`,
    });
    const body = { flags: panel.flags, components: panel.components.map((component) => component.toJSON()) };
    assert.doesNotThrow(() => validateMessage(body, true));
    const ended = renderEndedMusicPanel('Stopped by <@1>.');
    assert.doesNotThrow(() => validateMessage({ flags: ended.flags, components: ended.components.map((c) => c.toJSON()) }, true));
  });
});

describe('music bots in personal channels', () => {
  const input = {
    everyoneId: '1',
    botId: '2',
    botPermissions: P.Administrator,
    base: [],
    ownerId: '3',
    privacy: 'hidden' as const,
    allowed: [],
    blocked: [],
  };

  function permissionsOf(userId: string, overwrites: ReturnType<typeof buildOverwrites>): bigint {
    return resolvePermissions({ base: P.ViewChannel | P.Connect | P.Speak, userId, roleIds: [], everyoneId: '1', overwrites });
  }

  test('a bot at work in a hidden channel gets in and may speak, whatever the lists say', () => {
    const overwrites = buildOverwrites({ ...input, blocked: ['9'], guests: ['9'] });
    const permissions = permissionsOf('9', overwrites);
    assert.equal(permissions & GUEST_PERMISSIONS, GUEST_PERMISSIONS);
    assert.equal(permissionsOf('8', overwrites) & P.ViewChannel, 0n, 'others are still kept out');
  });

  test('a bot that is not an administrator hands out only what it holds itself', () => {
    const overwrites = buildOverwrites({ ...input, botPermissions: INVITE_PERMISSIONS, guests: ['9'] });
    const guest = overwrites.find((overwrite) => overwrite.id === '9')!;
    assert.equal(guest.allow, GUEST_PERMISSIONS, 'the invite asks for everything a guest needs');
  });

  test('a guest is among the last overwrites to go when there are too many', () => {
    const base = Array.from({ length: 150 }, (_, index) => ({ id: String(100 + index), type: 0, allow: P.Speak, deny: 0n }));
    const overwrites = buildOverwrites({ ...input, base, guests: ['9'] });
    assert.equal(overwrites.length, MAX_OVERWRITES);
    assert.ok(overwrites.some((overwrite) => overwrite.id === '9'));
  });
});

describe('music settings', () => {
  const env = { DISCORD_TOKEN: 'main' };

  test('without a Lavalink password the bot runs without music', () => {
    assert.equal(readConfig(env).music, null);
  });

  test('a Lavalink password turns music on, with sensible defaults', () => {
    assert.deepEqual(readConfig({ ...env, LAVALINK_PASSWORD: 'secret' }).music, {
      lavalink: { host: 'localhost', port: 2333, password: 'secret', secure: false },
      botTokens: [],
    });
    assert.deepEqual(
      readConfig({ ...env, LAVALINK_PASSWORD: 'secret', LAVALINK_HOST: 'lavalink', LAVALINK_PORT: '443', LAVALINK_SECURE: 'TRUE' })
        .music?.lavalink,
      { host: 'lavalink', port: 443, password: 'secret', secure: true },
    );
  });

  test('helper tokens may be separated by commas, spaces or new lines, and count once', () => {
    const music = readConfig({ ...env, LAVALINK_PASSWORD: 'secret', MUSIC_BOT_TOKENS: ' one,two \n three, one ,' }).music;
    assert.deepEqual(music?.botTokens, ['one', 'two', 'three']);
  });

  test('settings that cannot work are refused with a reason', () => {
    const refused = (extra: Record<string, string>, pattern: RegExp): void => {
      assert.throws(() => readConfig({ ...env, ...extra }), (error: unknown) => error instanceof ConfigError && pattern.test(error.message));
    };
    refused({ MUSIC_BOT_TOKENS: 'one' }, /MUSIC_BOT_TOKENS is set but LAVALINK_PASSWORD is not/u);
    refused({ LAVALINK_PASSWORD: 'x', MUSIC_BOT_TOKENS: 'one,main' }, /contains the token from DISCORD_TOKEN/u);
    refused({ LAVALINK_PASSWORD: 'x', LAVALINK_PORT: '70000' }, /LAVALINK_PORT must be a port number/u);
    refused({ LAVALINK_PASSWORD: 'x', LAVALINK_PORT: 'http' }, /LAVALINK_PORT must be a port number/u);
    refused({ LAVALINK_PASSWORD: 'x', LAVALINK_SECURE: 'yes' }, /LAVALINK_SECURE must be true or false/u);
  });
});
