import { EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import Member from '../../models/Member.js';
import { errorEmbed, COLORS, GLYPHS } from '../../utils/embeds.js';
import { escapeMarkdown, truncate } from '../../utils/helpers.js';
import { getRandomFooter } from '../../utils/raphael.js';
import logger from '../../utils/logger.js';

const USER_ID = /^\d{17,20}$/;
const FIELD_LIMIT = 1024;
const RECENT_NAMES = 5;
const RECENT_JOINS = 3;
const RECENT_NOTES = 3;
const NOTE_PREVIEW = 200;

const unix = (date) => Math.floor(new Date(date).getTime() / 1000);
const safeName = (name) => escapeMarkdown(String(name));

export default {
  name: 'userhistory',
  description: 'View user tracking history (username changes, joins, etc.)',
  usage: 'userhistory [@user|user_id]',
  category: 'moderation',
  permissions: {
    user: PermissionFlagsBits.ModerateMembers
  },
  aliases: ['history', 'trackuser', 'userlookup'],

  execute: async (message, args) => {
    const guildId = message.guild.id;

    try {
      const targetUser = await resolveUser(message, args[0]);
      if (!targetUser) {
        return message.reply({
          embeds: [await errorEmbed(guildId, 'User Not Found', 'No Discord user matches that mention or ID, Master.')]
        });
      }

      const memberData = await Member.findOne({ userId: targetUser.id, guildId }).lean();
      if (!memberData) {
        return message.reply({
          embeds: [await errorEmbed(guildId, 'No Records', `I hold no tracking data for **${safeName(targetUser.tag)}**, Master.`)]
        });
      }

      const embed = new EmbedBuilder()
        .setColor(COLORS.RAPHAEL)
        .setTitle('『 User History 』')
        .setDescription(
          `**Analysis:** Tracking record for ${targetUser} (**${safeName(targetUser.tag)}**), Master.` +
          (memberData.createdAt ? `\nRecords kept since <t:${unix(memberData.createdAt)}:D>.` : '')
        )
        .setThumbnail(targetUser.displayAvatarURL({ size: 256 }))
        .setFooter({ text: getRandomFooter() })
        .setTimestamp();

      // Identity
      const username = memberData.username || targetUser.username;
      const identity = [
        `${GLYPHS.DOT} **Username:** ${safeName(username)}` +
          (memberData.discriminator && memberData.discriminator !== '0' ? `#${memberData.discriminator}` : '')
      ];
      if (memberData.displayName && memberData.displayName !== username) {
        identity.push(`${GLYPHS.DOT} **Display Name:** ${safeName(memberData.displayName)}`);
      }
      if (memberData.globalName && memberData.globalName !== memberData.displayName) {
        identity.push(`${GLYPHS.DOT} **Global Name:** ${safeName(memberData.globalName)}`);
      }
      identity.push(`${GLYPHS.DOT} **User ID:** \`${targetUser.id}\``);
      identity.push(`${GLYPHS.DOT} **Account Created:** <t:${unix(targetUser.createdTimestamp)}:D>`);
      embed.addFields({ name: `${GLYPHS.ARROW_RIGHT} Identity`, value: truncate(identity.join('\n'), FIELD_LIMIT) });

      // Username history
      const nameHistory = memberData.usernameHistory || [];
      if (nameHistory.length > 0) {
        const lines = nameHistory.slice(-RECENT_NAMES).reverse().map(entry => {
          const name = entry.discriminator && entry.discriminator !== '0'
            ? `${entry.username}#${entry.discriminator}`
            : entry.username;
          const display = entry.displayName && entry.displayName !== entry.username ? ` (${entry.displayName})` : '';
          const changed = entry.changedAt ? ` — <t:${unix(entry.changedAt)}:D>` : '';
          return `${GLYPHS.DOT} ${safeName(`${name}${display}`)}${changed}`;
        });
        embed.addFields({
          name: `${GLYPHS.ARROW_RIGHT} Username History (last ${Math.min(RECENT_NAMES, nameHistory.length)} of ${nameHistory.length})`,
          value: truncate(lines.join('\n'), FIELD_LIMIT)
        });
      }

      // Join/leave and moderation counts
      embed.addFields(
        {
          name: `${GLYPHS.ARROW_RIGHT} Join Activity`,
          value:
            `${GLYPHS.DOT} **Joins:** ${memberData.joinCount ?? 0}\n` +
            `${GLYPHS.DOT} **Leaves:** ${memberData.leaveCount ?? 0}\n` +
            `${GLYPHS.DOT} **Sus Level:** ${memberData.susLevel ?? 0}/10\n` +
            `${GLYPHS.DOT} **Status:** ${memberData.isSuspicious ? `${GLYPHS.ERROR} Suspicious` : 'Normal'}`,
          inline: true
        },
        {
          name: `${GLYPHS.ARROW_RIGHT} Moderation`,
          value:
            `${GLYPHS.DOT} **Warnings:** ${memberData.warnings?.length || 0}\n` +
            `${GLYPHS.DOT} **Timeouts:** ${memberData.mutes?.length || 0}\n` +
            `${GLYPHS.DOT} **Kicks:** ${memberData.kicks?.length || 0}\n` +
            `${GLYPHS.DOT} **Bans:** ${memberData.bans?.length || 0}`,
          inline: true
        }
      );

      // Recent joins
      const joinHistory = memberData.joinHistory || [];
      if (joinHistory.length > 0) {
        const lines = joinHistory.slice(-RECENT_JOINS).reverse().map(join => {
          let line = `${GLYPHS.DOT} <t:${unix(join.timestamp)}:D>`;
          if (join.inviteCode) line += ` via \`${join.inviteCode}\``;
          if (join.inviter) line += ` (invited by <@${join.inviter}>)`;
          return line;
        });
        embed.addFields({
          name: `${GLYPHS.ARROW_RIGHT} Recent Joins (last ${Math.min(RECENT_JOINS, joinHistory.length)} of ${joinHistory.length})`,
          value: truncate(lines.join('\n'), FIELD_LIMIT)
        });
      }

      // Flags
      const flags = [];
      if (memberData.flags?.radarOn) flags.push(`${GLYPHS.RADAR} On radar`);
      if (memberData.flags?.verified) flags.push(`${GLYPHS.SUCCESS} Verified`);
      if (memberData.flags?.autoModBypass) flags.push(`${GLYPHS.UNLOCK} AutoMod bypass`);
      if (memberData.isNewAccount) flags.push(`${GLYPHS.EGG} New account`);
      if (flags.length > 0) {
        embed.addFields({ name: `${GLYPHS.ARROW_RIGHT} Flags`, value: flags.join('\n') });
      }

      // Staff notes (no separate notes command exists, so the latest are shown here)
      const notes = memberData.notes || [];
      if (notes.length > 0) {
        const lines = notes.slice(-RECENT_NOTES).reverse().map(entry => {
          const when = entry.timestamp ? ` — <t:${unix(entry.timestamp)}:D>` : '';
          const author = entry.staffTag ? ` by ${safeName(entry.staffTag)}` : '';
          return `${GLYPHS.DOT} ${truncate(safeName(entry.note || 'No content'), NOTE_PREVIEW)}${author}${when}`;
        });
        embed.addFields({
          name: `${GLYPHS.ARROW_RIGHT} Staff Notes (last ${Math.min(RECENT_NOTES, notes.length)} of ${notes.length})`,
          value: truncate(lines.join('\n'), FIELD_LIMIT)
        });
      }

      return message.reply({ embeds: [embed] });
    } catch (error) {
      logger.error('[UserHistory] Command failed', error);
      const embed = await errorEmbed(guildId, 'Lookup Failed',
        'An anomaly interrupted the history lookup, Master. The incident has been logged.').catch(() => null);
      return message.reply(embed ? { embeds: [embed] } : { content: '**Alert:** The history lookup failed, Master.' }).catch(() => null);
    }
  }
};

// Mentioned user, a user ID, or the author when no target was given
async function resolveUser(message, arg) {
  const mentioned = message.mentions?.users?.first();
  if (mentioned) return mentioned;
  if (!arg) return message.author;

  const userId = arg.replace(/[<@!>]/g, '');
  if (!USER_ID.test(userId)) return null;
  return message.client.users.fetch(userId).catch(() => null);
}
