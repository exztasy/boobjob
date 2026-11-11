import { Events, OAuth2Scopes, type Guild, type VoiceState } from 'discord.js';
import type { BotContext } from './context.js';
import { commandDefinitions } from './interactions/commands.js';
import { handleInteraction } from './interactions/router.js';
import { INVITE_PERMISSIONS } from './permissions.js';
import { isVoiceChannel } from './util/discord.js';

/** Connects Discord's events to the services. */
export function registerEvents(context: BotContext): void {
  const { client, store, log, voice, channels, panels, sanctions } = context;

  const reconcile = (guild: Guild): void => {
    channels
      .reconcileGuild(guild)
      .catch((error: unknown) => log.error(`Could not reconcile guild ${guild.id}`, error));
  };

  client.once(Events.ClientReady, (ready) => {
    log.info(`Logged in as ${ready.user.tag}, serving ${ready.guilds.cache.size} server(s)`);
    const invite = ready.generateInvite({
      scopes: [OAuth2Scopes.Bot, OAuth2Scopes.ApplicationsCommands],
      permissions: INVITE_PERMISSIONS,
    });
    log.info(`Invite link: ${invite}`);

    ready.application.commands.set(commandDefinitions).then(
      () => log.info('Slash commands are registered'),
      (error: unknown) => log.error('Could not register the slash commands', error),
    );
    // Catch up on whatever happened while the bot was offline.
    void channels.sweep();
  });

  client.on(Events.VoiceStateUpdate, (oldState: VoiceState, newState: VoiceState) => {
    const guild = newState.guild;
    const left = oldState.channelId;
    const joined = newState.channelId;

    // First of all, release whoever is waiting for exactly this change to show up.
    voice.notify(guild.id, newState.id);

    if (left !== joined) {
      if (left && store.getTempChannel(left)) {
        channels
          .handleLeave(guild, left)
          .catch((error: unknown) => log.error(`Could not clean up channel ${left} in guild ${guild.id}`, error));
      }
      if (joined && store.getHub(joined)) {
        const member = newState.member;
        if (member && !member.user.bot) {
          channels
            .handleHubJoin(member)
            .catch((error: unknown) => log.error(`Could not give ${member.user.tag} a channel in guild ${guild.id}`, error));
        }
      }
    }

    sanctions.handleVoiceStateUpdate(oldState, newState);
  });

  client.on(Events.ChannelDelete, (channel) => channels.handleChannelDelete(channel));

  // Someone with the permission to do so can edit a personal channel by hand; show that in the panel.
  client.on(Events.ChannelUpdate, (before, after) => {
    if (!isVoiceChannel(after) || !store.getTempChannel(after.id)) return;
    const changed =
      !isVoiceChannel(before) ||
      before.name !== after.name ||
      before.userLimit !== after.userLimit ||
      before.bitrate !== after.bitrate ||
      before.rtcRegion !== after.rtcRegion ||
      before.videoQualityMode !== after.videoQualityMode;
    if (changed) panels.schedule(after.id);
  });

  // A guild that (re)appears may have changed while we could not see it. While starting up,
  // discord.js reports every guild as newly available, which overlaps with the sweep above;
  // reconciling is idempotent, so doing it twice is harmless and neither path is relied on alone.
  client.on(Events.GuildCreate, reconcile);
  client.on(Events.GuildAvailable, reconcile);

  client.on(Events.InteractionCreate, (interaction) => void handleInteraction(context, interaction));

  client.on(Events.Error, (error) => log.error('Discord client error', error));
  client.on(Events.Warn, (message) => log.warn(message));
}
