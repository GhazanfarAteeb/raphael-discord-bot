import {
  Events,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  MessageFlags
} from 'discord.js';
import Confession from '../../models/Confession.js';
import { COLORS } from '../../utils/embeds.js';

// Discord text inputs accept at most 4000 characters
const MODAL_MAX_LENGTH = 4000;
const REPLY_MIN_LENGTH = 5;
const REPLY_MAX_LENGTH = 1000;

export default {
  name: Events.InteractionCreate,
  async execute(interaction, client) {
    try {
      // Handle confession button clicks
      if (interaction.isButton()) {
        if (interaction.customId === 'confession_submit') {
          return await handleConfessionSubmit(interaction);
        }
        if (interaction.customId.startsWith('confession_reply_')) {
          return await handleConfessionReply(interaction);
        }
      }

      // Handle modal submissions
      if (interaction.isModalSubmit()) {
        if (interaction.customId === 'confession_modal') {
          return await handleConfessionModalSubmit(interaction, client);
        }
        if (interaction.customId.startsWith('confession_reply_modal_')) {
          return await handleConfessionReplyModalSubmit(interaction, client);
        }
      }
    } catch (error) {
      console.error('[confessionHandler] Error:', error);
      const content = '**Alert:** I was unable to process your confession, Master. Please try again.';
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply({ content }).catch(() => { });
      } else {
        await interaction.reply({ content, flags: MessageFlags.Ephemeral }).catch(() => { });
      }
    }
  }
};

function ephemeral(content) {
  return { content, flags: MessageFlags.Ephemeral };
}

function submitButton() {
  return new ButtonBuilder()
    .setCustomId('confession_submit')
    .setLabel('Submit a Confession')
    .setStyle(ButtonStyle.Primary);
}

function replyButton(confessionNumber) {
  return new ButtonBuilder()
    .setCustomId(`confession_reply_${confessionNumber}`)
    .setLabel('Reply')
    .setStyle(ButtonStyle.Secondary);
}

/**
 * Post a confession in the confession channel and record it on `confessionData`
 * (the caller saves). The latest confession carries the Submit button, plus a Reply
 * button only while replies are allowed; the previous confession's buttons are removed.
 * Shared by direct submissions and the approve subcommand. Returns the confession number.
 */
export async function postConfession(channel, confessionData, content, userId) {
  confessionData.confessionCount++;
  const confessionNumber = confessionData.confessionCount;

  // Find the previous main confession (not a reply) and remove all buttons from it
  const mainConfessions = confessionData.confessions.filter(c => !c.replyTo && c.messageId);
  const previousMainConfession = mainConfessions[mainConfessions.length - 1];
  if (previousMainConfession) {
    const prevMessage = await channel.messages.fetch(previousMainConfession.messageId).catch(() => null);
    if (prevMessage) await prevMessage.edit({ components: [] }).catch(() => { });
  }

  const confessionEmbed = new EmbedBuilder()
    .setAuthor({ name: `Anonymous Confession (#${confessionNumber})` })
    .setDescription(`"${content}"`)
    .setColor(COLORS.RAPHAEL)
    .setTimestamp();

  const buttons = [submitButton()];
  if (confessionData.settings.allowReplies) buttons.push(replyButton(confessionNumber));

  const sentMessage = await channel.send({
    embeds: [confessionEmbed],
    components: [new ActionRowBuilder().addComponents(buttons)]
  });

  // Thread is created when the first reply is submitted
  confessionData.confessions.push({
    number: confessionNumber,
    content,
    messageId: sentMessage.id,
    threadId: null,
    userId, // Stored for moderation purposes only
    timestamp: new Date()
  });

  return confessionNumber;
}

async function handleConfessionSubmit(interaction) {
  const confessionData = await Confession.findOne({ guildId: interaction.guild.id });

  if (!confessionData || !confessionData.enabled) {
    return interaction.reply(ephemeral('**Notice:** The confession system is not enabled in this server, Master.'));
  }

  if (confessionData.settings.bannedUsers.includes(interaction.user.id)) {
    return interaction.reply(ephemeral('**Notice:** You have been barred from submitting confessions, Master.'));
  }

  // Check cooldown
  const lastConfession = confessionData.userCooldowns?.get(interaction.user.id);
  if (lastConfession) {
    const cooldownEnd = new Date(lastConfession).getTime() + (confessionData.settings.cooldown * 1000);
    if (Date.now() < cooldownEnd) {
      const remaining = Math.ceil((cooldownEnd - Date.now()) / 1000);
      return interaction.reply(ephemeral(`**Notice:** Please wait **${remaining} seconds** before submitting another confession, Master.`));
    }
  }

  // Clamp stored limits so an older, inconsistent setting cannot produce an invalid modal
  const maxLength = Math.min(Math.max(confessionData.settings.maxLength || MODAL_MAX_LENGTH, 1), MODAL_MAX_LENGTH);
  const minLength = Math.min(Math.max(confessionData.settings.minLength || 1, 1), maxLength);

  const modal = new ModalBuilder()
    .setCustomId('confession_modal')
    .setTitle('Submit Anonymous Confession');

  const confessionInput = new TextInputBuilder()
    .setCustomId('confession_content')
    .setLabel('Your Confession')
    .setPlaceholder('Write your anonymous confession here...')
    .setStyle(TextInputStyle.Paragraph)
    .setMinLength(minLength)
    .setMaxLength(maxLength)
    .setRequired(true);

  modal.addComponents(new ActionRowBuilder().addComponents(confessionInput));

  return interaction.showModal(modal);
}

async function handleConfessionReply(interaction) {
  const confessionData = await Confession.findOne({ guildId: interaction.guild.id });

  if (!confessionData || !confessionData.enabled || !confessionData.settings.allowReplies) {
    return interaction.reply(ephemeral('**Notice:** Replies are not enabled in this server, Master.'));
  }

  if (confessionData.settings.bannedUsers.includes(interaction.user.id)) {
    return interaction.reply(ephemeral('**Notice:** You have been barred from the confession system, Master.'));
  }

  const confessionNumber = interaction.customId.replace('confession_reply_', '');

  const modal = new ModalBuilder()
    .setCustomId(`confession_reply_modal_${confessionNumber}`)
    .setTitle(`Reply to Confession #${confessionNumber}`);

  const replyInput = new TextInputBuilder()
    .setCustomId('reply_content')
    .setLabel('Your Reply')
    .setPlaceholder('Write your reply here...')
    .setStyle(TextInputStyle.Paragraph)
    .setMinLength(REPLY_MIN_LENGTH)
    .setMaxLength(REPLY_MAX_LENGTH)
    .setRequired(true);

  modal.addComponents(new ActionRowBuilder().addComponents(replyInput));

  return interaction.showModal(modal);
}

async function handleConfessionModalSubmit(interaction) {
  // Defer reply immediately to prevent timeout
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const confessionContent = interaction.fields.getTextInputValue('confession_content');
  const confessionData = await Confession.findOne({ guildId: interaction.guild.id });

  if (!confessionData || !confessionData.enabled) {
    return interaction.editReply({ content: '**Notice:** The confession system is not enabled in this server, Master.' });
  }

  if (confessionData.settings.bannedUsers.includes(interaction.user.id)) {
    return interaction.editReply({ content: '**Notice:** You have been barred from submitting confessions, Master.' });
  }

  const channel = interaction.guild.channels.cache.get(confessionData.channelId);
  if (!channel?.isTextBased()) {
    return interaction.editReply({ content: '**Notice:** The confession channel no longer exists, Master.' });
  }

  // Check for blocked words
  if (confessionData.settings.blockedWords?.length > 0) {
    const lowerContent = confessionContent.toLowerCase();
    const hasBlockedWord = confessionData.settings.blockedWords.some(word =>
      lowerContent.includes(word.toLowerCase())
    );
    if (hasBlockedWord) {
      return interaction.editReply({ content: '**Notice:** Your confession contains blocked words. Please revise it and try again, Master.' });
    }
  }

  // Update cooldown
  if (!confessionData.userCooldowns) {
    confessionData.userCooldowns = new Map();
  }
  confessionData.userCooldowns.set(interaction.user.id, new Date());

  // Check if approval is required
  if (confessionData.settings.requireApproval) {
    confessionData.pendingConfessions.push({
      content: confessionContent,
      userId: interaction.user.id,
      timestamp: new Date()
    });
    await confessionData.save();

    return interaction.editReply({ content: '**Confirmed:** Your confession has been submitted and awaits moderator approval, Master.' });
  }

  const confessionNumber = await postConfession(channel, confessionData, confessionContent, interaction.user.id);
  await confessionData.save();

  return interaction.editReply({ content: `**Confirmed:** Your anonymous confession (#${confessionNumber}) has been posted, Master.` });
}

async function handleConfessionReplyModalSubmit(interaction) {
  // Defer reply immediately to prevent timeout
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const replyContent = interaction.fields.getTextInputValue('reply_content');
  const confessionNumber = interaction.customId.replace('confession_reply_modal_', '');

  const confessionData = await Confession.findOne({ guildId: interaction.guild.id });

  if (!confessionData || !confessionData.enabled || !confessionData.settings.allowReplies) {
    return interaction.editReply({ content: '**Notice:** Replies are not enabled in this server, Master.' });
  }

  if (confessionData.settings.bannedUsers.includes(interaction.user.id)) {
    return interaction.editReply({ content: '**Notice:** You have been barred from the confession system, Master.' });
  }

  const confession = confessionData.confessions.find(c => c.number === parseInt(confessionNumber, 10));
  if (!confession) {
    return interaction.editReply({ content: '**Notice:** The original confession could not be found, Master.' });
  }

  const channel = interaction.guild.channels.cache.get(confessionData.channelId);
  if (!channel?.isTextBased()) {
    return interaction.editReply({ content: '**Notice:** The confession channel no longer exists, Master.' });
  }

  // Replies get their own number
  confessionData.confessionCount++;
  const replyNumber = confessionData.confessionCount;

  const replyEmbed = new EmbedBuilder()
    .setAuthor({ name: `Anonymous Reply (#${replyNumber})` })
    .setDescription(`"${replyContent}"`)
    .setColor(COLORS.RAPHAEL)
    .setTimestamp();

  const replyRow = new ActionRowBuilder().addComponents(replyButton(confessionNumber));

  // Post the reply in the confession's thread
  let thread = null;
  try {
    if (confession.threadId) {
      thread = await channel.threads.fetch(confession.threadId).catch(() => null);
    }

    if (!thread) {
      // Thread doesn't exist or was archived, try to create from original message
      const originalMessage = await channel.messages.fetch(confession.messageId).catch(() => null);
      if (originalMessage) {
        thread = await originalMessage.startThread({
          name: `Confession #${confessionNumber} Replies`,
          autoArchiveDuration: 1440
        }).catch(() => null);
        if (thread) {
          confession.threadId = thread.id;
        }
      }
    }

    if (thread) {
      // Remove Reply button from the previous reply in this thread
      if (confession.lastReplyMessageId) {
        const prevReply = await thread.messages.fetch(confession.lastReplyMessageId).catch(() => null);
        if (prevReply) await prevReply.edit({ components: [] }).catch(() => { });
      }

      const sentReplyMessage = await thread.send({ embeds: [replyEmbed], components: [replyRow] });
      confession.lastReplyMessageId = sentReplyMessage.id;
    } else {
      // Fallback: send to channel as a message if thread creation fails
      await channel.send({ embeds: [replyEmbed], components: [replyRow] });
    }
  } catch (error) {
    console.error('[confessionHandler] Failed to post reply in thread:', error);
    await channel.send({ embeds: [replyEmbed], components: [replyRow] });
  }

  confessionData.confessions.push({
    number: replyNumber,
    content: replyContent,
    messageId: null, // Reply is in thread
    threadId: confession.threadId,
    userId: interaction.user.id,
    replyTo: parseInt(confessionNumber, 10),
    timestamp: new Date()
  });
  await confessionData.save();

  return interaction.editReply({
    content: `**Confirmed:** Your anonymous reply (#${replyNumber}) to confession #${confessionNumber} has been posted, Master.`
  });
}
