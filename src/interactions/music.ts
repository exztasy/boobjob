import {
  InteractionContextType,
  MessageFlags,
  RESTJSONErrorCodes,
  SlashCommandBuilder,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type RESTPostAPIChatInputApplicationCommandsJSONBody,
} from 'discord.js';
import type { BotContext } from '../context.js';
import { UserError } from '../errors.js';
import { DEFAULT_SEARCH_SOURCE, MAX_QUERY_LENGTH, SEARCH_SOURCES, isSearchSource } from '../music/query.js';
import { LOOP_MODES, type LoopMode } from '../music/queue.js';
import { MAX_VOLUME, mayManageBots, type MusicService } from '../music/service.js';
import { parseMusicId } from '../ui/ids.js';
import { renderEndedMusicPanel } from '../ui/musicPanel.js';
import { describeError, hasApiCode } from '../util/discord.js';

const NO_MENTIONS = { parse: [] } as const;

/** The `/music` command, registered only when the bot has a Lavalink server to play from. */
export function musicCommand(): RESTPostAPIChatInputApplicationCommandsJSONBody {
  return new SlashCommandBuilder()
    .setName('music')
    .setDescription('Play music in your voice channel')
    .setContexts(InteractionContextType.Guild)
    .addSubcommand((sub) =>
      sub
        .setName('play')
        .setDescription('Play a song or playlist in your voice channel, or add it to the queue')
        .addStringOption((option) =>
          option
            .setName('query')
            .setDescription('A YouTube, Spotify or SoundCloud link, or what to search for')
            .setMaxLength(MAX_QUERY_LENGTH)
            .setRequired(true),
        )
        .addStringOption((option) =>
          option
            .setName('source')
            .setDescription(`Where to search when it is not a link (default: ${SEARCH_SOURCES[DEFAULT_SEARCH_SOURCE].label})`)
            .addChoices(...Object.entries(SEARCH_SOURCES).map(([value, source]) => ({ name: source.label, value }))),
        ),
    )
    .addSubcommand((sub) => sub.setName('pause').setDescription('Pause the music'))
    .addSubcommand((sub) => sub.setName('resume').setDescription('Carry on after a pause'))
    .addSubcommand((sub) => sub.setName('skip').setDescription('Skip to the next track in the queue'))
    .addSubcommand((sub) => sub.setName('stop').setDescription('Stop the music, clear the queue and send the bot away'))
    .addSubcommand((sub) =>
      sub
        .setName('queue')
        .setDescription('Show what is playing and what is up next')
        .addIntegerOption((option) => option.setName('page').setDescription('Which page of the queue').setMinValue(1)),
    )
    .addSubcommand((sub) => sub.setName('nowplaying').setDescription('Show the current track and how far along it is'))
    .addSubcommand((sub) =>
      sub
        .setName('volume')
        .setDescription('Set how loud the music is')
        .addIntegerOption((option) =>
          option
            .setName('percent')
            .setDescription(`0 to ${MAX_VOLUME}; 100 is normal`)
            .setMinValue(0)
            .setMaxValue(MAX_VOLUME)
            .setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('loop')
        .setDescription('Repeat the current track or the whole queue')
        .addStringOption((option) =>
          option
            .setName('mode')
            .setDescription('What to repeat')
            .setRequired(true)
            .addChoices(
              { name: 'Off', value: 'off' },
              { name: 'Track: repeat the current track', value: 'track' },
              { name: 'Queue: start over when the queue has played', value: 'queue' },
            ),
        ),
    )
    .addSubcommand((sub) => sub.setName('shuffle').setDescription('Put the waiting tracks in a random order'))
    .addSubcommand((sub) =>
      sub
        .setName('remove')
        .setDescription('Take a track out of the queue')
        .addIntegerOption((option) =>
          option
            .setName('position')
            .setDescription('Its number in /music queue')
            .setMinValue(1)
            .setRequired(true),
        ),
    )
    .addSubcommand((sub) => sub.setName('bots').setDescription('Show the music bots and what each one is doing'))
    .toJSON();
}

export async function handleMusicCommand(
  context: BotContext,
  interaction: ChatInputCommandInteraction<'cached'>,
): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  let content: string;
  try {
    if (!context.music) throw new UserError('Music is not set up on this bot.');
    content = await runMusicCommand(context.music, interaction);
  } catch (error) {
    if (!(error instanceof UserError)) {
      context.log.error(`/music ${interaction.options.getSubcommand(false) ?? ''} failed`, error);
    }
    content = `⚠️ ${describeError(error)}`;
  }
  await interaction.editReply({ content, allowedMentions: NO_MENTIONS });
}

async function runMusicCommand(music: MusicService, interaction: ChatInputCommandInteraction<'cached'>): Promise<string> {
  const { options, member } = interaction;
  const subcommand = options.getSubcommand(true);

  switch (subcommand) {
    case 'play': {
      const source = options.getString('source');
      return music.play(member, options.getString('query', true), source && isSearchSource(source) ? source : undefined);
    }
    case 'pause':
      return music.pause(member);
    case 'resume':
      return music.resume(member);
    case 'skip':
      return music.skip(member);
    case 'stop':
      return music.stopPlaying(member);
    case 'queue':
      return music.describeQueue(member, options.getInteger('page') ?? 1);
    case 'nowplaying':
      return music.nowPlaying(member);
    case 'volume':
      return music.setVolume(member, options.getInteger('percent', true));
    case 'loop': {
      const mode = options.getString('mode', true);
      if (!isLoopMode(mode)) throw new UserError('The loop mode is one of off, track or queue.');
      return music.setLoop(member, mode);
    }
    case 'shuffle':
      return music.shuffle(member);
    case 'remove':
      return music.remove(member, options.getInteger('position', true));
    case 'bots':
      return music.status(interaction.guild, mayManageBots(member));
    default:
      throw new UserError(`I don't know the command \`/music ${subcommand}\`.`);
  }
}

/** A press on one of the buttons under the "now playing" message. */
export async function handleMusicButton(context: BotContext, interaction: ButtonInteraction<'cached'>): Promise<void> {
  const action = parseMusicId(interaction.customId);
  const { music } = context;
  if (!action) return;

  const session = music?.sessionIn(interaction.channelId);
  if (!music || !session || session.panelMessageId !== interaction.message.id) {
    // The controls of music that is over, left behind by a restart for instance. Put them away.
    await interaction.update({ ...renderEndedMusicPanel('The music has stopped.'), allowedMentions: NO_MENTIONS });
    return;
  }
  if (interaction.member.voice.channelId !== interaction.channelId) {
    await interaction.reply({
      content: '⚠️ Join this voice channel to control the music in it.',
      flags: MessageFlags.Ephemeral,
      allowedMentions: NO_MENTIONS,
    });
    return;
  }

  // The message the button sits on is updated in place; a problem is reported privately.
  await interaction.deferUpdate();
  const { member } = interaction;
  try {
    switch (action) {
      case 'toggle':
        await music.togglePause(member);
        break;
      case 'skip':
        await music.skip(member);
        break;
      case 'stop':
        await music.stopPlaying(member);
        break;
      case 'loop':
        await music.cycleLoop(member);
        break;
      case 'shuffle':
        await music.shuffle(member);
        break;
      default:
        throw new UserError('That button is from an older version of this message.');
    }
  } catch (error) {
    if (!(error instanceof UserError)) context.log.error(`The music button "${action}" failed`, error);
    await interaction.followUp({
      content: `⚠️ ${describeError(error)}`,
      flags: MessageFlags.Ephemeral,
      allowedMentions: NO_MENTIONS,
    });
  }

  // Show the outcome right away instead of waiting for the regular refresh; if the music is
  // over, this is the message saying why. A channel deleted meanwhile has no message left to show it in.
  await interaction.editReply({ ...music.panelOf(session), allowedMentions: NO_MENTIONS }).catch((error: unknown) => {
    if (!hasApiCode(error, RESTJSONErrorCodes.UnknownMessage, RESTJSONErrorCodes.UnknownChannel)) throw error;
  });
}

function isLoopMode(value: string): value is LoopMode {
  return (LOOP_MODES as readonly string[]).includes(value);
}
