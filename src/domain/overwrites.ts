import { OverwriteType, PermissionFlagsBits } from 'discord.js';
import type { Privacy } from '../storage/store.js';

export interface Overwrite {
  id: string;
  type: OverwriteType;
  allow: bigint;
  deny: bigint;
}

export interface OverwriteInput {
  /** The guild id, which doubles as the id of the @everyone role. */
  everyoneId: string;
  botId: string;
  /** The bot's server-wide permissions. Discord only lets it set permissions it holds itself. */
  botPermissions: bigint;
  /** Overwrites of the category the channel lives in; the channel starts out as a copy of them. */
  base: readonly Overwrite[];
  ownerId: string;
  privacy: Privacy;
  allowed: readonly string[];
  blocked: readonly string[];
  /**
   * Bots of ours that are at work in the channel right now, such as the one
   * playing music there. They get in regardless of privacy and lists.
   */
  guests?: readonly string[];
}

const { ViewChannel, Connect, ManageRoles, Administrator } = PermissionFlagsBits;

/** Seeing a voice channel and joining it. */
export const ACCESS = ViewChannel | Connect;

/**
 * What the bot grants itself on every channel it creates, so that hiding the
 * channel from @everyone (or anything inherited from the category) cannot
 * lock the bot out of managing it.
 */
export const BOT_CHANNEL_PERMISSIONS =
  ViewChannel |
  Connect |
  PermissionFlagsBits.ManageChannels |
  PermissionFlagsBits.MoveMembers |
  PermissionFlagsBits.MuteMembers |
  PermissionFlagsBits.DeafenMembers |
  PermissionFlagsBits.SendMessages |
  PermissionFlagsBits.ReadMessageHistory;

/**
 * What a bot of ours gets while it works in a channel: getting in, being
 * heard, and getting in even when the owner's user limit says the channel is
 * full (which is what Move Members does for whoever holds it).
 */
export const GUEST_PERMISSIONS = ViewChannel | Connect | PermissionFlagsBits.Speak | PermissionFlagsBits.MoveMembers;

/** Discord's cap on permission overwrites per channel. */
export const MAX_OVERWRITES = 100;

/**
 * Computes the complete set of permission overwrites for a personal channel.
 *
 * The channel behaves like any other channel in its category (so mute roles,
 * verification gates and the like keep working) with these layers on top:
 *
 * 1. Privacy. `hidden` takes View Channel and Connect away from @everyone and
 *    from every role and member the category granted them to; `locked` does
 *    the same for Connect only; `public` changes nothing.
 * 2. Blocked users are denied View Channel and Connect.
 * 3. Allowed users and the owner are granted View Channel and Connect.
 * 4. The bot is granted what it needs to run the channel, and any bot of ours
 *    that is working in it what it needs to do that.
 *
 * A member's own overwrite beats any role overwrite, which is what makes the
 * allow and block lists work regardless of roles.
 */
export function buildOverwrites(input: OverwriteInput): Overwrite[] {
  const entries = new Map<string, Overwrite>();
  for (const overwrite of input.base) entries.set(overwrite.id, { ...overwrite });

  const entry = (id: string, type: OverwriteType): Overwrite => {
    let found = entries.get(id);
    if (!found) {
      found = { id, type, allow: 0n, deny: 0n };
      entries.set(id, found);
    }
    return found;
  };
  const grant = (target: Overwrite, permissions: bigint): void => {
    target.allow |= permissions;
    target.deny &= ~permissions;
  };
  const refuse = (target: Overwrite, permissions: bigint): void => {
    target.deny |= permissions;
    target.allow &= ~permissions;
  };

  const restricted = input.privacy === 'hidden' ? ACCESS : input.privacy === 'locked' ? Connect : 0n;
  if (restricted !== 0n) {
    for (const overwrite of entries.values()) overwrite.allow &= ~restricted;
    refuse(entry(input.everyoneId, OverwriteType.Role), restricted);
  }

  const special = new Set([input.ownerId, input.botId]);
  const guests = unique(input.guests ?? []).filter((id) => id !== input.ownerId);
  const blocked = unique(input.blocked).filter((id) => !special.has(id) && !guests.includes(id));
  const allowed = unique(input.allowed).filter((id) => !special.has(id) && !blocked.includes(id));

  for (const id of blocked) refuse(entry(id, OverwriteType.Member), ACCESS);
  for (const id of allowed) grant(entry(id, OverwriteType.Member), ACCESS);
  grant(entry(input.ownerId, OverwriteType.Member), ACCESS);
  grant(entry(input.botId, OverwriteType.Member), BOT_CHANNEL_PERMISSIONS);
  for (const id of guests) grant(entry(id, OverwriteType.Member), GUEST_PERMISSIONS);

  if ((input.botPermissions & Administrator) === 0n) {
    // Discord rejects the whole request if it touches a permission the bot lacks, and
    // only administrators may put Manage Roles into an overwrite at all.
    const settable = input.botPermissions & ~ManageRoles;
    for (const overwrite of entries.values()) {
      overwrite.allow &= settable;
      overwrite.deny &= settable;
    }
  }

  // If the cap forces something out, the overwrites that keep people out must be the last to go.
  const placed = new Set([input.everyoneId, ...special, ...guests, ...blocked, ...allowed]);
  const inherited = [...entries.keys()].filter((id) => !placed.has(id));
  const order = unique([input.everyoneId, input.botId, input.ownerId, ...guests, ...blocked, ...inherited, ...allowed]);

  return order
    .map((id) => entries.get(id))
    .filter((overwrite): overwrite is Overwrite => overwrite !== undefined && (overwrite.allow | overwrite.deny) !== 0n)
    .slice(0, MAX_OVERWRITES);
}

/**
 * Permissions that the category sets per role or member but that the bot
 * cannot carry over to a personal channel, because it does not hold them.
 * `0n` means the channel inherits its category faithfully.
 */
export function uninheritablePermissions(base: readonly Overwrite[], botPermissions: bigint): bigint {
  if ((botPermissions & Administrator) !== 0n) return 0n;
  const settable = botPermissions & ~ManageRoles;
  let lost = 0n;
  for (const overwrite of base) lost |= (overwrite.allow | overwrite.deny) & ~settable;
  return lost;
}

function unique(ids: readonly string[]): string[] {
  return [...new Set(ids)];
}
