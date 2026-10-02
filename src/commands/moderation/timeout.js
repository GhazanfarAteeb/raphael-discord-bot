import { PermissionFlagsBits } from 'discord.js';
import Member from '../../models/Member.js';
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
const MISSING_PERMISSIONS = 50013;

const UNIT_MS = {
  w: 7 * 24 * 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
  h: 60 * 60 * 1000,
  m: 60 * 1000,
  s: 1000
};
const UNIT_NAMES = [['week', UNIT_MS.w], ['day', UNIT_MS.d], ['hour', UNIT_MS.h], ['minute', UNIT_MS.m], ['second', UNIT_MS.s]];
// Discord's limit is 28 days from the moment the request lands; a minute of headroom keeps
// a full "28d" from being rejected once request latency is added
const DISCORD_MAX_TIMEOUT_MS = 28 * UNIT_MS.d;
const MAX_TIMEOUT_MS = DISCORD_MAX_TIMEOUT_MS - UNIT_MS.m;
const REMOVE_KEYWORDS = ['off', 'remove', 'clear'];

export default {
  name: 'timeout',
  category: 'moderation',
  description: 'Timeout a member (prevent them from sending messages)',
  usage: '<@user|user_id> <duration|off> [reason]',
  aliases: ['mute', 'to'],
  permissions: {
    user: PermissionFlagsBits.ModerateMembers,
    client: PermissionFlagsBits.ModerateMembers
  },
  cooldown: 3,

  async execute(message, args) {
    const guildId = message.guild.id;

    try {
      const prefix = await getPrefix(guildId);
      const durationHelp =
        `**Duration Parameters:**\n` +
        `${GLYPHS.INFO} \`5m\` — 5 minutes\n` +
        `${GLYPHS.INFO} \`1h\` — 1 hour\n` +
        `${GLYPHS.INFO} \`1d12h\` — 1 day 12 hours\n` +
        `${GLYPHS.INFO} \`1w\` — 1 week (maximum 28 days)\n` +
        `${GLYPHS.INFO} \`off\` — Remove an active timeout`;

      const userId = args[0]?.replace(/[<@!>]/g, '');
      if (!userId || !USER_ID.test(userId)) {
        return message.reply({
          embeds: [await errorEmbed(guildId, 'Invalid Usage',
            `${GLYPHS.ARROW_RIGHT} Usage: \`${prefix}timeout <@user|user_id> <duration|off> [reason]\`\n\n${durationHelp}`)]
        });
      }

      if (userId === message.author.id) {
        return message.reply({ embeds: [await errorEmbed(guildId, 'Permission Denied', 'You cannot time yourself out, Master.')] });
      }
      if (userId === message.client.user.id) {
        return message.reply({ embeds: [await errorEmbed(guildId, 'Invalid Usage', 'I cannot time myself out, Master.')] });
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

      if (!targetMember.moderatable) {
        return message.reply({ embeds: [await errorEmbed(guildId, 'Cannot Timeout', botLimitReason(targetMember))] });
      }
      if (!outranks(message.member, targetMember)) {
        return message.reply({
          embeds: [await errorEmbed(guildId, 'Permission Denied',
            'Their highest role is equal to or above yours, so you cannot moderate them, Master.')]
        });
      }

      const durationArg = args[1]?.toLowerCase();

      if (REMOVE_KEYWORDS.includes(durationArg)) {
        return await removeTimeout(message, targetMember, args.slice(2));
      }

      if (!durationArg) {
        return message.reply({
          embeds: [await errorEmbed(guildId, 'Invalid Usage', `**Notice:** A duration is required, Master.\n\n${durationHelp}`)]
        });
      }

      let durationMs = parseDuration(durationArg);
      if (!durationMs) {
        return message.reply({
          embeds: [await errorEmbed(guildId, 'Invalid Usage', `**Warning:** \`${truncate(durationArg.replace(/`/g, ''), 50)}\` is not a valid duration, Master.\n\n${durationHelp}`)]
        });
      }
      if (durationMs > DISCORD_MAX_TIMEOUT_MS) {
        return message.reply({
          embeds: [await errorEmbed(guildId, 'Invalid Usage', 'The maximum timeout duration is 28 days, Master.')]
        });
      }
      durationMs = Math.min(durationMs, MAX_TIMEOUT_MS);

      const reason = truncate(args.slice(2).join(' ').trim() || 'No reason provided', EMBED_REASON_LIMIT);
      const targetUser = targetMember.user;
      const duration = formatDuration(durationMs);
      const expiresAt = Date.now() + durationMs;
      const guildConfig = await Guild.getGuild(guildId);

      // Notify right before acting; withdrawn below if the timeout is rejected
      let notice = null;
      try {
        const dmEmbed = await errorEmbed(guildId, 'Timeout Notice',
          `**Caution:** You have been timed out in **${message.guild.name}**.\n\n` +
          `${GLYPHS.ARROW_RIGHT} **Duration:** ${duration}\n` +
          `${GLYPHS.ARROW_RIGHT} **Reason:** ${reason}\n` +
          `${GLYPHS.ARROW_RIGHT} **Moderator:** ${message.author.tag}\n\n` +
          `Communication resumes <t:${Math.floor(expiresAt / 1000)}:R>.`
        );
        notice = await targetMember.send({ embeds: [dmEmbed] });
      } catch {
        // DMs closed
      }

      try {
        await targetMember.timeout(durationMs, truncate(reason, AUDIT_REASON_LIMIT));
      } catch (error) {
        await notice?.delete().catch(() => {});
        logger.error(`[Timeout] Discord rejected the timeout of ${userId} in ${guildId}`, error);
        return message.reply({
          embeds: [await errorEmbed(guildId, 'Timeout Failed', error.code === MISSING_PERMISSIONS
            ? 'Discord denied me permission to time out this member, Master.'
            : 'Discord rejected the timeout request, Master. The incident has been logged.')]
        });
      }

      // Apply muted role if configured
      const mutedRole = guildConfig?.roles?.mutedRole ? message.guild.roles.cache.get(guildConfig.roles.mutedRole) : null;
      if (mutedRole && targetMember.manageable) {
        await targetMember.roles.add(mutedRole, truncate(`[Timeout] ${reason}`, AUDIT_REASON_LIMIT))
          .catch(err => logger.warn(`[Timeout] Failed to add muted role: ${err.message}`));
      }

      const caseNumber = await recordCase(message, targetUser, {
        action: 'timeout',
        reason,
        duration,
        mute: {
          moderatorId: message.author.id,
          reason,
          duration: durationMs / 1000,
          timestamp: new Date(),
          expiresAt: new Date(expiresAt)
        }
      });

      await postModLog(message, guildConfig, 'timeout', {
        caseNumber: caseNumber ?? '—',
        targetTag: targetUser.tag,
        targetId: targetUser.id,
        moderatorTag: message.author.tag,
        reason,
        duration
      });

      const embed = await successEmbed(guildId, 'Restriction Applied',
        `**Confirmed:** Communication restriction applied to **${targetUser.tag}**, Master.\n\n` +
        `${GLYPHS.ARROW_RIGHT} **Duration:** ${duration}\n` +
        `${GLYPHS.ARROW_RIGHT} **Reason:** ${reason}\n` +
        `${GLYPHS.ARROW_RIGHT} **Expires:** <t:${Math.floor(expiresAt / 1000)}:R>\n` +
        (caseNumber
          ? `${GLYPHS.ARROW_RIGHT} **Case Reference:** #${caseNumber}`
          : `${GLYPHS.ERROR} The case record could not be saved. The incident has been logged.`)
      );
      return message.reply({ embeds: [embed] });
    } catch (error) {
      logger.error('[Timeout] Command failed', error);
      const embed = await errorEmbed(guildId, 'Timeout Failed',
        'An anomaly interrupted the timeout protocol, Master. The incident has been logged.').catch(() => null);
      return message.reply(embed ? { embeds: [embed] } : { content: '**Alert:** The timeout protocol failed, Master.' }).catch(() => null);
    }
  }
};

// `timeout @user off [reason]`: same result and records as the untimeout command
async function removeTimeout(message, targetMember, reasonArgs) {
  const guildId = message.guild.id;
  const targetUser = targetMember.user;

  if (!targetMember.isCommunicationDisabled()) {
    return message.reply({
      embeds: [await errorEmbed(guildId, 'No Active Timeout', `**Notice:** **${targetUser.tag}** is not currently timed out, Master.`)]
    });
  }

  const reason = truncate(reasonArgs.join(' ').trim() || 'No reason provided', EMBED_REASON_LIMIT);
  const auditReason = truncate(`${reason} | Removed by ${message.author.tag}`, AUDIT_REASON_LIMIT);
  const guildConfig = await Guild.getGuild(guildId);

  try {
    await targetMember.timeout(null, auditReason);
  } catch (error) {
    logger.error(`[Timeout] Discord rejected the timeout removal for ${targetUser.id} in ${guildId}`, error);
    return message.reply({
      embeds: [await errorEmbed(guildId, 'Timeout Removal Failed', 'Discord rejected the request, Master. The incident has been logged.')]
    });
  }

  const mutedRole = guildConfig?.roles?.mutedRole ? message.guild.roles.cache.get(guildConfig.roles.mutedRole) : null;
  if (mutedRole && targetMember.roles.cache.has(mutedRole.id)) {
    await targetMember.roles.remove(mutedRole, auditReason)
      .catch(err => logger.warn(`[Timeout] Failed to remove muted role: ${err.message}`));
  }

  const caseNumber = await recordCase(message, targetUser, { action: 'untimeout', reason });

  await postModLog(message, guildConfig, 'untimeout', {
    caseNumber: caseNumber ?? '—',
    targetTag: targetUser.tag,
    targetId: targetUser.id,
    moderatorTag: message.author.tag,
    reason
  });

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
}

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

// Why `moderatable` is false: Discord exempts Administrators from timeouts entirely
function botLimitReason(target) {
  if (target.permissions.has(PermissionFlagsBits.Administrator)) {
    return 'Members with the Administrator permission cannot be timed out, Master. Discord exempts them from timeouts.';
  }
  const me = target.guild.members.me;
  return target.roles.highest.position >= me.roles.highest.position
    ? 'Their highest role is equal to or above mine, so I cannot moderate them, Master. Move my role above theirs in Server Settings › Roles.'
    : 'Discord does not permit me to moderate this member, Master.';
}

// Case and member records, written only after the action succeeded. Returns the case number,
// or null if it could not be saved (the action itself stands either way).
async function recordCase(message, user, { action, reason, duration, mute }) {
  const guildId = message.guild.id;
  let caseNumber = null;

  try {
    const nextCase = await ModLog.getNextCaseNumber(guildId);
    await ModLog.create({
      guildId,
      caseNumber: nextCase,
      action,
      moderatorId: message.author.id,
      moderatorTag: message.author.tag,
      targetId: user.id,
      targetTag: user.tag,
      reason,
      duration
    });
    caseNumber = nextCase;
  } catch (error) {
    logger.error(`[Timeout] Failed to save the ${action} case for ${user.id} in ${guildId}`, error);
  }

  if (mute) {
    try {
      await Member.updateOne(
        { userId: user.id, guildId },
        {
          $push: { mutes: mute },
          $setOnInsert: {
            username: user.username,
            discriminator: user.discriminator || '0',
            accountCreatedAt: user.createdAt
          }
        },
        { upsert: true }
      );
    } catch (error) {
      logger.error(`[Timeout] Failed to update the member record for ${user.id} in ${guildId}`, error);
    }
  }

  return caseNumber;
}

async function postModLog(message, guildConfig, action, logData) {
  try {
    const channelId = guildConfig?.channels?.modLog;
    const channel = channelId ? message.guild.channels.cache.get(channelId) : null;
    if (!channel) return;
    const embed = await modLogEmbed(message.guild.id, action, logData);
    if (action === 'untimeout') embed.setColor(COLORS.RAPHAEL_SUCCESS);
    await channel.send({ embeds: [embed] });
  } catch (error) {
    logger.warn(`[Timeout] Failed to post to the mod log in ${message.guild.id}: ${error.message}`);
  }
}

// "30m", "1d", "1d12h": one or more number+unit pairs (s, m, h, d, w)
function parseDuration(input) {
  if (!/^(\d+[smhdw])+$/.test(input)) return null;
  let total = 0;
  for (const [, value, unit] of input.matchAll(/(\d+)([smhdw])/g)) {
    total += Number(value) * UNIT_MS[unit];
  }
  return total > 0 ? total : null;
}

// Compound form: "1 week 3 days", "1 day 12 hours"
function formatDuration(ms) {
  let remaining = Math.round(ms / 1000) * 1000;
  const parts = [];
  for (const [name, size] of UNIT_NAMES) {
    const count = Math.floor(remaining / size);
    if (count > 0) {
      parts.push(`${count} ${name}${count === 1 ? '' : 's'}`);
      remaining -= count * size;
    }
  }
  return parts.join(' ') || '0 seconds';
}
