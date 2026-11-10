import {
  ChannelType,
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  VideoQualityMode,
  channelMention,
  escapeMarkdown,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
  type GuildMember,
  type RESTPostAPIChatInputApplicationCommandsJSONBody,
  type VoiceChannel,
} from 'discord.js';
import type { BotContext } from '../context.js';
import { MAX_NAME_LENGTH, MAX_USER_LIMIT, sanitizeName } from '../domain/settings.js';
import { UserError } from '../errors.js';
import { FEATURE_PERMISSIONS, REQUIRED_PERMISSIONS, missingPermissions } from '../permissions.js';
import { AUTOMATIC_REGION } from '../ui/ids.js';
import { describeError, isVoiceChannel } from '../util/discord.js';

const DEFAULT_HUB_NAME = '➕ Create a channel';
const NO_MENTIONS = { parse: [] } as const;

/** `/voice` subcommands that act on one person. */
const PERSON_SUBCOMMANDS = [
  ['allow', 'Let someone see and join your channel, now and in the future'],
  ['disallow', 'Take someone off your allowed list'],
  ['block', 'Keep someone out of your channel, now and in the future'],
  ['unblock', 'Take someone off your blocked list'],
  ['kick', 'Disconnect someone from your channel'],
  ['mute', 'Mute someone for as long as they are in your channel'],
  ['unmute', 'Undo a mute'],
  ['deafen', 'Deafen someone for as long as they are in your channel'],
  ['undeafen', 'Undo a deafen'],
  ['transfer', 'Hand your channel to someone else who is in it'],
] as const;

function voiceCommand(): RESTPostAPIChatInputApplicationCommandsJSONBody {
  const command = new SlashCommandBuilder()
    .setName('voice')
    .setDescription('Manage your temporary voice channel')
    .setContexts(InteractionContextType.Guild)
    .addSubcommand((sub) => sub.setName('panel').setDescription('Post a fresh control panel in your channel'))
    .addSubcommand((sub) =>
      sub
        .setName('name')
        .setDescription('Rename your channel')
        .addStringOption((option) =>
          option
            .setName('name')
            .setDescription('The new name; leave out to go back to the default')
            .setMaxLength(MAX_NAME_LENGTH),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('limit')
        .setDescription('Set how many people can join your channel')
        .addIntegerOption((option) =>
          option
            .setName('users')
            .setDescription(`1 to ${MAX_USER_LIMIT}, or 0 for no limit`)
            .setMinValue(0)
            .setMaxValue(MAX_USER_LIMIT)
            .setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('bitrate')
        .setDescription('Set the audio quality of your channel')
        .addIntegerOption((option) =>
          option.setName('kbps').setDescription('Bitrate in kbps').setMinValue(8).setMaxValue(384).setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('region')
        .setDescription('Set the voice region of your channel')
        .addStringOption((option) =>
          option.setName('region').setDescription('Leave out to let Discord choose').setAutocomplete(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('video')
        .setDescription('Set the video quality of your channel')
        .addStringOption((option) =>
          option
            .setName('quality')
            .setDescription('Video quality')
            .setRequired(true)
            .addChoices({ name: 'Auto', value: 'auto' }, { name: '720p', value: 'full' }),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('privacy')
        .setDescription('Choose who can see and join your channel')
        .addStringOption((option) =>
          option
            .setName('mode')
            .setDescription('Privacy mode')
            .setRequired(true)
            .addChoices(
              { name: 'Hidden: only people you allow can see or join', value: 'hidden' },
              { name: 'Locked: visible, but only people you allow can join', value: 'locked' },
              { name: 'Public: anyone can join', value: 'public' },
            ),
        ),
    );

  for (const [name, description] of PERSON_SUBCOMMANDS) {
    command.addSubcommand((sub) =>
      sub
        .setName(name)
        .setDescription(description)
        .addUserOption((option) => option.setName('user').setDescription('Who').setRequired(true)),
    );
  }
  command.addSubcommand((sub) =>
    sub.setName('claim').setDescription('Take over the channel you are in after its owner has left'),
  );

  return command.toJSON();
}

function hubCommand(): RESTPostAPIChatInputApplicationCommandsJSONBody {
  return new SlashCommandBuilder()
    .setName('voicehub')
    .setDescription('Set up join-to-create voice channels')
    .setContexts(InteractionContextType.Guild)
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((sub) =>
      sub
        .setName('setup')
        .setDescription('Create a voice channel that gives everyone who joins it a channel of their own')
        .addStringOption((option) =>
          option.setName('name').setDescription('Name for the hub channel').setMaxLength(MAX_NAME_LENGTH),
        )
        .addChannelOption((option) =>
          option
            .setName('category')
            .setDescription('Category to create it (and the personal channels) in')
            .addChannelTypes(ChannelType.GuildCategory),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('add')
        .setDescription('Turn an existing voice channel into a hub')
        .addChannelOption((option) =>
          option
            .setName('channel')
            .setDescription('The voice channel')
            .addChannelTypes(ChannelType.GuildVoice)
            .setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('remove')
        .setDescription('Stop using a voice channel as a hub (the channel itself is kept)')
        .addChannelOption((option) =>
          option
            .setName('channel')
            .setDescription('The hub channel')
            .addChannelTypes(ChannelType.GuildVoice)
            .setRequired(true),
        ),
    )
    .addSubcommand((sub) => sub.setName('list').setDescription('Show the hubs and check my permissions'))
    .toJSON();
}

/** What gets registered with Discord. */
export const commandDefinitions: RESTPostAPIChatInputApplicationCommandsJSONBody[] = [voiceCommand(), hubCommand()];

export async function handleCommand(
  context: BotContext,
  interaction: ChatInputCommandInteraction<'cached'>,
): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  let content: string;
  try {
    content =
      interaction.commandName === 'voicehub'
        ? await runHubCommand(context, interaction)
        : await runVoiceCommand(context, interaction);
  } catch (error) {
    if (!(error instanceof UserError)) {
      context.log.error(`/${interaction.commandName} ${interaction.options.getSubcommand(false) ?? ''} failed`, error);
    }
    content = `⚠️ ${describeError(error)}`;
  }
  await interaction.editReply({ content, allowedMentions: NO_MENTIONS });
}

export async function handleAutocomplete(
  context: BotContext,
  interaction: AutocompleteInteraction<'cached'>,
): Promise<void> {
  const typed = interaction.options.getFocused().trim().toLowerCase();
  const regions = await context.regions.list();
  const choices = [
    { name: 'Automatic', value: AUTOMATIC_REGION },
    ...regions.map((region) => ({ name: region.name, value: region.id })),
  ].filter((choice) => choice.name.toLowerCase().includes(typed) || choice.value.includes(typed));
  await interaction.respond(choices.slice(0, 25));
}

// ── /voice ────────────────────────────────────────────────────────────────

async function runVoiceCommand(
  context: BotContext,
  interaction: ChatInputCommandInteraction<'cached'>,
): Promise<string> {
  const { actions } = context;
  const { options } = interaction;
  const actor = interaction.member;
  const channel = targetChannel(context, interaction);
  const subcommand = options.getSubcommand(true);

  switch (subcommand) {
    case 'panel':
      return actions.repostPanel(channel, actor);
    case 'name':
      return actions.rename(channel, actor, options.getString('name'));
    case 'limit':
      return actions.setUserLimit(channel, actor, options.getInteger('users', true));
    case 'bitrate':
      return actions.setBitrate(channel, actor, options.getInteger('kbps', true));
    case 'region': {
      const region = options.getString('region');
      return actions.setRegion(channel, actor, !region || region === AUTOMATIC_REGION ? null : region);
    }
    case 'video': {
      const full = options.getString('quality', true) === 'full';
      return actions.setVideoQuality(channel, actor, full ? VideoQualityMode.Full : VideoQualityMode.Auto);
    }
    case 'privacy':
      return actions.setPrivacy(channel, actor, options.getString('mode', true));
    case 'allow':
      return actions.updateAccess(channel, actor, 'allow', [serverMember(interaction).id], []);
    case 'disallow':
      return actions.updateAccess(channel, actor, 'allow', [], [options.getUser('user', true).id]);
    case 'block':
      return actions.updateAccess(channel, actor, 'block', [serverMember(interaction).id], []);
    case 'unblock':
      return actions.updateAccess(channel, actor, 'block', [], [options.getUser('user', true).id]);
    case 'kick':
      return actions.kick(channel, actor, [options.getUser('user', true).id]);
    case 'mute':
      return actions.setSanctions(channel, actor, 'mute', [options.getUser('user', true).id], []);
    case 'unmute':
      return actions.setSanctions(channel, actor, 'mute', [], [options.getUser('user', true).id]);
    case 'deafen':
      return actions.setSanctions(channel, actor, 'deafen', [options.getUser('user', true).id], []);
    case 'undeafen':
      return actions.setSanctions(channel, actor, 'deafen', [], [options.getUser('user', true).id]);
    case 'transfer':
      return actions.transfer(channel, actor, options.getUser('user', true).id);
    case 'claim':
      return actions.claim(channel, actor);
    default:
      throw new UserError(`I don't know the command \`/voice ${subcommand}\`.`);
  }
}

/**
 * Which channel a `/voice` command is about: the one it was typed in, else
 * the one the member is sitting in, else the one they own.
 */
function targetChannel(context: BotContext, interaction: ChatInputCommandInteraction<'cached'>): VoiceChannel {
  const { store } = context;
  const guild = interaction.guild;

  const here = interaction.channel;
  if (isVoiceChannel(here) && store.getTempChannel(here.id)) return here;

  const connected = interaction.member.voice.channel;
  if (isVoiceChannel(connected) && store.getTempChannel(connected.id)) return connected;

  const owned = store.getTempChannelByOwner(guild.id, interaction.user.id);
  const ownedChannel = owned ? guild.channels.cache.get(owned.channelId) : undefined;
  if (isVoiceChannel(ownedChannel)) return ownedChannel;

  const hub = store.listHubs(guild.id).find((candidate) => guild.channels.cache.has(candidate.channelId));
  throw new UserError(
    hub
      ? `You don't have a voice channel at the moment. Join ${channelMention(hub.channelId)} to get one.`
      : "You don't have a voice channel at the moment, and this server has no hub yet. An admin can create one with `/voicehub setup`.",
  );
}

function serverMember(interaction: ChatInputCommandInteraction<'cached'>): GuildMember {
  const member = interaction.options.getMember('user');
  if (!member) throw new UserError('That user is not a member of this server.');
  return member;
}

// ── /voicehub ─────────────────────────────────────────────────────────────

async function runHubCommand(context: BotContext, interaction: ChatInputCommandInteraction<'cached'>): Promise<string> {
  const { store, channels, log } = context;
  const { options, guild } = interaction;
  if (!interaction.memberPermissions.has(PermissionFlagsBits.ManageGuild)) {
    throw new UserError('You need the Manage Server permission to set up voice hubs.');
  }
  const me = guild.members.me ?? (await guild.members.fetchMe());
  const subcommand = options.getSubcommand(true);

  switch (subcommand) {
    case 'setup': {
      const name = sanitizeName(options.getString('name') ?? '') ?? DEFAULT_HUB_NAME;
      const category = options.getChannel('category', false, [ChannelType.GuildCategory]);
      const hub = await guild.channels.create({
        name,
        type: ChannelType.GuildVoice,
        parent: category?.id ?? null,
        reason: `Voice hub created by ${interaction.user.tag}`,
      });
      store.addHub(guild.id, hub.id);
      return [
        `✅ Created ${channelMention(hub.id)}. Everyone who joins it gets a private voice channel of their own${category ? ` in **${escapeMarkdown(category.name)}**` : ''}.`,
        permissionReport(me),
      ].join('\n\n');
    }

    case 'add': {
      const channel = options.getChannel('channel', true, [ChannelType.GuildVoice]);
      if (store.getTempChannel(channel.id)) {
        throw new UserError("That is someone's temporary channel, so it can't be a hub.");
      }
      if (store.getHub(channel.id)) return `${channelMention(channel.id)} is already a hub.`;
      store.addHub(guild.id, channel.id);
      // Anyone already sitting in it should not have to rejoin.
      channels
        .reconcileGuild(guild)
        .catch((error: unknown) => log.error(`Could not reconcile guild ${guild.id} after adding a hub`, error));
      return [
        `✅ ${channelMention(channel.id)} is now a hub. Everyone who joins it gets a private voice channel of their own.`,
        permissionReport(me),
      ].join('\n\n');
    }

    case 'remove': {
      const channel = options.getChannel('channel', true, [ChannelType.GuildVoice]);
      if (!store.removeHub(channel.id)) throw new UserError(`${channelMention(channel.id)} is not a hub.`);
      return `✅ ${channelMention(channel.id)} is no longer a hub. The channel itself was left alone, and existing personal channels keep working until they empty.`;
    }

    case 'list': {
      const hubs = store.listHubs(guild.id).filter((hub) => guild.channels.cache.has(hub.channelId));
      const lines = hubs.map((hub) => {
        const channel = guild.channels.cache.get(hub.channelId);
        const where = channel?.parent ? `in **${escapeMarkdown(channel.parent.name)}**` : 'outside any category';
        return `• ${channelMention(hub.channelId)} creates channels ${where}`;
      });
      return [
        lines.length > 0 ? ['**Voice hubs**', ...lines].join('\n') : 'There are no hubs yet. Create one with `/voicehub setup`.',
        permissionReport(me),
      ].join('\n\n');
    }

    default:
      throw new UserError(`I don't know the command \`/voicehub ${subcommand}\`.`);
  }
}

/** Tells an admin whether the bot's role is set up correctly, and what to fix if not. */
function permissionReport(me: GuildMember): string {
  const required = missingPermissions(me, REQUIRED_PERMISSIONS);
  const optional = missingPermissions(me, FEATURE_PERMISSIONS);
  if (required.length === 0 && optional.length === 0) return '✅ My role has every permission I need.';

  const lines: string[] = [];
  if (required.length > 0) {
    lines.push(`⚠️ I can't create private channels until my role has: **${required.join('**, **')}**.`);
  }
  if (optional.length > 0) {
    lines.push(`⚠️ Mute, deafen or the control panel won't work until my role has: **${optional.join('**, **')}**.`);
  }
  lines.push('Grant them in Server Settings → Roles. They need to be on the role itself, not on a single channel.');
  return lines.join('\n');
}
