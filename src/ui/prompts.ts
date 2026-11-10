import {
  ActionRowBuilder,
  LabelBuilder,
  ModalBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  TextInputBuilder,
  TextInputStyle,
  UserSelectMenuBuilder,
  VideoQualityMode,
  channelMention,
} from 'discord.js';
import { BITRATE_CHOICES_KBPS, MAX_LIST_SIZE, MAX_NAME_LENGTH, MAX_USER_LIMIT, truncate } from '../domain/settings.js';
import type { AccessKind } from '../storage/store.js';
import { AUTOMATIC_REGION, FieldId, ModalId, SelectId } from './ids.js';

/** Discord's cap on the number of entries in one select menu. */
export const MAX_SELECT_OPTIONS = 25;

/** A private follow-up to a panel button: some explanation plus menus to act with. */
export interface Prompt {
  content: string;
  components: ActionRowBuilder<StringSelectMenuBuilder | UserSelectMenuBuilder>[];
}

export interface RegionOption {
  id: string;
  name: string;
}

/** Someone who can be picked in a member menu. */
export interface MemberOption {
  id: string;
  name: string;
  detail?: string;
  /** Shown as already ticked. */
  selected?: boolean;
}

export type SanctionKind = 'mute' | 'deafen';

// ── modals ────────────────────────────────────────────────────────────────

export function nameModal(currentName: string): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(ModalId.Name)
    .setTitle('Rename channel')
    .addLabelComponents(
      new LabelBuilder()
        .setLabel('Channel name')
        .setDescription('Leave empty to go back to the default name.')
        .setTextInputComponent(
          new TextInputBuilder()
            .setCustomId(FieldId.Name)
            .setStyle(TextInputStyle.Short)
            .setMaxLength(MAX_NAME_LENGTH)
            .setRequired(false)
            .setValue(truncate(currentName, MAX_NAME_LENGTH)),
        ),
    );
}

export function limitModal(currentLimit: number): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(ModalId.Limit)
    .setTitle('User limit')
    .addLabelComponents(
      new LabelBuilder()
        .setLabel('How many people can join?')
        .setDescription(`A number from 1 to ${MAX_USER_LIMIT}, or 0 for no limit.`)
        .setTextInputComponent(
          new TextInputBuilder()
            .setCustomId(FieldId.Limit)
            .setStyle(TextInputStyle.Short)
            .setMaxLength(10)
            .setRequired(true)
            .setValue(String(currentLimit)),
        ),
    );
}

// ── bitrate, region, video ────────────────────────────────────────────────

export interface QualityView {
  bitrate: number;
  /** Highest bitrate the server allows. */
  maxBitrate: number;
  rtcRegion: string | null;
  videoQuality: VideoQualityMode | null;
  regions: readonly RegionOption[];
}

export function qualityPrompt(view: QualityView, notice?: string): Prompt {
  const currentKbps = Math.round(view.bitrate / 1000);
  const maxKbps = Math.floor(view.maxBitrate / 1000);
  const bitrates = [...new Set([...BITRATE_CHOICES_KBPS.filter((kbps) => kbps <= maxKbps), currentKbps])].sort(
    (a, b) => a - b,
  );

  const bitrateMenu = new StringSelectMenuBuilder()
    .setCustomId(SelectId.Bitrate)
    .setPlaceholder('Bitrate')
    .addOptions(
      bitrates.map((kbps) => {
        const option = new StringSelectMenuOptionBuilder()
          .setLabel(`${kbps} kbps`)
          .setValue(String(kbps))
          .setDefault(kbps === currentKbps);
        if (kbps === 64) option.setDescription('Discord default');
        else if (kbps === maxKbps) option.setDescription('Highest this server allows');
        return option;
      }),
    );

  const known = view.regions.slice(0, MAX_SELECT_OPTIONS - 1);
  const regions =
    view.rtcRegion && !known.some((region) => region.id === view.rtcRegion)
      ? [{ id: view.rtcRegion, name: view.rtcRegion }, ...known.slice(0, MAX_SELECT_OPTIONS - 2)]
      : known;

  const regionMenu = new StringSelectMenuBuilder()
    .setCustomId(SelectId.Region)
    .setPlaceholder('Voice region')
    .addOptions(
      new StringSelectMenuOptionBuilder()
        .setLabel('Automatic')
        .setValue(AUTOMATIC_REGION)
        .setDescription('Let Discord pick the best region')
        .setDefault(view.rtcRegion === null),
      ...regions.map((region) =>
        new StringSelectMenuOptionBuilder()
          .setLabel(truncate(region.name, 100))
          .setValue(region.id)
          .setDefault(region.id === view.rtcRegion),
      ),
    );

  const fullVideo = view.videoQuality === VideoQualityMode.Full;
  const videoMenu = new StringSelectMenuBuilder()
    .setCustomId(SelectId.Video)
    .setPlaceholder('Video quality')
    .addOptions(
      new StringSelectMenuOptionBuilder()
        .setLabel('Auto video quality')
        .setValue(String(VideoQualityMode.Auto))
        .setDescription('Discord adapts the quality to everyone’s connection')
        .setDefault(!fullVideo),
      new StringSelectMenuOptionBuilder()
        .setLabel('720p video')
        .setValue(String(VideoQualityMode.Full))
        .setDescription('Always send full quality video')
        .setDefault(fullVideo),
    );

  return {
    content: compose(notice, '**🎚️ Bitrate, region and video**', 'Pick a value in any menu and it is applied right away.'),
    components: [menuRow(bitrateMenu), menuRow(regionMenu), menuRow(videoMenu)],
  };
}

// ── allow / block lists ───────────────────────────────────────────────────

export function accessPrompt(kind: AccessKind, channelId: string, userIds: readonly string[], notice?: string): Prompt {
  const channel = channelMention(channelId);
  const lines =
    kind === 'allow'
      ? [
          '**✅ Allowed users**',
          `People in this list can always see and join ${channel}, and your future channels too.`,
          `Add or remove people in the menu below (up to ${MAX_LIST_SIZE}).`,
        ]
      : [
          '**🚫 Blocked users**',
          `People in this list can never see or join ${channel} or your future channels. Blocking someone who is in the channel also disconnects them.`,
          `Add or remove people in the menu below (up to ${MAX_LIST_SIZE}).`,
        ];

  const menu = new UserSelectMenuBuilder()
    .setCustomId(kind === 'allow' ? SelectId.Allowed : SelectId.Blocked)
    .setPlaceholder(kind === 'allow' ? 'Search for people to allow' : 'Search for people to block')
    .setMinValues(0)
    .setMaxValues(MAX_LIST_SIZE);
  const shown = userIds.slice(0, MAX_LIST_SIZE);
  if (shown.length > 0) menu.setDefaultUsers(shown);

  return { content: compose(notice, ...lines), components: [menuRow(menu)] };
}

// ── people in the channel ─────────────────────────────────────────────────

export function kickPrompt(channelId: string, members: readonly MemberOption[], notice?: string): Prompt {
  if (members.length === 0) {
    return { content: compose(notice, `There is nobody else in ${channelMention(channelId)} to kick.`), components: [] };
  }
  const { shown, overflow } = fit(members, 'kick');
  const menu = memberMenu(SelectId.Kick, 'Pick who to kick', shown).setMinValues(1).setMaxValues(shown.length);
  return {
    content: compose(
      notice,
      '**👢 Kick**',
      `Pick who to disconnect from ${channelMention(channelId)}. They can come back if they still have access; block them to keep them out.`,
      overflow,
    ),
    components: [menuRow(menu)],
  };
}

export function sanctionPrompt(
  kind: SanctionKind,
  channelId: string,
  members: readonly MemberOption[],
  notice?: string,
): Prompt {
  const mute = kind === 'mute';
  if (members.length === 0) {
    return {
      content: compose(notice, `There is nobody else in ${channelMention(channelId)} to ${kind}.`),
      components: [],
    };
  }
  const { shown, overflow } = fit(members, kind);
  const menu = memberMenu(mute ? SelectId.Mute : SelectId.Deafen, mute ? 'Nobody is muted' : 'Nobody is deafened', shown)
    .setMinValues(0)
    .setMaxValues(shown.length);
  return {
    content: compose(
      notice,
      mute ? '**🔇 Muted members**' : '**🙉 Deafened members**',
      `Tick someone to ${kind} them, untick them to undo it. It only applies while they are in ${channelMention(channelId)} and is lifted as soon as they leave.`,
      overflow,
    ),
    components: [menuRow(menu)],
  };
}

export function transferPrompt(channelId: string, members: readonly MemberOption[], notice?: string): Prompt {
  if (members.length === 0) {
    return {
      content: compose(notice, `There is nobody else in ${channelMention(channelId)} to hand the channel to.`),
      components: [],
    };
  }
  const { shown, overflow } = fit(members, 'transfer');
  const menu = memberMenu(SelectId.Transfer, 'Pick the new owner', shown).setMinValues(1).setMaxValues(1);
  return {
    content: compose(
      notice,
      '**👑 Transfer ownership**',
      `Pick who takes over ${channelMention(channelId)}. You stay in the channel and keep access to it.`,
      overflow,
    ),
    components: [menuRow(menu)],
  };
}

// ── helpers ───────────────────────────────────────────────────────────────

function compose(notice: string | undefined, ...lines: (string | undefined)[]): string {
  const body = lines.filter((line): line is string => Boolean(line)).join('\n');
  return notice ? `${notice}\n\n${body}` : body;
}

function fit(members: readonly MemberOption[], command: string): { shown: MemberOption[]; overflow: string | undefined } {
  if (members.length <= MAX_SELECT_OPTIONS) return { shown: [...members], overflow: undefined };
  return {
    shown: members.slice(0, MAX_SELECT_OPTIONS),
    overflow: `-# Showing ${MAX_SELECT_OPTIONS} of ${members.length} people. Use \`/voice ${command}\` for anyone not listed.`,
  };
}

function memberMenu(customId: string, placeholder: string, members: readonly MemberOption[]): StringSelectMenuBuilder {
  return new StringSelectMenuBuilder()
    .setCustomId(customId)
    .setPlaceholder(placeholder)
    .addOptions(
      members.map((member) => {
        const option = new StringSelectMenuOptionBuilder()
          .setLabel(truncate(member.name, 100) || member.id)
          .setValue(member.id)
          .setDefault(member.selected === true);
        if (member.detail) option.setDescription(truncate(member.detail, 100));
        return option;
      }),
    );
}

function menuRow<T extends StringSelectMenuBuilder | UserSelectMenuBuilder>(menu: T): ActionRowBuilder<T> {
  return new ActionRowBuilder<T>().addComponents(menu);
}
