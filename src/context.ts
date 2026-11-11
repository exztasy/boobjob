import type { Client } from 'discord.js';
import type { Logger } from './logger.js';
import type { ActionService } from './services/actions.js';
import type { ChannelService } from './services/channels.js';
import type { PanelService } from './services/panels.js';
import type { RegionService } from './services/regions.js';
import type { SanctionService } from './services/sanctions.js';
import type { Store } from './storage/store.js';
import type { VoiceStateWaiter } from './util/voiceWaiter.js';

/** Everything an event or interaction handler may need. */
export interface BotContext {
  client: Client;
  store: Store;
  log: Logger;
  voice: VoiceStateWaiter;
  channels: ChannelService;
  panels: PanelService;
  sanctions: SanctionService;
  actions: ActionService;
  regions: RegionService;
}
