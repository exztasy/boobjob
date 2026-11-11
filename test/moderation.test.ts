import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PanelButton, SelectId } from '../src/ui/ids.js';
import { optionsOf, type Json } from './support/fakeDiscord.js';
import { createChannelFor, createWorld, destroyWorld, settle, until, type World } from './support/harness.js';

function assertClean(world: World): void {
  assert.deepEqual(world.fake.unexpected, [], 'requests the fake does not know');
  assert.deepEqual(world.fake.rejected, [], 'payloads Discord would reject');
  assert.deepEqual(world.log.problems(), [], 'warnings and errors logged by the bot');
}

/** A public channel owned by alice with bob and carol in it. */
async function channelWithGuests(world: World): Promise<{ channelId: string; panel: Json }> {
  const { fake, alice, bob, carol } = world;
  const created = await createChannelFor(world, alice);
  await fake.click(alice, created.panel, PanelButton.privacy('public'));
  fake.join(bob, created.channelId);
  fake.join(carol, created.channelId);
  await settle(10);
  return created;
}

function ticked(message: Json, customId: string): string[] {
  return optionsOf(message, customId)
    .filter((option) => option.default)
    .map((option) => option.value);
}

// ── kick ──────────────────────────────────────────────────────────────────

test('the owner kicks someone from the list of people in the channel', async (t) => {
  const world = await createWorld();
  t.after(() => destroyWorld(world));
  const { fake, alice, bob, carol } = world;
  const { channelId, panel } = await channelWithGuests(world);

  const opened = await fake.click(alice, panel, PanelButton.Kick);
  assert.deepEqual(
    optionsOf(opened.message!, SelectId.Kick).map((option) => option.label),
    ['bob', 'carol'],
    'everyone in the channel is listed, except the person asking',
  );

  const kicked = await fake.choose(alice, opened.message!, SelectId.Kick, [bob]);

  assert.match(kicked.message!.content, new RegExp(`Kicked <@${bob}>`, 'u'));
  assert.equal(fake.channelOf(bob), null);
  assert.equal(fake.channelOf(carol), channelId);
  assert.deepEqual(
    optionsOf(kicked.message!, SelectId.Kick).map((option) => option.label),
    ['carol'],
    'the list is brought up to date',
  );
  assert.ok(fake.canJoin(bob, channelId), 'a kick alone does not lock anyone out');
  assertClean(world);
});

test('several people can be kicked at once, and the menu says so when nobody is left', async (t) => {
  const world = await createWorld();
  t.after(() => destroyWorld(world));
  const { fake, alice, bob, carol } = world;
  const { panel } = await channelWithGuests(world);

  const opened = await fake.click(alice, panel, PanelButton.Kick);
  const kicked = await fake.choose(alice, opened.message!, SelectId.Kick, [bob, carol]);

  assert.equal(fake.channelOf(bob), null);
  assert.equal(fake.channelOf(carol), null);
  assert.match(kicked.message!.content, /There is nobody else in <#\d+> to kick/u);
  assert.deepEqual(kicked.message!.components, []);
  assertClean(world);
});

test('kicking someone who already left is reported, not treated as a failure', async (t) => {
  const world = await createWorld();
  t.after(() => destroyWorld(world));
  const { fake, alice, bob } = world;
  const { panel } = await channelWithGuests(world);
  const opened = await fake.click(alice, panel, PanelButton.Kick);

  fake.leave(bob);
  await settle(10);
  const kicked = await fake.choose(alice, opened.message!, SelectId.Kick, [bob]);

  assert.match(kicked.message!.content, new RegExp(`<@${bob}> is not in the channel`, 'u'));
  assertClean(world);
});

// ── mute ──────────────────────────────────────────────────────────────────

test('the owner mutes someone, and unmutes them by unticking them', async (t) => {
  const world = await createWorld();
  t.after(() => destroyWorld(world));
  const { fake, alice, bob, carol } = world;
  const { panel } = await channelWithGuests(world);

  const opened = await fake.click(alice, panel, PanelButton.Mute);
  assert.deepEqual(ticked(opened.message!, SelectId.Mute), []);
  const muted = await fake.choose(alice, opened.message!, SelectId.Mute, [bob]);

  assert.match(muted.message!.content, new RegExp(`Muted <@${bob}>`, 'u'));
  assert.equal(fake.voiceOf(bob).mute, true);
  assert.equal(fake.voiceOf(carol).mute, false);
  assert.equal(fake.voiceOf(bob).deaf, false, 'muting does not deafen');
  assert.deepEqual(ticked(muted.message!, SelectId.Mute), [bob], 'the menu shows who is muted');

  const unmuted = await fake.choose(alice, muted.message!, SelectId.Mute, []);
  assert.match(unmuted.message!.content, new RegExp(`Unmuted <@${bob}>`, 'u'));
  assert.equal(fake.voiceOf(bob).mute, false);
  assert.deepEqual(ticked(unmuted.message!, SelectId.Mute), []);
  assertClean(world);
});

test('adding a second muted person leaves the first one muted', async (t) => {
  const world = await createWorld();
  t.after(() => destroyWorld(world));
  const { fake, alice, bob, carol } = world;
  const { panel } = await channelWithGuests(world);

  const opened = await fake.click(alice, panel, PanelButton.Mute);
  const first = await fake.choose(alice, opened.message!, SelectId.Mute, [bob]);
  const second = await fake.choose(alice, first.message!, SelectId.Mute, [bob, carol]);

  assert.match(second.message!.content, new RegExp(`Muted <@${carol}>`, 'u'));
  assert.doesNotMatch(second.message!.content, new RegExp(`<@${bob}>`, 'u'), 'bob was already muted, nothing to report');
  assert.equal(fake.voiceOf(bob).mute, true);
  assert.equal(fake.voiceOf(carol).mute, true);
  assert.equal(fake.requestsTo('PATCH', new RegExp(`/members/${bob}$`, 'u')).filter((r) => 'mute' in (r.body ?? {})).length, 1);
  assertClean(world);
});

test('a mute only applies inside the channel: it is lifted when they move away and comes back when they return', async (t) => {
  const world = await createWorld();
  t.after(() => destroyWorld(world));
  const { fake, alice, bob, lounge } = world;
  const { channelId, panel } = await channelWithGuests(world);
  const opened = await fake.click(alice, panel, PanelButton.Mute);
  await fake.choose(alice, opened.message!, SelectId.Mute, [bob]);
  assert.equal(fake.voiceOf(bob).mute, true);

  fake.join(bob, lounge);
  await until(() => fake.voiceOf(bob).mute === false, 'the mute to be lifted in the other channel');

  fake.join(bob, channelId);
  await until(() => fake.voiceOf(bob).mute === true, 'the mute to apply again on return');
  assertClean(world);
});

test('someone who disconnects while muted is unmuted the next time they join a voice channel', async (t) => {
  const world = await createWorld();
  t.after(() => destroyWorld(world));
  const { fake, bot, alice, bob, lounge } = world;
  const { panel } = await channelWithGuests(world);
  const opened = await fake.click(alice, panel, PanelButton.Mute);
  await fake.choose(alice, opened.message!, SelectId.Mute, [bob]);

  fake.leave(bob);
  await settle();
  // Discord does not allow changing the voice state of someone who is not connected.
  assert.equal(fake.voiceOf(bob).mute, true);
  assert.deepEqual(bot.store.getApplied(fake.guildId, bob), { muted: true, deafened: false });

  fake.join(bob, lounge);
  await until(() => fake.voiceOf(bob).mute === false, 'the leftover mute to be lifted');
  assert.deepEqual(bot.store.getApplied(fake.guildId, bob), { muted: false, deafened: false });
  assert.deepEqual(world.fake.unexpected, []);
  assert.deepEqual(world.log.problems(), []);
});

test('someone muted in a channel that has since been removed is unmuted when they next join voice', async (t) => {
  const world = await createWorld();
  t.after(() => destroyWorld(world));
  const { fake, alice, bob, carol, lounge } = world;
  const { channelId, panel } = await channelWithGuests(world);
  const opened = await fake.click(alice, panel, PanelButton.Mute);
  await fake.choose(alice, opened.message!, SelectId.Mute, [bob]);

  fake.leave(bob);
  fake.leave(carol);
  fake.leave(alice);
  await until(() => !fake.channels.has(channelId), 'the channel to be removed');
  assert.equal(fake.voiceOf(bob).mute, true);

  fake.join(bob, lounge);
  await until(() => fake.voiceOf(bob).mute === false, 'the leftover mute to be lifted');
  assertClean(world);
});

test('a mute can be undone from the menu after the person has left, so it does not come back', async (t) => {
  const world = await createWorld();
  t.after(() => destroyWorld(world));
  const { fake, alice, bob } = world;
  const { channelId, panel } = await channelWithGuests(world);
  const opened = await fake.click(alice, panel, PanelButton.Mute);
  await fake.choose(alice, opened.message!, SelectId.Mute, [bob]);
  fake.leave(bob);
  await settle(10);

  const reopened = await fake.click(alice, panel, PanelButton.Mute);
  const entry = optionsOf(reopened.message!, SelectId.Mute).find((option) => option.value === bob);
  assert.equal(entry?.default, true, 'bob is still listed as muted');
  assert.match(entry?.description, /Left the channel/u);
  await fake.choose(alice, reopened.message!, SelectId.Mute, []);

  fake.join(bob, channelId);
  await until(() => fake.voiceOf(bob).mute === false, 'bob to be unmuted on return');
  await settle();
  assert.equal(fake.voiceOf(bob).mute, false);
  assertClean(world);
});

// ── deafen ────────────────────────────────────────────────────────────────

test('the owner deafens and undeafens someone', async (t) => {
  const world = await createWorld();
  t.after(() => destroyWorld(world));
  const { fake, alice, bob, lounge } = world;
  const { panel } = await channelWithGuests(world);

  const opened = await fake.click(alice, panel, PanelButton.Deafen);
  const deafened = await fake.choose(alice, opened.message!, SelectId.Deafen, [bob]);

  assert.match(deafened.message!.content, new RegExp(`Deafened <@${bob}>`, 'u'));
  assert.equal(fake.voiceOf(bob).deaf, true);
  assert.equal(fake.voiceOf(bob).mute, false, 'deafening does not mute');

  const undeafened = await fake.choose(alice, deafened.message!, SelectId.Deafen, []);
  assert.match(undeafened.message!.content, new RegExp(`Undeafened <@${bob}>`, 'u'));
  assert.equal(fake.voiceOf(bob).deaf, false);

  // Like a mute, it does not follow them out of the channel.
  await fake.choose(alice, undeafened.message!, SelectId.Deafen, [bob]);
  fake.join(bob, lounge);
  await until(() => fake.voiceOf(bob).deaf === false, 'the deafen to be lifted in the other channel');
  assertClean(world);
});

test('someone can be muted and deafened at the same time, and each is undone on its own', async (t) => {
  const world = await createWorld();
  t.after(() => destroyWorld(world));
  const { fake, alice, bob } = world;
  const { panel } = await channelWithGuests(world);

  const muteMenu = await fake.click(alice, panel, PanelButton.Mute);
  const muted = await fake.choose(alice, muteMenu.message!, SelectId.Mute, [bob]);
  const deafenMenu = await fake.click(alice, panel, PanelButton.Deafen);
  await fake.choose(alice, deafenMenu.message!, SelectId.Deafen, [bob]);
  assert.deepEqual({ mute: fake.voiceOf(bob).mute, deaf: fake.voiceOf(bob).deaf }, { mute: true, deaf: true });

  await fake.choose(alice, muted.message!, SelectId.Mute, []);
  assert.deepEqual({ mute: fake.voiceOf(bob).mute, deaf: fake.voiceOf(bob).deaf }, { mute: false, deaf: true });
  assertClean(world);
});

// ── moderators ────────────────────────────────────────────────────────────

test('a moderator\'s own server mute is never lifted by the bot', async (t) => {
  const world = await createWorld();
  t.after(() => destroyWorld(world));
  const { fake, bot, alice, bob, lounge } = world;
  const { panel } = await channelWithGuests(world);
  fake.moderate(bob, { mute: true });
  await settle(10);

  const opened = await fake.click(alice, panel, PanelButton.Mute);
  const muted = await fake.choose(alice, opened.message!, SelectId.Mute, [bob]);
  assert.match(muted.message!.content, /already server-muted by a moderator/u);
  assert.deepEqual(bot.store.getApplied(fake.guildId, bob), { muted: false, deafened: false }, 'the mute is not the bot\'s to lift');

  fake.join(bob, lounge);
  await settle();
  assert.equal(fake.voiceOf(bob).mute, true, 'leaving the channel does not undo the moderator\'s mute');
  assertClean(world);
});

test('when a moderator lifts the owner\'s mute, the bot does not put it back', async (t) => {
  const world = await createWorld();
  t.after(() => destroyWorld(world));
  const { fake, bot, alice, bob, lounge } = world;
  const { channelId, panel } = await channelWithGuests(world);
  const opened = await fake.click(alice, panel, PanelButton.Mute);
  await fake.choose(alice, opened.message!, SelectId.Mute, [bob]);

  fake.moderate(bob, { mute: false });
  await until(() => !bot.store.getSanction(channelId, bob).muted, 'the bot to accept the moderator\'s decision');

  fake.join(bob, lounge);
  fake.join(bob, channelId);
  await settle();
  assert.equal(fake.voiceOf(bob).mute, false, 'coming back does not mute them again');
  assertClean(world);
});

test('without the Mute Members permission the owner is told, and nothing is left half done', async (t) => {
  const world = await createWorld();
  t.after(() => destroyWorld(world));
  const { fake, bot, alice, bob } = world;
  const { channelId, panel } = await channelWithGuests(world);
  const opened = await fake.click(alice, panel, PanelButton.Mute);

  fake.failNext('PATCH', new RegExp(`/members/${bob}$`, 'u'), 403, { code: 50013, message: 'Missing Permissions' });
  const result = await fake.choose(alice, opened.message!, SelectId.Mute, [bob]);

  assert.match(result.message!.content, /I don't have the permissions for that/u);
  assert.equal(fake.voiceOf(bob).mute, false);
  assert.deepEqual(bot.store.getSanction(channelId, bob), { muted: false, deafened: false });
  assert.deepEqual(bot.store.getApplied(fake.guildId, bob), { muted: false, deafened: false });
  assert.deepEqual(ticked(result.message!, SelectId.Mute), []);
});

test('nobody can mute themselves through the bot', async (t) => {
  const world = await createWorld();
  t.after(() => destroyWorld(world));
  const { fake, alice } = world;
  const { panel, channelId } = await channelWithGuests(world);

  const opened = await fake.click(alice, panel, PanelButton.Mute);
  assert.ok(!optionsOf(opened.message!, SelectId.Mute).some((option) => option.value === alice), 'the owner is not in their own list');
  const result = await fake.command(alice, channelId, 'voice', 'mute', { user: { user: alice } });

  assert.match(result.message!.content, /You can't mute yourself here/u);
  assert.equal(fake.voiceOf(alice).mute, false);
  assertClean(world);
});
