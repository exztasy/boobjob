import { PermissionFlagsBits, PermissionsBitField, type GuildMember } from 'discord.js';

const P = PermissionFlagsBits;

/** Without these, server-wide, the bot cannot create channels or keep them private. */
export const REQUIRED_PERMISSIONS = P.ViewChannel | P.Connect | P.ManageChannels | P.ManageRoles | P.MoveMembers;

/** Needed for mute, deafen and the control panel message. */
export const FEATURE_PERMISSIONS = P.MuteMembers | P.DeafenMembers | P.SendMessages | P.ReadMessageHistory;

/**
 * Everyday permissions that servers commonly allow or deny per role in a voice
 * category: mute roles, "no streaming", "no soundboard" and the like. The bot
 * never uses them. It holds them because Discord only lets a bot put a
 * permission into a channel's overwrites if it has that permission itself, and
 * a personal channel has to carry over the restrictions of its category.
 */
export const INHERITABLE_PERMISSIONS =
  P.Speak |
  P.Stream |
  P.UseVAD |
  P.AddReactions |
  P.EmbedLinks |
  P.AttachFiles |
  P.UseExternalEmojis |
  P.UseExternalStickers |
  P.UseSoundboard |
  P.UseExternalSounds |
  P.UseEmbeddedActivities |
  P.UseApplicationCommands |
  P.UseExternalApps |
  P.SendTTSMessages |
  P.SendVoiceMessages |
  P.SendPolls |
  P.SetVoiceChannelStatus |
  P.CreateInstantInvite;

/** What the invite link asks for. */
export const INVITE_PERMISSIONS = REQUIRED_PERMISSIONS | FEATURE_PERMISSIONS | INHERITABLE_PERMISSIONS;

/** Names, as shown in Discord's role settings, of the wanted permissions the member lacks server-wide. */
export function missingPermissions(member: GuildMember, wanted: bigint): string[] {
  const missing = member.permissions.missing(wanted);
  return missing.map(permissionLabel);
}

export function permissionNames(permissions: bigint): string[] {
  return new PermissionsBitField(permissions).toArray().map(permissionLabel);
}

/** Permissions whose name in Discord's role settings is not simply their API name spelled out. */
const SETTINGS_LABELS: Record<string, string> = {
  ViewChannel: 'View Channels',
  ManageGuild: 'Manage Server',
  Stream: 'Video',
  UseVAD: 'Use Voice Activity',
  CreateInstantInvite: 'Create Invite',
  UseEmbeddedActivities: 'Use Activities',
  SendTTSMessages: 'Send Text-to-Speech Messages',
  MentionEveryone: 'Mention @everyone, @here and All Roles',
  ModerateMembers: 'Timeout Members',
};

/** The name an admin will find in Server Settings → Roles. */
function permissionLabel(name: string): string {
  return SETTINGS_LABELS[name] ?? name.replace(/([a-z])([A-Z])|([A-Z]+)([A-Z][a-z])/gu, '$1$3 $2$4');
}
