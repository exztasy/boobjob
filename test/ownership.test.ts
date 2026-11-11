import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PermissionFlagsBits as P } from 'discord.js';
import { PanelButton, SelectId } from '../src/ui/ids.js';
import { optionsOf, textOf } from './support/fakeDiscord.js';
import { channelOwnedBy, createChannelFor, createWorld, destroyWorld, settle, until, type World } from './support/harness.js';

function assertClean(world: World): void {
  assert.deepEqual(world.fake.unexpected, [], 'requests the fake does not know');
  assert.deepEqual(world.fake.rejected, [], 'payloads Discord would reject');
  assert.deepEqual(world.log.problems(), [], 'warnings and errors logged by the bot');
}

/** Alice's channel, made public, with bob in it. */
async function channelWithBob(world: World) {
  const { fake, alice, bob } = world;
  const created = await createChannelFor(world, alice);
  await fake.click(alice, created.panel, PanelButton.privacy('public'));
  fake.join(bob, created.channelId);
  await settle(10);
  return created;
}

test('someone who does not own the channel cannot use its controls', async (t) => {
  const world = await createWorld();
  t.after(() => destroyWorld(world));
  const { fake, bot, alice, bob } = world;
  const { channelId } = await channelWithBob(world);
  const before = fake.requests.length;

  for (const button of [
    PanelButton.Name,
    PanelButton.Limit,
    PanelButton.Quality,
    PanelButton.privacy('hidden'),
    PanelButton.Allowed,
    PanelButton.Blocked,
    PanelButton.Kick,
    PanelButton.Mute,
    PanelButton.Deafen,
    PanelButton.Transfer,
  ]) {
    const result = await fake.click(bob, fake.panelIn(channelId)!, button);
    assert.equal(result.modal, null, `${button} must not open a form`);
    assert.match(result.message!.content, new RegExp(`Only the owner of this channel, <@${alice}>`, 'u'), button);
    assert.ok(result.message!.flags & 64, 'the refusal is private');
    assert.deepEqual(result.message!.components, [], `${button} must not hand out menus`);
  }

  const changes = fake.requests.slice(before).filter((request) => !request.path.includes('/interactions/'));
  assert.deepEqual(changes, [], 'nothing was changed');
  assert.equal(bot.store.getTempChannel(channelId)?.privacy, 'public');
  assertClean(world);
});

test('a menu the owner opened cannot be used by them after they hand the channel over', async (t) => {
  const world = await createWorld();
  t.after(() => destroyWorld(world));
  const { fake, alice, bob, carol } = world;
  const { channelId, panel } = await channelWithBob(world);
  fake.join(carol, channelId);
  await settle(10);
  const kickMenu = await fake.click(alice, panel, PanelButton.Kick);
  const transferMenu = await fake.click(alice, panel, PanelButton.Transfer);
  await fake.choose(alice, transferMenu.message!, SelectId.Transfer, [bob]);

  const attempt = await fake.choose(alice, kickMenu.message!, SelectId.Kick, [carol]);

  assert.match(attempt.message!.content, new RegExp(`Only the owner of this channel, <@${bob}>`, 'u'));
  assert.equal(fake.channelOf(carol), channelId);
  assertClean(world);
});

test('while the owner is in the channel nobody can claim it', async (t) => {
  const world = await createWorld();
  t.after(() => destroyWorld(world));
  const { fake, alice, bob } = world;
  const { channelId, panel } = await channelWithBob(world);

  const result = await fake.click(bob, panel, PanelButton.Claim);

  assert.match(result.message!.content, new RegExp(`<@${alice}> is still here`, 'u'));
  assert.equal(channelOwnedBy(world, alice), channelId);
  assertClean(world);
});

test('once the owner has left, someone in the channel can claim it', async (t) => {
  const world = await createWorld();
  t.after(() => destroyWorld(world));
  const { fake, bot, alice, bob, carol } = world;
  const { channelId, panel } = await channelWithBob(world);
  await fake.click(alice, panel, PanelButton.privacy('hidden'));
  fake.leave(alice);
  await settle(10);
  assert.ok(fake.channels.has(channelId), 'the channel lives on while bob is in it');

  const outsider = await fake.click(carol, panel, PanelButton.Claim);
  assert.match(outsider.message!.content, /Join the channel first/u);

  const claimed = await fake.click(bob, panel, PanelButton.Claim);
  assert.match(claimed.message!.content, new RegExp(`You now own <#${channelId}>`, 'u'));
  assert.equal(bot.store.getTempChannel(channelId)?.ownerId, bob);
  await until(() => textOf(fake.panelIn(channelId)!).includes(`<@${bob}> owns this channel`), 'the panel to name the new owner');
  assert.ok(
    fake.messagesIn(channelId).some((message) => message.content === `👑 <@${bob}> now owns this channel.`),
    'everyone in the channel is told',
  );

  // The new owner is in charge...
  const limit = await fake.click(bob, panel, PanelButton.Limit);
  assert.ok(limit.modal, 'bob can use the controls now');
  await fake.submit(bob, channelId, limit.modal!, { limit: '6' });
  assert.equal(fake.channels.get(channelId)!.user_limit, 6);
  assert.equal(bot.store.getProfile(fake.guildId, bob)?.userLimit, 6, 'and what bob changes is saved for bob');
  assert.equal(bot.store.getProfile(fake.guildId, alice)?.userLimit ?? null, null, 'not for alice');

  // ...and the previous owner is an ordinary guest who can still get in.
  assert.ok(fake.canJoin(alice, channelId), 'alice can come back to the hidden channel');
  const refused = await fake.click(alice, panel, PanelButton.Kick);
  assert.match(refused.message!.content, new RegExp(`Only the owner of this channel, <@${bob}>`, 'u'));
  assertClean(world);
});

test('after their channel was claimed, the previous owner gets a new one from the hub', async (t) => {
  const world = await createWorld();
  t.after(() => destroyWorld(world));
  const { fake, alice, bob } = world;
  const { channelId, panel } = await channelWithBob(world);
  fake.leave(alice);
  await settle(10);
  await fake.click(bob, panel, PanelButton.Claim);

  const fresh = await createChannelFor(world, alice);

  assert.notEqual(fresh.channelId, channelId);
  assert.equal(channelOwnedBy(world, bob), channelId);
  assert.equal(channelOwnedBy(world, alice), fresh.channelId);
  assertClean(world);
});

test('an owner who returns through the hub is put back into their channel while it is in use', async (t) => {
  const world = await createWorld();
  t.after(() => destroyWorld(world));
  const { fake, alice, hub } = world;
  const { channelId } = await channelWithBob(world);
  fake.leave(alice);
  await settle(10);
  const channelsBefore = fake.channels.size;

  fake.join(alice, hub);

  await until(() => fake.channelOf(alice) === channelId, 'alice to be moved back into her channel');
  assert.equal(fake.channels.size, channelsBefore, 'no second channel is made');
  assertClean(world);
});

test('the owner transfers the channel to someone in it', async (t) => {
  const world = await createWorld();
  t.after(() => destroyWorld(world));
  const { fake, bot, alice, bob } = world;
  const { channelId, panel } = await channelWithBob(world);

  const opened = await fake.click(alice, panel, PanelButton.Transfer);
  assert.deepEqual(
    optionsOf(opened.message!, SelectId.Transfer).map((option) => option.label),
    ['bob'],
  );
  const transferred = await fake.choose(alice, opened.message!, SelectId.Transfer, [bob]);

  assert.match(transferred.message!.content, new RegExp(`<@${bob}> now owns <#${channelId}>`, 'u'));
  assert.deepEqual(transferred.message!.components, [], 'the menu is gone once the channel is handed over');
  assert.equal(bot.store.getTempChannel(channelId)?.ownerId, bob);
  assert.equal(fake.channelOf(alice), channelId, 'the previous owner stays in the channel');
  assert.deepEqual(bot.store.getChannelAccess(channelId).allowed, [alice], 'and keeps access to it');
  assertClean(world);
});

test('a channel cannot be handed to a bot or to someone who already owns one', async (t) => {
  const musicBot: { id?: string } = {};
  const world = await createWorld({
    prepare: (fake) => {
      musicBot.id = fake.addUser('music', { bot: true });
    },
  });
  t.after(() => destroyWorld(world));
  const { fake, bot, alice, bob, carol } = world;
  const { channelId, panel } = await channelWithBob(world);
  fake.join(musicBot.id!, channelId);
  await settle(10);

  const opened = await fake.click(alice, panel, PanelButton.Transfer);
  assert.deepEqual(
    optionsOf(opened.message!, SelectId.Transfer).map((option) => option.label),
    ['bob'],
    'bots are not offered',
  );
  const toBot = await fake.command(alice, channelId, 'voice', 'transfer', { user: { user: musicBot.id! } });
  assert.match(toBot.message!.content, /A bot can't own a channel/u);

  // Carol owns a channel with someone in it, then drops by alice's channel.
  const carols = await createChannelFor(world, carol);
  await fake.click(carol, carols.panel, PanelButton.privacy('public'));
  fake.join(bob, carols.channelId);
  fake.join(carol, channelId);
  await settle(10);
  const toOwner = await fake.command(alice, channelId, 'voice', 'transfer', { user: { user: carol } });
  assert.match(toOwner.message!.content, new RegExp(`<@${carol}> already owns <#${carols.channelId}>`, 'u'));
  assert.equal(bot.store.getTempChannel(channelId)?.ownerId, alice);
  assertClean(world);
});

test('a new owner is not left muted in the channel they now run', async (t) => {
  const world = await createWorld();
  t.after(() => destroyWorld(world));
  const { fake, alice, bob } = world;
  const { panel } = await channelWithBob(world);
  const muteMenu = await fake.click(alice, panel, PanelButton.Mute);
  await fake.choose(alice, muteMenu.message!, SelectId.Mute, [bob]);
  assert.equal(fake.voiceOf(bob).mute, true);

  const transferMenu = await fake.click(alice, panel, PanelButton.Transfer);
  await fake.choose(alice, transferMenu.message!, SelectId.Transfer, [bob]);

  await until(() => fake.voiceOf(bob).mute === false, 'the new owner to be unmuted');
  assertClean(world);
});

test('someone who could manage the channel in Discord itself can use the controls, and changes are saved for the owner', async (t) => {
  const moderator: { id?: string } = {};
  const world = await createWorld({
    prepare: (fake) => {
      const role = fake.addRole('Moderator', P.ManageChannels | P.MoveMembers);
      moderator.id = fake.addUser('mod', { roles: [role] });
    },
  });
  t.after(() => destroyWorld(world));
  const { fake, bot, alice } = world;
  const { channelId, panel } = await channelWithBob(world);
  fake.join(moderator.id!, channelId);
  await settle(10);

  const { modal } = await fake.click(moderator.id!, panel, PanelButton.Name);
  assert.ok(modal, 'the moderator gets the rename form');
  await fake.submit(moderator.id!, channelId, modal!, { name: 'Keep it friendly' });

  assert.equal(fake.channels.get(channelId)!.name, 'Keep it friendly');
  assert.equal(bot.store.getProfile(fake.guildId, alice)?.name, 'Keep it friendly', 'so the old name does not come back');
  assert.equal(bot.store.getProfile(fake.guildId, moderator.id!), undefined, "the moderator's own settings are untouched");
  assert.equal(bot.store.getTempChannel(channelId)?.ownerId, alice);
  assertClean(world);
});
