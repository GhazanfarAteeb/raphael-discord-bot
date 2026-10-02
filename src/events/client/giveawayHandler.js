import { Events, MessageFlags } from 'discord.js';
import Giveaway from '../../models/Giveaway.js';
import { buildGiveawayMessage, endGiveawayById } from '../../commands/community/giveaway.js';

const PARTICIPANTS_PREVIEW = 20;

export default {
  name: Events.InteractionCreate,
  async execute(interaction) {
    // Only handle giveaway button interactions
    if (!interaction.isButton()) return;
    if (!interaction.customId.startsWith('giveaway_')) return;

    try {
      const giveaway = await Giveaway.findOne({
        messageId: interaction.message.id,
        guildId: interaction.guild.id
      });

      if (!giveaway) {
        return await interaction.reply({
          content: '**Error:** This giveaway no longer exists, Master.',
          flags: MessageFlags.Ephemeral
        });
      }

      // The scheduler may not have closed it yet, but entries end at endsAt
      if (giveaway.ended || giveaway.endsAt <= new Date()) {
        return await interaction.reply({
          content: '**Notice:** This giveaway has already concluded, Master.',
          flags: MessageFlags.Ephemeral
        });
      }

      const action = interaction.customId.replace('giveaway_', '');

      if (action === 'enter') {
        return await handleEnter(interaction, giveaway);
      }
      if (action === 'participants') {
        return await handleParticipants(interaction, giveaway);
      }
    } catch (error) {
      console.error('[giveawayHandler] Error:', error);
      const payload = { content: '**Alert:** I was unable to process your giveaway entry, Master.', flags: MessageFlags.Ephemeral };
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply({ content: payload.content }).catch(() => { });
      } else {
        await interaction.reply(payload).catch(() => { });
      }
    }
  }
};

async function handleEnter(interaction, giveaway) {
  const userId = interaction.user.id;

  // Clicking again withdraws the entry
  if (giveaway.participants.includes(userId)) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const updated = await giveaway.removeParticipant(userId);
    if (updated) await refreshGiveawayMessage(interaction, updated);

    return interaction.editReply({ content: '**Confirmed:** You have withdrawn from the giveaway, Master.' });
  }

  // Role requirement
  const requiredRole = giveaway.requirements?.roleId;
  if (requiredRole && !interaction.member.roles.cache.has(requiredRole)) {
    return interaction.reply({
      content: `**Error:** The <@&${requiredRole}> role is required for giveaway entry, Master.`,
      flags: MessageFlags.Ephemeral,
      allowedMentions: { parse: [] }
    });
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const updated = await giveaway.addParticipant(userId);
  if (!updated) {
    // Already entered from a parallel click, or the giveaway closed in the meantime
    return interaction.editReply({ content: '**Notice:** Your entry is already registered, or the giveaway has concluded, Master.' });
  }

  await refreshGiveawayMessage(interaction, updated);

  return interaction.editReply({
    content: `**Confirmed:** Giveaway entry registered for **${updated.prize}**, Master.\n**Notice:** Activate again to withdraw.`,
    allowedMentions: { parse: [] }
  });
}

async function handleParticipants(interaction, giveaway) {
  const participants = giveaway.participants;

  if (participants.length === 0) {
    return interaction.reply({
      content: '**Notice:** No one has entered this giveaway yet, Master.',
      flags: MessageFlags.Ephemeral
    });
  }

  const participantList = participants.slice(0, PARTICIPANTS_PREVIEW).map(id => `<@${id}>`).join(', ');
  const moreCount = participants.length > PARTICIPANTS_PREVIEW ? ` and ${participants.length - PARTICIPANTS_PREVIEW} more` : '';

  return interaction.reply({
    content: `**Participants (${participants.length}):**\n${participantList}${moreCount}`,
    flags: MessageFlags.Ephemeral,
    allowedMentions: { parse: [] }
  });
}

// Re-render the giveaway message with the same builder the start command uses
async function refreshGiveawayMessage(interaction, giveaway) {
  await interaction.message.edit(await buildGiveawayMessage(giveaway)).catch((error) => {
    console.error('[giveawayHandler] Failed to update the giveaway message:', error);
  });
}

// Export function to check and end giveaways (called from scheduler)
export async function checkGiveaways(client) {
  try {
    // Check if database is connected before proceeding
    if (!client.db || !client.db.testConnection || !(await client.db.testConnection())) {
      console.log('[Giveaways] Database not connected, skipping check');
      return;
    }
    const endedGiveaways = await Giveaway.getActiveGiveaways();

    for (const giveaway of endedGiveaways) {
      const guild = client.guilds.cache.get(giveaway.guildId);
      if (!guild) continue;

      try {
        await endGiveawayById(guild, giveaway);
      } catch (error) {
        console.error(`[Giveaways] Failed to end giveaway ${giveaway.messageId}:`, error);
      }
    }
  } catch (error) {
    console.error('Error checking giveaways:', error);
  }
}
