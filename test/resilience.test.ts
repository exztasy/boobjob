import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { PermissionFlagsBits as P } from 'discord.js';
import { INVITE_PERMISSIONS } from '../src/permissions.js';
import { PanelButton, SelectId } from '../src/ui/ids.js';
import { textOf } from './support/fakeDiscord.js';
import {
  channelOwnedBy,
  createChannelFor,
  createWorld,
  destroyWorld,
  settle,
  startBot,
  until,
  type World,
} from './support/harness.js';

function assertClean(world: Pick<World, 'fake' | 'log'>): void {
  assert.deepEqual(world.fake.unexpected, [], 'requests the fake does not know');
  assert.deepEqual(world.fake.rejected, [], 'payloads Discord would reject');
  assert.deepEqual(world.log.problems(), [], 'warnings and errors logged by the bot');
}

function databaseFile(t: TestContext): string {
  const directory = mkdtempSync(path.join(tmpdir(), 'voice-bot-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return path.join(directory, 'bot.sqlite');
}

const CREATE_CHANNEL = /^\/guilds\/\d+\/channels$/u;

// ── restarts ──────────────────────────────────────────────────────────────

test('after a restart the bot catches up on everything that happened while it was offline', async (t) => {
  const databasePath = databaseFile(t);
  const world = await createWorld({ databasePath });
  const { fake, alice, bob, carol, hub } = world;
  t.after(() => fake.stop());
  const emptied = await createChannelFor(world, alice);
  const deleted = await createChannelFor(world, carol);
  await world.bot.stop();

  fake.leave(alice); // her channel is now empty
  fake.join(bob, hub); // bob is waiting for a channel
  fake.deleteChannelByHand(deleted.channelId); // an admin deleted carol's channel

  const restarted = await startBot(fake, { databasePath });
  t.after(() => restarted.bot.stop());

  await until(() => !fake.channels.has(emptied.channelId), 'the emptied channel to be removed');
  await until(() => {
    const current = fake.channelOf(bob);
    return current !== null && current !== hub;
  }, 'bob to be given a channel');
  await until(() => restarted.bot.store.getTempChannel(deleted.channelId) === undefined, 'the deleted channel to be forgotten');
  await until(() => restarted.bot.store.listTempChannels(fake.guildId).length === 1, "bob's channel to be the only one on record");
  assert.equal(restarted.bot.store.getTempChannelByOwner(fake.guildId, bob)?.channelId, fake.channelOf(bob));
  assertClean({ fake, log: restarted.log });
});

test('a channel and its panel keep working across a restart, and saved settings survive it', async (t) => {
  const databasePath = databaseFile(t);
  const world = await createWorld({ databasePath });
  const { fake, alice, bob } = world;
  t.after(() => fake.stop());
  const { channelId, panel } = await createChannelFor(world, alice);
  const allowMenu = await fake.click(alice, panel, PanelButton.Allowed);
  await fake.chooseUsers(alice, allowMenu.message!, SelectId.Allowed, [bob]);
  await world.bot.stop();

  const restarted = await startBot(fake, { databasePath });
  t.after(() => restarted.bot.stop());
  await settle();
  assert.ok(fake.channels.has(channelId), 'a channel in use is left alone');

  const { modal } = await fake.click(alice, panel, PanelButton.Limit);
  await fake.submit(alice, channelId, modal!, { limit: '8' });
  assert.equal(fake.channels.get(channelId)!.user_limit, 8);
  await until(() => textOf(fake.panelIn(channelId)!).includes('8 users'), 'the old panel to be updated');

  fake.leave(alice);
  await until(() => !fake.channels.has(channelId), 'the channel to be removed');
  fake.join(alice, world.hub);
  await until(() => fake.channelOf(alice) !== null && fake.channelOf(alice) !== world.hub, 'alice to get a new channel');
  const recreated = fake.channelOf(alice)!;
  assert.equal(fake.channels.get(recreated)!.user_limit, 8);
  assert.ok(fake.canJoin(bob, recreated), 'the allowed list survived as well');
  assertClean({ fake, log: restarted.log });
});

test('a mute that should have been lifted while the bot was offline is lifted when it comes back', async (t) => {
  const databasePath = databaseFile(t);
  const world = await createWorld({ databasePath });
  const { fake, alice, bob, lounge } = world;
  t.after(() => fake.stop());
  const { channelId, panel } = await createChannelFor(world, alice);
  await fake.click(alice, panel, PanelButton.privacy('public'));
  fake.join(bob, channelId);
  await settle(10);
  const muteMenu = await fake.click(alice, panel, PanelButton.Mute);
  await fake.choose(alice, muteMenu.message!, SelectId.Mute, [bob]);
  await world.bot.stop();

  fake.join(bob, lounge);
  assert.equal(fake.voiceOf(bob).mute, true, 'nobody was there to lift it');

  const restarted = await startBot(fake, { databasePath });
  t.after(() => restarted.bot.stop());
  await until(() => fake.voiceOf(bob).mute === false, 'the stale mute to be lifted');
  assertClean({ fake, log: restarted.log });
});

// ── timing ────────────────────────────────────────────────────────────────

test('people joining the hub at the same moment each get a channel of their own', async (t) => {
  const world = await createWorld();
  t.after(() => destroyWorld(world));
  const { fake, alice, bob, carol, hub } = world;

  for (const userId of [alice, bob, carol]) fake.join(userId, hub);

  await until(
    () => [alice, bob, carol].every((userId) => fake.channelOf(userId) === channelOwnedBy(world, userId) && fake.channelOf(userId) !== null),
    'everyone to be in their own channel',
  );
  assert.equal(new Set([alice, bob, carol].map((userId) => fake.channelOf(userId))).size, 3);
  assertClean(world);
});

test('someone who leaves before their channel is ready is not left with an orphaned channel', async (t) => {
  const world = await createWorld();
  t.after(() => destroyWorld(world));
  const { fake, bot, alice, hub } = world;
  const channelsBefore = fake.channels.size;

  fake.delayNext('POST', CREATE_CHANNEL, 60);
  fake.join(alice, hub);
  await settle(15);
  fake.leave(alice);

  await until(() => fake.requestsTo('DELETE', /^\/channels\/\d+$/u).length === 1, 'the unused channel to be removed');
  await settle();
  assert.equal(fake.channels.size, channelsBefore);
  assert.equal(bot.store.listTempChannels(fake.guildId).length, 0);
  assert.equal(fake.requestsTo('PATCH', new RegExp(`/members/${alice}$`, 'u')).length, 0, 'nobody tried to move her');
  assertClean(world);
});

test('someone who wanders into another channel while theirs is being made is left where they are', async (t) => {
  const world = await createWorld();
  t.after(() => destroyWorld(world));
  const { fake, bot, alice, hub, lounge } = world;

  fake.delayNext('POST', CREATE_CHANNEL, 60);
  fake.join(alice, hub);
  await settle(15);
  fake.join(alice, lounge);

  await until(() => fake.requestsTo('DELETE', /^\/channels\/\d+$/u).length === 1, 'the unused channel to be removed');
  await settle();
  assert.equal(fake.channelOf(alice), lounge, 'she was not pulled out of the channel she chose');
  assert.equal(bot.store.listTempChannels(fake.guildId).length, 0);
  assertClean(world);
});

test('hopping in and out of the hub does not pile up channels', async (t) => {
  const world = await createWorld();
  t.after(() => destroyWorld(world));
  const { fake, bot, alice, hub, lounge } = world;
  const channelsBefore = fake.channels.size;

  for (let round = 0; round < 5; round++) {
    fake.join(alice, hub);
    await settle(3);
    fake.join(alice, lounge);
    await settle(3);
  }
  fake.join(alice, hub);

  await until(() => fake.channelOf(alice) === channelOwnedBy(world, alice) && fake.channelOf(alice) !== null, 'alice to end up in her channel');
  await until(() => fake.channels.size === channelsBefore + 1, 'every channel but hers to be cleaned up');
  await settle();
  assert.equal(bot.store.listTempChannels(fake.guildId).length, 1);
  assert.equal(fake.channels.size, channelsBefore + 1);
  assertClean(world);
});

test('an owner who is alone and goes back to the hub gets a fresh channel', async (t) => {
  const world = await createWorld();
  t.after(() => destroyWorld(world));
  const { fake, bot, alice, hub } = world;
  const first = await createChannelFor(world, alice);

  fake.join(alice, hub);

  await until(() => {
    const current = fake.channelOf(alice);
    return current !== null && current !== hub && current !== first.channelId;
  }, 'alice to be moved into a new channel');
  await until(() => !fake.channels.has(first.channelId), 'the old channel to be removed');
  assert.equal(bot.store.listTempChannels(fake.guildId).length, 1);
  assertClean(world);
});

test('a clean-up pass that runs while a channel is being set up leaves it alone', async (t) => {
  const world = await createWorld();
  t.after(() => destroyWorld(world));
  const { fake, bot, alice, hub } = world;

  // The channel exists, but moving alice into it takes a moment, so it is empty for now.
  fake.delayNext('PATCH', new RegExp(`/members/${alice}$`, 'u'), 80);
  fake.join(alice, hub);
  await until(() => bot.store.listTempChannels(fake.guildId).length === 1, 'the channel to be created');
  assert.equal(fake.channelOf(alice), hub, 'alice has not been moved yet');

  await bot.context.channels.sweep();

  await until(() => fake.channelOf(alice) === channelOwnedBy(world, alice), 'alice to arrive in her channel');
  // The clean-up pass also saw alice waiting in the hub and asked for a channel for her.
  // Give that request time to run: it must find her already served.
  await settle(150);
  assert.equal(fake.requestsTo('POST', CREATE_CHANNEL).length, 1, 'no second channel was made for her');
  assert.equal(fake.requestsTo('DELETE', /^\/channels\/\d+$/u).length, 0, 'the half-ready channel was not removed');
  assertClean(world);
});

test('creating channels back to back is slowed down by the cooldown', async (t) => {
  const world = await createWorld({ tuning: { createCooldownMs: 250 } });
  t.after(() => destroyWorld(world));
  const { fake, alice, hub } = world;
  const first = await createChannelFor(world, alice);
  fake.leave(alice);
  await until(() => !fake.channels.has(first.channelId), 'the first channel to be removed');
  const creationsBefore = fake.requestsTo('POST', CREATE_CHANNEL).length;

  fake.join(alice, hub);
  await settle(100);
  assert.equal(fake.requestsTo('POST', CREATE_CHANNEL).length, creationsBefore, 'nothing is created during the cooldown');
  assert.equal(fake.channelOf(alice), hub);

  await until(() => fake.channelOf(alice) !== hub && fake.channelOf(alice) !== null, 'the channel to be created once the cooldown is over');
  assertClean(world);
});

// ── things going wrong ────────────────────────────────────────────────────

test('if the bot lacks a permission it needs, the member is told in the hub chat instead of getting an unprotected channel', async (t) => {
  const world = await createWorld({
    botPermissions: INVITE_PERMISSIONS & ~P.ManageRoles,
    tuning: { failureNoticeTtlMs: 80 },
  });
  t.after(() => destroyWorld(world));
  const { fake, bot, alice, hub } = world;

  fake.join(alice, hub);

  await until(() => fake.messagesIn(hub).length === 1, 'a notice in the hub chat');
  const notice = fake.messagesIn(hub)[0]!;
  assert.match(notice.content, new RegExp(`<@${alice}> I couldn't create your voice channel`, 'u'));
  assert.match(notice.content, /My role is missing these permissions: \*\*Manage Roles\*\*/u);
  assert.deepEqual(notice.mentions.map((user: { id: string }) => user.id), [alice]);
  assert.equal(fake.requestsTo('POST', CREATE_CHANNEL).length, 0, 'no channel was attempted');
  assert.equal(bot.store.listTempChannels(fake.guildId).length, 0);
  assert.equal(fake.channelOf(alice), hub);

  await until(() => fake.messagesIn(hub).length === 0, 'the notice to be cleaned up again');
  assert.deepEqual(fake.unexpected, []);
  assert.equal(world.log.entries.filter((entry) => entry.level === 'error').length, 1, 'and the problem is logged for the admin');
});

test('a saved setting the server no longer accepts does not stop the channel from being created', async (t) => {
  const world = await createWorld();
  t.after(() => destroyWorld(world));
  const { fake, bot, alice, hub } = world;
  // Saved while the server was boosted and the region still existed.
  bot.store.updateProfile(fake.guildId, alice, { name: 'Movie night', userLimit: 4, rtcRegion: 'atlantis' });

  fake.join(alice, hub);

  await until(() => fake.channelOf(alice) !== hub && fake.channelOf(alice) !== null, 'alice to get a channel anyway');
  const channel = fake.channels.get(fake.channelOf(alice)!)!;
  assert.equal(channel.name, 'Movie night', 'what can be kept is kept');
  assert.equal(channel.user_limit, 4);
  assert.equal(channel.rtc_region, null);
  assert.ok(!fake.canSee(world.bob, channel.id), 'and the channel is still private');
  assert.equal(fake.rejected.length, 1);
  assert.equal(world.log.entries.filter((entry) => entry.level === 'warn').length, 1);
});

test('a saved name the server now rejects falls back to the default name', async (t) => {
  const world = await createWorld();
  t.after(() => destroyWorld(world));
  const { fake, bot, alice, hub } = world;
  bot.store.updateProfile(fake.guildId, alice, { name: 'Filtered words' });
  const invalid = { code: 50035, message: 'Invalid Form Body' };
  fake.failNext('POST', CREATE_CHANNEL, 400, invalid);
  fake.failNext('POST', CREATE_CHANNEL, 400, invalid);

  fake.join(alice, hub);

  await until(() => fake.channelOf(alice) !== hub && fake.channelOf(alice) !== null, 'alice to get a channel anyway');
  assert.equal(fake.channels.get(fake.channelOf(alice)!)!.name, "alice's channel");
});

test('if Discord refuses a channel because of the saved lists, the member still gets one and is told the lists were cleared', async (t) => {
  const world = await createWorld();
  t.after(() => destroyWorld(world));
  const { fake, bot, alice, bob, carol, hub } = world;
  bot.store.updateProfile(fake.guildId, alice, { name: 'Movie night' });
  bot.store.changeProfileAccess(fake.guildId, alice, 'allow', [bob], []);
  bot.store.changeProfileAccess(fake.guildId, alice, 'block', [carol], []);
  // Every attempt that includes the lists is refused, whatever the name and settings.
  const invalid = { code: 50035, message: 'Invalid Form Body' };
  for (let attempt = 0; attempt < 4; attempt++) fake.failNext('POST', CREATE_CHANNEL, 400, invalid);

  fake.join(alice, hub);

  await until(() => fake.channelOf(alice) !== hub && fake.channelOf(alice) !== null, 'alice to get a channel anyway');
  const channelId = fake.channelOf(alice)!;
  assert.equal(fake.channels.get(channelId)!.name, 'Voice channel', 'the plainest channel possible');
  assert.equal(bot.store.getProfile(fake.guildId, alice)?.name, 'Movie night', 'the saved name is kept for next time');
  assert.ok(!fake.canSee(bob, channelId), 'the channel is private, just without the lists');
  assert.deepEqual(bot.store.getChannelAccess(channelId), { allowed: [], blocked: [] });
  assert.deepEqual(bot.store.getProfileAccess(fake.guildId, alice), { allowed: [], blocked: [] }, 'so the next channel is not held up again');
  await until(
    () => fake.messagesIn(channelId).some((message) => /did not accept your saved allowed and blocked lists/u.test(message.content)),
    'the owner to be told',
  );
});

test('when the server is out of channels the member is told why', async (t) => {
  const world = await createWorld();
  t.after(() => destroyWorld(world));
  const { fake, alice, hub } = world;
  fake.failNext('POST', CREATE_CHANNEL, 400, { code: 30013, message: 'Maximum number of guild channels reached (500)' });

  fake.join(alice, hub);

  await until(() => fake.messagesIn(hub).length === 1, 'a notice in the hub chat');
  assert.match(fake.messagesIn(hub)[0]!.content, /This server has reached the maximum number of channels/u);
});

test('an empty channel that could not be deleted is removed by the next sweep', async (t) => {
  const world = await createWorld();
  t.after(() => destroyWorld(world));
  const { fake, bot, alice } = world;
  const { channelId } = await createChannelFor(world, alice);
  fake.failNext('DELETE', new RegExp(`^/channels/${channelId}$`, 'u'), 403, { code: 50013, message: 'Missing Permissions' });

  fake.leave(alice);
  await until(() => world.log.entries.some((entry) => entry.level === 'error'), 'the failed deletion to be logged');
  assert.ok(fake.channels.has(channelId));
  assert.ok(bot.store.getTempChannel(channelId), 'the channel stays on record so it is not forgotten');

  await bot.context.channels.sweep();

  assert.ok(!fake.channels.has(channelId));
  assert.equal(bot.store.getTempChannel(channelId), undefined);
});

// ── the connection to Discord ─────────────────────────────────────────────

test('shutting down does not hang when Discord has stopped answering', async (t) => {
  const world = await createWorld({ tuning: { shutdownTimeoutMs: 150 } });
  t.after(() => world.fake.stop());
  const { fake, bot } = world;
  fake.freezeGateway();

  const startedAt = Date.now();
  await bot.stop();
  const took = Date.now() - startedAt;

  assert.ok(took >= 140, `it gave Discord its chance to confirm (${took} ms)`);
  assert.ok(took < 2_000, `but did not wait for long (${took} ms)`);
  assert.throws(() => bot.store.listHubs(fake.guildId), 'the database has been closed');
  assert.ok(world.log.problems().some((problem) => /did not confirm the disconnect/u.test(problem)), 'and the reason is logged');
  await bot.stop(); // asking twice is harmless
});

test('shutting down is immediate when Discord answers', async (t) => {
  const world = await createWorld();
  t.after(() => world.fake.stop());

  const startedAt = Date.now();
  await world.bot.stop();

  assert.ok(Date.now() - startedAt < 1_000);
  assert.deepEqual(world.log.problems(), []);
});

test('the caller is told when Discord closes the connection for good', async (t) => {
  const reported: number[] = [];
  const world = await createWorld({ onFatalDisconnect: (closeCode) => reported.push(closeCode) });
  t.after(() => destroyWorld(world));

  // What Discord does to a connected bot whose token has just been reset.
  world.fake.closeGateway(4004, 'Authentication failed.');

  await until(() => reported.length > 0, 'the fatal disconnect to be reported');
  assert.deepEqual(reported, [4004]);
});

test('an ordinary dropped connection is not treated as fatal, and the bot carries on after reconnecting', async (t) => {
  const reported: number[] = [];
  const world = await createWorld({ onFatalDisconnect: (closeCode) => reported.push(closeCode) });
  t.after(() => destroyWorld(world));
  const { fake, alice } = world;

  fake.closeGateway(4000, 'Unknown error.');
  await until(() => fake.gatewayConnections === 2, 'the bot to reconnect', 10_000);

  const { channelId } = await createChannelFor(world, alice);
  assert.ok(fake.channels.has(channelId));
  assert.deepEqual(reported, []);
});

// ── changes made behind the bot's back ────────────────────────────────────

test('a hub that is deleted stops being a hub', async (t) => {
  const world = await createWorld();
  t.after(() => destroyWorld(world));
  const { fake, bot, hub } = world;

  fake.deleteChannelByHand(hub);

  await until(() => bot.store.getHub(hub) === undefined, 'the hub to be forgotten');
});

test('a personal channel that is deleted by hand is forgotten, and its owner can get a new one', async (t) => {
  const world = await createWorld();
  t.after(() => destroyWorld(world));
  const { fake, bot, alice } = world;
  const first = await createChannelFor(world, alice);

  fake.deleteChannelByHand(first.channelId);
  await until(() => bot.store.getTempChannel(first.channelId) === undefined, 'the channel to be forgotten');
  assert.equal(fake.channelOf(alice), null, 'Discord disconnects whoever was inside');

  const second = await createChannelFor(world, alice);
  assert.notEqual(second.channelId, first.channelId);
  assertClean(world);
});

test('controls of a channel the bot no longer manages say so', async (t) => {
  const world = await createWorld();
  t.after(() => destroyWorld(world));
  const { fake, bot, alice } = world;
  const { channelId, panel } = await createChannelFor(world, alice);
  bot.store.deleteTempChannel(channelId);

  const result = await fake.click(alice, panel, PanelButton.Kick);

  assert.match(result.message!.content, /a voice channel that I no longer manage/u);
});

// ── bots ──────────────────────────────────────────────────────────────────

test('a bot joining the hub gets no channel, and a bot alone does not keep one alive', async (t) => {
  const music: { id?: string } = {};
  const world = await createWorld({
    prepare: (fake) => {
      music.id = fake.addUser('music', { bot: true });
    },
  });
  t.after(() => destroyWorld(world));
  const { fake, alice, hub } = world;

  fake.join(music.id!, hub);
  await settle();
  assert.equal(fake.channelOf(music.id!), hub);
  assert.equal(fake.requestsTo('POST', CREATE_CHANNEL).length, 0);

  const { channelId } = await createChannelFor(world, alice);
  fake.join(music.id!, channelId);
  await settle(10);
  fake.leave(alice);

  await until(() => !fake.channels.has(channelId), 'the channel to be removed although the music bot was still in it');
  assert.equal(fake.channelOf(music.id!), null);
  assertClean(world);
});

// ── a bot without Administrator, on a server with real-world permissions ──

test('with only the invited permissions the bot runs private channels on a server that gates its voice category', async (t) => {
  const ids: { member?: string; muted?: string; moderator?: string; outsider?: string; mod?: string } = {};
  const world = await createWorld({
    botPermissions: INVITE_PERMISSIONS,
    // Nobody can do anything until a role says so.
    everyonePermissions: P.ViewChannel | P.SendMessages | P.ReadMessageHistory,
    prepare: (fake, standard) => {
      ids.member = fake.addRole('Member', P.Connect | P.Speak);
      ids.muted = fake.addRole('Muted');
      ids.moderator = fake.addRole('Moderator', P.Connect | P.Speak | P.MoveMembers);
      ids.outsider = fake.addUser('outsider');
      ids.mod = fake.addUser('mod', { roles: [ids.moderator] });
      for (const userId of [standard.alice, standard.bob]) fake.members.get(userId)!.roles = [ids.member];
      fake.members.get(standard.carol)!.roles = [ids.member, ids.muted];
      const overwrites = [
        { id: fake.guildId, type: 0, allow: '0', deny: String(P.ViewChannel) },
        { id: ids.member, type: 0, allow: String(P.ViewChannel | P.Connect), deny: '0' },
        { id: ids.muted, type: 0, allow: '0', deny: String(P.Speak) },
        // Manage Messages and Mention Everyone are permissions the bot does not have itself.
        { id: ids.moderator, type: 0, allow: String(P.ViewChannel | P.Connect | P.ManageMessages | P.MentionEveryone), deny: '0' },
      ];
      for (const channelId of [standard.category, standard.hub, standard.lounge]) {
        fake.channels.get(channelId)!.permission_overwrites = structuredClone(overwrites);
      }
    },
  });
  t.after(() => destroyWorld(world));
  const { fake, alice, bob, carol, hub } = world;
  const outsider = ids.outsider!;
  assert.ok(!fake.canSee(outsider, hub), 'the category is hidden from people without the member role');

  // Created, hidden, and still manageable by the bot.
  const { channelId, panel } = await createChannelFor(world, alice);
  assert.ok(fake.canJoin(alice, channelId));
  assert.ok(!fake.canSee(bob, channelId), 'hidden even from members, who can see the rest of the category');
  assert.ok(!fake.canSee(ids.mod!, channelId), 'and from moderators without Administrator');

  const { modal } = await fake.click(alice, panel, PanelButton.Name);
  await fake.submit(alice, channelId, modal!, { name: 'Members only' });
  assert.equal(fake.channels.get(channelId)!.name, 'Members only');

  // Allowed users get in; a role that mutes them in this category still mutes them here.
  const allowMenu = await fake.click(alice, panel, PanelButton.Allowed);
  await fake.chooseUsers(alice, allowMenu.message!, SelectId.Allowed, [carol]);
  assert.ok(fake.canJoin(carol, channelId));
  assert.ok(!fake.can(carol, channelId, P.Speak), 'the mute role still applies');
  assert.ok(fake.can(alice, channelId, P.Speak));

  // Public means "like the rest of the category", not "open to the whole server".
  await fake.click(alice, panel, PanelButton.privacy('public'));
  assert.ok(fake.canJoin(bob, channelId));
  assert.ok(!fake.canSee(outsider, channelId), 'someone the category is hidden from still cannot see it');
  assert.ok(fake.can(ids.mod!, channelId, P.MoveMembers), 'moderators keep their powers in public channels');

  // Locked: visible to members, joinable only by invitation.
  await fake.click(alice, panel, PanelButton.privacy('locked'));
  assert.ok(fake.canSee(bob, channelId));
  assert.ok(!fake.canJoin(bob, channelId));
  assert.ok(fake.canJoin(carol, channelId));

  // Moderation works with the permissions the bot granted itself on the channel.
  fake.join(carol, channelId);
  await settle(10);
  const muteMenu = await fake.click(alice, panel, PanelButton.Mute);
  await fake.choose(alice, muteMenu.message!, SelectId.Mute, [carol]);
  assert.equal(fake.voiceOf(carol).mute, true);
  const kickMenu = await fake.click(alice, panel, PanelButton.Kick);
  await fake.choose(alice, kickMenu.message!, SelectId.Kick, [carol]);
  assert.equal(fake.channelOf(carol), null);

  fake.leave(alice);
  await until(() => !fake.channels.has(channelId), 'the channel to be removed');

  // What the bot could not carry over is not dropped silently: it is logged once and shown to admins.
  assert.deepEqual(fake.unexpected, []);
  assert.deepEqual(fake.rejected, []);
  const problems = world.log.problems();
  assert.equal(problems.length, 1, problems.join('\n'));
  assert.match(problems[0]!, /cannot inherit its overrides for Manage Messages, Mention @everyone, @here and All Roles/u);
  const report = await fake.command(fake.ownerId, world.general, 'voicehub', 'list');
  assert.match(
    report.message!.content,
    /\*\*Voice channels\*\* has role or member overrides for \*\*Manage Messages\*\*, \*\*Mention @everyone, @here and All Roles\*\*/u,
  );
});

test('an admin is warned when a restriction of the category cannot be carried over to personal channels', async (t) => {
  let muted = '';
  const world = await createWorld({
    // Someone trimmed the bot's role down to the bare minimum, on a server where
    // speaking is granted by a member role rather than to @everyone.
    botPermissions: P.ViewChannel | P.Connect | P.ManageChannels | P.ManageRoles | P.MoveMembers | P.SendMessages,
    everyonePermissions: P.ViewChannel | P.Connect | P.SendMessages | P.ReadMessageHistory,
    prepare: (fake, standard) => {
      muted = fake.addRole('Muted');
      const overwrites = [{ id: muted, type: 0, allow: '0', deny: String(P.Speak | P.SendMessages) }];
      for (const channelId of [standard.category, standard.hub]) {
        fake.channels.get(channelId)!.permission_overwrites = structuredClone(overwrites);
      }
    },
  });
  t.after(() => destroyWorld(world));
  const { fake, alice, general } = world;

  const report = await fake.command(fake.ownerId, general, 'voicehub', 'list');
  assert.match(report.message!.content, /has role or member overrides for \*\*Speak\*\*/u);
  assert.match(report.message!.content, /Add it to my role if you rely on it/u);

  // The channel is still created, with everything the bot is able to carry over.
  const { channelId } = await createChannelFor(world, alice);
  const inherited = (fake.channels.get(channelId)!.permission_overwrites as { id: string; deny: string }[]).find(
    (overwrite) => overwrite.id === muted,
  );
  assert.equal(BigInt(inherited!.deny), P.SendMessages, 'the part of the restriction the bot holds is kept');
  assert.ok(!fake.canSee(world.bob, channelId));
  assert.equal(world.log.problems().filter((problem) => /cannot inherit its overrides for Speak/u.test(problem)).length, 1);
});
