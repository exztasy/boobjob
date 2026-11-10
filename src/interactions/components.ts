import {
  MessageFlags,
  userMention,
  type APISelectMenuOption,
  type ButtonInteraction,
  type GuildMember,
  type GuildTextBasedChannel,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
  type UserSelectMenuInteraction,
  type VoiceChannel,
} from 'discord.js';
import type { BotContext } from '../context.js';
import { MAX_USER_LIMIT, parseUserLimit } from '../domain/settings.js';
import { UserError } from '../errors.js';
import type { TempChannel } from '../storage/store.js';
import { AUTOMATIC_REGION, FieldId, parseCustomId, type ParsedId } from '../ui/ids.js';
import {
  accessPrompt,
  kickPrompt,
  limitModal,
  nameModal,
  qualityPrompt,
  sanctionPrompt,
  transferPrompt,
  type Prompt,
} from '../ui/prompts.js';
import { describeError, isVoiceChannel } from '../util/discord.js';
import { memberOptions, qualityView, sanctionOptions } from './views.js';

const NO_MENTIONS = { parse: [] } as const;

/** The channel a control belongs to, and the person using it. */
interface Located {
  channel: VoiceChannel;
  record: TempChannel;
  actor: GuildMember;
}

interface FromChannel {
  channel: GuildTextBasedChannel | null;
  member: GuildMember;
}

// ── panel buttons ─────────────────────────────────────────────────────────

export async function handleButton(context: BotContext, interaction: ButtonInteraction<'cached'>): Promise<void> {
  const id = parseCustomId(interaction.customId);
  if (!id) return;

  // Anyone in the channel may try to claim it; everything else is for whoever runs it.
  const located = await locate(context, interaction, id.action !== 'claim');
  if (!located) return;
  const { channel } = located;

  // A modal has to be the very first response, so these two cannot be deferred.
  if (id.action === 'name') {
    await interaction.showModal(nameModal(channel.name));
    return;
  }
  if (id.action === 'limit') {
    await interaction.showModal(limitModal(channel.userLimit));
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  let reply: Prompt | string;
  try {
    reply = await runButton(context, located, id);
  } catch (error) {
    reply = failure(context, error);
  }
  await interaction.editReply(
    typeof reply === 'string' ? { content: reply, allowedMentions: NO_MENTIONS } : { ...reply, allowedMentions: NO_MENTIONS },
  );
}

async function runButton(context: BotContext, located: Located, id: ParsedId): Promise<Prompt | string> {
  const { actions, store } = context;
  const { channel, record, actor } = located;

  switch (id.action) {
    case 'claim':
      return actions.claim(channel, actor);
    case 'privacy':
      return actions.setPrivacy(channel, actor, id.argument ?? '');
    case 'quality':
      return qualityPrompt(await qualityView(context, channel));
    case 'allowed':
      return accessPrompt('allow', channel.id, store.getChannelAccess(channel.id).allowed);
    case 'blocked':
      return accessPrompt('block', channel.id, store.getChannelAccess(channel.id).blocked);
    case 'kick':
      return kickPrompt(channel.id, memberOptions(channel, new Set([actor.id])));
    case 'mute':
      return sanctionPrompt('mute', channel.id, await sanctionOptions(context, channel, 'mute', actor.id));
    case 'deafen':
      return sanctionPrompt('deafen', channel.id, await sanctionOptions(context, channel, 'deafen', actor.id));
    case 'transfer':
      return transferPrompt(channel.id, memberOptions(channel, new Set([record.ownerId]), true));
    default:
      throw new UserError('That button is from an older control panel. Use `/voice panel` to get a fresh one.');
  }
}

// ── menus in the private prompts ──────────────────────────────────────────

export async function handleStringSelect(
  context: BotContext,
  interaction: StringSelectMenuInteraction<'cached'>,
): Promise<void> {
  const id = parseCustomId(interaction.customId);
  if (!id || id.argument !== 'set') return;
  const located = await locate(context, interaction, true);
  if (!located) return;

  const { actions } = context;
  const { channel, record, actor } = located;
  const values = interaction.values;
  const first = values[0] ?? '';

  // The menu sits in a private prompt of ours, which is updated in place with the outcome.
  await interaction.deferUpdate();
  let notice: string;
  let succeeded = true;
  try {
    switch (id.action) {
      case 'bitrate':
        notice = await actions.setBitrate(channel, actor, Number(first));
        break;
      case 'region':
        notice = await actions.setRegion(channel, actor, first === AUTOMATIC_REGION ? null : first);
        break;
      case 'video':
        notice = await actions.setVideoQuality(channel, actor, Number(first));
        break;
      case 'kick':
        notice = await actions.kick(channel, actor, values);
        break;
      case 'mute':
      case 'deafen': {
        const { add, remove } = selectionChange(interaction.component.options, values);
        notice = await actions.setSanctions(channel, actor, id.action, add, remove);
        break;
      }
      case 'transfer':
        notice = await actions.transfer(channel, actor, first);
        break;
      default:
        return;
    }
  } catch (error) {
    succeeded = false;
    notice = failure(context, error);
  }

  let prompt: Prompt;
  switch (id.action) {
    case 'kick':
      // The gateway may not have reported the departures yet, so leave the picked people out explicitly.
      prompt = kickPrompt(channel.id, memberOptions(channel, new Set([actor.id, ...(succeeded ? values : [])])), notice);
      break;
    case 'mute':
    case 'deafen':
      prompt = sanctionPrompt(id.action, channel.id, await sanctionOptions(context, channel, id.action, actor.id), notice);
      break;
    case 'transfer':
      prompt = succeeded
        ? { content: notice, components: [] }
        : transferPrompt(channel.id, memberOptions(channel, new Set([record.ownerId]), true), notice);
      break;
    default:
      prompt = qualityPrompt(await qualityView(context, channel), notice);
  }
  await interaction.editReply({ ...prompt, allowedMentions: NO_MENTIONS });
}

export async function handleUserSelect(
  context: BotContext,
  interaction: UserSelectMenuInteraction<'cached'>,
): Promise<void> {
  const id = parseCustomId(interaction.customId);
  if (!id || id.argument !== 'set' || (id.action !== 'allowed' && id.action !== 'blocked')) return;
  const located = await locate(context, interaction, true);
  if (!located) return;

  const { actions, store } = context;
  const { channel, actor } = located;
  const kind = id.action === 'allowed' ? 'allow' : 'block';

  // The menu was shown with the list as it was; what the person changed is the difference
  // between that and what they submitted. Comparing against the list as it is now could
  // undo a change made elsewhere in the meantime.
  const shown = new Set((interaction.component.data.default_values ?? []).map((value) => value.id));
  const selected = new Set(interaction.values);
  const added = interaction.values.filter((userId) => !shown.has(userId));
  const removed = [...shown].filter((userId) => !selected.has(userId));
  const strangers = added.filter((userId) => !interaction.members.has(userId));

  await interaction.deferUpdate();
  let notice: string;
  try {
    notice = await actions.updateAccess(
      channel,
      actor,
      kind,
      added.filter((userId) => !strangers.includes(userId)),
      removed,
    );
    if (strangers.length > 0) {
      notice += `\n${strangers.map((userId) => userMention(userId)).join(', ')} ${strangers.length === 1 ? 'is' : 'are'} not in this server.`;
    }
  } catch (error) {
    notice = failure(context, error);
  }

  const lists = store.getChannelAccess(channel.id);
  await interaction.editReply({
    ...accessPrompt(kind, channel.id, kind === 'allow' ? lists.allowed : lists.blocked, notice),
    allowedMentions: NO_MENTIONS,
  });
}

// ── modals ────────────────────────────────────────────────────────────────

export async function handleModal(context: BotContext, interaction: ModalSubmitInteraction<'cached'>): Promise<void> {
  const id = parseCustomId(interaction.customId);
  if (!id || id.argument !== 'submit' || (id.action !== 'name' && id.action !== 'limit')) return;
  const located = await locate(context, interaction, true);
  if (!located) return;

  const { actions } = context;
  const { channel, actor } = located;

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  let content: string;
  try {
    if (id.action === 'name') {
      content = await actions.rename(channel, actor, interaction.fields.getTextInputValue(FieldId.Name));
    } else {
      const limit = parseUserLimit(interaction.fields.getTextInputValue(FieldId.Limit));
      if (limit === null) {
        throw new UserError(`The user limit has to be a number from 1 to ${MAX_USER_LIMIT}, or 0 for no limit.`);
      }
      content = await actions.setUserLimit(channel, actor, limit);
    }
  } catch (error) {
    content = failure(context, error);
  }
  await interaction.editReply({ content, allowedMentions: NO_MENTIONS });
}

// ── helpers ───────────────────────────────────────────────────────────────

/**
 * Works out which channel an interaction is about and whether the person may
 * use its controls. Answers the interaction itself, and returns `null`, when not.
 */
async function locate(
  context: BotContext,
  interaction: FromChannel & {
    reply(options: { content: string; flags: MessageFlags.Ephemeral; allowedMentions: typeof NO_MENTIONS }): Promise<unknown>;
  },
  managersOnly: boolean,
): Promise<Located | null> {
  const refuse = async (content: string): Promise<null> => {
    await interaction.reply({ content: `⚠️ ${content}`, flags: MessageFlags.Ephemeral, allowedMentions: NO_MENTIONS });
    return null;
  };

  const channel = interaction.channel;
  const record = isVoiceChannel(channel) ? context.store.getTempChannel(channel.id) : undefined;
  if (!isVoiceChannel(channel) || !record) {
    return refuse('These controls belong to a voice channel that I no longer manage.');
  }

  const actor = interaction.member;
  if (managersOnly && !context.actions.isManager(record, actor, channel)) {
    const ownerPresent = channel.guild.voiceStates.cache.get(record.ownerId)?.channelId === channel.id;
    return refuse(
      `Only the owner of this channel, ${userMention(record.ownerId)}, can use these controls.` +
        (ownerPresent ? '' : ' They are not here right now, so anyone in the channel can press **Claim channel** to take over.'),
    );
  }
  return { channel, record, actor };
}

/**
 * What the person did to a pre-filled menu: entries they newly ticked and
 * entries they unticked, relative to how the menu was shown to them.
 */
function selectionChange(
  options: readonly APISelectMenuOption[],
  values: readonly string[],
): { add: string[]; remove: string[] } {
  const selected = new Set(values);
  return {
    add: options.filter((option) => !option.default && selected.has(option.value)).map((option) => option.value),
    remove: options.filter((option) => option.default && !selected.has(option.value)).map((option) => option.value),
  };
}

function failure(context: BotContext, error: unknown): string {
  if (!(error instanceof UserError)) context.log.error('A channel control failed', error);
  return `⚠️ ${describeError(error)}`;
}
