import { PermissionFlagsBits } from 'discord.js';
import Guild from '../../models/Guild.js';
import { successEmbed, errorEmbed, warningEmbed, infoEmbed, GLYPHS } from '../../utils/embeds.js';
import { getPrefix } from '../../utils/helpers.js';
import RateLimitQueue from '../../utils/RateLimitQueue.js';
import { LOG_TYPES } from './logs.js';

const FIELD_LIMIT = 1024;
// Editing overwrites needs Manage Channels plus Manage Roles ("Manage Permissions")
const BOT_PERMISSIONS = [PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ManageRoles];

// Join lines without passing a field limit; the rest is summarised as "and N more"
function fitLines(lines, limit = FIELD_LIMIT) {
  let text = '';
  for (let i = 0; i < lines.length; i++) {
    const line = (text ? '\n' : '') + lines[i];
    const remaining = lines.length - i - 1;
    const reserve = remaining > 0 ? `\n— and ${remaining} more`.length : 0;
    if (text.length + line.length + reserve > limit) {
      return `${text}${text ? '\n' : ''}— and ${lines.length - i} more`;
    }
    text += line;
  }
  return text;
}

// Accepts the setlogs key ("mod"), the config field ("modLog") or a channel-style name ("mod-log")
function findLogType(input) {
  const target = input.toLowerCase().replace(/[-_]/g, '');
  return Object.entries(LOG_TYPES).find(([key, log]) => {
    const field = log.field.toLowerCase();
    return key === target || field === target || field.replace(/log$/, '') === target;
  });
}

// Roles that should be able to read the log channels
function getStaffRoles(guild, guildConfig) {
  return [...new Set([
    ...(guildConfig.roles?.adminRoles || []),
    ...(guildConfig.roles?.staffRoles || []),
    ...(guildConfig.roles?.moderatorRoles || [])
  ])].filter(roleId => guild.roles.cache.has(roleId));
}

// Hide the channel from @everyone, let the bot post and let staff read
async function lockChannel(channel, guild, staffRoles) {
  await channel.permissionOverwrites.edit(guild.id, {
    ViewChannel: false,
    SendMessages: false
  });

  await channel.permissionOverwrites.edit(guild.client.user.id, {
    ViewChannel: true,
    SendMessages: true,
    EmbedLinks: true,
    AttachFiles: true
  });

  for (const roleId of staffRoles) {
    await channel.permissionOverwrites.edit(roleId, {
      ViewChannel: true,
      SendMessages: false // Staff can read but not post
    });
  }
}

export default {
  name: 'fixlogs',
  description: 'Fix permissions for all log channels (make them private to admins/staff only)',
  usage: '[all|<log-type>]',
  aliases: ['fixlogpermissions', 'logpermissions', 'fixlogchannels'],
  category: 'config',
  permissions: [PermissionFlagsBits.ManageChannels],
  cooldown: 10,

  async execute(message, args) {
    const guildId = message.guild.id;

    try {
      // Rewriting channel permissions needs the real Discord permission, not just a bot staff role
      if (!message.member.permissions.has(PermissionFlagsBits.ManageChannels)) {
        return message.reply({
          embeds: [await errorEmbed(guildId, 'Permission Denied',
            `${GLYPHS.LOCK} You need the **Manage Channels** permission to change log channel permissions.`)]
        });
      }

      const prefix = await getPrefix(guildId);
      const guildConfig = await Guild.getGuild(guildId);

      if (!args[0]) {
        return showHelp(message, prefix, guildConfig);
      }

      if (!message.guild.members.me.permissions.has(BOT_PERMISSIONS)) {
        return message.reply({
          embeds: [await errorEmbed(guildId, 'Missing Permissions',
            `${GLYPHS.ERROR} I need the **Manage Channels** and **Manage Roles** permissions to fix log channels, Master.`)]
        });
      }

      const target = args[0].toLowerCase();

      if (target === 'all') {
        return fixAllLogChannels(message, guildConfig, prefix);
      }

      const logEntry = findLogType(target);
      if (!logEntry) {
        return message.reply({
          embeds: [await errorEmbed(guildId, 'Unknown Log Type',
            `${GLYPHS.ERROR} Unknown log type: \`${target}\`\n\n` +
            `**Available types:** ${Object.keys(LOG_TYPES).map(key => `\`${key}\``).join(', ')}`)]
        });
      }

      return fixSingleLogChannel(message, guildConfig, logEntry, prefix);
    } catch (error) {
      console.error('[FixLogs] Error:', error);
      return message.reply({
        embeds: [await errorEmbed(guildId, 'Configuration Error',
          'The log channel permissions could not be updated, Master. Please try again.')]
      }).catch(() => null);
    }
  }
};

async function showHelp(message, prefix, guildConfig) {
  const configured = [];
  const missing = [];

  for (const [key, log] of Object.entries(LOG_TYPES)) {
    const channelId = guildConfig.channels?.[log.field];
    if (!channelId) {
      missing.push(`${GLYPHS.DOT} **${key}:** Not configured`);
    } else if (!message.guild.channels.cache.has(channelId)) {
      missing.push(`${GLYPHS.DOT} **${key}:** Channel deleted`);
    } else {
      configured.push(`${GLYPHS.DOT} **${key}:** <#${channelId}>`);
    }
  }

  const embed = await infoEmbed(message.guild.id, 'Fix Log Channel Permissions',
    `${GLYPHS.INFO} Makes log channels private: hidden from @everyone and readable by admins and staff.`);

  embed.addFields(
    {
      name: `${GLYPHS.ARROW_RIGHT} Usage`,
      value:
        `\`${prefix}fixlogs all\` - Fix every configured log channel\n` +
        `\`${prefix}fixlogs <type>\` - Fix one log channel`
    },
    { name: `${GLYPHS.ARROW_RIGHT} Configured`, value: configured.length ? fitLines(configured) : 'None' }
  );
  if (missing.length) {
    embed.addFields({ name: `${GLYPHS.ARROW_RIGHT} Not Configured`, value: fitLines(missing) });
  }

  return message.reply({ embeds: [embed] });
}

async function fixAllLogChannels(message, guildConfig, prefix) {
  const guildId = message.guild.id;
  const queue = RateLimitQueue.forDiscord();
  const staffRoles = getStaffRoles(message.guild, guildConfig);

  // One channel often holds several logs: group them so each channel is processed once
  const byChannel = new Map();
  const skipped = [];
  for (const [key, log] of Object.entries(LOG_TYPES)) {
    const channelId = guildConfig.channels?.[log.field];
    if (!channelId) continue;
    if (!message.guild.channels.cache.has(channelId)) {
      skipped.push(`${GLYPHS.DOT} **${key}:** channel deleted`);
      continue;
    }
    if (!byChannel.has(channelId)) byChannel.set(channelId, []);
    byChannel.get(channelId).push(log.name);
  }

  if (byChannel.size === 0) {
    return message.reply({
      embeds: [await warningEmbed(guildId, 'No Log Channels',
        `${GLYPHS.WARNING} There are no log channels to fix, Master.\n\n` +
        `Set them with \`${prefix}setlogs set <type> #channel\` or create them with \`${prefix}setup\`.`)]
    });
  }

  const statusMsg = await message.reply({
    embeds: [await infoEmbed(guildId, 'Fixing Log Permissions',
      `${GLYPHS.LOADING} Processing ${byChannel.size} log channel(s)...`)]
  });

  const fixed = [];
  const failed = [];

  const jobs = [...byChannel].map(([channelId, logNames]) => {
    const channel = message.guild.channels.cache.get(channelId);
    return queue.add(() => lockChannel(channel, message.guild, staffRoles), `fix-${channelId}`)
      .then(() => fixed.push(`${GLYPHS.DOT} <#${channelId}> — ${logNames.join(', ')}`))
      .catch(error => failed.push(`${GLYPHS.DOT} <#${channelId}> — ${error.message}`));
  });
  await Promise.all(jobs);
  await queue.onIdle();

  let resultEmbed;
  if (failed.length === 0) {
    resultEmbed = await successEmbed(guildId, 'Log Permissions Fixed',
      `${GLYPHS.SUCCESS} ${fixed.length} log channel(s) are now private to admins and staff.`);
  } else if (fixed.length > 0) {
    resultEmbed = await warningEmbed(guildId, 'Log Permissions Partly Fixed',
      `${GLYPHS.WARNING} ${fixed.length} channel(s) fixed, ${failed.length} failed. ` +
      `Check that my role can manage those channels, Master.`);
  } else {
    resultEmbed = await errorEmbed(guildId, 'Log Permissions Not Fixed',
      `${GLYPHS.ERROR} No log channel could be updated. Check that my role can manage those channels, Master.`);
  }

  if (fixed.length) resultEmbed.addFields({ name: `${GLYPHS.ARROW_RIGHT} Fixed (${fixed.length})`, value: fitLines(fixed) });
  if (failed.length) resultEmbed.addFields({ name: `${GLYPHS.ARROW_RIGHT} Failed (${failed.length})`, value: fitLines(failed) });
  if (skipped.length) resultEmbed.addFields({ name: `${GLYPHS.ARROW_RIGHT} Skipped (${skipped.length})`, value: fitLines(skipped) });

  return statusMsg.edit({ embeds: [resultEmbed] });
}

async function fixSingleLogChannel(message, guildConfig, [key, log], prefix) {
  const guildId = message.guild.id;
  const channelId = guildConfig.channels?.[log.field];

  if (!channelId) {
    return message.reply({
      embeds: [await errorEmbed(guildId, 'Not Configured',
        `${GLYPHS.ERROR} The **${log.name}** channel is not configured.\n\n` +
        `Use \`${prefix}setlogs set ${key} #channel\` to set it up.`)]
    });
  }

  const channel = message.guild.channels.cache.get(channelId);
  if (!channel) {
    return message.reply({
      embeds: [await errorEmbed(guildId, 'Channel Not Found',
        `${GLYPHS.ERROR} The configured **${log.name}** channel no longer exists.\n\n` +
        `Use \`${prefix}setlogs set ${key} #channel\` to choose a new one.`)]
    });
  }

  try {
    await lockChannel(channel, message.guild, getStaffRoles(message.guild, guildConfig));
  } catch (error) {
    return message.reply({
      embeds: [await errorEmbed(guildId, 'Failed to Fix Permissions',
        `${GLYPHS.ERROR} Could not fix permissions: ${error.message}\n\n` +
        `Make sure my role can manage ${channel}.`)]
    });
  }

  return message.reply({
    embeds: [await successEmbed(guildId, 'Permissions Fixed',
      `${GLYPHS.SUCCESS} Fixed permissions for **${log.name}** (${channel})\n\n` +
      `${GLYPHS.DOT} Hidden from @everyone\n` +
      `${GLYPHS.DOT} Visible to admins and staff\n` +
      `${GLYPHS.DOT} Bot can send messages`)]
  });
}
