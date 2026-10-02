import { PermissionFlagsBits, ChannelType } from 'discord.js';
import Guild from '../../models/Guild.js';
import { successEmbed, errorEmbed, infoEmbed, GLYPHS } from '../../utils/embeds.js';
import { getPrefix, hasModPerms } from '../../utils/helpers.js';

// Every log channel the bot writes to. Shared with fixlogs so both commands cover the same set.
// `alsoSets` lists other config paths that read the same channel.
export const LOG_TYPES = {
  mod: { name: 'Moderation Log', field: 'modLog', description: 'Bans, kicks, warns, timeouts' },
  message: { name: 'Message Log', field: 'messageLog', description: 'Message edits and deletes' },
  voice: { name: 'Voice Log', field: 'voiceLog', description: 'Voice channel activity' },
  member: { name: 'Member Log', field: 'memberLog', description: 'Role changes, nicknames, bans' },
  server: { name: 'Server Log', field: 'serverLog', description: 'Channel, role, server changes' },
  join: { name: 'Join Log', field: 'joinLog', description: 'Member joins' },
  leave: { name: 'Leave Log', field: 'leaveLog', description: 'Member leaves' },
  verification: { name: 'Verification Log', field: 'verificationLog', description: 'Member verifications (button, captcha, manual)' },
  alert: {
    name: 'Alert Log',
    field: 'alertLog',
    description: 'Security alerts (suspicious members, new accounts)',
    alsoSets: ['features.memberTracking.alertChannel', 'features.accountAge.alertChannel']
  },
  ticket: { name: 'Ticket Log', field: 'ticketLog', description: 'Ticket activity' },
  botstatus: { name: 'Bot Status', field: 'botStatus', description: 'Bot online/offline notices' }
};

// $set entries that point one log type (and any paths sharing its channel) at channelId
function logUpdate(log, channelId) {
  const update = { [`channels.${log.field}`]: channelId };
  for (const path of log.alsoSets || []) update[path] = channelId;
  return update;
}

export default {
  name: 'setlogs',
  description: 'Configure logging channels',
  usage: 'setlogs | setlogs set <type> #channel | setlogs disable <type> | setlogs all #channel',
  category: 'config',
  aliases: ['logs', 'logging', 'setlog', 'logchannel'],
  permissions: [PermissionFlagsBits.ManageGuild],
  cooldown: 5,

  async execute(message, args) {
    const guildId = message.guild.id;

    try {
      const guildConfig = await Guild.getGuild(guildId);

      // Check for moderator permissions (admin, mod role, or ManageGuild)
      if (!hasModPerms(message.member, guildConfig)) {
        return message.reply({
          embeds: [await errorEmbed(guildId, 'Permission Denied',
            `${GLYPHS.LOCK} You need Moderator/Staff permissions to configure logging.`)]
        });
      }

      const prefix = await getPrefix(guildId);
      const subCommand = args[0]?.toLowerCase();

      switch (subCommand) {
        case undefined:
          return showConfig(message, guildConfig, prefix);
        case 'set':
          return setLog(message, args.slice(1), prefix);
        case 'disable':
        case 'remove':
          return disableLog(message, args.slice(1), prefix);
        case 'all':
          return setAllLogs(message, args.slice(1), prefix);
        case 'list':
        case 'types':
          return listTypes(message, prefix);
        default:
          // `setlogs mod #channel` works as a shorthand for `setlogs set mod #channel`
          if (LOG_TYPES[subCommand]) {
            return setLog(message, args, prefix);
          }
          return showConfig(message, guildConfig, prefix);
      }
    } catch (error) {
      console.error('[SetLogs] Error:', error);
      return message.reply({
        embeds: [await errorEmbed(guildId, 'Configuration Error',
          'The logging configuration could not be updated, Master. Please try again.')]
      }).catch(() => null);
    }
  }
};

async function showConfig(message, guildConfig, prefix) {
  const logStatus = Object.values(LOG_TYPES).map(log => {
    const channelId = guildConfig.channels?.[log.field];
    let status = 'Not set';
    if (channelId) {
      status = message.guild.channels.cache.has(channelId) ? `<#${channelId}>` : 'Channel deleted';
    }
    return `${GLYPHS.ARROW_RIGHT} **${log.name}:** ${status}`;
  }).join('\n');

  const embed = await infoEmbed(message.guild.id, 'Logging Configuration',
    `${GLYPHS.INFO} Current log channels for **${message.guild.name}**.`);

  embed.addFields(
    { name: `${GLYPHS.ARROW_RIGHT} Log Channels`, value: logStatus },
    {
      name: `${GLYPHS.ARROW_RIGHT} Commands`,
      value:
        `\`${prefix}setlogs set <type> #channel\` - Set one log channel\n` +
        `\`${prefix}setlogs disable <type>\` - Turn one log off\n` +
        `\`${prefix}setlogs all #channel\` - Send every log to one channel\n` +
        `\`${prefix}setlogs list\` - View all log types\n` +
        `\`${prefix}setup\` - Create all log channels automatically`
    }
  );

  return message.reply({ embeds: [embed] });
}

async function setLog(message, args, prefix) {
  const guildId = message.guild.id;
  const logType = args[0]?.toLowerCase();
  const channel = message.mentions.channels.first() ||
    message.guild.channels.cache.get(args[1]);

  if (!logType || !LOG_TYPES[logType]) {
    return message.reply({
      embeds: [await errorEmbed(guildId, 'Invalid Log Type',
        `${GLYPHS.ERROR} Please specify a valid log type.\n\n` +
        `**Available types:** ${Object.keys(LOG_TYPES).join(', ')}\n\n` +
        `**Usage:** \`${prefix}setlogs set <type> #channel\``)]
    });
  }

  if (!channel) {
    return message.reply({
      embeds: [await errorEmbed(guildId, 'No Channel',
        `${GLYPHS.ERROR} Please mention a channel.\n\n` +
        `**Usage:** \`${prefix}setlogs set ${logType} #channel\``)]
    });
  }

  if (channel.type !== ChannelType.GuildText) {
    return message.reply({
      embeds: [await errorEmbed(guildId, 'Invalid Channel',
        `${GLYPHS.ERROR} Please select a text channel.`)]
    });
  }

  const log = LOG_TYPES[logType];
  await Guild.updateGuild(guildId, { $set: logUpdate(log, channel.id) });

  return message.reply({
    embeds: [await successEmbed(guildId, 'Log Channel Set',
      `${GLYPHS.SUCCESS} **${log.name}** will now be sent to ${channel}.\n\n` +
      `**Logs:** ${log.description}`)]
  });
}

async function disableLog(message, args, prefix) {
  const guildId = message.guild.id;
  const logType = args[0]?.toLowerCase();

  if (!logType || !LOG_TYPES[logType]) {
    return message.reply({
      embeds: [await errorEmbed(guildId, 'Invalid Log Type',
        `${GLYPHS.ERROR} Please specify a valid log type.\n\n` +
        `**Available types:** ${Object.keys(LOG_TYPES).join(', ')}\n\n` +
        `**Usage:** \`${prefix}setlogs disable <type>\``)]
    });
  }

  const log = LOG_TYPES[logType];
  await Guild.updateGuild(guildId, { $set: logUpdate(log, null) });

  return message.reply({
    embeds: [await successEmbed(guildId, 'Log Disabled',
      `${GLYPHS.SUCCESS} **${log.name}** has been disabled.`)]
  });
}

async function setAllLogs(message, args, prefix) {
  const guildId = message.guild.id;
  const channel = message.mentions.channels.first() ||
    message.guild.channels.cache.get(args[0]);

  if (!channel) {
    return message.reply({
      embeds: [await errorEmbed(guildId, 'No Channel',
        `${GLYPHS.ERROR} Please mention a channel.\n\n` +
        `**Usage:** \`${prefix}setlogs all #channel\``)]
    });
  }

  if (channel.type !== ChannelType.GuildText) {
    return message.reply({
      embeds: [await errorEmbed(guildId, 'Invalid Channel',
        `${GLYPHS.ERROR} Please select a text channel.`)]
    });
  }

  const update = {};
  for (const log of Object.values(LOG_TYPES)) {
    Object.assign(update, logUpdate(log, channel.id));
  }
  await Guild.updateGuild(guildId, { $set: update });

  return message.reply({
    embeds: [await successEmbed(guildId, 'All Logs Set',
      `${GLYPHS.SUCCESS} Every log type will now be sent to ${channel}.\n\n` +
      `**Enabled:**\n` +
      Object.values(LOG_TYPES).map(l => `${GLYPHS.DOT} ${l.name}`).join('\n'))]
  });
}

async function listTypes(message, prefix) {
  const typeList = Object.entries(LOG_TYPES).map(([key, log]) =>
    `${GLYPHS.ARROW_RIGHT} **${key}** - ${log.name}\n› ${log.description}`
  ).join('\n');

  const embed = await infoEmbed(message.guild.id, 'Log Types', typeList);
  embed.addFields({
    name: `${GLYPHS.ARROW_RIGHT} Usage`,
    value: `\`${prefix}setlogs set <type> #channel\``
  });

  return message.reply({ embeds: [embed] });
}
