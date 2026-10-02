import { Events, EmbedBuilder, AuditLogEvent } from 'discord.js';
import Guild from '../../models/Guild.js';
import { COLORS, GLYPHS } from '../../utils/embeds.js';
import { sleep, truncate } from '../../utils/helpers.js';

// Audit log entries appear shortly after the gateway event
const AUDIT_LOG_DELAY_MS = 500;
const AUDIT_LOG_WINDOW_MS = 5000;
const AUDIT_LOG_FETCH_LIMIT = 5;
const FIELD_VALUE_MAX = 1024;
// Room kept for the " (+N more)" suffix of a truncated list
const MORE_SUFFIX_RESERVE = 20;

const COLOR = {
  update: COLORS.RAPHAEL,
  added: COLORS.RAPHAEL_SUCCESS,
  removed: COLORS.RAPHAEL_ERROR,
  warning: COLORS.RAPHAEL_WARNING,
  muted: COLORS.MUTED
};

export default {
  name: 'memberLogging',

  async initialize(client) {
    // Member role updates
    client.on(Events.GuildMemberUpdate, async (oldMember, newMember) => {
      await logMemberUpdate(oldMember, newMember);
    });

    // Member ban
    client.on(Events.GuildBanAdd, async (ban) => {
      await logBan(ban, true);
    });

    // Member unban
    client.on(Events.GuildBanRemove, async (ban) => {
      await logBan(ban, false);
    });

    console.log('[RAPHAEL] Member logging initialized');
  }
};

/**
 * Who performed a recent change to `targetId`, from the audit log
 * @param {string} [changeKey] only entries that changed this key (several member
 *   changes share one audit log type)
 */
async function findExecutor(guild, targetId, type, changeKey = null) {
  try {
    await sleep(AUDIT_LOG_DELAY_MS);

    const auditLogs = await guild.fetchAuditLogs({ limit: AUDIT_LOG_FETCH_LIMIT, type });

    const entry = auditLogs.entries.find(e =>
      e.target?.id === targetId &&
      Date.now() - e.createdTimestamp < AUDIT_LOG_WINDOW_MS &&
      (!changeKey || e.changes?.some(change => change.key === changeKey))
    );

    return entry?.executor ?? null;
  } catch {
    // Missing permission to view the audit log
    return null;
  }
}

function describeExecutor(executor, targetId) {
  if (!executor) return 'Unknown';
  if (executor.id === executor.client.user.id) return 'System';
  if (executor.id === targetId) return 'Self';
  if (executor.bot) return `${executor.username} (bot)`;
  return executor.username;
}

// Join items without exceeding a field value, noting how many were left out
function joinWithinLimit(items, separator = ', ', limit = FIELD_VALUE_MAX) {
  const shown = [];
  let length = 0;

  for (let i = 0; i < items.length; i++) {
    const added = (shown.length ? separator.length : 0) + items[i].length;
    const reserve = i < items.length - 1 ? MORE_SUFFIX_RESERVE : 0;
    if (length + added + reserve > limit) {
      return `${shown.join(separator)} (+${items.length - i} more)`;
    }
    shown.push(items[i]);
    length += added;
  }

  return shown.join(separator) || 'None';
}

function field(name, value, inline = true) {
  return { name: `${GLYPHS.ARROW_RIGHT} ${name}`, value: truncate(String(value || 'None'), FIELD_VALUE_MAX), inline };
}

function memberEmbed(member, title, color, description) {
  return new EmbedBuilder()
    .setTitle(`『 ${title} 』`)
    .setColor(color)
    .setDescription(description)
    .setThumbnail(member.user.displayAvatarURL())
    .setFooter({ text: `User ID: ${member.id}` })
    .setTimestamp();
}

async function logMemberUpdate(oldMember, newMember) {
  try {
    if (newMember.user.bot) return;

    // Skip if oldMember is partial (cache incomplete) - this causes false positives
    if (oldMember.partial) return;

    const guildConfig = await Guild.getGuild(newMember.guild.id, newMember.guild.name);

    if (!guildConfig?.channels?.memberLog) return;

    const logChannel = newMember.guild.channels.cache.get(guildConfig.channels.memberLog);
    if (!logChannel) return;

    const guild = newMember.guild;
    const username = newMember.user.username;
    const embeds = [];

    // Nickname change
    if (oldMember.nickname !== newMember.nickname) {
      const executor = await findExecutor(guild, newMember.id, AuditLogEvent.MemberUpdate, 'nick');

      embeds.push(memberEmbed(newMember, 'Nickname Changed', COLOR.update,
        `${GLYPHS.ARROW_RIGHT} **${username}**'s nickname was changed.`)
        .addFields(
          field('Before', oldMember.nickname || '*None*'),
          field('After', newMember.nickname || '*None*'),
          field('Changed By', describeExecutor(executor, newMember.id))
        ));
    }

    // Role changes. A cached member holding only @everyone may simply not have had its
    // roles cached yet (e.g. after a restart); comparing would report every role as new.
    const rolesComparable = !(oldMember.roles.cache.size <= 1 && newMember.roles.cache.size > 1);
    const guildId = guild.id;
    const addedRoles = rolesComparable
      ? newMember.roles.cache.filter(role => role.id !== guildId && !oldMember.roles.cache.has(role.id))
      : null;
    const removedRoles = rolesComparable
      ? oldMember.roles.cache.filter(role => role.id !== guildId && !newMember.roles.cache.has(role.id))
      : null;

    if (addedRoles?.size || removedRoles?.size) {
      const executor = await findExecutor(guild, newMember.id, AuditLogEvent.MemberRoleUpdate);
      const by = describeExecutor(executor, newMember.id);

      if (addedRoles.size > 0) {
        embeds.push(memberEmbed(newMember, 'Roles Added', COLOR.added,
          `${GLYPHS.ARROW_RIGHT} **${username}** received ${addedRoles.size === 1 ? 'a role' : `${addedRoles.size} roles`}.`)
          .addFields(
            field('Member', `${newMember.user.tag} (${newMember})`),
            field('Assigned By', by),
            field('Roles Added', joinWithinLimit(addedRoles.map(r => r.toString())), false)
          ));
      }

      if (removedRoles.size > 0) {
        embeds.push(memberEmbed(newMember, 'Roles Removed', COLOR.removed,
          `${GLYPHS.ARROW_RIGHT} **${username}** lost ${removedRoles.size === 1 ? 'a role' : `${removedRoles.size} roles`}.`)
          .addFields(
            field('Member', `${newMember.user.tag} (${newMember})`),
            field('Removed By', by),
            field('Roles Removed', joinWithinLimit(removedRoles.map(r => r.toString())), false)
          ));
      }
    }

    // Timeout changes. Compare timestamps: the Date getters return a new object each
    // time, so comparing them directly reported a timeout on every member update.
    const oldTimeout = oldMember.communicationDisabledUntilTimestamp ?? null;
    const newTimeout = newMember.communicationDisabledUntilTimestamp ?? null;
    if (oldTimeout !== newTimeout) {
      const executor = await findExecutor(guild, newMember.id, AuditLogEvent.MemberUpdate, 'communication_disabled_until');
      const by = describeExecutor(executor, newMember.id);

      if (newTimeout && newTimeout > Date.now()) {
        const until = Math.floor(newTimeout / 1000);
        embeds.push(memberEmbed(newMember, 'Member Timed Out', COLOR.warning,
          `${GLYPHS.ARROW_RIGHT} **${username}** was timed out.`)
          .addFields(
            field('Member', `${newMember.user.tag} (${newMember})`),
            field('Until', `<t:${until}:F> (<t:${until}:R>)`),
            field('Timed Out By', by)
          ));
      } else if (oldTimeout && oldTimeout > Date.now()) {
        // Lifted before it ran out (an expired timeout sends no update)
        embeds.push(memberEmbed(newMember, 'Timeout Lifted', COLOR.added,
          `${GLYPHS.ARROW_RIGHT} **${username}**'s timeout restriction has been removed.`)
          .addFields(
            field('Member', `${newMember.user.tag} (${newMember})`),
            field('Lifted By', by)
          ));
      }
    }

    // Boost changes
    if (!oldMember.premiumSince && newMember.premiumSince) {
      embeds.push(memberEmbed(newMember, 'New Server Booster', COLOR.added,
        `${GLYPHS.ARROW_RIGHT} **${username}** boosted the server.`)
        .addFields(
          field('Member', `${newMember.user.tag} (${newMember})`),
          field('Boost Count', `${guild.premiumSubscriptionCount ?? 'Unknown'}`)
        ));
    } else if (oldMember.premiumSince && !newMember.premiumSince) {
      embeds.push(memberEmbed(newMember, 'Boost Removed', COLOR.muted,
        `${GLYPHS.ARROW_RIGHT} **${username}** is no longer boosting the server.`)
        .addFields(
          field('Member', `${newMember.user.tag} (${newMember})`)
        ));
    }

    // Avatar change (server specific)
    if (oldMember.avatar !== newMember.avatar && newMember.avatar) {
      embeds.push(memberEmbed(newMember, 'Server Avatar Changed', COLOR.update,
        `${GLYPHS.ARROW_RIGHT} **${username}** changed their server avatar.`)
        .addFields(
          field('Member', `${newMember.user.tag} (${newMember})`)
        )
        .setThumbnail(newMember.displayAvatarURL())
        .setImage(newMember.displayAvatarURL({ size: 256 })));
    }

    // Send all embeds
    for (const embed of embeds) {
      await logChannel.send({ embeds: [embed] });
    }

  } catch (error) {
    console.error('[MemberLogging] Error logging member update:', error);
  }
}

async function logBan(ban, isBan) {
  try {
    const guildConfig = await Guild.getGuild(ban.guild.id, ban.guild.name);

    if (!guildConfig?.channels?.memberLog) return;

    const logChannel = ban.guild.channels.cache.get(guildConfig.channels.memberLog);
    if (!logChannel) return;

    const embed = new EmbedBuilder()
      .setTitle(isBan ? '『 Member Banned 』' : '『 Member Unbanned 』')
      .setColor(isBan ? COLOR.removed : COLOR.added)
      .setDescription(`${GLYPHS.ARROW_RIGHT} **${ban.user.username}** was ${isBan ? 'banned from' : 'unbanned in'} the server.`)
      .addFields(
        field('User', `${ban.user.tag} (${ban.user})`),
        field('User ID', ban.user.id)
      )
      .setThumbnail(ban.user.displayAvatarURL())
      .setTimestamp();

    if (ban.reason) {
      embed.addFields(field('Reason', ban.reason, false));
    }

    await logChannel.send({ embeds: [embed] });

  } catch (error) {
    console.error('[MemberLogging] Error logging ban:', error);
  }
}
