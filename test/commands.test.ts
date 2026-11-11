import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PermissionFlagsBits as P } from 'discord.js';
import { INVITE_PERMISSIONS } from '../src/permissions.js';
import { PanelButton } from '../src/ui/ids.js';
import { textOf } from './support/fakeDiscord.js';
import { channelOwnedBy, createChannelFor, createWorld, destroyWorld, settle, until, type World } from './support/harness.js';

function assertClean(world: World): void {
  assert.deepEqual(world.fake.unexpected, [], 'requests the fake does not know');
  assert.deepEqual(world.fake.rejected, [], 'payloads Discord would reject');
  assert.deepEqual(world.log.problems(), [], 'warnings and errors logged by the bot');
}

// ── registration ──────────────────────────────────────────────────────────

test('the slash commands are registered on startup, and only admins get the setup command by default', async (t) => {
  const world = await createWorld();
  t.after(() => destroyWorld(world));
  const { fake } = world;

  const voice = fake.commands.find((command) => command.name === 'voice')!;
  const hub = fake.commands.find((command) => command.name === 'voicehub')!;
  assert.deepEqual(
    voice.options.map((option: { name: string }) => option.name),
    [
      'panel', 'name', 'limit', 'bitrate', 'region', 'video', 'privacy',
      'allow', 'disallow', 'block', 'unblock', 'kick', 'mute', 'unmute', 'deafen', 'undeafen', 'transfer', 'claim',
    ],
  );
  assert.deepEqual(
    hub.options.map((option: { name: string }) => option.name),
    ['setup', 'add', 'remove', 'list'],
  );
  assert.equal(hub.default_member_permissions, String(P.ManageGuild));
  assert.equal(voice.default_member_permissions ?? null, null, 'everyone can use /voice');
  assert.deepEqual(voice.contexts, [0], 'the commands only exist inside servers');
  assert.deepEqual(hub.contexts, [0]);
  assertClean(world);
});

// ── /voicehub ─────────────────────────────────────────────────────────────

test('/voicehub setup creates a hub that hands out channels', async (t) => {
  const world = await createWorld({ registerHub: false });
  t.after(() => destroyWorld(world));
  const { fake, bot, alice, general, category } = world;

  const result = await fake.command(fake.ownerId, general, 'voicehub', 'setup', {
    name: 'Join to create',
    category: { channel: category },
  });

  const hub = [...fake.channels.values()].find((channel) => channel.name === 'Join to create')!;
  assert.ok(hub, 'the hub channel exists');
  assert.equal(hub.type, 2);
  assert.equal(hub.parent_id, category);
  assert.ok(bot.store.getHub(hub.id));
  assert.match(result.message!.content, new RegExp(`Created <#${hub.id}>`, 'u'));
  assert.match(result.message!.content, /My role has every permission I need/u);
  assert.ok(result.message!.flags & 64);

  fake.join(alice, hub.id);
  await until(() => channelOwnedBy(world, alice) !== undefined && fake.channelOf(alice) === channelOwnedBy(world, alice), 'alice to get a channel');
  assert.equal(fake.channels.get(fake.channelOf(alice)!)!.parent_id, category);
  assertClean(world);
});

test('/voicehub setup works without any options', async (t) => {
  const world = await createWorld({ registerHub: false });
  t.after(() => destroyWorld(world));
  const { fake, bot, general } = world;

  await fake.command(fake.ownerId, general, 'voicehub', 'setup');

  const hub = [...fake.channels.values()].find((channel) => channel.name === '➕ Create a channel' && bot.store.getHub(channel.id));
  assert.ok(hub);
  assert.equal(hub.parent_id, null);
  assertClean(world);
});

test('/voicehub add turns an existing channel into a hub and serves whoever is already waiting in it', async (t) => {
  const world = await createWorld({ registerHub: false });
  t.after(() => destroyWorld(world));
  const { fake, bot, alice, hub, general } = world;
  fake.join(alice, hub);
  await settle(20);
  assert.equal(fake.channelOf(alice), hub, 'nothing happens in a channel that is not a hub');

  const added = await fake.command(fake.ownerId, general, 'voicehub', 'add', { channel: { channel: hub } });
  assert.match(added.message!.content, new RegExp(`<#${hub}> is now a hub`, 'u'));
  await until(() => fake.channelOf(alice) !== hub && fake.channelOf(alice) !== null, 'alice to be given a channel');

  const again = await fake.command(fake.ownerId, general, 'voicehub', 'add', { channel: { channel: hub } });
  assert.match(again.message!.content, /already a hub/u);

  const mine = await fake.command(fake.ownerId, general, 'voicehub', 'add', { channel: { channel: fake.channelOf(alice)! } });
  assert.match(mine.message!.content, /someone's temporary channel/u);
  assert.equal(bot.store.listHubs(fake.guildId).length, 1);
  assertClean(world);
});

test('/voicehub list shows the hubs, and /voicehub remove stops one without deleting it', async (t) => {
  const world = await createWorld();
  t.after(() => destroyWorld(world));
  const { fake, bot, alice, hub, general } = world;

  const listed = await fake.command(fake.ownerId, general, 'voicehub', 'list');
  assert.match(listed.message!.content, new RegExp(`<#${hub}> creates channels in \\*\\*Voice channels\\*\\*`, 'u'));

  const removed = await fake.command(fake.ownerId, general, 'voicehub', 'remove', { channel: { channel: hub } });
  assert.match(removed.message!.content, /no longer a hub/u);
  assert.ok(fake.channels.has(hub), 'the channel itself is kept');
  assert.equal(bot.store.getHub(hub), undefined);

  fake.join(alice, hub);
  await settle(20);
  assert.equal(fake.channelOf(alice), hub, 'it no longer hands out channels');

  const empty = await fake.command(fake.ownerId, general, 'voicehub', 'list');
  assert.match(empty.message!.content, /There are no hubs yet/u);
  const notHub = await fake.command(fake.ownerId, general, 'voicehub', 'remove', { channel: { channel: hub } });
  assert.match(notHub.message!.content, /is not a hub/u);
  assertClean(world);
});

test('/voicehub is refused for members without Manage Server, even if Discord lets the command through', async (t) => {
  const world = await createWorld({ registerHub: false });
  t.after(() => destroyWorld(world));
  const { fake, bot, bob, general, hub } = world;

  const result = await fake.command(bob, general, 'voicehub', 'add', { channel: { channel: hub } });

  assert.match(result.message!.content, /You need the Manage Server permission/u);
  assert.equal(bot.store.getHub(hub), undefined);
  assertClean(world);
});

test('/voicehub list tells an admin which permissions the bot is missing', async (t) => {
  const world = await createWorld({ botPermissions: INVITE_PERMISSIONS & ~(P.ManageRoles | P.MuteMembers) });
  t.after(() => destroyWorld(world));
  const { fake, general } = world;

  const listed = await fake.command(fake.ownerId, general, 'voicehub', 'list');

  assert.match(listed.message!.content, /I can't create private channels until my role has: \*\*Manage Roles\*\*/u);
  assert.match(listed.message!.content, /won't work until my role has: \*\*Mute Members\*\*/u);
  assertClean(world);
});

// ── /voice ────────────────────────────────────────────────────────────────

test('/voice commands change the channel and are saved like the panel controls', async (t) => {
  const world = await createWorld();
  t.after(() => destroyWorld(world));
  const { fake, bot, alice, bob, general } = world;
  const { channelId } = await createChannelFor(world, alice);
  // Typed in an unrelated text channel: the channel meant is the one alice is sitting in.
  const run = (subcommand: string, options = {}) => fake.command(alice, general, 'voice', subcommand, options);

  assert.match((await run('name', { name: 'Study group' })).message!.content, /Renamed the channel to \*\*Study group\*\*/u);
  assert.match((await run('limit', { users: 5 })).message!.content, /User limit set to \*\*5\*\*/u);
  assert.match((await run('bitrate', { kbps: 32 })).message!.content, /Bitrate set to \*\*32 kbps\*\*/u);
  assert.match((await run('region', { region: 'japan' })).message!.content, /Voice region set to \*\*Japan\*\*/u);
  assert.match((await run('video', { quality: 'full' })).message!.content, /Video quality set to \*\*720p\*\*/u);
  assert.match((await run('privacy', { mode: 'locked' })).message!.content, /Privacy set to \*\*Locked\*\*/u);
  assert.match((await run('allow', { user: { user: bob } })).message!.content, /can now see and join/u);

  const channel = fake.channels.get(channelId)!;
  assert.equal(channel.name, 'Study group');
  assert.equal(channel.user_limit, 5);
  assert.equal(channel.bitrate, 32_000);
  assert.equal(channel.rtc_region, 'japan');
  assert.equal(channel.video_quality_mode, 2);
  assert.ok(fake.canJoin(bob, channelId));
  assert.deepEqual(bot.store.getProfile(fake.guildId, alice), {
    name: 'Study group',
    userLimit: 5,
    bitrate: 32_000,
    rtcRegion: 'japan',
    videoQuality: 2,
    privacy: 'locked',
  });
  assert.deepEqual(bot.store.getProfileAccess(fake.guildId, alice), { allowed: [bob], blocked: [] });

  assert.match((await run('disallow', { user: { user: bob } })).message!.content, /Removed <@\d+> from the allowed list/u);
  assert.match((await run('region')).message!.content, /Voice region set to \*\*Automatic\*\*/u);
  assert.match((await run('name')).message!.content, /Back to the default name/u);
  assert.ok(!fake.canJoin(bob, channelId));
  assert.equal(fake.channels.get(channelId)!.rtc_region, null);
  assertClean(world);
});

test('/voice commands act on people in the channel', async (t) => {
  const world = await createWorld();
  t.after(() => destroyWorld(world));
  const { fake, bot, alice, bob, carol } = world;
  const { channelId, panel } = await createChannelFor(world, alice);
  await fake.click(alice, panel, PanelButton.privacy('public'));
  fake.join(bob, channelId);
  fake.join(carol, channelId);
  await settle(10);
  const run = (subcommand: string, userId: string) => fake.command(alice, channelId, 'voice', subcommand, { user: { user: userId } });

  assert.match((await run('mute', bob)).message!.content, /Muted/u);
  assert.equal(fake.voiceOf(bob).mute, true);
  assert.match((await run('mute', bob)).message!.content, /is already muted/u);
  assert.match((await run('unmute', bob)).message!.content, /Unmuted/u);
  assert.equal(fake.voiceOf(bob).mute, false);
  assert.match((await run('unmute', bob)).message!.content, /is not muted in this channel/u);

  assert.match((await run('deafen', bob)).message!.content, /Deafened/u);
  assert.equal(fake.voiceOf(bob).deaf, true);
  assert.match((await run('undeafen', bob)).message!.content, /Undeafened/u);
  assert.equal(fake.voiceOf(bob).deaf, false);

  assert.match((await run('kick', bob)).message!.content, /Kicked/u);
  assert.equal(fake.channelOf(bob), null);
  assert.match((await run('kick', bob)).message!.content, /is not in the channel/u);

  assert.match((await run('block', carol)).message!.content, /Blocked/u);
  await until(() => fake.channelOf(carol) === null, 'carol to be disconnected');
  assert.ok(!fake.canSee(carol, channelId));
  assert.match((await run('unblock', carol)).message!.content, /Unblocked/u);
  assert.ok(fake.canJoin(carol, channelId));

  fake.join(bob, channelId);
  await settle(10);
  assert.match((await run('transfer', bob)).message!.content, /now owns/u);
  assert.equal(bot.store.getTempChannel(channelId)?.ownerId, bob);
  assertClean(world);
});

test('/voice claim takes over the channel you are in once its owner has left', async (t) => {
  const world = await createWorld();
  t.after(() => destroyWorld(world));
  const { fake, bot, alice, bob, general } = world;
  const { channelId, panel } = await createChannelFor(world, alice);
  await fake.click(alice, panel, PanelButton.privacy('public'));
  fake.join(bob, channelId);
  await settle(10);

  const early = await fake.command(bob, general, 'voice', 'claim');
  assert.match(early.message!.content, /is still here/u);

  fake.leave(alice);
  await settle(10);
  const claimed = await fake.command(bob, general, 'voice', 'claim');
  assert.match(claimed.message!.content, /You now own/u);
  assert.equal(bot.store.getTempChannel(channelId)?.ownerId, bob);
  assertClean(world);
});

test('/voice works for an owner who is not in their channel at the moment', async (t) => {
  const world = await createWorld();
  t.after(() => destroyWorld(world));
  const { fake, alice, bob, general } = world;
  const { channelId, panel } = await createChannelFor(world, alice);
  await fake.click(alice, panel, PanelButton.privacy('public'));
  fake.join(bob, channelId);
  fake.leave(alice);
  await settle(10);

  const result = await fake.command(alice, general, 'voice', 'limit', { users: 3 });

  assert.match(result.message!.content, /User limit set to \*\*3\*\*/u);
  assert.equal(fake.channels.get(channelId)!.user_limit, 3);
  assertClean(world);
});

test('/voice explains how to get a channel to someone who has none', async (t) => {
  const world = await createWorld();
  t.after(() => destroyWorld(world));
  const { fake, bot, alice, hub, general } = world;

  const withHub = await fake.command(alice, general, 'voice', 'limit', { users: 3 });
  assert.match(withHub.message!.content, new RegExp(`Join <#${hub}> to get one`, 'u'));

  bot.store.removeHub(hub);
  const withoutHub = await fake.command(alice, general, 'voice', 'limit', { users: 3 });
  assert.match(withoutHub.message!.content, /An admin can create one with `\/voicehub setup`/u);
  assertClean(world);
});

test('/voice refuses values Discord would reject', async (t) => {
  const world = await createWorld();
  t.after(() => destroyWorld(world));
  const { fake, alice } = world;
  const { channelId } = await createChannelFor(world, alice);

  const bitrate = await fake.command(alice, channelId, 'voice', 'bitrate', { kbps: 384 });
  assert.match(bitrate.message!.content, /between 8 and 96 kbps on this server/u);
  const region = await fake.command(alice, channelId, 'voice', 'region', { region: 'atlantis' });
  assert.match(region.message!.content, /I don't know that voice region/u);
  const retired = await fake.command(alice, channelId, 'voice', 'region', { region: 'amsterdam' });
  assert.match(retired.message!.content, /I don't know that voice region/u);

  assert.equal(fake.channels.get(channelId)!.bitrate, 64_000);
  assert.equal(fake.channels.get(channelId)!.rtc_region, null);
  assertClean(world);
});

test('/voice region suggests regions as you type', async (t) => {
  const world = await createWorld();
  t.after(() => destroyWorld(world));
  const { fake, alice, general } = world;

  const all = await fake.autocomplete(alice, general, 'voice', 'region', 'region', '');
  assert.deepEqual(
    all.choices!.map((choice) => choice.value),
    ['auto', 'japan', 'rotterdam', 'us-east'],
  );
  const filtered = await fake.autocomplete(alice, general, 'voice', 'region', 'region', 'rot');
  assert.deepEqual(filtered.choices, [{ name: 'Rotterdam', value: 'rotterdam' }]);
  assertClean(world);
});

test('/voice panel posts a fresh control panel and removes the old one', async (t) => {
  const world = await createWorld();
  t.after(() => destroyWorld(world));
  const { fake, bot, alice } = world;
  const { channelId, panel } = await createChannelFor(world, alice);

  const result = await fake.command(alice, channelId, 'voice', 'panel');

  assert.match(result.message!.content, /Posted a fresh control panel/u);
  const fresh = fake.panelIn(channelId)!;
  assert.notEqual(fresh.id, panel.id);
  assert.ok(!fake.messages.has(panel.id), 'the old panel is gone');
  assert.equal(bot.store.getTempChannel(channelId)?.panelMessageId, fresh.id);
  assert.deepEqual(fresh.mentions, [], 'reposting does not ping the owner again');

  // The fresh panel is the one that gets updated from now on.
  await fake.command(alice, channelId, 'voice', 'limit', { users: 9 });
  await until(() => textOf(fake.panelIn(channelId)!).includes('9 users'), 'the fresh panel to be updated');
  assertClean(world);
});

test('if the panel message is deleted, the bot notices and /voice panel brings it back', async (t) => {
  const world = await createWorld();
  t.after(() => destroyWorld(world));
  const { fake, bot, alice } = world;
  const { channelId, panel } = await createChannelFor(world, alice);
  fake.deleteMessageByHand(panel.id);

  await fake.command(alice, channelId, 'voice', 'limit', { users: 2 });
  await until(() => bot.store.getTempChannel(channelId)?.panelMessageId === null, 'the bot to notice the panel is gone');
  assert.equal(fake.channels.get(channelId)!.user_limit, 2, 'the change itself went through');

  await fake.command(alice, channelId, 'voice', 'panel');
  assert.match(textOf(fake.panelIn(channelId)!), /2 users/u);
  assert.deepEqual(world.fake.unexpected, []);
  assert.deepEqual(world.log.problems(), []);
});

test('only the owner can use /voice on a channel', async (t) => {
  const world = await createWorld();
  t.after(() => destroyWorld(world));
  const { fake, alice, bob } = world;
  const { channelId, panel } = await createChannelFor(world, alice);
  await fake.click(alice, panel, PanelButton.privacy('public'));
  fake.join(bob, channelId);
  await settle(10);

  for (const [subcommand, options] of [
    ['limit', { users: 1 }],
    ['privacy', { mode: 'hidden' }],
    ['kick', { user: { user: alice } }],
    ['mute', { user: { user: alice } }],
    ['block', { user: { user: alice } }],
    ['transfer', { user: { user: bob } }],
    ['panel', {}],
  ] as const) {
    const result = await fake.command(bob, channelId, 'voice', subcommand, options);
    assert.match(result.message!.content, new RegExp(`Only the owner of this channel, <@${alice}>`, 'u'), subcommand);
  }
  assert.equal(fake.channelOf(alice), channelId);
  assert.equal(fake.voiceOf(alice).mute, false);
  assert.equal(fake.channels.get(channelId)!.user_limit, 0);
  assertClean(world);
});
