import { Events, MessageFlags } from 'discord.js';
import { errorEmbed, infoEmbed } from '../../utils/embeds.js';

// Discord API error codes
const UNKNOWN_MESSAGE = 10008;

export default {
  name: Events.InteractionCreate,
  async execute(interaction, client) {
    // Only handle AFK dismiss buttons
    if (!interaction.isButton()) return;
    if (!interaction.customId.startsWith('afk_dismiss_')) return;

    try {
      // Extract the user ID from the custom ID
      const userId = interaction.customId.replace('afk_dismiss_', '');

      // Only allow the mentioned user to dismiss
      if (interaction.user.id !== userId) {
        return await interaction.reply({
          embeds: [await errorEmbed(interaction.guildId, 'Not Your Notice',
            'Only the member who returned from AFK may dismiss this notice, Master.')],
          flags: MessageFlags.Ephemeral
        });
      }

      // Acknowledge first: the message (and its button) is about to disappear
      await interaction.deferUpdate();

      try {
        await interaction.message.delete();
      } catch (error) {
        if (error.code !== UNKNOWN_MESSAGE) throw error;
        // Already deleted
        await interaction.followUp({
          embeds: [await infoEmbed(interaction.guildId, 'Notice Dismissed',
            '**Notice:** This message has already been dismissed, Master.')],
          flags: MessageFlags.Ephemeral
        }).catch(() => { });
      }
    } catch (error) {
      console.error('[AFK] Error dismissing AFK notice:', error);
      const payload = {
        embeds: [await errorEmbed(interaction.guildId, 'Dismiss Failed',
          'I could not dismiss this notice, Master.').catch(() => null)].filter(Boolean),
        flags: MessageFlags.Ephemeral
      };
      if (!payload.embeds.length) return;
      const respond = interaction.deferred || interaction.replied
        ? interaction.followUp(payload)
        : interaction.reply(payload);
      await respond.catch(() => { });
    }
  }
};
