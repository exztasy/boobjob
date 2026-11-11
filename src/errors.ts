/**
 * A problem the person using the bot can understand and act on. The message is
 * shown to them as-is, so it should say what is wrong and what to do instead.
 */
export class UserError extends Error {
  override name = 'UserError';
}
