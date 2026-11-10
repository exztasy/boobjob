import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  MessageFlags,
  SeparatorBuilder,
  TextDisplayBuilder,
  channelMention,
  escapeMarkdown,
  userMention,
  type VideoQualityMode,
} from 'discord.js';
import { formatBitrate, formatUserLimit, formatVideoQuality } from '../domain/settings.js';
import { PRIVACY_MODES, type Privacy } from '../storage/store.js';
import { relativeTime } from '../util/discord.js';
import { PanelButton } from './ids.js';

export const PRIVACY_INFO: Record<Privacy, { label: string; emoji: string; summary: string }> = {
  hidden: {
    label: 'Hidden',
    emoji: '🙈',
    summary: 'only the owner and allowed users can see or join this channel.',
  },
  locked: {
    label: 'Locked',
    emoji: '🔒',
    summary: 'the channel is visible, but only the owner and allowed users can join.',
  },
  public: {
    label: 'Public',
    emoji: '🌐',
    summary: 'anyone who can see this category can join, except blocked users.',
  },
};

/** Everything the control panel shows, as plain data. */
export interface PanelView {
  channelName: string;
  ownerId: string;
  /** The hub the channel was created from, if it still exists. */
  hubId: string | null;
  userLimit: number;
  bitrate: number;
  /** Voice region id, or `null` when Discord picks one automatically. */
  rtcRegion: string | null;
  videoQuality: VideoQualityMode | null;
  privacy: Privacy;
  allowedCount: number;
  blockedCount: number;
  /** A rename that is waiting for Discord's rename limit to clear. */
  pendingName: { name: string; at: number } | null;
}

export interface PanelMessage {
  components: ContainerBuilder[];
  flags: MessageFlags.IsComponentsV2;
}

const ACCENT_COLOR = 0x5865f2;

/** Builds the control panel message for a channel. */
export function renderPanel(view: PanelView): PanelMessage {
  const privacy = PRIVACY_INFO[view.privacy];
  const restore = view.hubId ? `joins ${channelMention(view.hubId)}` : 'creates a channel';

  const pendingName = view.pendingName
    ? ` → **${escapeMarkdown(view.pendingName.name)}** ${relativeTime(view.pendingName.at)}`
    : '';

  const container = new ContainerBuilder()
    .setAccentColor(ACCENT_COLOR)
    .addTextDisplayComponents(
      text(
        '### 🎛️ Voice channel controls',
        `${userMention(view.ownerId)} owns this channel. Every setting below is saved and comes back the next time the owner ${restore}.`,
      ),
    )
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(
      text(
        '**Channel**',
        `✏️ **${escapeMarkdown(view.channelName)}**${pendingName}`,
        [
          `👥 ${formatUserLimit(view.userLimit)}`,
          `🎚️ ${formatBitrate(view.bitrate)}`,
          `🌍 ${view.rtcRegion ?? 'Automatic region'}`,
          `📹 ${formatVideoQuality(view.videoQuality)} video`,
        ].join(' · '),
      ),
    )
    .addActionRowComponents(
      row(
        button(PanelButton.Name, 'Rename', '✏️'),
        button(PanelButton.Limit, 'User limit', '👥'),
        button(PanelButton.Quality, 'Bitrate & region', '🎚️'),
      ),
    )
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(text('**Privacy**', `${privacy.emoji} **${privacy.label}** — ${privacy.summary}`))
    .addActionRowComponents(
      row(
        ...PRIVACY_MODES.map((mode) => {
          const info = PRIVACY_INFO[mode];
          const active = mode === view.privacy;
          return button(PanelButton.privacy(mode), info.label, info.emoji)
            .setStyle(active ? ButtonStyle.Success : ButtonStyle.Secondary)
            .setDisabled(active);
        }),
      ),
    )
    .addTextDisplayComponents(text(`✅ ${view.allowedCount} allowed · 🚫 ${view.blockedCount} blocked`))
    .addActionRowComponents(
      row(button(PanelButton.Allowed, 'Allowed users', '✅'), button(PanelButton.Blocked, 'Blocked users', '🚫')),
    )
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(text('**People in the channel**'))
    .addActionRowComponents(
      row(
        button(PanelButton.Kick, 'Kick', '👢'),
        button(PanelButton.Mute, 'Mute', '🔇'),
        button(PanelButton.Deafen, 'Deafen', '🙉'),
      ),
    )
    .addSeparatorComponents(new SeparatorBuilder())
    .addActionRowComponents(
      row(button(PanelButton.Transfer, 'Transfer ownership', '👑'), button(PanelButton.Claim, 'Claim channel', '🙋')),
    )
    .addTextDisplayComponents(
      text('-# Only the owner can use these controls. If the owner has left, anyone in the channel can claim it.'),
    );

  return { components: [container], flags: MessageFlags.IsComponentsV2 };
}

function text(...lines: string[]): TextDisplayBuilder {
  return new TextDisplayBuilder().setContent(lines.join('\n'));
}

function button(customId: string, label: string, emoji: string): ButtonBuilder {
  return new ButtonBuilder().setCustomId(customId).setLabel(label).setEmoji(emoji).setStyle(ButtonStyle.Secondary);
}

function row(...buttons: ButtonBuilder[]): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(buttons);
}
