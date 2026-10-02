import { PermissionFlagsBits } from 'discord.js';
import Guild from '../../models/Guild.js';
import { successEmbed, errorEmbed, infoEmbed, GLYPHS } from '../../utils/embeds.js';
import { getPrefix, hasAdminPerms, getAssignableRoleError, truncate } from '../../utils/helpers.js';
import { parseBirthdayMessage, getBirthdayTemplate } from '../config/birthdayconfig.js';

// Leaves room in the announcement embed description / plain message for expanded placeholders
const MAX_MESSAGE_LENGTH = 1500;
const PREVIEW_AGE = 25;

export default {
  name: 'birthdaypreference',
  aliases: ['bdpref', 'birthdaysettings', 'bdsettings'],
  description: 'Configure birthday system settings (Admin only)',
  usage: '<channel|role|message|enable|disable|status> [value]',
  category: 'config',
  permissions: {
    user: PermissionFlagsBits.Administrator
  },

  async execute(message, args) {
    const guildId = message.guild.id;

    try {
      const guildConfig = await Guild.getGuild(guildId, message.guild.name);
      const prefix = await getPrefix(guildId);

      if (!hasAdminPerms(message.member, guildConfig)) {
        return message.reply({
          embeds: [await errorEmbed(guildId, 'Permission Denied',
            'Administrator permissions are required to configure birthday settings, Master.')]
        });
      }

      const action = args[0]?.toLowerCase();

      switch (action) {
        case 'channel':
          return setChannel(message, args, prefix);
        case 'role':
          return setRole(message, args, prefix);
        case 'message':
          return setMessage(message, args, prefix);
        case 'enable':
        case 'on':
          return toggleSystem(message, true);
        case 'disable':
        case 'off':
          return toggleSystem(message, false);
        case 'status':
          return showStatus(message, guildConfig, prefix);
        default:
          return showHelp(message, guildConfig, prefix);
      }
    } catch (error) {
      console.error('[birthdaypreference] Error:', error);
      return message.reply({
        embeds: [await errorEmbed(guildId, 'Operation Failed', 'I was unable to update the birthday settings, Master.')]
      });
    }
  }
};

function describeSettings(bs) {
  return `**Status:** ${bs?.enabled !== false ? '◉ Enabled' : '◇ Disabled'}\n` +
    `**Announcement Channel:** ${bs?.channel ? `<#${bs.channel}>` : 'Not set'}\n` +
    `**Birthday Role:** ${bs?.role ? `<@&${bs.role}>` : 'Not set'}`;
}

async function showHelp(message, guildConfig, prefix) {
  const embed = await infoEmbed(message.guild.id, 'Birthday Settings',
    `${describeSettings(guildConfig?.features?.birthdaySystem)}\n\n` +
    '**Commands:**\n' +
    `${GLYPHS.DOT} \`${prefix}birthdaypreference channel #channel\` — Set announcement channel\n` +
    `${GLYPHS.DOT} \`${prefix}birthdaypreference role @role\` — Set birthday role\n` +
    `${GLYPHS.DOT} \`${prefix}birthdaypreference message <text>\` — Set custom message\n` +
    `${GLYPHS.DOT} \`${prefix}birthdaypreference enable\` — Enable birthday system\n` +
    `${GLYPHS.DOT} \`${prefix}birthdaypreference disable\` — Disable birthday system\n` +
    `${GLYPHS.DOT} \`${prefix}birthdaypreference status\` — View current settings\n\n` +
    '**Message Variables:**\n' +
    `${GLYPHS.DOT} \`{user}\` — Mentions the birthday member\n` +
    `${GLYPHS.DOT} \`{username}\` — Their username\n` +
    `${GLYPHS.DOT} \`{age}\` — Their age (if a birth year was provided)`
  );

  return message.reply({ embeds: [embed] });
}

async function setChannel(message, args, prefix) {
  const channel = message.mentions.channels.first() ||
    message.guild.channels.cache.get(args[1]?.replace(/[<#>]/g, ''));

  if (!channel?.isTextBased()) {
    return message.reply({
      embeds: [await errorEmbed(message.guild.id, 'Invalid Channel',
        `Please mention a text channel or provide its ID, Master.\n\n**Usage:** \`${prefix}birthdaypreference channel #channel\``)]
    });
  }

  await Guild.updateGuild(message.guild.id, {
    $set: {
      'features.birthdaySystem.channel': channel.id,
      'channels.birthdayChannel': channel.id
    }
  });

  return message.reply({
    embeds: [await successEmbed(message.guild.id, 'Birthday Channel Set',
      `Birthday announcements will now be sent to ${channel}, Master.`)]
  });
}

async function setRole(message, args, prefix) {
  const role = message.mentions.roles.first() ||
    message.guild.roles.cache.get(args[1]?.replace(/[<@&>]/g, ''));

  if (!role) {
    return message.reply({
      embeds: [await errorEmbed(message.guild.id, 'Invalid Role',
        `Please mention a role or provide its ID, Master.\n\n**Usage:** \`${prefix}birthdaypreference role @role\``)]
    });
  }

  // The birthday role is handed out automatically, so it must not carry moderation powers
  const roleError = getAssignableRoleError(role, message.member);
  if (roleError) {
    return message.reply({ embeds: [await errorEmbed(message.guild.id, 'Role Not Allowed', roleError)] });
  }

  await Guild.updateGuild(message.guild.id, { $set: { 'features.birthdaySystem.role': role.id } });

  return message.reply({
    embeds: [await successEmbed(message.guild.id, 'Birthday Role Set',
      `Birthday role set to ${role}, Master.\n\nIt will be assigned to members on their birthday.`)]
  });
}

async function setMessage(message, args, prefix) {
  const customMessage = args.slice(1).join(' ');

  if (!customMessage) {
    return message.reply({
      embeds: [await errorEmbed(message.guild.id, 'No Message Provided',
        'Please provide a custom birthday message, Master.\n\n' +
        `**Usage:** \`${prefix}birthdaypreference message Happy Birthday {user}! You are now {age} years old.\`\n\n` +
        '**Variables:**\n' +
        `${GLYPHS.DOT} \`{user}\` — Mentions the member\n` +
        `${GLYPHS.DOT} \`{username}\` — Their username\n` +
        `${GLYPHS.DOT} \`{age}\` — Their age`)]
    });
  }

  if (customMessage.length > MAX_MESSAGE_LENGTH) {
    return message.reply({
      embeds: [await errorEmbed(message.guild.id, 'Message Too Long',
        `The birthday message may be at most ${MAX_MESSAGE_LENGTH} characters (yours is ${customMessage.length}), Master.`)]
    });
  }

  await Guild.updateGuild(message.guild.id, { $set: { 'features.birthdaySystem.message': customMessage } });

  // Same placeholder handling as the real announcement (every occurrence is replaced)
  const preview = parseBirthdayMessage(customMessage, message.member, PREVIEW_AGE);

  return message.reply({
    embeds: [await successEmbed(message.guild.id, 'Birthday Message Set',
      `Custom birthday message updated, Master.\n\n**Preview:**\n${truncate(preview, 2000)}`)]
  });
}

async function toggleSystem(message, enabled) {
  await Guild.updateGuild(message.guild.id, { $set: { 'features.birthdaySystem.enabled': enabled } });

  return message.reply({
    embeds: [await successEmbed(message.guild.id,
      enabled ? 'Birthday System Enabled' : 'Birthday System Disabled',
      `Birthday celebrations are now ${enabled ? 'enabled' : 'disabled'}, Master.`)]
  });
}

async function showStatus(message, guildConfig, prefix) {
  const bs = guildConfig?.features?.birthdaySystem;

  return message.reply({
    embeds: [await infoEmbed(message.guild.id, 'Birthday System Status',
      `${describeSettings(bs)}\n` +
      `**Custom Message:** ${truncate(getBirthdayTemplate(bs), 1500)}\n\n` +
      `Use \`${prefix}birthdaypreference help\` to see configuration commands.`)]
  });
}
