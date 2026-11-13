import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  MessageFlags,
  SeparatorBuilder,
  TextDisplayBuilder,
  userMention,
} from 'discord.js';
import { formatDuration, trackLine } from '../music/format.js';
import type { LoopMode, QueueItem } from '../music/queue.js';
import { MusicButton } from './ids.js';
import type { PanelMessage } from './panel.js';

/** How many of the waiting tracks the message lists before it sums up the rest. */
export const UPCOMING_SHOWN = 5;

export const LOOP_INFO: Record<LoopMode, { label: string; summary: string }> = {
  off: { label: 'Loop: off', summary: 'Looping is off' },
  track: { label: 'Loop: track', summary: 'Repeating this track' },
  queue: { label: 'Loop: queue', summary: 'Repeating the whole queue' },
};

/** Everything the "now playing" message shows, as plain data. */
export interface MusicPanelView {
  /** The bot account that is in the channel playing. */
  botId: string;
  current: QueueItem | null;
  paused: boolean;
  loop: LoopMode;
  /** Volume in percent; 100 is normal. */
  volume: number;
  /** The waiting tracks, next one first. */
  upcoming: readonly QueueItem[];
  /** Total length of the waiting tracks in milliseconds. */
  upcomingDuration: number;
  /** The latest thing that went wrong, if it is still worth knowing. */
  problem: string | null;
}

const ACCENT_COLOR = 0x1db954;
const ENDED_COLOR = 0x80848e;

/** Builds the message that shows what is playing in a voice channel, with its controls. */
export function renderMusicPanel(view: MusicPanelView): PanelMessage {
  const container = new ContainerBuilder()
    .setAccentColor(ACCENT_COLOR)
    .addTextDisplayComponents(text('### 🎵 Music', `${userMention(view.botId)} is playing in this channel.`))
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(text(...nowPlaying(view)))
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(text(...upNext(view)));

  if (view.problem) container.addTextDisplayComponents(text(`⚠️ ${view.problem}`));

  const playing = view.current !== null;
  container
    .addActionRowComponents(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        view.paused
          ? button(MusicButton.Toggle, 'Resume', '▶️').setStyle(ButtonStyle.Success)
          : button(MusicButton.Toggle, 'Pause', '⏸️').setDisabled(!playing),
        button(MusicButton.Skip, 'Skip', '⏭️').setDisabled(!playing && view.upcoming.length === 0),
        button(MusicButton.Stop, 'Stop', '⏹️').setStyle(ButtonStyle.Danger),
        button(MusicButton.Loop, LOOP_INFO[view.loop].label, '🔁').setStyle(
          view.loop === 'off' ? ButtonStyle.Secondary : ButtonStyle.Primary,
        ),
        button(MusicButton.Shuffle, 'Shuffle', '🔀').setDisabled(view.upcoming.length < 2),
      ),
    )
    .addTextDisplayComponents(
      text('-# Anyone in this voice channel can use these controls. Add music with `/music play`.'),
    );

  return { components: [container], flags: MessageFlags.IsComponentsV2 };
}

/** What the message turns into once the music is over: the reason, and no controls. */
export function renderEndedMusicPanel(reason: string): PanelMessage {
  const container = new ContainerBuilder()
    .setAccentColor(ENDED_COLOR)
    .addTextDisplayComponents(text('### 🎵 Music', `⏹️ ${reason}`, '-# Start again with `/music play`.'));
  return { components: [container], flags: MessageFlags.IsComponentsV2 };
}

function nowPlaying(view: MusicPanelView): string[] {
  if (!view.current) return ['**Now playing**', 'Nothing right now. Add music with `/music play`.'];

  const state: string[] = [];
  if (view.paused) state.push('⏸️ Paused');
  if (view.loop !== 'off') state.push(`🔁 ${LOOP_INFO[view.loop].summary}`);
  if (view.volume !== 100) state.push(`🔊 ${view.volume}%`);

  return [
    '**Now playing**',
    trackLine(view.current.track),
    `-# Requested by ${userMention(view.current.requesterId)}${state.length > 0 ? ` · ${state.join(' · ')}` : ''}`,
  ];
}

function upNext(view: MusicPanelView): string[] {
  const count = view.upcoming.length;
  if (count === 0) return ['**Up next**', 'Nothing queued.'];

  const lines = view.upcoming.slice(0, UPCOMING_SHOWN).map((item, index) => `${index + 1}. ${trackLine(item.track)}`);
  const rest = count - lines.length;
  return [
    `**Up next** · ${count === 1 ? '1 track' : `${count} tracks`} · \`${formatDuration(view.upcomingDuration)}\``,
    ...lines,
    ...(rest > 0 ? [`…and ${rest} more. See them all with \`/music queue\`.`] : []),
  ];
}

function text(...lines: string[]): TextDisplayBuilder {
  return new TextDisplayBuilder().setContent(lines.join('\n'));
}

function button(customId: string, label: string, emoji: string): ButtonBuilder {
  return new ButtonBuilder().setCustomId(customId).setLabel(label).setEmoji(emoji).setStyle(ButtonStyle.Secondary);
}
