import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType, MessageFlags } from 'discord.js';
import Economy from '../../models/Economy.js';
import Guild from '../../models/Guild.js';
import { errorEmbed, COLORS } from '../../utils/embeds.js';
import { getPrefix } from '../../utils/helpers.js';
import { getRandomFooter } from '../../utils/raphael.js';
import { getBackground } from '../../utils/shopItems.js';

// The inventory closes after this long without a button press
const IDLE_TIMEOUT = 120_000;
// Discord's embed description limit
const MAX_DESCRIPTION = 4096;

const relativeTime = (date) => (date ? `<t:${Math.floor(new Date(date).getTime() / 1000)}:R>` : 'Unknown');

// Joins entries until the description limit, noting how many were left out
function joinWithinLimit(entries, separator = '\n\n') {
  const shown = [];
  let length = 0;
  for (const entry of entries) {
    const remaining = entries.length - shown.length - 1;
    const reserve = remaining > 0 ? 40 : 0; // room for the "and N more" line
    if (length + separator.length + entry.length + reserve > MAX_DESCRIPTION) break;
    shown.push(entry);
    length += separator.length + entry.length;
  }
  const hidden = entries.length - shown.length;
  return shown.join(separator) + (hidden > 0 ? `${separator}*...and ${hidden} more*` : '');
}

export default {
  name: 'inventory',
  description: 'View your purchased items',
  usage: 'inventory [backgrounds/badges/items] [background]',
  category: 'economy',
  // setbg/bg open the backgrounds view: backgrounds are chosen with its Activate button
  aliases: ['inv', 'bag', 'items', 'backgrounds', 'bg', 'setbg', 'setbackground', 'background'],
  cooldown: 3,

  execute: async (message, args) => {
    const userId = message.author.id;
    const guildId = message.guild.id;

    try {
      const economy = await Economy.getEconomy(userId, guildId);
      const guildConfig = await Guild.getGuild(guildId);
      const prefix = await getPrefix(guildId);

      // Anything that isn't another category opens the backgrounds view, and is treated as
      // a background to jump to (e.g. "setbg sunset")
      const firstArg = args[0]?.toLowerCase();
      const category = firstArg === 'badges' || firstArg === 'items' ? firstArg : 'backgrounds';
      const jumpTo = ['backgrounds', 'background', 'bg'].includes(firstArg) ? args.slice(1).join(' ') : args.join(' ');
      const author = {
        name: `${message.author.tag}'s Inventory`,
        iconURL: message.author.displayAvatarURL()
      };

      if (category === 'backgrounds') {
        // The default background is always listed first so members can switch back to it
        const defaultBackground = {
          id: 'default',
          name: 'Default',
          image: getBackground('default')?.image || guildConfig.economy?.fallbackBackground?.image || ''
        };
        const ownedBackgrounds = [
          defaultBackground,
          ...economy.inventory.backgrounds.filter(bg => bg.id !== 'default')
        ];

        // Get shop items to find images
        const shopItems = guildConfig.customShopItems || [];

        let equippedId = economy.profile.background || 'default';
        const maxPages = ownedBackgrounds.length;

        // Open on the requested background, else the active one
        const query = jumpTo.trim().toLowerCase();
        const requested = query
          ? ownedBackgrounds.findIndex(bg => bg.id.toLowerCase() === query || bg.name.toLowerCase() === query)
          : -1;
        let currentPage = Math.max(0, requested >= 0 ? requested : ownedBackgrounds.findIndex(bg => bg.id === equippedId));

        const generateEmbed = (page) => {
          const bg = ownedBackgrounds[page];
          const isEquipped = equippedId === bg.id;

          // Find the image from shop items
          const shopItem = shopItems.find(item => item.id === bg.id);
          const imageUrl = shopItem?.image || bg.image || '';

          const embed = new EmbedBuilder()
            .setColor(COLORS.RAPHAEL)
            .setAuthor(author)
            .setTitle(`『 ${bg.name} 』`)
            .setDescription(isEquipped
              ? `This background is shown on your \`${prefix}profile\` and \`${prefix}level\` cards, Master.`
              : `Press **Activate** to show this background on your \`${prefix}profile\` and \`${prefix}level\` cards, Master.` +
                (maxPages === 1 ? `\nVisit \`${prefix}shop\` to acquire more backgrounds.` : ''))
            .addFields(
              { name: '▸ Status', value: isEquipped ? '◉ **ACTIVE**' : '◇ Inactive', inline: true },
              { name: '▸ Acquired', value: bg.id === 'default' ? 'Always available' : relativeTime(bg.purchasedAt), inline: true }
            )
            .setFooter({ text: `${getRandomFooter()} | Background ${page + 1} of ${maxPages}` })
            .setTimestamp();

          if (imageUrl) {
            embed.setImage(imageUrl);
          }

          return embed;
        };

        const generateButtons = (page, allDisabled = false) => {
          const bg = ownedBackgrounds[page];
          const isEquipped = equippedId === bg.id;

          return new ActionRowBuilder()
            .addComponents(
              new ButtonBuilder()
                .setCustomId('inventory_previous')
                .setLabel('‹ Previous')
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(allDisabled || page === 0),
              new ButtonBuilder()
                .setCustomId('inventory_equip')
                .setLabel(isEquipped ? '◉ Active' : 'Activate')
                .setStyle(isEquipped ? ButtonStyle.Secondary : ButtonStyle.Success)
                .setDisabled(allDisabled || isEquipped),
              new ButtonBuilder()
                .setCustomId('inventory_next')
                .setLabel('Next ›')
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(allDisabled || page === maxPages - 1)
            );
        };

        const invMessage = await message.reply({
          embeds: [generateEmbed(currentPage)],
          components: [generateButtons(currentPage)]
        });

        const collector = invMessage.createMessageComponentCollector({
          componentType: ComponentType.Button,
          idle: IDLE_TIMEOUT
        });

        collector.on('collect', async (interaction) => {
          try {
            if (interaction.user.id !== userId) {
              return await interaction.reply({
                content: `This inventory belongs to ${message.author.username}, Master. Use \`${prefix}inventory\` to view your own.`,
                flags: MessageFlags.Ephemeral
              });
            }

            if (interaction.customId === 'inventory_previous') {
              currentPage = Math.max(0, currentPage - 1);
            } else if (interaction.customId === 'inventory_next') {
              currentPage = Math.min(maxPages - 1, currentPage + 1);
            } else if (interaction.customId === 'inventory_equip') {
              const bg = ownedBackgrounds[currentPage];
              // Only equips a background the member still owns (the default needs no purchase)
              const filter = bg.id === 'default'
                ? { userId, guildId }
                : { userId, guildId, 'inventory.backgrounds.id': bg.id };
              const result = await Economy.updateOne(filter, { $set: { 'profile.background': bg.id } });
              if (result.matchedCount === 0) {
                return await interaction.reply({
                  content: 'That background is no longer in your inventory, Master.',
                  flags: MessageFlags.Ephemeral
                });
              }
              equippedId = bg.id;
            }

            await interaction.update({
              embeds: [generateEmbed(currentPage)],
              components: [generateButtons(currentPage)]
            });
          } catch (error) {
            console.error('[Inventory] Error handling button:', error);
            const reply = { embeds: [await errorEmbed(guildId, 'Inventory Error', 'That action could not be processed, Master. Please try again.')], flags: MessageFlags.Ephemeral };
            await (interaction.replied || interaction.deferred ? interaction.followUp(reply) : interaction.reply(reply)).catch(() => {});
          }
        });

        collector.on('end', () => {
          invMessage.edit({ components: [generateButtons(currentPage, true)] }).catch(() => { });
        });

      } else if (category === 'badges') {
        const badges = economy.inventory.badges;
        const embed = new EmbedBuilder()
          .setColor(COLORS.RAPHAEL_WARNING)
          .setAuthor(author)
          .setTitle('『 Badges 』')
          .setDescription(
            badges.length > 0
              ? joinWithinLimit(badges.map((badge, i) =>
                `${i + 1}. ◈ **${badge.name}**\nEarned: ${relativeTime(badge.earnedAt)}`
              ))
              : 'No badges earned yet, Master. Complete achievements to earn badges.'
          )
          .setFooter({ text: `${getRandomFooter()} | Total: ${badges.length} badge${badges.length === 1 ? '' : 's'}` })
          .setTimestamp();

        await message.reply({ embeds: [embed] });

      } else if (category === 'items') {
        const items = economy.inventory.items;
        const embed = new EmbedBuilder()
          .setColor(COLORS.RAPHAEL)
          .setAuthor(author)
          .setTitle('『 Items 』')
          .setDescription(
            items.length > 0
              ? joinWithinLimit(items.map((item, i) =>
                `${i + 1}. **${item.name}** x${item.quantity}\nPurchased: ${relativeTime(item.purchasedAt)}`
              ))
              : 'No items acquired yet, Master.'
          )
          .setFooter({ text: `${getRandomFooter()} | Total: ${items.length} item type${items.length === 1 ? '' : 's'}` })
          .setTimestamp();

        await message.reply({ embeds: [embed] });

      } else {
        await message.reply({
          embeds: [await errorEmbed(guildId, 'Invalid Category',
            `Unknown category, Master. Use \`backgrounds\`, \`badges\`, or \`items\`.\n\n**Syntax:** \`${prefix}inventory [backgrounds/badges/items]\``)]
        });
      }

    } catch (error) {
      console.error('[Inventory] Error:', error);
      return message.reply({
        embeds: [await errorEmbed(guildId, 'Inventory Error', 'An anomaly occurred while loading inventory data, Master.')]
      }).catch(() => {});
    }
  }
};
