import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createChannelFor, createWorld, destroyWorld, settle, until, type World, type WorldOptions } from './support/harness.js';
import { assertClean, botJoins, music, panelShows, playing, startsPlaying } from './support/music.js';

async function musicWorld(t: { after: (fn: () => Promise<void>) => void }, options: WorldOptions = {}): Promise<World> {
  const world = await createWorld({ music: { helpers: 1 }, ...options });
  t.after(() => destroyWorld(world));
  return world;
}

/**
 * Starts a song in the lounge, an ordinary voice channel the bot does not
 * manage, and waits for the "now playing" message that will say how it ends.
 */
async function playInLounge(world: World, userId = world.alice): Promise<string> {
  world.lavalink!.addTrack({ title: 'Lounge song' });
  world.fake.join(userId, world.lounge);
  return replay(world, userId);
}

async function replay(world: World, userId: string): Promise<string> {
  await music(world, userId, 'play', { query: 'lounge song' });
  const botId = await botJoins(world, world.lounge);
  await startsPlaying(world, botId, 'Lounge song');
  await panelShows(world.fake, world.lounge, /Now playing\*\*\n\*\*\[Lounge song\]/u);
  return botId;
}

test('the bot leaves a channel that nobody is listening in any more', async (t) => {
  const world = await musicWorld(t, { tuning: { musicAloneMs: 150 } });
  const { fake, lavalink, alice, lounge } = world;
  const botId = await playInLounge(world);

  // Coming back in time keeps the music going.
  fake.leave(alice);
  await settle(50);
  fake.join(alice, lounge);
  await settle(200);
  assert.equal(fake.channelOf(botId), lounge);

  fake.leave(alice);
  await until(() => fake.channelOf(botId) === null, 'the bot to leave');
  assert.equal(lavalink!.playerOf(botId, fake.guildId), undefined, 'and its player is gone');
  await panelShows(fake, lounge, new RegExp(`<@${botId}> left because nobody was listening any more`, 'u'));
  assertClean(world);
});

test('the bot leaves after a while with nothing to play', async (t) => {
  const world = await musicWorld(t, { tuning: { musicIdleMs: 150 } });
  const { fake, lavalink, lounge } = world;
  const botId = await playInLounge(world);

  lavalink!.finishTrack(botId, fake.guildId);
  await until(() => fake.channelOf(botId) === null, 'the bot to leave');
  await panelShows(fake, lounge, /left after 150 ms with nothing to play/u);
  assertClean(world);
});

test('music in a personal channel ends with the channel', async (t) => {
  const world = await musicWorld(t);
  const { fake, lavalink, alice, helpers } = world;
  lavalink!.addTrack({ title: 'Song' });
  const { channelId } = await createChannelFor(world, alice);
  await music(world, alice, 'play', { query: 'song' });
  const helper = await botJoins(world, channelId);

  // The bot does not count as company: with its owner gone, the channel goes.
  fake.leave(alice);
  await until(() => !fake.channels.has(channelId), 'the empty channel to be removed');
  await until(() => lavalink!.playerOf(helper, fake.guildId) === undefined, 'the player to be removed');
  assert.equal(fake.channelOf(helper), null);

  // And the bot is free again.
  const next = await createChannelFor(world, alice);
  await music(world, alice, 'play', { query: 'song' });
  assert.equal(await botJoins(world, next.channelId), helpers[0]);
  assertClean(world);
});

test('a bot that a moderator disconnects or drags away stops playing and is free again', async (t) => {
  const world = await musicWorld(t);
  const { fake, lavalink, alice, bob, lounge, hub } = world;
  const botId = await playInLounge(world);

  fake.leave(botId);
  await panelShows(fake, lounge, new RegExp(`<@${botId}> was disconnected from the channel`, 'u'));
  await until(() => lavalink!.playerOf(botId, fake.guildId) === undefined, 'the player to be removed');

  assert.equal(await replay(world, alice), botId);
  fake.join(botId, hub);
  await panelShows(fake, lounge, /was moved to another channel/u);
  await until(() => fake.channelOf(botId) === null, 'the bot to leave the channel it was dragged to');
  assert.deepEqual(fake.membersIn(hub), [], 'it does not stay where it was put');

  fake.join(bob, lounge);
  assert.equal(await replay(world, bob), botId);
  assertClean(world);
});

test('a helper that is kicked from the server stops playing there', async (t) => {
  const world = await musicWorld(t);
  const { fake, lounge } = world;
  const botId = await playInLounge(world);

  fake.kick(botId);
  await panelShows(fake, lounge, /was disconnected from the channel/u);
  assert.match(await music(world, world.alice, 'play', { query: 'lounge song' }), /joined/u);
  assert.equal(await botJoins(world, lounge), fake.botId, 'the main bot takes over');
});

test('a voice server change is passed on to Lavalink', async (t) => {
  const world = await musicWorld(t);
  const { fake, lavalink } = world;
  const botId = await playInLounge(world);
  const before = lavalink!.playerOf(botId, fake.guildId)!.voice!.token;

  fake.newVoiceServer(botId);
  await until(() => lavalink!.playerOf(botId, fake.guildId)!.voice!.token !== before, 'Lavalink to get the new voice server');
  assert.equal(playing(world, botId), 'Lounge song', 'the music carries on');
  assertClean(world);
});

test('an audio connection that does not come back ends the music; one that does, does not', async (t) => {
  const world = await musicWorld(t, { tuning: { voiceRecoveryMs: 150 } });
  const { fake, lavalink, lounge } = world;
  const botId = await playInLounge(world);

  lavalink!.closeVoice(botId, fake.guildId, 4006, 'Session is no longer valid.');
  await settle(50);
  lavalink!.restoreVoice(botId, fake.guildId);
  await settle(250);
  assert.equal(fake.channelOf(botId), lounge, 'a connection that recovered is left alone');

  lavalink!.closeVoice(botId, fake.guildId, 4006, 'Session is no longer valid.');
  await until(() => fake.channelOf(botId) === null, 'the bot to leave');
  await panelShows(fake, lounge, /The audio connection to Discord was lost/u);
  assert.deepEqual(world.log.problems().map((problem) => problem.replace(/ \(close code.*/u, '')), [
    `warn: The audio connection of musicbot1 in guild ${fake.guildId} did not come back`,
  ]);
});

test('Discord not letting the bot into the channel is reported, and nothing is left behind', async (t) => {
  const world = await musicWorld(t, { tuning: { voiceJoinTimeoutMs: 200 } });
  const { fake, lavalink, alice, lounge, helpers } = world;
  lavalink!.addTrack({ title: 'Song' });
  fake.ignoreVoiceRequests(helpers[0]!);
  fake.join(alice, lounge);

  const reply = await music(world, alice, 'play', { query: 'song' });
  assert.match(reply, new RegExp(`<@${helpers[0]}> couldn't join <#${lounge}>: Discord did not let it in`, 'u'));
  assert.deepEqual(
    fake.voiceRequests.map((request) => request.channelId),
    [lounge, null],
    'it asked to join, and when nothing came of it, took the request back',
  );
  assert.equal(lavalink!.playerOf(helpers[0]!, fake.guildId), undefined);
  assert.match(await music(world, alice, 'bots'), /🟢 \*\*musicbot1\*\* is free/u);
});

test('when the connection to Lavalink drops, the music of that bot ends and comes back with the connection', async (t) => {
  const world = await musicWorld(t);
  const { fake, lavalink, alice, lounge } = world;
  const botId = await playInLounge(world);

  lavalink!.dropConnection(botId);
  await panelShows(fake, lounge, /The connection to the music server was lost/u);
  await until(() => fake.channelOf(botId) === null, 'the bot to leave the channel it can no longer play in');
  await until(() => lavalink!.isConnected(botId), 'the bot to reconnect');

  await music(world, alice, 'play', { query: 'lounge song' });
  await startsPlaying(world, (await botJoins(world, lounge)), 'Lounge song');
  assert.deepEqual(world.log.problems(), [
    `warn: musicbot1 lost its connection to the music server at 127.0.0.1:${lavalink!.address.port}: the connection was closed (code 1006). Reconnecting.`,
  ]);
});

test('a music server that is down at startup is waited for, and said so once', async (t) => {
  const world = await musicWorld(t, { music: { helpers: 1, lavalinkDown: true } });
  const { fake, lavalink, alice, lounge } = world;
  lavalink!.addTrack({ title: 'Song' });
  fake.join(alice, lounge);
  await settle(200);

  const port = lavalink!.address.port;
  assert.deepEqual(world.log.problems(), [
    `warn: voicebot cannot connect to the music server at 127.0.0.1:${port}: the connection was refused. Trying again every 50 ms until it works.`,
    `warn: musicbot1 cannot connect to the music server at 127.0.0.1:${port}: the connection was refused. Trying again every 50 ms until it works.`,
  ]);
  assert.match(await music(world, alice, 'play', { query: 'song' }), /can't reach the music server right now/u);

  await lavalink!.start();
  await until(() => world.bot.context.music!.bots.every((bot) => bot.usable), 'the bots to connect');
  assert.match(await music(world, alice, 'play', { query: 'song' }), /Now playing/u);
});

test('a wrong Lavalink password is pointed out', async (t) => {
  const world = await musicWorld(t, { music: { helpers: 0, password: 'not-the-password', waitForLavalink: false } });
  await until(() => world.log.problems().length > 0, 'the problem to be logged');
  await settle(200);
  assert.deepEqual(world.log.problems(), [
    `warn: voicebot cannot connect to the music server at 127.0.0.1:${world.lavalink!.address.port}: the password was rejected. ` +
      'LAVALINK_PASSWORD has to be the password that Lavalink itself is configured with. Trying again every 50 ms until it works.',
  ]);
});

test('a bot left in a voice channel from before a restart leaves it', async (t) => {
  const world = await musicWorld(t, {
    prepare: (fake, { lounge, helpers }) => {
      fake.join(helpers[0]!, lounge);
      fake.join(fake.botId, lounge);
    },
  });
  const { fake, helpers } = world;
  await until(() => fake.channelOf(helpers[0]!) === null && fake.channelOf(fake.botId) === null, 'both bots to leave');
  assertClean(world);
});

test('stopping the bot while music plays goes without complaint', async (t) => {
  const world = await createWorld({ music: { helpers: 1 } });
  t.after(async () => {
    await world.fake.stop();
    await world.lavalink?.stop();
  });
  const { fake, lavalink } = world;
  const botId = await playInLounge(world);

  await world.bot.stop();
  await until(() => !lavalink!.isConnected(botId) && !lavalink!.isConnected(fake.botId), 'the Lavalink connections to close');
  assert.equal(fake.isConnected(botId), false, 'the helper logged off');
  assertClean(world);
});
