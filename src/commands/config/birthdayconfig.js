import { PermissionFlagsBits, EmbedBuilder, ChannelType } from 'discord.js';
import Guild from '../../models/Guild.js';
import { successEmbed, errorEmbed, infoEmbed, GLYPHS } from '../../utils/embeds.js';
import { hasModPerms, getPrefix, getAssignableRoleError } from '../../utils/helpers.js';

export default {
  name: 'birthdayconfig',
  description: 'Configure birth anniversary announcement protocols, Master',
  usage: '<enable|disable|channel|message|embed|role|test|...>',
  aliases: ['bdayconfig', 'birthdaymsg', 'bdaymsg'],
  permissions: [PermissionFlagsBits.ManageGuild],
  cooldown: 3,

  async execute(message, args) {
    const guildConfig = await Guild.getGuild(message.guild.id, message.guild.name);
    const prefix = await getPrefix(message.guild.id);

    // Check for moderator permissions
    if (!hasModPerms(message.member, guildConfig)) {
      return message.reply({
        embeds: [await errorEmbed(message.guild.id, 'Permission Denied',
          `${GLYPHS.LOCK} You need Moderator/Staff permissions to configure birthday messages.`)]
      });
    }

    if (!args[0]) {
      return showStatus(message, guildConfig, prefix);
    }

    const action = args[0].toLowerCase();

    switch (action) {
      case 'enable':
      case 'on':
        await Guild.updateGuild(message.guild.id, {
          $set: { 'features.birthdaySystem.enabled': true }
        });
        return message.reply({
          embeds: [await successEmbed(message.guild.id, 'Birthday System Enabled',
            `${GLYPHS.SUCCESS} Birthday announcements are now enabled.\n\n` +
            `Make sure to set a channel: \`${prefix}birthdayconfig channel #channel\``)]
        });

      case 'disable':
      case 'off':
        await Guild.updateGuild(message.guild.id, {
          $set: { 'features.birthdaySystem.enabled': false }
        });
        return message.reply({
          embeds: [await successEmbed(message.guild.id, 'Birthday System Disabled',
            `${GLYPHS.SUCCESS} Birthday announcements are now disabled.`)]
        });

      case 'channel':
        const channel = message.mentions.channels.first() ||
          message.guild.channels.cache.get(args[1]);

        if (!channel) {
          return message.reply({
            embeds: [await infoEmbed(message.guild.id, 'Birthday Channel',
              `**Current:** ${guildConfig.features?.birthdaySystem?.channel ? `<#${guildConfig.features.birthdaySystem.channel}>` : 'Not set'}\n\n` +
              `**Usage:** \`${prefix}birthdayconfig channel #channel\``)]
          });
        }

        if (channel.type !== ChannelType.GuildText) {
          return message.reply({
            embeds: [await errorEmbed(message.guild.id, 'Invalid Channel',
              'Please select a text channel.')]
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
            `${GLYPHS.SUCCESS} Birthday messages will be sent to ${channel}`)]
        });

      case 'role':
        const role = message.mentions.roles.first() ||
          message.guild.roles.cache.get(args[1]);

        if (args[1] === 'none' || args[1] === 'remove') {
          await Guild.updateGuild(message.guild.id, {
            $set: { 'features.birthdaySystem.role': null, 'roles.birthdayRole': null }
          });
          return message.reply({
            embeds: [await successEmbed(message.guild.id, 'Birthday Role Removed',
              `${GLYPHS.SUCCESS} Birthday role has been removed.`)]
          });
        }

        if (!role) {
          return message.reply({
            embeds: [await infoEmbed(message.guild.id, 'Birthday Role',
              `**Current:** ${guildConfig.features?.birthdaySystem?.role ? `<@&${guildConfig.features.birthdaySystem.role}>` : 'Not set'}\n\n` +
              `**Usage:**\n` +
              `\`${prefix}birthdayconfig role @role\` - Set birthday role\n` +
              `\`${prefix}birthdayconfig role none\` - Remove birthday role\n\n` +
              `This role will be given to users on their birthday and removed the next day.`)]
          });
        }

        const roleError = getAssignableRoleError(role, message.member);
        if (roleError) {
          return message.reply({ embeds: [await errorEmbed(message.guild.id, 'Role Not Allowed', roleError)] });
        }

        await Guild.updateGuild(message.guild.id, {
          $set: {
            'features.birthdaySystem.role': role.id,
            'roles.birthdayRole': role.id
          }
        });

        return message.reply({
          embeds: [await successEmbed(message.guild.id, 'Birthday Role Set',
            `${GLYPHS.SUCCESS} Birthday role set to ${role}`)]
        });

      case 'message':
      case 'msg':
      case 'description':
      case 'desc':
        const bdayMsg = args.slice(1).join(' ');

        if (!bdayMsg) {
          const currentMsg = guildConfig.features?.birthdaySystem?.message || '🎂 Happy Birthday {user}! 🎉';
          return message.reply({
            embeds: [await infoEmbed(message.guild.id, 'Birthday Message Variables',
              `**Current Message:**\n${currentMsg}\n\n` +
              `**Available Variables:**\n` +
              `${GLYPHS.DOT} \`{user}\` - Mentions the user\n` +
              `${GLYPHS.DOT} \`{username}\` - User's username\n` +
              `${GLYPHS.DOT} \`{displayname}\` - User's display name\n` +
              `${GLYPHS.DOT} \`{age}\` - User's age (if birth year set)\n` +
              `${GLYPHS.DOT} \`{server}\` - Server name\n` +
              `${GLYPHS.DOT} \`\\n\` - New line\n\n` +
              `**Example:**\n\`${prefix}birthdayconfig message 🎂 Happy Birthday {user}!\\nHope you have an amazing day!\``)]
          });
        }

        await Guild.updateGuild(message.guild.id, {
          $set: { 'features.birthdaySystem.message': bdayMsg }
        });

        return message.reply({
          embeds: [await successEmbed(message.guild.id, 'Birthday Message Set',
            `${GLYPHS.SUCCESS} Birthday message has been updated.\n\n` +
            `**Preview:**\n${parseBirthdayMessage(bdayMsg, message.member, 21)}`)]
        });

      case 'embed':
        const embedOption = args[1]?.toLowerCase();

        if (!['on', 'off', 'enable', 'disable'].includes(embedOption)) {
          return message.reply({
            embeds: [await errorEmbed(message.guild.id, 'Invalid Option',
              `Use \`${prefix}birthdayconfig embed on\` or \`${prefix}birthdayconfig embed off\``)]
          });
        }

        const embedEnabled = ['on', 'enable'].includes(embedOption);
        await Guild.updateGuild(message.guild.id, {
          $set: { 'features.birthdaySystem.embedEnabled': embedEnabled }
        });

        return message.reply({
          embeds: [await successEmbed(message.guild.id, 'Embed Setting Updated',
            `${GLYPHS.SUCCESS} Birthday embeds are now **${embedEnabled ? 'enabled' : 'disabled'}**`)]
        });

      case 'test':
        return sendTestBirthday(message, guildConfig, prefix);

      case 'image':
      case 'banner':
        const imageUrl = args[1];

        if (!imageUrl) {
          const currentBanner = guildConfig.features?.birthdaySystem?.bannerUrl;
          return message.reply({
            embeds: [await infoEmbed(message.guild.id, 'Birthday Banner',
              currentBanner
                ? `**Current Banner:**\n${currentBanner}`
                : `No banner set. Use \`${prefix}birthdayconfig image <url>\` to set one.`)]
          });
        }

        if (imageUrl === 'remove' || imageUrl === 'none') {
          await Guild.updateGuild(message.guild.id, {
            $set: { 'features.birthdaySystem.bannerUrl': null }
          });
          return message.reply({
            embeds: [await successEmbed(message.guild.id, 'Banner Removed',
              `${GLYPHS.SUCCESS} Birthday banner has been removed.`)]
          });
        }

        if (!imageUrl.match(/^https?:\/\/.+/i)) {
          return message.reply({
            embeds: [await errorEmbed(message.guild.id, 'Invalid URL',
              'Please provide a valid image URL starting with http:// or https://')]
          });
        }

        await Guild.updateGuild(message.guild.id, {
          $set: { 'features.birthdaySystem.bannerUrl': imageUrl }
        });

        return message.reply({
          embeds: [await successEmbed(message.guild.id, 'Banner Set',
            `${GLYPHS.SUCCESS} Birthday banner has been set.`)]
        });

      case 'thumbnail':
      case 'thumb':
        const thumbUrl = args[1];

        if (!thumbUrl) {
          return message.reply({
            embeds: [await infoEmbed(message.guild.id, 'Birthday Thumbnail',
              guildConfig.features?.birthdaySystem?.thumbnailUrl
                ? `**Current Thumbnail:**\n${guildConfig.features.birthdaySystem.thumbnailUrl}`
                : 'No custom thumbnail set (defaults to user avatar).\n\n' +
                `\`${prefix}birthdayconfig thumbnail <url>\` - Set custom\n` +
                `\`${prefix}birthdayconfig thumbnail avatar\` - User's avatar\n` +
                `\`${prefix}birthdayconfig thumbnail server\` - Server icon\n` +
                `\`${prefix}birthdayconfig thumbnail remove\` - Remove`)]
          });
        }

        if (thumbUrl === 'remove' || thumbUrl === 'none' || thumbUrl === 'off') {
          await Guild.updateGuild(message.guild.id, {
            $set: { 'features.birthdaySystem.thumbnailUrl': null, 'features.birthdaySystem.thumbnailType': null }
          });
          return message.reply({
            embeds: [await successEmbed(message.guild.id, 'Thumbnail Removed',
              `${GLYPHS.SUCCESS} Birthday thumbnail has been removed.`)]
          });
        }

        if (thumbUrl === 'avatar' || thumbUrl === 'user') {
          await Guild.updateGuild(message.guild.id, {
            $set: { 'features.birthdaySystem.thumbnailType': 'avatar', 'features.birthdaySystem.thumbnailUrl': null }
          });
          return message.reply({
            embeds: [await successEmbed(message.guild.id, 'Thumbnail Set',
              `${GLYPHS.SUCCESS} Thumbnail will show the user's avatar.`)]
          });
        }

        if (thumbUrl === 'server' || thumbUrl === 'guild') {
          await Guild.updateGuild(message.guild.id, {
            $set: { 'features.birthdaySystem.thumbnailType': 'server', 'features.birthdaySystem.thumbnailUrl': null }
          });
          return message.reply({
            embeds: [await successEmbed(message.guild.id, 'Thumbnail Set',
              `${GLYPHS.SUCCESS} Thumbnail will show the server icon.`)]
          });
        }

        if (!thumbUrl.match(/^https?:\/\/.+/i)) {
          return message.reply({
            embeds: [await errorEmbed(message.guild.id, 'Invalid URL',
              'Please provide a valid URL, or use `avatar`, `server`, or `remove`.')]
          });
        }

        await Guild.updateGuild(message.guild.id, {
          $set: { 'features.birthdaySystem.thumbnailUrl': thumbUrl, 'features.birthdaySystem.thumbnailType': 'custom' }
        });

        return message.reply({
          embeds: [await successEmbed(message.guild.id, 'Thumbnail Set',
            `${GLYPHS.SUCCESS} Birthday thumbnail has been set.`)]
        });

      case 'title':
        const titleText = args.slice(1).join(' ');

        if (!titleText) {
          return message.reply({
            embeds: [await infoEmbed(message.guild.id, 'Embed Title',
              `**Current Title:**\n${guildConfig.features?.birthdaySystem?.embedTitle || '🎂 Happy Birthday!'}\n\n` +
              `Use \`${prefix}birthdayconfig title <text>\` to set a custom title.\n` +
              `Use \`${prefix}birthdayconfig title reset\` for default.\n\n` +
              `**Variables:** {username}, {age}`)]
          });
        }

        if (titleText === 'reset' || titleText === 'default') {
          await Guild.updateGuild(message.guild.id, {
            $set: { 'features.birthdaySystem.embedTitle': null }
          });
          return message.reply({
            embeds: [await successEmbed(message.guild.id, 'Title Reset',
              `${GLYPHS.SUCCESS} Birthday embed title reset to default.`)]
          });
        }

        if (titleText === 'none' || titleText === 'remove') {
          await Guild.updateGuild(message.guild.id, {
            $set: { 'features.birthdaySystem.embedTitle': ' ' }
          });
          return message.reply({
            embeds: [await successEmbed(message.guild.id, 'Title Removed',
              `${GLYPHS.SUCCESS} Birthday embed title has been removed.`)]
          });
        }

        await Guild.updateGuild(message.guild.id, {
          $set: { 'features.birthdaySystem.embedTitle': titleText }
        });

        return message.reply({
          embeds: [await successEmbed(message.guild.id, 'Title Set',
            `${GLYPHS.SUCCESS} Birthday embed title set to: ${titleText}`)]
        });

      case 'footer':
        const footerText = args.slice(1).join(' ');

        if (!footerText) {
          return message.reply({
            embeds: [await infoEmbed(message.guild.id, 'Embed Footer',
              `**Current Footer:**\n${guildConfig.features?.birthdaySystem?.footerText || 'Default'}\n\n` +
              `Use \`${prefix}birthdayconfig footer <text>\` to set.\n` +
              `Use \`${prefix}birthdayconfig footer reset\` for default.\n` +
              `Use \`${prefix}birthdayconfig footer none\` to remove.`)]
          });
        }

        if (footerText === 'reset' || footerText === 'default') {
          await Guild.updateGuild(message.guild.id, {
            $set: { 'features.birthdaySystem.footerText': null }
          });
          return message.reply({
            embeds: [await successEmbed(message.guild.id, 'Footer Reset',
              `${GLYPHS.SUCCESS} Birthday footer reset to default.`)]
          });
        }

        if (footerText === 'none' || footerText === 'remove') {
          await Guild.updateGuild(message.guild.id, {
            $set: { 'features.birthdaySystem.footerText': ' ' }
          });
          return message.reply({
            embeds: [await successEmbed(message.guild.id, 'Footer Removed',
              `${GLYPHS.SUCCESS} Birthday footer has been removed.`)]
          });
        }

        await Guild.updateGuild(message.guild.id, {
          $set: { 'features.birthdaySystem.footerText': footerText }
        });

        return message.reply({
          embeds: [await successEmbed(message.guild.id, 'Footer Set',
            `${GLYPHS.SUCCESS} Birthday footer set to: ${footerText}`)]
        });

      case 'color':
        const colorHex = args[1];

        if (!colorHex) {
          return message.reply({
            embeds: [await infoEmbed(message.guild.id, 'Embed Color',
              `**Current Color:**\n${guildConfig.features?.birthdaySystem?.embedColor || '#FF69B4'}\n\n` +
              `Use \`${prefix}birthdayconfig color #HEX\` to set.\n` +
              `Use \`${prefix}birthdayconfig color reset\` for default pink.`)]
          });
        }

        if (colorHex === 'reset' || colorHex === 'default') {
          await Guild.updateGuild(message.guild.id, {
            $set: { 'features.birthdaySystem.embedColor': '#FF69B4' }
          });
          return message.reply({
            embeds: [await successEmbed(message.guild.id, 'Color Reset',
              `${GLYPHS.SUCCESS} Birthday embed color reset to default pink.`)]
          });
        }

        if (!colorHex.match(/^#?[0-9A-Fa-f]{6}$/)) {
          return message.reply({
            embeds: [await errorEmbed(message.guild.id, 'Invalid Color',
              'Please provide a valid hex color code (e.g., #FF69B4)')]
          });
        }

        const normalizedColor = colorHex.startsWith('#') ? colorHex : `#${colorHex}`;
        await Guild.updateGuild(message.guild.id, {
          $set: { 'features.birthdaySystem.embedColor': normalizedColor }
        });

        return message.reply({
          embeds: [await successEmbed(message.guild.id, 'Color Set',
            `${GLYPHS.SUCCESS} Birthday embed color set to: ${normalizedColor}`)]
        });

      case 'mention':
        const mentionOption = args[1]?.toLowerCase();

        if (!['on', 'off', 'enable', 'disable'].includes(mentionOption)) {
          return message.reply({
            embeds: [await errorEmbed(message.guild.id, 'Invalid Option',
              `Use \`${prefix}birthdayconfig mention on\` or \`${prefix}birthdayconfig mention off\``)]
          });
        }

        const mentionEnabled = ['on', 'enable'].includes(mentionOption);
        await Guild.updateGuild(message.guild.id, {
          $set: { 'features.birthdaySystem.mentionUser': mentionEnabled }
        });

        return message.reply({
          embeds: [await successEmbed(message.guild.id, 'Mention Setting Updated',
            `${GLYPHS.SUCCESS} User mention is now **${mentionEnabled ? 'enabled' : 'disabled'}**`)]
        });

      case 'age':
      case 'showage':
        const ageOption = args[1]?.toLowerCase();

        if (!['on', 'off', 'enable', 'disable'].includes(ageOption)) {
          return message.reply({
            embeds: [await errorEmbed(message.guild.id, 'Invalid Option',
              `Use \`${prefix}birthdayconfig age on\` or \`${prefix}birthdayconfig age off\``)]
          });
        }

        const showAge = ['on', 'enable'].includes(ageOption);
        await Guild.updateGuild(message.guild.id, {
          $set: { 'features.birthdaySystem.showAge': showAge }
        });

        return message.reply({
          embeds: [await successEmbed(message.guild.id, 'Age Setting Updated',
            `${GLYPHS.SUCCESS} Showing age is now **${showAge ? 'enabled' : 'disabled'}**\n\n` +
            `Note: Age will only show if the user provided their birth year.`)]
        });

      case 'preview':
        return showPreview(message, guildConfig);

      case 'help':
        return showHelp(message, prefix);

      default:
        return message.reply({
          embeds: [await errorEmbed(message.guild.id, 'Unknown Option',
            `Unknown option: \`${action}\`\n\nUse \`${prefix}birthdayconfig help\` for available commands.`)]
        });
    }
  }
};

async function showStatus(message, guildConfig, prefix) {
  const bday = guildConfig.features?.birthdaySystem || {};
  const channel = bday.channel ? message.guild.channels.cache.get(bday.channel) : null;
  const role = bday.role ? message.guild.roles.cache.get(bday.role) : null;

  const embed = new EmbedBuilder()
    .setColor(bday.embedColor || '#FF69B4')
    .setTitle('🎂 Birthday Announcement System')
    .setDescription('Celebrate member birthdays!')
    .addFields(
      { name: '▸ Status', value: bday.enabled !== false ? '`✅ Enabled`' : '`❌ Disabled`', inline: true },
      { name: '▸ Channel', value: channel ? `${channel}` : '`Not set`', inline: true },
      { name: '▸ Role', value: role ? `${role}` : '`Not set`', inline: true },
      { name: '▸ Embed', value: bday.embedEnabled !== false ? '`✅ On`' : '`❌ Off`', inline: true },
      { name: '▸ Show Age', value: bday.showAge ? '`✅ On`' : '`❌ Off`', inline: true },
      { name: '▸ Mention', value: bday.mentionUser !== false ? '`✅ On`' : '`❌ Off`', inline: true },
      { name: '▸ Message', value: `\`\`\`${(bday.message || '🎂 Happy Birthday {user}! 🎉').slice(0, 80)}\`\`\``, inline: false }
    )
    .addFields(
      {
        name: '📝 Quick Commands', value:
          `\`${prefix}birthdayconfig channel #channel\` - Set channel\n` +
          `\`${prefix}birthdayconfig role @role\` - Set birthday role\n` +
          `\`${prefix}birthdayconfig message <text>\` - Set message\n` +
          `\`${prefix}birthdayconfig test\` - Send test message\n` +
          `\`${prefix}birthdayconfig help\` - All options`, inline: false
      }
    )
    .setFooter({ text: `Use ${prefix}birthdayconfig help for all customization options` });

  return message.reply({ embeds: [embed] });
}

async function showHelp(message, prefix) {
  const helpEmbed = new EmbedBuilder()
    .setColor('#FF69B4')
    .setTitle('🎂 Birthday Configuration')
    .setDescription('All available commands for customizing birthday announcements.')
    .addFields(
      {
        name: '🔧 Basic Setup', value:
          `\`${prefix}birthdayconfig enable\` - Enable system\n` +
          `\`${prefix}birthdayconfig disable\` - Disable system\n` +
          `\`${prefix}birthdayconfig channel #channel\` - Set channel\n` +
          `\`${prefix}birthdayconfig role @role\` - Set birthday role\n` +
          `\`${prefix}birthdayconfig message <text>\` - Set message`, inline: false
      },
      {
        name: '🎨 Embed Customization', value:
          `\`${prefix}birthdayconfig embed on/off\` - Toggle embed\n` +
          `\`${prefix}birthdayconfig color #hex\` - Set color\n` +
          `\`${prefix}birthdayconfig title <text>\` - Set title\n` +
          `\`${prefix}birthdayconfig footer <text>\` - Set footer\n` +
          `\`${prefix}birthdayconfig image <url>\` - Set banner\n` +
          `\`${prefix}birthdayconfig thumbnail <type>\` - Set thumbnail`, inline: false
      },
      {
        name: '⚙️ Display Options', value:
          `\`${prefix}birthdayconfig mention on/off\` - Toggle ping\n` +
          `\`${prefix}birthdayconfig age on/off\` - Show user age`, inline: false
      },
      {
        name: '🔍 Preview & Test', value:
          `\`${prefix}birthdayconfig test\` - Send test to channel\n` +
          `\`${prefix}birthdayconfig preview\` - Preview here`, inline: false
      }
    );

  const varsEmbed = new EmbedBuilder()
    .setColor('#FF69B4')
    .setTitle('📋 Available Variables')
    .setDescription(
      '`{user}` - Mentions the user\n' +
      '`{username}` - User\'s username\n' +
      '`{displayname}` - User\'s display name\n' +
      '`{age}` - User\'s age (if year set)\n' +
      '`{server}` - Server name\n' +
      '`\\n` - New line'
    );

  return message.reply({ embeds: [helpEmbed, varsEmbed] });
}

async function showPreview(message, guildConfig) {
  const bday = guildConfig.features?.birthdaySystem || {};
  const embed = buildBirthdayEmbed(message.member, bday, guildConfig, 21);

  await message.reply({
    embeds: [await infoEmbed(message.guild.id, 'Birthday Preview',
      'Here\'s how your birthday message will look:')]
  });

  const content = bday.mentionUser !== false ? `🎂 ${message.member}` : undefined;
  await message.channel.send({ content, embeds: [embed] });
}

async function sendTestBirthday(message, guildConfig, prefix) {
  const bday = guildConfig.features?.birthdaySystem || {};
  const channel = bday.channel ? message.guild.channels.cache.get(bday.channel) : message.channel;

  if (!channel) {
    return message.reply({
      embeds: [await errorEmbed(message.guild.id, 'No Channel',
        `Birthday channel not found. Use \`${prefix}birthdayconfig channel #channel\` to set one.`)]
    });
  }

  if (bday.embedEnabled !== false) {
    const embed = buildBirthdayEmbed(message.member, bday, guildConfig, 21);
    const content = bday.mentionUser !== false ? `🎂 ${message.member}` : undefined;
    await channel.send({ content, embeds: [embed] });
  } else {
    const bdayMsg = parseBirthdayMessage(
      bday.message || '🎂 Happy Birthday {user}! 🎉',
      message.member, 21
    );
    await channel.send(bdayMsg);
  }

  return message.reply({
    embeds: [await successEmbed(message.guild.id, 'Test Sent',
      `${GLYPHS.SUCCESS} Test birthday message sent to ${channel}`)]
  });
}

/**
 * Build the birthday embed based on settings
 */
function buildBirthdayEmbed(member, bday, guildConfig, age = null) {
  const bdayMsg = parseBirthdayMessage(
    bday.message || '🎂 Happy Birthday {user}! 🎉',
    member, age
  );

  const embed = new EmbedBuilder()
    .setColor(bday.embedColor || '#FF69B4');

  // Author section
  embed.setAuthor({
    name: member.user.username,
    iconURL: member.user.displayAvatarURL({ dynamic: true, size: 128 })
  });

  // Title
  const title = bday.embedTitle;
  if (title && title.trim() && title !== ' ') {
    embed.setTitle(parseBirthdayMessage(title, member, age));
  } else if (title !== ' ') {
    embed.setTitle('🎂 Happy Birthday!');
  }

  // Description
  embed.setDescription(bdayMsg);

  // Thumbnail
  if (bday.thumbnailType === 'server') {
    embed.setThumbnail(member.guild.iconURL({ dynamic: true, size: 256 }));
  } else if (bday.thumbnailUrl) {
    embed.setThumbnail(bday.thumbnailUrl);
  } else {
    // Default to avatar
    embed.setThumbnail(member.user.displayAvatarURL({ dynamic: true, size: 256 }));
  }

  // Show age field if enabled and available
  if (bday.showAge && age) {
    embed.addFields(
      { name: '🎈 Turning', value: `**${age}** years old!`, inline: true }
    );
  }

  // Footer
  const footerText = bday.footerText;
  if (footerText && footerText.trim() && footerText !== ' ') {
    embed.setFooter({ text: parseBirthdayMessage(footerText, member, age) });
  } else if (footerText !== ' ') {
    embed.setFooter({ text: `🎉 Have an amazing day!` });
  }

  // Timestamp
  if (bday.showTimestamp !== false) {
    embed.setTimestamp();
  }

  // Banner image
  if (bday.bannerUrl) {
    embed.setImage(bday.bannerUrl);
  }

  return embed;
}

/**
 * Parse birthday message with variables
 */
function parseBirthdayMessage(msg, member, age = null) {
  return msg
    .replace(/{user}/gi, `<@${member.user.id}>`)
    .replace(/{username}/gi, member.user.username)
    .replace(/{displayname}/gi, member.displayName || member.user.displayName || member.user.username)
    .replace(/{age}/gi, age ? age.toString() : '??')
    .replace(/{server}/gi, member.guild.name)
    .replace(/\\n/g, '\n');
}

export { parseBirthdayMessage, buildBirthdayEmbed };
