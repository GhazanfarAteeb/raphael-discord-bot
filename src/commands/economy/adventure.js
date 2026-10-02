import { EmbedBuilder } from 'discord.js';
import Economy from '../../models/Economy.js';
import Guild from '../../models/Guild.js';
import { ADVENTURE_NPCS, ADVENTURE_REWARDS, ADVENTURE_COOLDOWN, ADVENTURE_MESSAGES, DEFAULT_COIN_NAME } from '../../utils/gameConfig.js';
import { errorEmbed, COLORS } from '../../utils/embeds.js';
import { formatNumber } from '../../utils/helpers.js';
import { getRandomFooter } from '../../utils/raphael.js';

const MAX_TRANSACTIONS = 50;
const randomItem = (list) => list[Math.floor(Math.random() * list.length)];

async function cooldownReply(message, guildId, lastAdventure) {
    const availableAt = Math.floor((new Date(lastAdventure).getTime() + ADVENTURE_COOLDOWN * 1000) / 1000);
    return message.reply({
        embeds: [await errorEmbed(guildId, 'Expedition Cooldown',
            `The expedition protocol is still recharging, Master. You may embark again <t:${availableAt}:R>.`
        )]
    });
}

export default {
    name: 'adventure',
    description: 'Embark on an expedition to acquire resources, Master',
    usage: 'adventure',
    category: 'economy',
    aliases: ['adv', 'quest'],
    cooldown: 3,

    execute: async (message, args) => {
        const userId = message.author.id;
        const guildId = message.guild.id;

        try {
            const guildConfig = await Guild.getGuild(guildId);
            const economy = await Economy.getEconomy(userId, guildId);
            const cooldownMs = ADVENTURE_COOLDOWN * 1000;

            // Quick check for a friendly message; the update below is what actually enforces it
            if (economy.lastAdventure && Date.now() - economy.lastAdventure.getTime() < cooldownMs) {
                return cooldownReply(message, guildId, economy.lastAdventure);
            }

            // Random coin reward
            const reward = Math.floor(Math.random() * (ADVENTURE_REWARDS.max - ADVENTURE_REWARDS.min + 1)) + ADVENTURE_REWARDS.min;

            // Random NPC and outcome
            const npcList = guildConfig.economy?.adventureNPCs?.length > 0
                ? guildConfig.economy.adventureNPCs
                : ADVENTURE_NPCS;
            const npc = randomItem(npcList);
            const adventureMsg = randomItem(ADVENTURE_MESSAGES);

            // One conditional update: the cooldown, the reward and the stats land together, and
            // only if the cooldown has elapsed (two adventures at once can't both pay).
            // __v is bumped so a stale copy of this document elsewhere can't save over the new balance.
            const now = new Date();
            const updated = await Economy.findOneAndUpdate(
                {
                    userId,
                    guildId,
                    $or: [{ lastAdventure: null }, { lastAdventure: { $lte: new Date(now.getTime() - cooldownMs) } }]
                },
                {
                    $set: { lastAdventure: now },
                    $inc: { coins: reward, 'stats.totalEarned': reward, adventuresCompleted: 1, __v: 1 },
                    $push: {
                        transactions: {
                            $each: [{ type: 'earn', amount: reward, description: 'Adventure reward', timestamp: now }],
                            $position: 0,
                            $slice: MAX_TRANSACTIONS
                        }
                    }
                },
                { new: true }
            );

            if (!updated) {
                // Another adventure claimed the slot first
                const latest = await Economy.findOne({ userId, guildId }).select('lastAdventure').lean();
                return cooldownReply(message, guildId, latest?.lastAdventure ?? now);
            }

            const coinName = guildConfig.economy?.coinName || DEFAULT_COIN_NAME;
            const adventurer = message.member?.displayName || message.author.username;

            const embed = new EmbedBuilder()
                .setColor(COLORS.RAPHAEL_SUCCESS)
                .setTitle('『 Expedition Report 』')
                .setDescription(
                    `**${adventurer}** ${adventureMsg}.\n\n` +
                    `Resources acquired from **${npc}**: **${formatNumber(reward)}** ${coinName}, Master.`
                )
                .addFields(
                    { name: '▸ Updated Balance', value: `**${formatNumber(updated.coins)}** ${coinName}`, inline: true },
                    { name: '▸ Expeditions Completed', value: `**${formatNumber(updated.adventuresCompleted)}**`, inline: true },
                    { name: '▸ Next Expedition', value: `<t:${Math.floor((now.getTime() + cooldownMs) / 1000)}:R>`, inline: true }
                )
                .setThumbnail(message.author.displayAvatarURL({ extension: 'png' }))
                .setFooter({ text: getRandomFooter() })
                .setTimestamp();

            await message.reply({ embeds: [embed] });

        } catch (error) {
            console.error('[Adventure] Error:', error);
            return message.reply({
                embeds: [await errorEmbed(guildId, 'Expedition Error', 'An anomaly occurred during expedition processing, Master. Please retry.')]
            }).catch(() => {});
        }
    }
};
