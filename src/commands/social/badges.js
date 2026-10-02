import { EmbedBuilder } from 'discord.js';
import Social from '../../models/Social.js';
import { errorEmbed, infoEmbed, COLORS } from '../../utils/embeds.js';
import { getRandomFooter } from '../../utils/raphael.js';

// Discord's embed description limit
const MAX_DESCRIPTION = 4096;
const LOCKED_PREVIEW_COUNT = 5;

export default {
  name: 'badges',
  description: 'Display achievement records for a user, Master',
  usage: '[@user]',
  aliases: ['mybadges', 'achievements'],
  category: 'social',
  cooldown: 5,

  async execute(message, args, client) {
    const guildId = message.guild.id;
    const targetUser = message.mentions.users.first() || message.author;
    const isSelf = targetUser.id === message.author.id;

    try {
      // Read-only: viewing badges never creates a social profile
      const social = await Social.findOne({ odId: targetUser.id, guildId }).lean();
      const badges = social?.badges || [];

      if (badges.length === 0) {
        return message.reply({
          embeds: [await infoEmbed(guildId, 'No Achievements', isSelf
            ? '**Notice:** No achievements detected in your profile, Master.\n\nAchievements are earned through activity, bonds, and progression.'
            : `**Notice:** **${targetUser.username}** has not acquired any achievements yet.`)]
        });
      }

      // Badge emoji are stored data, not shown: each entry uses a glyph instead
      const entries = badges.map(b => {
        const earned = b.earnedAt ? `<t:${Math.floor(new Date(b.earnedAt).getTime() / 1000)}:D>` : 'Unknown date';
        return `◈ **${b.name}**\n› *${b.description || 'No description recorded'}* (${earned})`;
      });

      const shown = [];
      let length = 0;
      for (const entry of entries) {
        if (length + entry.length + 2 > MAX_DESCRIPTION - 40) break;
        shown.push(entry);
        length += entry.length + 2;
      }
      const hidden = entries.length - shown.length;

      const embed = new EmbedBuilder()
        .setColor(COLORS.RAPHAEL)
        .setTitle(`『 ${targetUser.username}'s Achievements 』`)
        .setThumbnail(targetUser.displayAvatarURL())
        .setDescription(shown.join('\n\n') + (hidden > 0 ? `\n\n*...and ${hidden} more*` : ''))
        .setFooter({ text: `${getRandomFooter()} | ${badges.length} achievement${badges.length !== 1 ? 's' : ''} acquired` });

      // Show available badges they don't have
      if (isSelf) {
        const lockedBadges = Object.values(Social.BADGES)
          .filter(b => !badges.some(earned => earned.id === b.id))
          .slice(0, LOCKED_PREVIEW_COUNT)
          .map(b => b.name)
          .join(' • ');

        if (lockedBadges) {
          embed.addFields({
            name: '◈ Locked Achievements',
            value: lockedBadges
          });
        }
      }

      await message.reply({ embeds: [embed] });

    } catch (error) {
      console.error('[Badges] Error:', error);
      return message.reply({
        embeds: [await errorEmbed(guildId, 'Retrieval Error', 'An anomaly occurred while retrieving achievement data, Master.')]
      }).catch(() => {});
    }
  }
};
