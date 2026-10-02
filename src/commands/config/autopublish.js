import { PermissionFlagsBits, ChannelType } from 'discord.js';
import Guild from '../../models/Guild.js';
import { successEmbed, errorEmbed, infoEmbed, GLYPHS } from '../../utils/embeds.js';
import { getPrefix, hasModPerms } from '../../utils/helpers.js';

const CHANNEL_ID = /^(?:<#)?(\d{17,20})>?$/;
// Publishing other members' messages needs Manage Messages in the announcement channel
const PUBLISH_PERMISSIONS = [PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageMessages];

function describeChannel(guild, channelId) {
  return guild.channels.cache.has(channelId) ? `<#${channelId}>` : `Deleted channel (\`${channelId}\`)`;
}

export default {
  name: 'autopublish',
  description: 'Automatically publish messages in announcement channels',
  usage: '<enable|disable|add|remove|list>',
  aliases: ['autopub'],
  category: 'config',
  permissions: [PermissionFlagsBits.ManageGuild],
  cooldown: 5,

  async execute(message, args) {
    const guildId = message.guild.id;

    try {
      const prefix = await getPrefix(guildId);
      const guildConfig = await Guild.getGuild(guildId);

      // Check for moderator permissions (admin, mod role, or ManageGuild)
      if (!hasModPerms(message.member, guildConfig)) {
        return message.reply({
          embeds: [await errorEmbed(guildId, 'Permission Denied',
            `${GLYPHS.LOCK} You need Moderator/Staff permissions to manage auto-publish.`)]
        });
      }

      const settings = {
        enabled: guildConfig.autoPublish?.enabled ?? false,
        channels: guildConfig.autoPublish?.channels || []
      };
      const subCommand = args[0]?.toLowerCase();

      switch (subCommand) {
        case undefined:
          return showHelp(message, settings, prefix);

        case 'enable':
          await Guild.updateGuild(guildId, { $set: { 'autoPublish.enabled': true } });
          return message.reply({
            embeds: [await successEmbed(guildId, 'Auto-Publish Activated',
              `${GLYPHS.SUCCESS} Messages in configured announcement channels will be published automatically, Master.` +
              (settings.channels.length === 0
                ? `\n\nNo channels are configured yet. Add one with \`${prefix}autopublish add #channel\`.`
                : ''))]
          });

        case 'disable':
          await Guild.updateGuild(guildId, { $set: { 'autoPublish.enabled': false } });
          return message.reply({
            embeds: [await successEmbed(guildId, 'Auto-Publish Deactivated',
              `${GLYPHS.SUCCESS} Auto-publish has been disabled, Master.`)]
          });

        case 'add':
          return addChannel(message, args[1], settings, prefix);

        case 'remove':
          return removeChannel(message, args[1], settings, prefix);

        case 'list':
          return listChannels(message, settings, prefix);

        default:
          return message.reply({
            embeds: [await errorEmbed(guildId, 'Unknown Subcommand',
              `${GLYPHS.ERROR} Unknown subcommand. Use \`${prefix}autopublish\` for guidance, Master.`)]
          });
      }
    } catch (error) {
      console.error('[AutoPublish] Error:', error);
      return message.reply({
        embeds: [await errorEmbed(guildId, 'Configuration Error',
          'The auto-publish settings could not be updated, Master. Please try again.')]
      }).catch(() => null);
    }
  }
};

async function showHelp(message, settings, prefix) {
  const embed = await infoEmbed(message.guild.id, 'Auto-Publish Announcements',
    `${GLYPHS.INFO} Automatically publish messages sent in announcement channels to following servers.\n\n` +
    `${GLYPHS.ARROW_RIGHT} **Status:** ${settings.enabled ? 'Active' : 'Inactive'}\n` +
    `${GLYPHS.ARROW_RIGHT} **Channels:** ${settings.channels.length}`);

  embed.addFields({
    name: `${GLYPHS.ARROW_RIGHT} Commands`,
    value:
      `\`${prefix}autopublish enable\` - Enable auto-publish\n` +
      `\`${prefix}autopublish disable\` - Disable auto-publish\n` +
      `\`${prefix}autopublish add #channel\` - Add an announcement channel\n` +
      `\`${prefix}autopublish remove <#channel|channel_id>\` - Remove a channel\n` +
      `\`${prefix}autopublish list\` - List all channels`
  });

  return message.reply({ embeds: [embed] });
}

async function addChannel(message, arg, settings, prefix) {
  const guildId = message.guild.id;
  const channel = message.mentions.channels.first() ||
    message.guild.channels.cache.get(arg?.match(CHANNEL_ID)?.[1]);

  if (!channel) {
    return message.reply({
      embeds: [await errorEmbed(guildId, 'No Channel',
        `${GLYPHS.ERROR} Please mention a channel.\n\n**Usage:** \`${prefix}autopublish add #channel\``)]
    });
  }

  if (channel.type !== ChannelType.GuildAnnouncement) {
    return message.reply({
      embeds: [await errorEmbed(guildId, 'Not an Announcement Channel',
        `${GLYPHS.ERROR} ${channel} is not an announcement channel. Only channels of the "Announcement" type can be published, Master.`)]
    });
  }

  if (settings.channels.includes(channel.id)) {
    return message.reply({
      embeds: [await infoEmbed(guildId, 'Already Added',
        `${GLYPHS.INFO} ${channel} is already in the auto-publish list, Master.`)]
    });
  }

  await Guild.updateGuild(guildId, { $addToSet: { 'autoPublish.channels': channel.id } });

  const embed = await successEmbed(guildId, 'Channel Added',
    `${GLYPHS.SUCCESS} Added ${channel} to the auto-publish list. Every message there will be published automatically, Master.` +
    (settings.enabled ? '' : `\n\nAuto-publish is currently off. Turn it on with \`${prefix}autopublish enable\`.`));

  const botPermissions = channel.permissionsFor?.(message.guild.members.me);
  if (!botPermissions?.has(PUBLISH_PERMISSIONS)) {
    embed.addFields({
      name: `${GLYPHS.WARNING} Missing Permissions`,
      value: `I need **Send Messages** and **Manage Messages** in ${channel} to publish other members' messages.`
    });
  }

  return message.reply({ embeds: [embed] });
}

async function removeChannel(message, arg, settings, prefix) {
  const guildId = message.guild.id;
  // Raw IDs work too, so deleted channels can be removed
  const channelId = message.mentions.channels.first()?.id || arg?.match(CHANNEL_ID)?.[1];

  if (!channelId) {
    return message.reply({
      embeds: [await errorEmbed(guildId, 'No Channel',
        `${GLYPHS.ERROR} Please mention a channel or give its ID.\n\n**Usage:** \`${prefix}autopublish remove <#channel|channel_id>\``)]
    });
  }

  if (!settings.channels.includes(channelId)) {
    return message.reply({
      embeds: [await errorEmbed(guildId, 'Not Found',
        `${GLYPHS.ERROR} ${describeChannel(message.guild, channelId)} is not in the auto-publish list, Master.`)]
    });
  }

  // Also drop channels that were deleted since they were added
  const stale = settings.channels.filter(id => id !== channelId && !message.guild.channels.cache.has(id));
  await Guild.updateGuild(guildId, { $pull: { 'autoPublish.channels': { $in: [channelId, ...stale] } } });

  return message.reply({
    embeds: [await successEmbed(guildId, 'Channel Removed',
      `${GLYPHS.SUCCESS} Removed ${describeChannel(message.guild, channelId)} from the auto-publish list, Master.` +
      (stale.length ? `\n${GLYPHS.INFO} Also removed ${stale.length} deleted channel(s).` : ''))]
  });
}

async function listChannels(message, settings, prefix) {
  let channels = settings.channels.length
    ? settings.channels.map(id => `${GLYPHS.DOT} ${describeChannel(message.guild, id)}`).join('\n')
    : 'No channels configured';
  if (channels.length > 1024) {
    channels = `${channels.slice(0, 1000).replace(/\n[^\n]*$/, '')}\n— and more`;
  }

  const embed = await infoEmbed(message.guild.id, 'Auto-Publish Channels',
    `${GLYPHS.ARROW_RIGHT} **Status:** ${settings.enabled ? 'Active' : 'Inactive'}`);
  embed.addFields({ name: `${GLYPHS.ARROW_RIGHT} Channels (${settings.channels.length})`, value: channels });

  if (settings.channels.some(id => !message.guild.channels.cache.has(id))) {
    embed.addFields({
      name: `${GLYPHS.WARNING} Deleted Channels`,
      value: `Remove them with \`${prefix}autopublish remove <channel_id>\`.`
    });
  }

  return message.reply({ embeds: [embed] });
}
