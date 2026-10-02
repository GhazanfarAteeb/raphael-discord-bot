import { EmbedBuilder } from 'discord.js';
import Reminder from '../../models/Reminder.js';
import { createEmbed, COLORS, GLYPHS } from '../../utils/embeds.js';
import { getRandomFooter } from '../../utils/raphael.js';
import { safeDbOperation } from '../../utils/errorHandlers.js';

const EMBED_DESCRIPTION_LIMIT = 4096;
const FIELD_VALUE_LIMIT = 1024;

// Prevents overlapping runs when a check takes longer than the scheduler interval
let checkInProgress = false;

/**
 * Check and send due reminders
 * Should be called periodically (e.g., every 30 seconds)
 */
export async function checkReminders(client) {
  if (checkInProgress) return;
  checkInProgress = true;

  try {
    return await safeDbOperation(async () => {
      const dueReminders = await Reminder.getDueReminders();

      if (dueReminders.length > 0) {
        console.log(`[Reminders] Found ${dueReminders.length} due reminder(s)`);
      }

      for (const reminder of dueReminders) {
        try {
          // Claim before sending (marks it completed) so it is never delivered twice;
          // a failed delivery is not retried, to prevent spam
          const claimed = await Reminder.claimReminder(reminder._id);
          if (!claimed) continue;

          await deliverReminder(client, claimed);
        } catch (error) {
          console.error(`[Reminders] Error sending reminder ${reminder._id}:`, error);
        }
      }
    });
  } finally {
    checkInProgress = false;
  }
}

/**
 * Deliver a reminder in its original channel, falling back to a DM when the server,
 * channel or member is gone, or the bot can no longer post there
 */
async function deliverReminder(client, reminder) {
  const guild = client.guilds.cache.get(reminder.guildId) ?? null;
  const embed = await buildReminderEmbed(reminder, guild);

  if (guild) {
    const channel = await client.channels.fetch(reminder.channelId).catch(() => null);
    const member = await guild.members.fetch(reminder.userId).catch(() => null);

    if (channel?.guildId === guild.id && channel.isTextBased() && member) {
      try {
        await channel.send({
          content: `<@${reminder.userId}>`,
          embeds: [embed],
          // Only the reminder owner is pinged, whatever the reminder text contains
          allowedMentions: { users: [reminder.userId] }
        });
        console.log(`[Reminders] Sent reminder ${reminder._id} in #${channel.name ?? reminder.channelId}`);
        return;
      } catch (channelError) {
        console.log(`[Reminders] Could not send reminder ${reminder._id} to channel ${reminder.channelId} (${channelError.code ?? channelError.message}), trying DM`);
      }
    } else {
      console.log(`[Reminders] Channel or member unavailable for reminder ${reminder._id}, trying DM`);
    }
  } else {
    console.log(`[Reminders] Guild ${reminder.guildId} not found for reminder ${reminder._id}, trying DM`);
  }

  // Fall back to DM
  const user = await client.users.fetch(reminder.userId).catch(() => null);
  if (!user) {
    console.log(`[Reminders] User ${reminder.userId} not found, reminder ${reminder._id} dropped`);
    return;
  }

  try {
    await user.send({ embeds: [embed] });
    console.log(`[Reminders] Sent reminder ${reminder._id} via DM to ${user.tag}`);
  } catch {
    console.log(`[Reminders] Could not DM user ${user.tag}, reminder ${reminder._id} dropped`);
  }
}

async function buildReminderEmbed(reminder, guild) {
  const plainEmbed = () => new EmbedBuilder()
    .setColor(COLORS.RAPHAEL)
    .setFooter({ text: getRandomFooter() })
    .setTimestamp();

  // Guild theme when the server is still available; never look up (and create) config for a server the bot left.
  // The reminder is already claimed, so a config lookup failure must not stop delivery.
  const embed = guild
    ? await createEmbed(guild.id, 'info').catch(() => plainEmbed())
    : plainEmbed();

  const intro = '**Master, the temporal alert you scheduled has come due.**\n\n>>> ';
  const createdAt = Math.floor(new Date(reminder.createdAt).getTime() / 1000);
  const origin = guild
    ? `${guild.name} ${GLYPHS.DOT} <#${reminder.channelId}>`
    : 'A server Raphael no longer has access to';

  return embed
    .setTitle('『 Temporal Alert 』')
    .setDescription(truncate(`${intro}${reminder.message || 'No message specified'}`, EMBED_DESCRIPTION_LIMIT))
    .addFields(
      { name: `${GLYPHS.ARROW_RIGHT} Scheduled`, value: `<t:${createdAt}:R>`, inline: true },
      { name: `${GLYPHS.ARROW_RIGHT} Origin`, value: truncate(origin, FIELD_VALUE_LIMIT), inline: true }
    );
}

function truncate(text, max) {
  const value = String(text ?? '');
  return value.length > max ? `${value.slice(0, max - 3)}...` : value;
}
