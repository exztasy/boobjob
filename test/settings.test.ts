import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { VideoQualityMode } from 'discord.js';
import { RenameLimiter } from '../src/domain/renameLimiter.js';
import {
  FALLBACK_CHANNEL_NAME,
  MAX_NAME_LENGTH,
  clampBitrate,
  defaultChannelName,
  parseUserLimit,
  resolveSettings,
  sanitizeName,
  truncate,
} from '../src/domain/settings.js';
import { KeyedQueue } from '../src/util/keyedQueue.js';

const context = { displayName: 'Alice', hubBitrate: 64_000, maxBitrate: 96_000 };

describe('channel names', () => {
  test('are trimmed and have runs of whitespace collapsed', () => {
    assert.equal(sanitizeName('  Movie \n\t night  '), 'Movie night');
  });

  test('that are blank count as no name at all', () => {
    assert.equal(sanitizeName('   \n '), null);
    assert.equal(sanitizeName(''), null);
  });

  test('are cut to what Discord accepts', () => {
    assert.equal(sanitizeName('x'.repeat(250))?.length, MAX_NAME_LENGTH);
  });

  test('are never cut in the middle of an emoji', () => {
    const name = truncate('🎮'.repeat(60), 99);

    assert.ok(name.length <= 99);
    assert.equal(name, '🎮'.repeat(49), 'a whole number of emoji survives');
  });

  test('default to the owner\'s display name', () => {
    assert.equal(defaultChannelName('Alice'), "Alice's channel");
  });

  test('default to something sensible when the display name is unusable', () => {
    assert.equal(defaultChannelName('   '), FALLBACK_CHANNEL_NAME);
    assert.ok(defaultChannelName('n'.repeat(200)).length <= MAX_NAME_LENGTH);
    assert.ok(defaultChannelName('n'.repeat(200)).endsWith("'s channel"));
  });
});

describe('the user limit typed into the panel', () => {
  test('accepts numbers from 0 to 99', () => {
    assert.equal(parseUserLimit('5'), 5);
    assert.equal(parseUserLimit(' 99 '), 99);
    assert.equal(parseUserLimit('0'), 0);
  });

  test('accepts words for "no limit"', () => {
    for (const text of ['', 'none', 'Unlimited', 'OFF', 'no limit']) assert.equal(parseUserLimit(text), 0, text);
  });

  test('rejects everything else', () => {
    for (const text of ['100', '-1', '2.5', 'five', '1e1', '0x10', '9999']) assert.equal(parseUserLimit(text), null, text);
  });
});

describe('turning a saved profile into channel settings', () => {
  test('uses defaults for a member who has never changed anything', () => {
    assert.deepEqual(resolveSettings(undefined, context), {
      name: "Alice's channel",
      userLimit: 0,
      bitrate: 64_000,
      rtcRegion: null,
      videoQuality: VideoQualityMode.Auto,
      privacy: 'hidden',
    });
  });

  test('uses what the member saved', () => {
    const settings = resolveSettings(
      { name: 'Movie night', userLimit: 4, bitrate: 96_000, rtcRegion: 'rotterdam', videoQuality: 2, privacy: 'locked' },
      context,
    );

    assert.deepEqual(settings, {
      name: 'Movie night',
      userLimit: 4,
      bitrate: 96_000,
      rtcRegion: 'rotterdam',
      videoQuality: VideoQualityMode.Full,
      privacy: 'locked',
    });
  });

  test('mixes saved values with defaults for the rest', () => {
    const settings = resolveSettings({ userLimit: 2, name: null, bitrate: null }, context);

    assert.equal(settings.userLimit, 2);
    assert.equal(settings.name, "Alice's channel");
    assert.equal(settings.bitrate, 64_000);
  });

  test('lowers a saved bitrate the server no longer allows', () => {
    // Saved while the server was boosted; the boosts have since lapsed.
    assert.equal(resolveSettings({ bitrate: 384_000 }, context).bitrate, 96_000);
  });

  test('lowers the hub bitrate too if it is above what the server allows', () => {
    assert.equal(resolveSettings(undefined, { ...context, hubBitrate: 128_000 }).bitrate, 96_000);
  });

  test('ignores saved values that make no sense', () => {
    const settings = resolveSettings({ userLimit: 500, videoQuality: 7, name: '   ' }, context);

    assert.equal(settings.userLimit, 0);
    assert.equal(settings.videoQuality, VideoQualityMode.Auto);
    assert.equal(settings.name, "Alice's channel");
  });
});

test('bitrates are kept within what Discord and the server allow', () => {
  assert.equal(clampBitrate(1_000, 96_000), 8_000);
  assert.equal(clampBitrate(500_000, 96_000), 96_000);
  assert.equal(clampBitrate(64_000, 96_000), 64_000);
});

describe('the rename limiter', () => {
  const WINDOW = 600_000;

  function limiterAt(start: number): { limiter: RenameLimiter; advance: (ms: number) => void } {
    let now = start;
    return { limiter: new RenameLimiter(2, WINDOW, () => now), advance: (ms) => void (now += ms) };
  }

  test('allows two renames and then makes the third wait for the window to pass', () => {
    const { limiter, advance } = limiterAt(1_000_000);

    assert.equal(limiter.retryAfter('a'), 0);
    limiter.record('a');
    advance(60_000);
    assert.equal(limiter.retryAfter('a'), 0);
    limiter.record('a');
    advance(60_000);

    // The first rename was two minutes ago, so it stops counting in eight.
    assert.equal(limiter.retryAfter('a'), WINDOW - 120_000);
    advance(WINDOW - 120_000);
    assert.equal(limiter.retryAfter('a'), 0);
  });

  test('counts each channel separately', () => {
    const { limiter } = limiterAt(0);
    limiter.record('a');
    limiter.record('a');

    assert.ok(limiter.retryAfter('a') > 0);
    assert.equal(limiter.retryAfter('b'), 0);
  });

  test('honours a wait that Discord itself asked for', () => {
    const { limiter, advance } = limiterAt(0);
    limiter.block('a', 30_000);

    assert.equal(limiter.retryAfter('a'), 30_000);
    advance(30_000);
    assert.equal(limiter.retryAfter('a'), 0);
  });

  test('forgets channels that are gone', () => {
    const { limiter } = limiterAt(0);
    limiter.record('a');
    limiter.record('a');
    limiter.block('a', 5_000);
    limiter.forget('a');

    assert.equal(limiter.retryAfter('a'), 0);
  });
});

describe('the keyed queue', () => {
  const tick = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

  test('runs tasks with the same key one after another, in order', async () => {
    const queue = new KeyedQueue();
    const events: string[] = [];
    const task = (name: string, ms: number) => async () => {
      events.push(`start ${name}`);
      await tick(ms);
      events.push(`end ${name}`);
    };

    await Promise.all([queue.run('k', task('slow', 20)), queue.run('k', task('fast', 1))]);

    assert.deepEqual(events, ['start slow', 'end slow', 'start fast', 'end fast']);
  });

  test('runs tasks with different keys side by side', async () => {
    const queue = new KeyedQueue();
    const events: string[] = [];

    await Promise.all([
      queue.run('a', async () => {
        await tick(20);
        events.push('a');
      }),
      queue.run('b', async () => {
        events.push('b');
      }),
    ]);

    assert.deepEqual(events, ['b', 'a']);
  });

  test('carries on after a task fails, and hands the failure to whoever queued it', async () => {
    const queue = new KeyedQueue();

    const failing = queue.run('k', async () => {
      throw new Error('boom');
    });
    const next = queue.run('k', async () => 'still running');

    await assert.rejects(failing, /boom/u);
    assert.equal(await next, 'still running');
  });

  test('does not hold on to keys once their work is done', async () => {
    const queue = new KeyedQueue();
    await queue.run('k', async () => undefined);
    await tick(1);

    assert.equal(queue.size, 0);
  });
});
