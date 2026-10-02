import Event from '../../models/Event.js';
import { successEmbed, errorEmbed, GLYPHS } from '../../utils/embeds.js';
import { parseDuration, hasPermission, getPrefix } from '../../utils/helpers.js';

const MIN_LEAD_MS = 60 * 1000; // 1 minute
const MAX_LEAD_MS = 365 * 24 * 60 * 60 * 1000; // 1 year
const MAX_TITLE_LENGTH = 200;
const MAX_DESCRIPTION_LENGTH = 1000;
const NOTIFY_BEFORE_MINUTES = 15;

export default {
  name: 'createevent',
  aliases: ['addevent', 'newevent'],
  description: 'Create a server event with notifications',
  usage: '<time> | <title> | [description]',
  category: 'community',
  permissions: ['ManageGuild'],
  cooldown: 10,
  execute: async (message, args) => {
    const guildId = message.guild.id;

    try {
      const prefix = await getPrefix(guildId);

      if (!hasPermission(message.member, 'ManageGuild')) {
        return message.reply({
          embeds: [await errorEmbed(guildId, 'Permission Denied', 'The **Manage Server** permission is required to create events, Master.')]
        });
      }

      const usage = `**Usage:** \`${prefix}createevent <time> | <title> | [description]\`\n\n` +
        '**Examples:**\n' +
        `${GLYPHS.DOT} \`${prefix}createevent 2h | Movie Night | Join us in VC!\`\n` +
        `${GLYPHS.DOT} \`${prefix}createevent 1d12h | Tournament | Registration required\`\n` +
        `${GLYPHS.DOT} \`${prefix}createevent 30m | Quick Meeting\``;

      if (args.length === 0) {
        return message.reply({
          embeds: [await errorEmbed(guildId, 'Missing Parameters', `Please provide the event details, Master.\n\n${usage}`)]
        });
      }

      const [timeStr, title, ...rest] = args.join(' ').split('|').map(p => p.trim());
      // Any further "|" belongs to the description
      const description = rest.join(' | ').trim() || null;

      if (!title) {
        return message.reply({
          embeds: [await errorEmbed(guildId, 'Invalid Format', `Separate the time, title and description with \`|\`, Master.\n\n${usage}`)]
        });
      }

      const duration = parseDuration(timeStr);
      if (!duration || duration < MIN_LEAD_MS) {
        return message.reply({
          embeds: [await errorEmbed(guildId, 'Invalid Time', 'Use a format such as `30m`, `2h` or `1d12h`. The minimum is 1 minute, Master.')]
        });
      }

      if (duration > MAX_LEAD_MS) {
        return message.reply({
          embeds: [await errorEmbed(guildId, 'Invalid Time', 'An event cannot be scheduled more than 1 year ahead, Master.')]
        });
      }

      // Validate lengths before saving, so an oversized event is never stored
      if (title.length > MAX_TITLE_LENGTH) {
        return message.reply({
          embeds: [await errorEmbed(guildId, 'Title Too Long',
            `The title may be at most ${MAX_TITLE_LENGTH} characters (yours is ${title.length}), Master.`)]
        });
      }

      if (description && description.length > MAX_DESCRIPTION_LENGTH) {
        return message.reply({
          embeds: [await errorEmbed(guildId, 'Description Too Long',
            `The description may be at most ${MAX_DESCRIPTION_LENGTH} characters (yours is ${description.length}), Master.`)]
        });
      }

      const eventDate = new Date(Date.now() + duration);
      const unix = Math.floor(eventDate.getTime() / 1000);

      const event = await Event.create({
        guildId,
        title,
        description,
        eventDate,
        creatorId: message.author.id,
        creatorTag: message.author.tag,
        notificationChannel: message.channel.id,
        notifyBefore: NOTIFY_BEFORE_MINUTES
      });

      const embed = await successEmbed(guildId, 'Event Created', `**${title}** has been scheduled, Master.`);

      embed.addFields({ name: '▸ When', value: `<t:${unix}:F> (<t:${unix}:R>)`, inline: false });

      if (description) {
        embed.addFields({ name: '▸ Description', value: description, inline: false });
      }

      embed.addFields(
        { name: '▸ Event ID', value: `\`${event._id.toString()}\``, inline: true },
        { name: '▸ Notification', value: `${NOTIFY_BEFORE_MINUTES} minutes before`, inline: true }
      );

      embed.setFooter({ text: `Members can join with ${prefix}joinevent <ID>` });

      return message.reply({ embeds: [embed] });

    } catch (error) {
      console.error('[createevent] Error:', error);
      return message.reply({
        embeds: [await errorEmbed(guildId, 'Operation Failed', 'I was unable to create the event. Please try again, Master.')]
      });
    }
  }
};
