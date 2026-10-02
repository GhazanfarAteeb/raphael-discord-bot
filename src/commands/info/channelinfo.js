import { EmbedBuilder, ChannelType } from 'discord.js';
import { errorEmbed, COLORS } from '../../utils/embeds.js';
import { getPrefix, truncate } from '../../utils/helpers.js';
import { getRandomFooter } from '../../utils/raphael.js';

const CHANNEL_TYPES = {
    [ChannelType.GuildText]: '◇ Text Channel',
    [ChannelType.GuildVoice]: '◇ Voice Channel',
    [ChannelType.GuildCategory]: '◇ Category',
    [ChannelType.GuildAnnouncement]: '◇ Announcement Channel',
    [ChannelType.AnnouncementThread]: '◇ Announcement Thread',
    [ChannelType.PublicThread]: '◇ Public Thread',
    [ChannelType.PrivateThread]: '◇ Private Thread',
    [ChannelType.GuildStageVoice]: '◇ Stage Channel',
    [ChannelType.GuildForum]: '◇ Forum Channel',
    [ChannelType.GuildMedia]: '◇ Media Channel'
};

export default {
    name: 'channelinfo',
    aliases: ['ci', 'channel'],
    description: 'Retrieve analytical data on a channel, Master',
    usage: '[#channel|channel_id]',
    category: 'info',
    cooldown: 3,

    async execute(message, args) {
        const guildId = message.guild.id;

        try {
            // No argument means the current channel; an argument that matches nothing is an error
            let channel = message.channel;
            if (args[0]) {
                channel = message.mentions.channels.first()
                    || message.guild.channels.cache.get(args[0].replace(/[<#>]/g, ''));

                if (!channel) {
                    const prefix = await getPrefix(guildId);
                    return message.reply({
                        embeds: [await errorEmbed(guildId, 'Channel Not Found',
                            `**Warning:** Unable to locate that channel, Master.\n\n**Usage:** \`${prefix}channelinfo [#channel|channel_id]\``)]
                    });
                }
            }

            const embed = new EmbedBuilder()
                .setTitle(`『 #${truncate(channel.name, 200)} Analysis 』`)
                .setColor(COLORS.RAPHAEL)
                .addFields({
                    name: '▸ General',
                    value: [
                        `**Identifier:** \`${channel.id}\``,
                        `**Type:** ${CHANNEL_TYPES[channel.type] || 'Unknown Channel'}`,
                        `**Created:** <t:${Math.floor(channel.createdTimestamp / 1000)}:D>`,
                        `**Position:** ${channel.position !== undefined ? channel.position + 1 : 'N/A'}`
                    ].join('\n'),
                    inline: true
                })
                .setFooter({ text: getRandomFooter() })
                .setTimestamp();

            if (channel.parent) {
                embed.addFields({ name: '▸ Category', value: truncate(channel.parent.name, 1024), inline: true });
            }

            if (channel.type === ChannelType.GuildText || channel.type === ChannelType.GuildAnnouncement) {
                embed.addFields({
                    name: '▸ Configuration',
                    value: [
                        `**NSFW:** ${channel.nsfw ? '◉' : '◇'}`,
                        `**Slowmode:** ${channel.rateLimitPerUser ? `${channel.rateLimitPerUser}s` : 'Disabled'}`,
                        `**Topic:** ${channel.topic ? truncate(channel.topic, 100) : 'None'}`
                    ].join('\n'),
                    inline: false
                });
            }

            if (channel.type === ChannelType.GuildVoice || channel.type === ChannelType.GuildStageVoice) {
                const membersInVoice = channel.members?.size || 0;
                embed.addFields({
                    name: '▸ Audio Configuration',
                    value: [
                        `**Bitrate:** ${channel.bitrate / 1000}kbps`,
                        `**User Limit:** ${channel.userLimit || 'Unlimited'}`,
                        `**Region:** ${channel.rtcRegion || 'Automatic'}`,
                        `**Connected:** ${membersInVoice} member${membersInVoice !== 1 ? 's' : ''}`
                    ].join('\n'),
                    inline: false
                });

                if (membersInVoice > 0 && membersInVoice <= 10) {
                    embed.addFields({
                        name: '▸ Connected Members',
                        value: channel.members.map(m => m.user.tag).join(', '),
                        inline: false
                    });
                }
            }

            if (channel.type === ChannelType.GuildForum) {
                const tags = channel.availableTags?.map(t => t.name).join(', ') || 'None';
                embed.addFields({
                    name: '▸ Forum Settings',
                    value: [
                        `**Default Layout:** ${channel.defaultForumLayout === 1 ? 'List' : 'Gallery'}`,
                        `**Tags:** ${truncate(tags, 100)}`,
                        `**Post Slowmode:** ${channel.defaultThreadRateLimitPerUser ? `${channel.defaultThreadRateLimitPerUser}s` : 'Off'}`
                    ].join('\n'),
                    inline: false
                });
            }

            if (channel.isThread()) {
                embed.addFields({
                    name: '▸ Thread Info',
                    value: [
                        `**Parent:** <#${channel.parentId}>`,
                        `**Owner:** <@${channel.ownerId}>`,
                        `**Archived:** ${channel.archived ? '◉' : '◇'}`,
                        `**Locked:** ${channel.locked ? '◉' : '◇'}`,
                        `**Members:** ${channel.memberCount || 'Unknown'}`
                    ].join('\n'),
                    inline: false
                });
            }

            if (channel.permissionOverwrites) {
                const overwrites = channel.permissionOverwrites.cache;
                const roleOverwrites = overwrites.filter(o => o.type === 0).size;
                const memberOverwrites = overwrites.filter(o => o.type === 1).size;

                embed.addFields({
                    name: '▸ Permissions',
                    value: `${roleOverwrites} role${roleOverwrites !== 1 ? 's' : ''}, ${memberOverwrites} member${memberOverwrites !== 1 ? 's' : ''} with custom permissions`,
                    inline: false
                });
            }

            return message.reply({ embeds: [embed] });
        } catch (error) {
            console.error('[channelinfo] Error:', error);
            return message.reply({
                embeds: [await errorEmbed(guildId, 'Analysis Failed', 'I was unable to analyse that channel, Master.')]
            });
        }
    }
};
