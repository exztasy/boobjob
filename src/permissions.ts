import { PermissionFlagsBits, PermissionsBitField, type GuildMember } from 'discord.js';

const P = PermissionFlagsBits;

/** Without these, server-wide, the bot cannot create channels or keep them private. */
export const REQUIRED_PERMISSIONS = P.ViewChannel | P.Connect | P.ManageChannels | P.ManageRoles | P.MoveMembers;

/** Needed for mute, deafen and the control panel message. */
export const FEATURE_PERMISSIONS = P.MuteMembers | P.DeafenMembers | P.SendMessages | P.ReadMessageHistory;

/** What the invite link asks for. */
export const INVITE_PERMISSIONS = REQUIRED_PERMISSIONS | FEATURE_PERMISSIONS;

/** Names, as shown in Discord's role settings, of the wanted permissions the member lacks server-wide. */
export function missingPermissions(member: GuildMember, wanted: bigint): string[] {
  const missing = member.permissions.missing(wanted);
  return missing.map(permissionLabel);
}

export function permissionNames(permissions: bigint): string[] {
  return new PermissionsBitField(permissions).toArray().map(permissionLabel);
}

function permissionLabel(name: string): string {
  return name.replace(/([a-z])([A-Z])/gu, '$1 $2');
}
