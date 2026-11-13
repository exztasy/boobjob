import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PermissionFlagsBits as P } from 'discord.js';
import { INVITE_PERMISSIONS } from '../src/permissions.js';
import { MusicButton } from '../src/ui/ids.js';
import { findComponent, textOf, VOICE_ENDPOINT } from './support/fakeDiscord.js';
import { createChannelFor, createWorld, destroyWorld, settle, until, type World } from './support/harness.js';
import { assertClean, botJoins, music, musicPanelIn, panelShows, playing, startsPlaying } from './support/music.js';

async function musicWorld(t: { after: (fn: () => Promise<void>) => void }, options: Parameters<typeof createWorld>[0] = {}): Promise<World> {
  const world = await createWorld({ music: { helpers: 1 }, ...options });
  t.after(() => destroyWorld(world));
  return world;
}

test('/music play sends a music bot into the voice channel and plays the first search result', async (t) => {
  const world = await musicWorld(t);
  const { fake, lavalink, alice, helpers } = world;
  const helper = helpers[0]!;
  lavalink!.addTrack({ title: 'Something Else', author: 'Nobody' });
  lavalink!.addTrack({ title: 'Never Gonna Give You Up', author: 'Rick Astley', length: 213_000 });
  const { channelId } = await createChannelFor(world, alice);

  const reply = await music(world, alice, 'play', { query: '  never   gonna ' });

  assert.equal(
    reply,
    `🎵 <@${helper}> joined <#${channelId}>.\n` +
      '▶️ Now playing **[Never Gonna Give You Up](https://www.youtube.com/watch?v=track-2)** · Rick Astley · `3:33`',
  );
  assert.deepEqual(lavalink!.loads, ['ytsearch:never gonna'], 'a search, on YouTube unless told otherwise');
  assert.equal(await botJoins(world, channelId), helper, 'a helper plays, so the main bot stays free');
  assert.deepEqual(fake.voiceRequests, [{ botId: helper, channelId, selfMute: false, selfDeaf: true }]);

  const player = lavalink!.playerOf(helper, fake.guildId)!;
  assert.equal(player.track?.info.title, 'Never Gonna Give You Up');
  assert.deepEqual(
    { channelId: player.voice?.channelId, endpoint: player.voice?.endpoint, sessionId: player.voice?.sessionId },
    { channelId, endpoint: VOICE_ENDPOINT, sessionId: `session-${helper}` },
    'Lavalink gets everything it needs to reach Discord, including the channel',
  );

  const panel = await panelShows(fake, channelId, /Never Gonna Give You Up/u);
  assert.match(textOf(panel), new RegExp(`<@${helper}> is playing in this channel`, 'u'));
  assert.match(textOf(panel), new RegExp(`Requested by <@${alice}>`, 'u'));
  assert.deepEqual(panel.mentions, [], 'the music message pings nobody');
  assertClean(world);
});

test('a music bot is let into a hidden personal channel only while it plays there', async (t) => {
  const world = await musicWorld(t);
  const { fake, lavalink, alice, bob, helpers } = world;
  const helper = helpers[0]!;
  lavalink!.addTrack({ title: 'Song' });
  const { channelId } = await createChannelFor(world, alice);
  assert.ok(!fake.canJoin(helper, channelId), 'the channel is hidden from everyone, bots included');

  await music(world, alice, 'play', { query: 'song' });
  assert.ok(fake.canJoin(helper, channelId), 'the bot that plays was let in');
  assert.ok(fake.can(helper, channelId, 1n << 21n), 'and may speak');
  assert.ok(!fake.canSee(bob, channelId), 'nobody else was');

  assert.match(await music(world, alice, 'stop'), /Stopped the music/u);
  await until(() => !fake.canJoin(helper, channelId), 'the access to be taken back');
  assert.equal(fake.channelOf(helper), null, 'the bot left');
  assertClean(world);
});

test('a music bot gets into a personal channel that is full', async (t) => {
  const world = await musicWorld(t);
  const { fake, lavalink, alice, bob, helpers } = world;
  lavalink!.addTrack({ title: 'Song' });
  const { channelId } = await createChannelFor(world, alice);
  await fake.command(alice, channelId, 'voice', 'allow', { user: { user: bob } });
  await fake.command(alice, channelId, 'voice', 'limit', { users: 2 });
  fake.join(bob, channelId);

  await music(world, alice, 'play', { query: 'song' });
  assert.equal(await botJoins(world, channelId), helpers[0]);
  assertClean(world);
});

test('more requests in the same channel queue up behind the current track', async (t) => {
  const world = await musicWorld(t);
  const { fake, lavalink, alice, bob, helpers } = world;
  const helper = helpers[0]!;
  lavalink!.addTrack({ title: 'First song', length: 60_000 });
  lavalink!.addTrack({ title: 'Second song', length: 120_000 });
  lavalink!.addTrack({ title: 'Third song', length: 30_000 });
  const { channelId } = await createChannelFor(world, alice);
  await fake.command(alice, channelId, 'voice', 'allow', { user: { user: bob } });
  fake.join(bob, channelId);

  await music(world, alice, 'play', { query: 'first' });
  assert.match(await music(world, bob, 'play', { query: 'second' }), /Added \*\*\[Second song\].* to the queue at position 1\./u);
  assert.match(await music(world, alice, 'play', { query: 'third' }), /at position 2\./u);
  assert.equal(playing(world, helper), 'First song');
  assert.equal(fake.voiceRequests.length, 1, 'the bot that is there takes the requests; nobody else is sent');

  const queue = await music(world, bob, 'queue');
  assert.match(queue, /\*\*Now playing\*\* · \*\*First song\*\*/u);
  assert.match(queue, /\*\*Up next\*\* · 2 tracks · `2:30`\n1\. \*\*Second song\*\*.*\n2\. \*\*Third song\*\*/u);

  lavalink!.finishTrack(helper, fake.guildId);
  await startsPlaying(world, helper, 'Second song');
  const panel = await panelShows(fake, channelId, /Now playing\*\*\n\*\*\[Second song\]/u);
  assert.match(textOf(panel), new RegExp(`Requested by <@${bob}>`, 'u'));
  assert.match(textOf(panel), /Up next\*\* · 1 track · `0:30`\n1\. \*\*Third song\*\*/u);

  lavalink!.finishTrack(helper, fake.guildId);
  await startsPlaying(world, helper, 'Third song');
  lavalink!.finishTrack(helper, fake.guildId);
  await panelShows(fake, channelId, /Nothing right now/u);
  assert.equal(playing(world, helper), undefined);
  assert.equal(fake.channelOf(helper), channelId, 'the bot waits for more for a while');
  assertClean(world);
});

test('skip, pause, resume, volume, loop, shuffle and remove act on the music in your channel', async (t) => {
  const world = await musicWorld(t);
  const { fake, lavalink, alice, helpers } = world;
  const helper = helpers[0]!;
  for (const title of ['One', 'Two', 'Three', 'Four', 'Five']) lavalink!.addTrack({ title: `Track ${title}` });
  const { channelId } = await createChannelFor(world, alice);
  for (const title of ['One', 'Two', 'Three', 'Four', 'Five']) await music(world, alice, 'play', { query: `track ${title}` });
  const player = () => lavalink!.playerOf(helper, fake.guildId);

  assert.match(await music(world, alice, 'pause'), /Paused/u);
  assert.equal(player()?.paused, true);
  assert.match(await music(world, alice, 'pause'), /already paused/u);
  assert.match(await music(world, alice, 'nowplaying'), /^⏸️ \*\*\[Track One\]/u);
  assert.match(await music(world, alice, 'resume'), /Resumed/u);
  assert.equal(player()?.paused, false);

  assert.match(await music(world, alice, 'volume', { percent: 40 }), /Volume set to 40%/u);
  assert.equal(player()?.volume, 40);

  assert.match(await music(world, alice, 'skip'), /Skipped \*\*\[Track One\].*\n▶️ Now playing \*\*\[Track Two\]/u);
  await startsPlaying(world, helper, 'Track Two');

  assert.match(await music(world, alice, 'remove', { position: 2 }), /Removed \*\*\[Track Four\]/u);
  assert.match(await music(world, alice, 'remove', { position: 9 }), /There is no track at position 9\. 2 tracks are waiting/u);

  assert.match(await music(world, alice, 'loop', { mode: 'track' }), /Repeating the current track/u);
  lavalink!.finishTrack(helper, fake.guildId);
  // One, Two after the skip, and Two once more.
  await until(() => lavalink!.calls.filter((call) => call.method === 'PATCH' && call.body?.track).length === 3, 'the track to start over');
  assert.equal(playing(world, helper), 'Track Two', 'looping a track plays it again');

  assert.match(await music(world, alice, 'loop', { mode: 'queue' }), /Repeating the whole queue/u);
  lavalink!.finishTrack(helper, fake.guildId);
  await startsPlaying(world, helper, 'Track Three');
  assert.match(await music(world, alice, 'queue'), /1\. \*\*Track Five\*\*.*\n2\. \*\*Track Two\*\*/u);

  assert.match(await music(world, alice, 'shuffle'), /Shuffled the 2 waiting tracks/u);
  assert.match(await music(world, alice, 'loop', { mode: 'off' }), /Looping is off/u);

  const panel = await panelShows(fake, channelId, /🔊 40%/u);
  assert.ok(findComponent(panel, MusicButton.Shuffle), 'the panel has the controls');
  assertClean(world);
});

test('controlling the music takes being in its channel', async (t) => {
  const world = await musicWorld(t);
  const { fake, lavalink, alice, bob, carol, lounge } = world;
  lavalink!.addTrack({ title: 'Song' });
  await createChannelFor(world, alice);

  assert.match(await music(world, bob, 'skip'), /Nothing is playing right now\. Join a voice channel/u);
  assert.match(await music(world, bob, 'play', { query: 'song' }), /Join a voice channel first/u);

  await music(world, alice, 'play', { query: 'song' });
  assert.match(await music(world, bob, 'stop'), /Join the voice channel the music is playing in/u);
  fake.join(carol, lounge);
  assert.match(await music(world, carol, 'pause'), new RegExp(`Nothing is playing in <#${lounge}>`, 'u'));
  assert.match(await music(world, alice, 'pause'), /Paused/u);
  assertClean(world);
});

test('a playlist link queues the whole playlist, starting with the track the link points at', async (t) => {
  const world = await musicWorld(t);
  const { lavalink, alice, helpers } = world;
  const url = 'https://www.youtube.com/watch?v=abc&list=PL123';
  lavalink!.addPlaylist(
    'Road *trip*',
    [{ title: 'A' }, { title: 'B' }, { title: 'C' }, { title: 'D' }],
    { uri: url, selectedTrack: 2 },
  );
  await createChannelFor(world, alice);

  const reply = await music(world, alice, 'play', { query: `<${url}>` });
  assert.deepEqual(lavalink!.loads, [url], 'links are passed on as they are');
  assert.match(reply, /Added 4 tracks from \*\*Road \\\*trip\\\*\*\* to the queue\.\n▶️ Now playing \*\*\[C\]/u);
  assert.equal(playing(world, helpers[0]!), 'C');
  assert.match(await music(world, alice, 'queue'), /3 tracks.*\n1\. \*\*D\*\*.*\n2\. \*\*A\*\*.*\n3\. \*\*B\*\*/u);
  assertClean(world);
});

test('searches go where they are asked to, and say so when nothing turns up', async (t) => {
  const world = await musicWorld(t);
  const { lavalink, alice } = world;
  lavalink!.addTrack({ title: 'Cloud song', source: 'soundcloud' });
  await createChannelFor(world, alice);

  assert.match(await music(world, alice, 'play', { query: 'cloud', source: 'youtube' }), /couldn't find anything for "cloud" on YouTube/u);
  assert.match(await music(world, alice, 'play', { query: 'cloud', source: 'soundcloud' }), /Now playing \*\*\[Cloud song\]/u);
  await music(world, alice, 'play', { query: 'anything', source: 'spotify' });
  await music(world, alice, 'play', { query: 'anything', source: 'youtubemusic' });
  assert.match(await music(world, alice, 'play', { query: 'https://example.com/nothing.mp3' }), /couldn't find anything to play at that link/u);
  assert.match(await music(world, alice, 'play', { query: 'file:///etc/passwd' }), /couldn't find anything for "file:\/\/\/etc\/passwd"/u);
  assert.deepEqual(lavalink!.loads, [
    'ytsearch:cloud',
    'scsearch:cloud',
    'spsearch:anything',
    'ytmsearch:anything',
    'https://example.com/nothing.mp3',
    'ytsearch:file:///etc/passwd',
  ]);
  assertClean(world);
});

test('what Lavalink says about a link it cannot load is passed on when it is meant for people', async (t) => {
  const world = await musicWorld(t);
  const { lavalink, alice } = world;
  await createChannelFor(world, alice);
  lavalink!.respondTo('https://www.youtube.com/watch?v=private', {
    loadType: 'error',
    data: { message: 'This video is private.', severity: 'common', cause: 'x', causeStackTrace: 'x' },
  });
  lavalink!.respondTo('https://www.youtube.com/watch?v=broken', {
    loadType: 'error',
    data: { message: 'NullPointerException at line 42', severity: 'fault', cause: 'x', causeStackTrace: 'x' },
  });

  assert.match(await music(world, alice, 'play', { query: 'https://www.youtube.com/watch?v=private' }), /couldn't load that: This video is private\./u);
  assert.match(
    await music(world, alice, 'play', { query: 'https://www.youtube.com/watch?v=broken' }),
    /couldn't load that: the music server could not play it\./u,
  );
  assert.equal(world.log.problems().length, 2, 'both are logged in full');
  assert.equal(anyBotInVoice(world), undefined, 'no bot was sent for nothing');
});

function anyBotInVoice(world: World): string | undefined {
  return [...world.helpers, world.fake.botId].find((botId) => world.fake.channelOf(botId) !== null);
}

test('a track that cannot be played is skipped, and the channel is told why', async (t) => {
  const world = await musicWorld(t);
  const { fake, lavalink, alice, helpers } = world;
  const helper = helpers[0]!;
  lavalink!.addTrack({ title: 'Blocked song' });
  lavalink!.addTrack({ title: 'Good song' });
  const { channelId } = await createChannelFor(world, alice);
  await music(world, alice, 'play', { query: 'blocked' });
  await music(world, alice, 'play', { query: 'good' });

  lavalink!.failTrack(helper, fake.guildId, { message: 'This video is not available in your country.', severity: 'common' });
  await startsPlaying(world, helper, 'Good song');
  const panel = await panelShows(fake, channelId, /⚠️ Skipped \*\*\[Blocked song\].*: This video is not available in your country\./u);
  assert.match(textOf(panel), /Now playing\*\*\n\*\*\[Good song\]/u);

  lavalink!.finishTrack(helper, fake.guildId);
  await panelShows(fake, channelId, /Nothing right now/u);
  assert.doesNotMatch(textOf(musicPanelIn(fake, channelId)!), /⚠️/u, 'the warning goes once something played through');
  assert.equal(world.log.problems().length, 1, 'the failure is logged');
});

test('a stuck track is skipped', async (t) => {
  const world = await musicWorld(t);
  const { fake, lavalink, alice, helpers } = world;
  const helper = helpers[0]!;
  lavalink!.addTrack({ title: 'Stuck song' });
  lavalink!.addTrack({ title: 'Next song' });
  const { channelId } = await createChannelFor(world, alice);
  await music(world, alice, 'play', { query: 'stuck' });
  await music(world, alice, 'play', { query: 'next' });

  lavalink!.stickTrack(helper, fake.guildId);
  await startsPlaying(world, helper, 'Next song');
  await panelShows(fake, channelId, /Skipped \*\*\[Stuck song\].*: it stopped sending audio/u);
});

test('after five tracks in a row fail, playback stops instead of working through the whole queue', async (t) => {
  const world = await musicWorld(t);
  const { fake, lavalink, alice, helpers } = world;
  const helper = helpers[0]!;
  const tracks = Array.from({ length: 7 }, (_, index) => `Broken ${index + 1}`);
  lavalink!.addPlaylist('Broken', tracks.map((title) => ({ title })), { uri: 'https://soundcloud.com/x/sets/broken' });
  const { channelId } = await createChannelFor(world, alice);
  await music(world, alice, 'play', { query: 'https://soundcloud.com/x/sets/broken' });

  for (let index = 1; index <= 5; index++) {
    await startsPlaying(world, helper, `Broken ${index}`);
    lavalink!.failTrack(helper, fake.guildId, { message: 'Gone.', severity: 'common' });
  }
  const panel = await panelShows(fake, channelId, /Stopped after 5 tracks in a row could not be played/u);
  assert.match(textOf(panel), /Up next\*\* · 2 tracks/u, 'what is left stays queued');
  await settle();
  assert.equal(playing(world, helper), undefined);

  assert.match(await music(world, alice, 'skip'), /Now playing \*\*\[Broken 6\]/u, 'and can be started again');
});

test('the buttons under the music message control the music', async (t) => {
  const world = await musicWorld(t);
  const { fake, lavalink, alice, bob, helpers } = world;
  const helper = helpers[0]!;
  for (const title of ['One', 'Two', 'Three']) lavalink!.addTrack({ title });
  const { channelId } = await createChannelFor(world, alice);
  for (const title of ['One', 'Two', 'Three']) await music(world, alice, 'play', { query: title });
  let panel = await panelShows(fake, channelId, /Up next\*\* · 2 tracks/u);

  let result = await fake.click(alice, panel, MusicButton.Toggle);
  assert.equal(lavalink!.playerOf(helper, fake.guildId)?.paused, true);
  assert.match(textOf(result.message!), /⏸️ Paused/u, 'the message shows the outcome straight away');
  assert.equal(findComponent(result.message!, MusicButton.Toggle)?.label, 'Resume');

  result = await fake.click(alice, result.message!, MusicButton.Toggle);
  assert.equal(lavalink!.playerOf(helper, fake.guildId)?.paused, false);

  result = await fake.click(alice, result.message!, MusicButton.Skip);
  await startsPlaying(world, helper, 'Two');
  assert.match(textOf(result.message!), /Now playing\*\*\n\*\*\[Two\]/u);

  result = await fake.click(alice, result.message!, MusicButton.Loop);
  assert.equal(findComponent(result.message!, MusicButton.Loop)?.label, 'Loop: track');
  result = await fake.click(alice, result.message!, MusicButton.Loop);
  assert.equal(findComponent(result.message!, MusicButton.Loop)?.label, 'Loop: queue');

  // Someone who is not in the channel cannot touch it.
  await fake.command(alice, channelId, 'voice', 'allow', { user: { user: bob } });
  const refused = await fake.click(bob, result.message!, MusicButton.Stop);
  assert.match(textOf(refused.message!), /Join this voice channel to control the music in it/u);
  assert.equal(fake.channelOf(helper), channelId);

  assert.equal(findComponent(result.message!, MusicButton.Shuffle)?.disabled, true, 'nothing to shuffle with one track waiting');

  result = await fake.click(alice, result.message!, MusicButton.Stop);
  await until(() => fake.channelOf(helper) === null, 'the bot to leave');
  panel = musicPanelIn(fake, channelId)!;
  assert.match(textOf(panel), new RegExp(`Stopped by <@${alice}>`, 'u'));
  assert.equal(findComponent(panel, MusicButton.Toggle), undefined, 'the controls are gone');
  assertClean(world);
});

test('the controls of music that is over are cleared away when someone presses them', async (t) => {
  const world = await musicWorld(t);
  const { fake, lavalink, alice } = world;
  lavalink!.addTrack({ title: 'Song' });
  const { channelId } = await createChannelFor(world, alice);
  await music(world, alice, 'play', { query: 'song' });
  const panel = await panelShows(fake, channelId, /Song/u);
  const stale = structuredClone(panel);
  await music(world, alice, 'stop');

  const result = await fake.click(alice, stale, MusicButton.Skip);
  assert.match(textOf(result.message!), /The music has stopped/u);
  assert.equal(findComponent(result.message!, MusicButton.Skip), undefined);
  assertClean(world);
});

test('long, oddly formatted titles still fit into every message', async (t) => {
  const world = await musicWorld(t, { music: { helpers: 3 } });
  const { fake, lavalink, alice } = world;
  const url = 'https://www.youtube.com/playlist?list=PLodd';
  lavalink!.addPlaylist(
    '*'.repeat(200),
    Array.from({ length: 30 }, (_, index) => ({
      title: `${'*_`|'.repeat(30)} ${index}`,
      author: '\\'.repeat(60),
      length: 36_000_000,
      uri: `https://x.example/${'(a)'.repeat(60)}`,
    })),
    { uri: url },
  );
  const { channelId } = await createChannelFor(world, alice);

  await music(world, alice, 'play', { query: url });
  await music(world, alice, 'queue');
  await music(world, alice, 'queue', { page: 3 });
  await music(world, alice, 'nowplaying');
  await music(world, fake.ownerId, 'bots');
  await panelShows(fake, channelId, /Up next\*\* · 29 tracks/u);
  assertClean(world);
});

test('music plays where the bot may not post its message', async (t) => {
  const world = await musicWorld(t, {
    botPermissions: INVITE_PERMISSIONS,
    prepare: (fake, { lounge }) => {
      fake.editChannelByHand(lounge, {
        permission_overwrites: [{ id: fake.botRoleId, type: 0, allow: '0', deny: String(P.SendMessages) }],
      });
    },
  });
  const { fake, lavalink, alice, lounge, helpers } = world;
  lavalink!.addTrack({ title: 'Song' });
  fake.join(alice, lounge);

  assert.match(await music(world, alice, 'play', { query: 'song' }), /Now playing/u);
  await startsPlaying(world, helpers[0]!, 'Song');
  await settle(50);
  assert.equal(musicPanelIn(fake, lounge), undefined);
  assert.deepEqual(fake.requestsTo('POST', new RegExp(`/channels/${lounge}/messages`, 'u')).length, 1, 'it tried once, not on every change');
  assert.match(await music(world, alice, 'skip'), /last track/u);
  assertClean(world);
});
