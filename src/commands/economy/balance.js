import { EmbedBuilder } from 'discord.js';
import Economy from '../../models/Economy.js';
import Guild from '../../models/Guild.js';
import { DEFAULT_COIN_NAME } from '../../utils/gameConfig.js';
import { errorEmbed, COLORS } from '../../utils/embeds.js';
import { formatNumber } from '../../utils/helpers.js';
import { getRandomFooter } from '../../utils/raphael.js';

export default {
    name: 'balance',
    description: 'Retrieve financial status report, Master',
    usage: 'balance [@user]',
    category: 'economy',
    aliases: ['bal', 'coins', 'money', 'wallet'],
    cooldown: 3,

    execute: async (message, args) => {
        const targetUser = message.mentions.users.first() || message.author;
        const userId = targetUser.id;
        const guildId = message.guild.id;

        try {
            const economy = await Economy.getEconomy(userId, guildId);
            const guildConfig = await Guild.getGuild(guildId);
            const coinName = guildConfig.economy?.coinName || DEFAULT_COIN_NAME;

            const isSelf = targetUser.id === message.author.id;

            const embed = new EmbedBuilder()
                .setColor(COLORS.RAPHAEL)
                .setAuthor({
                    name: targetUser.tag,
                    iconURL: targetUser.displayAvatarURL()
                })
                .setTitle('『 Financial Report 』')
                .setDescription(`**Analysis complete.** ${isSelf ? 'Your' : `${targetUser.username}'s`} economic status has been retrieved${isSelf ? ', Master' : ''}.`)
                .addFields(
                    {
                        name: '▸ Total Assets',
                        value: `**${formatNumber(economy.coins + economy.bank)}** ${coinName}`,
                        inline: true
                    }
                )
                .setFooter({ text: `${getRandomFooter()} | Earned: ${formatNumber(economy.stats.totalEarned)} | Spent: ${formatNumber(economy.stats.totalSpent)}` })
                .setTimestamp();

            await message.reply({ embeds: [embed] });

        } catch (error) {
            console.error('[Balance] Error:', error);
            return message.reply({
                embeds: [await errorEmbed(guildId, 'Retrieval Error', 'An anomaly occurred while retrieving financial data. Please try again, Master.')]
            }).catch(() => {});
        }
    }
};
