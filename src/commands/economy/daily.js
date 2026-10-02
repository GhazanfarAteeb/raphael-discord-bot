import { EmbedBuilder } from 'discord.js';
import Economy from '../../models/Economy.js';
import Guild from '../../models/Guild.js';
import { DEFAULT_COIN_NAME } from '../../utils/gameConfig.js';
import { errorEmbed, COLORS } from '../../utils/embeds.js';
import { formatNumber } from '../../utils/helpers.js';
import { getRandomFooter } from '../../utils/raphael.js';

const DAILY_INTERVAL_MS = 24 * 60 * 60 * 1000;
const days = (count) => `${count} day${count === 1 ? '' : 's'}`;

export default {
    name: 'daily',
    description: 'Claim your daily resource allocation, Master',
    usage: 'daily',
    category: 'economy',
    aliases: ['dailyreward'],
    cooldown: 3,

    execute: async (message, args) => {
        const userId = message.author.id;
        const guildId = message.guild.id;

        try {
            const economy = await Economy.getEconomy(userId, guildId);
            const guildConfig = await Guild.getGuild(guildId);
            const coinName = guildConfig.economy?.coinName || DEFAULT_COIN_NAME;

            let result;
            try {
                result = await economy.claimDaily();
            } catch (error) {
                if (error.code !== 'COOLDOWN') throw error;

                const embed = new EmbedBuilder()
                    .setColor(COLORS.RAPHAEL_WARNING)
                    .setTitle('『 Temporal Restriction 』')
                    .setDescription(
                        `Today's allocation has already been claimed, Master.\n\n` +
                        `▸ **Next Allocation:** <t:${Math.floor(error.availableAt.getTime() / 1000)}:R>\n\n` +
                        `*Patience is a virtue, Master. Return when the temporal window reopens.*`
                    )
                    .setFooter({ text: getRandomFooter() })
                    .setTimestamp();

                return message.reply({ embeds: [embed] });
            }

            const nextClaim = Math.floor((Date.now() + DAILY_INTERVAL_MS) / 1000);

            const embed = new EmbedBuilder()
                .setColor(COLORS.RAPHAEL)
                .setAuthor({
                    name: message.author.tag,
                    iconURL: message.author.displayAvatarURL()
                })
                .setTitle('『 Daily Allocation 』')
                .setDescription(
                    `Daily resource allocation complete, Master.\n\n` +
                    `You have received **${formatNumber(result.amount)}** ${coinName}. ` +
                    `The next allocation becomes available <t:${nextClaim}:R>.`
                )
                .addFields(
                    {
                        name: '▸ Breakdown',
                        value: `Base Allocation: **${formatNumber(result.baseReward)}** ${coinName}\n` +
                               `Consistency Bonus: **+${formatNumber(result.streakBonus)}** ${coinName}`,
                        inline: true
                    },
                    {
                        name: '▸ Streak Data',
                        value: `Current: **${days(result.streak)}**\n` +
                               `Record: **${days(economy.daily.longestStreak)}**`,
                        inline: true
                    },
                    {
                        name: '▸ Updated Balance',
                        value: `**${formatNumber(economy.coins)}** ${coinName}`,
                        inline: true
                    }
                )
                .setFooter({ text: getRandomFooter() })
                .setTimestamp();

            // Add streak milestone messages - Raphael style
            if (result.streak === 7) {
                embed.addFields({
                    name: '◈ Weekly Milestone Achieved',
                    value: '*Impressive dedication detected. A 7-day consistency record has been logged, Master.*',
                    inline: false
                });
            } else if (result.streak === 30) {
                embed.addFields({
                    name: '◈ Monthly Achievement Unlocked',
                    value: '*Extraordinary. 30 consecutive days of activity recorded. Your commitment is... admirable, Master.*',
                    inline: false
                });
            } else if (result.streak === 100) {
                embed.addFields({
                    name: '◈ Legendary Status Confirmed',
                    value: '*Remarkable. 100 days of unwavering dedication. This level of commitment exceeds all parameters, Master.*',
                    inline: false
                });
            }

            await message.reply({ embeds: [embed] });

        } catch (error) {
            console.error('[Daily] Error:', error);
            return message.reply({
                embeds: [await errorEmbed(guildId, 'Allocation Error', 'An anomaly occurred during resource allocation. Please try again, Master.')]
            }).catch(() => {});
        }
    }
};
