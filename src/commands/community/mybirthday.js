import { EmbedBuilder } from 'discord.js';
import Birthday, { nextBirthdayOccurrence } from '../../models/Birthday.js';
import { errorEmbed, infoEmbed, COLORS, GLYPHS } from '../../utils/embeds.js';
import { getPrefix, truncate } from '../../utils/helpers.js';
import { formatDate } from './requestbirthday.js';

const CELEBRATION_LABELS = {
  public: 'Public announcement',
  dm: 'Direct message only',
  role: 'Role assignment',
  none: 'No celebration'
};

export default {
  name: 'mybirthday',
  description: 'View your registered birthday',
  usage: '',
  aliases: ['mybday', 'checkbirthday', 'viewbirthday'],
  category: 'community',
  execute: async (message) => {
    const guildId = message.guild.id;
    const userId = message.author.id;

    try {
      const prefix = await getPrefix(guildId);
      const birthday = await Birthday.findOne({ guildId, userId });

      if (!birthday) {
        return message.reply({
          embeds: [await infoEmbed(guildId, 'No Birthday Set',
            'You do not have a birthday registered, Master.\n\n' +
            '**To register it:**\n' +
            `${GLYPHS.DOT} Submit a request with \`${prefix}requestbirthday <month> <day> [year]\`\n` +
            `${GLYPHS.DOT} Or ask a staff member to set it with \`${prefix}setbirthday\``)]
        });
      }

      const { month, day, year } = birthday.birthday;
      const { daysUntil } = nextBirthdayOccurrence(month, day);

      const embed = new EmbedBuilder()
        .setColor(COLORS.RAPHAEL)
        .setTitle('『 Your Birthday 』')
        .setDescription(`**Analysis:** Birthday record for ${message.author}, Master.`)
        .setThumbnail(message.author.displayAvatarURL({ dynamic: true, size: 256 }))
        .addFields(
          { name: '▸ Birthday', value: formatDate({ month, day, year }), inline: true },
          { name: '▸ Days Until', value: daysUntil === 0 ? '**Today**' : `${daysUntil} day${daysUntil === 1 ? '' : 's'}`, inline: true }
        );

      // Age info
      if (year && birthday.showAge) {
        const age = birthday.getAge();
        if (age !== null) {
          embed.addFields({ name: '▸ Age', value: daysUntil === 0 ? `${age} (today)` : `${age} (turning ${age + 1})`, inline: true });
        }
      } else if (year) {
        embed.addFields({ name: '▸ Age', value: 'Hidden', inline: true });
      }

      // Source info
      let sourceText = 'Self-set';
      if (birthday.source === 'staff') {
        const setter = birthday.setBy ? await message.client.users.fetch(birthday.setBy).catch(() => null) : null;
        sourceText = `Staff${setter ? ` (${setter.tag})` : ''}`;
      } else if (birthday.source === 'request') {
        sourceText = 'Approved request';
      }

      embed.addFields({ name: '▸ Source', value: sourceText, inline: true });

      if (birthday.verified) {
        embed.addFields({ name: '▸ Status', value: '◉ Verified', inline: true });
      }

      embed.addFields({
        name: '▸ Celebration',
        value: CELEBRATION_LABELS[birthday.celebrationPreference] || CELEBRATION_LABELS.public,
        inline: true
      });

      if (birthday.customMessage) {
        embed.addFields({ name: '▸ Custom Message', value: truncate(birthday.customMessage, 1024), inline: false });
      }

      // Members change their birthday through a request; birthdaypreference is an admin setting
      embed.setFooter({ text: `${prefix}requestbirthday to request a change • ${prefix}removebirthday to remove it` });

      return message.reply({ embeds: [embed] });

    } catch (error) {
      console.error('[mybirthday] Error:', error);
      return message.reply({
        embeds: [await errorEmbed(guildId, 'Operation Failed', 'I was unable to fetch your birthday. Please try again, Master.')]
      });
    }
  }
};
