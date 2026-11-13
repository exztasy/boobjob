import { RESTJSONErrorCodes, type Client, type VoiceChannel } from 'discord.js';
import type { Logger } from '../logger.js';
import type { Store, TempChannel } from '../storage/store.js';
import type { Tuning } from '../tuning.js';
import { renderPanel, type PanelView } from '../ui/panel.js';
import { hasApiCode, isVoiceChannel } from '../util/discord.js';
import type { KeyedQueue } from '../util/keyedQueue.js';
import type { RenameService } from './renames.js';

export interface PanelDeps {
  client: Client;
  store: Store;
  renames: RenameService;
  queue: KeyedQueue;
  log: Logger;
  tuning: Tuning;
}

/** Keeps the control panel message in each channel's chat in step with the channel. */
export class PanelService {
  private readonly timers = new Map<string, NodeJS.Timeout>();

  constructor(private readonly deps: PanelDeps) {}

  view(channel: VoiceChannel, record: TempChannel): PanelView {
    const { store, renames } = this.deps;
    const access = store.getChannelAccess(channel.id);
    return {
      channelName: channel.name,
      ownerId: record.ownerId,
      hubId: record.hubId && store.getHub(record.hubId) ? record.hubId : null,
      userLimit: channel.userLimit,
      bitrate: channel.bitrate,
      rtcRegion: channel.rtcRegion,
      videoQuality: channel.videoQualityMode,
      privacy: record.privacy,
      allowedCount: access.allowed.length,
      blockedCount: access.blocked.length,
      pendingName: renames.pendingFor(channel.id),
    };
  }

  /** Posts a new panel at the bottom of the channel's chat and removes the previous one. */
  post(channel: VoiceChannel, options: { mentionOwner: boolean }): Promise<void> {
    return this.deps.queue.run(`panel:${channel.id}`, async () => {
      const { store } = this.deps;
      const record = store.getTempChannel(channel.id);
      if (!record) return;

      let message;
      try {
        message = await channel.send({
          ...renderPanel(this.view(channel, record)),
          allowedMentions: { parse: [], users: options.mentionOwner ? [record.ownerId] : [] },
        });
      } catch (error) {
        // Removed in the meantime, typically because the owner left again right away.
        if (hasApiCode(error, RESTJSONErrorCodes.UnknownChannel)) return;
        throw error;
      }
      store.setPanelMessage(channel.id, message.id);

      if (record.panelMessageId) {
        await channel.messages.delete(record.panelMessageId).catch(() => undefined);
      }
    });
  }

  /** Asks for the panel to be brought up to date soon. Calls in quick succession cost one edit. */
  schedule(channelId: string): void {
    if (this.timers.has(channelId)) return;
    const timer = setTimeout(() => {
      this.timers.delete(channelId);
      this.refresh(channelId).catch((error: unknown) =>
        this.deps.log.warn(`Could not update the control panel of channel ${channelId}`, error),
      );
    }, this.deps.tuning.panelDebounceMs);
    timer.unref();
    this.timers.set(channelId, timer);
  }

  refresh(channelId: string): Promise<void> {
    return this.deps.queue.run(`panel:${channelId}`, async () => {
      const { client, store } = this.deps;
      const record = store.getTempChannel(channelId);
      if (!record?.panelMessageId) return;
      const channel = client.channels.cache.get(channelId);
      if (!isVoiceChannel(channel)) return;

      try {
        await channel.messages.edit(record.panelMessageId, {
          ...renderPanel(this.view(channel, record)),
          allowedMentions: { parse: [] },
        });
      } catch (error) {
        if (hasApiCode(error, RESTJSONErrorCodes.UnknownMessage)) {
          // Someone deleted the panel. `/voice panel` posts a new one.
          store.setPanelMessage(channelId, null);
        } else if (!hasApiCode(error, RESTJSONErrorCodes.UnknownChannel)) {
          throw error;
        }
      }
    });
  }

  forget(channelId: string): void {
    const timer = this.timers.get(channelId);
    if (timer) clearTimeout(timer);
    this.timers.delete(channelId);
  }

  stop(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }
}
