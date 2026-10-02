import { EmbedBuilder } from 'discord.js';
import Economy from '../../models/Economy.js';
import Guild from '../../models/Guild.js';
import { DICE_MIN, DICE_MAX, DEFAULT_COIN_NAME } from '../../utils/gameConfig.js';
import { errorEmbed, COLORS } from '../../utils/embeds.js';
import { getPrefix, formatNumber } from '../../utils/helpers.js';
import { getRandomFooter } from '../../utils/raphael.js';

// Guessing the exact face pays 5x the wager in total
const DICE_MULTIPLIER = 5;
// Die-face symbols (text glyphs, not emoji)
const DIE_FACES = ['⚀', '⚁', '⚂', '⚃', '⚄', '⚅'];

export default {
  name: 'dice',
  description: 'Roll dice and bet on the outcome!',
  usage: 'dice <amount> <number 1-6>',
  category: 'economy',
  aliases: ['rolldice', 'diceroll'],
  cooldown: 5,

  execute: async (message, args) => {
    const userId = message.author.id;
    const guildId = message.guild.id;

    try {
      const amount = parseInt(args[0]);
      const guess = parseInt(args[1]);

      if (!amount || isNaN(amount)) {
        const prefix = await getPrefix(guildId);
        return message.reply({
          embeds: [await errorEmbed(guildId, 'Invalid Parameters',
            `Please provide a valid wager, Master.\n\n` +
            `▸ Syntax: \`${prefix}dice <amount> <number 1-6>\`\n` +
            `▸ Example: \`${prefix}dice 100 5\``
          )]
        });
      }

      if (!guess || isNaN(guess) || guess < 1 || guess > 6) {
        const prefix = await getPrefix(guildId);
        return message.reply({
          embeds: [await errorEmbed(guildId, 'Selection Required',
            `Please choose a number between 1 and 6, Master.\n\n` +
            `▸ Syntax: \`${prefix}dice <amount> <number 1-6>\`\n` +
            `▸ Example: \`${prefix}dice 100 5\``
          )]
        });
      }

      if (amount < DICE_MIN) {
        return message.reply({
          embeds: [await errorEmbed(guildId, 'Wager Rejected', `Minimum wager is **${formatNumber(DICE_MIN)}** coins, Master.`)]
        });
      }

      if (amount > DICE_MAX) {
        return message.reply({
          embeds: [await errorEmbed(guildId, 'Wager Rejected', `Maximum wager is **${formatNumber(DICE_MAX)}** coins, Master.`)]
        });
      }

      const guildConfig = await Guild.getGuild(guildId);
      const economy = await Economy.getEconomy(userId, guildId);
      const coinName = guildConfig.economy?.coinName || DEFAULT_COIN_NAME;

      if (economy.coins < amount) {
        return message.reply({
          embeds: [await errorEmbed(guildId, 'Insufficient Resources',
            `Your current balance is insufficient, Master.\n\n` +
            `▸ **Available Funds:** ${formatNumber(economy.coins)} ${coinName}\n` +
            `▸ **Required Wager:** ${formatNumber(amount)} ${coinName}`
          )]
        });
      }

      // Roll the dice
      const roll = Math.floor(Math.random() * 6) + 1;
      const won = roll === guess;

      const winnings = won ? amount * DICE_MULTIPLIER : 0;
      const netGain = won ? winnings - amount : -amount;

      // Stats first, so the single save inside addCoins/removeCoins records them too
      if (won) {
        economy.gamblingWins = (economy.gamblingWins || 0) + 1;
      } else {
        economy.gamblingLosses = (economy.gamblingLosses || 0) + 1;
      }
      economy.gamblingTotal = (economy.gamblingTotal || 0) + amount;

      if (won) {
        await economy.addCoins(netGain, `Dice win (${DICE_MULTIPLIER}x)`);
      } else {
        await economy.removeCoins(amount, 'Dice loss');
      }

      const embed = new EmbedBuilder()
        .setTitle('『 Dice Roll 』')
        .setDescription(
          `▸ **Your Guess:** ${guess}\n` +
          `▸ **Dice Roll:** ${DIE_FACES[roll - 1]} **${roll}**\n\n` +
          (won
            ? `◉ **VICTORY**\n\n▸ **Multiplier:** ${DICE_MULTIPLIER}x\n▸ **Winnings:** +${formatNumber(winnings)} ${coinName}\n▸ **Net Profit:** +${formatNumber(netGain)} ${coinName}\n\n*Precisely as calculated, Master.*`
            : `◆ **DEFEAT**\n\n▸ **Loss:** -${formatNumber(amount)} ${coinName}\n\n*The probabilities were not in your favor, Master.*`)
        )
        .addFields({ name: '▸ Updated Balance', value: `**${formatNumber(economy.coins)}** ${coinName}` })
        .setColor(won ? COLORS.RAPHAEL_SUCCESS : COLORS.RAPHAEL_ERROR)
        .setThumbnail(message.author.displayAvatarURL({ extension: 'png' }))
        .setFooter({ text: `${getRandomFooter()} | W:${economy.gamblingWins || 0} L:${economy.gamblingLosses || 0}` })
        .setTimestamp();

      await message.reply({ embeds: [embed] });

    } catch (error) {
      console.error('[Dice] Error:', error);
      return message.reply({
        embeds: [await errorEmbed(guildId, 'System Error', 'An anomaly occurred while rolling the dice, Master.')]
      }).catch(() => {});
    }
  }
};
