import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import Birthday, { BirthdayRequest } from '../../models/Birthday.js';
import Guild from '../../models/Guild.js';
import { errorEmbed, infoEmbed, COLORS, GLYPHS } from '../../utils/embeds.js';
import { getPrefix, truncate } from '../../utils/helpers.js';
import { getRandomFooter } from '../../utils/raphael.js';

// Longest request reason accepted; keeps the staff ticket embed field under Discord's 1024 limit
export const MAX_REASON_LENGTH = 500;
// Shortest request-ID prefix staff may type instead of a ticket number
const MIN_REQUEST_ID_PREFIX = 6;

// Simple ID generator
function generateRequestId() {
  return Date.now().toString(36) + Math.random().toString(36).substring(2, 8);
}

// Month names for display
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

const STATUS_DISPLAY = {
  open: { color: COLORS.RAPHAEL_WARNING, label: '◇ Open' },
  approved: { color: COLORS.RAPHAEL_SUCCESS, label: '◉ Approved' },
  rejected: { color: COLORS.RAPHAEL_ERROR, label: '◆ Rejected' },
  cancelled: { color: COLORS.MUTED, label: '— Cancelled' }
};

const PRIORITY_DISPLAY = { low: '◇ Low', normal: '◈ Normal', high: '◆ High' };

function formatDate({ month, day, year }) {
  return `${MONTH_NAMES[month - 1]} ${day}${year ? `, ${year}` : ''}`;
}

/**
 * Validate a birthday. Returns an error message, or null when the date is valid.
 * A year is optional; when given, the date must not be in the future.
 */
function validateBirthDate(month, day, year = null) {
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    return 'Invalid month. Please use a number from 1 to 12, Master.';
  }
  if (!Number.isInteger(day) || day < 1 || day > 31) {
    return 'Invalid day. Please use a number from 1 to 31, Master.';
  }

  const currentYear = new Date().getFullYear();
  if (year !== null && (!Number.isInteger(year) || year < 1900 || year > currentYear)) {
    return `Invalid year. Please use a year from 1900 to ${currentYear}, Master.`;
  }

  // Year 2000 is a leap year, so February 29 is accepted when no year is given
  const date = new Date(year ?? 2000, month - 1, day);
  if (date.getMonth() !== month - 1 || date.getDate() !== day) {
    return `${MONTH_NAMES[month - 1]} ${day} does not exist${year ? ` in ${year}` : ''}, Master.`;
  }

  if (year !== null) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    if (date > today) {
      return 'That date has not happened yet. A birth date cannot be in the future, Master.';
    }
  }

  return null;
}

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Find an open ticket from what staff typed: a ticket number (`7`, `#0007`) or
 * the start of its request ID (at least 6 characters, matched literally).
 * Returns { request } or { error }.
 */
async function findOpenTicket(guildId, input) {
  const raw = String(input ?? '').trim().replace(/^#/, '');
  if (!raw) return { error: 'Please provide a ticket number or request ID, Master.' };

  if (/^\d+$/.test(raw)) {
    const request = await BirthdayRequest.findOne({ guildId, ticketNumber: parseInt(raw, 10), status: 'open' });
    if (request) return { request };
  }

  if (raw.length < MIN_REQUEST_ID_PREFIX) {
    return { error: 'No open ticket matches that number, Master.' };
  }

  // Two results are enough to tell a unique prefix from an ambiguous one
  const matches = await BirthdayRequest.find({
    guildId,
    status: 'open',
    requestId: { $regex: `^${escapeRegex(raw)}`, $options: 'i' }
  }).limit(2);

  if (matches.length === 0) return { error: 'No open ticket matches that number or ID, Master.' };
  if (matches.length > 1) return { error: 'That ID matches more than one open ticket. Please use the ticket number, Master.' };
  return { request: matches[0] };
}

/**
 * Create the ticket embed for a birthday request
 */
function createTicketEmbed(request, user, currentBirthday = null) {
  const ticketNum = request.getFormattedTicketNumber();
  const status = STATUS_DISPLAY[request.status] || STATUS_DISPLAY.open;
  const priority = request.priority || 'normal';

  const embed = new EmbedBuilder()
    .setColor(status.color)
    .setAuthor({
      name: `Birthday Request ${ticketNum}`,
      iconURL: user?.displayAvatarURL({ dynamic: true })
    })
    .setTitle(`『 ${status.label} 』`)
    .setThumbnail(user?.displayAvatarURL({ dynamic: true, size: 256 }) || null)
    .addFields(
      { name: '▸ Requester', value: `${user?.tag || 'Unknown'}\n<@${request.userId}>`, inline: true },
      { name: '▸ Requested Birthday', value: formatDate(request.requestedBirthday), inline: true },
      { name: '▸ Status', value: status.label, inline: true },
      {
        name: '▸ Current Birthday',
        // A null nested path still reads back as an object, so check for an actual month
        value: currentBirthday?.month ? formatDate(currentBirthday) : '*Not set*',
        inline: true
      },
      { name: '▸ Priority', value: PRIORITY_DISPLAY[priority] || PRIORITY_DISPLAY.normal, inline: true },
      { name: '▸ Reason', value: truncate(request.reason || 'No reason provided', 1024), inline: false }
    );

  // If reviewed, show reviewer info
  if (request.status !== 'open' && request.reviewedBy) {
    embed.addFields(
      { name: '▸ Reviewed By', value: `<@${request.reviewedBy}>`, inline: true },
      { name: '▸ Reviewed At', value: `<t:${Math.floor(new Date(request.reviewedAt).getTime() / 1000)}:R>`, inline: true }
    );
  }

  // Rejection reason if rejected
  if (request.status === 'rejected' && request.rejectionReason) {
    embed.addFields({ name: '▸ Rejection Reason', value: truncate(request.rejectionReason, 1024), inline: false });
  }

  // Staff notes (latest three)
  if (request.staffNotes && request.staffNotes.length > 0) {
    const notesText = request.staffNotes.slice(-3)
      .map(n => `• ${truncate(n.note || '', 300)} — <@${n.staffId}>`)
      .join('\n');
    embed.addFields({ name: '▸ Staff Notes', value: truncate(notesText, 1024), inline: false });
  }

  embed.setFooter({ text: `Ticket ID: ${request.requestId} • Created` });
  embed.setTimestamp(request.createdAt);

  return embed;
}

/**
 * Create buttons for the ticket
 */
function createTicketButtons(request, isOpen = true) {
  const row1 = new ActionRowBuilder();
  const row2 = new ActionRowBuilder();
  const priority = request.priority || 'normal';

  if (isOpen) {
    row1.addComponents(
      new ButtonBuilder()
        .setCustomId(`bday_ticket_approve_${request.requestId}`)
        .setLabel('Approve')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`bday_ticket_reject_${request.requestId}`)
        .setLabel('Reject')
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId(`bday_ticket_note_${request.requestId}`)
        .setLabel('Add Note')
        .setStyle(ButtonStyle.Secondary)
    );

    row2.addComponents(
      new ButtonBuilder()
        .setCustomId(`bday_ticket_priority_low_${request.requestId}`)
        .setLabel('Low')
        .setStyle(priority === 'low' ? ButtonStyle.Primary : ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`bday_ticket_priority_normal_${request.requestId}`)
        .setLabel('Normal')
        .setStyle(priority === 'normal' ? ButtonStyle.Primary : ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`bday_ticket_priority_high_${request.requestId}`)
        .setLabel('High')
        .setStyle(priority === 'high' ? ButtonStyle.Primary : ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`bday_ticket_user_${request.requestId}`)
        .setLabel('View User')
        .setStyle(ButtonStyle.Secondary)
    );

    return [row1, row2];
  }

  // Closed ticket - only show reopen button
  row1.addComponents(
    new ButtonBuilder()
      .setCustomId(`bday_ticket_reopen_${request.requestId}`)
      .setLabel('Reopen')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(request.status === 'approved'),
    new ButtonBuilder()
      .setCustomId(`bday_ticket_user_${request.requestId}`)
      .setLabel('View User')
      .setStyle(ButtonStyle.Secondary)
  );

  return [row1];
}

export default {
  name: 'requestbirthday',
  description: 'Request to set or change your birthday (requires staff approval)',
  usage: '<month> <day> [year] [reason]',
  aliases: ['bdayrequest', 'birthdayrequest'],
  category: 'community',
  cooldown: 60, // 1 minute cooldown to prevent spam
  execute: async (message, args) => {
    const guildId = message.guild.id;
    const userId = message.author.id;

    try {
      const prefix = await getPrefix(guildId);

      if (args.length < 2) {
        return message.reply({
          embeds: [await errorEmbed(guildId, 'Birthday Required',
            'Please provide your birthday, Master.\n\n' +
            `**Usage:** \`${prefix}requestbirthday <month> <day> [year] [reason]\`\n\n` +
            '**Examples:**\n' +
            `${GLYPHS.DOT} \`${prefix}requestbirthday 12 25\` — December 25\n` +
            `${GLYPHS.DOT} \`${prefix}requestbirthday 12 25 2000\` — December 25, 2000\n` +
            `${GLYPHS.DOT} \`${prefix}requestbirthday 12 25 2000 My birthday was entered incorrectly\``)]
        });
      }

      const month = parseInt(args[0], 10);
      const day = parseInt(args[1], 10);
      let year = null;
      let reason = null;

      // A four-digit third argument is the birth year; anything else starts the reason
      if (args[2]) {
        if (/^\d{4}$/.test(args[2])) {
          year = parseInt(args[2], 10);
          reason = args.slice(3).join(' ') || null;
        } else {
          reason = args.slice(2).join(' ');
        }
      }

      const dateError = validateBirthDate(month, day, year);
      if (dateError) {
        return message.reply({ embeds: [await errorEmbed(guildId, 'Invalid Date', dateError)] });
      }

      if (reason && reason.length > MAX_REASON_LENGTH) {
        return message.reply({
          embeds: [await errorEmbed(guildId, 'Reason Too Long',
            `The reason may be at most ${MAX_REASON_LENGTH} characters (yours is ${reason.length}), Master.`)]
        });
      }

      // Check for existing open request
      const existingRequest = await BirthdayRequest.findOne({ userId, guildId, status: 'open' });

      if (existingRequest) {
        const ticketNum = existingRequest.getFormattedTicketNumber();
        return message.reply({
          embeds: [await errorEmbed(guildId, 'Ticket Already Open',
            `You already have an open ticket (${ticketNum}), Master.\n\n` +
            `**Requested:** ${formatDate(existingRequest.requestedBirthday)}\n\n` +
            'Please wait for staff to review it.\n' +
            `Use \`${prefix}cancelbirthday\` to cancel your request.`)]
        });
      }

      // Check current birthday
      const currentBirthday = await Birthday.findOne({ userId, guildId });

      // If same as current birthday
      if (currentBirthday &&
        currentBirthday.birthday.month === month &&
        currentBirthday.birthday.day === day &&
        (currentBirthday.birthday.year ?? null) === year) {
        return message.reply({
          embeds: [await infoEmbed(guildId, 'Already Set',
            'This is already your registered birthday, Master.')]
        });
      }

      // Get next ticket number
      const ticketNumber = await BirthdayRequest.getNextTicketNumber(guildId);

      const request = new BirthdayRequest({
        ticketNumber,
        requestId: generateRequestId(),
        userId,
        guildId,
        requestedBirthday: { month, day, year },
        currentBirthday: currentBirthday ? currentBirthday.birthday : null,
        reason: reason || 'No reason provided',
        status: 'open',
        priority: 'normal'
      });

      await request.save();

      const ticketNum = request.getFormattedTicketNumber();

      // Notify staff if there's a staff channel configured
      const guildConfig = await Guild.getGuild(guildId, message.guild.name);
      const staffChannelId = guildConfig?.channels?.staffChannel;

      if (staffChannelId) {
        try {
          const channel = message.guild.channels.cache.get(staffChannelId);
          if (channel?.isTextBased()) {
            const ticketMsg = await channel.send({
              content: `**New Birthday Request** ${ticketNum}`,
              embeds: [createTicketEmbed(request, message.author, currentBirthday?.birthday)],
              components: createTicketButtons(request, true)
            });

            // Save message reference for updates
            request.ticketMessageId = ticketMsg.id;
            request.ticketChannelId = channel.id;
            await request.save();
          }
        } catch (err) {
          console.error('Failed to create birthday ticket:', err);
        }
      }

      const confirmEmbed = new EmbedBuilder()
        .setColor(COLORS.RAPHAEL_SUCCESS)
        .setTitle(`『 Ticket Created ${ticketNum} 』`)
        .setDescription(
          '**Confirmed.** Your birthday request has been submitted for staff review, Master.\n\n' +
          `**Ticket Number:** ${ticketNum}\n` +
          `**Requested Birthday:** ${formatDate({ month, day, year })}\n` +
          `**Reason:** ${reason || 'No reason provided'}\n\n` +
          'You will be notified when staff reviews your request.\n' +
          `Use \`${prefix}cancelbirthday\` to cancel this request.`
        )
        .setFooter({ text: getRandomFooter() })
        .setTimestamp();

      return message.reply({ embeds: [confirmEmbed] });

    } catch (error) {
      console.error('[requestbirthday] Error:', error);
      return message.reply({
        embeds: [await errorEmbed(guildId, 'Ticket Failed', 'I was unable to create your ticket. Please try again, Master.')]
      });
    }
  }
};

// Export helper functions for use in the other ticket commands and the button handler
export { createTicketEmbed, createTicketButtons, findOpenTicket, validateBirthDate, formatDate, MONTH_NAMES };
