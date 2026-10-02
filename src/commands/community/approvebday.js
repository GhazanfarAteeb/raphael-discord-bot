import { PermissionFlagsBits, EmbedBuilder } from 'discord.js';
import Birthday, { BirthdayRequest } from '../../models/Birthday.js';
import Guild from '../../models/Guild.js';
import { successEmbed, errorEmbed, COLORS, GLYPHS } from '../../utils/embeds.js';
import { getPrefix } from '../../utils/helpers.js';
import { getRandomFooter } from '../../utils/raphael.js';
import { createTicketEmbed, createTicketButtons, findOpenTicket, formatDate } from './requestbirthday.js';
import { celebrateBirthdayIfToday } from './setbirthday.js';

export default {
  name: 'approvebday',
  description: 'Approve a pending birthday request',
  usage: '<ticket-number|request-id>',
  aliases: ['approvebirthday', 'bdayapprove'],
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
            'Please provide a ticket number or request ID, Master.\n\n' +
            `**Usage:** \`${prefix}approvebday <ticket-number>\`\n\n` +
            '**Examples:**\n' +
            `${GLYPHS.DOT} \`${prefix}approvebday #0001\`\n` +
            `${GLYPHS.DOT} \`${prefix}approvebday 1\`\n\n` +
            `Use \`${prefix}birthdayrequests\` to see open tickets.`)]
        });
      }

      const { request: found, error } = await findOpenTicket(guildId, args[0]);
      if (!found) {
        return message.reply({ embeds: [await errorEmbed(guildId, 'Ticket Not Found', error)] });
      }

      // Claim the ticket atomically so two staff members cannot both act on it
      const request = await BirthdayRequest.findOneAndUpdate(
        { _id: found._id, status: 'open' },
        { $set: { status: 'approved', reviewedBy: message.author.id, reviewedAt: new Date() } },
        { new: true }
      );

      if (!request) {
        return message.reply({
          embeds: [await errorEmbed(guildId, 'Already Reviewed', 'Another staff member has already handled this ticket, Master.')]
        });
      }

      const userId = request.userId;
      const { month, day, year } = request.requestedBirthday;
      const targetUser = await message.client.users.fetch(userId).catch(() => null);

      let birthday;
      try {
        birthday = await Birthday.findOne({ guildId, userId });
        const fields = {
          birthday: { month, day, year },
          source: 'request',
          setBy: message.author.id,
          verified: true,
          verifiedBy: message.author.id,
          verifiedAt: new Date()
        };
        if (targetUser) fields.username = targetUser.username;

        if (birthday) {
          birthday.set(fields);
        } else {
          birthday = new Birthday({ guildId, userId, ...fields });
        }
        await birthday.save();
      } catch (saveError) {
        // Reopen the ticket so it is not left approved without a birthday
        await BirthdayRequest.updateOne(
          { _id: request._id },
          { $set: { status: 'open' }, $unset: { reviewedBy: '', reviewedAt: '' } }
        ).catch(() => { });
        throw saveError;
      }

      let celebrationChannelId = null;
      try {
        celebrationChannelId = await celebrateBirthdayIfToday(message.guild, guildConfig, birthday);
      } catch (celebrationErr) {
        console.error('[approvebday] Failed to send birthday celebration:', celebrationErr);
      }

      // Update ticket message if exists
      if (request.ticketMessageId && request.ticketChannelId) {
        try {
          const ticketChannel = message.guild.channels.cache.get(request.ticketChannelId);
          const ticketMsg = await ticketChannel?.messages.fetch(request.ticketMessageId).catch(() => null);
          if (ticketMsg) {
            await ticketMsg.edit({
              content: `**Ticket Approved** by ${message.author.tag}`,
              embeds: [createTicketEmbed(request, targetUser, request.currentBirthday)],
              components: createTicketButtons(request, false)
            });
          }
        } catch (err) {
          console.error('[approvebday] Failed to update ticket message:', err);
        }
      }

      const ticketNum = request.getFormattedTicketNumber();
      const dateStr = formatDate({ month, day, year });

      // Try to DM the user
      if (targetUser) {
        try {
          const dmEmbed = new EmbedBuilder()
            .setColor(COLORS.RAPHAEL_SUCCESS)
            .setTitle(`『 Ticket ${ticketNum} Approved 』`)
            .setDescription(
              `**Confirmed.** Your birthday request in **${message.guild.name}** has been approved, Master.\n\n` +
              `**Birthday:** ${dateStr}\n` +
              `**Approved by:** ${message.author.tag}`
            )
            .setFooter({ text: getRandomFooter() })
            .setTimestamp();
          await targetUser.send({ embeds: [dmEmbed] });
        } catch (err) {
          // User has DMs disabled
        }
      }

      let description = `Ticket ${ticketNum} approved, Master.\n\n` +
        `**User:** ${targetUser?.tag || userId}\n` +
        `**Birthday:** ${dateStr}`;

      if (birthday.isBirthdayToday()) {
        description += '\n\n**Notice:** Today is their birthday.';
        if (celebrationChannelId) {
          description += `\n${GLYPHS.DOT} Celebration announced in <#${celebrationChannelId}>`;
        }
      }

      return message.reply({ embeds: [await successEmbed(guildId, 'Request Approved', description)] });

    } catch (error) {
      console.error('[approvebday] Error:', error);
      return message.reply({
        embeds: [await errorEmbed(guildId, 'Operation Failed', 'I was unable to approve that request. Please try again, Master.')]
      });
    }
  }
};
