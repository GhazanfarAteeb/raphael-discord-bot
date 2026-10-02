import mongoose from 'mongoose';
import Event from '../../models/Event.js';
import { successEmbed, errorEmbed } from '../../utils/embeds.js';
import { getPrefix } from '../../utils/helpers.js';

// Statuses of events that have not started yet ("notified" means the reminder already went out)
const JOINABLE_STATUSES = ['scheduled', 'notified'];

export default {
  name: 'joinevent',
  aliases: ['eventjoin', 'rsvp'],
  description: 'Join an event to get notified',
  usage: '<event_id>',
  category: 'community',
  execute: async (message, args) => {
    const guildId = message.guild.id;
    const userId = message.author.id;

    try {
      const prefix = await getPrefix(guildId);
      const eventId = args[0];

      if (!eventId) {
        return message.reply({
          embeds: [await errorEmbed(guildId, 'Event ID Required',
            `Please provide an event ID, Master.\n\n**Usage:** \`${prefix}joinevent <event_id>\`\n\nFind event IDs with \`${prefix}events\`.`)]
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

      if (!JOINABLE_STATUSES.includes(event.status)) {
        return message.reply({
          embeds: [await errorEmbed(guildId, 'Event Closed', 'This event is no longer accepting participants, Master.')]
        });
      }

      if (event.eventDate < new Date()) {
        return message.reply({
          embeds: [await errorEmbed(guildId, 'Event Started', 'This event has already started, Master.')]
        });
      }

      if (event.participants.some(p => p.userId === userId)) {
        return message.reply({
          embeds: [await errorEmbed(guildId, 'Already Joined', 'You are already signed up for this event, Master.')]
        });
      }

      if (event.maxParticipants && event.participants.length >= event.maxParticipants) {
        return message.reply({
          embeds: [await errorEmbed(guildId, 'Event Full', 'This event has reached its participant limit, Master.')]
        });
      }

      // Atomic push guarded against double sign-ups from rapid repeats
      const updated = await Event.findOneAndUpdate(
        { _id: event._id, 'participants.userId': { $ne: userId } },
        { $push: { participants: { userId, username: message.author.username, joinedAt: new Date() } } },
        { new: true }
      );

      if (!updated) {
        return message.reply({
          embeds: [await errorEmbed(guildId, 'Already Joined', 'You are already signed up for this event, Master.')]
        });
      }

      const unix = Math.floor(updated.eventDate.getTime() / 1000);
      const count = updated.participants.length;
      const embed = await successEmbed(guildId, 'Event Joined', `You have been added to **${updated.title}**, Master.`);

      embed.addFields(
        { name: '▸ When', value: `<t:${unix}:F> (<t:${unix}:R>)`, inline: false },
        { name: '▸ Participants', value: `${count} member${count !== 1 ? 's' : ''}`, inline: true }
      );

      return message.reply({ embeds: [embed] });

    } catch (error) {
      console.error('[joinevent] Error:', error);
      return message.reply({
        embeds: [await errorEmbed(guildId, 'Operation Failed', 'I was unable to add you to the event. Please try again, Master.')]
      });
    }
  }
};
