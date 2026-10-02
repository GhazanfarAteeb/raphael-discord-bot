import { PermissionFlagsBits } from 'discord.js';
import Guild from '../../models/Guild.js';
import { successEmbed, errorEmbed, infoEmbed, GLYPHS } from '../../utils/embeds.js';
import { getPrefix, hasAdminPerms } from '../../utils/helpers.js';

const MAX_NAME_LENGTH = 20;
const DEFAULT_EMOJI = '💰';
const DEFAULT_NAME = 'coins';
const CUSTOM_EMOJI = /^<a?:\w{2,32}:\d{17,20}>$/;
// Pictographs cover ZWJ sequences and skin tones; flags are regional-indicator pairs; keycaps end in U+20E3
const UNICODE_EMOJI = /\p{Extended_Pictographic}|\p{Regional_Indicator}|⃣/u;
const graphemes = new Intl.Segmenter('en', { granularity: 'grapheme' });

// One custom Discord emoji, or one Unicode emoji (a single grapheme cluster that is a pictograph)
function isSingleEmoji(value) {
  if (CUSTOM_EMOJI.test(value)) return true;
  return [...graphemes.segment(value)].length === 1 && UNICODE_EMOJI.test(value);
}

export default {
  name: 'setcoin',
  description: 'Customize coin emoji and name (Admin only)',
  usage: 'setcoin <emoji|name> <value>',
  category: 'config',
  aliases: ['coinconfig', 'customcoin'],
  permissions: [PermissionFlagsBits.Administrator],
  cooldown: 5,

  async execute(message, args) {
    const guildId = message.guild.id;

    try {
      const guildConfig = await Guild.getGuild(guildId);

      if (!hasAdminPerms(message.member, guildConfig)) {
        return message.reply({
          embeds: [await errorEmbed(guildId, 'Permission Denied',
            `${GLYPHS.LOCK} You need Administrator permissions to configure coins.`)]
        });
      }

      const prefix = await getPrefix(guildId);
      const currentEmoji = guildConfig.economy?.coinEmoji || DEFAULT_EMOJI;
      const currentName = guildConfig.economy?.coinName || DEFAULT_NAME;

      if (!args[0]) {
        const embed = await infoEmbed(guildId, 'Coin Configuration',
          `${GLYPHS.ARROW_RIGHT} **Emoji:** ${currentEmoji}\n` +
          `${GLYPHS.ARROW_RIGHT} **Name:** ${currentName}`);
        embed.addFields(
          {
            name: `${GLYPHS.ARROW_RIGHT} Usage`,
            value:
              `\`${prefix}setcoin emoji <emoji>\` - Change the coin emoji (one emoji, standard or custom)\n` +
              `\`${prefix}setcoin name <name>\` - Change the coin name (up to ${MAX_NAME_LENGTH} characters)`
          },
          {
            name: `${GLYPHS.ARROW_RIGHT} Example`,
            value: `\`${prefix}setcoin name credits\``
          }
        );
        return message.reply({ embeds: [embed] });
      }

      const type = args[0].toLowerCase();
      const value = args.slice(1).join(' ').trim();

      if (!['emoji', 'emote', 'name'].includes(type)) {
        return message.reply({
          embeds: [await errorEmbed(guildId, 'Invalid Type',
            `${GLYPHS.ERROR} Use \`emoji\` or \`name\`.\n\n` +
            `**Usage:** \`${prefix}setcoin <emoji|name> <value>\``)]
        });
      }

      if (!value) {
        return message.reply({
          embeds: [await errorEmbed(guildId, 'Missing Value',
            `${GLYPHS.ERROR} Please provide a value.\n\n` +
            `**Usage:** \`${prefix}setcoin ${type} <value>\``)]
        });
      }

      if (type === 'emoji' || type === 'emote') {
        if (!isSingleEmoji(value)) {
          return message.reply({
            embeds: [await errorEmbed(guildId, 'Invalid Emoji',
              `${GLYPHS.ERROR} Please provide exactly one emoji: a standard emoji or a custom server emoji.`)]
          });
        }

        await Guild.updateGuild(guildId, { $set: { 'economy.coinEmoji': value } });

        return message.reply({
          embeds: [await successEmbed(guildId, 'Coin Emoji Updated',
            `${GLYPHS.SUCCESS} The coin emoji is now ${value}\n\n` +
            `**Example:** **100** ${value} ${currentName}`)]
        });
      }

      // type === 'name'
      if (value.length > MAX_NAME_LENGTH) {
        return message.reply({
          embeds: [await errorEmbed(guildId, 'Name Too Long',
            `${GLYPHS.ERROR} The coin name can be at most ${MAX_NAME_LENGTH} characters.`)]
        });
      }

      // Stored lowercase, so echo what was actually saved
      const coinName = value.toLowerCase();
      await Guild.updateGuild(guildId, { $set: { 'economy.coinName': coinName } });

      return message.reply({
        embeds: [await successEmbed(guildId, 'Coin Name Updated',
          `${GLYPHS.SUCCESS} The coin name is now **${coinName}**\n\n` +
          `**Example:** **100** ${currentEmoji} ${coinName}`)]
      });
    } catch (error) {
      console.error('[SetCoin] Error:', error);
      return message.reply({
        embeds: [await errorEmbed(guildId, 'Configuration Error',
          'The coin settings could not be updated, Master. Please try again.')]
      }).catch(() => null);
    }
  }
};
