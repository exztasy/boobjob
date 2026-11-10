import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ModalId, PanelButton, SelectId } from '../src/ui/ids.js';
import { optionsOf, textOf } from './support/fakeDiscord.js';
import { createChannelFor, createWorld, destroyWorld, until, type World } from './support/harness.js';

/** Leaves the channel, waits for it to be cleaned up, and joins the hub again. */
async function recreateChannel(world: World, userId: string, oldChannelId: string) {
  world.fake.leave(userId);
  await until(() => !world.fake.channels.has(oldChannelId), 'the old channel to be removed');
  return createChannelFor(world, userId);
}

function assertClean(world: World): void {
  assert.deepEqual(world.fake.unexpected, [], 'requests the fake does not know');
  assert.deepEqual(world.fake.rejected, [], 'payloads Discord would reject');
  assert.deepEqual(world.log.problems(), [], 'warnings and errors logged by the bot');
}

test('the owner renames the channel from the panel, and the name comes back next time', async (t) => {
  const world = await createWorld();
  t.after(() => destroyWorld(world));
  const { fake, alice } = world;
  const { channelId, panel } = await createChannelFor(world, alice);

  const opened = await fake.click(alice, panel, PanelButton.Name);
  assert.equal(opened.modal?.custom_id, ModalId.Name);
  assert.equal(opened.modal?.components[0].component.value, "alice's channel", 'the form starts with the current name');

  const submitted = await fake.submit(alice, channelId, opened.modal!, { name: '  Movie   night ' });
  assert.match(submitted.message!.content, /Renamed the channel to \*\*Movie night\*\*/u);
  assert.equal(fake.channels.get(channelId)!.name, 'Movie night');
  await until(() => textOf(fake.panelIn(channelId)!).includes('**Movie night**'), 'the panel to show the new name');

  const again = await recreateChannel(world, alice, channelId);
  assert.equal(fake.channels.get(again.channelId)!.name, 'Movie night');
  assertClean(world);
});

test('submitting an empty name goes back to the default name', async (t) => {
  const world = await createWorld();
  t.after(() => destroyWorld(world));
  const { fake, bot, alice } = world;
  bot.store.updateProfile(fake.guildId, alice, { name: 'Movie night' });
  const { channelId, panel } = await createChannelFor(world, alice);
  assert.equal(fake.channels.get(channelId)!.name, 'Movie night');

  const { modal } = await fake.click(alice, panel, PanelButton.Name);
  const submitted = await fake.submit(alice, channelId, modal!, { name: '' });

  assert.match(submitted.message!.content, /Back to the default name, \*\*alice's channel\*\*/u);
  assert.equal(fake.channels.get(channelId)!.name, "alice's channel");
  assert.equal(bot.store.getProfile(fake.guildId, alice)?.name, null);
  assertClean(world);
});

test('the owner sets a user limit from the panel, and it comes back next time', async (t) => {
  const world = await createWorld();
  t.after(() => destroyWorld(world));
  const { fake, alice } = world;
  const { channelId, panel } = await createChannelFor(world, alice);

  const { modal } = await fake.click(alice, panel, PanelButton.Limit);
  assert.equal(modal?.custom_id, ModalId.Limit);
  const submitted = await fake.submit(alice, channelId, modal!, { limit: '4' });

  assert.match(submitted.message!.content, /User limit set to \*\*4\*\*/u);
  assert.equal(fake.channels.get(channelId)!.user_limit, 4);
  await until(() => textOf(fake.panelIn(channelId)!).includes('4 users'), 'the panel to show the limit');

  const again = await recreateChannel(world, alice, channelId);
  assert.equal(fake.channels.get(again.channelId)!.user_limit, 4);
  assertClean(world);
});

test('a user limit that makes no sense is refused with an explanation', async (t) => {
  const world = await createWorld();
  t.after(() => destroyWorld(world));
  const { fake, alice } = world;
  const { channelId, panel } = await createChannelFor(world, alice);

  const { modal } = await fake.click(alice, panel, PanelButton.Limit);
  const submitted = await fake.submit(alice, channelId, modal!, { limit: 'lots' });

  assert.match(submitted.message!.content, /number from 1 to 99, or 0 for no limit/u);
  assert.equal(fake.channels.get(channelId)!.user_limit, 0);
  assertClean(world);
});

test('the owner changes bitrate, region and video quality, and they come back next time', async (t) => {
  const world = await createWorld();
  t.after(() => destroyWorld(world));
  const { fake, alice } = world;
  const { channelId, panel } = await createChannelFor(world, alice);

  const opened = await fake.click(alice, panel, PanelButton.Quality);
  const prompt = opened.message!;
  assert.ok(prompt.flags & 64, 'only the owner sees the menus');
  assert.deepEqual(
    optionsOf(prompt, SelectId.Bitrate).map((option) => option.value),
    ['8', '16', '32', '64', '96'],
    'only bitrates this server allows are offered',
  );
  assert.equal(optionsOf(prompt, SelectId.Bitrate).find((option) => option.default)?.value, '64');
  assert.deepEqual(
    optionsOf(prompt, SelectId.Region).map((option) => option.value),
    ['auto', 'japan', 'rotterdam', 'us-east'],
    'retired regions are not offered',
  );

  const bitrate = await fake.choose(alice, prompt, SelectId.Bitrate, ['96']);
  assert.match(bitrate.message!.content, /Bitrate set to \*\*96 kbps\*\*/u);
  assert.equal(optionsOf(bitrate.message!, SelectId.Bitrate).find((option) => option.default)?.value, '96');

  const region = await fake.choose(alice, bitrate.message!, SelectId.Region, ['rotterdam']);
  assert.match(region.message!.content, /Voice region set to \*\*Rotterdam\*\*/u);

  const video = await fake.choose(alice, region.message!, SelectId.Video, ['2']);
  assert.match(video.message!.content, /Video quality set to \*\*720p\*\*/u);

  const channel = fake.channels.get(channelId)!;
  assert.equal(channel.bitrate, 96_000);
  assert.equal(channel.rtc_region, 'rotterdam');
  assert.equal(channel.video_quality_mode, 2);
  await until(() => {
    const text = textOf(fake.panelIn(channelId)!);
    return text.includes('96 kbps') && text.includes('rotterdam') && text.includes('720p');
  }, 'the panel to show the new values');

  const again = await recreateChannel(world, alice, channelId);
  const recreated = fake.channels.get(again.channelId)!;
  assert.equal(recreated.bitrate, 96_000);
  assert.equal(recreated.rtc_region, 'rotterdam');
  assert.equal(recreated.video_quality_mode, 2);

  // Going back to automatic is remembered as well.
  const reopened = await fake.click(alice, again.panel, PanelButton.Quality);
  await fake.choose(alice, reopened.message!, SelectId.Region, ['auto']);
  assert.equal(fake.channels.get(again.channelId)!.rtc_region, null);
  const third = await recreateChannel(world, alice, again.channelId);
  assert.equal(fake.channels.get(third.channelId)!.rtc_region, null);
  assertClean(world);
});

test('settings are remembered per member', async (t) => {
  const world = await createWorld();
  t.after(() => destroyWorld(world));
  const { fake, alice, bob } = world;
  const mine = await createChannelFor(world, alice);
  const { modal } = await fake.click(alice, mine.panel, PanelButton.Limit);
  await fake.submit(alice, mine.channelId, modal!, { limit: '3' });

  const theirs = await createChannelFor(world, bob);

  assert.equal(fake.channels.get(theirs.channelId)!.name, "bob's channel");
  assert.equal(fake.channels.get(theirs.channelId)!.user_limit, 0);
  assertClean(world);
});

test('a third rename within the limit window is saved and applied as soon as Discord allows it', async (t) => {
  const world = await createWorld({ tuning: { renameLimit: 2, renameWindowMs: 400 } });
  t.after(() => destroyWorld(world));
  const { fake, bot, alice } = world;
  const { channelId, panel } = await createChannelFor(world, alice);
  const rename = async (name: string) => {
    const { modal } = await fake.click(alice, panel, PanelButton.Name);
    return fake.submit(alice, channelId, modal!, { name });
  };

  await rename('One');
  await rename('Two');
  const third = await rename('Three');

  assert.match(third.message!.content, /two renames per channel every 10 minutes/u);
  assert.match(third.message!.content, /\*\*Three\*\* is saved/u);
  assert.equal(fake.channels.get(channelId)!.name, 'Two', 'the channel keeps its name for now');
  assert.equal(bot.store.getProfile(fake.guildId, alice)?.name, 'Three', 'but the new one is already saved');
  await until(() => textOf(fake.panelIn(channelId)!).includes('→ **Three**'), 'the panel to announce the pending rename');

  await until(() => fake.channels.get(channelId)!.name === 'Three', 'the delayed rename to be applied', 5_000);
  await until(() => !textOf(fake.panelIn(channelId)!).includes('→'), 'the panel to drop the pending notice');
  assert.equal(fake.requestsTo('PATCH', new RegExp(`^/channels/${channelId}$`, 'u')).filter((r) => r.body?.name).length, 3);
  assertClean(world);
});

test('if Discord itself refuses a rename as too frequent, it is rescheduled instead of hanging', async (t) => {
  // The bot's own count starts from zero after a restart, so Discord can be the first to object.
  const world = await createWorld({
    tuning: { renameLimit: 100 },
    renameLimit: { count: 1, windowMs: 60_000, retryAfterSeconds: 600 },
  });
  t.after(() => destroyWorld(world));
  const { fake, alice } = world;
  const { channelId, panel } = await createChannelFor(world, alice);
  const rename = async (name: string) => {
    const { modal } = await fake.click(alice, panel, PanelButton.Name);
    return fake.submit(alice, channelId, modal!, { name });
  };

  await rename('One');
  const second = await rename('Two');

  assert.match(second.message!.content, /\*\*Two\*\* is saved, and this channel will be renamed <t:\d+:R>/u);
  assert.equal(fake.channels.get(channelId)!.name, 'One');

  // Other settings are not held up by the rename limit.
  const { modal } = await fake.click(alice, panel, PanelButton.Limit);
  const limit = await fake.submit(alice, channelId, modal!, { limit: '2' });
  assert.match(limit.message!.content, /User limit set to \*\*2\*\*/u);
  assert.equal(fake.channels.get(channelId)!.user_limit, 2);
  assert.deepEqual(fake.unexpected, []);
  assert.deepEqual(fake.rejected, []);
});

test('changes made in Discord\'s own channel settings show up in the panel', async (t) => {
  const world = await createWorld();
  t.after(() => destroyWorld(world));
  const { fake, alice } = world;
  const { channelId } = await createChannelFor(world, alice);

  fake.editChannelByHand(channelId, { name: 'Renamed by an admin', user_limit: 7 });

  await until(() => {
    const text = textOf(fake.panelIn(channelId)!);
    return text.includes('Renamed by an admin') && text.includes('7 users');
  }, 'the panel to follow the manual change');
  assertClean(world);
});

test('names with markdown or mentions are shown literally and ping nobody', async (t) => {
  const world = await createWorld();
  t.after(() => destroyWorld(world));
  const { fake, alice, bob } = world;
  const { channelId, panel } = await createChannelFor(world, alice);

  const { modal } = await fake.click(alice, panel, PanelButton.Name);
  const submitted = await fake.submit(alice, channelId, modal!, { name: `**bold** <@${bob}> @everyone` });

  assert.equal(fake.channels.get(channelId)!.name, `**bold** <@${bob}> @everyone`);
  assert.match(submitted.message!.content, /\\\*\\\*bold\\\*\\\*/u, 'markdown is escaped');
  await until(() => textOf(fake.panelIn(channelId)!).includes('bold'), 'the panel to show the new name');
  assert.deepEqual(fake.panelIn(channelId)!.mentions, [], 'refreshing the panel pings nobody');
  const edits = fake.requestsTo('PATCH', new RegExp(`^/channels/${channelId}/messages/`, 'u'));
  assert.ok(edits.length > 0);
  for (const edit of edits) assert.deepEqual(edit.body?.allowed_mentions, { parse: [] });
  assertClean(world);
});
