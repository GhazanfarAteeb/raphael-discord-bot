import { Events, ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder, EmbedBuilder, PermissionFlagsBits, MessageFlags } from 'discord.js';
import Birthday, { BirthdayRequest } from '../../models/Birthday.js';
import Guild from '../../models/Guild.js';
import { createTicketEmbed, createTicketButtons, formatDate, MAX_REASON_LENGTH } from '../../commands/community/requestbirthday.js';
import { celebrateBirthdayIfToday } from '../../commands/community/setbirthday.js';
import { COLORS } from '../../utils/embeds.js';
import { getRandomFooter } from '../../utils/raphael.js';

const PRIORITIES = ['low', 'normal', 'high'];
const MAX_NOTE_LENGTH = 200;
const STATUS_GLYPHS = { open: '◇', approved: '◉', rejected: '◆', cancelled: '—' };

export default {
  name: Events.InteractionCreate,
  async execute(interaction, client) {
    try {
      // Handle Birthday Ticket buttons
      if (interaction.isButton() && interaction.customId.startsWith('bday_ticket_')) {
        return await handleTicketButton(interaction, client);
      }

      // Handle Birthday Ticket modals
      if (interaction.isModalSubmit() && interaction.customId.startsWith('bday_ticket_modal_')) {
        return await handleTicketModal(interaction, client);
      }
    } catch (error) {
      console.error('[birthdayTicketHandler] Error:', error);
      const payload = { content: '**Alert:** I was unable to process that ticket action, Master.', flags: MessageFlags.Ephemeral };
      if (interaction.deferred || interaction.replied) {
        await interaction.followUp(payload).catch(() => { });
      } else {
        await interaction.reply(payload).catch(() => { });
      }
    }
  }
};

function ephemeral(content) {
  return { content, flags: MessageFlags.Ephemeral };
}

/**
 * Check if user has staff permissions
 */
async function isStaff(interaction) {
  const guildConfig = await Guild.getGuild(interaction.guild.id, interaction.guild.name);

  return interaction.member.permissions.has(PermissionFlagsBits.ManageRoles) ||
    interaction.member.permissions.has(PermissionFlagsBits.Administrator) ||
    (guildConfig?.roles?.staffRoles || []).some(roleId => interaction.member.roles.cache.has(roleId));
}

/**
 * Handle birthday ticket button interactions
 */
async function handleTicketButton(interaction, client) {
  const parts = interaction.customId.split('_');
  // Format: bday_ticket_<action>_[param]_<requestId>
  const action = parts[2];
  const requestId = parts[parts.length - 1];

  // Check staff permissions for most actions
  if (action !== 'user' && !await isStaff(interaction)) {
    return interaction.reply(ephemeral('**Notice:** Staff permissions are required to manage birthday tickets, Master.'));
  }

  const request = await BirthdayRequest.findOne({ requestId, guildId: interaction.guild.id });
  if (!request) {
    return interaction.reply(ephemeral('**Notice:** This ticket no longer exists, Master.'));
  }

  switch (action) {
    case 'approve':
      return approveTicket(interaction, request, client);
    case 'reject':
      return showRejectModal(interaction, request);
    case 'note':
      return showNoteModal(interaction, request);
    case 'priority':
      return updatePriority(interaction, request, parts[3], client);
    case 'user':
      return viewUser(interaction, request, client);
    case 'reopen':
      return reopenTicket(interaction, request, client);
    default:
      return interaction.reply(ephemeral('**Notice:** Unknown ticket action, Master.'));
  }
}

/**
 * Approve a birthday ticket
 */
async function approveTicket(interaction, request, client) {
  // Claim the ticket atomically so it cannot be approved and rejected at the same time
  const claimed = await BirthdayRequest.findOneAndUpdate(
    { _id: request._id, status: 'open' },
    { $set: { status: 'approved', reviewedBy: interaction.user.id, reviewedAt: new Date() } },
    { new: true }
  );

  if (!claimed) {
    return interaction.reply(ephemeral('**Notice:** This ticket has already been reviewed, Master.'));
  }

  await interaction.deferUpdate();

  const guildId = claimed.guildId;
  const userId = claimed.userId;
  const { month, day, year } = claimed.requestedBirthday;
  const targetUser = await client.users.fetch(userId).catch(() => null);

  let birthday;
  try {
    birthday = await Birthday.findOne({ guildId, userId });
    const fields = {
      birthday: { month, day, year },
      source: 'request',
      setBy: interaction.user.id,
      verified: true,
      verifiedBy: interaction.user.id,
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
      { _id: claimed._id },
      { $set: { status: 'open' }, $unset: { reviewedBy: '', reviewedAt: '' } }
    ).catch(() => { });
    throw saveError;
  }

  let celebrationChannelId = null;
  try {
    const guildConfig = await Guild.getGuild(guildId, interaction.guild.name);
    celebrationChannelId = await celebrateBirthdayIfToday(interaction.guild, guildConfig, birthday);
  } catch (err) {
    console.error('[birthdayTicketHandler] Failed to send birthday celebration:', err);
  }

  // Try to DM the user
  if (targetUser) {
    try {
      const dmEmbed = new EmbedBuilder()
        .setColor(COLORS.RAPHAEL_SUCCESS)
        .setTitle(`『 Ticket ${claimed.getFormattedTicketNumber()} Approved 』`)
        .setDescription(
          `**Confirmed.** Your birthday request in **${interaction.guild.name}** has been approved, Master.\n\n` +
          `**Birthday:** ${formatDate({ month, day, year })}\n` +
          `**Approved by:** ${interaction.user.tag}`
        )
        .setFooter({ text: getRandomFooter() })
        .setTimestamp();
      await targetUser.send({ embeds: [dmEmbed] });
    } catch (err) {
      // User has DMs disabled
    }
  }

  let content = `**Ticket Approved** by ${interaction.user.tag}`;
  if (celebrationChannelId) {
    content += ` • Today is their birthday; celebration announced in <#${celebrationChannelId}>`;
  }

  await interaction.editReply({
    content,
    embeds: [createTicketEmbed(claimed, targetUser, claimed.currentBirthday)],
    components: createTicketButtons(claimed, false),
    allowedMentions: { parse: [] }
  });
}

/**
 * Show reject modal
 */
async function showRejectModal(interaction, request) {
  if (request.status !== 'open') {
    return interaction.reply(ephemeral('**Notice:** This ticket has already been reviewed, Master.'));
  }

  const modal = new ModalBuilder()
    .setCustomId(`bday_ticket_modal_reject_${request.requestId}`)
    .setTitle('Reject Birthday Request');

  const reasonInput = new TextInputBuilder()
    .setCustomId('rejection_reason')
    .setLabel('Reason for rejection')
    .setPlaceholder('Enter a reason for rejecting this request...')
    .setStyle(TextInputStyle.Paragraph)
    .setMaxLength(MAX_REASON_LENGTH)
    .setRequired(true);

  modal.addComponents(new ActionRowBuilder().addComponents(reasonInput));
  await interaction.showModal(modal);
}

/**
 * Show add note modal
 */
async function showNoteModal(interaction, request) {
  const modal = new ModalBuilder()
    .setCustomId(`bday_ticket_modal_note_${request.requestId}`)
    .setTitle('Add Staff Note');

  const noteInput = new TextInputBuilder()
    .setCustomId('staff_note')
    .setLabel('Note')
    .setPlaceholder('Add a note to this ticket...')
    .setStyle(TextInputStyle.Paragraph)
    .setMaxLength(MAX_NOTE_LENGTH)
    .setRequired(true);

  modal.addComponents(new ActionRowBuilder().addComponents(noteInput));
  await interaction.showModal(modal);
}

/**
 * Update ticket priority
 */
async function updatePriority(interaction, request, priority, client) {
  if (!PRIORITIES.includes(priority)) {
    return interaction.reply(ephemeral('**Notice:** Unknown priority, Master.'));
  }

  const updated = await BirthdayRequest.findOneAndUpdate(
    { _id: request._id },
    { $set: { priority } },
    { new: true }
  );

  const targetUser = await client.users.fetch(updated.userId).catch(() => null);

  await interaction.update({
    embeds: [createTicketEmbed(updated, targetUser, updated.currentBirthday)],
    components: createTicketButtons(updated, updated.status === 'open')
  });
}

/**
 * View user info
 */
async function viewUser(interaction, request, client) {
  const targetUser = await client.users.fetch(request.userId).catch(() => null);
  const member = await interaction.guild.members.fetch(request.userId).catch(() => null);

  if (!targetUser) {
    return interaction.reply(ephemeral('**Notice:** I could not fetch that user\'s information, Master.'));
  }

  const birthday = await Birthday.findOne({ guildId: request.guildId, userId: request.userId });

  const embed = new EmbedBuilder()
    .setColor(COLORS.RAPHAEL)
    .setTitle('『 Requester Analysis 』')
    .setAuthor({ name: targetUser.tag, iconURL: targetUser.displayAvatarURL({ dynamic: true }) })
    .setThumbnail(targetUser.displayAvatarURL({ dynamic: true, size: 256 }))
    .addFields(
      { name: '▸ User', value: `${targetUser.tag}\n<@${targetUser.id}>`, inline: true },
      { name: '▸ ID', value: targetUser.id, inline: true },
      { name: '▸ Account Created', value: `<t:${Math.floor(targetUser.createdTimestamp / 1000)}:D>`, inline: true }
    )
    .setFooter({ text: getRandomFooter() });

  if (member) {
    embed.addFields({ name: '▸ Joined Server', value: `<t:${Math.floor(member.joinedTimestamp / 1000)}:D>`, inline: true });
  }

  if (birthday) {
    embed.addFields(
      { name: '▸ Current Birthday', value: formatDate(birthday.birthday), inline: true },
      { name: '▸ Source', value: birthday.source || 'Unknown', inline: true }
    );
  } else {
    embed.addFields({ name: '▸ Current Birthday', value: '*Not set*', inline: true });
  }

  // Previous requests
  const previousRequests = await BirthdayRequest.find({
    guildId: request.guildId,
    userId: request.userId
  }).sort({ createdAt: -1 }).limit(5);

  if (previousRequests.length > 1) {
    const historyText = previousRequests
      .map(r => `${STATUS_GLYPHS[r.status] || '◇'} ${r.getFormattedTicketNumber()} — ${r.status}`)
      .join('\n');
    embed.addFields({ name: '▸ Request History', value: historyText, inline: false });
  }

  await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}

/**
 * Reopen a ticket
 */
async function reopenTicket(interaction, request, client) {
  if (request.status === 'approved') {
    return interaction.reply(ephemeral('**Notice:** An approved ticket cannot be reopened, Master.'));
  }

  // A member may only have one open ticket at a time
  const otherOpen = await BirthdayRequest.exists({
    guildId: request.guildId,
    userId: request.userId,
    status: 'open',
    _id: { $ne: request._id }
  });
  if (otherOpen) {
    return interaction.reply(ephemeral('**Notice:** This member already has another open ticket, Master.'));
  }

  const reopened = await BirthdayRequest.findOneAndUpdate(
    { _id: request._id, status: { $in: ['rejected', 'cancelled'] } },
    {
      $set: { status: 'open', reviewedBy: null, reviewedAt: null, rejectionReason: null },
      $push: { staffNotes: { staffId: interaction.user.id, note: 'Ticket reopened', createdAt: new Date() } }
    },
    { new: true }
  );

  if (!reopened) {
    return interaction.reply(ephemeral('**Notice:** This ticket is already open, Master.'));
  }

  const targetUser = await client.users.fetch(reopened.userId).catch(() => null);

  await interaction.update({
    content: `**Ticket Reopened** by ${interaction.user.tag}`,
    embeds: [createTicketEmbed(reopened, targetUser, reopened.currentBirthday)],
    components: createTicketButtons(reopened, true),
    allowedMentions: { parse: [] }
  });
}

/**
 * Handle ticket modal submissions
 */
async function handleTicketModal(interaction, client) {
  const parts = interaction.customId.split('_');
  const action = parts[3]; // reject or note
  const requestId = parts[4];

  if (!await isStaff(interaction)) {
    return interaction.reply(ephemeral('**Notice:** Staff permissions are required to manage birthday tickets, Master.'));
  }

  const request = await BirthdayRequest.findOne({ requestId, guildId: interaction.guild.id });
  if (!request) {
    return interaction.reply(ephemeral('**Notice:** This ticket no longer exists, Master.'));
  }

  switch (action) {
    case 'reject': {
      const reason = interaction.fields.getTextInputValue('rejection_reason').slice(0, MAX_REASON_LENGTH);

      const rejected = await BirthdayRequest.findOneAndUpdate(
        { _id: request._id, status: 'open' },
        { $set: { status: 'rejected', reviewedBy: interaction.user.id, reviewedAt: new Date(), rejectionReason: reason } },
        { new: true }
      );

      if (!rejected) {
        return interaction.reply(ephemeral('**Notice:** This ticket has already been reviewed, Master.'));
      }

      const targetUser = await client.users.fetch(rejected.userId).catch(() => null);

      // DM the user
      if (targetUser) {
        try {
          const dmEmbed = new EmbedBuilder()
            .setColor(COLORS.RAPHAEL_ERROR)
            .setTitle(`『 Ticket ${rejected.getFormattedTicketNumber()} Rejected 』`)
            .setDescription(
              `Your birthday request in **${interaction.guild.name}** has been rejected, Master.\n\n` +
              `**Reason:** ${reason}\n` +
              `**Rejected by:** ${interaction.user.tag}\n\n` +
              'If you believe this was a mistake, please contact server staff.'
            )
            .setFooter({ text: getRandomFooter() })
            .setTimestamp();
          await targetUser.send({ embeds: [dmEmbed] });
        } catch (err) {
          // User has DMs disabled
        }
      }

      await interaction.update({
        content: `**Ticket Rejected** by ${interaction.user.tag}`,
        embeds: [createTicketEmbed(rejected, targetUser, rejected.currentBirthday)],
        components: createTicketButtons(rejected, false),
        allowedMentions: { parse: [] }
      });
      break;
    }

    case 'note': {
      const note = interaction.fields.getTextInputValue('staff_note').slice(0, MAX_NOTE_LENGTH);

      const updated = await BirthdayRequest.findOneAndUpdate(
        { _id: request._id },
        { $push: { staffNotes: { staffId: interaction.user.id, note, createdAt: new Date() } } },
        { new: true }
      );

      const targetUser = await client.users.fetch(updated.userId).catch(() => null);

      await interaction.update({
        embeds: [createTicketEmbed(updated, targetUser, updated.currentBirthday)],
        components: createTicketButtons(updated, updated.status === 'open')
      });
      break;
    }

    default:
      return interaction.reply(ephemeral('**Notice:** Unknown ticket action, Master.'));
  }
}
