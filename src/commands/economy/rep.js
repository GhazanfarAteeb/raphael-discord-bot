import { EmbedBuilder } from 'discord.js';
import Economy from '../../models/Economy.js';
import { REPUTATION_COOLDOWN, REPUTATION_AMOUNT } from '../../utils/gameConfig.js';
import { errorEmbed, COLORS } from '../../utils/embeds.js';
import { getPrefix, formatNumber } from '../../utils/helpers.js';
import { getRandomFooter } from '../../utils/raphael.js';

const COOLDOWN_MS = REPUTATION_COOLDOWN * 1000;

function formatCooldown(seconds) {
    const hours = seconds / 3600;
    if (Number.isInteger(hours)) return `${hours} hour${hours === 1 ? '' : 's'}`;
    const minutes = Math.ceil(seconds / 60);
    return `${minutes} minute${minutes === 1 ? '' : 's'}`;
}

// Records that `userId` acknowledged `targetId` now, but only if the per-target cooldown has
// elapsed. Each branch is a single conditional update, so two commands at once can't both pass.
// (The giver's `reputationReceived` list holds who they gave reputation to.)
async function claimCooldown(userId, guildId, targetId, now) {
    const cutoff = new Date(now.getTime() - COOLDOWN_MS);

    const renewed = await Economy.updateOne(
        {
            userId,
            guildId,
            reputationReceived: {
                $elemMatch: { userId: targetId, $or: [{ timestamp: { $lte: cutoff } }, { timestamp: null }] }
            }
        },
        { $set: { 'reputationReceived.$.timestamp': now } }
    );
    if (renewed.modifiedCount > 0) return true;

    const first = await Economy.updateOne(
        { userId, guildId, 'reputationReceived.userId': { $ne: targetId } },
        { $push: { reputationReceived: { userId: targetId, timestamp: now } } }
    );
    return first.modifiedCount > 0;
}

export default {
    name: 'rep',
    description: 'Give reputation to someone',
    usage: 'rep <@user>',
    category: 'economy',
    aliases: ['reputation', 'giverep'],
    cooldown: 3,

    execute: async (message, args) => {
        const userId = message.author.id;
        const guildId = message.guild.id;

        try {
            const targetUser = message.mentions.users.first();

            if (!targetUser) {
                const prefix = await getPrefix(guildId);
                return message.reply({
                    embeds: [await errorEmbed(guildId, 'Target Required', `Please specify a user to acknowledge, Master.\n\n**Syntax:** \`${prefix}rep @user\``)]
                });
            }

            if (targetUser.id === userId) {
                return message.reply({
                    embeds: [await errorEmbed(guildId, 'Invalid Operation', 'Self-acknowledgment is not permitted, Master.')]
                });
            }

            if (targetUser.bot) {
                return message.reply({
                    embeds: [await errorEmbed(guildId, 'Invalid Target', 'Automated systems cannot receive reputation, Master.')]
                });
            }

            // Make sure both documents exist before the conditional updates below
            await Economy.getEconomy(userId, guildId);
            await Economy.getEconomy(targetUser.id, guildId);

            const now = new Date();
            if (!(await claimCooldown(userId, guildId, targetUser.id, now))) {
                const giver = await Economy.findOne({ userId, guildId }).select('reputationReceived').lean();
                const lastGiven = giver?.reputationReceived?.find(r => r.userId === targetUser.id)?.timestamp ?? now;
                const availableAt = Math.floor((new Date(lastGiven).getTime() + COOLDOWN_MS) / 1000);
                return message.reply({
                    embeds: [await errorEmbed(guildId, 'Cooldown Active',
                        `You recently acknowledged **${targetUser.username}**, Master.\n\n` +
                        `▸ **Available Again:** <t:${availableAt}:R>`
                    )]
                });
            }

            // Atomic increment: concurrent grants from different members all count
            const receiver = await Economy.findOneAndUpdate(
                { userId: targetUser.id, guildId },
                {
                    $inc: { reputation: REPUTATION_AMOUNT },
                    $push: { reputationGiven: { userId, timestamp: now } }
                },
                { new: true }
            );

            const embed = new EmbedBuilder()
                .setColor(COLORS.RAPHAEL)
                .setTitle('『 Reputation Acknowledged 』')
                .setDescription(
                    `${message.author} has granted **+${formatNumber(REPUTATION_AMOUNT)} reputation** to ${targetUser}.\n\n` +
                    `▸ **${targetUser.username}'s Reputation:** ${formatNumber(receiver?.reputation ?? REPUTATION_AMOUNT)}`
                )
                .setThumbnail(targetUser.displayAvatarURL({ extension: 'png' }))
                .setFooter({ text: `${getRandomFooter()} | Cooldown: ${formatCooldown(REPUTATION_COOLDOWN)} per member` })
                .setTimestamp();

            await message.reply({ embeds: [embed] });

        } catch (error) {
            console.error('[Rep] Error:', error);
            return message.reply({
                embeds: [await errorEmbed(guildId, 'Reputation Error', 'An anomaly occurred while granting reputation. Please try again later, Master.')]
            }).catch(() => {});
        }
    }
};
