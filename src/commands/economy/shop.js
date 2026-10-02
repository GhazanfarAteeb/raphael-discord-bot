import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType, MessageFlags } from 'discord.js';
import Economy from '../../models/Economy.js';
import Guild from '../../models/Guild.js';
import { DEFAULT_COIN_NAME } from '../../utils/gameConfig.js';
import { errorEmbed, COLORS } from '../../utils/embeds.js';
import { getPrefix, formatNumber } from '../../utils/helpers.js';
import { getRandomFooter } from '../../utils/raphael.js';

// The catalog closes after this long without a button press
const IDLE_TIMEOUT = 120_000;
const MAX_TRANSACTIONS = 50;

// A numeric stock of 0 or more is a limited quantity (0 = sold out); -1 or no value is unlimited
const isLimited = (stock) => typeof stock === 'number' && Number.isFinite(stock) && stock >= 0;
const isValidPrice = (price) => typeof price === 'number' && Number.isFinite(price) && price >= 0;
const isImageUrl = (url) => typeof url === 'string' && /^https?:\/\//i.test(url);

// The shop sells the server's custom backgrounds (Guild.customShopItems with type 'background')
function findBackground(guildConfig, itemId) {
  return (guildConfig.customShopItems || []).find(item => item.type === 'background' && item.id === itemId);
}

function toListing(item) {
  return {
    id: item.id,
    name: item.name,
    description: item.description || 'A custom visual template',
    price: item.price,
    image: item.image || '',
    stock: item.stock,
    available: isValidPrice(item.price)
  };
}

// Takes one unit of a limited item; true if a unit was reserved. The decrement only applies
// while stock > 0, and with new: false the returned document is the state the update was
// applied to, so its stock says whether it did.
async function reserveStock(guildId, itemId) {
  const before = await Guild.updateGuild(guildId,
    { $inc: { 'customShopItems.$[elem].stock': -1 } },
    { arrayFilters: [{ 'elem.id': itemId, 'elem.stock': { $gt: 0 } }], new: false }
  );
  // updateGuild re-cached that pre-update document: drop it so readers see the new stock
  await Guild.invalidateCache(guildId);
  const item = before?.customShopItems?.find(i => i.id === itemId);
  return isLimited(item?.stock) && item.stock > 0;
}

// Returns a reserved unit (skipped if an admin has since made the item unlimited or removed it)
async function releaseStock(guildId, itemId) {
  await Guild.updateGuild(guildId,
    { $inc: { 'customShopItems.$[elem].stock': 1 } },
    { arrayFilters: [{ 'elem.id': itemId, 'elem.stock': { $gte: 0 } }] }
  );
}

// Charges the price and grants the background in one conditional update: it only applies if
// the member can afford it and doesn't own it yet. __v is bumped so a stale copy of the
// document elsewhere can't save over the new balance.
function purchase(userId, guildId, listing) {
  const now = new Date();
  return Economy.findOneAndUpdate(
    { userId, guildId, coins: { $gte: listing.price }, 'inventory.backgrounds.id': { $ne: listing.id } },
    {
      $inc: { coins: -listing.price, 'stats.totalSpent': listing.price, __v: 1 },
      $push: {
        'inventory.backgrounds': { id: listing.id, name: listing.name, purchasedAt: now },
        transactions: {
          $each: [{ type: 'spend', amount: listing.price, description: `Purchased background: ${listing.name}`, timestamp: now }],
          $position: 0,
          $slice: MAX_TRANSACTIONS
        }
      }
    },
    { new: true }
  );
}

export default {
  name: 'shop',
  description: 'Access the acquisition catalog for profile customizations, Master',
  usage: 'shop [category]',
  category: 'economy',
  aliases: ['store', 'buy'],
  cooldown: 3,

  execute: async (message, args) => {
    const userId = message.author.id;
    const guildId = message.guild.id;

    try {
      const prefix = await getPrefix(guildId);
      const economy = await Economy.getEconomy(userId, guildId);
      const guildConfig = await Guild.getGuild(guildId);
      const coinName = guildConfig.economy?.coinName || DEFAULT_COIN_NAME;

      // Custom shop backgrounds only (the built-in default is free)
      const listings = (guildConfig.customShopItems || [])
        .filter(item => item.type === 'background')
        .map(toListing);

      if (listings.length === 0) {
        const embed = new EmbedBuilder()
          .setColor(COLORS.RAPHAEL_ERROR)
          .setTitle('『 Acquisition Module 』')
          .setDescription(`**Notice:** The inventory is currently vacant, Master.\n\nRequest an administrator to add items using \`${prefix}manageshop\`.`)
          .setFooter({ text: getRandomFooter() });

        return message.reply({ embeds: [embed] });
      }

      // What the page shows about the member; refreshed whenever a purchase is attempted
      const state = {
        coins: economy.coins,
        owned: new Set(economy.inventory.backgrounds.map(bg => bg.id))
      };
      const refreshState = (doc) => {
        state.coins = doc.coins;
        state.owned = new Set(doc.inventory.backgrounds.map(bg => bg.id));
      };

      let currentPage = 0;
      let busy = false;
      const maxPages = listings.length;

      const describe = (listing) => {
        const owned = state.owned.has(listing.id);
        const soldOut = isLimited(listing.stock) && listing.stock <= 0;
        const canAfford = state.coins >= listing.price;
        return { owned, soldOut, canAfford, purchasable: listing.available && !owned && !soldOut && canAfford };
      };

      const generateEmbed = (page) => {
        const listing = listings[page];
        const { owned, soldOut, canAfford } = describe(listing);

        const status = owned ? '◉ Acquired'
          : !listing.available ? '◆ Withdrawn'
          : soldOut ? '◆ Sold Out'
          : canAfford ? '◈ Available'
          : '◇ Insufficient Resources';

        const embed = new EmbedBuilder()
          .setColor(COLORS.RAPHAEL)
          .setTitle('『 Acquisition Module 』')
          .setDescription(`**${listing.name}**\n${listing.description}`)
          .addFields(
            { name: '▸ Value', value: listing.available ? `**${formatNumber(listing.price)}** ${coinName}` : '—', inline: true },
            { name: '▸ Balance', value: `**${formatNumber(state.coins)}** ${coinName}`, inline: true },
            { name: '▸ Status', value: status, inline: true }
          )
          .setFooter({ text: `${getRandomFooter()} | Item ${page + 1} of ${maxPages}` })
          .setTimestamp();

        if (isLimited(listing.stock)) {
          embed.addFields({ name: '▸ Stock', value: `**${formatNumber(listing.stock)}** remaining`, inline: true });
        }
        if (isImageUrl(listing.image)) {
          embed.setImage(listing.image);
        }

        return embed;
      };

      const generateButtons = (page, allDisabled = false) => {
        const listing = listings[page];
        const { owned, soldOut, purchasable } = describe(listing);

        const label = owned ? '◉ Acquired'
          : !listing.available ? 'Unavailable'
          : soldOut ? 'Sold Out'
          : `Acquire (${formatNumber(listing.price)})`;

        return [new ActionRowBuilder()
          .addComponents(
            new ButtonBuilder()
              .setCustomId('shop_previous')
              .setLabel('‹ Previous')
              .setStyle(ButtonStyle.Secondary)
              .setDisabled(allDisabled || page === 0),
            new ButtonBuilder()
              .setCustomId('shop_buy')
              .setLabel(label)
              .setStyle(purchasable ? ButtonStyle.Success : owned ? ButtonStyle.Secondary : ButtonStyle.Danger)
              .setDisabled(allDisabled || !purchasable),
            new ButtonBuilder()
              .setCustomId('shop_next')
              .setLabel('Next ›')
              .setStyle(ButtonStyle.Secondary)
              .setDisabled(allDisabled || page === maxPages - 1)
          )];
      };

      const pagePayload = () => ({
        embeds: [generateEmbed(currentPage)],
        components: generateButtons(currentPage)
      });

      const shopMessage = await message.reply(pagePayload());

      const collector = shopMessage.createMessageComponentCollector({
        componentType: ComponentType.Button,
        idle: IDLE_TIMEOUT
      });

      // Shows the refreshed page and tells the buyer (privately) why nothing was bought
      const decline = async (interaction, text) => {
        await interaction.editReply(pagePayload());
        await interaction.followUp({ content: text, flags: MessageFlags.Ephemeral });
      };

      const handlePurchase = async (interaction) => {
        const listing = listings[currentPage];

        // Re-read the item at buy time: it may have been removed, repriced or sold out
        const current = findBackground(await Guild.getGuild(guildId), listing.id);
        if (!current || !isValidPrice(current.price)) {
          listing.available = false;
          return decline(interaction, 'This background has been withdrawn from the catalog, Master.');
        }
        const shownPrice = listing.price;
        Object.assign(listing, toListing(current));
        refreshState(await Economy.getEconomy(userId, guildId));

        if (state.owned.has(listing.id)) {
          return decline(interaction, 'This item is already in your inventory, Master.');
        }
        if (isLimited(listing.stock) && listing.stock <= 0) {
          return decline(interaction, `**${listing.name}** is sold out, Master.`);
        }
        if (listing.price !== shownPrice) {
          return decline(interaction,
            `The price of **${listing.name}** has changed to **${formatNumber(listing.price)}** ${coinName}, Master. Select Acquire again to confirm.`);
        }
        if (state.coins < listing.price) {
          return decline(interaction,
            `You require **${formatNumber(listing.price - state.coins)}** additional ${coinName}, Master.`);
        }

        const limited = isLimited(listing.stock);
        if (limited && !(await reserveStock(guildId, listing.id))) {
          listing.stock = 0;
          return decline(interaction, `**${listing.name}** has just sold out, Master.`);
        }

        let updated;
        try {
          updated = await purchase(userId, guildId, listing);
        } catch (error) {
          if (limited) await releaseStock(guildId, listing.id).catch(e => console.error('[Shop] Error releasing stock:', e));
          throw error;
        }

        if (!updated) {
          // Spent or bought elsewhere in the meantime: return the reserved unit and explain
          if (limited) await releaseStock(guildId, listing.id).catch(e => console.error('[Shop] Error releasing stock:', e));
          refreshState(await Economy.getEconomy(userId, guildId));
          return decline(interaction, state.owned.has(listing.id)
            ? 'This item is already in your inventory, Master.'
            : `You require **${formatNumber(Math.max(listing.price - state.coins, 0))}** additional ${coinName}, Master.`);
        }

        collector.stop('purchased');

        const purchaseEmbed = new EmbedBuilder()
          .setColor(COLORS.RAPHAEL_SUCCESS)
          .setTitle('『 Acquisition Complete 』')
          .setDescription(`**Confirmed:** **${listing.name}** has been added to your inventory, Master.`)
          .addFields(
            { name: '▸ Expended', value: `**${formatNumber(listing.price)}** ${coinName}`, inline: true },
            { name: '▸ Updated Balance', value: `**${formatNumber(updated.coins)}** ${coinName}`, inline: true }
          )
          .setFooter({ text: `${getRandomFooter()} | Use ${prefix}setbg ${listing.id} to apply` })
          .setTimestamp();

        return interaction.editReply({ embeds: [purchaseEmbed], components: [] });
      };

      collector.on('collect', async (interaction) => {
        if (interaction.user.id !== userId) {
          return interaction.reply({
            content: `This catalog belongs to ${message.author.username}, Master. Use \`${prefix}shop\` to open your own.`,
            flags: MessageFlags.Ephemeral
          }).catch(() => {});
        }

        // One action at a time (a double-click on Acquire must not buy twice)
        if (busy) return interaction.deferUpdate().catch(() => {});
        busy = true;

        try {
          if (interaction.customId === 'shop_previous') {
            currentPage = Math.max(0, currentPage - 1);
            await interaction.update(pagePayload());
          } else if (interaction.customId === 'shop_next') {
            currentPage = Math.min(maxPages - 1, currentPage + 1);
            await interaction.update(pagePayload());
          } else if (interaction.customId === 'shop_buy') {
            await interaction.deferUpdate();
            await handlePurchase(interaction);
          }
        } catch (error) {
          console.error('[Shop] Error handling button:', error);
          const reply = {
            embeds: [await errorEmbed(guildId, 'Acquisition Error', 'An error occurred during processing, Master. Please retry.')],
            flags: MessageFlags.Ephemeral
          };
          await (interaction.replied || interaction.deferred ? interaction.followUp(reply) : interaction.reply(reply)).catch(() => {});
        } finally {
          busy = false;
        }
      });

      // Idle, message deleted, etc.: leave the page visible with its buttons disabled
      collector.on('end', (_collected, reason) => {
        if (reason === 'purchased') return;
        shopMessage.edit({ components: generateButtons(currentPage, true) }).catch(() => { });
      });

    } catch (error) {
      console.error('[Shop] Error:', error);
      return message.reply({
        embeds: [await errorEmbed(guildId, 'Acquisition Error', 'An error occurred while loading the acquisition module, Master. Please retry.')]
      }).catch(() => {});
    }
  }
};
