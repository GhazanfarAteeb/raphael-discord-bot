import { PermissionFlagsBits } from 'discord.js';
import ModLog from '../../models/ModLog.js';
import Guild from '../../models/Guild.js';
import { successEmbed, errorEmbed, modLogEmbed, GLYPHS, COLORS } from '../../utils/embeds.js';
import { getPrefix, truncate } from '../../utils/helpers.js';
import logger from '../../utils/logger.js';

const USER_ID = /^\d{17,20}$/;
const EMBED_REASON_LIMIT = 1000;
const AUDIT_REASON_LIMIT = 512;
// Discord API codes for "not in this server" and "no such user"
const UNKNOWN_MEMBER = 10007;
const UNKNOWN_USER = 10013;

export default {
  name: 'untimeout',
  category: 'moderation',
  description: 'Remove timeout from a member',
  usage: '<@user|user_id> [reason]',
  aliases: ['unmute', 'removetimeout', 'cleartimeout'],
  permissions: {
    user: PermissionFlagsBits.ModerateMembers,
    client: PermissionFlagsBits.ModerateMembers
  },
  cooldown: 3,

  async execute(message, args) {
    const guildId = message.guild.id;

    try {
      const userId = args[0]?.replace(/[<@!>]/g, '');
      if (!userId || !USER_ID.test(userId)) {
        const prefix = await getPrefix(guildId);
        return message.reply({
          embeds: [await errorEmbed(guildId, 'Invalid Usage',
            `${GLYPHS.ARROW_RIGHT} Usage: \`${prefix}untimeout <@user|user_id> [reason]\`\n\n` +
            `**Examples:**\n` +
            `${GLYPHS.DOT} \`${prefix}untimeout @User\`\n` +
            `${GLYPHS.DOT} \`${prefix}unmute @User Appeal accepted\``)]
        });
      }

      if (userId === message.guild.ownerId) {
        return message.reply({
          embeds: [await errorEmbed(guildId, 'Permission Denied', 'The server owner cannot be timed out, so there is nothing to remove, Master.')]
        });
      }

      const targetMember = await fetchMember(message.guild, userId);
      if (!targetMember) {
        return message.reply({ embeds: [await errorEmbed(guildId, 'User Not Found', 'That user is not a member of this server, Master.')] });
      }

      if (!targetMember.moderatable) {
        return message.reply({ embeds: [await errorEmbed(guildId, 'Cannot Modify', botLimitReason(targetMember))] });
      }
      if (!outranks(message.member, targetMember)) {
        return message.reply({
          embeds: [await errorEmbed(guildId, 'Permission Denied',
            'Their highest role is equal to or above yours, so you cannot moderate them, Master.')]
        });
      }

      const targetUser = targetMember.user;
      if (!targetMember.isCommunicationDisabled()) {
        return message.reply({
          embeds: [await errorEmbed(guildId, 'No Active Timeout', `**Notice:** **${targetUser.tag}** is not currently timed out, Master.`)]
        });
      }

      const reason = truncate(args.slice(1).join(' ').trim() || 'No reason provided', EMBED_REASON_LIMIT);
      const auditReason = truncate(`${reason} | Removed by ${message.author.tag}`, AUDIT_REASON_LIMIT);
      const guildConfig = await Guild.getGuild(guildId, message.guild.name);

      try {
        await targetMember.timeout(null, auditReason);
      } catch (error) {
        logger.error(`[Untimeout] Discord rejected the timeout removal for ${userId} in ${guildId}`, error);
        return message.reply({
          embeds: [await errorEmbed(guildId, 'Timeout Removal Failed', 'Discord rejected the request, Master. The incident has been logged.')]
        });
      }

      const mutedRole = guildConfig?.roles?.mutedRole ? message.guild.roles.cache.get(guildConfig.roles.mutedRole) : null;
      if (mutedRole && targetMember.roles.cache.has(mutedRole.id)) {
        await targetMember.roles.remove(mutedRole, auditReason)
          .catch(err => logger.warn(`[Untimeout] Failed to remove muted role: ${err.message}`));
      }

      const caseNumber = await recordCase(message, targetUser, reason);

      // Mod log channel
      try {
        const channelId = guildConfig?.channels?.modLog;
        const logChannel = channelId ? message.guild.channels.cache.get(channelId) : null;
        if (logChannel) {
          const logEmbed = await modLogEmbed(guildId, 'untimeout', {
            caseNumber: caseNumber ?? '—',
            moderatorTag: message.author.tag,
            targetTag: targetUser.tag,
            targetId: targetUser.id,
            reason
          });
          logEmbed.setColor(COLORS.RAPHAEL_SUCCESS);
          await logChannel.send({ embeds: [logEmbed] });
        }
      } catch (error) {
        logger.warn(`[Untimeout] Failed to post to the mod log in ${guildId}: ${error.message}`);
      }

      try {
        const dmEmbed = await successEmbed(guildId, 'Timeout Lifted',
          `**Notice:** Your timeout in **${message.guild.name}** has been removed.\n\n` +
          `${GLYPHS.ARROW_RIGHT} **Reason:** ${reason}\n` +
          `${GLYPHS.ARROW_RIGHT} **Moderator:** ${message.author.tag}`
        );
        await targetMember.send({ embeds: [dmEmbed] });
      } catch {
        // DMs closed
      }

      const embed = await successEmbed(guildId, 'Restriction Lifted',
        `**Confirmed:** Communication restriction removed from **${targetUser.tag}**, Master.\n\n` +
        `${GLYPHS.ARROW_RIGHT} **Reason:** ${reason}\n` +
        (caseNumber
          ? `${GLYPHS.ARROW_RIGHT} **Case Reference:** #${caseNumber}`
          : `${GLYPHS.ERROR} The case record could not be saved. The incident has been logged.`)
      );
      return message.reply({ embeds: [embed] });
    } catch (error) {
      logger.error('[Untimeout] Command failed', error);
      const embed = await errorEmbed(guildId, 'Timeout Removal Failed',
        'An anomaly interrupted the request, Master. The incident has been logged.').catch(() => null);
      return message.reply(embed ? { embeds: [embed] } : { content: '**Alert:** The timeout could not be removed, Master.' }).catch(() => null);
    }
  }
};

// The member, or null when they are not in the server; other lookup failures are rethrown
async function fetchMember(guild, userId) {
  try {
    return await guild.members.fetch({ user: userId, force: true });
  } catch (error) {
    if (error.code === UNKNOWN_MEMBER || error.code === UNKNOWN_USER) return null;
    throw error;
  }
}

// Server owner and Administrators may act on anyone; others only below their own top role
function outranks(moderator, target) {
  if (moderator.id === moderator.guild.ownerId) return true;
  if (moderator.permissions.has(PermissionFlagsBits.Administrator)) return true;
  return target.roles.highest.position < moderator.roles.highest.position;
}

function botLimitReason(target) {
  if (target.id === target.guild.members.me.id) return 'I cannot modify my own timeout, Master.';
  if (target.permissions.has(PermissionFlagsBits.Administrator)) {
    return 'Members with the Administrator permission are exempt from timeouts, so there is nothing for me to remove, Master.';
  }
  const me = target.guild.members.me;
  return target.roles.highest.position >= me.roles.highest.position
    ? 'Their highest role is equal to or above mine, so I cannot moderate them, Master. Move my role above theirs in Server Settings › Roles.'
    : 'Discord does not permit me to moderate this member, Master.';
}

// Case record, written only after the timeout was removed. Returns the case number, or null
// if it could not be saved (the removal itself stands either way).
async function recordCase(message, user, reason) {
  try {
    const caseNumber = await ModLog.getNextCaseNumber(message.guild.id);
    await ModLog.create({
      guildId: message.guild.id,
      caseNumber,
      action: 'untimeout',
      moderatorId: message.author.id,
      moderatorTag: message.author.tag,
      targetId: user.id,
      targetTag: user.tag,
      reason
    });
    return caseNumber;
  } catch (error) {
    logger.error(`[Untimeout] Failed to save the case for ${user.id} in ${message.guild.id}`, error);
    return null;
  }
}
