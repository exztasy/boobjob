import { PermissionFlagsBits } from 'discord.js';
import { Bot } from '../../src/bot.js';
import type { MusicConfig } from '../../src/config.js';
import type { Logger } from '../../src/logger.js';
import type { Tuning } from '../../src/tuning.js';
import { FakeDiscord, MAIN_BOT_TOKEN, type FakeDiscordOptions, type Json } from './fakeDiscord.js';
import { FakeLavalink } from './fakeLavalink.js';

/** Timings short enough for tests to run in milliseconds. */
export const FAST: Partial<Tuning> = {
  createCooldownMs: 0,
  panelDebounceMs: 5,
  sweepIntervalMs: 60 * 60_000,
  voiceSettleMs: 500,
  failureNoticeCooldownMs: 0,
  failureNoticeTtlMs: 60_000,
  musicIdleMs: 60_000,
  musicAloneMs: 60_000,
  voiceJoinTimeoutMs: 1_000,
  voiceRecoveryMs: 100,
  lavalinkRetryMs: 50,
  lavalinkRequestTimeoutMs: 2_000,
  lavalinkPingMs: 60_000,
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
  /** The extra music bots, in the order of their tokens; empty without music. */
  helpers: string[];
  /** The music server; `null` when the world has no music. */
  lavalink: FakeLavalink | null;
}

export type StandardIds = Pick<World, 'category' | 'hub' | 'lounge' | 'general' | 'alice' | 'bob' | 'carol' | 'helpers'>;

export interface HelperSpec {
  name?: string;
  /** Set to false for a bot that was never invited to the server. */
  inServer?: boolean;
  roles?: string[];
  /** A token the fake does not know, so that logging in fails. */
  badToken?: boolean;
}

export interface MusicOptions {
  /** How many extra music bots there are, or what each of them is like. */
  helpers?: number | HelperSpec[];
  /** The password the bot is configured with, if it should not be the right one. */
  password?: string;
  /** Set to false to start without waiting for every bot to reach the music server. */
  waitForLavalink?: boolean;
  /** The music server is down when the bot starts; `lavalink.start()` brings it up. */
  lavalinkDown?: boolean;
}

export interface WorldOptions extends Partial<FakeDiscordOptions> {
  tuning?: Partial<Tuning>;
  /** Turns music on: a fake Lavalink, plus extra music bots if asked for. */
  music?: MusicOptions;
  databasePath?: string;
  /** Set to `false` to start without the standard hub being registered. */
  registerHub?: boolean;
  onFatalDisconnect?: (closeCode: number) => void;
  /** Runs after the standard server is built and before the bot connects. */
  prepare?: (fake: FakeDiscord, ids: StandardIds) => void;
}

export async function createWorld(options: WorldOptions = {}): Promise<World> {
  const { tuning, databasePath, prepare, registerHub = true, onFatalDisconnect, music: musicOptions, ...fakeOptions } = options;
  const fake = new FakeDiscord({ botPermissions: PermissionFlagsBits.Administrator, ...fakeOptions });

  let lavalink: FakeLavalink | null = null;
  let music: MusicConfig | null = null;
  const helpers: string[] = [];
  if (musicOptions) {
    lavalink = new FakeLavalink();
    // Started even when it is meant to be down, to settle on a port it can come back on.
    await lavalink.start();
    if (musicOptions.lavalinkDown) await lavalink.stop();
    const specs: HelperSpec[] =
      typeof musicOptions.helpers === 'number'
        ? Array.from({ length: musicOptions.helpers }, () => ({}))
        : (musicOptions.helpers ?? []);
    const tokens = specs.map((spec, index) => {
      const token = `helper-token-${index + 1}`;
      helpers.push(
        fake.addBot(spec.name ?? `musicbot${index + 1}`, { token, inServer: spec.inServer, roles: spec.roles }),
      );
      return spec.badToken ? `${token}-reset` : token;
    });
    music = {
      lavalink: { ...lavalink.address, password: musicOptions.password ?? lavalink.password },
      botTokens: tokens,
    };
  }

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
    helpers,
  };
  prepare?.(fake, ids);

  await fake.start();
  let started;
  try {
    started = await startBot(fake, {
      tuning,
      databasePath,
      onFatalDisconnect,
      music,
      waitForLavalink: musicOptions?.lavalinkDown ? false : musicOptions?.waitForLavalink,
    });
  } catch (error) {
    // A world that did not come up must not linger and keep the test process alive.
    await fake.stop();
    await lavalink?.stop();
    throw error;
  }
  const { bot, log } = started;
  if (registerHub) bot.store.addHub(fake.guildId, hub);
  return { fake, bot, log, lavalink, ...ids };
}

/** Starts a bot against the fake and waits until it has finished starting up. */
export async function startBot(
  fake: FakeDiscord,
  options: {
    tuning?: Partial<Tuning>;
    databasePath?: string;
    onFatalDisconnect?: (closeCode: number) => void;
    music?: MusicConfig | null;
    waitForLavalink?: boolean;
  } = {},
): Promise<{ bot: Bot; log: RecordingLogger }> {
  const log = new RecordingLogger();
  const registrationsBefore = fake.requestsTo('PUT', /\/commands$/u).length;
  const bot = new Bot({
    token: MAIN_BOT_TOKEN,
    databasePath: options.databasePath ?? ':memory:',
    log,
    tuning: { ...FAST, ...options.tuning },
    clientOptions: { rest: { makeRequest: fake.makeRequest } },
    onFatalDisconnect: options.onFatalDisconnect,
    music: options.music,
  });
  try {
    await bot.start();
    await until(
      () => bot.client.isReady() && fake.requestsTo('PUT', /\/commands$/u).length > registrationsBefore,
      'the bot to finish starting up',
    );
    const music = bot.context.music;
    if (music && options.waitForLavalink !== false) {
      await until(
        () => music.bots.every((player) => player.usable || player.loginFailed),
        'every music bot to reach the music server',
      );
    }
  } catch (error) {
    await bot.stop();
    throw error;
  }
  return { bot, log };
}

export async function destroyWorld(world: Pick<World, 'fake' | 'bot'> & { lavalink?: FakeLavalink | null }): Promise<void> {
  await world.bot.stop();
  await world.fake.stop();
  await world.lavalink?.stop();
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
