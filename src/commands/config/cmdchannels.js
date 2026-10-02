import { PermissionFlagsBits } from 'discord.js';
import Guild from '../../models/Guild.js';
import { successEmbed, errorEmbed, infoEmbed, GLYPHS } from '../../utils/embeds.js';
import { getPrefix, hasModPerms } from '../../utils/helpers.js';

const FIELD_LIMIT = 1024;

// A mention or raw ID; the ID is returned even when the channel/role no longer exists
function parseChannelId(arg) {
  return String(arg ?? '').match(/^(?:<#)?(\d{17,20})>?$/)?.[1] ?? null;
}
function parseRoleId(arg) {
  return String(arg ?? '').match(/^(?:<@&)?(\d{17,20})>?$/)?.[1] ?? null;
}

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

export default {
  name: 'cmdchannels',
  description: 'Restrict bot commands to specific channels',
  usage: '<enable|disable|add|remove|bypass|list> [options]',
  aliases: ['commandchannels', 'allowedchannels', 'botchannels'],
  category: 'config',
  permissions: [PermissionFlagsBits.ManageGuild],
  cooldown: 3,

  async execute(message, args) {
    const guildId = message.guild.id;

    try {
      const prefix = await getPrefix(guildId);
      const guildConfig = await Guild.getGuild(guildId, message.guild.name);

      // Check for moderator permissions (admin, mod role, or ManageGuild)
      if (!hasModPerms(message.member, guildConfig)) {
        return message.reply({
          embeds: [await errorEmbed(guildId, 'Permission Denied',
            `${GLYPHS.LOCK} You need Moderator/Staff permissions to manage command channels.`)]
        });
      }

      const settings = {
        enabled: guildConfig.commandChannels?.enabled ?? false,
        channels: guildConfig.commandChannels?.channels || [],
        bypassRoles: guildConfig.commandChannels?.bypassRoles || []
      };
      const subcommand = args[0]?.toLowerCase();

      switch (subcommand) {
        case undefined:
          return showHelp(message, settings, prefix);
        case 'enable':
          return enable(message, settings, prefix);
        case 'disable':
          await Guild.updateGuild(guildId, { $set: { 'commandChannels.enabled': false } });
          return message.reply({
            embeds: [await successEmbed(guildId, 'Channel Restrictions Disabled',
              `${GLYPHS.SUCCESS} Bot commands can now be used in any channel.`)]
          });
        case 'add':
          return addChannel(message, args[1], settings, prefix);
        case 'remove':
          return removeChannel(message, args[1], settings, prefix);
        case 'bypass':
          return manageBypass(message, args.slice(1), settings, prefix);
        case 'list':
          return showList(message, settings, prefix);
        default:
          return message.reply({
            embeds: [await errorEmbed(guildId, 'Unknown Subcommand',
              `${GLYPHS.ERROR} Unknown subcommand: \`${subcommand}\`\n\nUse \`${prefix}cmdchannels\` to see available options.`)]
          });
      }
    } catch (error) {
      console.error('[CmdChannels] Error:', error);
      return message.reply({
        embeds: [await errorEmbed(guildId, 'Configuration Error',
          'The command channel settings could not be updated, Master. Please try again.')]
      }).catch(() => null);
    }
  }
};

async function showHelp(message, settings, prefix) {
  const embed = await infoEmbed(message.guild.id, 'Command Channel Restrictions',
    `${GLYPHS.INFO} Restrict bot commands to specific channels. Configuration commands always work everywhere.\n\n` +
    `${GLYPHS.ARROW_RIGHT} **Status:** ${settings.enabled ? 'Enabled' : 'Disabled'}\n` +
    `${GLYPHS.ARROW_RIGHT} **Allowed Channels:** ${settings.channels.length}\n` +
    `${GLYPHS.ARROW_RIGHT} **Bypass Roles:** ${settings.bypassRoles.length}`);

  embed.addFields(
    {
      name: `${GLYPHS.ARROW_RIGHT} Restrictions`,
      value:
        `\`${prefix}cmdchannels enable\` - Enable channel restrictions\n` +
        `\`${prefix}cmdchannels disable\` - Disable restrictions\n` +
        `\`${prefix}cmdchannels list\` - View current settings`
    },
    {
      name: `${GLYPHS.ARROW_RIGHT} Channels`,
      value:
        `\`${prefix}cmdchannels add #channel\` - Allow a channel\n` +
        `\`${prefix}cmdchannels remove <#channel|channel_id>\` - Remove a channel`
    },
    {
      name: `${GLYPHS.ARROW_RIGHT} Bypass Roles`,
      value:
        `\`${prefix}cmdchannels bypass add @role\` - Role may use commands anywhere\n` +
        `\`${prefix}cmdchannels bypass remove <@role|role_id>\` - Remove a bypass role\n` +
        `\`${prefix}cmdchannels bypass list\` - View bypass roles`
    }
  );

  return message.reply({ embeds: [embed] });
}

async function enable(message, settings, prefix) {
  const guildId = message.guild.id;
  const existing = settings.channels.filter(id => message.guild.channels.cache.has(id));

  // Enabling with only deleted channels would block every command outside config ones
  if (existing.length === 0) {
    return message.reply({
      embeds: [await errorEmbed(guildId, 'No Channels Added',
        `${GLYPHS.ERROR} Please add at least one existing channel first.\n\n**Usage:** \`${prefix}cmdchannels add #channel\``)]
    });
  }

  const stale = settings.channels.filter(id => !existing.includes(id));
  await Guild.updateGuild(guildId, {
    $set: { 'commandChannels.enabled': true, 'commandChannels.channels': existing }
  });

  return message.reply({
    embeds: [await successEmbed(guildId, 'Channel Restrictions Enabled',
      `${GLYPHS.SUCCESS} Bot commands will now only work in the allowed channels.\n\n` +
      `**Allowed Channels:** ${existing.length}\n` +
      `**Bypass Roles:** ${settings.bypassRoles.length}` +
      (stale.length ? `\n\n${GLYPHS.INFO} Removed ${stale.length} deleted channel(s) from the list.` : ''))]
  });
}

async function addChannel(message, arg, settings, prefix) {
  const guildId = message.guild.id;
  const channel = message.mentions.channels.first() || message.guild.channels.cache.get(parseChannelId(arg));

  if (!channel) {
    return message.reply({
      embeds: [await errorEmbed(guildId, 'Channel Not Found',
        `${GLYPHS.ERROR} Please mention a valid channel.\n\n**Usage:** \`${prefix}cmdchannels add #channel\``)]
    });
  }

  if (!channel.isTextBased()) {
    return message.reply({
      embeds: [await errorEmbed(guildId, 'Invalid Channel Type',
        `${GLYPHS.ERROR} Please select a text channel.`)]
    });
  }

  if (settings.channels.includes(channel.id)) {
    return message.reply({
      embeds: [await infoEmbed(guildId, 'Already Added',
        `${GLYPHS.INFO} ${channel} is already in the allowed channels list.`)]
    });
  }

  const updated = await Guild.updateGuild(guildId, { $addToSet: { 'commandChannels.channels': channel.id } });

  return message.reply({
    embeds: [await successEmbed(guildId, 'Channel Added',
      `${GLYPHS.SUCCESS} ${channel} has been added to the allowed channels.\n\n` +
      `**Total Channels:** ${updated?.commandChannels?.channels?.length ?? settings.channels.length + 1}`)]
  });
}

async function removeChannel(message, arg, settings, prefix) {
  const guildId = message.guild.id;
  const channelId = message.mentions.channels.first()?.id || parseChannelId(arg);

  if (!channelId) {
    return message.reply({
      embeds: [await errorEmbed(guildId, 'Channel Not Found',
        `${GLYPHS.ERROR} Please mention a channel or give its ID.\n\n**Usage:** \`${prefix}cmdchannels remove <#channel|channel_id>\``)]
    });
  }

  if (!settings.channels.includes(channelId)) {
    return message.reply({
      embeds: [await errorEmbed(guildId, 'Not Found',
        `${GLYPHS.ERROR} <#${channelId}> is not in the allowed channels list.`)]
    });
  }

  // Also drop channels that were deleted since they were added
  const stale = settings.channels.filter(id => id !== channelId && !message.guild.channels.cache.has(id));
  const remaining = settings.channels.filter(id => id !== channelId && !stale.includes(id));
  const update = { $pull: { 'commandChannels.channels': { $in: [channelId, ...stale] } } };

  // With no channels left, an active restriction would block every non-config command
  const autoDisabled = settings.enabled && remaining.length === 0;
  if (autoDisabled) update.$set = { 'commandChannels.enabled': false };

  await Guild.updateGuild(guildId, update);

  const label = message.guild.channels.cache.has(channelId) ? `<#${channelId}>` : `Deleted channel (\`${channelId}\`)`;
  let description = `${GLYPHS.SUCCESS} ${label} has been removed from the allowed channels.\n\n` +
    `**Remaining Channels:** ${remaining.length}`;
  if (stale.length) description += `\n${GLYPHS.INFO} Also removed ${stale.length} deleted channel(s).`;
  if (autoDisabled) description += `\n\n${GLYPHS.WARNING} No allowed channels remain, so channel restrictions have been disabled.`;

  return message.reply({ embeds: [await successEmbed(guildId, 'Channel Removed', description)] });
}

async function manageBypass(message, args, settings, prefix) {
  const guildId = message.guild.id;
  const action = args[0]?.toLowerCase();

  if (!['add', 'remove', 'list'].includes(action)) {
    return message.reply({
      embeds: [await errorEmbed(guildId, 'Invalid Action',
        `${GLYPHS.ERROR} Valid actions: \`add\`, \`remove\`, \`list\`\n\n**Usage:** \`${prefix}cmdchannels bypass add @role\``)]
    });
  }

  if (action === 'list') {
    if (settings.bypassRoles.length === 0) {
      return message.reply({
        embeds: [await infoEmbed(guildId, 'No Bypass Roles',
          `${GLYPHS.INFO} No roles can bypass channel restrictions.`)]
      });
    }
    return message.reply({
      embeds: [await infoEmbed(guildId, 'Bypass Roles',
        fitLines(settings.bypassRoles.map(id => `${GLYPHS.DOT} ${describeRole(message.guild, id)}`), 4096))]
    });
  }

  if (action === 'add') {
    const role = message.mentions.roles.first() || message.guild.roles.cache.get(parseRoleId(args[1]));
    if (!role) {
      return message.reply({
        embeds: [await errorEmbed(guildId, 'Role Not Found',
          `${GLYPHS.ERROR} Please mention a valid role.\n\n**Usage:** \`${prefix}cmdchannels bypass add @role\``)]
      });
    }

    if (settings.bypassRoles.includes(role.id)) {
      return message.reply({
        embeds: [await infoEmbed(guildId, 'Already Added',
          `${GLYPHS.INFO} ${role} already bypasses channel restrictions.`)]
      });
    }

    await Guild.updateGuild(guildId, { $addToSet: { 'commandChannels.bypassRoles': role.id } });
    return message.reply({
      embeds: [await successEmbed(guildId, 'Bypass Role Added',
        `${GLYPHS.SUCCESS} Members with ${role} can now use commands in any channel.`)]
    });
  }

  // action === 'remove': raw IDs work, so deleted roles can be removed too
  const roleId = message.mentions.roles.first()?.id || parseRoleId(args[1]);
  if (!roleId) {
    return message.reply({
      embeds: [await errorEmbed(guildId, 'Role Not Found',
        `${GLYPHS.ERROR} Please mention a role or give its ID.\n\n**Usage:** \`${prefix}cmdchannels bypass remove <@role|role_id>\``)]
    });
  }

  if (!settings.bypassRoles.includes(roleId)) {
    return message.reply({
      embeds: [await errorEmbed(guildId, 'Not Found',
        `${GLYPHS.ERROR} ${describeRole(message.guild, roleId)} is not a bypass role.`)]
    });
  }

  const stale = settings.bypassRoles.filter(id => id !== roleId && !message.guild.roles.cache.has(id));
  await Guild.updateGuild(guildId, { $pull: { 'commandChannels.bypassRoles': { $in: [roleId, ...stale] } } });

  return message.reply({
    embeds: [await successEmbed(guildId, 'Bypass Role Removed',
      `${GLYPHS.SUCCESS} ${describeRole(message.guild, roleId)} no longer bypasses channel restrictions.` +
      (stale.length ? `\n${GLYPHS.INFO} Also removed ${stale.length} deleted role(s).` : ''))]
  });
}

function describeRole(guild, roleId) {
  return guild.roles.cache.has(roleId) ? `<@&${roleId}>` : `Deleted role (\`${roleId}\`)`;
}

async function showList(message, settings, prefix) {
  const guild = message.guild;
  const channelLines = settings.channels.map(id =>
    `${GLYPHS.DOT} ${guild.channels.cache.has(id) ? `<#${id}>` : `Deleted channel (\`${id}\`)`}`);
  const roleLines = settings.bypassRoles.map(id => `${GLYPHS.DOT} ${describeRole(guild, id)}`);
  const deletedChannels = settings.channels.filter(id => !guild.channels.cache.has(id)).length;

  const embed = await infoEmbed(guild.id, 'Command Channel Settings',
    `${GLYPHS.ARROW_RIGHT} **Status:** ${settings.enabled ? 'Enabled' : 'Disabled'}\n` +
    `${GLYPHS.ARROW_RIGHT} **Allowed Channels:** ${settings.channels.length}\n` +
    `${GLYPHS.ARROW_RIGHT} **Bypass Roles:** ${settings.bypassRoles.length}`);

  embed.addFields(
    { name: `${GLYPHS.ARROW_RIGHT} Allowed Channels`, value: channelLines.length ? fitLines(channelLines) : 'No channels configured' },
    { name: `${GLYPHS.ARROW_RIGHT} Bypass Roles`, value: roleLines.length ? fitLines(roleLines) : 'No bypass roles' }
  );

  if (deletedChannels) {
    embed.addFields({
      name: `${GLYPHS.WARNING} Deleted Channels`,
      value: `${deletedChannels} allowed channel(s) no longer exist. Remove them with \`${prefix}cmdchannels remove <channel_id>\`.`
    });
  }

  return message.reply({ embeds: [embed] });
}
