import type { GuildMember, VoiceChannel } from 'discord.js';
import type { BotContext } from '../context.js';
import type { MemberOption, QualityView, SanctionKind } from '../ui/prompts.js';
import { voiceStatesIn } from '../util/discord.js';

/** The people connected to a channel, as menu entries, sorted by name. */
export function memberOptions(channel: VoiceChannel, excluded: ReadonlySet<string>, humansOnly = false): MemberOption[] {
  const options: MemberOption[] = [];
  for (const state of voiceStatesIn(channel.guild, channel.id)) {
    if (excluded.has(state.id)) continue;
    if (humansOnly && state.member?.user.bot) continue;
    options.push(describeMember(state.id, state.member));
  }
  return options.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Entries for the mute or deafen menu: everyone in the channel, with those
 * currently muted/deafened ticked, plus anyone who left while still being so
 * (it applies again if they return, and this is where it can be undone).
 */
export async function sanctionOptions(
  context: BotContext,
  channel: VoiceChannel,
  kind: SanctionKind,
  actorId: string,
): Promise<MemberOption[]> {
  const flag = kind === 'mute' ? 'muted' : 'deafened';
  const sanctioned = new Set(
    context.store
      .listSanctions(channel.id)
      .filter((sanction) => sanction[flag])
      .map((sanction) => sanction.userId),
  );

  const present = memberOptions(channel, new Set([actorId])).map((option) => ({
    ...option,
    selected: sanctioned.has(option.id),
  }));
  const presentIds = new Set(present.map((option) => option.id));

  const absent: MemberOption[] = [];
  for (const userId of sanctioned) {
    if (presentIds.has(userId) || userId === actorId) continue;
    const member =
      channel.guild.members.cache.get(userId) ?? (await channel.guild.members.fetch(userId).catch(() => null));
    absent.push({
      ...describeMember(userId, member),
      detail: `Left the channel, still ${flag} if they come back`,
      selected: true,
    });
  }

  // Ticked entries go first so that a crowded channel cannot push them off the end of the menu.
  return [...present.filter((option) => option.selected), ...absent, ...present.filter((option) => !option.selected)];
}

export async function qualityView(context: BotContext, channel: VoiceChannel): Promise<QualityView> {
  return {
    bitrate: channel.bitrate,
    maxBitrate: channel.guild.maximumBitrate,
    rtcRegion: channel.rtcRegion,
    videoQuality: channel.videoQualityMode,
    regions: await context.regions.list(),
  };
}

function describeMember(id: string, member: GuildMember | null | undefined): MemberOption {
  if (!member) return { id, name: 'Unknown member', detail: `ID ${id}` };
  return {
    id,
    name: member.displayName,
    detail: `@${member.user.username}${member.user.bot ? ' · bot' : ''}`,
  };
}
