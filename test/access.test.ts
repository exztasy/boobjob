import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PanelButton, SelectId } from '../src/ui/ids.js';
import { findComponent, textOf } from './support/fakeDiscord.js';
import { createChannelFor, createWorld, destroyWorld, until, type World } from './support/harness.js';

function assertClean(world: World): void {
  assert.deepEqual(world.fake.unexpected, [], 'requests the fake does not know');
  assert.deepEqual(world.fake.rejected, [], 'payloads Discord would reject');
  assert.deepEqual(world.log.problems(), [], 'warnings and errors logged by the bot');
}

async function recreateChannel(world: World, userId: string, oldChannelId: string) {
  world.fake.leave(userId);
  await until(() => !world.fake.channels.has(oldChannelId), 'the old channel to be removed');
  return createChannelFor(world, userId);
}

/** Ids pre-selected in a user select menu. */
function shownUsers(message: Record<string, any>, customId: string): string[] {
  return (findComponent(message, customId)?.default_values ?? []).map((value: { id: string }) => value.id);
}

test('the privacy buttons switch between hidden, locked and public, and the choice is remembered', async (t) => {
  const world = await createWorld();
  t.after(() => destroyWorld(world));
  const { fake, alice, bob } = world;
  const { channelId, panel } = await createChannelFor(world, alice);
  assert.ok(findComponent(panel, PanelButton.privacy('hidden'))?.disabled, 'the current mode is marked');

  const locked = await fake.click(alice, panel, PanelButton.privacy('locked'));
  assert.match(locked.message!.content, /Privacy set to \*\*Locked\*\*/u);
  assert.ok(locked.message!.flags & 64, 'the confirmation is only shown to the owner');
  assert.ok(fake.canSee(bob, channelId), 'a locked channel is visible');
  assert.ok(!fake.canJoin(bob, channelId), 'but cannot be joined');
  await until(() => findComponent(fake.panelIn(channelId)!, PanelButton.privacy('locked'))?.disabled === true, 'the panel to mark the new mode');

  await fake.click(alice, fake.panelIn(channelId)!, PanelButton.privacy('public'));
  assert.ok(fake.canJoin(bob, channelId), 'a public channel can be joined by anyone');

  const again = await recreateChannel(world, alice, channelId);
  assert.ok(fake.canJoin(bob, again.channelId), 'the next channel is public too');
  assert.match(textOf(again.panel), /\*\*Public\*\*/u);

  await fake.click(alice, again.panel, PanelButton.privacy('hidden'));
  assert.ok(!fake.canSee(bob, again.channelId));
  assert.ok(fake.canJoin(alice, again.channelId));
  assertClean(world);
});

test('the owner lets people in from the panel, and they are let in next time too', async (t) => {
  const world = await createWorld();
  t.after(() => destroyWorld(world));
  const { fake, alice, bob, carol } = world;
  const { channelId, panel } = await createChannelFor(world, alice);

  const opened = await fake.click(alice, panel, PanelButton.Allowed);
  assert.ok(opened.message!.flags & 64);
  assert.deepEqual(shownUsers(opened.message!, SelectId.Allowed), []);

  const added = await fake.chooseUsers(alice, opened.message!, SelectId.Allowed, [bob]);
  assert.match(added.message!.content, new RegExp(`<@${bob}> can now see and join <#${channelId}>`, 'u'));
  assert.deepEqual(shownUsers(added.message!, SelectId.Allowed), [bob], 'the menu now shows who is allowed');
  assert.ok(fake.canJoin(bob, channelId));
  assert.ok(!fake.canSee(carol, channelId), 'everyone else is still kept out');
  await until(() => textOf(fake.panelIn(channelId)!).includes('1 allowed'), 'the panel to count the allowed user');

  const again = await recreateChannel(world, alice, channelId);
  assert.ok(fake.canJoin(bob, again.channelId), 'bob is allowed into the next channel straight away');
  assert.ok(!fake.canSee(carol, again.channelId));

  // Unticking someone takes their access away again, now and in the future.
  const reopened = await fake.click(alice, again.panel, PanelButton.Allowed);
  assert.deepEqual(shownUsers(reopened.message!, SelectId.Allowed), [bob]);
  const removed = await fake.chooseUsers(alice, reopened.message!, SelectId.Allowed, []);
  assert.match(removed.message!.content, new RegExp(`Removed <@${bob}> from the allowed list`, 'u'));
  assert.ok(!fake.canSee(bob, again.channelId));

  const third = await recreateChannel(world, alice, again.channelId);
  assert.ok(!fake.canSee(bob, third.channelId));
  assertClean(world);
});

test('several people can be allowed at once, and an allowed person can actually join', async (t) => {
  const world = await createWorld();
  t.after(() => destroyWorld(world));
  const { fake, alice, bob, carol } = world;
  const { channelId, panel } = await createChannelFor(world, alice);

  const opened = await fake.click(alice, panel, PanelButton.Allowed);
  await fake.chooseUsers(alice, opened.message!, SelectId.Allowed, [bob, carol]);

  assert.ok(fake.canJoin(bob, channelId));
  assert.ok(fake.canJoin(carol, channelId));
  fake.join(bob, channelId);
  fake.leave(alice);
  await until(() => fake.channelOf(alice) === null, 'alice to be gone');
  assert.ok(fake.channels.has(channelId), 'the channel stays while a guest is in it');
  assertClean(world);
});

test('blocking someone who is in the channel shows them out and keeps them out, next time too', async (t) => {
  const world = await createWorld();
  t.after(() => destroyWorld(world));
  const { fake, alice, bob, carol } = world;
  const { channelId, panel } = await createChannelFor(world, alice);
  await fake.click(alice, panel, PanelButton.privacy('public'));
  fake.join(bob, channelId);
  fake.join(carol, channelId);

  const opened = await fake.click(alice, panel, PanelButton.Blocked);
  const blocked = await fake.chooseUsers(alice, opened.message!, SelectId.Blocked, [bob]);

  assert.match(blocked.message!.content, new RegExp(`Blocked <@${bob}>`, 'u'));
  await until(() => fake.channelOf(bob) === null, 'bob to be disconnected');
  assert.ok(!fake.canSee(bob, channelId), 'a blocked person cannot even see a public channel');
  assert.equal(fake.channelOf(carol), channelId, 'nobody else is affected');
  assert.ok(fake.canJoin(carol, channelId));

  fake.leave(carol);
  const again = await recreateChannel(world, alice, channelId);
  assert.ok(!fake.canSee(bob, again.channelId), 'bob is blocked from the next channel as well');

  const reopened = await fake.click(alice, again.panel, PanelButton.Blocked);
  assert.deepEqual(shownUsers(reopened.message!, SelectId.Blocked), [bob]);
  const unblocked = await fake.chooseUsers(alice, reopened.message!, SelectId.Blocked, []);
  assert.match(unblocked.message!.content, new RegExp(`Unblocked <@${bob}>`, 'u'));
  assert.ok(fake.canJoin(bob, again.channelId), 'the channel is public, so bob can join again');
  assertClean(world);
});

test('someone is on one list at a time: allowing a blocked person unblocks them, and the other way round', async (t) => {
  const world = await createWorld();
  t.after(() => destroyWorld(world));
  const { fake, bot, alice, bob } = world;
  const { channelId, panel } = await createChannelFor(world, alice);

  const blockMenu = await fake.click(alice, panel, PanelButton.Blocked);
  await fake.chooseUsers(alice, blockMenu.message!, SelectId.Blocked, [bob]);
  const allowMenu = await fake.click(alice, panel, PanelButton.Allowed);
  await fake.chooseUsers(alice, allowMenu.message!, SelectId.Allowed, [bob]);

  assert.deepEqual(bot.store.getChannelAccess(channelId), { allowed: [bob], blocked: [] });
  assert.deepEqual(bot.store.getProfileAccess(fake.guildId, alice), { allowed: [bob], blocked: [] });
  assert.ok(fake.canJoin(bob, channelId));

  const blockAgain = await fake.click(alice, panel, PanelButton.Blocked);
  await fake.chooseUsers(alice, blockAgain.message!, SelectId.Blocked, [bob]);
  assert.deepEqual(bot.store.getChannelAccess(channelId), { allowed: [], blocked: [bob] });
  assert.ok(!fake.canSee(bob, channelId));
  assertClean(world);
});

test('the owner and the bot cannot be put on a list', async (t) => {
  const world = await createWorld();
  t.after(() => destroyWorld(world));
  const { fake, bot, alice } = world;
  const { channelId, panel } = await createChannelFor(world, alice);

  const opened = await fake.click(alice, panel, PanelButton.Blocked);
  const result = await fake.chooseUsers(alice, opened.message!, SelectId.Blocked, [alice, fake.botId]);

  assert.match(result.message!.content, /The owner can't be blocked/u);
  assert.match(result.message!.content, /I can't be blocked/u);
  assert.deepEqual(bot.store.getChannelAccess(channelId), { allowed: [], blocked: [] });
  assert.ok(fake.canJoin(alice, channelId));
  assertClean(world);
});

test('a menu that was opened earlier only applies what was changed in it', async (t) => {
  const world = await createWorld();
  t.after(() => destroyWorld(world));
  const { fake, bot, alice, bob, carol } = world;
  const { channelId, panel } = await createChannelFor(world, alice);

  // Two menus are opened while the list is empty...
  const first = await fake.click(alice, panel, PanelButton.Allowed);
  const second = await fake.click(alice, panel, PanelButton.Allowed);
  // ...bob is added through one of them...
  await fake.chooseUsers(alice, first.message!, SelectId.Allowed, [bob]);
  // ...and carol through the other, which still shows an empty list.
  await fake.chooseUsers(alice, second.message!, SelectId.Allowed, [carol]);

  assert.deepEqual(bot.store.getChannelAccess(channelId).allowed, [bob, carol], 'adding carol did not remove bob');
  assert.ok(fake.canJoin(bob, channelId));
  assert.ok(fake.canJoin(carol, channelId));
  assertClean(world);
});

test('the lists hold at most 25 people', async (t) => {
  const extras: string[] = [];
  const world = await createWorld({
    prepare: (fake) => {
      for (let index = 0; index < 26; index++) extras.push(fake.addUser(`guest-${index}`));
    },
  });
  t.after(() => destroyWorld(world));
  const { fake, bot, alice } = world;
  const { channelId, panel } = await createChannelFor(world, alice);

  const opened = await fake.click(alice, panel, PanelButton.Allowed);
  const full = await fake.chooseUsers(alice, opened.message!, SelectId.Allowed, extras.slice(0, 25));
  assert.equal(bot.store.getChannelAccess(channelId).allowed.length, 25);
  assert.equal(shownUsers(full.message!, SelectId.Allowed).length, 25);

  const overflow = await fake.command(alice, channelId, 'voice', 'allow', { user: { user: extras[25]! } });
  assert.match(overflow.message!.content, /holds 25 people at most/u);
  assert.equal(bot.store.getChannelAccess(channelId).allowed.length, 25);
  assert.ok(!fake.canSee(extras[25]!, channelId));
  assert.ok((fake.channels.get(channelId)!.permission_overwrites as unknown[]).length <= 100);
  assertClean(world);
});

test('if the permissions cannot be changed, nothing is saved and the owner is told', async (t) => {
  const world = await createWorld();
  t.after(() => destroyWorld(world));
  const { fake, bot, alice, bob } = world;
  const { channelId, panel } = await createChannelFor(world, alice);
  const opened = await fake.click(alice, panel, PanelButton.Allowed);

  fake.failNext('PATCH', new RegExp(`^/channels/${channelId}$`, 'u'), 403, { code: 50013, message: 'Missing Permissions' });
  const result = await fake.chooseUsers(alice, opened.message!, SelectId.Allowed, [bob]);

  assert.match(result.message!.content, /I don't have the permissions for that/u);
  assert.deepEqual(bot.store.getChannelAccess(channelId), { allowed: [], blocked: [] });
  assert.deepEqual(bot.store.getProfileAccess(fake.guildId, alice), { allowed: [], blocked: [] });
  assert.deepEqual(shownUsers(result.message!, SelectId.Allowed), [], 'the menu still shows the real list');
  assert.ok(!fake.canSee(bob, channelId));

  fake.failNext('PATCH', new RegExp(`^/channels/${channelId}$`, 'u'), 403, { code: 50013, message: 'Missing Permissions' });
  const privacy = await fake.click(alice, panel, PanelButton.privacy('public'));
  assert.match(privacy.message!.content, /I don't have the permissions for that/u);
  assert.equal(bot.store.getTempChannel(channelId)?.privacy, 'hidden');
  assert.equal(bot.store.getProfile(fake.guildId, alice)?.privacy ?? null, null);
  assert.ok(!fake.canSee(bob, channelId));
});
