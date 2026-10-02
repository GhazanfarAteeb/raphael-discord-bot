import { EmbedBuilder } from 'discord.js';
import { errorEmbed, COLORS } from '../../utils/embeds.js';
import { getPrefix, truncate } from '../../utils/helpers.js';
import { getRandomFooter } from '../../utils/raphael.js';

const MEMBERS_SHOWN = 10;
const KEY_PERMISSIONS = [
    'Administrator', 'ManageGuild', 'ManageRoles', 'ManageChannels',
    'KickMembers', 'BanMembers', 'ManageMessages', 'MentionEveryone',
    'ManageNicknames', 'ManageWebhooks', 'ManageGuildExpressions'
];

export default {
    name: 'roleinfo',
    aliases: ['ri', 'role'],
    description: 'Get information about a role',
    usage: '<@role|role_id|role name>',
    category: 'info',
    cooldown: 3,

    async execute(message, args, client) {
        const guildId = message.guild.id;

        try {
            const prefix = await getPrefix(guildId);

            if (!args[0]) {
                return message.reply({
                    embeds: [await errorEmbed(guildId, 'Target Required', `**Notice:** Please specify a role, Master.\n\n\`${prefix}roleinfo @role\` or \`${prefix}roleinfo Admin\``)]
                });
            }

            const query = args.join(' ').toLowerCase();
            const role = message.mentions.roles.first()
                || message.guild.roles.cache.get(args[0])
                || message.guild.roles.cache.find(r => r.name.toLowerCase() === query)
                || message.guild.roles.cache.find(r => r.name.toLowerCase().includes(query));

            if (!role) {
                return message.reply({
                    embeds: [await errorEmbed(guildId, 'Role Not Found', '**Warning:** Unable to locate the specified role, Master.')]
                });
            }

            const membersWithRole = role.members.size;
            const permissions = role.permissions.toArray();
            const keyPerms = KEY_PERMISSIONS.filter(p => permissions.includes(p));
            const permText = keyPerms.length > 0
                ? keyPerms.map(p => `\`${p}\``).join(', ')
                : permissions.length > 0 ? `${permissions.length} permissions` : 'None';

            // Role#color is deprecated in favour of Role#colors
            const color = role.colors?.primaryColor ?? role.color;

            const memberText = membersWithRole === 0
                ? 'No members'
                : role.members.first(MEMBERS_SHOWN).map(m => m.user.tag).join(', ') +
                    (membersWithRole > MEMBERS_SHOWN ? ` and ${membersWithRole - MEMBERS_SHOWN} more` : '');

            const embed = new EmbedBuilder()
                .setTitle(`『 ${truncate(role.name, 200)} Analysis 』`)
                .setColor(color || COLORS.RAPHAEL)
                .setThumbnail(role.iconURL({ size: 128 }) || null)
                .addFields(
                    {
                        name: '▸ General',
                        value: [
                            `**Identifier:** \`${role.id}\``,
                            `**Color:** ${role.hexColor}`,
                            `**Position:** ${role.position}/${message.guild.roles.cache.size}`,
                            `**Created:** <t:${Math.floor(role.createdTimestamp / 1000)}:D>`
                        ].join('\n'),
                        inline: true
                    },
                    {
                        name: '▸ Configuration',
                        value: [
                            `**Hoisted:** ${role.hoist ? '◉' : '◇'}`,
                            `**Mentionable:** ${role.mentionable ? '◉' : '◇'}`,
                            `**Managed:** ${role.managed ? '◉' : '◇'}`,
                            `**Bot Role:** ${role.tags?.botId ? '◉' : '◇'}`
                        ].join('\n'),
                        inline: true
                    },
                    {
                        name: `▸ Members (${membersWithRole})`,
                        value: truncate(memberText, 1024),
                        inline: false
                    },
                    {
                        name: '▸ Key Permissions',
                        value: permText,
                        inline: false
                    }
                )
                .setFooter({ text: getRandomFooter() })
                .setTimestamp();

            if (role.mentionable) {
                embed.addFields({ name: '▸ Mention', value: `\`<@&${role.id}>\``, inline: false });
            }

            if (role.managed) {
                let managedBy = 'Unknown integration';
                if (role.tags?.botId) {
                    const bot = await client.users.fetch(role.tags.botId).catch(() => null);
                    managedBy = bot ? `Bot: ${bot.tag}` : `Bot ID: ${role.tags.botId}`;
                } else if (role.tags?.integrationId) {
                    managedBy = `Integration ID: ${role.tags.integrationId}`;
                } else if (role.tags?.premiumSubscriberRole) {
                    managedBy = 'Server Boost Role';
                }

                embed.addFields({ name: '▸ Managed By', value: managedBy, inline: false });
            }

            return message.reply({ embeds: [embed] });
        } catch (error) {
            console.error('[roleinfo] Error:', error);
            return message.reply({
                embeds: [await errorEmbed(guildId, 'Analysis Failed', 'I was unable to analyse that role, Master.')]
            });
        }
    }
};
