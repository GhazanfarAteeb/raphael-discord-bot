import { EmbedBuilder } from 'discord.js';
import Economy from '../../models/Economy.js';
import Guild from '../../models/Guild.js';
import { ROULETTE_MIN, ROULETTE_MAX, ROULETTE_PAYOUTS, DEFAULT_COIN_NAME } from '../../utils/gameConfig.js';
import { errorEmbed, COLORS } from '../../utils/embeds.js';
import { getPrefix, formatNumber } from '../../utils/helpers.js';
import { getRandomFooter } from '../../utils/raphael.js';

// Single-zero wheel: 0 is green, the rest split evenly between red and black
const RED_NUMBERS = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);
const MAX_NUMBER = 36;
const COLOR_NAMES = { red: 'Red', black: 'Black', green: 'Green' };

function getColor(number) {
    if (number === 0) return 'green';
    return RED_NUMBERS.has(number) ? 'red' : 'black';
}

// Parses the wager target: red/black (color bet), green (straight bet on 0) or a number 0-36
function parseBet(input) {
    if (input === 'red' || input === 'black') return { type: 'color', color: input };
    if (input === 'green') return { type: 'straight', number: 0 };
    if (/^\d+$/.test(input ?? '')) {
        const number = parseInt(input, 10);
        if (number <= MAX_NUMBER) return { type: 'straight', number };
    }
    return null;
}

function describeBet(bet) {
    if (bet.type === 'color') return COLOR_NAMES[bet.color];
    return bet.number === 0 ? 'Green (0)' : `Number ${bet.number}`;
}

function wagerGuide(prefix) {
    return `**Color Wagers:** red or black (pays ${ROULETTE_PAYOUTS.color}x)\n` +
        `**Green:** 0 only (pays ${ROULETTE_PAYOUTS.straight}x)\n` +
        `**Number Wagers:** 0-${MAX_NUMBER} (pays ${ROULETTE_PAYOUTS.straight}x)\n\n` +
        `**Examples:**\n` +
        `\`${prefix}roulette 100 red\`\n` +
        `\`${prefix}roulette 50 17\``;
}

export default {
    name: 'roulette',
    description: 'Spin the roulette wheel and bet on colors or numbers!',
    usage: 'roulette <amount> <red/black/green OR 0-36>',
    category: 'economy',
    aliases: ['roul', 'wheel'],
    cooldown: 5,

    execute: async (message, args) => {
        const userId = message.author.id;
        const guildId = message.guild.id;

        try {
            const amount = parseInt(args[0]);
            const betInput = args[1]?.toLowerCase();

            if (!amount || isNaN(amount)) {
                const prefix = await getPrefix(guildId);
                return message.reply({
                    embeds: [await errorEmbed(guildId, 'Probability Analysis',
                        `Please provide a valid wager, Master.\n\n` +
                        `**Syntax:** \`${prefix}roulette <amount> <bet>\`\n` +
                        wagerGuide(prefix)
                    )]
                });
            }

            if (!betInput) {
                const prefix = await getPrefix(guildId);
                return message.reply({
                    embeds: [await errorEmbed(guildId, 'Selection Required',
                        `Please specify your prediction, Master.\n\n` + wagerGuide(prefix)
                    )]
                });
            }

            const bet = parseBet(betInput);
            if (!bet) {
                const prefix = await getPrefix(guildId);
                return message.reply({
                    embeds: [await errorEmbed(guildId, 'Invalid Selection',
                        `Unrecognized wager parameter, Master.\n\n` + wagerGuide(prefix)
                    )]
                });
            }

            if (amount < ROULETTE_MIN) {
                return message.reply({
                    embeds: [await errorEmbed(guildId, 'Wager Threshold', `Minimum wager is **${formatNumber(ROULETTE_MIN)}** coins, Master.`)]
                });
            }

            if (amount > ROULETTE_MAX) {
                return message.reply({
                    embeds: [await errorEmbed(guildId, 'Wager Exceeded', `Maximum wager is **${formatNumber(ROULETTE_MAX)}** coins, Master.`)]
                });
            }

            const guildConfig = await Guild.getGuild(guildId);
            const economy = await Economy.getEconomy(userId, guildId);
            const coinName = guildConfig.economy?.coinName || DEFAULT_COIN_NAME;

            if (economy.coins < amount) {
                return message.reply({
                    embeds: [await errorEmbed(guildId, 'Resource Deficit',
                        `Insufficient ${coinName}, Master.\n\n` +
                        `▸ **Current Balance:** ${formatNumber(economy.coins)} ${coinName}\n` +
                        `▸ **Wager Amount:** ${formatNumber(amount)} ${coinName}`
                    )]
                });
            }

            // Spin the wheel
            const result = Math.floor(Math.random() * (MAX_NUMBER + 1)); // 0-36
            const resultColor = getColor(result);

            const won = bet.type === 'color' ? bet.color === resultColor : bet.number === result;
            const multiplier = won ? ROULETTE_PAYOUTS[bet.type] : 0;
            const winnings = amount * multiplier;
            const netGain = winnings - amount;

            // Stats first, so the single save inside addCoins/removeCoins records them too
            if (won) {
                economy.gamblingWins = (economy.gamblingWins || 0) + 1;
            } else {
                economy.gamblingLosses = (economy.gamblingLosses || 0) + 1;
            }
            economy.gamblingTotal = (economy.gamblingTotal || 0) + amount;

            if (won) {
                await economy.addCoins(netGain, `Roulette win (${multiplier}x)`);
            } else {
                await economy.removeCoins(amount, 'Roulette loss');
            }

            const embed = new EmbedBuilder()
                .setTitle('『 Probability Wheel 』')
                .setDescription(
                    `▸ **Your Prediction:** ${describeBet(bet)}\n` +
                    `▸ **Result:** **${COLOR_NAMES[resultColor]} ${result}**\n\n` +
                    (won
                        ? `◉ **PREDICTION CORRECT**\n\n▸ **Multiplier:** ${multiplier}x\n▸ **Winnings:** +${formatNumber(winnings)} ${coinName}\n▸ **Net Profit:** +${formatNumber(netGain)} ${coinName}`
                        : `◆ **PREDICTION FAILED**\n\n▸ **Loss:** -${formatNumber(amount)} ${coinName}`)
                )
                .addFields({ name: '▸ Updated Balance', value: `**${formatNumber(economy.coins)}** ${coinName}` })
                .setColor(won ? COLORS.RAPHAEL_SUCCESS : COLORS.RAPHAEL_ERROR)
                .setThumbnail(message.author.displayAvatarURL({ extension: 'png' }))
                .setFooter({ text: `${getRandomFooter()} | Record: ${economy.gamblingWins || 0}W / ${economy.gamblingLosses || 0}L` })
                .setTimestamp();

            await message.reply({ embeds: [embed] });

        } catch (error) {
            console.error('[Roulette] Error:', error);
            return message.reply({
                embeds: [await errorEmbed(guildId, 'System Error', 'Probability calculation failed, Master. Please retry.')]
            }).catch(() => {});
        }
    }
};
