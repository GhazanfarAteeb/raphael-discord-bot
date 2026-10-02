import { PermissionFlagsBits, EmbedBuilder } from 'discord.js';
import EmbedTemplate from '../../models/EmbedTemplate.js';
import { errorEmbed, successEmbed } from '../../utils/embeds.js';
import { getPrefix } from '../../utils/helpers.js';

export default {
    name: 'embed',
    description: 'Create and manage custom embeds',
    usage: 'embed <create/edit/delete/list/send/preview> [args]',
    category: 'utility',
    permissions: [PermissionFlagsBits.ManageMessages],
    
    execute: async (message, args) => {
        const guildId = message.guild.id;
        const action = args[0]?.toLowerCase();
        
        if (!action) {
            return message.reply({
                embeds: [await errorEmbed(guildId, 'Please specify an action: `create`, `edit`, `delete`, `list`, `send`, or `preview`')]
            });
        }
        
        // List all embeds
        if (action === 'list') {
            const templates = await EmbedTemplate.find({ guildId });
            const prefix = await getPrefix(guildId);
            
            if (templates.length === 0) {
                return message.reply({
                    embeds: [await errorEmbed(guildId, `No custom embeds found! Create one with \`${prefix}embed create\``)]
                });
            }
            
            const embed = await successEmbed(guildId, '📋 Custom Embeds', 
                templates.map(t => `**${t.name}** - ${t.description || 'No description'}\nUsed ${t.usageCount} times | Category: ${t.category}`).join('\n\n')
            );
            
            return message.reply({ embeds: [embed] });
        }
        
        // Send embed to channel
        if (action === 'send') {
            const embedName = args[1];
            const targetChannel = message.mentions.channels.first() || message.channel;
            const prefix = await getPrefix(guildId);
            
            if (!embedName) {
                return message.reply({
                    embeds: [await errorEmbed(guildId, `Please specify an embed name! Usage: \`${prefix}embed send <name> [#channel]\``)]
                });
            }
            
            // The sender must be able to post there themselves; the bot is not a way around channel permissions
            const senderPerms = targetChannel.permissionsFor(message.member);
            if (!senderPerms?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks])) {
                return message.reply({
                    embeds: [await errorEmbed(guildId, 'Access Denied', `You cannot post embeds in ${targetChannel}, Master.`)]
                });
            }
            
            const template = await EmbedTemplate.findOne({ guildId, name: embedName });
            
            if (!template) {
                return message.reply({
                    embeds: [await errorEmbed(guildId, `Embed "${embedName}" not found!`)]
                });
            }
            
            const embedData = template.buildEmbed({
                user: message.author,
                guild: message.guild,
                channel: targetChannel,
                client: message.client
            });
            
            const embed = new EmbedBuilder(embedData);
            
            await targetChannel.send({
                content: template.content ? template.replaceVariables(template.content, { user: message.author, guild: message.guild, channel: targetChannel }) : null,
                embeds: [embed],
                // @everyone/@here and role pings only for members allowed to make them in that channel
                allowedMentions: senderPerms.has(PermissionFlagsBits.MentionEveryone)
                    ? { parse: ['users', 'roles', 'everyone'] }
                    : { parse: ['users'] }
            });
            
            // Update usage stats
            template.usageCount++;
            template.lastUsed = new Date();
            await template.save();
            
            if (targetChannel.id !== message.channel.id) {
                message.reply({
                    embeds: [await successEmbed(guildId, '✅ Embed Sent', `Sent embed "${embedName}" to ${targetChannel}`)]
                });
            }
            
            return;
        }
        
        // Preview embed
        if (action === 'preview') {
            const embedName = args[1];
            const prefix = await getPrefix(guildId);
            
            if (!embedName) {
                return message.reply({
                    embeds: [await errorEmbed(guildId, `Please specify an embed name! Usage: \`${prefix}embed preview <name>\``)]
                });
            }
            
            const template = await EmbedTemplate.findOne({ guildId, name: embedName });
            
            if (!template) {
                return message.reply({
                    embeds: [await errorEmbed(guildId, `Embed "${embedName}" not found!`)]
                });
            }
            
            const embedData = template.buildEmbed({
                user: message.author,
                guild: message.guild,
                channel: message.channel,
                client: message.client
            });
            
            const embed = new EmbedBuilder(embedData);
            
            return message.reply({
                content: template.content ? `**Content:** ${template.replaceVariables(template.content, { user: message.author, guild: message.guild, channel: message.channel })}` : '**Preview:**',
                embeds: [embed]
            });
        }
        
        // Delete embed
        if (action === 'delete' || action === 'remove') {
            const embedName = args[1];
            const prefix = await getPrefix(guildId);
            
            if (!embedName) {
                return message.reply({
                    embeds: [await errorEmbed(guildId, `Please specify an embed name! Usage: \`${prefix}embed delete <name>\``)]
                });
            }
            
            const result = await EmbedTemplate.deleteOne({ guildId, name: embedName });
            
            if (result.deletedCount === 0) {
                return message.reply({
                    embeds: [await errorEmbed(guildId, `Embed "${embedName}" not found!`)]
                });
            }
            
            return message.reply({
                embeds: [await successEmbed(guildId, '🗑️ Embed Deleted', `Deleted embed "${embedName}"`)]
            });
        }
        
        // Create/Edit - Interactive setup
        if (action === 'create' || action === 'edit') {
            const embedName = args[1];
            const prefix = await getPrefix(guildId);
            
            if (!embedName) {
                return message.reply({
                    embeds: [await errorEmbed(guildId, `Please specify an embed name! Usage: \`${prefix}embed ${action} <name>\``)]
                });
            }
            
            const existingTemplate = await EmbedTemplate.findOne({ guildId, name: embedName });
            
            if (action === 'create' && existingTemplate) {
                return message.reply({
                    embeds: [await errorEmbed(guildId, `Embed "${embedName}" already exists! Use \`${prefix}embed edit ${embedName}\` to modify it.`)]
                });
            }
            
            if (action === 'edit' && !existingTemplate) {
                return message.reply({
                    embeds: [await errorEmbed(guildId, `Embed "${embedName}" not found! Use \`${prefix}embed create ${embedName}\` to create it.`)]
                });
            }
            
            // Send interactive setup message
            const setupEmbed = new EmbedBuilder()
                .setColor('#5865F2')
                .setTitle(`📝 ${action === 'create' ? 'Creating' : 'Editing'} Embed: ${embedName}`)
                .setDescription(`Use the \`${prefix}embedset\` command to configure this embed:\n\n` +
                    '**Basic Setup:**\n' +
                    `\`${prefix}embedset ${embedName} title <text>\` - Set title\n` +
                    `\`${prefix}embedset ${embedName} description <text>\` - Set description\n` +
                    `\`${prefix}embedset ${embedName} color <hex>\` - Set color (e.g., #FF0000)\n` +
                    `\`${prefix}embedset ${embedName} content <text>\` - Set message content\n\n` +
                    '**Images:**\n' +
                    `\`${prefix}embedset ${embedName} image <url>\` - Set large image\n` +
                    `\`${prefix}embedset ${embedName} thumbnail <url>\` - Set thumbnail\n` +
                    `\`${prefix}embedset ${embedName} thumbnail userAvatar\` - Use user\'s avatar\n\n` +
                    '**Author Section:**\n' +
                    `\`${prefix}embedset ${embedName} author <text>\` - Set author name\n` +
                    `\`${prefix}embedset ${embedName} authorIcon <url>\` - Set author icon\n` +
                    `\`${prefix}embedset ${embedName} authorIcon userAvatar\` - Use user\'s avatar\n\n` +
                    '**Footer:**\n' +
                    `\`${prefix}embedset ${embedName} footer <text>\` - Set footer text\n` +
                    `\`${prefix}embedset ${embedName} footerIcon <url>\` - Set footer icon\n` +
                    `\`${prefix}embedset ${embedName} footerIcon userAvatar\` - Use user\'s avatar\n` +
                    `\`${prefix}embedset ${embedName} footerIcon botAvatar\` - Use bot\'s avatar\n\n` +
                    '**Fields:**\n' +
                    `\`${prefix}embedset ${embedName} addfield <name> | <value> [inline]\` - Add field\n\n` +
                    '**Variables:** `{user}` `{user.name}` `{user.tag}` `{server}` `{server.members}` `{channel}` `{date}` `{time}`\n\n' +
                    `**Preview:** \`${prefix}embed preview ${embedName}\`\n` +
                    `**Send:** \`${prefix}embed send ${embedName} [#channel]\``
                )
                .setTimestamp();
            
            message.reply({ embeds: [setupEmbed] });
            
            // Create template if it doesn't exist
            if (action === 'create') {
                await EmbedTemplate.create({
                    guildId,
                    name: embedName,
                    createdBy: message.author.id,
                    embed: {}
                });
            }
            
            return;
        }
        
        return message.reply({
            embeds: [await errorEmbed(guildId, 'Invalid action! Use: `create`, `edit`, `delete`, `list`, `send`, or `preview`')]
        });
    }
};
