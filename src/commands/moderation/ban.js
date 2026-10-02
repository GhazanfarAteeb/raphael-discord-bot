import { Message, PermissionFlagsBits } from 'discord.js';
import Member from '../../models/Member.js';
import ModLog from '../../models/ModLog.js';
import Guild from '../../models/Guild.js';
import { successEmbed, errorEmbed, modLogEmbed, GLYPHS } from '../../utils/embeds.js';
import { getPrefix, truncate } from '../../utils/helpers.js';
import logger from '../../utils/logger.js';

const USER_ID = /^\d{17,20}$/;
const EMBED_REASON_LIMIT = 1000;
const AUDIT_REASON_LIMIT = 512;
const DELETE_MESSAGE_SECONDS = 24 * 60 * 60;
// Discord API codes for "not in this server" and "no such user"
const UNKNOWN_MEMBER = 10007;
const UNKNOWN_USER = 10013;
const MISSING_PERMISSIONS = 50013;

export default {
  name: 'ban',
  category: 'moderation',
  description: 'Execute permanent exclusion protocol on a member, Master',
  usage: '<@user|user_id> [reason]',
  aliases: ['hammer'],
  permissions: {
    user: PermissionFlagsBits.BanMembers,
    client: PermissionFlagsBits.BanMembers
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
            `${GLYPHS.ARROW_RIGHT} Usage: \`${prefix}ban <@user|user_id> [reason]\``)]
        });
      }

      if (userId === message.author.id) {
        return message.reply({ embeds: [await errorEmbed(guildId, 'Permission Denied', 'You cannot ban yourself, Master.')] });
      }
      if (userId === message.client.user.id) {
        return message.reply({ embeds: [await errorEmbed(guildId, 'Invalid Usage', 'I cannot ban myself, Master.')] });
      }
      if (userId === message.guild.ownerId) {
        return message.reply({
          embeds: [await errorEmbed(guildId, 'Permission Denied', 'The server owner is immune to moderation actions, Master.')]
        });
      }

      // Reason, plus the trailing true/false that the bridged /ban adds for its delete_messages option
      const reasonArgs = args.slice(1);
      let deleteMessageSeconds = DELETE_MESSAGE_SECONDS;
      if (!(message instanceof Message) && ['true', 'false'].includes(reasonArgs.at(-1))) {
        if (reasonArgs.pop() === 'false') deleteMessageSeconds = 0;
      }
      const reason = truncate(reasonArgs.join(' ').trim() || 'No reason provided', EMBED_REASON_LIMIT);

      const targetMember = await fetchMember(message.guild, userId);
      let targetUser;

      if (targetMember) {
        if (!targetMember.bannable) {
          return message.reply({ embeds: [await errorEmbed(guildId, 'Cannot Ban', botHierarchyReason(targetMember))] });
        }
        if (!outranks(message.member, targetMember)) {
          return message.reply({
            embeds: [await errorEmbed(guildId, 'Permission Denied',
              'Their highest role is equal to or above yours, so you cannot ban them, Master.')]
          });
        }
        targetUser = targetMember.user;
      } else {
        targetUser = await message.client.users.fetch(userId).catch(() => null);
        if (!targetUser) {
          return message.reply({ embeds: [await errorEmbed(guildId, 'User Not Found', 'No Discord user exists with that ID, Master.')] });
        }
        const existingBan = await message.guild.bans.fetch({ user: userId, force: true }).catch(() => null);
        if (existingBan) {
          return message.reply({
            embeds: [await errorEmbed(guildId, 'Already Banned', `**${targetUser.tag}** is already banned from this server, Master.`)]
          });
        }
      }

      // Notify right before acting: once banned they share no server with me to receive it
      let notice = null;
      if (targetMember) {
        try {
          const dmEmbed = await errorEmbed(guildId, 'Expulsion Notice',
            `**Notice:** You have been permanently banned from **${message.guild.name}**.\n\n` +
            `${GLYPHS.ARROW_RIGHT} **Reason:** ${reason}\n` +
            `${GLYPHS.ARROW_RIGHT} **Moderator:** ${message.author.tag}\n\n` +
            `*This decision is final.*`
          );
          notice = await targetUser.send({ embeds: [dmEmbed] });
        } catch {
          // DMs closed
        }
      }

      try {
        await message.guild.members.ban(userId, {
          reason: truncate(reason, AUDIT_REASON_LIMIT),
          deleteMessageSeconds
        });
      } catch (error) {
        // The ban did not happen, so withdraw the notice that said it had
        await notice?.delete().catch(() => {});
        logger.error(`[Ban] Discord rejected the ban of ${userId} in ${guildId}`, error);
        return message.reply({
          embeds: [await errorEmbed(guildId, 'Ban Failed', error.code === MISSING_PERMISSIONS
            ? 'Discord denied me permission to ban this user, Master.'
            : 'Discord rejected the ban request, Master. The incident has been logged.')]
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

      const embed = await successEmbed(guildId, 'Expulsion Executed',
        `**Notice:** Disciplinary action has been executed, Master.\n\n` +
        `${GLYPHS.ARROW_RIGHT} **Subject:** ${targetUser.tag}\n` +
        `${GLYPHS.ARROW_RIGHT} **Action:** Permanent Expulsion\n` +
        `${GLYPHS.ARROW_RIGHT} **Reason:** ${reason}\n` +
        (caseNumber
          ? `${GLYPHS.ARROW_RIGHT} **Case Reference:** #${caseNumber}`
          : `${GLYPHS.ERROR} The case record could not be saved. The incident has been logged.`)
      );
      return message.reply({ embeds: [embed] });
    } catch (error) {
      logger.error('[Ban] Command failed', error);
      const embed = await errorEmbed(guildId, 'Ban Failed',
        'An anomaly interrupted the ban protocol, Master. The incident has been logged.').catch(() => null);
      return message.reply(embed ? { embeds: [embed] } : { content: '**Alert:** The ban protocol failed, Master.' }).catch(() => null);
    }
  }
};

// The member, or null when they are not in the server. Other failures are rethrown so a
// lookup error is never mistaken for "not a member" (which would skip the hierarchy checks).
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
    ? 'Their highest role is equal to or above mine, so I cannot ban them, Master. Move my role above theirs in Server Settings › Roles.'
    : 'Discord does not permit me to ban this member, Master.';
}

// Case and member records, written only after the ban succeeded. Returns the case number,
// or null if it could not be saved (the ban itself stands either way).
async function recordCase(message, user, reason) {
  const guildId = message.guild.id;
  let caseNumber = null;

  try {
    const nextCase = await ModLog.getNextCaseNumber(guildId);
    await ModLog.create({
      guildId,
      caseNumber: nextCase,
      action: 'ban',
      moderatorId: message.author.id,
      moderatorTag: message.author.tag,
      targetId: user.id,
      targetTag: user.tag,
      reason
    });
    caseNumber = nextCase;
  } catch (error) {
    logger.error(`[Ban] Failed to save the case for ${user.id} in ${guildId}`, error);
  }

  try {
    await Member.updateOne(
      { userId: user.id, guildId },
      {
        $push: { bans: { moderatorId: message.author.id, reason, timestamp: new Date() } },
        $setOnInsert: {
          username: user.username,
          discriminator: user.discriminator || '0',
          accountCreatedAt: user.createdAt
        }
      },
      { upsert: true }
    );
  } catch (error) {
    logger.error(`[Ban] Failed to update the member record for ${user.id} in ${guildId}`, error);
  }

  return caseNumber;
}

async function postModLog(message, logData) {
  try {
    const guildConfig = await Guild.getGuild(message.guild.id);
    const channelId = guildConfig?.channels?.modLog;
    const channel = channelId ? message.guild.channels.cache.get(channelId) : null;
    if (!channel) return;
    const embed = await modLogEmbed(message.guild.id, 'ban', logData);
    await channel.send({ embeds: [embed] });
  } catch (error) {
    logger.warn(`[Ban] Failed to post to the mod log in ${message.guild.id}: ${error.message}`);
  }
}
