import { PermissionFlagsBits } from 'discord.js';
import Member from '../../models/Member.js';
import ModLog from '../../models/ModLog.js';
import Guild from '../../models/Guild.js';
import { successEmbed, errorEmbed, modLogEmbed, GLYPHS } from '../../utils/embeds.js';
import { getPrefix, truncate } from '../../utils/helpers.js';
import logger from '../../utils/logger.js';

const USER_ID = /^\d{17,20}$/;
const EMBED_REASON_LIMIT = 1000;
// Discord API codes for "not in this server" and "no such user"
const UNKNOWN_MEMBER = 10007;
const UNKNOWN_USER = 10013;

export default {
  name: 'warn',
  category: 'moderation',
  description: 'Warn a member',
  usage: '<@user|user_id> [reason]',
  aliases: ['warning'],
  permissions: {
    user: PermissionFlagsBits.ModerateMembers,
    client: PermissionFlagsBits.ModerateMembers
  },
  cooldown: 2,

  async execute(message, args) {
    const guildId = message.guild.id;

    try {
      const userId = args[0]?.replace(/[<@!>]/g, '');
      if (!userId || !USER_ID.test(userId)) {
        const prefix = await getPrefix(guildId);
        return message.reply({
          embeds: [await errorEmbed(guildId, 'Invalid Usage',
            `${GLYPHS.ARROW_RIGHT} Usage: \`${prefix}warn <@user|user_id> [reason]\``)]
        });
      }

      if (userId === message.author.id) {
        return message.reply({ embeds: [await errorEmbed(guildId, 'Permission Denied', 'You cannot warn yourself, Master.')] });
      }
      if (userId === message.guild.ownerId) {
        return message.reply({
          embeds: [await errorEmbed(guildId, 'Permission Denied', 'The server owner is immune to moderation actions, Master.')]
        });
      }

      const targetMember = await fetchMember(message.guild, userId);
      if (!targetMember) {
        return message.reply({ embeds: [await errorEmbed(guildId, 'User Not Found', 'That user is not a member of this server, Master.')] });
      }

      if (targetMember.user.bot) {
        return message.reply({ embeds: [await errorEmbed(guildId, 'Invalid Usage', 'Automated accounts cannot be warned, Master.')] });
      }

      // Server owner and Administrators may warn anyone; others only below their own top role
      const isOwner = message.author.id === message.guild.ownerId;
      const isAdmin = message.member.permissions.has(PermissionFlagsBits.Administrator);
      if (!isOwner && !isAdmin && targetMember.roles.highest.position >= message.member.roles.highest.position) {
        return message.reply({
          embeds: [await errorEmbed(guildId, 'Permission Denied',
            'Their highest role is equal to or above yours, so you cannot warn them, Master.')]
        });
      }

      const reason = truncate(args.slice(1).join(' ').trim() || 'No reason provided', EMBED_REASON_LIMIT);
      const targetUser = targetMember.user;

      // The warning itself is the record, so it must save before anything is announced
      const memberData = await Member.findOneAndUpdate(
        { userId: targetUser.id, guildId },
        {
          $push: {
            warnings: {
              moderatorId: message.author.id,
              moderatorTag: message.author.tag,
              reason,
              timestamp: new Date()
            }
          },
          $setOnInsert: {
            username: targetUser.username,
            discriminator: targetUser.discriminator || '0',
            accountCreatedAt: targetUser.createdAt
          }
        },
        { upsert: true, new: true, projection: { warnings: 1 } }
      ).lean();
      const warningCount = memberData?.warnings?.length ?? 1;

      let caseNumber = null;
      try {
        caseNumber = await ModLog.getNextCaseNumber(guildId);
        await ModLog.create({
          guildId,
          caseNumber,
          action: 'warn',
          moderatorId: message.author.id,
          moderatorTag: message.author.tag,
          targetId: targetUser.id,
          targetTag: targetUser.tag,
          reason
        });
      } catch (error) {
        caseNumber = null;
        logger.error(`[Warn] Failed to save the case for ${targetUser.id} in ${guildId}`, error);
      }

      // Mod log channel
      try {
        const guildConfig = await Guild.getGuild(guildId);
        const channelId = guildConfig?.channels?.modLog;
        const modLogChannel = channelId ? message.guild.channels.cache.get(channelId) : null;
        if (modLogChannel) {
          const logEmbed = await modLogEmbed(guildId, 'warn', {
            caseNumber: caseNumber ?? '—',
            targetTag: targetUser.tag,
            targetId: targetUser.id,
            moderatorTag: message.author.tag,
            reason
          });
          await modLogChannel.send({ embeds: [logEmbed] });
        }
      } catch (error) {
        logger.warn(`[Warn] Failed to post to the mod log in ${guildId}: ${error.message}`);
      }

      try {
        const dmEmbed = await errorEmbed(guildId, 'Official Warning',
          `**Caution:** You have received an official warning in **${message.guild.name}**.\n\n` +
          `${GLYPHS.ARROW_RIGHT} **Reason:** ${reason}\n` +
          `${GLYPHS.ARROW_RIGHT} **Moderator:** ${message.author.tag}\n` +
          `${GLYPHS.ARROW_RIGHT} **Accumulated Warnings:** ${warningCount}\n\n` +
          `*Further infractions may result in escalated disciplinary action.*`
        );
        await targetMember.send({ embeds: [dmEmbed] });
      } catch {
        // DMs closed
      }

      const embed = await successEmbed(guildId, 'Warning Issued',
        `**Notice:** Disciplinary warning has been recorded, Master.\n\n` +
        `${GLYPHS.ARROW_RIGHT} **Subject:** ${targetUser.tag}\n` +
        `${GLYPHS.ARROW_RIGHT} **Reason:** ${reason}\n` +
        `${GLYPHS.ARROW_RIGHT} **Total Infractions:** ${warningCount}\n` +
        (caseNumber
          ? `${GLYPHS.ARROW_RIGHT} **Case Reference:** #${caseNumber}`
          : `${GLYPHS.ERROR} The case record could not be saved. The incident has been logged.`)
      );
      return message.reply({ embeds: [embed] });
    } catch (error) {
      logger.error('[Warn] Command failed', error);
      const embed = await errorEmbed(guildId, 'Warning Failed',
        'An anomaly prevented the warning from being recorded, Master. The incident has been logged.').catch(() => null);
      return message.reply(embed ? { embeds: [embed] } : { content: '**Alert:** The warning could not be recorded, Master.' }).catch(() => null);
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
