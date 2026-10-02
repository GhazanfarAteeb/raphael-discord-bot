import { EmbedBuilder } from 'discord.js';
import { BirthdayRequest } from '../../models/Birthday.js';
import { errorEmbed, infoEmbed, COLORS } from '../../utils/embeds.js';
import { getPrefix } from '../../utils/helpers.js';
import { getRandomFooter } from '../../utils/raphael.js';
import { createTicketEmbed, createTicketButtons } from './requestbirthday.js';

export default {
  name: 'cancelbirthday',
  description: 'Cancel your pending birthday request',
  usage: '',
  aliases: ['cancelbday', 'cancelticket'],
  category: 'community',
  execute: async (message) => {
    const guildId = message.guild.id;
    const userId = message.author.id;

    try {
      const prefix = await getPrefix(guildId);

      // Cancel atomically so a cancellation cannot race a staff approval
      const request = await BirthdayRequest.findOneAndUpdate(
        { userId, guildId, status: 'open' },
        { $set: { status: 'cancelled', reviewedAt: new Date() } },
        { new: true }
      );

      if (!request) {
        return message.reply({
          embeds: [await infoEmbed(guildId, 'No Open Ticket',
            'You do not have an open birthday request to cancel, Master.')]
        });
      }

      const ticketNum = request.getFormattedTicketNumber();

      // Update ticket message if it exists
      if (request.ticketMessageId && request.ticketChannelId) {
        try {
          const channel = message.guild.channels.cache.get(request.ticketChannelId);
          const ticketMsg = await channel?.messages.fetch(request.ticketMessageId).catch(() => null);
          if (ticketMsg) {
            await ticketMsg.edit({
              content: '**Ticket Cancelled** by the requester',
              embeds: [createTicketEmbed(request, message.author, request.currentBirthday)],
              components: createTicketButtons(request, false)
            });
          }
        } catch (err) {
          console.error('[cancelbirthday] Failed to update ticket message:', err);
        }
      }

      const embed = new EmbedBuilder()
        .setColor(COLORS.RAPHAEL)
        .setTitle(`『 Ticket ${ticketNum} Cancelled 』`)
        .setDescription(
          '**Confirmed.** Your birthday request has been cancelled, Master.\n\n' +
          `You may submit a new request at any time with \`${prefix}requestbirthday <month> <day> [year]\`.`
        )
        .setFooter({ text: getRandomFooter() })
        .setTimestamp();

      return message.reply({ embeds: [embed] });

    } catch (error) {
      console.error('[cancelbirthday] Error:', error);
      return message.reply({
        embeds: [await errorEmbed(guildId, 'Operation Failed', 'I was unable to cancel your request. Please try again, Master.')]
      });
    }
  }
};
