import assert from 'node:assert/strict';
import { test } from 'node:test';
import { textOf } from './support/fakeDiscord.js';
import { channelOwnedBy, createChannelFor, createWorld, destroyWorld, settle, until } from './support/harness.js';

test('joining the hub gives a member a hidden channel of their own and moves them into it', async (t) => {
  const world = await createWorld();
  t.after(() => destroyWorld(world));
  const { fake, alice, bob, hub, category } = world;

  const { channelId, panel } = await createChannelFor(world, alice);

  const channel = fake.channels.get(channelId)!;
  assert.equal(channel.name, "alice's channel");
  assert.equal(channel.parent_id, category, 'the channel sits next to the hub');
  assert.deepEqual(fake.membersIn(channelId), [alice]);
  assert.deepEqual(fake.membersIn(hub), []);

  assert.ok(fake.canJoin(alice, channelId), 'the owner can get in');
  assert.ok(!fake.canSee(bob, channelId), 'nobody else can see it');
  assert.ok(!fake.canJoin(bob, channelId), 'nobody else can join it');

  assert.match(textOf(panel), new RegExp(`<@${alice}> owns this channel`, 'u'));
  assert.deepEqual(
    panel.mentions.map((user: { id: string }) => user.id),
    [alice],
    'the owner is pinged so they find the panel',
  );
  assert.deepEqual(fake.unexpected, []);
  assert.deepEqual(fake.rejected, []);
  assert.deepEqual(world.log.problems(), []);
});

test('a channel is removed once the last person leaves it', async (t) => {
  const world = await createWorld();
  t.after(() => destroyWorld(world));
  const { fake, bot, alice } = world;

  const { channelId } = await createChannelFor(world, alice);
  fake.leave(alice);

  await until(() => !fake.channels.has(channelId), 'the empty channel to be deleted');
  assert.equal(bot.store.getTempChannel(channelId), undefined);
  assert.equal(channelOwnedBy(world, alice), undefined);
  await settle();
  assert.deepEqual(world.log.problems(), []);
});
