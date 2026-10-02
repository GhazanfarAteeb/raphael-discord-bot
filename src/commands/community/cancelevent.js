import mongoose from 'mongoose';
import Event from '../../models/Event.js';
import { successEmbed, errorEmbed, warningEmbed } from '../../utils/embeds.js';
import { hasPermission, getPrefix, chunkArray } from '../../utils/helpers.js';

// Discord allows at most 100 users in allowedMentions per message; 50 mentions also stay far below 2000 characters
const MENTIONS_PER_MESSAGE = 50;

export default {
  name: 'cancelevent',
  aliases: ['deleteevent', 'removeevent'],
  description: 'Cancel a scheduled event',
  usage: '<event_id>',
  category: 'community',
  permissions: ['ManageGuild'],
  execute: async (message, args) => {
    const guildId = message.guild.id;

    try {
      const prefix = await getPrefix(guildId);

      if (!hasPermission(message.member, 'ManageGuild')) {
        return message.reply({
          embeds: [await errorEmbed(guildId, 'Permission Denied', 'The **Manage Server** permission is required to cancel events, Master.')]
        });
      }

      const eventId = args[0];

      if (!eventId) {
        return message.reply({
          embeds: [await errorEmbed(guildId, 'Event ID Required',
            `Please provide an event ID, Master.\n\n**Usage:** \`${prefix}cancelevent <event_id>\`\n\nFind event IDs with \`${prefix}events\`.`)]
        });
      }

      if (!mongoose.isValidObjectId(eventId)) {
        return message.reply({
          embeds: [await errorEmbed(guildId, 'Invalid Event ID',
            `\`${eventId.slice(0, 40)}\` is not a valid event ID, Master. Find event IDs with \`${prefix}events\`.`)]
        });
      }

      const event = await Event.findOne({ _id: eventId, guildId });

      if (!event) {
        return message.reply({
          embeds: [await errorEmbed(guildId, 'Event Not Found', 'No event matches that ID, Master.')]
        });
      }

      const eventTitle = event.title;
      const participantIds = [...new Set(event.participants.map(p => p.userId))];
      let notified = 0;

      // Notify participants in batches so a long list never exceeds Discord's message limits
      if (participantIds.length > 0 && event.notificationChannel) {
        const channel = message.guild.channels.cache.get(event.notificationChannel);
        if (channel?.isTextBased()) {
          const notice = await warningEmbed(guildId, 'Event Cancelled', `The event **${eventTitle}** has been cancelled.`);
          const batches = chunkArray(participantIds, MENTIONS_PER_MESSAGE);

          for (let i = 0; i < batches.length; i++) {
            const batch = batches[i];
            const sent = await channel.send({
              content: batch.map(id => `<@${id}>`).join(' '),
              embeds: i === 0 ? [notice] : [],
              allowedMentions: { users: batch }
            }).catch(() => null);
            if (sent) notified += batch.length;
          }
        }
      }

      await Event.deleteOne({ _id: event._id, guildId });

      let description = `**${eventTitle}** has been cancelled, Master.`;
      if (participantIds.length > 0) {
        description += notified === participantIds.length
          ? `\n\n${notified} participant${notified !== 1 ? 's have' : ' has'} been notified.`
          : `\n\n${notified} of ${participantIds.length} participants could be notified.`;
      }

      return message.reply({ embeds: [await successEmbed(guildId, 'Event Cancelled', description)] });

    } catch (error) {
      console.error('[cancelevent] Error:', error);
      return message.reply({
        embeds: [await errorEmbed(guildId, 'Operation Failed', 'I was unable to cancel the event. Please try again, Master.')]
      });
    }
  }
};
