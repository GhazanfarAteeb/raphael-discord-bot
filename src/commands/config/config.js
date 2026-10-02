import { PermissionFlagsBits } from 'discord.js';
import Guild from '../../models/Guild.js';
import { successEmbed, errorEmbed, infoEmbed, GLYPHS } from '../../utils/embeds.js';
import { getPrefix, hasAdminPerms } from '../../utils/helpers.js';

const FIELD_LIMIT = 1024;
const MAX_LISTED = 5;

// Every channel the config stores, in display order
const CHANNEL_LABELS = {
  modLog: 'Mod Log',
  alertLog: 'Alert Log',
  joinLog: 'Join Log',
  leaveLog: 'Leave Log',
  messageLog: 'Message Log',
  voiceLog: 'Voice Log',
  memberLog: 'Member Log',
  serverLog: 'Server Log',
  verificationLog: 'Verification Log',
  ticketLog: 'Ticket Log',
  botStatus: 'Bot Status',
  staffChannel: 'Staff Channel',
  welcomeChannel: 'Welcome',
  birthdayChannel: 'Birthdays',
  eventChannel: 'Events',
  levelUpChannel: 'Level Up',
  ticketCategory: 'Ticket Category',
  ticketPanelChannel: 'Ticket Panel'
};

// Settings this command can change, with the value each takes
const SETTABLE = {
  susthreshold: { value: '<1-20>', description: 'Suspicion score that flags a joining member' },
  accountagethreshold: { value: '<1-168>', description: 'Accounts younger than this many hours count as new' },
  inviteverification: { value: '<on|off>', description: 'Invite link checking' },
  membertracking: { value: '<on|off>', description: 'Join/leave tracking and sus detection' },
  accountage: { value: '<on|off>', description: 'New account detection' },
  embedcolor: { value: '<#hex>', description: 'Theme color for info embeds' }
};

const TOGGLE_FEATURES = {
  inviteverification: { key: 'inviteVerification', name: 'Invite Verification' },
  membertracking: { key: 'memberTracking', name: 'Member Tracking' },
  accountage: { key: 'accountAge', name: 'Account Age Check' }
};

const onOff = (value) => value ? 'Enabled' : 'Disabled';

// Up to MAX_LISTED mentions, then a count of the rest
function mentionList(ids, format) {
  if (!ids?.length) return 'None';
  const shown = ids.slice(0, MAX_LISTED).map(format).join(', ');
  return ids.length > MAX_LISTED ? `${shown} +${ids.length - MAX_LISTED} more` : shown;
}

function fit(value) {
  return value.length <= FIELD_LIMIT ? value : `${value.slice(0, FIELD_LIMIT - 20).replace(/\n[^\n]*$/, '')}\n— and more`;
}

export default {
  name: 'config',
  description: 'View or edit server configuration',
  usage: '[setting] [value]',
  category: 'config',
  aliases: ['configuration', 'settings'],
  permissions: [PermissionFlagsBits.Administrator],
  cooldown: 3,

  async execute(message, args) {
    const guildId = message.guild.id;

    try {
      const guild = await Guild.getGuild(guildId, message.guild.name);

      if (!hasAdminPerms(message.member, guild)) {
        return message.reply({
          embeds: [await errorEmbed(guildId, 'Permission Denied',
            `${GLYPHS.LOCK} You need Administrator permissions to view or edit configuration.`)]
        });
      }

      const prefix = await getPrefix(guildId);

      if (args.length === 0) {
        return showConfig(message, guild, prefix);
      }

      const setting = args[0].toLowerCase();
      const value = args.slice(1).join(' ');

      if (TOGGLE_FEATURES[setting]) {
        return toggleFeature(message, TOGGLE_FEATURES[setting], value);
      }

      switch (setting) {
        case 'susthreshold':
          return setNumber(message, value, {
            path: 'features.memberTracking.susThreshold', min: 1, max: 20,
            title: 'Sus Threshold Updated',
            invalid: 'The sus threshold must be a number between 1 and 20.',
            done: n => `Members with a suspicion score of **${n}** or more will now be flagged.`
          });

        case 'accountagethreshold':
          return setNumber(message, value, {
            path: 'features.accountAge.threshold', min: 1, max: 168,
            title: 'Account Age Threshold Updated',
            invalid: 'The account age threshold must be a number between 1 and 168 hours (7 days).',
            done: n => `Accounts younger than **${n}** hours now count as new.`
          });

        case 'embedcolor':
          return setEmbedColor(message, value);

        default:
          return message.reply({
            embeds: [await errorEmbed(guildId, 'Unknown Setting',
              `${GLYPHS.WARNING} Unknown setting. Valid settings: ${Object.keys(SETTABLE).map(k => `\`${k}\``).join(', ')}.\n\n` +
              `Use \`${prefix}config\` to see the current configuration.`)]
          });
      }
    } catch (error) {
      console.error('[Config] Error:', error);
      return message.reply({
        embeds: [await errorEmbed(guildId, 'Configuration Error',
          'The configuration could not be loaded or saved, Master. Please try again.')]
      }).catch(() => null);
    }
  }
};

async function showConfig(message, guild, prefix) {
  const features = guild.features || {};
  const roles = guild.roles || {};
  const channels = guild.channels || {};
  const roleMention = id => message.guild.roles.cache.has(id) ? `<@&${id}>` : `deleted role (\`${id}\`)`;
  const channelMention = id => message.guild.channels.cache.has(id) ? `<#${id}>` : `deleted channel (\`${id}\`)`;
  const singleRole = id => id ? roleMention(id) : 'Not set';

  const embed = await infoEmbed(message.guild.id, 'Server Configuration',
    `${GLYPHS.INFO} Current configuration for **${message.guild.name}**.`);

  embed.addFields({
    name: `${GLYPHS.ARROW_RIGHT} General`,
    value:
      `**Prefix:** \`${guild.prefix || prefix}\`\n` +
      `**Embed Color:** ${guild.embedStyle?.color || 'Default'}`
  });

  const antiNuke = features.autoMod?.antiNuke;
  embed.addFields({
    name: `${GLYPHS.ARROW_RIGHT} Security`,
    value:
      `**Invite Verification:** ${onOff(features.inviteVerification?.enabled)}` +
      `${features.inviteVerification?.action ? ` (action: ${features.inviteVerification.action})` : ''}\n` +
      `**Member Tracking:** ${onOff(features.memberTracking?.enabled)} ` +
      `(flags a suspicion score of ${features.memberTracking?.susThreshold ?? 4} or more)\n` +
      `**Account Age Check:** ${onOff(features.accountAge?.enabled)} ` +
      `(accounts under ${features.accountAge?.threshold ?? 24} hours)\n` +
      `**AutoMod:** ${onOff(features.autoMod?.enabled)}\n` +
      `**Anti-Nuke:** ${onOff(antiNuke?.enabled)}${antiNuke?.action ? ` (action: ${antiNuke.action})` : ''}`
  });

  embed.addFields({
    name: `${GLYPHS.ARROW_RIGHT} Roles`,
    value: fit(
      `**Admin Roles:** ${mentionList(roles.adminRoles, roleMention)}\n` +
      `**Moderator Roles:** ${mentionList(roles.moderatorRoles, roleMention)}\n` +
      `**Staff Roles:** ${mentionList(roles.staffRoles, roleMention)}\n` +
      `**Sus Role:** ${singleRole(roles.susRole)}\n` +
      `**New Account Role:** ${singleRole(roles.newAccountRole)}\n` +
      `**Muted Role:** ${singleRole(roles.mutedRole)}`)
  });

  const setChannels = Object.entries(CHANNEL_LABELS).filter(([key]) => channels[key]);
  const unsetChannels = Object.entries(CHANNEL_LABELS).filter(([key]) => !channels[key]);
  embed.addFields({
    name: `${GLYPHS.ARROW_RIGHT} Channels (${setChannels.length}/${Object.keys(CHANNEL_LABELS).length} set)`,
    value: fit(
      (setChannels.length
        ? setChannels.map(([key, label]) => `**${label}:** ${channelMention(channels[key])}`).join('\n')
        : 'No channels configured') +
      (unsetChannels.length ? `\n**Not set:** ${unsetChannels.map(([, label]) => label).join(', ')}` : ''))
  });

  const autoRole = guild.autoRole || {};
  const delaySeconds = Math.round((autoRole.delay || 0) / 1000); // Stored in milliseconds
  embed.addFields({
    name: `${GLYPHS.ARROW_RIGHT} Auto Role`,
    value: fit(
      `**Status:** ${onOff(autoRole.enabled)}\n` +
      `**Member Roles:** ${mentionList(autoRole.roles, roleMention)}\n` +
      `**Bot Roles:** ${mentionList(autoRole.botRoles, roleMention)}\n` +
      `**Delay:** ${delaySeconds ? `${delaySeconds}s` : 'Instant'}`),
    inline: true
  });

  const commandChannels = guild.commandChannels || {};
  embed.addFields({
    name: `${GLYPHS.ARROW_RIGHT} Command Channels`,
    value: fit(
      `**Status:** ${onOff(commandChannels.enabled)}\n` +
      `**Allowed:** ${mentionList(commandChannels.channels, channelMention)}\n` +
      `**Bypass Roles:** ${mentionList(commandChannels.bypassRoles, roleMention)}`),
    inline: true
  });

  const levelSystem = features.levelSystem || {};
  embed.addFields({
    name: `${GLYPHS.ARROW_RIGHT} Leveling`,
    value: fit(
      `**Status:** ${onOff(levelSystem.enabled)}\n` +
      `**XP per Message:** ${levelSystem.minXpPerMessage ?? 15}-${levelSystem.maxXpPerMessage ?? 25} ` +
      `(${levelSystem.xpCooldown ?? 60}s cooldown)\n` +
      `**Voice XP:** ${onOff(guild.voiceXP?.enabled)}\n` +
      `**Level Rewards:** ${levelSystem.rewards?.length || 0}\n` +
      `**XP Multipliers:** ${levelSystem.xpMultipliers?.length || 0} role(s), booster ${levelSystem.boosterMultiplier ?? 1.5}x\n` +
      `**No-XP Channels:** ${levelSystem.noXpChannels?.length || 0}`)
  });

  const autoPublish = guild.autoPublish || {};
  embed.addFields({
    name: `${GLYPHS.ARROW_RIGHT} Auto-Publish`,
    value: fit(
      `**Status:** ${onOff(autoPublish.enabled)}\n` +
      `**Channels:** ${mentionList(autoPublish.channels, channelMention)}`)
  });

  const disabledText = guild.textCommands?.disabledCommands || [];
  const disabledSlash = guild.slashCommands?.disabledCommands || [];
  const listCommands = (list, mark) => {
    if (!list.length) return 'None';
    const shown = list.slice(0, 15).map(c => `\`${mark}${c}\``).join(', ');
    return list.length > 15 ? `${shown} +${list.length - 15} more` : shown;
  };
  embed.addFields({
    name: `${GLYPHS.ARROW_RIGHT} Disabled Commands`,
    value: fit(
      `**Text:** ${listCommands(disabledText, '')}\n` +
      `**Slash:** ${listCommands(disabledSlash, '/')}`)
  });

  embed.addFields({
    name: `${GLYPHS.ARROW_RIGHT} Settings You Can Change`,
    value: Object.entries(SETTABLE)
      .map(([key, s]) => `\`${prefix}config ${key} ${s.value}\` - ${s.description}`)
      .join('\n')
  });

  return message.reply({ embeds: [embed] });
}

async function setNumber(message, value, { path, min, max, title, invalid, done }) {
  const guildId = message.guild.id;
  const number = parseInt(value, 10);

  if (isNaN(number) || number < min || number > max) {
    return message.reply({
      embeds: [await errorEmbed(guildId, 'Invalid Value', `${GLYPHS.WARNING} ${invalid}`)]
    });
  }

  await Guild.updateGuild(guildId, { $set: { [path]: number } });

  return message.reply({
    embeds: [await successEmbed(guildId, title, `${GLYPHS.SUCCESS} ${done(number)}`)]
  });
}

async function toggleFeature(message, feature, value) {
  const guildId = message.guild.id;
  const input = value.toLowerCase();
  const enabled = ['on', 'enable', 'true'].includes(input);
  const disabled = ['off', 'disable', 'false'].includes(input);

  if (!enabled && !disabled) {
    return message.reply({
      embeds: [await errorEmbed(guildId, 'Invalid Value',
        `${GLYPHS.WARNING} Value must be either \`on\` or \`off\`.`)]
    });
  }

  await Guild.updateGuild(guildId, { $set: { [`features.${feature.key}.enabled`]: enabled } });

  return message.reply({
    embeds: [await successEmbed(guildId, 'Feature Updated',
      `${GLYPHS.SUCCESS} **${feature.name}** has been ${enabled ? 'enabled' : 'disabled'}.`)]
  });
}

async function setEmbedColor(message, value) {
  const guildId = message.guild.id;

  if (!/^#[0-9A-F]{6}$/i.test(value)) {
    return message.reply({
      embeds: [await errorEmbed(guildId, 'Invalid Color',
        `${GLYPHS.WARNING} Color must be a valid hex code (e.g., #00CED1).`)]
    });
  }

  await Guild.updateGuild(guildId, { $set: { 'embedStyle.color': value } });

  const embed = await successEmbed(guildId, 'Embed Color Updated',
    `${GLYPHS.SUCCESS} Embed color set to ${value}`);
  embed.setColor(value); // Preview the chosen color
  return message.reply({ embeds: [embed] });
}
