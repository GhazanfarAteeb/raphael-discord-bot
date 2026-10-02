import { ChannelType } from 'discord.js';
import { infoEmbed, errorEmbed } from '../../utils/embeds.js';
import { formatNumber } from '../../utils/helpers.js';
import { getRandomFooter } from '../../utils/raphael.js';

const FEATURES_SHOWN = 10;

const TEXT_TYPES = [ChannelType.GuildText];
const VOICE_TYPES = [ChannelType.GuildVoice];

export default {
    name: 'serverinfo',
    description: 'Get information about the server',
    usage: '',
    aliases: ['server', 'guild', 'guildinfo'],
    category: 'info',
    cooldown: 5,

    async execute(message) {
        const guild = message.guild;

        try {
            const embed = await infoEmbed(guild.id, 'Server Analysis',
                `**Report:** Comprehensive data compiled for **${guild.name}**, Master.`
            );

            embed.addFields({
                name: '▸ Core Data',
                value:
                    `**Designation:** ${guild.name}\n` +
                    `**Identifier:** \`${guild.id}\`\n` +
                    `**Owner:** <@${guild.ownerId}>\n` +
                    `**Established:** <t:${Math.floor(guild.createdTimestamp / 1000)}:D>`,
                inline: false
            });

            // memberCount comes with the guild; bots are counted from the member cache rather
            // than downloading every member (slow, and it can time out on large servers)
            const total = guild.memberCount;
            const cachedBots = guild.members.cache.filter(m => m.user.bot).size;
            const cacheComplete = guild.members.cache.size >= total;
            const approx = cacheComplete ? '' : '~';

            const channels = guild.channels.cache;
            const countOf = (types) => channels.filter(c => types.includes(c.type)).size;

            embed.addFields({
                name: '▸ Population Metrics',
                value:
                    `**Total Entities:** ${formatNumber(total)}\n` +
                    `◇ Organic Users: ${approx}${formatNumber(Math.max(total - cachedBots, 0))}\n` +
                    `◇ Automated Systems: ${cacheComplete ? '' : 'at least '}${formatNumber(cachedBots)}\n` +
                    `**Authority Levels:** ${guild.roles.cache.size}\n` +
                    `**Custom Expressions:** ${guild.emojis.cache.size}`,
                inline: true
            });

            embed.addFields({
                name: '▸ Communication Channels',
                value:
                    `**Total:** ${channels.size}\n` +
                    `◇ Text: ${countOf(TEXT_TYPES)}\n` +
                    `◇ Announcement: ${countOf([ChannelType.GuildAnnouncement])}\n` +
                    `◇ Forum and Media: ${countOf([ChannelType.GuildForum, ChannelType.GuildMedia])}\n` +
                    `◇ Voice: ${countOf(VOICE_TYPES)}\n` +
                    `◇ Stage: ${countOf([ChannelType.GuildStageVoice])}\n` +
                    `◇ Categories: ${countOf([ChannelType.GuildCategory])}`,
                inline: true
            });

            const features = guild.features.map(f =>
                f.split('_').map(w => w.charAt(0) + w.slice(1).toLowerCase()).join(' ')
            );

            if (features.length > 0) {
                const extra = features.length > FEATURES_SHOWN ? `\n+${features.length - FEATURES_SHOWN} more` : '';
                embed.addFields({
                    name: '▸ Enabled Capabilities',
                    value: features.slice(0, FEATURES_SHOWN).map(f => `◇ ${f}`).join('\n') + extra,
                    inline: false
                });
            }

            if (guild.premiumTier > 0) {
                embed.addFields({
                    name: '▸ Enhancement Status',
                    value:
                        `**Tier Classification:** ${guild.premiumTier}\n` +
                        `**Active Enhancements:** ${guild.premiumSubscriptionCount || 0}`,
                    inline: false
                });
            }

            if (guild.icon) {
                embed.setThumbnail(guild.iconURL({ dynamic: true, size: 256 }));
            }

            if (guild.banner) {
                embed.setImage(guild.bannerURL({ size: 1024 }));
            }

            embed.setFooter({ text: getRandomFooter() });

            return message.reply({ embeds: [embed] });
        } catch (error) {
            console.error('[serverinfo] Error:', error);
            return message.reply({
                embeds: [await errorEmbed(guild.id, 'Analysis Failed', 'I was unable to compile the server data, Master.')]
            });
        }
    }
};
