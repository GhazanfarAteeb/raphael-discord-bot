import { PermissionFlagsBits, ChannelType } from 'discord.js';
import Guild from '../../models/Guild.js';
import { successEmbed, errorEmbed, infoEmbed, GLYPHS } from '../../utils/embeds.js';
import { getPrefix, hasModPerms } from '../../utils/helpers.js';

const PATH = 'features.levelSystem.noXpChannels';
const CHANNEL_ID = /^(?:<#)?(\d{17,20})>?$/;

function describeChannel(guild, channelId) {
  return guild.channels.cache.has(channelId) ? `<#${channelId}>` : `Deleted channel (\`${channelId}\`)`;
}

export default {
  name: 'noxp',
  description: 'Manage channels where XP is not earned',
  usage: 'noxp add #channel | noxp remove #channel | noxp list',
  category: 'config',
  aliases: ['xpblacklist', 'ignorexp', 'noxpchannel'],
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
            `${GLYPHS.LOCK} You need Moderator/Staff permissions to manage XP channels.`)]
        });
      }

      const ctx = {
        message,
        guildId,
        prefix: await getPrefix(guildId),
        channels: guildConfig.features?.levelSystem?.noXpChannels || []
      };

      switch (args[0]?.toLowerCase()) {
        case 'add':
          return addChannel(ctx, args[1]);
        case 'remove':
        case 'delete':
          return removeChannel(ctx, args[1]);
        case 'list':
        case 'show':
          return listChannels(ctx);
        case 'clear':
          return clearChannels(ctx);
        default:
          return showHelp(ctx);
      }
    } catch (error) {
      console.error('[NoXP] Error:', error);
      return message.reply({
        embeds: [await errorEmbed(guildId, 'Configuration Error',
          'The no-XP channel list could not be updated, Master. Please try again.')]
      }).catch(() => null);
    }
  }
};

async function showHelp({ message, guildId, prefix, channels }) {
  const embed = await infoEmbed(guildId, 'No-XP Channels',
    `${GLYPHS.INFO} Messages in these channels do not earn XP. Useful for spam and bot-command channels.\n\n` +
    `${GLYPHS.ARROW_RIGHT} **Blacklisted Channels:** ${channels.length}`);

  embed.addFields(
    {
      name: `${GLYPHS.ARROW_RIGHT} Commands`,
      value:
        `\`${prefix}noxp add #channel\` - Blacklist a channel\n` +
        `\`${prefix}noxp remove <#channel|channel_id>\` - Remove from the blacklist\n` +
        `\`${prefix}noxp list\` - View blacklisted channels\n` +
        `\`${prefix}noxp clear\` - Clear the blacklist`
    },
    {
      name: `${GLYPHS.ARROW_RIGHT} Examples`,
      value: `\`${prefix}noxp add #spam\`\n\`${prefix}noxp add #bot-commands\``
    }
  );

  return message.reply({ embeds: [embed] });
}

async function addChannel({ message, guildId, prefix, channels }, arg) {
  const channel = message.mentions.channels.first() ||
    message.guild.channels.cache.get(arg?.match(CHANNEL_ID)?.[1]);

  if (!channel) {
    return message.reply({
      embeds: [await errorEmbed(guildId, 'No Channel',
        `${GLYPHS.ERROR} Please mention a channel or provide a channel ID.\n\n` +
        `**Usage:** \`${prefix}noxp add #channel\``)]
    });
  }

  if (channel.type !== ChannelType.GuildText) {
    return message.reply({
      embeds: [await errorEmbed(guildId, 'Invalid Channel',
        `${GLYPHS.ERROR} Please select a text channel.`)]
    });
  }

  if (channels.includes(channel.id)) {
    return message.reply({
      embeds: [await infoEmbed(guildId, 'Already Blacklisted',
        `${GLYPHS.INFO} ${channel} is already blacklisted from earning XP.`)]
    });
  }

  await Guild.updateGuild(guildId, { $addToSet: { [PATH]: channel.id } });

  return message.reply({
    embeds: [await successEmbed(guildId, 'Channel Blacklisted',
      `${GLYPHS.SUCCESS} ${channel} has been added to the no-XP list.\n\n` +
      `Messages in this channel will no longer earn XP.`)]
  });
}

async function removeChannel({ message, guildId, prefix, channels }, arg) {
  // Raw IDs work too, so deleted channels can be removed
  const channelId = message.mentions.channels.first()?.id || arg?.match(CHANNEL_ID)?.[1];

  if (!channelId) {
    return message.reply({
      embeds: [await errorEmbed(guildId, 'No Channel',
        `${GLYPHS.ERROR} Please mention a channel or provide a channel ID.\n\n` +
        `**Usage:** \`${prefix}noxp remove <#channel|channel_id>\``)]
    });
  }

  if (!channels.includes(channelId)) {
    return message.reply({
      embeds: [await errorEmbed(guildId, 'Not Blacklisted',
        `${GLYPHS.ERROR} ${describeChannel(message.guild, channelId)} is not in the no-XP list.`)]
    });
  }

  await Guild.updateGuild(guildId, { $pull: { [PATH]: channelId } });

  return message.reply({
    embeds: [await successEmbed(guildId, 'Channel Removed',
      `${GLYPHS.SUCCESS} ${describeChannel(message.guild, channelId)} has been removed from the no-XP list.` +
      (message.guild.channels.cache.has(channelId) ? '\n\nMessages in this channel will now earn XP again.' : ''))]
  });
}

async function listChannels({ message, guildId, prefix, channels }) {
  if (channels.length === 0) {
    return message.reply({
      embeds: [await infoEmbed(guildId, 'No Blacklisted Channels',
        `${GLYPHS.INFO} No channels are blacklisted from earning XP.\n\n` +
        `Use \`${prefix}noxp add #channel\` to add one.`)]
    });
  }

  let channelList = channels.map(id => `${GLYPHS.ARROW_RIGHT} ${describeChannel(message.guild, id)}`).join('\n');
  if (channelList.length > 4000) {
    channelList = `${channelList.slice(0, 3980).replace(/\n[^\n]*$/, '')}\n— and more`;
  }

  const embed = await infoEmbed(guildId, `No-XP Channels (${channels.length})`, channelList);
  if (channels.some(id => !message.guild.channels.cache.has(id))) {
    embed.addFields({
      name: `${GLYPHS.WARNING} Deleted Channels`,
      value: `Remove them with \`${prefix}noxp remove <channel_id>\`.`
    });
  }

  return message.reply({ embeds: [embed] });
}

async function clearChannels({ message, guildId, channels }) {
  if (channels.length === 0) {
    return message.reply({
      embeds: [await infoEmbed(guildId, 'Nothing to Clear',
        `${GLYPHS.INFO} There are no blacklisted channels to clear.`)]
    });
  }

  await Guild.updateGuild(guildId, { $set: { [PATH]: [] } });

  return message.reply({
    embeds: [await successEmbed(guildId, 'Channels Cleared',
      `${GLYPHS.SUCCESS} All ${channels.length} channel(s) have been removed from the no-XP list.`)]
  });
}
