import Member from '../../models/Member.js';
import { infoEmbed, errorEmbed, warningEmbed, COLORS, GLYPHS } from '../../utils/embeds.js';
import { isStaff, getPrefix } from '../../utils/helpers.js';

const HIGH_RISK_SUS = 7;
const MEDIUM_RISK_SUS = 4;
const HIGH_RISK_WARNINGS = 3;

// Plain-text severity markers and theme colors in place of traffic-light emoji
const RISK = {
    high: { label: 'High', marker: '◆', color: COLORS.RAPHAEL_ERROR },
    medium: { label: 'Medium', marker: '◈', color: COLORS.RAPHAEL_WARNING },
    low: { label: 'Low', marker: '◇', color: COLORS.RAPHAEL_SUCCESS }
};

function susMarker(level) {
    if (level >= HIGH_RISK_SUS) return '◆';
    if (level >= MEDIUM_RISK_SUS) return '◈';
    return '◇';
}

export default {
    name: 'checkuser',
    description: 'Check a user for suspicious activity',
    usage: '<@user|user_id>',
    aliases: ['check', 'scan', 'inspect'],
    category: 'info',
    cooldown: 3,

    async execute(message, args) {
        const guildId = message.guild.id;

        try {
            // Restrict to staff
            if (!await isStaff(message.member, guildId)) {
                return message.reply({
                    embeds: [await errorEmbed(guildId, 'Permission Denied', 'Only staff members can use this skill, Master.')]
                });
            }

            if (!args[0]) {
                const prefix = await getPrefix(guildId);
                return message.reply({
                    embeds: [await errorEmbed(guildId, 'Invalid Usage', `**Usage:** \`${prefix}checkuser <@user|user_id>\``)]
                });
            }

            const userId = args[0].replace(/[<@!>]/g, '');
            const targetMember = await message.guild.members.fetch(userId).catch(() => null);

            if (!targetMember) {
                return message.reply({
                    embeds: [await errorEmbed(guildId, 'User Not Found', 'I could not find that member, Master.')]
                });
            }

            const memberData = await Member.findOne({ userId: targetMember.user.id, guildId });

            if (!memberData) {
                return message.reply({
                    embeds: [await warningEmbed(guildId, 'No Data', 'No records exist for this member, Master.')]
                });
            }

            // Recalculated for display only; this read-only skill does not write the result back
            memberData.calculateSusLevel();

            const embed = await infoEmbed(guildId,
                'User Security Check',
                `Detailed analysis of **${targetMember.user.tag}**, Master.`
            );

            const accountAge = (Date.now() - targetMember.user.createdTimestamp) / (1000 * 60 * 60);
            embed.addFields({
                name: `${GLYPHS.ARROW_RIGHT} Account Information`,
                value:
                    `**Username:** ${targetMember.user.tag}\n` +
                    `**ID:** \`${targetMember.user.id}\`\n` +
                    `**Created:** <t:${Math.floor(targetMember.user.createdTimestamp / 1000)}:D>\n` +
                    `**Age:** ${accountAge.toFixed(0)} hours (${(accountAge / 24).toFixed(1)} days)\n` +
                    `**New Account:** ${memberData.isNewAccount ? `${GLYPHS.EGG} Yes` : 'No'}`,
                inline: false
            });

            embed.addFields({
                name: `${GLYPHS.ARROW_RIGHT} Suspicious Activity Analysis`,
                value:
                    `**Sus Level:** ${susMarker(memberData.susLevel)} **${memberData.susLevel}**/10\n` +
                    `**Status:** ${memberData.isSuspicious ? `${GLYPHS.RADAR} **SUSPICIOUS**` : '◇ Normal'}\n` +
                    `**Join Count:** ${memberData.joinCount}\n` +
                    `**Leave Count:** ${memberData.leaveCount}\n` +
                    `**Radar Flag:** ${memberData.flags?.radarOn ? `${GLYPHS.ALERT} On` : 'Off'}`,
                inline: false
            });

            if (memberData.joinHistory.length > 0) {
                const joinsText = memberData.joinHistory.slice(-5).reverse().map(j =>
                    `${GLYPHS.DOT} <t:${Math.floor(new Date(j.timestamp).getTime() / 1000)}:R>${j.inviteCode ? ` (invite: \`${j.inviteCode}\`)` : ''}`
                ).join('\n');

                embed.addFields({ name: `${GLYPHS.ARROW_RIGHT} Recent Joins`, value: joinsText, inline: false });
            }

            const modActions = [];
            if (memberData.warnings.length > 0) modActions.push(`**Warnings:** ${memberData.warnings.length}`);
            if (memberData.kicks.length > 0) modActions.push(`**Kicks:** ${memberData.kicks.length}`);
            if (memberData.bans.length > 0) modActions.push(`**Bans:** ${memberData.bans.length}`);
            if (memberData.mutes.length > 0) modActions.push(`**Mutes:** ${memberData.mutes.length}`);

            if (modActions.length > 0) {
                embed.addFields({ name: `${GLYPHS.ARROW_RIGHT} Moderation History`, value: modActions.join('\n'), inline: false });
            }

            if (memberData.inviteLinks.length > 0) {
                const last = memberData.inviteLinks[memberData.inviteLinks.length - 1];
                embed.addFields({
                    name: `${GLYPHS.WARNING} Invite Links Posted`,
                    value: `**Count:** ${memberData.inviteLinks.length}\n` +
                        `**Last:** <t:${Math.floor(new Date(last.timestamp).getTime() / 1000)}:R>`,
                    inline: false
                });
            }

            let risk = RISK.low;
            if (memberData.susLevel >= HIGH_RISK_SUS || memberData.warnings.length >= HIGH_RISK_WARNINGS) {
                risk = RISK.high;
            } else if (memberData.susLevel >= MEDIUM_RISK_SUS || memberData.warnings.length >= 1) {
                risk = RISK.medium;
            }

            embed.addFields({
                name: `${GLYPHS.SHIELD} Risk Assessment`,
                value: `${risk.marker} **${risk.label} Risk**`,
                inline: false
            });

            embed.setThumbnail(targetMember.user.displayAvatarURL({ dynamic: true }));
            embed.setColor(risk.color);

            return message.reply({ embeds: [embed] });
        } catch (error) {
            console.error('[checkuser] Error:', error);
            return message.reply({
                embeds: [await errorEmbed(guildId, 'Analysis Failed', 'I was unable to complete the security check, Master.')]
            });
        }
    }
};
