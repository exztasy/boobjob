import type { Privacy } from '../storage/store.js';

/**
 * Custom ids of everything clickable. They never carry a channel id: every
 * control lives in the chat of the voice channel it manages, so the channel
 * the interaction comes from says which channel is meant.
 */
const PREFIX = 'vc';

export const PanelButton = {
  Name: `${PREFIX}:name`,
  Limit: `${PREFIX}:limit`,
  Quality: `${PREFIX}:quality`,
  Allowed: `${PREFIX}:allowed`,
  Blocked: `${PREFIX}:blocked`,
  Kick: `${PREFIX}:kick`,
  Mute: `${PREFIX}:mute`,
  Deafen: `${PREFIX}:deafen`,
  Transfer: `${PREFIX}:transfer`,
  Claim: `${PREFIX}:claim`,
  privacy: (mode: Privacy): string => `${PREFIX}:privacy:${mode}`,
} as const;

export const ModalId = {
  Name: `${PREFIX}:name:submit`,
  Limit: `${PREFIX}:limit:submit`,
} as const;

export const SelectId = {
  Bitrate: `${PREFIX}:bitrate:set`,
  Region: `${PREFIX}:region:set`,
  Video: `${PREFIX}:video:set`,
  Allowed: `${PREFIX}:allowed:set`,
  Blocked: `${PREFIX}:blocked:set`,
  Kick: `${PREFIX}:kick:set`,
  Mute: `${PREFIX}:mute:set`,
  Deafen: `${PREFIX}:deafen:set`,
  Transfer: `${PREFIX}:transfer:set`,
} as const;

export const FieldId = {
  Name: 'name',
  Limit: 'limit',
} as const;

/** Value standing for "let Discord pick" in the region menu. */
export const AUTOMATIC_REGION = 'auto';

export interface ParsedId {
  /** What the control is about, e.g. `name` or `privacy`. */
  action: string;
  /** Extra detail, e.g. the privacy mode or `set` / `submit`. */
  argument: string | undefined;
}

/** Splits one of our custom ids; `null` for ids that are not ours. */
export function parseCustomId(customId: string): ParsedId | null {
  const [prefix, action, argument] = customId.split(':');
  if (prefix !== PREFIX || !action) return null;
  return { action, argument };
}
