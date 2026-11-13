import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PermissionFlagsBits as P } from 'discord.js';
import { INVITE_PERMISSIONS } from '../src/permissions.js';
import { createChannelFor, createWorld, destroyWorld, until, type World, type WorldOptions } from './support/harness.js';
import { assertClean, botJoins, music, musicBotIn, playing } from './support/music.js';

async function musicWorld(t: { after: (fn: () => Promise<void>) => void }, options: WorldOptions): Promise<World> {
  const world = await createWorld(options);
  t.after(() => destroyWorld(world));
  return world;
}

test('each voice channel gets a bot of its own until every bot is busy', async (t) => {
  const world = await musicWorld(t, { music: { helpers: 2 } });
  const { fake, lavalink, alice, bob, carol, helpers } = world;
  const dave = fake.addUser('dave');
  for (const title of ['A song', 'B song', 'C song', 'D song']) lavalink!.addTrack({ title });
  const channels = [];
  for (const userId of [alice, bob, carol, dave]) channels.push((await createChannelFor(world, userId)).channelId);

  await music(world, alice, 'play', { query: 'a song' });
  await music(world, bob, 'play', { query: 'b song' });
  await music(world, carol, 'play', { query: 'c song' });

  assert.deepEqual(
    [musicBotIn(world, channels[0]!), musicBotIn(world, channels[1]!), musicBotIn(world, channels[2]!)],
    [helpers[0], helpers[1], fake.botId],
    'helpers first, the main bot last',
  );
  assert.deepEqual(
    [playing(world, helpers[0]!), playing(world, helpers[1]!), playing(world, fake.botId)],
    ['A song', 'B song', 'C song'],
    'each plays what was asked for in its channel',
  );

  const refusal = await music(world, dave, 'play', { query: 'd song' });
  assert.match(refusal, /All my music bots are busy/u);
  for (const channelId of channels.slice(0, 3)) assert.match(refusal, new RegExp(`<#${channelId}>`, 'u'));
  assert.equal(musicBotIn(world, channels[3]!), undefined);

  // Once one is done, it can go elsewhere.
  await music(world, bob, 'stop');
  await until(() => fake.channelOf(helpers[1]!) === null, 'the bot to leave');
  await music(world, dave, 'play', { query: 'd song' });
  assert.equal(await botJoins(world, channels[3]!), helpers[1]);
  assert.equal(playing(world, helpers[1]!), 'D song');
  assertClean(world);
});

test('with no helper bots the main bot plays, in one channel at a time', async (t) => {
  const world = await musicWorld(t, { music: {} });
  const { fake, lavalink, alice, bob } = world;
  lavalink!.addTrack({ title: 'Song' });
  const first = await createChannelFor(world, alice);
  const second = await createChannelFor(world, bob);

  await music(world, alice, 'play', { query: 'song' });
  assert.equal(await botJoins(world, first.channelId), fake.botId);
  assert.match(
    await music(world, bob, 'play', { query: 'song' }),
    new RegExp(`Music is already playing in <#${first.channelId}>, and a bot can only be in one voice channel at a time`, 'u'),
  );
  assert.equal(musicBotIn(world, second.channelId), undefined);

  // Being in voice does not get in the way of the main bot's other work.
  await fake.command(bob, second.channelId, 'voice', 'name', { name: 'Still works' });
  assert.equal(fake.channels.get(second.channelId)?.name, 'Still works');
  assertClean(world);
});

test('requests arriving together never send the same bot to two channels', async (t) => {
  const world = await musicWorld(t, { music: { helpers: 1 } });
  const { fake, lavalink, alice, bob, helpers } = world;
  lavalink!.addTrack({ title: 'Song' });
  const first = await createChannelFor(world, alice);
  const second = await createChannelFor(world, bob);

  await Promise.all([music(world, alice, 'play', { query: 'song' }), music(world, bob, 'play', { query: 'song' })]);

  const bots = [musicBotIn(world, first.channelId), musicBotIn(world, second.channelId)];
  assert.deepEqual(new Set(bots), new Set([helpers[0], fake.botId]));
  assert.equal(fake.voiceRequests.length, 2);
  assertClean(world);
});

test('requests arriving together in one channel share one bot', async (t) => {
  const world = await musicWorld(t, { music: { helpers: 1 } });
  const { fake, lavalink, alice, bob } = world;
  lavalink!.addTrack({ title: 'First' });
  lavalink!.addTrack({ title: 'Second' });
  const { channelId } = await createChannelFor(world, alice);
  await fake.command(alice, channelId, 'voice', 'allow', { user: { user: bob } });
  fake.join(bob, channelId);

  const replies = await Promise.all([music(world, alice, 'play', { query: 'first' }), music(world, bob, 'play', { query: 'second' })]);

  assert.equal(fake.voiceRequests.length, 1, 'one bot was sent');
  assert.equal(replies.filter((reply) => reply.includes('joined')).length, 1, 'and one reply says it joined');
  assert.match(await music(world, alice, 'queue'), /Up next\*\* · 1 track/u);
  assertClean(world);
});

test('a helper that is not in the server is passed over, and admins get a link to invite it', async (t) => {
  const world = await musicWorld(t, { music: { helpers: [{ name: 'outsider', inServer: false }, { name: 'insider' }] } });
  const { fake, lavalink, alice, helpers } = world;
  lavalink!.addTrack({ title: 'Song' });
  const { channelId } = await createChannelFor(world, alice);

  await music(world, alice, 'play', { query: 'song' });
  assert.equal(await botJoins(world, channelId), helpers[1]);

  const forAdmin = await music(world, fake.ownerId, 'bots');
  assert.match(forAdmin, /🟢 \*\*voicebot\*\* is free\./u);
  assert.match(forAdmin, new RegExp(`⚪ \\*\\*outsider\\*\\* is not in this server\\. \\[Invite it\\]\\(<https://discord\\.com/api/oauth2/authorize\\?client_id=${helpers[0]}&scope=bot&permissions=3146752>\\)`, 'u'));
  assert.match(forAdmin, new RegExp(`🎵 \\*\\*insider\\*\\* is playing in <#${channelId}>\\.`, 'u'));
  assert.match(forAdmin, /music in 2 channels at once/u);

  const forMember = await music(world, alice, 'bots');
  assert.match(forMember, /\*\*outsider\*\* is not in this server\.$/mu, 'only admins see invite links');
  assertClean(world);
});

test('a helper whose token is refused is reported and left out', async (t) => {
  const world = await musicWorld(t, { music: { helpers: [{ badToken: true }, {}] } });
  const { lavalink, alice, helpers } = world;
  lavalink!.addTrack({ title: 'Song' });
  const { channelId } = await createChannelFor(world, alice);

  assert.deepEqual(world.log.problems(), [
    'error: Discord rejected the token of music bot #1 (entry 1 of MUSIC_BOT_TOKENS). Carrying on without it.',
  ]);
  await music(world, alice, 'play', { query: 'song' });
  assert.equal(await botJoins(world, channelId), helpers[1]);
  assert.match(await music(world, alice, 'bots'), /🔴 \*\*music bot #1\*\* could not log in to Discord\. Its token may have been reset\./u);
});

test('outside personal channels a bot only goes where its own permissions let it', async (t) => {
  let room = '';
  const world = await musicWorld(t, {
    botPermissions: INVITE_PERMISSIONS,
    music: { helpers: 1 },
    prepare: (fake, { category }) => {
      // Nobody may connect here except, through its role, the main bot.
      room = fake.addVoiceChannel('Members only', {
        parent: category,
        overwrites: [{ id: fake.guildId, type: 'role', deny: P.Connect }],
      });
    },
  });
  const { fake, lavalink, alice, helpers } = world;
  lavalink!.addTrack({ title: 'Song' });
  fake.join(alice, room);

  assert.equal(
    await music(world, alice, 'play', { query: 'song' }),
    `⚠️ I can't play there. <@${helpers[0]}> is missing **Connect** in <#${room}>.`,
    'nothing is changed in channels the bot does not manage',
  );
  assert.equal(fake.voiceRequests.length, 0);

  fake.editChannelByHand(room, {
    permission_overwrites: [
      { id: fake.guildId, type: 0, allow: '0', deny: String(P.Connect) },
      { id: fake.botRoleId, type: 0, allow: String(P.Connect), deny: '0' },
    ],
  });
  await music(world, alice, 'play', { query: 'song' });
  assert.equal(await botJoins(world, room), fake.botId, 'the bot that may go is sent');
  assertClean(world);
});

test('a full channel gets a bot that may still join it', async (t) => {
  const world = await musicWorld(t, { botPermissions: INVITE_PERMISSIONS, music: { helpers: 1 } });
  const { fake, lavalink, alice, lounge } = world;
  lavalink!.addTrack({ title: 'Song' });
  fake.editChannelByHand(lounge, { user_limit: 1 });
  fake.join(alice, lounge);

  await music(world, alice, 'play', { query: 'song' });
  assert.equal(await botJoins(world, lounge), fake.botId, 'Move Members lets the main bot into a full channel; the helper lacks it');
  assertClean(world);
});
