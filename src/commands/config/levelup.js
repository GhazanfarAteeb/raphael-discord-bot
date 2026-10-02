import { PermissionFlagsBits, EmbedBuilder, ChannelType } from 'discord.js';
import Guild from '../../models/Guild.js';
import { successEmbed, errorEmbed, infoEmbed, GLYPHS } from '../../utils/embeds.js';
import { hasModPerms, getPrefix } from '../../utils/helpers.js';

// Used when a guild has no message/title of its own
export const DEFAULT_LEVEL_UP_MESSAGE = 'Congratulations {user}! You reached level {level}!';
export const DEFAULT_LEVEL_UP_TITLE = 'Level Up!';
export const DEFAULT_LEVEL_UP_COLOR = '#FFD700';

// Earlier defaults still stored in existing guild documents: rendered as the current default
const LEGACY_LEVEL_UP_MESSAGES = new Set([
  '🎉 Congratulations {user}! You reached level {level}!',
  '🎉 {user} leveled up to level {level}!'
]);

// The title/footer commands store a single space to mean "show none"
const NONE = ' ';

// Sample figures for preview/test (level 5 needs 405 XP under the Level model formula)
const SAMPLE_STATS = { newLevel: 5, oldLevel: 4, totalXp: 1250, currentXp: 150, nextLevelXp: 405 };

const LIMITS = { title: 256, description: 4096, footer: 2048, field: 1024, content: 2000, author: 256 };

const PLACEHOLDERS = /\{(user|username|displayname|level|oldlevel|xp|totalxp|nextxp|server)\}/gi;

export default {
  name: 'levelup',
  category: 'config',
  description: 'Configure level up announcement messages',
  usage: '<enable|disable|channel|message|embed|test|...>',
  aliases: ['lvlup', 'levelupmsg', 'lvlupmsg'],
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
            `${GLYPHS.LOCK} You need Moderator/Staff permissions to configure level up messages, Master.`)]
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
            $set: { 'features.levelSystem.announceLevelUp': true }
          });
          return message.reply({
            embeds: [await successEmbed(guildId, 'Level Up Announcements Enabled',
              `${GLYPHS.SUCCESS} Level up announcements are now enabled.`)]
          });

        case 'disable':
        case 'off':
          await Guild.updateGuild(guildId, {
            $set: { 'features.levelSystem.announceLevelUp': false }
          });
          return message.reply({
            embeds: [await successEmbed(guildId, 'Level Up Announcements Disabled',
              `${GLYPHS.SUCCESS} Level up announcements are now disabled.`)]
          });

        case 'status':
          return await showStatus(message, guildConfig, prefix);

        case 'channel': {
          if (args[1] === 'current' || args[1] === 'same') {
            // Voice XP and admin awards fall back to channels.levelUpChannel, so clear both
            await Guild.updateGuild(guildId, {
              $unset: { 'features.levelSystem.levelUpChannel': '', 'channels.levelUpChannel': '' }
            });
            return message.reply({
              embeds: [await successEmbed(guildId, 'Level Up Channel Set',
                `${GLYPHS.SUCCESS} Level up messages will be sent in the channel where the member leveled up.`)]
            });
          }

          const channel = message.mentions.channels.first() ||
            message.guild.channels.cache.get(args[1]);

          if (!channel) {
            const current = guildConfig.features?.levelSystem?.levelUpChannel;
            return message.reply({
              embeds: [await infoEmbed(guildId, 'Level Up Channel',
                `**Current:** ${current ? `<#${current}>` : 'Same channel as the message (default)'}\n\n` +
                `**Usage:**\n` +
                `${GLYPHS.DOT} \`${prefix}levelup channel #channel\` — Set a specific channel\n` +
                `${GLYPHS.DOT} \`${prefix}levelup channel current\` — Use the channel of the message`)]
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
              'features.levelSystem.levelUpChannel': channel.id,
              'channels.levelUpChannel': channel.id
            }
          });

          return message.reply({
            embeds: [await successEmbed(guildId, 'Level Up Channel Set',
              `${GLYPHS.SUCCESS} Level up messages will be sent to ${channel}.`)]
          });
        }

        case 'message':
        case 'msg':
        case 'description':
        case 'desc': {
          const lvlMsg = args.slice(1).join(' ');

          if (!lvlMsg) {
            return message.reply({
              embeds: [await infoEmbed(guildId, 'Level Up Message',
                `**Current Message:**\n${clip(getLevelUpTemplate(guildConfig.features?.levelSystem), 1500)}\n\n` +
                `**Available Variables:**\n${variablesList()}\n\n` +
                `**Example:**\n\`${prefix}levelup message {user} has reached level {level}, Master.\``)]
            });
          }

          await Guild.updateGuild(guildId, {
            $set: { 'features.levelSystem.levelUpMessage': lvlMsg }
          });

          const preview = parseLevelMessage(lvlMsg, message.member, SAMPLE_STATS.newLevel, SAMPLE_STATS.oldLevel,
            SAMPLE_STATS.totalXp, SAMPLE_STATS.nextLevelXp);
          return message.reply({
            embeds: [await successEmbed(guildId, 'Level Up Message Set',
              `${GLYPHS.SUCCESS} Level up message has been updated.\n\n**Preview:**\n${clip(preview, 3500)}`)]
          });
        }

        case 'embed': {
          const embedOption = args[1]?.toLowerCase();

          if (!['on', 'off', 'enable', 'disable'].includes(embedOption)) {
            return message.reply({
              embeds: [await errorEmbed(guildId, 'Invalid Option',
                `Use \`${prefix}levelup embed on\` or \`${prefix}levelup embed off\`, Master.`)]
            });
          }

          const embedEnabled = ['on', 'enable'].includes(embedOption);
          await Guild.updateGuild(guildId, {
            $set: { 'features.levelSystem.embedEnabled': embedEnabled }
          });

          return message.reply({
            embeds: [await successEmbed(guildId, 'Embed Setting Updated',
              `${GLYPHS.SUCCESS} Level up embeds are now **${embedEnabled ? 'enabled' : 'disabled'}**.`)]
          });
        }

        case 'test':
          return await sendTestLevelUp(message, guildConfig, prefix);

        case 'image':
        case 'banner': {
          const imageUrl = args[1];

          if (!imageUrl) {
            const currentBanner = guildConfig.features?.levelSystem?.bannerUrl;
            return message.reply({
              embeds: [await infoEmbed(guildId, 'Level Up Banner',
                currentBanner
                  ? `**Current Banner:**\n${currentBanner}`
                  : `No banner set. Use \`${prefix}levelup image <url>\` to set one, or \`${prefix}levelup image remove\` to remove it.`)]
            });
          }

          if (imageUrl === 'remove' || imageUrl === 'none') {
            await Guild.updateGuild(guildId, {
              $set: { 'features.levelSystem.bannerUrl': null }
            });
            return message.reply({
              embeds: [await successEmbed(guildId, 'Banner Removed',
                `${GLYPHS.SUCCESS} Level up banner has been removed.`)]
            });
          }

          if (!isHttpUrl(imageUrl)) {
            return message.reply({
              embeds: [await errorEmbed(guildId, 'Invalid URL',
                'Please provide a valid image URL starting with http:// or https://, Master.')]
            });
          }

          await Guild.updateGuild(guildId, {
            $set: { 'features.levelSystem.bannerUrl': imageUrl }
          });

          return message.reply({
            embeds: [await successEmbed(guildId, 'Banner Set',
              `${GLYPHS.SUCCESS} Level up banner has been set.`)]
          });
        }

        case 'thumbnail':
        case 'thumb': {
          const thumbUrl = args[1];

          if (!thumbUrl) {
            return message.reply({
              embeds: [await infoEmbed(guildId, 'Level Up Thumbnail',
                `**Current:** ${describeThumbnail(guildConfig.features?.levelSystem)}\n\n` +
                `${GLYPHS.DOT} \`${prefix}levelup thumbnail <url>\` — Set a custom thumbnail\n` +
                `${GLYPHS.DOT} \`${prefix}levelup thumbnail avatar\` — Use the member's avatar\n` +
                `${GLYPHS.DOT} \`${prefix}levelup thumbnail server\` — Use the server icon\n` +
                `${GLYPHS.DOT} \`${prefix}levelup thumbnail remove\` — Show no thumbnail`)]
            });
          }

          if (thumbUrl === 'remove' || thumbUrl === 'none' || thumbUrl === 'off') {
            // thumbnailType null means "no thumbnail" (unset means the avatar default)
            await Guild.updateGuild(guildId, {
              $set: { 'features.levelSystem.thumbnailUrl': null, 'features.levelSystem.thumbnailType': null }
            });
            return message.reply({
              embeds: [await successEmbed(guildId, 'Thumbnail Removed',
                `${GLYPHS.SUCCESS} Level up announcements will show no thumbnail.`)]
            });
          }

          if (thumbUrl === 'avatar' || thumbUrl === 'user') {
            await Guild.updateGuild(guildId, {
              $set: { 'features.levelSystem.thumbnailType': 'avatar', 'features.levelSystem.thumbnailUrl': null }
            });
            return message.reply({
              embeds: [await successEmbed(guildId, 'Thumbnail Set',
                `${GLYPHS.SUCCESS} Thumbnail will show the member's avatar.`)]
            });
          }

          if (thumbUrl === 'server' || thumbUrl === 'guild') {
            await Guild.updateGuild(guildId, {
              $set: { 'features.levelSystem.thumbnailType': 'server', 'features.levelSystem.thumbnailUrl': null }
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
            $set: { 'features.levelSystem.thumbnailUrl': thumbUrl, 'features.levelSystem.thumbnailType': 'custom' }
          });

          return message.reply({
            embeds: [await successEmbed(guildId, 'Thumbnail Set',
              `${GLYPHS.SUCCESS} Level up thumbnail has been set.`)]
          });
        }

        case 'title': {
          const titleText = args.slice(1).join(' ');

          if (!titleText) {
            const current = guildConfig.features?.levelSystem?.embedTitle;
            return message.reply({
              embeds: [await infoEmbed(guildId, 'Embed Title',
                `**Current Title:** ${current === NONE ? 'None' : (current || `Default (${DEFAULT_LEVEL_UP_TITLE})`)}\n\n` +
                `${GLYPHS.DOT} \`${prefix}levelup title <text>\` — Set a custom title\n` +
                `${GLYPHS.DOT} \`${prefix}levelup title reset\` — Use the default\n` +
                `${GLYPHS.DOT} \`${prefix}levelup title none\` — Remove the title\n\n` +
                `**Variables:** every message variable works here, e.g. {username}, {level}`)]
            });
          }

          if (titleText === 'reset' || titleText === 'default') {
            await Guild.updateGuild(guildId, {
              $set: { 'features.levelSystem.embedTitle': null }
            });
            return message.reply({
              embeds: [await successEmbed(guildId, 'Title Reset',
                `${GLYPHS.SUCCESS} Level up embed title reset to default.`)]
            });
          }

          if (titleText === 'none' || titleText === 'remove') {
            await Guild.updateGuild(guildId, {
              $set: { 'features.levelSystem.embedTitle': NONE }
            });
            return message.reply({
              embeds: [await successEmbed(guildId, 'Title Removed',
                `${GLYPHS.SUCCESS} Level up embed title has been removed.`)]
            });
          }

          if (titleText.length > LIMITS.title) {
            return message.reply({
              embeds: [await errorEmbed(guildId, 'Title Too Long',
                `Embed titles are limited to ${LIMITS.title} characters, Master.`)]
            });
          }

          await Guild.updateGuild(guildId, {
            $set: { 'features.levelSystem.embedTitle': titleText }
          });

          return message.reply({
            embeds: [await successEmbed(guildId, 'Title Set',
              `${GLYPHS.SUCCESS} Level up embed title set to: ${titleText}`)]
          });
        }

        case 'footer': {
          const footerText = args.slice(1).join(' ');

          if (!footerText) {
            const current = guildConfig.features?.levelSystem?.footerText;
            return message.reply({
              embeds: [await infoEmbed(guildId, 'Embed Footer',
                `**Current Footer:** ${current === NONE ? 'None' : (current || 'Default (XP progress)')}\n\n` +
                `${GLYPHS.DOT} \`${prefix}levelup footer <text>\` — Set a custom footer\n` +
                `${GLYPHS.DOT} \`${prefix}levelup footer reset\` — Use the default\n` +
                `${GLYPHS.DOT} \`${prefix}levelup footer none\` — Remove the footer\n\n` +
                `**Variables:** every message variable works here, e.g. {xp}, {nextxp}, {level}`)]
            });
          }

          if (footerText === 'reset' || footerText === 'default') {
            await Guild.updateGuild(guildId, {
              $set: { 'features.levelSystem.footerText': null }
            });
            return message.reply({
              embeds: [await successEmbed(guildId, 'Footer Reset',
                `${GLYPHS.SUCCESS} Level up footer reset to default.`)]
            });
          }

          if (footerText === 'none' || footerText === 'remove') {
            await Guild.updateGuild(guildId, {
              $set: { 'features.levelSystem.footerText': NONE }
            });
            return message.reply({
              embeds: [await successEmbed(guildId, 'Footer Removed',
                `${GLYPHS.SUCCESS} Level up footer has been removed.`)]
            });
          }

          await Guild.updateGuild(guildId, {
            $set: { 'features.levelSystem.footerText': footerText }
          });

          return message.reply({
            embeds: [await successEmbed(guildId, 'Footer Set',
              `${GLYPHS.SUCCESS} Level up footer set to: ${footerText}`)]
          });
        }

        case 'color': {
          const colorHex = args[1];

          if (!colorHex) {
            return message.reply({
              embeds: [await infoEmbed(guildId, 'Embed Color',
                `**Current Color:** ${guildConfig.features?.levelSystem?.embedColor || DEFAULT_LEVEL_UP_COLOR}\n\n` +
                `${GLYPHS.DOT} \`${prefix}levelup color #HEX\` — Set a custom color\n` +
                `${GLYPHS.DOT} \`${prefix}levelup color reset\` — Use the default gold`)]
            });
          }

          if (colorHex === 'reset' || colorHex === 'default') {
            await Guild.updateGuild(guildId, {
              $set: { 'features.levelSystem.embedColor': DEFAULT_LEVEL_UP_COLOR }
            });
            return message.reply({
              embeds: [await successEmbed(guildId, 'Color Reset',
                `${GLYPHS.SUCCESS} Level up embed color reset to the default gold.`)]
            });
          }

          if (!/^#?[0-9A-Fa-f]{6}$/.test(colorHex)) {
            return message.reply({
              embeds: [await errorEmbed(guildId, 'Invalid Color',
                'Please provide a valid hex color code (e.g., #FFD700), Master.')]
            });
          }

          const normalizedColor = colorHex.startsWith('#') ? colorHex : `#${colorHex}`;
          await Guild.updateGuild(guildId, {
            $set: { 'features.levelSystem.embedColor': normalizedColor }
          });

          return message.reply({
            embeds: [await successEmbed(guildId, 'Color Set',
              `${GLYPHS.SUCCESS} Level up embed color set to: ${normalizedColor}`)]
          });
        }

        case 'mention': {
          const mentionOption = args[1]?.toLowerCase();

          if (!['on', 'off', 'enable', 'disable'].includes(mentionOption)) {
            return message.reply({
              embeds: [await errorEmbed(guildId, 'Invalid Option',
                `Use \`${prefix}levelup mention on\` or \`${prefix}levelup mention off\`, Master.`)]
            });
          }

          const mentionEnabled = ['on', 'enable'].includes(mentionOption);
          await Guild.updateGuild(guildId, {
            $set: { 'features.levelSystem.mentionUser': mentionEnabled }
          });

          return message.reply({
            embeds: [await successEmbed(guildId, 'Mention Setting Updated',
              `${GLYPHS.SUCCESS} Pinging the member in level up messages is now **${mentionEnabled ? 'enabled' : 'disabled'}**.`)]
          });
        }

        case 'progress': {
          const progressOption = args[1]?.toLowerCase();

          if (!['on', 'off', 'enable', 'disable'].includes(progressOption)) {
            return message.reply({
              embeds: [await errorEmbed(guildId, 'Invalid Option',
                `Use \`${prefix}levelup progress on\` or \`${prefix}levelup progress off\`, Master.`)]
            });
          }

          const showProgress = ['on', 'enable'].includes(progressOption);
          await Guild.updateGuild(guildId, {
            $set: { 'features.levelSystem.showProgress': showProgress }
          });

          return message.reply({
            embeds: [await successEmbed(guildId, 'Progress Setting Updated',
              `${GLYPHS.SUCCESS} XP progress bar is now **${showProgress ? 'enabled' : 'disabled'}**.`)]
          });
        }

        case 'preview':
          return await showPreview(message, guildConfig);

        case 'help':
          return await showHelp(message, prefix);

        default:
          return message.reply({
            embeds: [await errorEmbed(guildId, 'Unknown Option',
              `Unknown option: \`${clip(action, 50)}\`\n\nUse \`${prefix}levelup help\` for available commands, Master.`)]
          });
      }
    } catch (error) {
      console.error('[LevelUp] Error:', error);
      return message.reply({
        embeds: [await errorEmbed(guildId, 'Level Up Configuration Failed',
          'An anomaly occurred while updating the level up configuration, Master.')]
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
    '`{level}` — New level reached',
    '`{oldlevel}` — Previous level',
    '`{xp}` — Total XP',
    '`{nextxp}` — XP the next level requires',
    '`{server}` — Server name',
    '`\\n` — New line'
  ].map(line => `${GLYPHS.DOT} ${line}`).join('\n');
}

function describeThumbnail(level = {}) {
  if (level.thumbnailType === null) return 'None';
  if (level.thumbnailType === 'server') return 'Server icon';
  if (level.thumbnailUrl) return level.thumbnailUrl;
  return "Member's avatar (default)";
}

async function showStatus(message, guildConfig, prefix) {
  const level = guildConfig.features?.levelSystem || {};
  const channelId = level.levelUpChannel;
  const channel = channelId ? message.guild.channels.cache.get(channelId) : null;
  const channelText = channel
    ? `${channel}`
    : channelId ? 'Configured channel is missing; using the message channel' : 'Same channel as the message';

  const embed = await infoEmbed(message.guild.id, 'Level Up Announcements',
    level.enabled
      ? 'Current level up announcement configuration, Master.'
      : `${GLYPHS.WARNING} The leveling system is disabled, so no XP is earned and no announcements are sent, Master.`);

  embed.addFields(
    { name: '▸ Leveling', value: onOff(level.enabled, 'Enabled', 'Disabled'), inline: true },
    { name: '▸ Announcements', value: onOff(level.announceLevelUp !== false, 'Enabled', 'Disabled'), inline: true },
    { name: '▸ Channel', value: channelText, inline: true },
    { name: '▸ Embed', value: onOff(level.embedEnabled !== false), inline: true },
    { name: '▸ Mention', value: onOff(level.mentionUser !== false), inline: true },
    { name: '▸ Progress', value: onOff(level.showProgress !== false), inline: true },
    { name: '▸ Message', value: codeBlock(getLevelUpTemplate(level), LIMITS.field), inline: false },
    {
      name: '▸ Commands', value:
        `\`${prefix}levelup enable\` — Enable level up messages\n` +
        `\`${prefix}levelup disable\` — Disable level up messages\n` +
        `\`${prefix}levelup channel #channel\` — Set the announcement channel\n` +
        `\`${prefix}levelup message <text>\` — Set the level up message\n` +
        `\`${prefix}levelup test\` — Send a test message\n` +
        `\`${prefix}levelup help\` — Show all options`, inline: false
    }
  );

  return message.reply({ embeds: [embed] });
}

async function showHelp(message, prefix) {
  const embed = await infoEmbed(message.guild.id, 'Level Up Configuration',
    'All available commands for customizing level up announcements, Master.');

  embed.addFields(
    {
      name: '▸ Basic Setup', value:
        `\`${prefix}levelup enable\` — Enable announcements\n` +
        `\`${prefix}levelup disable\` — Disable announcements\n` +
        `\`${prefix}levelup channel #channel\` — Set the channel\n` +
        `\`${prefix}levelup channel current\` — Use the message channel\n` +
        `\`${prefix}levelup message <text>\` — Set the message`, inline: false
    },
    {
      name: '▸ Embed Customization', value:
        `\`${prefix}levelup embed on/off\` — Toggle embed mode\n` +
        `\`${prefix}levelup color #hex\` — Set the embed color\n` +
        `\`${prefix}levelup title <text>\` — Set the embed title\n` +
        `\`${prefix}levelup footer <text>\` — Set the embed footer\n` +
        `\`${prefix}levelup image <url>\` — Set a banner image\n` +
        `\`${prefix}levelup thumbnail <type>\` — Set the thumbnail`, inline: false
    },
    {
      name: '▸ Display Options', value:
        `\`${prefix}levelup mention on/off\` — Toggle the member ping\n` +
        `\`${prefix}levelup progress on/off\` — Toggle the XP progress bar`, inline: false
    },
    {
      name: '▸ Preview & Test', value:
        `\`${prefix}levelup test\` — Send a test to the announcement channel\n` +
        `\`${prefix}levelup preview\` — Preview here`, inline: false
    },
    { name: '▸ Variables', value: variablesList(), inline: false }
  );

  return message.reply({ embeds: [embed] });
}

async function showPreview(message, guildConfig) {
  await message.reply({
    embeds: [await infoEmbed(message.guild.id, 'Level Up Preview',
      'This is how your level up announcement will look, Master:')]
  });

  // Same payload as a real announcement, without pinging anyone
  const payload = buildLevelUpMessage(message.member, guildConfig, SAMPLE_STATS, { silent: true });
  await message.channel.send(payload);
}

async function sendTestLevelUp(message, guildConfig, prefix) {
  const level = guildConfig.features?.levelSystem || {};
  const channel = level.levelUpChannel ? message.guild.channels.cache.get(level.levelUpChannel) : message.channel;

  if (!channel) {
    return message.reply({
      embeds: [await errorEmbed(message.guild.id, 'No Channel',
        `The level up channel no longer exists. Use \`${prefix}levelup channel #channel\` to set one, Master.`)]
    });
  }

  if (!canAnnounceIn(channel, message.guild, level.embedEnabled !== false)) {
    return message.reply({
      embeds: [await errorEmbed(message.guild.id, 'Missing Permissions',
        `I cannot send ${level.embedEnabled !== false ? 'embeds ' : 'messages '}in ${channel}, Master.`)]
    });
  }

  await channel.send(buildLevelUpMessage(message.member, guildConfig, SAMPLE_STATS));

  return message.reply({
    embeds: [await successEmbed(message.guild.id, 'Test Sent',
      `${GLYPHS.SUCCESS} Test level up message sent to ${channel}.`)]
  });
}

// ==================== SHARED HELPERS (used by the XP announcers) ====================

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

function formatNumber(value) {
  return Number(value ?? 0).toLocaleString();
}

// Accepts a GuildMember or a User (admin awards may only have the User)
function resolveUser(member) {
  return member?.user ?? member;
}

/** The configured level up message, with the old emoji default treated as the current default. */
export function getLevelUpTemplate(level) {
  const msg = level?.levelUpMessage;
  return !msg || !msg.trim() || LEGACY_LEVEL_UP_MESSAGES.has(msg) ? DEFAULT_LEVEL_UP_MESSAGE : msg;
}

/**
 * Replace every documented placeholder in one pass, so a username containing "{level}"
 * is not substituted again. `{totalxp}` is kept as an alias of `{xp}` for older messages.
 * `context.guild` is needed when `member` is a User rather than a GuildMember.
 */
export function parseLevelMessage(msg, member, newLevel, oldLevel, totalXp, nextLevelXp, context = {}) {
  const user = resolveUser(member);
  const guild = member?.guild ?? context.guild;
  const values = {
    user: user?.id ? `<@${user.id}>` : '',
    username: user?.username ?? 'Unknown',
    displayname: member?.displayName ?? user?.globalName ?? user?.username ?? 'Unknown',
    level: String(newLevel ?? 0),
    oldlevel: String(oldLevel ?? Math.max(0, Number(newLevel ?? 1) - 1)),
    xp: formatNumber(totalXp),
    totalxp: formatNumber(totalXp),
    nextxp: formatNumber(nextLevelXp),
    server: guild?.name ?? ''
  };

  return String(msg ?? '')
    .replace(PLACEHOLDERS, (_, key) => values[key.toLowerCase()])
    .replace(/\\n/g, '\n');
}

function resolveThumbnail(level, user, guild) {
  // null is what `levelup thumbnail remove` stores; an unset type keeps the avatar default
  if (level.thumbnailType === null || level.thumbnailType === 'none') return null;
  if (level.thumbnailType === 'server') return guild?.iconURL({ size: 256 }) ?? null;
  if (level.thumbnailUrl) return level.thumbnailUrl;
  return user?.displayAvatarURL?.({ size: 256 }) ?? null;
}

function createProgressBar(percent, length = 10) {
  const filled = Math.round((percent / 100) * length);
  return '█'.repeat(filled) + '░'.repeat(length - filled);
}

/**
 * Build the level up embed from the guild's settings.
 * options.currentXp: XP into the current level, for the progress bar (defaults to totalXp)
 * options.guild: needed when `member` is a User
 * options.fields: extra fields appended after the progress bar
 */
export function buildLevelUpEmbed(member, level = {}, guildConfig, newLevel, oldLevel, totalXp, nextLevelXp, options = {}) {
  const settings = level || {};
  const user = resolveUser(member);
  const guild = member?.guild ?? options.guild;
  const parse = text => parseLevelMessage(text, member, newLevel, oldLevel, totalXp, nextLevelXp, { guild });
  const currentXp = options.currentXp ?? totalXp;

  const embed = new EmbedBuilder().setColor(safeColor(settings.embedColor, DEFAULT_LEVEL_UP_COLOR));

  if (user?.username) {
    embed.setAuthor({
      name: clip(user.username, LIMITS.author),
      iconURL: user.displayAvatarURL?.({ size: 128 }) ?? undefined
    });
  }

  if (settings.embedTitle !== NONE) {
    const title = settings.embedTitle && settings.embedTitle.trim() ? parse(settings.embedTitle) : DEFAULT_LEVEL_UP_TITLE;
    if (title.trim()) embed.setTitle(clip(title, LIMITS.title));
  }

  const description = parse(getLevelUpTemplate(settings));
  if (description.trim()) embed.setDescription(clip(description, LIMITS.description));

  const thumbnail = resolveThumbnail(settings, user, guild);
  if (thumbnail && isHttpUrl(thumbnail)) embed.setThumbnail(thumbnail);

  if (settings.showProgress !== false && nextLevelXp > 0) {
    const percent = Math.min(100, Math.max(0, Math.round((currentXp / nextLevelXp) * 100)));
    embed.addFields({ name: '▸ Progress to Next Level', value: `${createProgressBar(percent)} ${percent}%`, inline: false });
  }

  if (options.fields?.length) {
    embed.addFields(options.fields.slice(0, 24).map(field => ({
      ...field,
      name: clip(field.name, 256),
      value: clip(field.value, LIMITS.field)
    })));
  }

  if (settings.footerText !== NONE) {
    const footer = settings.footerText && settings.footerText.trim()
      ? parse(settings.footerText)
      : `${formatNumber(currentXp)} / ${formatNumber(nextLevelXp)} XP`;
    if (footer.trim()) embed.setFooter({ text: clip(footer, LIMITS.footer) });
  }

  if (settings.showTimestamp !== false) embed.setTimestamp();

  if (settings.bannerUrl && isHttpUrl(settings.bannerUrl)) embed.setImage(settings.bannerUrl);

  return embed;
}

/**
 * Message options for a level up announcement, honouring the embed and mention settings.
 * stats: { newLevel, oldLevel, totalXp, currentXp, nextLevelXp }
 * options: { guild, fields, note, silent } (silent: render the mention without pinging)
 */
export function buildLevelUpMessage(member, guildConfig, stats = {}, options = {}) {
  const level = guildConfig?.features?.levelSystem || {};
  const user = resolveUser(member);
  const guild = member?.guild ?? options.guild;
  const { newLevel, oldLevel, totalXp, currentXp, nextLevelXp } = stats;
  const mention = level.mentionUser !== false && user?.id;
  const userMention = user?.id ? `<@${user.id}>` : '';
  const allowedMentions = mention && !options.silent ? { users: [user.id] } : { parse: [] };

  if (level.embedEnabled !== false) {
    const embed = buildLevelUpEmbed(member, level, guildConfig, newLevel, oldLevel, totalXp, nextLevelXp,
      { currentXp, guild, fields: options.fields });
    return { content: mention ? userMention : undefined, embeds: [embed], allowedMentions };
  }

  let text = parseLevelMessage(getLevelUpTemplate(level), member, newLevel, oldLevel, totalXp, nextLevelXp, { guild });
  if (mention && !text.includes(userMention)) text = `${userMention} ${text}`;
  if (options.note) text += `\n${options.note}`;
  return { content: clip(text, LIMITS.content), allowedMentions };
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
 * Where a level up is announced: the configured level up channel, else `fallbackChannel`
 * (the channel the member chatted in), else the legacy channels.levelUpChannel.
 */
export function resolveLevelUpChannel(guild, guildConfig, fallbackChannel = null) {
  const configuredId = guildConfig?.features?.levelSystem?.levelUpChannel;
  const configured = configuredId ? guild.channels.cache.get(configuredId) : null;
  if (configured) return configured;
  if (fallbackChannel) return fallbackChannel;
  const legacyId = guildConfig?.channels?.levelUpChannel;
  return (legacyId && guild.channels.cache.get(legacyId)) || null;
}

/**
 * Announce a level up with the guild's level up settings. Never throws.
 * levelData: the saved Level document (level, xp, totalXP, xpForNextLevel()).
 * Returns true when a message was sent.
 */
export async function sendLevelUpAnnouncement({
  guild, member, guildConfig, levelData, levelsGained, oldLevel, fallbackChannel = null, fields, note
}) {
  try {
    const level = guildConfig?.features?.levelSystem || {};
    if (level.announceLevelUp === false || !levelsGained?.length || !member) return false;

    const channel = resolveLevelUpChannel(guild, guildConfig, fallbackChannel);
    if (!channel || !canAnnounceIn(channel, guild, level.embedEnabled !== false)) return false;

    const newLevel = Math.max(...levelsGained);
    const stats = {
      newLevel,
      oldLevel: oldLevel ?? Math.max(0, newLevel - levelsGained.length),
      totalXp: levelData?.totalXP ?? 0,
      currentXp: levelData?.xp ?? 0,
      nextLevelXp: typeof levelData?.xpForNextLevel === 'function' ? levelData.xpForNextLevel() : 0
    };

    await channel.send(buildLevelUpMessage(member, guildConfig, stats, { guild, fields, note }));
    return true;
  } catch (error) {
    console.error('[LevelUp] Failed to announce level up:', error);
    return false;
  }
}
