import { infoEmbed, errorEmbed } from '../../utils/embeds.js';
import Member from '../../models/Member.js';
import Guild from '../../models/Guild.js';
import { hasModPerms } from '../../utils/helpers.js';
import { getRandomFooter } from '../../utils/raphael.js';

const ROLES_SHOWN = 10;

export default {
    name: 'userinfo',
    description: 'Get information about a user',
    usage: '[@user|user_id]',
    aliases: ['user', 'whois', 'ui'],
    category: 'info',
    cooldown: 3,

    async execute(message, args) {
        const guildId = message.guild.id;

        try {
            const targetId = args[0]?.replace(/[<@!>]/g, '');
            const targetUser = targetId
                ? await message.guild.members.fetch(targetId).catch(() => null)
                : message.member;

            if (!targetUser) {
                return message.reply({
                    embeds: [await errorEmbed(guildId, 'Subject Not Found', '**Warning:** Unable to locate the specified user, Master.')]
                });
            }

            const embed = await infoEmbed(guildId, 'Individual Analysis', `**Report:** Data compiled for **${targetUser.user.tag}**, Master.`);

            embed.addFields({
                name: '▸ Identity Data',
                value:
                    `**Username:** ${targetUser.user.tag}\n` +
                    `**Identifier:** \`${targetUser.user.id}\`\n` +
                    `**Classification:** ${targetUser.user.bot ? 'Automated System' : 'Organic User'}\n` +
                    `**Reference:** ${targetUser}`,
                inline: false
            });

            embed.addFields({
                name: '▸ Temporal Records',
                value:
                    `**Account Created:** <t:${Math.floor(targetUser.user.createdTimestamp / 1000)}:D>\n` +
                    `**Age:** <t:${Math.floor(targetUser.user.createdTimestamp / 1000)}:R>`,
                inline: false
            });

            if (targetUser.joinedTimestamp) {
                embed.addFields({
                    name: '▸ Server Affiliation',
                    value:
                        `**First Detected:** <t:${Math.floor(targetUser.joinedTimestamp / 1000)}:D>\n` +
                        `**Duration:** <t:${Math.floor(targetUser.joinedTimestamp / 1000)}:R>`,
                    inline: false
                });
            }

            const roles = targetUser.roles.cache
                .filter(r => r.id !== message.guild.id)
                .sort((a, b) => b.position - a.position);

            if (roles.size > 0) {
                embed.addFields({
                    name: `▸ Authority Levels [${roles.size}]`,
                    value: roles.first(ROLES_SHOWN).map(r => r.toString()).join(', ') +
                        (roles.size > ROLES_SHOWN ? ` +${roles.size - ROLES_SHOWN} more` : ''),
                    inline: false
                });
            }

            // Infractions, sus level and surveillance status are moderation data: staff only
            const guildConfig = await Guild.getGuild(guildId, message.guild.name);
            if (hasModPerms(message.member, guildConfig)) {
                const memberData = await Member.findOne({ userId: targetUser.user.id, guildId }).lean();
                if (memberData) {
                    embed.addFields({
                        name: '▸ Behavioral Metrics',
                        value:
                            `**Entry Count:** ${memberData.joinCount ?? 0}\n` +
                            `**Departure Count:** ${memberData.leaveCount ?? 0}\n` +
                            `**Infractions:** ${memberData.warnings?.length ?? 0}\n` +
                            `**Threat Assessment:** ${memberData.susLevel ?? 0}/10\n` +
                            `**New Account:** ${memberData.isNewAccount ? 'Affirmative' : 'Negative'}\n` +
                            `**Under Surveillance:** ${memberData.isSuspicious ? '◉ Active' : '◇ Inactive'}`,
                        inline: false
                    });
                }
            }

            embed.setThumbnail(targetUser.user.displayAvatarURL({ dynamic: true, size: 256 }));
            // Members without a colored role report black (0); keep the theme color then
            if (targetUser.displayColor) embed.setColor(targetUser.displayColor);
            embed.setFooter({ text: getRandomFooter() });

            return message.reply({ embeds: [embed] });
        } catch (error) {
            console.error('[userinfo] Error:', error);
            return message.reply({
                embeds: [await errorEmbed(guildId, 'Analysis Failed', 'I was unable to compile data for that user, Master.')]
            });
        }
    }
};
