import { PermissionFlagsBits, EmbedBuilder, ChannelType } from 'discord.js';
import Guild from '../../models/Guild.js';
import { successEmbed, errorEmbed, infoEmbed, GLYPHS } from '../../utils/embeds.js';
import { hasModPerms, getPrefix, getAssignableRoleError } from '../../utils/helpers.js';

// Used when a guild has no message/title/footer of its own
export const DEFAULT_BIRTHDAY_MESSAGE = 'Happy Birthday {user}!';
export const DEFAULT_BIRTHDAY_TITLE = 'Happy Birthday!';
export const DEFAULT_BIRTHDAY_COLOR = '#FF69B4';
const DEFAULT_BIRTHDAY_FOOTER = 'Have a wonderful day.';

// Earlier defaults still stored in existing guild documents: rendered as the current default
const LEGACY_BIRTHDAY_MESSAGES = new Set(['🎂 Happy Birthday {user}! 🎉', '🎉 Happy Birthday {user}! 🎂']);
const LEGACY_BIRTHDAY_TITLES = new Set(['🎂 Happy Birthday!']);

// The title/footer commands store a single space to mean "show none"
const NONE = ' ';

// Age used by preview/test when the age display is on
const SAMPLE_AGE = 21;

const LIMITS = { title: 256, description: 4096, footer: 2048, field: 1024, content: 2000, author: 256 };

const PLACEHOLDERS = /\{(user|username|displayname|age|server)\}/gi;

export default {
  name: 'birthdayconfig',
  category: 'config',
  description: 'Configure birth anniversary announcement protocols, Master',
  usage: '<enable|disable|channel|message|embed|role|test|...>',
  aliases: ['bdayconfig', 'birthdaymsg', 'bdaymsg'],
  permissions: [PermissionFlagsBits.ManageGuild],
  cooldown: 3,

  async execute(message, args) {
    const guildId = message.guild.id;

    try {
      const guildConfig = await Guild.getGuild(guildId, message.guild.name);
      const prefix = await getPrefix(guildId);

      if (!hasModPerms(message.member, guildConfig)) {
        return message.reply({
          embeds: [await errorEmbed(guildId, 'Permission Denied',
            `${GLYPHS.LOCK} You need Moderator/Staff permissions to configure birthday messages, Master.`)]
        });
      }

      if (!args[0]) {
        return await showStatus(message, guildConfig, prefix);
      }

      const action = args[0].toLowerCase();

      switch (action) {
        case 'enable':
        case 'on':
          await Guild.updateGuild(guildId, {
            $set: { 'features.birthdaySystem.enabled': true }
          });
          return message.reply({
            embeds: [await successEmbed(guildId, 'Birthday System Enabled',
              `${GLYPHS.SUCCESS} Birthday announcements are now enabled.\n\n` +
              `Make sure a channel is set: \`${prefix}birthdayconfig channel #channel\``)]
          });

        case 'disable':
        case 'off':
          await Guild.updateGuild(guildId, {
            $set: { 'features.birthdaySystem.enabled': false }
          });
          return message.reply({
            embeds: [await successEmbed(guildId, 'Birthday System Disabled',
              `${GLYPHS.SUCCESS} Birthday announcements are now disabled.`)]
          });

        case 'status':
          return await showStatus(message, guildConfig, prefix);

        case 'channel': {
          const channel = message.mentions.channels.first() ||
            message.guild.channels.cache.get(args[1]);

          if (!channel) {
            const current = guildConfig.features?.birthdaySystem?.channel;
            return message.reply({
              embeds: [await infoEmbed(guildId, 'Birthday Channel',
                `**Current:** ${current ? `<#${current}>` : 'Not set'}\n\n` +
                `**Usage:** \`${prefix}birthdayconfig channel #channel\``)]
            });
          }

          if (channel.type !== ChannelType.GuildText) {
            return message.reply({
              embeds: [await errorEmbed(guildId, 'Invalid Channel',
                'Please select a text channel, Master.')]
            });
          }

          await Guild.updateGuild(guildId, {
            $set: {
              'features.birthdaySystem.channel': channel.id,
              'channels.birthdayChannel': channel.id
            }
          });

          return message.reply({
            embeds: [await successEmbed(guildId, 'Birthday Channel Set',
              `${GLYPHS.SUCCESS} Birthday messages will be sent to ${channel}.`)]
          });
        }

        case 'role': {
          const role = message.mentions.roles.first() ||
            message.guild.roles.cache.get(args[1]);

          if (args[1] === 'none' || args[1] === 'remove') {
            await Guild.updateGuild(guildId, {
              $set: { 'features.birthdaySystem.role': null, 'roles.birthdayRole': null }
            });
            return message.reply({
              embeds: [await successEmbed(guildId, 'Birthday Role Removed',
                `${GLYPHS.SUCCESS} Birthday role has been removed.`)]
            });
          }

          if (!role) {
            const current = guildConfig.features?.birthdaySystem?.role;
            return message.reply({
              embeds: [await infoEmbed(guildId, 'Birthday Role',
                `**Current:** ${current ? `<@&${current}>` : 'Not set'}\n\n` +
                `**Usage:**\n` +
                `${GLYPHS.DOT} \`${prefix}birthdayconfig role @role\` — Set the birthday role\n` +
                `${GLYPHS.DOT} \`${prefix}birthdayconfig role none\` — Remove the birthday role\n\n` +
                `This role is given to members on their birthday and removed at the end of the day.`)]
            });
          }

          const roleError = getAssignableRoleError(role, message.member);
          if (roleError) {
            return message.reply({ embeds: [await errorEmbed(guildId, 'Role Not Allowed', roleError)] });
          }

          await Guild.updateGuild(guildId, {
            $set: {
              'features.birthdaySystem.role': role.id,
              'roles.birthdayRole': role.id
            }
          });

          return message.reply({
            embeds: [await successEmbed(guildId, 'Birthday Role Set',
              `${GLYPHS.SUCCESS} Birthday role set to ${role}.`)]
          });
        }

        case 'message':
        case 'msg':
        case 'description':
        case 'desc': {
          const bdayMsg = args.slice(1).join(' ');

          if (!bdayMsg) {
            return message.reply({
              embeds: [await infoEmbed(guildId, 'Birthday Message',
                `**Current Message:**\n${clip(getBirthdayTemplate(guildConfig.features?.birthdaySystem), 1500)}\n\n` +
                `**Available Variables:**\n${variablesList()}\n\n` +
                `**Example:**\n\`${prefix}birthdayconfig message Happy Birthday {user}!\\nMay your day be splendid, Master.\``)]
            });
          }

          await Guild.updateGuild(guildId, {
            $set: { 'features.birthdaySystem.message': bdayMsg }
          });

          const bday = guildConfig.features?.birthdaySystem || {};
          const preview = parseBirthdayMessage(bdayMsg, message.member, bday.showAge ? SAMPLE_AGE : null);
          return message.reply({
            embeds: [await successEmbed(guildId, 'Birthday Message Set',
              `${GLYPHS.SUCCESS} Birthday message has been updated.\n\n**Preview:**\n${clip(preview, 3500)}`)]
          });
        }

        case 'embed': {
          const embedOption = args[1]?.toLowerCase();

          if (!['on', 'off', 'enable', 'disable'].includes(embedOption)) {
            return message.reply({
              embeds: [await errorEmbed(guildId, 'Invalid Option',
                `Use \`${prefix}birthdayconfig embed on\` or \`${prefix}birthdayconfig embed off\`, Master.`)]
            });
          }

          const embedEnabled = ['on', 'enable'].includes(embedOption);
          await Guild.updateGuild(guildId, {
            $set: { 'features.birthdaySystem.embedEnabled': embedEnabled }
          });

          return message.reply({
            embeds: [await successEmbed(guildId, 'Embed Setting Updated',
              `${GLYPHS.SUCCESS} Birthday embeds are now **${embedEnabled ? 'enabled' : 'disabled'}**.`)]
          });
        }

        case 'test':
          return await sendTestBirthday(message, guildConfig, prefix);

        case 'image':
        case 'banner': {
          const imageUrl = args[1];

          if (!imageUrl) {
            const currentBanner = guildConfig.features?.birthdaySystem?.bannerUrl;
            return message.reply({
              embeds: [await infoEmbed(guildId, 'Birthday Banner',
                currentBanner
                  ? `**Current Banner:**\n${currentBanner}`
                  : `No banner set. Use \`${prefix}birthdayconfig image <url>\` to set one.`)]
            });
          }

          if (imageUrl === 'remove' || imageUrl === 'none') {
            await Guild.updateGuild(guildId, {
              $set: { 'features.birthdaySystem.bannerUrl': null }
            });
            return message.reply({
              embeds: [await successEmbed(guildId, 'Banner Removed',
                `${GLYPHS.SUCCESS} Birthday banner has been removed.`)]
            });
          }

          if (!isHttpUrl(imageUrl)) {
            return message.reply({
              embeds: [await errorEmbed(guildId, 'Invalid URL',
                'Please provide a valid image URL starting with http:// or https://, Master.')]
            });
          }

          await Guild.updateGuild(guildId, {
            $set: { 'features.birthdaySystem.bannerUrl': imageUrl }
          });

          return message.reply({
            embeds: [await successEmbed(guildId, 'Banner Set',
              `${GLYPHS.SUCCESS} Birthday banner has been set.`)]
          });
        }

        case 'thumbnail':
        case 'thumb': {
          const thumbUrl = args[1];

          if (!thumbUrl) {
            return message.reply({
              embeds: [await infoEmbed(guildId, 'Birthday Thumbnail',
                `**Current:** ${describeThumbnail(guildConfig.features?.birthdaySystem)}\n\n` +
                `${GLYPHS.DOT} \`${prefix}birthdayconfig thumbnail <url>\` — Set a custom thumbnail\n` +
                `${GLYPHS.DOT} \`${prefix}birthdayconfig thumbnail avatar\` — Use the member's avatar\n` +
                `${GLYPHS.DOT} \`${prefix}birthdayconfig thumbnail server\` — Use the server icon\n` +
                `${GLYPHS.DOT} \`${prefix}birthdayconfig thumbnail remove\` — Show no thumbnail`)]
            });
          }

          if (thumbUrl === 'remove' || thumbUrl === 'none' || thumbUrl === 'off') {
            // thumbnailType null means "no thumbnail" (unset means the avatar default)
            await Guild.updateGuild(guildId, {
              $set: { 'features.birthdaySystem.thumbnailUrl': null, 'features.birthdaySystem.thumbnailType': null }
            });
            return message.reply({
              embeds: [await successEmbed(guildId, 'Thumbnail Removed',
                `${GLYPHS.SUCCESS} Birthday announcements will show no thumbnail.`)]
            });
          }

          if (thumbUrl === 'avatar' || thumbUrl === 'user') {
            await Guild.updateGuild(guildId, {
              $set: { 'features.birthdaySystem.thumbnailType': 'avatar', 'features.birthdaySystem.thumbnailUrl': null }
            });
            return message.reply({
              embeds: [await successEmbed(guildId, 'Thumbnail Set',
                `${GLYPHS.SUCCESS} Thumbnail will show the member's avatar.`)]
            });
          }

          if (thumbUrl === 'server' || thumbUrl === 'guild') {
            await Guild.updateGuild(guildId, {
              $set: { 'features.birthdaySystem.thumbnailType': 'server', 'features.birthdaySystem.thumbnailUrl': null }
            });
            return message.reply({
              embeds: [await successEmbed(guildId, 'Thumbnail Set',
                `${GLYPHS.SUCCESS} Thumbnail will show the server icon.`)]
            });
          }

          if (!isHttpUrl(thumbUrl)) {
            return message.reply({
              embeds: [await errorEmbed(guildId, 'Invalid URL',
                'Please provide a valid URL, or use `avatar`, `server`, or `remove`, Master.')]
            });
          }

          await Guild.updateGuild(guildId, {
            $set: { 'features.birthdaySystem.thumbnailUrl': thumbUrl, 'features.birthdaySystem.thumbnailType': 'custom' }
          });

          return message.reply({
            embeds: [await successEmbed(guildId, 'Thumbnail Set',
              `${GLYPHS.SUCCESS} Birthday thumbnail has been set.`)]
          });
        }

        case 'title': {
          const titleText = args.slice(1).join(' ');

          if (!titleText) {
            const current = guildConfig.features?.birthdaySystem?.embedTitle;
            return message.reply({
              embeds: [await infoEmbed(guildId, 'Embed Title',
                `**Current Title:** ${current === NONE ? 'None' : getBirthdayTitleTemplate(guildConfig.features?.birthdaySystem)}\n\n` +
                `${GLYPHS.DOT} \`${prefix}birthdayconfig title <text>\` — Set a custom title\n` +
                `${GLYPHS.DOT} \`${prefix}birthdayconfig title reset\` — Use the default\n` +
                `${GLYPHS.DOT} \`${prefix}birthdayconfig title none\` — Remove the title\n\n` +
                `**Variables:** every message variable works here, e.g. {username}, {age}`)]
            });
          }

          if (titleText === 'reset' || titleText === 'default') {
            await Guild.updateGuild(guildId, {
              $set: { 'features.birthdaySystem.embedTitle': null }
            });
            return message.reply({
              embeds: [await successEmbed(guildId, 'Title Reset',
                `${GLYPHS.SUCCESS} Birthday embed title reset to default.`)]
            });
          }

          if (titleText === 'none' || titleText === 'remove') {
            await Guild.updateGuild(guildId, {
              $set: { 'features.birthdaySystem.embedTitle': NONE }
            });
            return message.reply({
              embeds: [await successEmbed(guildId, 'Title Removed',
                `${GLYPHS.SUCCESS} Birthday embed title has been removed.`)]
            });
          }

          if (titleText.length > LIMITS.title) {
            return message.reply({
              embeds: [await errorEmbed(guildId, 'Title Too Long',
                `Embed titles are limited to ${LIMITS.title} characters, Master.`)]
            });
          }

          await Guild.updateGuild(guildId, {
            $set: { 'features.birthdaySystem.embedTitle': titleText }
          });

          return message.reply({
            embeds: [await successEmbed(guildId, 'Title Set',
              `${GLYPHS.SUCCESS} Birthday embed title set to: ${titleText}`)]
          });
        }

        case 'footer': {
          const footerText = args.slice(1).join(' ');

          if (!footerText) {
            const current = guildConfig.features?.birthdaySystem?.footerText;
            return message.reply({
              embeds: [await infoEmbed(guildId, 'Embed Footer',
                `**Current Footer:** ${current === NONE ? 'None' : (current || `Default (${DEFAULT_BIRTHDAY_FOOTER})`)}\n\n` +
                `${GLYPHS.DOT} \`${prefix}birthdayconfig footer <text>\` — Set a custom footer\n` +
                `${GLYPHS.DOT} \`${prefix}birthdayconfig footer reset\` — Use the default\n` +
                `${GLYPHS.DOT} \`${prefix}birthdayconfig footer none\` — Remove the footer`)]
            });
          }

          if (footerText === 'reset' || footerText === 'default') {
            await Guild.updateGuild(guildId, {
              $set: { 'features.birthdaySystem.footerText': null }
            });
            return message.reply({
              embeds: [await successEmbed(guildId, 'Footer Reset',
                `${GLYPHS.SUCCESS} Birthday footer reset to default.`)]
            });
          }

          if (footerText === 'none' || footerText === 'remove') {
            await Guild.updateGuild(guildId, {
              $set: { 'features.birthdaySystem.footerText': NONE }
            });
            return message.reply({
              embeds: [await successEmbed(guildId, 'Footer Removed',
                `${GLYPHS.SUCCESS} Birthday footer has been removed.`)]
            });
          }

          await Guild.updateGuild(guildId, {
            $set: { 'features.birthdaySystem.footerText': footerText }
          });

          return message.reply({
            embeds: [await successEmbed(guildId, 'Footer Set',
              `${GLYPHS.SUCCESS} Birthday footer set to: ${footerText}`)]
          });
        }

        case 'color': {
          const colorHex = args[1];

          if (!colorHex) {
            return message.reply({
              embeds: [await infoEmbed(guildId, 'Embed Color',
                `**Current Color:** ${guildConfig.features?.birthdaySystem?.embedColor || DEFAULT_BIRTHDAY_COLOR}\n\n` +
                `${GLYPHS.DOT} \`${prefix}birthdayconfig color #HEX\` — Set a custom color\n` +
                `${GLYPHS.DOT} \`${prefix}birthdayconfig color reset\` — Use the default (${DEFAULT_BIRTHDAY_COLOR})`)]
            });
          }

          if (colorHex === 'reset' || colorHex === 'default') {
            await Guild.updateGuild(guildId, {
              $set: { 'features.birthdaySystem.embedColor': DEFAULT_BIRTHDAY_COLOR }
            });
            return message.reply({
              embeds: [await successEmbed(guildId, 'Color Reset',
                `${GLYPHS.SUCCESS} Birthday embed color reset to the default (${DEFAULT_BIRTHDAY_COLOR}).`)]
            });
          }

          if (!/^#?[0-9A-Fa-f]{6}$/.test(colorHex)) {
            return message.reply({
              embeds: [await errorEmbed(guildId, 'Invalid Color',
                `Please provide a valid hex color code (e.g., ${DEFAULT_BIRTHDAY_COLOR}), Master.`)]
            });
          }

          const normalizedColor = colorHex.startsWith('#') ? colorHex : `#${colorHex}`;
          await Guild.updateGuild(guildId, {
            $set: { 'features.birthdaySystem.embedColor': normalizedColor }
          });

          return message.reply({
            embeds: [await successEmbed(guildId, 'Color Set',
              `${GLYPHS.SUCCESS} Birthday embed color set to: ${normalizedColor}`)]
          });
        }

        case 'mention': {
          const mentionOption = args[1]?.toLowerCase();

          if (!['on', 'off', 'enable', 'disable'].includes(mentionOption)) {
            return message.reply({
              embeds: [await errorEmbed(guildId, 'Invalid Option',
                `Use \`${prefix}birthdayconfig mention on\` or \`${prefix}birthdayconfig mention off\`, Master.`)]
            });
          }

          const mentionEnabled = ['on', 'enable'].includes(mentionOption);
          await Guild.updateGuild(guildId, {
            $set: { 'features.birthdaySystem.mentionUser': mentionEnabled }
          });

          return message.reply({
            embeds: [await successEmbed(guildId, 'Mention Setting Updated',
              `${GLYPHS.SUCCESS} Pinging the member is now **${mentionEnabled ? 'enabled' : 'disabled'}**.`)]
          });
        }

        case 'age':
        case 'showage': {
          const ageOption = args[1]?.toLowerCase();

          if (!['on', 'off', 'enable', 'disable'].includes(ageOption)) {
            return message.reply({
              embeds: [await errorEmbed(guildId, 'Invalid Option',
                `Use \`${prefix}birthdayconfig age on\` or \`${prefix}birthdayconfig age off\`, Master.`)]
            });
          }

          const showAge = ['on', 'enable'].includes(ageOption);
          await Guild.updateGuild(guildId, {
            $set: { 'features.birthdaySystem.showAge': showAge }
          });

          return message.reply({
            embeds: [await successEmbed(guildId, 'Age Setting Updated',
              `${GLYPHS.SUCCESS} Showing age is now **${showAge ? 'enabled' : 'disabled'}**.\n\n` +
              `Age is only shown for members who provided their birth year and did not mark their age as private.`)]
          });
        }

        case 'preview':
          return await showPreview(message, guildConfig);

        case 'help':
          return await showHelp(message, prefix);

        default:
          return message.reply({
            embeds: [await errorEmbed(guildId, 'Unknown Option',
              `Unknown option: \`${clip(action, 50)}\`\n\nUse \`${prefix}birthdayconfig help\` for available commands, Master.`)]
          });
      }
    } catch (error) {
      console.error('[BirthdayConfig] Error:', error);
      return message.reply({
        embeds: [await errorEmbed(guildId, 'Birthday Configuration Failed',
          'An anomaly occurred while updating the birthday configuration, Master.')]
      }).catch(() => null);
    }
  }
};

function onOff(value, on = 'On', off = 'Off') {
  return value ? `◉ ${on}` : `◇ ${off}`;
}

function variablesList() {
  return [
    '`{user}` — Mentions the member',
    '`{username}` — Username',
    '`{displayname}` — Display name',
    '`{age}` — Age (lines using it are left out when the age is not shown)',
    '`{server}` — Server name',
    '`\\n` — New line'
  ].map(line => `${GLYPHS.DOT} ${line}`).join('\n');
}

function describeThumbnail(bday = {}) {
  if (bday.thumbnailType === null) return 'None';
  if (bday.thumbnailType === 'server') return 'Server icon';
  if (bday.thumbnailUrl) return bday.thumbnailUrl;
  return "Member's avatar (default)";
}

async function showStatus(message, guildConfig, prefix) {
  const bday = guildConfig.features?.birthdaySystem || {};
  const channelId = bday.channel || guildConfig.channels?.birthdayChannel;
  const channel = channelId ? message.guild.channels.cache.get(channelId) : null;
  const roleId = bday.role || guildConfig.roles?.birthdayRole;
  const role = roleId ? message.guild.roles.cache.get(roleId) : null;

  const embed = await infoEmbed(message.guild.id, 'Birthday Announcements',
    'Current birthday announcement configuration, Master.');

  embed.addFields(
    { name: '▸ Status', value: onOff(bday.enabled !== false, 'Enabled', 'Disabled'), inline: true },
    { name: '▸ Channel', value: channel ? `${channel}` : (channelId ? 'Configured channel is missing' : 'Not set'), inline: true },
    { name: '▸ Role', value: role ? `${role}` : 'Not set', inline: true },
    { name: '▸ Embed', value: onOff(bday.embedEnabled !== false), inline: true },
    { name: '▸ Show Age', value: onOff(bday.showAge), inline: true },
    { name: '▸ Mention', value: onOff(bday.mentionUser !== false), inline: true },
    { name: '▸ Message', value: codeBlock(getBirthdayTemplate(bday), LIMITS.field), inline: false },
    {
      name: '▸ Quick Commands', value:
        `\`${prefix}birthdayconfig channel #channel\` — Set the channel\n` +
        `\`${prefix}birthdayconfig role @role\` — Set the birthday role\n` +
        `\`${prefix}birthdayconfig message <text>\` — Set the message\n` +
        `\`${prefix}birthdayconfig test\` — Send a test message\n` +
        `\`${prefix}birthdayconfig help\` — All options`, inline: false
    }
  );

  return message.reply({ embeds: [embed] });
}

async function showHelp(message, prefix) {
  const embed = await infoEmbed(message.guild.id, 'Birthday Configuration',
    'All available commands for customizing birthday announcements, Master.');

  embed.addFields(
    {
      name: '▸ Basic Setup', value:
        `\`${prefix}birthdayconfig enable\` — Enable the system\n` +
        `\`${prefix}birthdayconfig disable\` — Disable the system\n` +
        `\`${prefix}birthdayconfig channel #channel\` — Set the channel\n` +
        `\`${prefix}birthdayconfig role @role\` — Set the birthday role\n` +
        `\`${prefix}birthdayconfig message <text>\` — Set the message`, inline: false
    },
    {
      name: '▸ Embed Customization', value:
        `\`${prefix}birthdayconfig embed on/off\` — Toggle embed mode\n` +
        `\`${prefix}birthdayconfig color #hex\` — Set the color\n` +
        `\`${prefix}birthdayconfig title <text>\` — Set the title\n` +
        `\`${prefix}birthdayconfig footer <text>\` — Set the footer\n` +
        `\`${prefix}birthdayconfig image <url>\` — Set a banner\n` +
        `\`${prefix}birthdayconfig thumbnail <type>\` — Set the thumbnail`, inline: false
    },
    {
      name: '▸ Display Options', value:
        `\`${prefix}birthdayconfig mention on/off\` — Toggle the member ping\n` +
        `\`${prefix}birthdayconfig age on/off\` — Show the member's age`, inline: false
    },
    {
      name: '▸ Preview & Test', value:
        `\`${prefix}birthdayconfig test\` — Send a test to the birthday channel\n` +
        `\`${prefix}birthdayconfig preview\` — Preview here`, inline: false
    },
    { name: '▸ Variables', value: variablesList(), inline: false }
  );

  return message.reply({ embeds: [embed] });
}

async function showPreview(message, guildConfig) {
  const bday = guildConfig.features?.birthdaySystem || {};

  await message.reply({
    embeds: [await infoEmbed(message.guild.id, 'Birthday Preview',
      'This is how your birthday announcement will look, Master:')]
  });

  // Same payload as a real announcement, without pinging anyone
  const payload = buildBirthdayMessage(message.member, guildConfig, {
    age: bday.showAge ? SAMPLE_AGE : null,
    silent: true
  });
  await message.channel.send(payload);
}

async function sendTestBirthday(message, guildConfig, prefix) {
  const bday = guildConfig.features?.birthdaySystem || {};
  const channelId = bday.channel || guildConfig.channels?.birthdayChannel;
  const channel = channelId ? message.guild.channels.cache.get(channelId) : message.channel;

  if (!channel) {
    return message.reply({
      embeds: [await errorEmbed(message.guild.id, 'No Channel',
        `The birthday channel no longer exists. Use \`${prefix}birthdayconfig channel #channel\` to set one, Master.`)]
    });
  }

  if (!canAnnounceIn(channel, message.guild, bday.embedEnabled !== false)) {
    return message.reply({
      embeds: [await errorEmbed(message.guild.id, 'Missing Permissions',
        `I cannot send ${bday.embedEnabled !== false ? 'embeds ' : 'messages '}in ${channel}, Master.`)]
    });
  }

  await channel.send(buildBirthdayMessage(message.member, guildConfig, { age: bday.showAge ? SAMPLE_AGE : null }));

  return message.reply({
    embeds: [await successEmbed(message.guild.id, 'Test Sent',
      `${GLYPHS.SUCCESS} Test birthday message sent to ${channel}.`)]
  });
}

// ==================== SHARED HELPERS (used by the birthday scheduler) ====================

function clip(text, max) {
  const value = String(text ?? '');
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function codeBlock(text, max) {
  // Keep a configured message from closing the block early
  const safe = String(text ?? '').replace(/```/g, '`​``');
  return `\`\`\`${clip(safe, max - 6)}\`\`\``;
}

function isHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function safeColor(value, fallback) {
  if (typeof value === 'string' && /^#?[0-9a-f]{6}$/i.test(value)) {
    return value.startsWith('#') ? value : `#${value}`;
  }
  return fallback;
}

// Accepts a GuildMember or a User
function resolveUser(member) {
  return member?.user ?? member;
}

/** The configured birthday message, with the old emoji default treated as the current default. */
export function getBirthdayTemplate(bday) {
  const msg = bday?.message;
  return !msg || !msg.trim() || LEGACY_BIRTHDAY_MESSAGES.has(msg) ? DEFAULT_BIRTHDAY_MESSAGE : msg;
}

function getBirthdayTitleTemplate(bday) {
  const title = bday?.embedTitle;
  return !title || !title.trim() || LEGACY_BIRTHDAY_TITLES.has(title) ? DEFAULT_BIRTHDAY_TITLE : title;
}

// Without an age, a line whose only placeholder is {age} ("Turning {age} today!") is left
// out; anywhere else the placeholder is simply removed, so no other text is lost
function removeAge(text) {
  if (!/\{age\}/i.test(text)) return text;
  const lines = text.split(/\\n|\n/);
  const isAgeOnlyLine = line => /\{age\}/i.test(line) && !/\{(user|username|displayname|server)\}/i.test(line);
  const kept = lines.filter(line => !isAgeOnlyLine(line));
  const result = kept.some(line => line.trim()) ? kept.join('\n') : text;
  return result.replace(/[ \t]*\{age\}/gi, '');
}

/**
 * Replace every documented placeholder (all occurrences, one pass) and `\n`.
 * age: number to show, or null when the age is unknown or hidden.
 * context.guild is needed when `member` is a User rather than a GuildMember.
 */
export function parseBirthdayMessage(msg, member, age = null, context = {}) {
  const user = resolveUser(member);
  const guild = member?.guild ?? context.guild;
  const hasAge = age !== null && age !== undefined && Number.isFinite(Number(age));
  const values = {
    user: user?.id ? `<@${user.id}>` : '',
    username: user?.username ?? 'Unknown',
    displayname: member?.displayName ?? user?.globalName ?? user?.username ?? 'Unknown',
    age: hasAge ? String(age) : '',
    server: guild?.name ?? ''
  };

  const text = hasAge ? String(msg ?? '') : removeAge(String(msg ?? ''));
  return text
    .replace(PLACEHOLDERS, (_, key) => values[key.toLowerCase()])
    .replace(/\\n/g, '\n');
}

function resolveThumbnail(bday, user, guild) {
  // null is what `birthdayconfig thumbnail remove` stores; an unset type keeps the avatar default
  if (bday.thumbnailType === null || bday.thumbnailType === 'none') return null;
  if (bday.thumbnailType === 'server') return guild?.iconURL({ size: 256 }) ?? null;
  if (bday.thumbnailUrl) return bday.thumbnailUrl;
  return user?.displayAvatarURL?.({ size: 256 }) ?? null;
}

/**
 * Build the birthday embed from the guild's birthday settings.
 * age: number to show, or null when unknown/hidden (callers apply the showAge rules).
 * options.customMessage: the member's own birthday message, shown as a field
 * options.guild: needed when `member` is a User
 */
export function buildBirthdayEmbed(member, bday = {}, guildConfig, age = null, options = {}) {
  const settings = bday || {};
  const user = resolveUser(member);
  const guild = member?.guild ?? options.guild;
  const parse = text => parseBirthdayMessage(text, member, age, { guild });

  const embed = new EmbedBuilder().setColor(safeColor(settings.embedColor, DEFAULT_BIRTHDAY_COLOR));

  if (user?.username) {
    embed.setAuthor({
      name: clip(user.username, LIMITS.author),
      iconURL: user.displayAvatarURL?.({ size: 128 }) ?? undefined
    });
  }

  if (settings.embedTitle !== NONE) {
    const title = parse(getBirthdayTitleTemplate(settings));
    if (title.trim()) embed.setTitle(clip(title, LIMITS.title));
  }

  const description = parse(getBirthdayTemplate(settings));
  if (description.trim()) embed.setDescription(clip(description, LIMITS.description));

  const thumbnail = resolveThumbnail(settings, user, guild);
  if (thumbnail && isHttpUrl(thumbnail)) embed.setThumbnail(thumbnail);

  if (settings.showAge && age !== null && age !== undefined) {
    embed.addFields({ name: '▸ Turning', value: `**${age}** years old`, inline: true });
  }

  if (options.customMessage) {
    embed.addFields({ name: '▸ Personal Message', value: clip(`"${options.customMessage}"`, LIMITS.field), inline: false });
  }

  if (settings.footerText !== NONE) {
    const footer = settings.footerText && settings.footerText.trim() ? parse(settings.footerText) : DEFAULT_BIRTHDAY_FOOTER;
    if (footer.trim()) embed.setFooter({ text: clip(footer, LIMITS.footer) });
  }

  if (settings.showTimestamp !== false) embed.setTimestamp();

  if (settings.bannerUrl && isHttpUrl(settings.bannerUrl)) embed.setImage(settings.bannerUrl);

  return embed;
}

/**
 * Message options for a birthday announcement, honouring the embed and mention settings.
 * Only the birthday member can be pinged; @everyone/@here and roles never are.
 * options: { age, customMessage, guild, silent } (silent: render the mention without pinging)
 */
export function buildBirthdayMessage(member, guildConfig, options = {}) {
  const bday = guildConfig?.features?.birthdaySystem || {};
  const user = resolveUser(member);
  const guild = member?.guild ?? options.guild;
  const age = options.age ?? null;
  const mention = bday.mentionUser !== false && user?.id;
  const userMention = user?.id ? `<@${user.id}>` : '';
  const allowedMentions = mention && !options.silent ? { users: [user.id] } : { parse: [] };

  if (bday.embedEnabled !== false) {
    const embed = buildBirthdayEmbed(member, bday, guildConfig, age, { guild, customMessage: options.customMessage });
    return { content: mention ? userMention : undefined, embeds: [embed], allowedMentions };
  }

  const template = getBirthdayTemplate(bday);
  let text = parseBirthdayMessage(template, member, age, { guild });
  if (mention && !text.includes(userMention)) text = `${userMention} ${text}`;
  if (bday.showAge && age !== null && !/\{age\}/i.test(template)) text += `\nTurning **${age}** today.`;
  if (options.customMessage) text += `\n\n"${options.customMessage}"`;
  return { content: clip(text, LIMITS.content), allowedMentions };
}

/**
 * The age to announce for a Birthday document on its celebration day, or null when the
 * guild's age display is off, the member keeps their age private, or no year is known.
 */
export function getAnnouncedAge(birthday, guildConfig, date = new Date()) {
  if (!guildConfig?.features?.birthdaySystem?.showAge) return null;
  if (!birthday?.showAge || !birthday?.birthday?.year) return null;
  const age = date.getFullYear() - birthday.birthday.year;
  return age > 0 ? age : null;
}

function canAnnounceIn(channel, guild, withEmbed) {
  if (!channel?.isTextBased?.()) return false;
  const me = guild?.members?.me;
  if (!me) return true;
  const needed = [
    PermissionFlagsBits.ViewChannel,
    channel.isThread?.() ? PermissionFlagsBits.SendMessagesInThreads : PermissionFlagsBits.SendMessages
  ];
  if (withEmbed) needed.push(PermissionFlagsBits.EmbedLinks);
  return channel.permissionsFor(me)?.has(needed) ?? false;
}

/**
 * Post a birthday announcement for `member` in `channel` with the guild's settings.
 * birthday: the Birthday document (age privacy and personal message). Never throws.
 * Returns true when the message was sent.
 */
export async function sendBirthdayAnnouncement({ channel, member, guildConfig, birthday, date = new Date() }) {
  try {
    const guild = channel?.guild ?? member?.guild;
    const embedEnabled = guildConfig?.features?.birthdaySystem?.embedEnabled !== false;
    if (!channel || !member || !canAnnounceIn(channel, guild, embedEnabled)) return false;

    await channel.send(buildBirthdayMessage(member, guildConfig, {
      age: getAnnouncedAge(birthday, guildConfig, date),
      customMessage: birthday?.customMessage,
      guild
    }));
    return true;
  } catch (error) {
    console.error('[Birthday] Failed to send birthday announcement:', error);
    return false;
  }
}
