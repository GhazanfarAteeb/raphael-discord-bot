import { EmbedBuilder } from 'discord.js';
import Economy from '../../models/Economy.js';
import Guild from '../../models/Guild.js';
import { getBackground } from '../../utils/shopItems.js';
import { errorEmbed, COLORS } from '../../utils/embeds.js';
import { getPrefix } from '../../utils/helpers.js';
import { getRandomFooter } from '../../utils/raphael.js';

export default {
  name: 'setbackground',
  description: 'Set your profile background',
  usage: 'setbackground <background_name/id>',
  category: 'economy',
  aliases: ['setbg', 'background', 'bg'],
  cooldown: 3,

  execute: async (message, args) => {
    const userId = message.author.id;
    const guildId = message.guild.id;

    try {
      const prefix = await getPrefix(guildId);

      if (!args[0]) {
        return message.reply({
          embeds: [await errorEmbed(guildId, 'Background Required',
            `Please specify a background, Master. Use \`${prefix}inventory backgrounds\` to view the ones you own.`)]
        });
      }

      const economy = await Economy.getEconomy(userId, guildId);

      const bgQuery = args.join(' ').toLowerCase();

      // Find background in inventory
      const ownedBg = economy.inventory.backgrounds.find(bg =>
        bg.id?.toLowerCase() === bgQuery || bg.name?.toLowerCase() === bgQuery
      );

      if (!ownedBg) {
        return message.reply({
          embeds: [await errorEmbed(guildId, 'Background Not Owned',
            `You do not own this background, Master. Use \`${prefix}inventory backgrounds\` to view your collection or \`${prefix}shop\` to acquire new ones.`)]
        });
      }

      // Preview image: built-in backgrounds first, then the server's shop items
      const guildConfig = await Guild.getGuild(guildId);
      const shopItem = (guildConfig.customShopItems || []).find(item => item.id === ownedBg.id);
      const imageUrl = getBackground(ownedBg.id)?.image || shopItem?.image || null;

      // Set background
      economy.profile.background = ownedBg.id;
      await economy.save();

      const embed = new EmbedBuilder()
        .setColor(COLORS.RAPHAEL_SUCCESS)
        .setTitle('『 Background Updated 』')
        .setDescription(`**Confirmed:** Profile background set to **${ownedBg.name}**, Master.`)
        .setImage(imageUrl)
        .setFooter({ text: `${getRandomFooter()} | Use ${prefix}profile to preview changes` })
        .setTimestamp();

      await message.reply({ embeds: [embed] });

    } catch (error) {
      console.error('[SetBackground] Error:', error);
      return message.reply({
        embeds: [await errorEmbed(guildId, 'Background Error', 'An anomaly occurred while setting your background, Master.')]
      }).catch(() => {});
    }
  }
};
