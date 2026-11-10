import { PermissionFlagsBits } from 'discord.js';
import { Bot } from '../../src/bot.js';
import type { Logger } from '../../src/logger.js';
import type { Tuning } from '../../src/tuning.js';
import { FakeDiscord, type FakeDiscordOptions, type Json } from './fakeDiscord.js';

/** Timings short enough for tests to run in milliseconds. */
export const FAST: Partial<Tuning> = {
  createCooldownMs: 0,
  emptyGraceMs: 0,
  panelDebounceMs: 5,
  sweepIntervalMs: 60 * 60_000,
  voiceSettleMs: 500,
  failureNoticeCooldownMs: 0,
  failureNoticeTtlMs: 60_000,
};

export interface LogEntry {
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  details: unknown[];
}

/** Collects what the bot logs, so a test can check that nothing went wrong quietly. */
export class RecordingLogger implements Logger {
  readonly entries: LogEntry[] = [];

  debug(message: string, ...details: unknown[]): void {
    this.entries.push({ level: 'debug', message, details });
  }
  info(message: string, ...details: unknown[]): void {
    this.entries.push({ level: 'info', message, details });
  }
  warn(message: string, ...details: unknown[]): void {
    this.entries.push({ level: 'warn', message, details });
  }
  error(message: string, ...details: unknown[]): void {
    this.entries.push({ level: 'error', message, details });
  }

  /** Warnings and errors, formatted for an assertion message. */
  problems(): string[] {
    return this.entries
      .filter((entry) => entry.level === 'warn' || entry.level === 'error')
      .map((entry) => `${entry.level}: ${entry.message} ${entry.details.map((detail) => String(detail)).join(' ')}`.trim());
  }
}

/** A running bot connected to a fake Discord server with a hub and a few people. */
export interface World {
  fake: FakeDiscord;
  bot: Bot;
  log: RecordingLogger;
  category: string;
  hub: string;
  /** An ordinary voice channel that is not managed by the bot. */
  lounge: string;
  /** An ordinary text channel. */
  general: string;
  alice: string;
  bob: string;
  carol: string;
}

export type StandardIds = Pick<World, 'category' | 'hub' | 'lounge' | 'general' | 'alice' | 'bob' | 'carol'>;

export interface WorldOptions extends Partial<FakeDiscordOptions> {
  tuning?: Partial<Tuning>;
  databasePath?: string;
  /** Set to `false` to start without the standard hub being registered. */
  registerHub?: boolean;
  /** Runs after the standard server is built and before the bot connects. */
  prepare?: (fake: FakeDiscord, ids: StandardIds) => void;
}

export async function createWorld(options: WorldOptions = {}): Promise<World> {
  const { tuning, databasePath, prepare, registerHub = true, ...fakeOptions } = options;
  const fake = new FakeDiscord({ botPermissions: PermissionFlagsBits.Administrator, ...fakeOptions });

  const category = fake.addCategory('Voice channels');
  const hub = fake.addVoiceChannel('➕ Create a channel', { parent: category });
  const lounge = fake.addVoiceChannel('Lounge', { parent: category });
  const general = fake.addTextChannel('general');
  const ids: StandardIds = {
    category,
    hub,
    lounge,
    general,
    alice: fake.addUser('alice'),
    bob: fake.addUser('bob'),
    carol: fake.addUser('carol'),
  };
  prepare?.(fake, ids);

  await fake.start();
  const { bot, log } = await startBot(fake, { tuning, databasePath });
  if (registerHub) bot.store.addHub(fake.guildId, hub);
  return { fake, bot, log, ...ids };
}

/** Starts a bot against the fake and waits until it has finished starting up. */
export async function startBot(
  fake: FakeDiscord,
  options: { tuning?: Partial<Tuning>; databasePath?: string } = {},
): Promise<{ bot: Bot; log: RecordingLogger }> {
  const log = new RecordingLogger();
  const registrationsBefore = fake.requestsTo('PUT', /\/commands$/u).length;
  const bot = new Bot({
    token: 'fake-token',
    databasePath: options.databasePath ?? ':memory:',
    log,
    tuning: { ...FAST, ...options.tuning },
    clientOptions: { rest: { makeRequest: fake.makeRequest } },
  });
  await bot.start();
  await until(
    () => bot.client.isReady() && fake.requestsTo('PUT', /\/commands$/u).length > registrationsBefore,
    'the bot to finish starting up',
  );
  return { bot, log };
}

export async function destroyWorld(world: Pick<World, 'fake' | 'bot'>): Promise<void> {
  await world.bot.stop();
  await world.fake.stop();
}

/** Waits for something the bot does in the background. */
export async function until(check: () => boolean, what: string, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

/** Lets the bot finish whatever it is doing, then checks that nothing else happens. */
export async function settle(ms = 40): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/** The personal channel the bot currently has on record for a member. */
export function channelOwnedBy(world: World, userId: string): string | undefined {
  return world.bot.store.getTempChannelByOwner(world.fake.guildId, userId)?.channelId;
}

/** Joins the hub and waits until the member has been moved into a channel of their own. */
export async function createChannelFor(world: World, userId: string): Promise<{ channelId: string; panel: Json }> {
  const { fake, hub } = world;
  fake.join(userId, hub);
  await until(() => {
    const current = fake.channelOf(userId);
    return current !== null && current !== hub && channelOwnedBy(world, userId) === current;
  }, 'the member to be moved into their own channel');
  const channelId = fake.channelOf(userId)!;
  await until(() => fake.panelIn(channelId) !== undefined, 'the control panel to be posted');
  return { channelId, panel: fake.panelIn(channelId)! };
}
