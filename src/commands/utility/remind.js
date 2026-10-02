import Reminder from '../../models/Reminder.js';
import { successEmbed, errorEmbed, infoEmbed, GLYPHS } from '../../utils/embeds.js';
import { getPrefix } from '../../utils/helpers.js';

const MIN_DURATION = 10 * 1000; // 10 seconds
const MAX_DURATION = 30 * 24 * 60 * 60 * 1000; // 30 days
const MAX_REMINDERS = 25; // per member, per server
const PREVIEW_LENGTH = 50;
const MAX_MESSAGE_DISPLAY = 3500;
const EMBED_DESCRIPTION_LIMIT = 4096;
const DELETE_ACTIONS = ['delete', 'remove', 'cancel'];

export default {
  name: 'remind',
  category: 'utility',
  description: 'Configure temporal alerts for future notification, Master',
  usage: '<time> <message> | list | delete <number>',
  aliases: ['reminder', 'remindme', 'setreminder'],
  cooldown: 5,

  async execute(message, args) {
    try {
      if (!args[0]) {
        return await showHelp(message);
      }

      const action = args[0].toLowerCase();

      if (action === 'list') {
        return await listReminders(message);
      }

      if (DELETE_ACTIONS.includes(action)) {
        return await deleteReminder(message, args[1]);
      }

      // Otherwise, create a reminder
      return await createReminder(message, args);
    } catch (error) {
      console.error('[Remind] Command error:', error);
      try {
        await message.reply({
          embeds: [await errorEmbed(message.guild.id, 'Temporal Alert Failure',
            'The temporal alert system encountered an unexpected error, Master. Please try again shortly.')]
        });
      } catch {
        // Reply failed as well (message deleted or database unavailable)
      }
    }
  }
};

async function showHelp(message) {
  const prefix = await getPrefix(message.guild.id);
  const embed = await infoEmbed(message.guild.id, 'Temporal Alert Protocol',
    `**Create a reminder:**\n` +
    `\`${prefix}remind <time> <message>\`\n` +
    `Example: \`${prefix}remind 2h check the oven\`\n\n` +
    `**List your reminders in this server:**\n` +
    `\`${prefix}remind list\`\n\n` +
    `**Delete a reminder:**\n` +
    `\`${prefix}remind delete <number>\`\n\n` +
    `**Time formats:**\n` +
    `${GLYPHS.DOT} \`s\` - seconds (30s)\n` +
    `${GLYPHS.DOT} \`m\` - minutes (10m)\n` +
    `${GLYPHS.DOT} \`h\` - hours (2h)\n` +
    `${GLYPHS.DOT} \`d\` - days (1d)\n` +
    `${GLYPHS.DOT} \`w\` - weeks (1w)\n\n` +
    `**Combined formats:**\n` +
    `\`1h30m\` - 1 hour 30 minutes\n` +
    `\`2d12h\` - 2 days 12 hours`
  );
  return message.reply({ embeds: [embed] });
}

async function createReminder(message, args) {
  const guildId = message.guild.id;
  const timeStr = args[0];
  const duration = parseDuration(timeStr);

  if (!duration || duration < MIN_DURATION) {
    return message.reply({
      embeds: [await errorEmbed(guildId, 'Invalid Time',
        '**Notice:** Invalid temporal format detected, Master. Valid formats: 10m, 2h, 1d. Minimum duration: 10 seconds.')]
    });
  }

  if (duration > MAX_DURATION) {
    return message.reply({
      embeds: [await errorEmbed(guildId, 'Time Too Long',
        '**Notice:** Maximum temporal range is 30 days, Master.')]
    });
  }

  const reminderMessage = args.slice(1).join(' ') || 'No message specified';
  const remindAt = new Date(Date.now() + duration);

  // Check the member's reminder count in this server
  const userReminders = await Reminder.getUserReminders(message.author.id, guildId);
  if (userReminders.length >= MAX_REMINDERS) {
    return message.reply({
      embeds: [await errorEmbed(guildId, 'Reminder Limit',
        `**Notice:** Maximum reminder capacity (${MAX_REMINDERS}) reached in this server, Master. Remove existing entries with \`remind delete <number>\`.`)]
    });
  }

  // Create reminder
  await Reminder.createReminder({
    guildId,
    channelId: message.channel.id,
    userId: message.author.id,
    message: reminderMessage,
    remindAt
  });

  const embed = await successEmbed(guildId, 'Temporal Alert Scheduled',
    truncate(
      `${GLYPHS.SUCCESS} **Confirmed:** Alert scheduled for <t:${Math.floor(remindAt.getTime() / 1000)}:R>, Master.\n\n` +
      `**Message:** ${truncate(reminderMessage, MAX_MESSAGE_DISPLAY)}`,
      EMBED_DESCRIPTION_LIMIT
    )
  );

  return message.reply({ embeds: [embed] });
}

async function listReminders(message) {
  const guildId = message.guild.id;
  const reminders = await Reminder.getUserReminders(message.author.id, guildId);

  if (reminders.length === 0) {
    return message.reply({
      embeds: [await infoEmbed(guildId, 'Temporal Alerts',
        '**Notice:** No active temporal alerts detected in your registry for this server, Master.')]
    });
  }

  const reminderList = reminders.map((r, i) =>
    `**${i + 1}.** ${preview(r.message)}\n` +
    `   ${GLYPHS.DOT} Reminds: <t:${Math.floor(r.remindAt.getTime() / 1000)}:R>`
  ).join('\n\n');

  const embed = await infoEmbed(guildId, 'Temporal Alerts',
    truncate(`${reminderList}\n\nUse \`remind delete <number>\` to remove a reminder.`, EMBED_DESCRIPTION_LIMIT)
  );

  return message.reply({ embeds: [embed] });
}

/**
 * Delete by list number (as shown by `remind list`) or by reminder ID.
 * Either way only the author's own pending reminders in this server can be touched.
 */
async function deleteReminder(message, target) {
  const guildId = message.guild.id;
  const userId = message.author.id;

  if (!target) {
    return message.reply({
      embeds: [await errorEmbed(guildId, 'Missing Number',
        '**Notice:** Specify which reminder to delete, Master: `remind delete <number>`. Use `remind list` to view the numbers.')]
    });
  }

  let removed = null;

  if (/^[a-f\d]{24}$/i.test(target)) {
    removed = await Reminder.deleteUserReminder(userId, guildId, target);
  } else {
    const reminders = await Reminder.getUserReminders(userId, guildId);

    if (reminders.length === 0) {
      return message.reply({
        embeds: [await infoEmbed(guildId, 'No Reminders',
          '**Notice:** You have no active reminders in this server to delete, Master.')]
      });
    }

    const index = /^\d+$/.test(target) ? Number.parseInt(target, 10) - 1 : -1;
    if (index < 0 || index >= reminders.length) {
      return message.reply({
        embeds: [await errorEmbed(guildId, 'Invalid Number',
          `**Notice:** Please provide a number between 1 and ${reminders.length}, Master.`)]
      });
    }

    removed = await Reminder.deleteUserReminder(userId, guildId, reminders[index]._id);
  }

  if (!removed) {
    return message.reply({
      embeds: [await errorEmbed(guildId, 'Reminder Not Found',
        '**Notice:** That reminder no longer exists in your registry for this server, Master. It may have already been delivered.')]
    });
  }

  return message.reply({
    embeds: [await successEmbed(guildId, 'Reminder Deleted',
      `${GLYPHS.SUCCESS} Deleted reminder: "${preview(removed.message)}"`)]
  });
}

// Single-line preview of a reminder message
function preview(text) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  return value.length > PREVIEW_LENGTH ? `${value.slice(0, PREVIEW_LENGTH)}...` : value;
}

function truncate(text, max) {
  const value = String(text ?? '');
  return value.length > max ? `${value.slice(0, max - 3)}...` : value;
}

// Helper function to parse duration (supports combined formats like 1h30m)
function parseDuration(str) {
  const regex = /(\d+)(s|m|h|d|w)/gi;
  let match;
  let totalMs = 0;

  const multipliers = {
    s: 1000,
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
    w: 7 * 24 * 60 * 60 * 1000
  };

  while ((match = regex.exec(str)) !== null) {
    const value = parseInt(match[1]);
    const unit = match[2].toLowerCase();
    totalMs += value * multipliers[unit];
  }

  return totalMs > 0 ? totalMs : null;
}
