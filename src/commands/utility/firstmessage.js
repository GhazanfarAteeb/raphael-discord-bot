import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits } from 'discord.js';
import { COLORS, errorEmbed, infoEmbed } from '../../utils/embeds.js';
import { getRandomFooter } from '../../utils/raphael.js';

const READ_PERMISSIONS = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory];
const PREVIEW_LENGTH = 1024;

export default {
    name: 'firstmessage',
    aliases: ['firstmsg', 'fm', 'oldestmessage'],
    description: 'Retrieve the earliest message record in a channel, Master',
    usage: 'firstmessage [#channel]',
    category: 'utility',
    cooldown: 10,

    async execute(message, args, client) {
        const guildId = message.guild.id;
        let statusMsg = null;

        try {
            // Get target channel
            const channel = message.mentions.channels.first()
                || message.guild.channels.cache.get(args[0])
                || message.channel;

            // Check if it's a text-based channel
            if (!channel.isTextBased()) {
                return message.reply({
                    embeds: [await errorEmbed(guildId, '**Notice:** This function is restricted to text-based channels, Master.')]
                });
            }

            // Only reveal history the requester could read themselves (no peeking into private channels)
            if (!channel.permissionsFor(message.member)?.has(READ_PERMISSIONS)) {
                return message.reply({
                    embeds: [await errorEmbed(guildId, 'Access Denied', 'You lack access to the history of that channel, Master.')]
                });
            }

            // The bot needs the same access to read the history
            if (!channel.permissionsFor(message.guild.members.me)?.has(READ_PERMISSIONS)) {
                return message.reply({
                    embeds: [await errorEmbed(guildId, 'Access Denied', `I lack the View Channel or Read Message History permission in ${channel}, Master.`)]
                });
            }

            statusMsg = await message.reply({
                embeds: [await infoEmbed(guildId, 'Archive Scan', `**Notice:** Scanning ${channel} for the earliest message record, Master...`)]
            });

            // Fetch the first message (oldest)
            const messages = await channel.messages.fetch({ after: '0', limit: 1 });

            if (messages.size === 0) {
                return statusMsg.edit({
                    embeds: [await errorEmbed(guildId, '**Notice:** No message records detected in this channel, Master.')]
                });
            }

            const firstMessage = messages.first();
            const sentAt = Math.floor(firstMessage.createdTimestamp / 1000);
            const author = firstMessage.author;

            const embed = new EmbedBuilder()
                .setTitle(`『 Archive Record: #${channel.name} 』`)
                .setColor(COLORS.RAPHAEL)
                .setDescription(firstMessage.content?.substring(0, PREVIEW_LENGTH) || '*No text content*')
                .addFields(
                    {
                        name: '▸ Author',
                        value: author ? `${author.tag} (<@${author.id}>)` : 'Unknown',
                        inline: true
                    },
                    {
                        name: '▸ Sent',
                        value: `<t:${sentAt}:F>\n(<t:${sentAt}:R>)`,
                        inline: true
                    },
                    {
                        name: '▸ Message ID',
                        value: firstMessage.id,
                        inline: true
                    }
                )
                .setFooter({ text: getRandomFooter() })
                .setTimestamp();

            // Add author avatar if available
            if (author) {
                embed.setThumbnail(author.displayAvatarURL({ extension: 'png', size: 128 }));
            }

            // Add attachment info if present
            if (firstMessage.attachments.size > 0) {
                embed.addFields({
                    name: '▸ Attachments',
                    value: `${firstMessage.attachments.size} attachment${firstMessage.attachments.size !== 1 ? 's' : ''}`,
                    inline: true
                });
            }

            // Add embed count if present
            if (firstMessage.embeds.length > 0) {
                embed.addFields({
                    name: '▸ Embeds',
                    value: `${firstMessage.embeds.length} embed${firstMessage.embeds.length !== 1 ? 's' : ''}`,
                    inline: true
                });
            }

            // Link button to jump to the message
            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setLabel('Jump to Message')
                    .setStyle(ButtonStyle.Link)
                    .setURL(firstMessage.url)
            );

            await statusMsg.edit({
                embeds: [embed],
                components: [row]
            });

        } catch (error) {
            console.error('First message error:', error);
            try {
                const payload = {
                    embeds: [await errorEmbed(guildId, '**Warning:** Message retrieval failed, Master. Possible cause: insufficient channel access permissions.')],
                    components: []
                };
                // Replace the scan notice if it was sent, so it does not stay stuck on "Scanning..."
                if (statusMsg) await statusMsg.edit(payload);
                else await message.reply(payload);
            } catch {
                // Reply failed too (message deleted or no permission); nothing more to do
            }
        }
    }
};
