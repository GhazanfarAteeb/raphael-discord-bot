import { PermissionFlagsBits } from 'discord.js';
import Birthday from '../../models/Birthday.js';
import Guild from '../../models/Guild.js';
import { successEmbed, errorEmbed, GLYPHS } from '../../utils/embeds.js';
import { getPrefix } from '../../utils/helpers.js';
import { sendBirthdayAnnouncement } from '../config/birthdayconfig.js';
import { validateBirthDate, formatDate } from './requestbirthday.js';

/**
 * Announce a birthday right away if it is today, the birthday system is enabled,
 * and it has not been celebrated yet today. Shared by setbirthday, approvebday and
 * the birthday ticket buttons. The announcement itself comes from birthdayconfig, so it
 * matches the scheduled one: every placeholder is filled in, the age follows the guild and
 * member privacy settings, and only the birthday member can be pinged.
 * Returns the channel ID the announcement went to, or null if nothing was sent.
 */
export async function celebrateBirthdayIfToday(guild, guildConfig, birthday) {
  const settings = guildConfig?.features?.birthdaySystem || {};
  if (settings.enabled === false) return null;
  if (!birthday.isBirthdayToday()) return null;

  const today = new Date().toDateString();
  if (birthday.lastCelebrated && new Date(birthday.lastCelebrated).toDateString() === today) return null;

  const channelId = settings.channel || guildConfig?.channels?.birthdayChannel;
  const channel = channelId ? guild.channels.cache.get(channelId) : null;
  if (!channel) return null;

  const member = await guild.members.fetch(birthday.userId).catch(() => null);
  if (!member) return null;

  const sent = await sendBirthdayAnnouncement({ channel, member, guildConfig, birthday });
  if (!sent) return null;

  birthday.lastCelebrated = new Date();
  birthday.notificationSent = true;
  await birthday.save();

  return channel.id;
}

// "<@123>", "<@!123>" or a bare ID; anything else is not a target
function parseUserId(arg) {
  const match = String(arg ?? '').match(/^(?:<@!?(\d{17,20})>|(\d{17,20}))$/);
  return match ? (match[1] || match[2]) : null;
}

export default {
  name: 'setbirthday',
  description: 'Set a member\'s birthday for celebrations (Staff command)',
  usage: '<@user|user_id> <month> <day> [year] [--fake] [--private] [--showage]',
  category: 'community',
  permissions: [PermissionFlagsBits.ManageRoles],
  cooldown: 5,
  execute: async (message, args) => {
    const guildId = message.guild.id;

    try {
      const guildConfig = await Guild.getGuild(guildId, message.guild.name);
      const isStaff = message.member.permissions.has(PermissionFlagsBits.ManageRoles) ||
        message.member.permissions.has(PermissionFlagsBits.Administrator) ||
        (guildConfig?.roles?.staffRoles || []).some(roleId => message.member.roles.cache.has(roleId));

      if (!isStaff) {
        return message.reply({
          embeds: [await errorEmbed(guildId, 'Permission Denied', 'Staff permissions are required for this skill, Master.')]
        });
      }

      const prefix = await getPrefix(guildId);
      const flags = args.filter(arg => arg.startsWith('--')).map(arg => arg.toLowerCase());
      const cleanArgs = args.filter(arg => !arg.startsWith('--'));

      if (cleanArgs.length < 3) {
        return message.reply({
          embeds: [await errorEmbed(guildId, 'Missing Parameters',
            'Please provide a member and their birthday, Master.\n\n' +
            `**Usage:** \`${prefix}setbirthday <@user|user_id> <month> <day> [year] [--fake] [--private] [--showage]\`\n\n` +
            '**Examples:**\n' +
            `${GLYPHS.DOT} \`${prefix}setbirthday @User 12 25\` — December 25\n` +
            `${GLYPHS.DOT} \`${prefix}setbirthday @User 12 25 2000\` — December 25, 2000\n` +
            `${GLYPHS.DOT} \`${prefix}setbirthday @User 12 25 --fake\` — not their real birthday (privacy)\n` +
            `${GLYPHS.DOT} \`${prefix}setbirthday @User 12 25 2000 --showage\` — show their age in announcements\n\n` +
            'Ages are hidden unless `--showage` is given; `--private` hides it again.')]
        });
      }

      // The first argument is the target. Mentions are not used: a reply's author counts as a mention.
      const targetId = parseUserId(cleanArgs[0]);
      const targetUser = targetId ? await message.client.users.fetch(targetId).catch(() => null) : null;

      if (!targetUser) {
        return message.reply({
          embeds: [await errorEmbed(guildId, 'Member Not Found',
            `The first argument must be a member mention or user ID, Master.\n\n**Usage:** \`${prefix}setbirthday <@user|user_id> <month> <day> [year]\``)]
        });
      }

      const userId = targetUser.id;
      const isFake = flags.includes('--fake');
      const isPrivate = flags.includes('--private');
      const wantsAge = flags.includes('--showage');

      const month = parseInt(cleanArgs[1], 10);
      const day = parseInt(cleanArgs[2], 10);
      const year = cleanArgs[3] !== undefined ? parseInt(cleanArgs[3], 10) : null;

      const dateError = validateBirthDate(month, day, Number.isNaN(year) ? -1 : year);
      if (dateError) {
        return message.reply({ embeds: [await errorEmbed(guildId, 'Invalid Date', dateError)] });
      }

      // Age stays hidden unless staff opt in, matching birthdays approved from requests
      let birthday = await Birthday.findOne({ guildId, userId });
      const showAge = wantsAge && !isPrivate ? true : (isPrivate ? false : (birthday?.showAge ?? false));

      const fields = {
        birthday: { month, day, year },
        username: targetUser.username,
        isActualBirthday: !isFake,
        showAge,
        source: 'staff',
        setBy: message.author.id,
        verified: true,
        verifiedBy: message.author.id,
        verifiedAt: new Date()
      };

      if (birthday) {
        birthday.set(fields);
      } else {
        birthday = new Birthday({ guildId, userId, ...fields });
      }

      await birthday.save();

      const isBirthdayToday = birthday.isBirthdayToday();
      const systemEnabled = guildConfig?.features?.birthdaySystem?.enabled !== false;

      // Assign birthday role if configured AND it's their birthday today
      const birthdayRoleId = guildConfig?.features?.birthdaySystem?.role || guildConfig?.roles?.birthdayRole;
      let roleAssigned = false;

      if (systemEnabled && birthdayRoleId && isBirthdayToday) {
        try {
          const member = await message.guild.members.fetch(userId).catch(() => null);
          const role = message.guild.roles.cache.get(birthdayRoleId);
          if (member && role && !member.roles.cache.has(birthdayRoleId)) {
            await member.roles.add(role, 'Birthday set by staff on their birthday');
            roleAssigned = true;
          }
        } catch (roleErr) {
          console.error('[setbirthday] Failed to assign birthday role:', roleErr);
        }
      }

      let celebrationChannelId = null;
      try {
        celebrationChannelId = await celebrateBirthdayIfToday(message.guild, guildConfig, birthday);
      } catch (celebrationErr) {
        console.error('[setbirthday] Failed to send birthday celebration:', celebrationErr);
      }

      let description = `Birthday for **${targetUser.tag}** set to **${formatDate({ month, day, year })}**, Master.`;

      if (isFake) description += `\n${GLYPHS.DOT} Marked as not their real birthday (privacy)`;
      if (year) description += `\n${GLYPHS.DOT} Age ${showAge ? 'shown' : 'hidden'} in announcements`;

      if (!isFake && year) {
        const age = birthday.getAge();
        if (age !== null) {
          description += `\n${GLYPHS.DOT} They turn ${age + 1} on their next birthday`;
        }
      }

      if (isBirthdayToday) {
        description += '\n\n**Notice:** Today is their birthday.';
        if (roleAssigned) description += `\n${GLYPHS.DOT} Birthday role assigned`;
        if (celebrationChannelId) description += `\n${GLYPHS.DOT} Celebration announced in <#${celebrationChannelId}>`;
        if (!systemEnabled) description += `\n${GLYPHS.DOT} The birthday system is disabled, so no celebration was sent`;
      }

      description += `\n\n**Source:** Staff (set by ${message.author.tag}) • Verified`;

      return message.reply({ embeds: [await successEmbed(guildId, 'Birthday Set', description)] });

    } catch (error) {
      console.error('[setbirthday] Error:', error);
      return message.reply({
        embeds: [await errorEmbed(guildId, 'Operation Failed', 'I was unable to set that birthday. Please try again, Master.')]
      });
    }
  }
};
