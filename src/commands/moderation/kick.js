import { PermissionFlagsBits } from 'discord.js';
import Member from '../../models/Member.js';
import ModLog from '../../models/ModLog.js';
import Guild from '../../models/Guild.js';
import { successEmbed, errorEmbed, modLogEmbed, GLYPHS } from '../../utils/embeds.js';
import { getPrefix, truncate } from '../../utils/helpers.js';
import logger from '../../utils/logger.js';

const USER_ID = /^\d{17,20}$/;
const EMBED_REASON_LIMIT = 1000;
const AUDIT_REASON_LIMIT = 512;
// Discord API codes for "not in this server" and "no such user"
const UNKNOWN_MEMBER = 10007;
const UNKNOWN_USER = 10013;
const MISSING_PERMISSIONS = 50013;

export default {
  name: 'kick',
  category: 'moderation',
  description: 'Execute temporary exclusion protocol on a member, Master',
  usage: '<@user|user_id> [reason]',
  aliases: ['boot'],
  permissions: {
    user: PermissionFlagsBits.KickMembers,
    client: PermissionFlagsBits.KickMembers
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
            `${GLYPHS.ARROW_RIGHT} Usage: \`${prefix}kick <@user|user_id> [reason]\``)]
        });
      }

      if (userId === message.author.id) {
        return message.reply({ embeds: [await errorEmbed(guildId, 'Permission Denied', 'You cannot kick yourself, Master.')] });
      }
      if (userId === message.client.user.id) {
        return message.reply({ embeds: [await errorEmbed(guildId, 'Invalid Usage', 'I cannot kick myself, Master.')] });
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

      if (!targetMember.kickable) {
        return message.reply({ embeds: [await errorEmbed(guildId, 'Cannot Kick', botHierarchyReason(targetMember))] });
      }
      if (!outranks(message.member, targetMember)) {
        return message.reply({
          embeds: [await errorEmbed(guildId, 'Permission Denied',
            'Their highest role is equal to or above yours, so you cannot kick them, Master.')]
        });
      }

      const reason = truncate(args.slice(1).join(' ').trim() || 'No reason provided', EMBED_REASON_LIMIT);
      const targetUser = targetMember.user;

      // Notify right before acting: once removed they may share no server with me
      let notice = null;
      try {
        const dmEmbed = await errorEmbed(guildId, 'Removal Notice',
          `**Notice:** You have been removed from **${message.guild.name}**.\n\n` +
          `${GLYPHS.ARROW_RIGHT} **Reason:** ${reason}\n` +
          `${GLYPHS.ARROW_RIGHT} **Moderator:** ${message.author.tag}\n\n` +
          `*You may rejoin if you have an invite link.*`
        );
        notice = await targetMember.send({ embeds: [dmEmbed] });
      } catch {
        // DMs closed
      }

      try {
        await targetMember.kick(truncate(reason, AUDIT_REASON_LIMIT));
      } catch (error) {
        // The kick did not happen, so withdraw the notice that said it had
        await notice?.delete().catch(() => {});
        logger.error(`[Kick] Discord rejected the kick of ${userId} in ${guildId}`, error);
        return message.reply({
          embeds: [await errorEmbed(guildId, 'Kick Failed', error.code === MISSING_PERMISSIONS
            ? 'Discord denied me permission to kick this member, Master.'
            : 'Discord rejected the kick request, Master. The incident has been logged.')]
        });
      }

      const caseNumber = await recordCase(message, targetUser, reason);

      await postModLog(message, {
        caseNumber: caseNumber ?? '—',
        targetTag: targetUser.tag,
        targetId: targetUser.id,
        moderatorTag: message.author.tag,
        reason
      });

      const embed = await successEmbed(guildId, 'Removal Executed',
        `**Notice:** Disciplinary action has been executed, Master.\n\n` +
        `${GLYPHS.ARROW_RIGHT} **Subject:** ${targetUser.tag}\n` +
        `${GLYPHS.ARROW_RIGHT} **Action:** Server Removal\n` +
        `${GLYPHS.ARROW_RIGHT} **Reason:** ${reason}\n` +
        (caseNumber
          ? `${GLYPHS.ARROW_RIGHT} **Case Reference:** #${caseNumber}`
          : `${GLYPHS.ERROR} The case record could not be saved. The incident has been logged.`)
      );
      return message.reply({ embeds: [embed] });
    } catch (error) {
      logger.error('[Kick] Command failed', error);
      const embed = await errorEmbed(guildId, 'Kick Failed',
        'An anomaly interrupted the kick protocol, Master. The incident has been logged.').catch(() => null);
      return message.reply(embed ? { embeds: [embed] } : { content: '**Alert:** The kick protocol failed, Master.' }).catch(() => null);
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

function botHierarchyReason(target) {
  const me = target.guild.members.me;
  return target.roles.highest.position >= me.roles.highest.position
    ? 'Their highest role is equal to or above mine, so I cannot kick them, Master. Move my role above theirs in Server Settings › Roles.'
    : 'Discord does not permit me to kick this member, Master.';
}

// Case and member records, written only after the kick succeeded. Returns the case number,
// or null if it could not be saved (the kick itself stands either way).
async function recordCase(message, user, reason) {
  const guildId = message.guild.id;
  let caseNumber = null;

  try {
    const nextCase = await ModLog.getNextCaseNumber(guildId);
    await ModLog.create({
      guildId,
      caseNumber: nextCase,
      action: 'kick',
      moderatorId: message.author.id,
      moderatorTag: message.author.tag,
      targetId: user.id,
      targetTag: user.tag,
      reason
    });
    caseNumber = nextCase;
  } catch (error) {
    logger.error(`[Kick] Failed to save the case for ${user.id} in ${guildId}`, error);
  }

  try {
    await Member.updateOne(
      { userId: user.id, guildId },
      {
        $push: { kicks: { moderatorId: message.author.id, reason, timestamp: new Date() } },
        $setOnInsert: {
          username: user.username,
          discriminator: user.discriminator || '0',
          accountCreatedAt: user.createdAt
        }
      },
      { upsert: true }
    );
  } catch (error) {
    logger.error(`[Kick] Failed to update the member record for ${user.id} in ${guildId}`, error);
  }

  return caseNumber;
}

async function postModLog(message, logData) {
  try {
    const guildConfig = await Guild.getGuild(message.guild.id);
    const channelId = guildConfig?.channels?.modLog;
    const channel = channelId ? message.guild.channels.cache.get(channelId) : null;
    if (!channel) return;
    const embed = await modLogEmbed(message.guild.id, 'kick', logData);
    await channel.send({ embeds: [embed] });
  } catch (error) {
    logger.warn(`[Kick] Failed to post to the mod log in ${message.guild.id}: ${error.message}`);
  }
}
