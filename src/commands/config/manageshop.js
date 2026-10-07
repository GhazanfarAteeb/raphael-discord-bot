import { PermissionFlagsBits, ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType, MessageFlags } from 'discord.js';
import Guild from '../../models/Guild.js';
import { successEmbed, errorEmbed, infoEmbed, warningEmbed, GLYPHS } from '../../utils/embeds.js';
import { getPrefix, formatNumber, hasModPerms } from '../../utils/helpers.js';
import { saveBackgroundFromMessage, deleteBackgroundImage, FALLBACK_KEY, IMAGE_NOT_SAVED } from '../../utils/backgroundImages.js';

const MAX_NAME_LENGTH = 100; // Names are used as embed field names (limit 256)
const MAX_DESCRIPTION_LENGTH = 500;
const ITEMS_PER_PAGE = 5;
const LIST_TIMEOUT = 60000;
const DEFAULT_FALLBACK = { image: '', color: '#2C2F33' };
const MAX_URL_LENGTH = 500; // Keeps list fields well inside Discord's 1024-character limit
const IMAGE_URL = /^https?:\/\/.+\.(png|jpg|jpeg|gif|webp)(\?.*)?$/i;
const EXAMPLE_ID = 'bg_m1k9x2_a7f3';

function isImageUrl(value) {
  if (value.length > MAX_URL_LENGTH || !IMAGE_URL.test(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

// Shorten for display, marking the cut only when something was actually cut
function shorten(text, max) {
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

function stockText(stock) {
  return stock === -1 || stock === undefined ? 'Unlimited' : String(stock);
}

// Updates one item in place, matched by id
function updateItem(guildId, itemId, fields) {
  const set = Object.fromEntries(
    Object.entries(fields).map(([key, value]) => [`customShopItems.$[item].${key}`, value])
  );
  return Guild.updateGuild(guildId, { $set: set }, { arrayFilters: [{ 'item.id': itemId }] });
}

// Cards are drawn from a stored copy of each background image (utils/backgroundImages.js).
// `reply` shows the image in its embed, so the copy can come from Discord's proxy even when
// the bot can't reach the image host. Tells the admin when no copy could be made.
async function saveImageCopy(message, reply, guildId, key, imageUrl) {
  if (await saveBackgroundFromMessage(reply, guildId, key, imageUrl)) return;
  await message.reply({
    embeds: [await warningEmbed(guildId, 'Image Not Saved', `${GLYPHS.WARN} ${IMAGE_NOT_SAVED}`)]
  }).catch(() => {});
}

export default {
  name: 'manageshop',
  description: 'Add, remove, or modify shop backgrounds',
  usage: '<add|remove|edit|list|setprice|stock|fallback> [options]',
  aliases: ['shopmanage', 'editshop', 'customshop'],
  category: 'config',
  permissions: [PermissionFlagsBits.ManageGuild],
  cooldown: 3,

  async execute(message, args) {
    const guildId = message.guild.id;

    try {
      const prefix = await getPrefix(guildId);
      const guildConfig = await Guild.getGuild(guildId, message.guild.name);

      // Check for moderator permissions (admin, mod role, or ManageGuild)
      if (!hasModPerms(message.member, guildConfig)) {
        return message.reply({
          embeds: [await errorEmbed(guildId, 'Permission Denied',
            `${GLYPHS.LOCK} You need Moderator/Staff permissions to manage the shop.`)]
        });
      }

      const ctx = {
        message,
        guildId,
        prefix,
        guildConfig,
        items: guildConfig.customShopItems || [],
        coinEmoji: guildConfig.economy?.coinEmoji || '💰'
      };
      const subcommand = args[0]?.toLowerCase();

      switch (subcommand) {
        case undefined: return showHelp(ctx);
        case 'add': return addItem(ctx, args.slice(1));
        case 'remove': return removeItem(ctx, args[1]);
        case 'list': return listItems(ctx);
        case 'setprice': return setPrice(ctx, args[1], args[2]);
        case 'edit': return editItem(ctx, args[1], args[2]?.toLowerCase(), args.slice(3).join(' '));
        case 'stock': return setStock(ctx, args[1], args[2]);
        case 'fallback': return setFallback(ctx, args[1]?.toLowerCase(), args.slice(2).join(' '));
        default:
          return message.reply({
            embeds: [await errorEmbed(guildId, 'Unknown Subcommand',
              `${GLYPHS.ERROR} Unknown subcommand: \`${subcommand}\`\n\nUse \`${prefix}manageshop\` to see available options.`)]
          });
      }
    } catch (error) {
      console.error('[ManageShop] Error:', error);
      return message.reply({
        embeds: [await errorEmbed(guildId, 'Shop Error',
          'The shop could not be updated, Master. Please try again.')]
      }).catch(() => null);
    }
  }
};

async function showHelp({ message, guildId, prefix, guildConfig, items }) {
  const fallbackBg = guildConfig.economy?.fallbackBackground;

  const embed = await infoEmbed(guildId, 'Background Shop Management',
    `${GLYPHS.INFO} Manage custom backgrounds in your server shop.\n\n` +
    `${GLYPHS.ARROW_RIGHT} **Backgrounds:** ${items.length}\n` +
    `${GLYPHS.ARROW_RIGHT} **Fallback:** ${fallbackBg?.image ? `Image (${shorten(fallbackBg.image, 60)})` : `Color ${fallbackBg?.color || DEFAULT_FALLBACK.color}`}`);

  embed.addFields(
    {
      name: `${GLYPHS.ARROW_RIGHT} Items`,
      value:
        `\`${prefix}manageshop add "<name>" <price> <image_url>\` - Add a background\n` +
        `\`${prefix}manageshop remove <id>\` - Remove a background\n` +
        `\`${prefix}manageshop list\` - List all backgrounds`
    },
    {
      name: `${GLYPHS.ARROW_RIGHT} Editing`,
      value:
        `\`${prefix}manageshop setprice <id> <price>\` - Change the price\n` +
        `\`${prefix}manageshop edit <id> <name|description|image> <value>\` - Edit a property\n` +
        `\`${prefix}manageshop stock <id> <amount>\` - Set stock (-1 = unlimited)`
    },
    {
      name: `${GLYPHS.ARROW_RIGHT} Default Background`,
      value: `\`${prefix}manageshop fallback <url|color|clear> [value]\` - Background for profiles without one`
    }
  );

  return message.reply({ embeds: [embed] });
}

async function addItem({ message, guildId, prefix, coinEmoji }, args) {
  // manageshop add "Background Name" 1000 https://image.url  |  manageshop add BackgroundName 1000 https://image.url
  const input = args.join(' ');
  const match = input.match(/^"([^"]+)"\s+(\d+)\s+(\S+)/) || input.match(/^(\S+)\s+(\d+)\s+(\S+)/);

  if (!match) {
    return message.reply({
      embeds: [await errorEmbed(guildId, 'Invalid Format',
        `${GLYPHS.ERROR} **Usage:**\n` +
        `\`${prefix}manageshop add "Background Name" <price> <image_url>\`\n` +
        `\`${prefix}manageshop add BackgroundName <price> <image_url>\`\n\n` +
        `**Example:** \`${prefix}manageshop add "Galaxy" 5000 https://example.com/galaxy.png\``)]
    });
  }

  const itemName = match[1].trim();
  const price = parseInt(match[2], 10);
  const imageUrl = match[3];

  if (itemName.length > MAX_NAME_LENGTH) {
    return message.reply({
      embeds: [await errorEmbed(guildId, 'Name Too Long',
        `${GLYPHS.ERROR} Background names can be at most ${MAX_NAME_LENGTH} characters.`)]
    });
  }

  if (!Number.isSafeInteger(price) || price < 0) {
    return message.reply({
      embeds: [await errorEmbed(guildId, 'Invalid Price',
        `${GLYPHS.ERROR} Price must be 0 or a positive whole number.`)]
    });
  }

  if (!isImageUrl(imageUrl)) {
    return message.reply({
      embeds: [await errorEmbed(guildId, 'Invalid Image URL',
        `${GLYPHS.ERROR} Please provide a valid image URL (png, jpg, gif, or webp; up to ${MAX_URL_LENGTH} characters).`)]
    });
  }

  const itemId = `bg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

  await Guild.updateGuild(guildId, {
    $push: {
      customShopItems: {
        id: itemId,
        name: itemName,
        description: 'A custom background',
        price,
        type: 'background',
        image: imageUrl,
        stock: -1,
        createdBy: message.author.id,
        createdAt: new Date()
      }
    }
  });

  const embed = await successEmbed(guildId, 'Background Added to Shop',
    `${GLYPHS.SUCCESS} **${itemName}** is now available in the shop.`);
  embed.addFields(
    { name: `${GLYPHS.ARROW_RIGHT} Price`, value: `${formatNumber(price)} ${coinEmoji}`, inline: true },
    { name: `${GLYPHS.ARROW_RIGHT} ID`, value: `\`${itemId}\``, inline: true }
  );
  embed.setImage(imageUrl);

  const reply = await message.reply({ embeds: [embed] });
  await saveImageCopy(message, reply, guildId, itemId, imageUrl);
  return reply;
}

async function findItemOrReply({ message, guildId, prefix, items }, itemId, usage) {
  if (!itemId) {
    await message.reply({
      embeds: [await errorEmbed(guildId, 'Missing Item ID',
        `${GLYPHS.ERROR} Please provide the item ID.\n\n**Usage:** \`${usage}\`\n` +
        `**Tip:** Use \`${prefix}manageshop list\` to see item IDs`)]
    });
    return null;
  }

  const item = items.find(i => i.id === itemId);
  if (!item) {
    await message.reply({
      embeds: [await errorEmbed(guildId, 'Item Not Found',
        `${GLYPHS.ERROR} No item found with ID: \`${itemId}\``)]
    });
    return null;
  }
  return item;
}

async function removeItem(ctx, itemId) {
  const { message, guildId, prefix } = ctx;
  const item = await findItemOrReply(ctx, itemId, `${prefix}manageshop remove <id>`);
  if (!item) return null;

  await Guild.updateGuild(guildId, { $pull: { customShopItems: { id: itemId } } });
  await deleteBackgroundImage(guildId, itemId).catch(() => {});

  return message.reply({
    embeds: [await successEmbed(guildId, 'Item Removed',
      `${GLYPHS.SUCCESS} Removed **${item.name}** from the shop.`)]
  });
}

async function listItems({ message, guildId, prefix, items, coinEmoji }) {
  if (items.length === 0) {
    return message.reply({
      embeds: [await infoEmbed(guildId, 'No Backgrounds',
        `${GLYPHS.INFO} There are no custom backgrounds in the shop yet.\n\nUse \`${prefix}manageshop add\` to add one.`)]
    });
  }

  const maxPages = Math.ceil(items.length / ITEMS_PER_PAGE);
  let currentPage = 0;

  const buildPage = async (page) => {
    const pageItems = items.slice(page * ITEMS_PER_PAGE, (page + 1) * ITEMS_PER_PAGE);
    const embed = await infoEmbed(guildId, 'Shop Backgrounds',
      `${GLYPHS.INFO} Page ${page + 1}/${maxPages} — ${items.length} background(s) in total.`);

    for (const item of pageItems) {
      embed.addFields({
        name: `${GLYPHS.ARROW_RIGHT} ${shorten(item.name || 'Unnamed', MAX_NAME_LENGTH)}`,
        value:
          `**ID:** \`${item.id}\`\n` +
          `**Price:** ${formatNumber(item.price ?? 0)} ${coinEmoji}\n` +
          `**Stock:** ${stockText(item.stock)}` +
          (item.image && item.image.length <= MAX_URL_LENGTH ? `\n**Image:** [Preview](${item.image})` : ''),
        inline: false
      });
    }
    return embed;
  };

  const buildButtons = (page) => new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('manageshop_prev')
      .setLabel('‹ Previous')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(page === 0),
    new ButtonBuilder()
      .setCustomId('manageshop_next')
      .setLabel('Next ›')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(page === maxPages - 1)
  );

  if (maxPages === 1) {
    return message.reply({ embeds: [await buildPage(0)] });
  }

  const listMessage = await message.reply({
    embeds: [await buildPage(0)],
    components: [buildButtons(0)]
  });
  if (!listMessage) return null;

  const collector = listMessage.createMessageComponentCollector({
    componentType: ComponentType.Button,
    time: LIST_TIMEOUT
  });

  collector.on('collect', async (interaction) => {
    try {
      if (interaction.user.id !== message.author.id) {
        return interaction.reply({
          content: 'Only the member who opened this list can change its page, Master.',
          flags: MessageFlags.Ephemeral
        });
      }

      if (interaction.customId === 'manageshop_prev') {
        currentPage = Math.max(0, currentPage - 1);
      } else if (interaction.customId === 'manageshop_next') {
        currentPage = Math.min(maxPages - 1, currentPage + 1);
      }

      await interaction.update({
        embeds: [await buildPage(currentPage)],
        components: [buildButtons(currentPage)]
      });
    } catch (error) {
      console.error('[ManageShop] Pagination error:', error);
    }
  });

  collector.on('end', () => {
    listMessage.edit({ components: [] }).catch(() => { });
  });

  return listMessage;
}

async function setPrice(ctx, itemId, priceArg) {
  const { message, guildId, prefix, coinEmoji } = ctx;
  const newPrice = parseInt(priceArg, 10);

  if (!itemId || isNaN(newPrice)) {
    return message.reply({
      embeds: [await errorEmbed(guildId, 'Invalid Usage',
        `${GLYPHS.ERROR} **Usage:** \`${prefix}manageshop setprice <id> <price>\`\n\n` +
        `**Example:** \`${prefix}manageshop setprice ${EXAMPLE_ID} 2500\``)]
    });
  }

  if (!Number.isSafeInteger(newPrice) || newPrice < 0) {
    return message.reply({
      embeds: [await errorEmbed(guildId, 'Invalid Price',
        `${GLYPHS.ERROR} Price must be 0 or greater.`)]
    });
  }

  const item = await findItemOrReply(ctx, itemId, `${prefix}manageshop setprice <id> <price>`);
  if (!item) return null;

  await updateItem(guildId, itemId, { price: newPrice });

  return message.reply({
    embeds: [await successEmbed(guildId, 'Price Updated',
      `${GLYPHS.SUCCESS} Updated the price of **${item.name}**.\n\n` +
      `**Old Price:** ${formatNumber(item.price ?? 0)} ${coinEmoji}\n` +
      `**New Price:** ${formatNumber(newPrice)} ${coinEmoji}`)]
  });
}

async function editItem(ctx, itemId, field, value) {
  const { message, guildId, prefix } = ctx;

  if (!itemId || !field) {
    return message.reply({
      embeds: [await errorEmbed(guildId, 'Invalid Usage',
        `${GLYPHS.ERROR} **Usage:** \`${prefix}manageshop edit <id> <field> <value>\`\n\n` +
        `**Fields:** name, description, image\n\n` +
        `**Example:** \`${prefix}manageshop edit ${EXAMPLE_ID} description "A beautiful galaxy background"\``)]
    });
  }

  const item = await findItemOrReply(ctx, itemId, `${prefix}manageshop edit <id> <field> <value>`);
  if (!item) return null;

  // Remove surrounding quotes if present
  const cleanValue = value.trim().replace(/^["']|["']$/g, '');
  let update;
  let label;

  switch (field) {
    case 'name':
      if (!cleanValue) {
        return message.reply({ embeds: [await errorEmbed(guildId, 'Missing Value', `${GLYPHS.ERROR} Please provide a name.`)] });
      }
      if (cleanValue.length > MAX_NAME_LENGTH) {
        return message.reply({ embeds: [await errorEmbed(guildId, 'Name Too Long', `${GLYPHS.ERROR} Background names can be at most ${MAX_NAME_LENGTH} characters.`)] });
      }
      update = { name: cleanValue };
      label = 'name';
      break;
    case 'description':
    case 'desc':
      if (!cleanValue) {
        return message.reply({ embeds: [await errorEmbed(guildId, 'Missing Value', `${GLYPHS.ERROR} Please provide a description.`)] });
      }
      if (cleanValue.length > MAX_DESCRIPTION_LENGTH) {
        return message.reply({ embeds: [await errorEmbed(guildId, 'Description Too Long', `${GLYPHS.ERROR} Descriptions can be at most ${MAX_DESCRIPTION_LENGTH} characters.`)] });
      }
      update = { description: cleanValue };
      label = 'description';
      break;
    case 'image':
      if (!isImageUrl(cleanValue)) {
        return message.reply({ embeds: [await errorEmbed(guildId, 'Invalid Image URL', `${GLYPHS.ERROR} Please provide a valid image URL (png, jpg, gif, or webp).`)] });
      }
      update = { image: cleanValue };
      label = 'image';
      break;
    default:
      return message.reply({ embeds: [await errorEmbed(guildId, 'Unknown Field', `${GLYPHS.ERROR} Valid fields: name, description, image`)] });
  }

  await updateItem(guildId, itemId, update);

  const embed = await successEmbed(guildId, 'Background Updated',
    `${GLYPHS.SUCCESS} Updated the ${label} of **${update.name || item.name}** to: **${shorten(cleanValue, 1000)}**`);
  if (update.image) embed.setImage(update.image);

  const reply = await message.reply({ embeds: [embed] });
  if (update.image) await saveImageCopy(message, reply, guildId, itemId, update.image);
  return reply;
}

async function setStock(ctx, itemId, stockArg) {
  const { message, guildId, prefix } = ctx;
  const stock = parseInt(stockArg, 10);

  if (!itemId || isNaN(stock) || stock < -1) {
    return message.reply({
      embeds: [await errorEmbed(guildId, 'Invalid Usage',
        `${GLYPHS.ERROR} **Usage:** \`${prefix}manageshop stock <id> <amount>\`\n\n` +
        `Use \`-1\` for unlimited stock.\n\n` +
        `**Example:** \`${prefix}manageshop stock ${EXAMPLE_ID} 50\``)]
    });
  }

  const item = await findItemOrReply(ctx, itemId, `${prefix}manageshop stock <id> <amount>`);
  if (!item) return null;

  await updateItem(guildId, itemId, { stock });

  return message.reply({
    embeds: [await successEmbed(guildId, 'Stock Updated',
      `${GLYPHS.SUCCESS} **${item.name}** stock set to: **${stockText(stock)}**`)]
  });
}

async function setFallback({ message, guildId, prefix, guildConfig }, type, value) {
  // `clear` takes no value, so it is handled before the usage check
  if (type === 'clear' || type === 'reset') {
    await Guild.updateGuild(guildId, { $set: { 'economy.fallbackBackground': { ...DEFAULT_FALLBACK } } });
    await deleteBackgroundImage(guildId, FALLBACK_KEY).catch(() => {});
    return message.reply({
      embeds: [await successEmbed(guildId, 'Fallback Reset',
        `${GLYPHS.SUCCESS} The default background has been reset to the standard dark theme (${DEFAULT_FALLBACK.color}).`)]
    });
  }

  if (!type || !value) {
    const currentFallback = guildConfig.economy?.fallbackBackground;
    const embed = await infoEmbed(guildId, 'Fallback Background',
      `${GLYPHS.INFO} The default background for profiles without one: the image if one is set, otherwise the color.\n\n` +
      `${GLYPHS.ARROW_RIGHT} **Image:** ${currentFallback?.image ? shorten(currentFallback.image, 200) : 'None'}\n` +
      `${GLYPHS.ARROW_RIGHT} **Color:** ${currentFallback?.color || DEFAULT_FALLBACK.color}`);
    embed.addFields({
      name: `${GLYPHS.ARROW_RIGHT} Usage`,
      value:
        `\`${prefix}manageshop fallback url <image_url>\` - Set an image\n` +
        `\`${prefix}manageshop fallback color <hex_color>\` - Set the color\n` +
        `\`${prefix}manageshop fallback clear\` - Reset to default`
    });
    return message.reply({ embeds: [embed] });
  }

  if (type === 'url' || type === 'image') {
    if (!isImageUrl(value)) {
      return message.reply({
        embeds: [await errorEmbed(guildId, 'Invalid URL',
          `${GLYPHS.ERROR} Please provide a valid image URL (http or https, ending in png, jpg, gif or webp).`)]
      });
    }

    await Guild.updateGuild(guildId, { $set: { 'economy.fallbackBackground.image': value } });

    const embed = await successEmbed(guildId, 'Fallback Background Updated',
      `${GLYPHS.SUCCESS} Default background image set.\n\n**URL:** ${shorten(value, 200)}`);
    embed.setImage(value);
    const reply = await message.reply({ embeds: [embed] });
    await saveImageCopy(message, reply, guildId, FALLBACK_KEY, value);
    return reply;
  }

  if (type === 'color') {
    if (!/^#[0-9A-F]{6}$/i.test(value)) {
      return message.reply({
        embeds: [await errorEmbed(guildId, 'Invalid Color',
          `${GLYPHS.ERROR} Please provide a valid hex color (e.g., #FF0000)`)]
      });
    }

    await Guild.updateGuild(guildId, { $set: { 'economy.fallbackBackground.color': value } });

    const embed = await successEmbed(guildId, 'Fallback Color Updated',
      `${GLYPHS.SUCCESS} Default background color set to: **${value}**`);
    embed.setColor(value); // Preview the chosen color
    return message.reply({ embeds: [embed] });
  }

  return message.reply({
    embeds: [await errorEmbed(guildId, 'Invalid Type',
      `${GLYPHS.ERROR} Use \`url\`, \`color\`, or \`clear\``)]
  });
}
