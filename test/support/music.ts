import assert from 'node:assert/strict';
import { textOf, type FakeDiscord, type Json } from './fakeDiscord.js';
import { until, type World } from './harness.js';

/** Runs a `/music` subcommand and returns the text of the (private) reply. */
export async function music(
  world: World,
  userId: string,
  subcommand: string,
  options: Record<string, string | number> = {},
  channelId = world.general,
): Promise<string> {
  const result = await world.fake.command(userId, channelId, 'music', subcommand, options);
  assert.ok(result.message, `/music ${subcommand} got no reply`);
  assert.ok((result.message.flags & (1 << 6)) !== 0, 'replies to /music are only for the person who asked');
  return textOf(result.message);
}

/** The "now playing" message in a voice channel's chat. */
export function musicPanelIn(fake: FakeDiscord, channelId: string): Json | undefined {
  return fake
    .messagesIn(channelId)
    .filter((message) => textOf(message).startsWith('### 🎵 Music'))
    .at(-1);
}

/** Waits until the "now playing" message in a channel says something. */
export async function panelShows(fake: FakeDiscord, channelId: string, pattern: RegExp): Promise<Json> {
  await until(() => pattern.test(textOf(musicPanelIn(fake, channelId) ?? {})), `the music message to show ${pattern}`);
  return musicPanelIn(fake, channelId)!;
}

/** The music bot connected to a voice channel, if any. */
export function musicBotIn(world: World, channelId: string): string | undefined {
  const bots = new Set([world.fake.botId, ...world.helpers]);
  return world.fake.membersIn(channelId).find((userId) => bots.has(userId));
}

/** Waits until a music bot is in a channel and returns it. */
export async function botJoins(world: World, channelId: string): Promise<string> {
  await until(() => musicBotIn(world, channelId) !== undefined, `a music bot to join ${channelId}`);
  return musicBotIn(world, channelId)!;
}

/** The title of what a bot's player is playing in the test server. */
export function playing(world: World, botId: string): string | undefined {
  return world.lavalink!.playerOf(botId, world.fake.guildId)?.track?.info.title;
}

export async function startsPlaying(world: World, botId: string, title: string): Promise<void> {
  await until(() => playing(world, botId) === title, `${botId} to play "${title}"`);
}

export function assertClean(world: Pick<World, 'fake' | 'log'>): void {
  assert.deepEqual(world.fake.unexpected, [], 'requests the fake does not know');
  assert.deepEqual(world.fake.rejected, [], 'payloads Discord would reject');
  assert.deepEqual(world.log.problems(), [], 'warnings and errors logged by the bot');
}
