import { Client, Events, GatewayIntentBits, type ClientOptions, type RateLimitData } from 'discord.js';
import type { BotContext } from './context.js';
import { RenameLimiter } from './domain/renameLimiter.js';
import { registerEvents } from './events.js';
import type { Logger } from './logger.js';
import { ActionService } from './services/actions.js';
import { ChannelService } from './services/channels.js';
import { PanelService } from './services/panels.js';
import { RegionService } from './services/regions.js';
import { RenameService } from './services/renames.js';
import { SanctionService } from './services/sanctions.js';
import { openDatabase } from './storage/database.js';
import { Store } from './storage/store.js';
import { DEFAULT_TUNING, type Tuning } from './tuning.js';
import { KeyedQueue } from './util/keyedQueue.js';
import { VoiceStateWaiter } from './util/voiceWaiter.js';

export interface BotOptions {
  token: string;
  databasePath: string;
  log: Logger;
  tuning?: Partial<Tuning>;
  /** Overrides for the Discord client; tests use this to point it at a fake Discord. */
  clientOptions?: Partial<ClientOptions>;
  /**
   * Called when Discord closes the connection in a way it will not let us
   * recover from, for instance because the token was reset. The bot can do
   * nothing more after that, so the caller is expected to stop it.
   */
  onFatalDisconnect?: (closeCode: number) => void;
}

/**
 * Discord answers a third rename of a channel within ten minutes with a rate
 * limit that lasts until the window is over, and the client's default is to
 * sit and wait for it. Failing fast instead lets the rename be scheduled and
 * the person be told what is going on.
 */
function rejectLongChannelEditWaits(limit: RateLimitData): boolean {
  return (
    limit.route === '/channels/:id' &&
    limit.method.toUpperCase() === 'PATCH' &&
    Math.max(limit.retryAfter, limit.timeToReset) > 5_000
  );
}

export class Bot {
  readonly client: Client;
  readonly store: Store;
  readonly context: BotContext;
  private readonly renames: RenameService;
  private readonly tuning: Tuning;
  private sweepTimer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(private readonly options: BotOptions) {
    const { log } = options;
    const tuning = (this.tuning = { ...DEFAULT_TUNING, ...options.tuning });

    this.store = new Store(openDatabase(options.databasePath));
    this.client = new Client({
      // Channels and roles, plus who is in which voice channel. Nothing privileged is needed.
      intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
      // Names typed by users end up in our messages; they must never ping anyone by accident.
      allowedMentions: { parse: [] },
      ...options.clientOptions,
      rest: { rejectOnRateLimit: rejectLongChannelEditWaits, ...options.clientOptions?.rest },
    });

    const { client, store } = this;
    const queue = new KeyedQueue();
    const voice = new VoiceStateWaiter();
    const renames = (this.renames = new RenameService(new RenameLimiter(tuning.renameLimit, tuning.renameWindowMs), log));
    const panels = new PanelService({ client, store, renames, queue, log, tuning });
    renames.onApplied = (channelId) => panels.schedule(channelId);
    const sanctions = new SanctionService({ store, queue, voice, log, tuning });
    const channels = new ChannelService({ client, store, queue, voice, panels, sanctions, renames, log, tuning });
    const regions = new RegionService(client, log);
    const actions = new ActionService({ store, queue, channels, panels, sanctions, renames, regions, log });

    this.context = { client, store, log, voice, channels, panels, sanctions, actions, regions };
    registerEvents(this.context);
    // discord.js reconnects by itself after ordinary drops; this fires only when it has given up.
    client.on(Events.ShardDisconnect, (closeEvent) => options.onFatalDisconnect?.(closeEvent.code));
  }

  /** Connects to Discord. Resolves once logged in; the bot is fully up when the client emits `clientReady`. */
  async start(): Promise<void> {
    await this.client.login(this.options.token);

    this.sweepTimer = setInterval(() => void this.context.channels.sweep(), this.tuning.sweepIntervalMs);
    this.sweepTimer.unref();
  }

  /**
   * Disconnects from Discord and closes the database. Saying goodbye to
   * Discord is a courtesy and closing the database is not, so if Discord is
   * slow or unreachable the wait is cut short: a process that is being
   * stopped usually has only a few seconds before it is killed.
   */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    const { log } = this.options;

    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
    this.context.panels.stop();
    this.renames.stop();

    let timer: NodeJS.Timeout | undefined;
    const disconnected = this.client.destroy().then(
      () => true,
      (error: unknown) => {
        log.warn('Could not disconnect from Discord cleanly', error);
        return true;
      },
    );
    const gaveUp = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), this.tuning.shutdownTimeoutMs);
    });
    const confirmed = await Promise.race([disconnected, gaveUp]);
    clearTimeout(timer);
    if (!confirmed) {
      log.warn(`Discord did not confirm the disconnect within ${this.tuning.shutdownTimeoutMs} ms; shutting down regardless`);
    }

    this.store.close();
  }
}
