import { EmbedBuilder } from 'discord.js';
import Economy from '../../models/Economy.js';
import Guild from '../../models/Guild.js';
import { COINFLIP_MIN, COINFLIP_MAX, DEFAULT_COIN_NAME } from '../../utils/gameConfig.js';
import { errorEmbed, COLORS } from '../../utils/embeds.js';
import { getPrefix, formatNumber } from '../../utils/helpers.js';
import { getRandomFooter } from '../../utils/raphael.js';

const CHOICES = { heads: 'heads', h: 'heads', tails: 'tails', t: 'tails' };
const capitalize = (text) => text.charAt(0).toUpperCase() + text.slice(1);

export default {
    name: 'coinflip',
    description: 'Engage in probability-based wagering protocol, Master',
    usage: 'coinflip <amount> <heads|tails>',
    category: 'economy',
    aliases: ['cf', 'flip'],
    cooldown: 5,

    execute: async (message, args) => {
        const userId = message.author.id;
        const guildId = message.guild.id;

        try {
            const amount = parseInt(args[0]);
            const choice = args[1]?.toLowerCase();

            if (!amount || isNaN(amount)) {
                const prefix = await getPrefix(guildId);
                return message.reply({
                    embeds: [await errorEmbed(guildId, 'Invalid Parameters',
                        `A valid wager amount is required, Master.\n\n` +
                        `▸ Syntax: \`${prefix}coinflip <amount> <heads|tails>\`\n` +
                        `▸ Example: \`${prefix}coinflip 100 heads\``
                    )]
                });
            }

            if (!choice || !Object.hasOwn(CHOICES, choice)) {
                const prefix = await getPrefix(guildId);
                return message.reply({
                    embeds: [await errorEmbed(guildId, 'Selection Required',
                        `Please specify your prediction, Master.\n\n` +
                        `▸ Syntax: \`${prefix}coinflip <amount> <heads|tails>\`\n` +
                        `▸ Example: \`${prefix}coinflip 100 heads\``
                    )]
                });
            }

            if (amount < COINFLIP_MIN) {
                return message.reply({
                    embeds: [await errorEmbed(guildId, 'Wager Rejected', `Minimum wager is **${formatNumber(COINFLIP_MIN)}** coins, Master.`)]
                });
            }

            if (amount > COINFLIP_MAX) {
                return message.reply({
                    embeds: [await errorEmbed(guildId, 'Wager Rejected', `Maximum wager is **${formatNumber(COINFLIP_MAX)}** coins, Master.`)]
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

            const userChoice = CHOICES[choice];

            // Flip the coin
            const result = Math.random() < 0.5 ? 'heads' : 'tails';
            const won = result === userChoice;

            // Stats first, so the single save inside addCoins/removeCoins records them too
            if (won) {
                economy.gamblingWins = (economy.gamblingWins || 0) + 1;
            } else {
                economy.gamblingLosses = (economy.gamblingLosses || 0) + 1;
            }
            economy.gamblingTotal = (economy.gamblingTotal || 0) + amount;

            if (won) {
                await economy.addCoins(amount, 'Coinflip win');
            } else {
                await economy.removeCoins(amount, 'Coinflip loss');
            }

            const embed = new EmbedBuilder()
                .setTitle('『 Binary Probability 』')
                .setDescription(
                    `Initiating random binary calculation...\n\n` +
                    `▸ **Your Prediction:** ${capitalize(userChoice)}\n` +
                    `▸ **Outcome:** ${capitalize(result)}\n\n` +
                    (won
                        ? `◉ **PREDICTION CORRECT**\n\n▸ **Resources Gained:** +${formatNumber(amount)} ${coinName}\n\n*Fortune favors you, Master.*`
                        : `◆ **PREDICTION INCORRECT**\n\n▸ **Resources Lost:** -${formatNumber(amount)} ${coinName}\n\n*Perhaps reconsider your strategy, Master.*`)
                )
                .addFields({ name: '▸ Updated Balance', value: `**${formatNumber(economy.coins)}** ${coinName}` })
                .setColor(won ? COLORS.RAPHAEL_SUCCESS : COLORS.RAPHAEL_ERROR)
                .setThumbnail(message.author.displayAvatarURL({ extension: 'png' }))
                .setFooter({ text: `${getRandomFooter()} | W:${economy.gamblingWins || 0} L:${economy.gamblingLosses || 0}` })
                .setTimestamp();

            await message.reply({ embeds: [embed] });

        } catch (error) {
            console.error('[Coinflip] Error:', error);
            return message.reply({
                embeds: [await errorEmbed(guildId, 'System Error', 'An anomaly occurred during probability calculation, Master.')]
            }).catch(() => {});
        }
    }
};
