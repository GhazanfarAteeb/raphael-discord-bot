import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits } from 'discord.js';
import { errorEmbed, infoEmbed, GLYPHS } from '../../utils/embeds.js';

export default {
    name: 'firstmessage',
    aliases: ['firstmsg', 'fm', 'oldestmessage'],
    description: 'Retrieve the earliest message record in a channel, Master',
    usage: 'firstmessage [#channel]',
    category: 'utility',
    cooldown: 10,
    
    async execute(message, args, client) {
        const guildId = message.guild.id;
        
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
        if (!channel.permissionsFor(message.member)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory])) {
            return message.reply({
                embeds: [await errorEmbed(guildId, 'Access Denied', 'You lack access to the history of that channel, Master.')]
            });
        }
        
        try {
            const statusMsg = await message.reply({
                content: `**Notice:** Scanning channel ${channel} for earliest message record, Master...`
            });
            
            // Fetch the first message (oldest)
            const messages = await channel.messages.fetch({ after: '0', limit: 1 });
            
            if (messages.size === 0) {
                return statusMsg.edit({
                    content: null,
                    embeds: [await errorEmbed(guildId, '**Notice:** No message records detected in this channel, Master.')]
                });
            }
            
            const firstMessage = messages.first();
            
            // Create embed
            const embed = new EmbedBuilder()
                .setTitle(`『 Archive Record: #${channel.name} 』`)
                .setColor('#5865F2')
                .setDescription(firstMessage.content?.substring(0, 1024) || '*No text content*')
                .addFields(
                    {
                        name: '👤 Author',
                        value: `${firstMessage.author?.tag || 'Unknown'} (<@${firstMessage.author?.id || 'Unknown'}>)`,
                        inline: true
                    },
                    {
                        name: '📅 Sent',
                        value: `<t:${Math.floor(firstMessage.createdTimestamp / 1000)}:F>\n(<t:${Math.floor(firstMessage.createdTimestamp / 1000)}:R>)`,
                        inline: true
                    }
                )
                .setFooter({ text: `Message ID: ${firstMessage.id}` })
                .setTimestamp();
            
            // Add author avatar if available
            if (firstMessage.author) {
                embed.setThumbnail(firstMessage.author.displayAvatarURL({ extension: 'png', size: 128 }));
            }
            
            // Add attachment info if present
            if (firstMessage.attachments.size > 0) {
                embed.addFields({
                    name: '📎 Attachments',
                    value: `${firstMessage.attachments.size} attachment${firstMessage.attachments.size !== 1 ? 's' : ''}`,
                    inline: true
                });
            }
            
            // Add embed count if present
            if (firstMessage.embeds.length > 0) {
                embed.addFields({
                    name: '📦 Embeds',
                    value: `${firstMessage.embeds.length} embed${firstMessage.embeds.length !== 1 ? 's' : ''}`,
                    inline: true
                });
            }
            
            // Create button to jump to message
            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setLabel('Jump to Message')
                    .setStyle(ButtonStyle.Link)
                    .setURL(firstMessage.url)
                    .setEmoji('🔗')
            );
            
            await statusMsg.edit({
                content: null,
                embeds: [embed],
                components: [row]
            });
            
        } catch (error) {
            console.error('First message error:', error);
            return message.reply({
                embeds: [await errorEmbed(guildId, '**Warning:** Message retrieval failed, Master. Possible cause: insufficient channel access permissions.')]
            });
        }
    }
};
