import { Events, EmbedBuilder } from 'discord.js';
import Guild from '../../models/Guild.js';
import { COLORS, GLYPHS } from '../../utils/embeds.js';
import { truncate } from '../../utils/helpers.js';

const FIELD_VALUE_MAX = 1024;
const DESCRIPTION_MAX = 4000;
// Code block fences around the inline bulk-delete transcript
const CODE_BLOCK_OVERHEAD = 8;
const NOT_CACHED = '*Unavailable (the message was not cached)*';

export default {
  name: 'messageLogging',

  async initialize(client) {
    // Message Delete
    client.on(Events.MessageDelete, async (message) => {
      if (!message.guild || message.author?.bot) return;

      await logMessageDelete(message);
    });

    // Message Update (Edit)
    client.on(Events.MessageUpdate, async (oldMessage, newMessage) => {
      if (!newMessage.guild || newMessage.author?.bot) return;
      if (oldMessage.content === newMessage.content) return; // Embed updates, etc.
      // An uncached message has no old content to compare; only a real edit sets editedTimestamp
      if (oldMessage.partial && !newMessage.editedTimestamp) return;

      await logMessageEdit(oldMessage, newMessage);
    });

    // Bulk Message Delete
    client.on(Events.MessageBulkDelete, async (messages, channel) => {
      await logBulkDelete(messages, channel);
    });

    console.log('[RAPHAEL] Message logging initialized');
  }
};

// The configured message log channel, or null
async function getMessageLogChannel(guild) {
  const guildConfig = await Guild.getGuild(guild.id, guild.name);
  const logChannelId = guildConfig?.channels?.messageLog;
  return logChannelId ? guild.channels.cache.get(logChannelId) ?? null : null;
}

function field(name, value, inline = true) {
  return { name: `${GLYPHS.ARROW_RIGHT} ${name}`, value, inline };
}

function describeAuthor(author) {
  return author ? `${author.tag} (${author.id})` : 'Unknown';
}

// Message text for a field or description; uncached messages have no content to show
function describeContent(message, limit) {
  if (message.partial && !message.content) return NOT_CACHED;
  return message.content ? truncate(message.content, limit) : '*No text content*';
}

// Keep message text from closing the transcript's code block
function escapeCodeBlock(text) {
  return text.replace(/```/g, '`​`​`');
}

async function logMessageDelete(message) {
  try {
    const logChannel = await getMessageLogChannel(message.guild);
    if (!logChannel) return;

    const embed = new EmbedBuilder()
      .setTitle('『 Message Deleted 』')
      .setColor(COLORS.RAPHAEL_ERROR)
      .setDescription(describeContent(message, DESCRIPTION_MAX))
      .addFields(
        field('Author', describeAuthor(message.author)),
        field('Channel', `<#${message.channelId}> (${message.channelId})`)
      )
      .setFooter({ text: `Message ID: ${message.id}` })
      .setTimestamp();

    // Add attachment info if any
    if (message.attachments?.size > 0) {
      const attachmentList = message.attachments.map(a => a.name).join(', ');
      embed.addFields(field('Attachments', truncate(attachmentList, FIELD_VALUE_MAX), false));
    }

    await logChannel.send({ embeds: [embed] });

  } catch (error) {
    console.error('[MessageLogging] Error logging message delete:', error);
  }
}

async function logMessageEdit(oldMessage, newMessage) {
  try {
    const logChannel = await getMessageLogChannel(newMessage.guild);
    if (!logChannel) return;

    const embed = new EmbedBuilder()
      .setTitle('『 Message Edited 』')
      .setColor(COLORS.RAPHAEL_WARNING)
      .addFields(
        field('Before', describeContent(oldMessage, FIELD_VALUE_MAX), false),
        field('After', describeContent(newMessage, FIELD_VALUE_MAX), false),
        field('Author', describeAuthor(newMessage.author)),
        field('Channel', `<#${newMessage.channelId}> (${newMessage.channelId})`),
        field('Jump to Message', `[Open message](${newMessage.url})`)
      )
      .setFooter({ text: `Message ID: ${newMessage.id}` })
      .setTimestamp();

    await logChannel.send({ embeds: [embed] });

  } catch (error) {
    console.error('[MessageLogging] Error logging message edit:', error);
  }
}

async function logBulkDelete(messages, channel) {
  try {
    if (!channel.guild) return;

    const logChannel = await getMessageLogChannel(channel.guild);
    if (!logChannel) return;

    // Oldest first
    const messageLog = [...messages.values()]
      .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
      .map(msg => {
        const content = msg.content || (msg.partial ? '[not cached]' : '[no text content]');
        return `[${msg.createdAt.toISOString()}] ${describeAuthor(msg.author)}: ${content}`;
      })
      .join('\n');

    const embed = new EmbedBuilder()
      .setTitle('『 Bulk Message Delete 』')
      .setColor(COLORS.RAPHAEL_ERROR)
      .setDescription(`${GLYPHS.ARROW_RIGHT} **${messages.size}** messages were deleted in ${channel}.`)
      .addFields(
        field('Channel', `${channel} (${channel.id})`)
      )
      .setTimestamp();

    const inline = escapeCodeBlock(messageLog);

    // Small enough to show in full inside the embed; otherwise attach the whole transcript
    if (inline.length + CODE_BLOCK_OVERHEAD <= FIELD_VALUE_MAX) {
      embed.addFields(field('Messages', `\`\`\`\n${inline}\n\`\`\``, false));
      await logChannel.send({ embeds: [embed] });
    } else {
      embed.addFields(field('Messages', 'The full transcript is attached.', false));
      await logChannel.send({
        embeds: [embed],
        files: [{
          attachment: Buffer.from(messageLog, 'utf-8'),
          name: `deleted_messages_${Date.now()}.txt`
        }]
      });
    }

  } catch (error) {
    console.error('[MessageLogging] Error logging bulk delete:', error);
  }
}
