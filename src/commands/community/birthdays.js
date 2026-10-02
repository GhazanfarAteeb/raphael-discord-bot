import Birthday from '../../models/Birthday.js';
import { infoEmbed, errorEmbed, GLYPHS } from '../../utils/embeds.js';
import { getPrefix } from '../../utils/helpers.js';
import { MONTH_NAMES } from './requestbirthday.js';

const MAX_FIELDS = 25;
const FIELD_VALUE_LIMIT = 1024;
// Discord rejects embeds over 6000 characters in total; leave room for the footer
const EMBED_TEXT_BUDGET = 5800;
const MEMBER_FETCH_CHUNK = 100;

// Look members up from the cache, then fetch the rest in batches instead of one request per birthday
async function fetchMembers(guild, userIds) {
  const members = new Map();
  const missing = [];

  for (const id of userIds) {
    const cached = guild.members.cache.get(id);
    if (cached) members.set(id, cached);
    else missing.push(id);
  }

  for (let i = 0; i < missing.length; i += MEMBER_FETCH_CHUNK) {
    const fetched = await guild.members.fetch({ user: missing.slice(i, i + MEMBER_FETCH_CHUNK) }).catch(() => null);
    fetched?.forEach(member => members.set(member.id, member));
  }

  return members;
}

// Join lines into one field value, replacing whatever does not fit with "+N more"
function joinWithinLimit(lines, limit = FIELD_VALUE_LIMIT) {
  let value = '';
  for (let i = 0; i < lines.length; i++) {
    const remaining = lines.length - i;
    const next = (value ? '\n' : '') + lines[i];
    const suffix = remaining > 1 ? `\n+${remaining - 1} more` : '';
    if ((value + next + suffix).length > limit) {
      return `${value}\n+${remaining} more`.trim();
    }
    value += next;
  }
  return value;
}

export default {
  name: 'birthdays',
  aliases: ['listbirthdays', 'upcomingbirthdays'],
  description: 'View upcoming birthdays',
  usage: '[days]',
  category: 'community',
  execute: async (message, args) => {
    const guildId = message.guild.id;

    try {
      const days = args[0] ? parseInt(args[0], 10) : 30;

      if (isNaN(days) || days < 1 || days > 365) {
        const prefix = await getPrefix(guildId);
        return message.reply({
          embeds: [await errorEmbed(guildId, 'Invalid Range',
            `Please provide a number of days from 1 to 365, Master.\n\n**Usage:** \`${prefix}birthdays [days]\``)]
        });
      }

      const upcoming = await Birthday.getUpcomingBirthdays(guildId, days);
      const members = await fetchMembers(message.guild, [...new Set(upcoming.map(item => item.birthday.userId))]);

      // Group by how many days away the birthday is (already sorted soonest first)
      const groups = new Map();
      for (const item of upcoming) {
        const member = members.get(item.birthday.userId);
        if (!member) continue;

        let line = `${member}`;
        if (item.birthday.showAge && item.birthday.birthday.year) {
          const age = item.birthday.getAge();
          if (age !== null) {
            // getAge() already counts a birthday that is today
            line += ` • Turning ${item.daysUntil === 0 ? age : age + 1}`;
          }
        }

        if (!groups.has(item.daysUntil)) {
          groups.set(item.daysUntil, { month: item.birthday.birthday.month, day: item.birthday.birthday.day, lines: [] });
        }
        groups.get(item.daysUntil).lines.push(line);
      }

      if (groups.size === 0) {
        return message.reply({
          embeds: [await infoEmbed(guildId, 'No Upcoming Birthdays', `No birthdays in the next ${days} days, Master.`)]
        });
      }

      const embed = await infoEmbed(guildId, 'Upcoming Birthdays', `Birthdays in the next ${days} days, Master.`);
      let used = (embed.data.title?.length || 0) + (embed.data.description?.length || 0) + (embed.data.footer?.text?.length || 0);
      let shownDates = 0;

      for (const [daysUntil, group] of groups) {
        const when = daysUntil === 0 ? 'Today' : `in ${daysUntil} day${daysUntil === 1 ? '' : 's'}`;
        const name = `${GLYPHS.CALENDAR} ${MONTH_NAMES[group.month - 1]} ${group.day} (${when})`;
        const value = joinWithinLimit(group.lines);

        if (shownDates >= MAX_FIELDS || used + name.length + value.length > EMBED_TEXT_BUDGET) break;

        embed.addFields({ name, value, inline: false });
        used += name.length + value.length;
        shownDates++;
      }

      if (shownDates < groups.size) {
        const hidden = groups.size - shownDates;
        embed.setFooter({ text: `+${hidden} more date${hidden === 1 ? '' : 's'} not shown. Try a shorter range.` });
      }

      return message.reply({ embeds: [embed] });

    } catch (error) {
      console.error('[birthdays] Error:', error);
      return message.reply({
        embeds: [await errorEmbed(guildId, 'Operation Failed', 'I was unable to fetch the birthdays. Please try again, Master.')]
      });
    }
  }
};
