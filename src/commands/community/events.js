import Event from '../../models/Event.js';
import { infoEmbed, errorEmbed, GLYPHS } from '../../utils/embeds.js';
import { getPrefix, truncate } from '../../utils/helpers.js';

const MAX_EVENTS_FETCHED = 25;
const MAX_EVENTS_SHOWN = 10;
const DESCRIPTION_PREVIEW_LENGTH = 300;
const FIELD_NAME_LIMIT = 256;
const FIELD_VALUE_LIMIT = 1024;
// Discord rejects embeds over 6000 characters in total; leave room for the footer
const EMBED_TEXT_BUDGET = 5800;

export default {
  name: 'events',
  aliases: ['listevents', 'upcomingevents'],
  description: 'View upcoming server events',
  usage: '',
  category: 'community',
  execute: async (message) => {
    const guildId = message.guild.id;

    try {
      const prefix = await getPrefix(guildId);
      const events = await Event.getUpcomingEvents(guildId, MAX_EVENTS_FETCHED);

      if (events.length === 0) {
        return message.reply({
          embeds: [await infoEmbed(guildId, 'No Upcoming Events', 'There are no scheduled events at this time, Master.')]
        });
      }

      const embed = await infoEmbed(
        guildId,
        'Upcoming Events',
        `${events.length}${events.length === MAX_EVENTS_FETCHED ? '+' : ''} event${events.length !== 1 ? 's' : ''} scheduled, Master.`
      );

      let used = (embed.data.title?.length || 0) + (embed.data.description?.length || 0) + (embed.data.footer?.text?.length || 0);
      let shown = 0;

      for (const event of events) {
        if (shown >= MAX_EVENTS_SHOWN) break;

        const unix = Math.floor(event.eventDate.getTime() / 1000);
        let value = '';

        if (event.description) {
          value += `${truncate(event.description, DESCRIPTION_PREVIEW_LENGTH)}\n\n`;
        }

        value += `**When:** <t:${unix}:F> (<t:${unix}:R>)\n`;

        if (event.location) {
          const channel = message.guild.channels.cache.get(event.location);
          value += `**Location:** ${channel ? channel.toString() : truncate(event.location, 100)}\n`;
        }

        if (event.participants.length > 0) {
          value += `**Participants:** ${event.participants.length} member${event.participants.length !== 1 ? 's' : ''}\n`;
        }

        value += `**ID:** \`${event._id.toString()}\``;

        const name = truncate(`${GLYPHS.SPARKLE} ${event.title}`, FIELD_NAME_LIMIT);
        value = truncate(value, FIELD_VALUE_LIMIT);

        if (used + name.length + value.length > EMBED_TEXT_BUDGET) break;

        embed.addFields({ name, value, inline: false });
        used += name.length + value.length;
        shown++;
      }

      const footer = shown < events.length
        ? `Showing ${shown} of ${events.length}${events.length === MAX_EVENTS_FETCHED ? '+' : ''} events • ${prefix}joinevent <ID> to join`
        : `${prefix}joinevent <ID> to join an event`;
      embed.setFooter({ text: footer });

      return message.reply({ embeds: [embed] });

    } catch (error) {
      console.error('[events] Error:', error);
      return message.reply({
        embeds: [await errorEmbed(guildId, 'Operation Failed', 'I was unable to fetch the events. Please try again, Master.')]
      });
    }
  }
};
