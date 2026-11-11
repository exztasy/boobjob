import { MessageFlags, RESTJSONErrorCodes, type Interaction } from 'discord.js';
import type { BotContext } from '../context.js';
import { hasApiCode } from '../util/discord.js';
import { handleAutocomplete, handleCommand } from './commands.js';
import { handleButton, handleModal, handleStringSelect, handleUserSelect } from './components.js';

/** Sends an interaction to its handler and makes sure a failure never goes unanswered. */
export async function handleInteraction(context: BotContext, interaction: Interaction): Promise<void> {
  try {
    await dispatch(context, interaction);
  } catch (error) {
    if (hasApiCode(error, RESTJSONErrorCodes.UnknownInteraction)) {
      // Discord gives three seconds to acknowledge; this one expired before we got to it.
      context.log.warn(`Interaction ${interaction.id} expired before it could be answered`);
      return;
    }
    context.log.error(`Interaction ${interaction.id} failed`, error);
    if (!interaction.isRepliable()) return;

    const apology = {
      content: '⚠️ Something went wrong on my side. Please try again.',
      flags: MessageFlags.Ephemeral,
    } as const;
    // A follow-up never edits an existing message, so it cannot damage the control panel.
    await (interaction.deferred || interaction.replied ? interaction.followUp(apology) : interaction.reply(apology)).catch(
      () => undefined,
    );
  }
}

async function dispatch(context: BotContext, interaction: Interaction): Promise<void> {
  if (!interaction.inCachedGuild()) {
    if (interaction.isRepliable()) {
      await interaction.reply({ content: 'I only work inside servers.', flags: MessageFlags.Ephemeral });
    }
    return;
  }

  if (interaction.isChatInputCommand()) return handleCommand(context, interaction);
  if (interaction.isAutocomplete()) return handleAutocomplete(context, interaction);
  if (interaction.isButton()) return handleButton(context, interaction);
  if (interaction.isStringSelectMenu()) return handleStringSelect(context, interaction);
  if (interaction.isUserSelectMenu()) return handleUserSelect(context, interaction);
  if (interaction.isModalSubmit()) return handleModal(context, interaction);
}
