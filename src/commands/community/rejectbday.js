import { PermissionFlagsBits, EmbedBuilder } from 'discord.js';
import { BirthdayRequest } from '../../models/Birthday.js';
import Guild from '../../models/Guild.js';
import { successEmbed, errorEmbed, COLORS, GLYPHS } from '../../utils/embeds.js';
import { getPrefix } from '../../utils/helpers.js';
import { getRandomFooter } from '../../utils/raphael.js';
import { createTicketEmbed, createTicketButtons, findOpenTicket, formatDate, MAX_REASON_LENGTH } from './requestbirthday.js';

export default {
  name: 'rejectbday',
  description: 'Reject an open birthday ticket',
  usage: '<ticket-number|request-id> [reason]',
  aliases: ['rejectbirthday', 'bdayreject', 'denybday'],
  category: 'community',
  permissions: [PermissionFlagsBits.ManageRoles],
  execute: async (message, args) => {
    const guildId = message.guild.id;

    try {
      const guildConfig = await Guild.getGuild(guildId, message.guild.name);
      const isStaff = message.member.permissions.has(PermissionFlagsBits.ManageRoles) ||
        message.member.permissions.has(PermissionFlagsBits.Administrator) ||
        (guildConfig?.roles?.staffRoles || []).some(roleId => message.member.roles.cache.has(roleId));

      if (!isStaff) {
        return message.reply({
          embeds: [await errorEmbed(guildId, 'Permission Denied', 'Staff permissions are required for this skill, Master.')]
        });
      }

      const prefix = await getPrefix(guildId);

      if (!args[0]) {
        return message.reply({
          embeds: [await errorEmbed(guildId, 'Ticket Required',
            'Please provide a ticket number, Master.\n\n' +
            `**Usage:** \`${prefix}rejectbday <ticket-number> [reason]\`\n\n` +
            '**Examples:**\n' +
            `${GLYPHS.DOT} \`${prefix}rejectbday #0001 Invalid date\`\n` +
            `${GLYPHS.DOT} \`${prefix}rejectbday 1 Please provide proof\`\n\n` +
            `Use \`${prefix}birthdayrequests\` to see open tickets.`)]
        });
      }

      const reason = args.slice(1).join(' ') || 'No reason provided';
      if (reason.length > MAX_REASON_LENGTH) {
        return message.reply({
          embeds: [await errorEmbed(guildId, 'Reason Too Long',
            `The rejection reason may be at most ${MAX_REASON_LENGTH} characters (yours is ${reason.length}), Master.`)]
        });
      }

      const { request: found, error } = await findOpenTicket(guildId, args[0]);
      if (!found) {
        return message.reply({ embeds: [await errorEmbed(guildId, 'Ticket Not Found', error)] });
      }

      // Claim the ticket atomically so two staff members cannot both act on it
      const request = await BirthdayRequest.findOneAndUpdate(
        { _id: found._id, status: 'open' },
        { $set: { status: 'rejected', reviewedBy: message.author.id, reviewedAt: new Date(), rejectionReason: reason } },
        { new: true }
      );

      if (!request) {
        return message.reply({
          embeds: [await errorEmbed(guildId, 'Already Reviewed', 'Another staff member has already handled this ticket, Master.')]
        });
      }

      const userId = request.userId;
      const dateStr = formatDate(request.requestedBirthday);
      const targetUser = await message.client.users.fetch(userId).catch(() => null);

      // Update ticket message if exists
      if (request.ticketMessageId && request.ticketChannelId) {
        try {
          const ticketChannel = message.guild.channels.cache.get(request.ticketChannelId);
          const ticketMsg = await ticketChannel?.messages.fetch(request.ticketMessageId).catch(() => null);
          if (ticketMsg) {
            await ticketMsg.edit({
              content: `**Ticket Rejected** by ${message.author.tag}`,
              embeds: [createTicketEmbed(request, targetUser, request.currentBirthday)],
              components: createTicketButtons(request, false)
            });
          }
        } catch (err) {
          console.error('[rejectbday] Failed to update ticket message:', err);
        }
      }

      const ticketNumStr = request.getFormattedTicketNumber();

      // Try to DM the user
      if (targetUser) {
        try {
          const dmEmbed = new EmbedBuilder()
            .setColor(COLORS.RAPHAEL_ERROR)
            .setTitle(`『 Ticket ${ticketNumStr} Rejected 』`)
            .setDescription(
              `Your birthday request in **${message.guild.name}** has been rejected, Master.\n\n` +
              `**Requested Birthday:** ${dateStr}\n` +
              `**Reason:** ${reason}\n` +
              `**Rejected by:** ${message.author.tag}\n\n` +
              'If you believe this was a mistake, please contact server staff.'
            )
            .setFooter({ text: getRandomFooter() })
            .setTimestamp();
          await targetUser.send({ embeds: [dmEmbed] });
        } catch (err) {
          // User has DMs disabled
        }
      }

      return message.reply({
        embeds: [await successEmbed(guildId, `Ticket ${ticketNumStr} Rejected`,
          `Birthday ticket rejected, Master.\n\n` +
          `**User:** ${targetUser?.tag || userId}\n` +
          `**Requested Birthday:** ${dateStr}\n` +
          `**Reason:** ${reason}`
        )]
      });

    } catch (error) {
      console.error('[rejectbday] Error:', error);
      return message.reply({
        embeds: [await errorEmbed(guildId, 'Operation Failed', 'I was unable to reject that ticket. Please try again, Master.')]
      });
    }
  }
};
