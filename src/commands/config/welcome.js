import { PermissionFlagsBits, EmbedBuilder, ChannelType } from 'discord.js';
import Guild from '../../models/Guild.js';
import { successEmbed, errorEmbed, infoEmbed, GLYPHS, COLORS } from '../../utils/embeds.js';
import { hasModPerms, getAssignableRoleError, getPrefix } from '../../utils/helpers.js';
import { getRandomFooter } from '../../utils/raphael.js';

const DEFAULT_WELCOME_MESSAGE = 'Welcome {user} to {server}!';
const DEFAULT_WELCOME_TITLE = '『 Welcome to {server} 』';
const DEFAULT_GREETING = 'welcome, {user}!';
const DEFAULT_WELCOME_COLOR = '#5865F2';

// Discord message and embed limits
const LIMITS = { title: 256, description: 4096, footer: 2048, author: 256, content: 2000 };

const TOGGLE_VALUES = new Map([
  ['on', true], ['enable', true], ['true', true], ['yes', true],
  ['off', false], ['disable', false], ['false', false], ['no', false]
]);

export default {
  name: 'welcome',
  category: 'config',
  description: 'Configure new member greeting protocols, Master',
  usage: '<status|enable|disable|channel|message|embed|dm|test|help|...>',
  aliases: ['welcomemsg', 'greet'],
  permissions: [PermissionFlagsBits.ManageGuild],
  cooldown: 3,

  async execute(message, args) {
    try {
      return await runWelcomeCommand(message, args);
    } catch (error) {
      console.error('[Welcome] Error:', error);
      return message.reply({
        embeds: [await errorEmbed(message.guild.id, 'Welcome Configuration Error',
          'An anomaly occurred while processing this request, Master. Please try again.')]
      }).catch(() => { });
    }
  }
};

async function runWelcomeCommand(message, args) {
  const guildConfig = await Guild.getGuild(message.guild.id, message.guild.name);
  const prefix = await getPrefix(message.guild.id);
  const welcome = guildConfig.features?.welcomeSystem || {};

  // Check for moderator permissions (admin, mod role, or ManageGuild)
  if (!hasModPerms(message.member, guildConfig)) {
    return replyError(message, 'Permission Denied',
      `${GLYPHS.LOCK} You need Moderator/Staff permissions to configure welcome messages, Master.`);
  }

  if (!args[0]) {
    return showStatus(message, guildConfig, prefix);
  }

  const action = args[0].toLowerCase();

  switch (action) {
    case 'status':
      return showStatus(message, guildConfig, prefix);

    case 'enable':
    case 'on': {
      await updateWelcome(message, { enabled: true });
      const channelId = getWelcomeChannelId(guildConfig);
      const needsChannel = !(channelId && message.guild.channels.cache.has(channelId));
      return replySuccess(message, 'Welcome System Enabled',
        `${GLYPHS.SUCCESS} Welcome messages are now enabled.` +
        (needsChannel ? `\n\nNo usable welcome channel is set. Use \`${prefix}welcome channel #channel\` to set one.` : ''));
    }

    case 'disable':
    case 'off':
      await updateWelcome(message, { enabled: false });
      return replySuccess(message, 'Welcome System Disabled', `${GLYPHS.SUCCESS} Welcome messages are now disabled.`);

    case 'channel': {
      const channel = message.mentions.channels.first() ||
        message.guild.channels.cache.get(args[1]);

      if (!channel) {
        return replyError(message, 'No Channel',
          `Please mention a channel or provide a channel ID, Master.\n\n` +
          `**Current Channel:** ${describeChannel(message.guild, getWelcomeChannelId(guildConfig))}\n` +
          `**Usage:** \`${prefix}welcome channel #channel\``);
      }

      if (channel.type !== ChannelType.GuildText) {
        return replyError(message, 'Invalid Channel', 'Please select a text channel, Master.');
      }

      await Guild.updateGuild(message.guild.id, {
        $set: {
          'features.welcomeSystem.channel': channel.id,
          'channels.welcomeChannel': channel.id
        }
      });

      return replySuccess(message, 'Welcome Channel Set', `${GLYPHS.SUCCESS} Welcome messages will be sent to ${channel}.`);
    }

    case 'message':
    case 'msg':
    case 'description':
    case 'desc': {
      const welcomeMsg = args.slice(1).join(' ');

      if (!welcomeMsg) {
        return replyInfo(message, 'Welcome Message Variables',
          `**Current Message:**\n${clampText(welcome.message || DEFAULT_WELCOME_MESSAGE, 1000)}\n\n` +
          `**Available Variables:**\n` +
          `${GLYPHS.DOT} \`{user}\` - Mentions the user\n` +
          `${GLYPHS.DOT} \`{username}\` - User's username\n` +
          `${GLYPHS.DOT} \`{displayname}\` - User's display name\n` +
          `${GLYPHS.DOT} \`{tag}\` - User's tag\n` +
          `${GLYPHS.DOT} \`{id}\` - User's ID\n` +
          `${GLYPHS.DOT} \`{server}\` - Server name\n` +
          `${GLYPHS.DOT} \`{membercount}\` - Total member count\n` +
          `${GLYPHS.DOT} \`{usercreated}\` - Account creation date\n` +
          `${GLYPHS.DOT} \`{avatar}\` - User's avatar URL\n` +
          `${GLYPHS.DOT} \`\\n\` - New line\n\n` +
          `**Example:**\n\`${prefix}welcome message Welcome to {server}, {user}!\\nPlease read the rules.\``);
      }

      if (welcomeMsg.length > LIMITS.description) {
        return replyError(message, 'Message Too Long',
          `The welcome message can be at most ${LIMITS.description} characters, Master (yours is ${welcomeMsg.length}).`);
      }

      await updateWelcome(message, { message: welcomeMsg });

      return replySuccess(message, 'Welcome Message Set',
        `${GLYPHS.SUCCESS} Welcome message has been updated.\n\n` +
        `**Preview:**\n${clampText(parseWelcomeMessage(welcomeMsg, message.member), 1500)}`);
    }

    case 'embed':
      return setToggle(message, args[1], prefix, 'embed', 'embedEnabled',
        on => `Welcome embeds are now **${on ? 'enabled' : 'disabled'}**.`);

    case 'dm':
      return setToggle(message, args[1], prefix, 'dm', 'dmWelcome',
        on => `DM welcome messages are now **${on ? 'enabled' : 'disabled'}**.`);

    case 'mention':
    case 'ping':
      return setToggle(message, args[1], prefix, 'mention', 'mentionUser',
        on => `The greeting above the embed is now **${on ? 'enabled' : 'disabled'}**.`,
        `When enabled, the greeting text (default "welcome, @user!") is sent above the embed.`);

    case 'timestamp':
      return setToggle(message, args[1], prefix, 'timestamp', 'showTimestamp',
        on => `The timestamp is now **${on ? 'enabled' : 'disabled'}**.`);

    case 'test':
      return sendTestWelcome(message, guildConfig, prefix);

    case 'image':
    case 'banner': {
      const imageUrl = args[1];

      if (!imageUrl) {
        return replyInfo(message, 'Welcome Banner',
          welcome.bannerUrl
            ? `**Current Banner:**\n${welcome.bannerUrl}\n\nUse \`${prefix}welcome image remove\` to remove it.`
            : `No banner set. Use \`${prefix}welcome image <url>\` to set one, or \`${prefix}welcome image remove\` to remove.`);
      }

      if (isKeyword(imageUrl, ['remove', 'none'])) {
        await updateWelcome(message, { bannerUrl: null });
        return replySuccess(message, 'Banner Removed', `${GLYPHS.SUCCESS} Welcome banner has been removed.`);
      }

      if (!isHttpUrl(imageUrl)) {
        return replyError(message, 'Invalid URL',
          'Please provide a valid image URL starting with http:// or https://, Master.');
      }

      await updateWelcome(message, { bannerUrl: imageUrl });
      return replySuccess(message, 'Banner Set', `${GLYPHS.SUCCESS} Welcome banner has been set.`);
    }

    case 'thumbnail':
    case 'thumb': {
      const thumbUrl = args[1];

      if (!thumbUrl) {
        return replyInfo(message, 'Welcome Thumbnail',
          `**Current Thumbnail:** ${describeThumbnail(welcome)}` +
          (welcome.thumbnailUrl ? `\n${welcome.thumbnailUrl}` : '') + '\n\n' +
          `\`${prefix}welcome thumbnail <url>\` - Set custom thumbnail\n` +
          `\`${prefix}welcome thumbnail avatar\` - Use user's avatar\n` +
          `\`${prefix}welcome thumbnail server\` - Use server icon\n` +
          `\`${prefix}welcome thumbnail remove\` - Remove thumbnail`);
      }

      if (isKeyword(thumbUrl, ['remove', 'none', 'off'])) {
        await updateWelcome(message, { thumbnailUrl: null, thumbnailType: null });
        return replySuccess(message, 'Thumbnail Removed', `${GLYPHS.SUCCESS} Welcome thumbnail has been removed.`);
      }

      if (isKeyword(thumbUrl, ['avatar', 'user'])) {
        await updateWelcome(message, { thumbnailType: 'avatar', thumbnailUrl: null });
        return replySuccess(message, 'Thumbnail Set', `${GLYPHS.SUCCESS} Thumbnail will show the user's avatar.`);
      }

      if (isKeyword(thumbUrl, ['server', 'guild'])) {
        await updateWelcome(message, { thumbnailType: 'server', thumbnailUrl: null });
        return replySuccess(message, 'Thumbnail Set', `${GLYPHS.SUCCESS} Thumbnail will show the server icon.`);
      }

      if (!isHttpUrl(thumbUrl)) {
        return replyError(message, 'Invalid URL',
          'Please provide a valid URL, or use `avatar`, `server`, or `remove`, Master.');
      }

      await updateWelcome(message, { thumbnailUrl: thumbUrl, thumbnailType: 'custom' });
      return replySuccess(message, 'Thumbnail Set', `${GLYPHS.SUCCESS} Welcome thumbnail has been set.`);
    }

    case 'title': {
      const titleText = args.slice(1).join(' ');

      if (!titleText) {
        return replyInfo(message, 'Embed Title',
          `**Current Title:** ${welcome.embedTitle?.trim() ? welcome.embedTitle : describeTemplate(welcome.embedTitle)}\n\n` +
          `Use \`${prefix}welcome title <text>\` to set a custom title.\n` +
          `Use \`${prefix}welcome title reset\` for the default title.\n` +
          `Use \`${prefix}welcome title none\` to remove the title entirely.\n\n` +
          `**Variables:** {username}, {server}, {membercount}`);
      }

      if (isKeyword(titleText, ['reset', 'default'])) {
        await updateWelcome(message, { embedTitle: null });
        return replySuccess(message, 'Title Reset', `${GLYPHS.SUCCESS} Welcome embed title reset to the default.`);
      }

      if (isKeyword(titleText, ['none', 'remove'])) {
        await updateWelcome(message, { embedTitle: ' ' });
        return replySuccess(message, 'Title Removed', `${GLYPHS.SUCCESS} Welcome embed title has been removed.`);
      }

      if (titleText.length > LIMITS.title) {
        return replyError(message, 'Title Too Long',
          `Embed titles can be at most ${LIMITS.title} characters, Master (yours is ${titleText.length}).`);
      }

      await updateWelcome(message, { embedTitle: titleText });
      return replySuccess(message, 'Title Set', `${GLYPHS.SUCCESS} Welcome embed title set to:\n${titleText}`);
    }

    case 'color':
    case 'colour': {
      const colorValue = args[1];

      if (!colorValue) {
        return replyInfo(message, 'Embed Color',
          `**Current Color:** ${welcome.embedColor || 'Default'}\n\n` +
          `Use \`${prefix}welcome color #HEX\` to set (e.g., \`${prefix}welcome color #5432A6\`)\n` +
          `Use \`${prefix}welcome color reset\` for the default color.`);
      }

      if (isKeyword(colorValue, ['reset', 'default'])) {
        await updateWelcome(message, { embedColor: null });
        return replySuccess(message, 'Color Reset', `${GLYPHS.SUCCESS} Welcome embed color reset to the default.`);
      }

      const match = colorValue.match(/^#?([0-9a-f]{6})$/i);
      if (!match) {
        return replyError(message, 'Invalid Color', 'Please provide a six-digit hex color (e.g., `#5432A6`), Master.');
      }

      const hex = `#${match[1]}`;
      await updateWelcome(message, { embedColor: hex });
      return replySuccess(message, 'Color Set', `${GLYPHS.SUCCESS} Welcome embed color set to \`${hex}\``);
    }

    case 'greet':
    case 'greeting':
    case 'content': {
      const greetText = args.slice(1).join(' ');

      if (!greetText) {
        return replyInfo(message, 'Greeting Text',
          `**Current Greeting:**\n${clampText(welcome.greetingText || DEFAULT_GREETING, 500)}\n\n` +
          `This is the text shown above the embed when mention is enabled.\n\n` +
          `Use \`${prefix}welcome greet <text>\` to customize.\n` +
          `Use \`${prefix}welcome greet reset\` for the default.\n\n` +
          `**Variables:** {user}, {username}, {server}`);
      }

      if (isKeyword(greetText, ['reset', 'default'])) {
        await updateWelcome(message, { greetingText: null });
        return replySuccess(message, 'Greeting Reset', `${GLYPHS.SUCCESS} Greeting text reset to "welcome, @user!"`);
      }

      if (greetText.length > LIMITS.content) {
        return replyError(message, 'Greeting Too Long',
          `The greeting can be at most ${LIMITS.content} characters, Master (yours is ${greetText.length}).`);
      }

      await updateWelcome(message, { greetingText: greetText });
      return replySuccess(message, 'Greeting Set',
        `${GLYPHS.SUCCESS} Greeting text set to:\n${clampText(greetText.replace(/{user}/gi, () => `${message.author}`), 1500)}`);
    }

    case 'footer': {
      const footerText = args.slice(1).join(' ');

      if (!footerText) {
        return replyInfo(message, 'Footer Text',
          `**Current Footer:** ${welcome.footerText?.trim() ? welcome.footerText : (welcome.footerText === ' ' ? 'Hidden' : 'Member #{membercount} (default)')}\n\n` +
          `Use \`${prefix}welcome footer <text>\` to customize.\n` +
          `Use \`${prefix}welcome footer reset\` for the default.\n` +
          `Use \`${prefix}welcome footer none\` to remove the footer.\n\n` +
          `**Variables:** {username}, {server}, {membercount}`);
      }

      if (isKeyword(footerText, ['reset', 'default'])) {
        await updateWelcome(message, { footerText: null });
        return replySuccess(message, 'Footer Reset', `${GLYPHS.SUCCESS} Footer text reset to the default.`);
      }

      if (isKeyword(footerText, ['none', 'remove'])) {
        await updateWelcome(message, { footerText: ' ' });
        return replySuccess(message, 'Footer Removed', `${GLYPHS.SUCCESS} Footer has been removed.`);
      }

      if (footerText.length > LIMITS.footer) {
        return replyError(message, 'Footer Too Long',
          `Embed footers can be at most ${LIMITS.footer} characters, Master (yours is ${footerText.length}).`);
      }

      await updateWelcome(message, { footerText });
      return replySuccess(message, 'Footer Set', `${GLYPHS.SUCCESS} Footer text set to: ${footerText}`);
    }

    case 'author': {
      const authorOption = args[1]?.toLowerCase();

      if (!authorOption) {
        return replyInfo(message, 'Author Settings',
          `**Current:** ${welcome.authorType || 'username (with avatar)'}\n\n` +
          `\`${prefix}welcome author username\` - Show username with avatar\n` +
          `\`${prefix}welcome author displayname\` - Show display name with avatar\n` +
          `\`${prefix}welcome author server\` - Show server name with icon\n` +
          `\`${prefix}welcome author none\` - No author section`);
      }

      const authorTypes = {
        username: 'username',
        displayname: 'displayname',
        display: 'displayname',
        server: 'server',
        guild: 'server',
        none: 'none',
        remove: 'none'
      };
      const authorType = Object.hasOwn(authorTypes, authorOption) ? authorTypes[authorOption] : null;

      if (!authorType) {
        return replyError(message, 'Invalid Option', 'Valid options: `username`, `displayname`, `server`, `none`');
      }

      await updateWelcome(message, { authorType });
      return replySuccess(message, 'Author Setting Updated', `${GLYPHS.SUCCESS} Author section set to: **${authorType}**`);
    }

    case 'autorole':
    case 'role': {
      const roleArg = args[1];

      if (!roleArg) {
        const currentRole = welcome.autoRole ? message.guild.roles.cache.get(welcome.autoRole) : null;
        return replyInfo(message, 'Welcome Auto Role',
          `**Current Role:** ${currentRole || (welcome.autoRole ? 'Role no longer exists' : 'None')}\n\n` +
          `Use \`${prefix}welcome role @role\` to set a role given on join.\n` +
          `Use \`${prefix}welcome role remove\` to disable.`);
      }

      if (isKeyword(roleArg, ['remove', 'none'])) {
        await updateWelcome(message, { autoRole: null });
        return replySuccess(message, 'Auto Role Removed', `${GLYPHS.SUCCESS} Welcome auto role has been disabled.`);
      }

      const role = message.mentions.roles.first() || message.guild.roles.cache.get(roleArg);
      if (!role) {
        return replyError(message, 'Role Not Found', 'Please mention a role or provide a valid role ID, Master.');
      }

      const roleError = getAssignableRoleError(role, message.member);
      if (roleError) {
        return replyError(message, 'Role Not Allowed', roleError);
      }

      await updateWelcome(message, { autoRole: role.id });
      return replySuccess(message, 'Auto Role Set', `${GLYPHS.SUCCESS} New members will receive ${role}.`);
    }

    case 'preview':
      return showPreview(message, guildConfig);

    case 'reset':
      await updateWelcome(message, {
        enabled: false,
        channel: null,
        message: null,
        embedEnabled: true,
        dmWelcome: false,
        bannerUrl: null,
        thumbnailUrl: null,
        thumbnailType: null,
        embedTitle: null,
        embedColor: null,
        mentionUser: false,
        greetingText: null,
        footerText: null,
        authorType: 'username',
        showTimestamp: true,
        autoRole: null
      });
      return replySuccess(message, 'Welcome System Reset', `${GLYPHS.SUCCESS} All welcome settings have been reset to defaults.`);

    case 'help':
      return showHelp(message, prefix);

    default:
      return replyError(message, 'Unknown Option',
        `Unknown option: \`${action}\`\n\nUse \`${prefix}welcome help\` for available commands, Master.`);
  }
}

// ============================================
// Helpers
// ============================================

async function replySuccess(message, title, description) {
  return message.reply({ embeds: [await successEmbed(message.guild.id, title, description)] });
}

async function replyError(message, title, description) {
  return message.reply({ embeds: [await errorEmbed(message.guild.id, title, description)] });
}

async function replyInfo(message, title, description) {
  return message.reply({ embeds: [await infoEmbed(message.guild.id, title, description)] });
}

// Writes the given welcomeSystem fields with dotted paths so other fields are kept
function updateWelcome(message, fields) {
  const $set = {};
  for (const [key, value] of Object.entries(fields)) {
    $set[`features.welcomeSystem.${key}`] = value;
  }
  return Guild.updateGuild(message.guild.id, { $set });
}

async function setToggle(message, value, prefix, command, field, describe, note = '') {
  const enabled = parseToggle(value);

  if (enabled === null) {
    return replyError(message, 'Invalid Option',
      `Use \`${prefix}welcome ${command} on\` or \`${prefix}welcome ${command} off\`, Master.` +
      (note ? `\n\n${note}` : ''));
  }

  await updateWelcome(message, { [field]: enabled });
  return replySuccess(message, 'Setting Updated', `${GLYPHS.SUCCESS} ${describe(enabled)}`);
}

function parseToggle(value) {
  const key = String(value ?? '').toLowerCase();
  return TOGGLE_VALUES.has(key) ? TOGGLE_VALUES.get(key) : null;
}

function isKeyword(value, keywords) {
  return keywords.includes(String(value ?? '').toLowerCase());
}

function isHttpUrl(value) {
  return /^https?:\/\/\S+$/i.test(value ?? '');
}

function clampText(text, max) {
  const value = String(text ?? '');
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

// Same channel the join handler uses
function getWelcomeChannelId(guildConfig) {
  return guildConfig.features?.welcomeSystem?.channel || guildConfig.channels?.welcomeChannel || null;
}

function describeChannel(guild, channelId) {
  if (!channelId) return 'Not configured';
  const channel = guild.channels.cache.get(channelId);
  return channel ? `${channel}` : `${GLYPHS.ERROR} No longer exists (\`${channelId}\`)`;
}

// A single space means the value was removed ("title none")
function describeTemplate(value) {
  if (value === ' ') return 'Hidden';
  return value?.trim() ? 'Custom' : 'Default';
}

// Mirrors the thumbnail logic in buildWelcomeEmbed
function describeThumbnail(welcome) {
  if (welcome.thumbnailType === 'avatar') return 'User avatar';
  if (welcome.thumbnailType === 'server') return 'Server icon';
  if (welcome.thumbnailUrl) return 'Custom image';
  return 'None';
}

function cannotSendIn(channel, me) {
  return !channel.permissionsFor(me)?.has([
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.EmbedLinks
  ]);
}

function toPayload({ embed, content }) {
  return embed ? { content, embeds: [embed] } : { content };
}

// ============================================
// Views
// ============================================

async function showStatus(message, guildConfig, prefix) {
  const welcome = guildConfig.features?.welcomeSystem || {};
  const autoRole = welcome.autoRole ? message.guild.roles.cache.get(welcome.autoRole) : null;
  const flag = on => (on ? '◉ On' : '◇ Off');

  const embed = new EmbedBuilder()
    .setColor(COLORS.RAPHAEL)
    .setTitle('『 Welcome System Status 』')
    .setDescription(`**Analysis:** Current welcome configuration, Master.\nUse \`${prefix}welcome help\` for all commands.`)
    .addFields(
      {
        name: '▸ Delivery',
        value: [
          `Status: ${welcome.enabled ? '◉ Active' : '◇ Inactive'}`,
          `Channel: ${describeChannel(message.guild, getWelcomeChannelId(guildConfig))}`,
          `Embed mode: ${flag(welcome.embedEnabled !== false)}`,
          `DM welcome: ${flag(welcome.dmWelcome)}`,
          `Mention user: ${flag(welcome.mentionUser)}`,
          `Auto role: ${autoRole || (welcome.autoRole ? 'Role no longer exists' : 'None')}`
        ].join('\n'),
        inline: true
      },
      {
        name: '▸ Appearance',
        value: [
          `Color: ${welcome.embedColor || 'Default'}`,
          `Title: ${describeTemplate(welcome.embedTitle)}`,
          `Footer: ${describeTemplate(welcome.footerText)}`,
          `Author: ${welcome.authorType || 'username'}`,
          `Thumbnail: ${describeThumbnail(welcome)}`,
          `Banner: ${welcome.bannerUrl ? 'Set' : 'Not set'}`,
          `Timestamp: ${flag(welcome.showTimestamp !== false)}`
        ].join('\n'),
        inline: true
      },
      {
        name: '▸ Current Message',
        value: `\`\`\`${clampText(welcome.message || DEFAULT_WELCOME_MESSAGE, 300).replace(/```/g, "'''")}\`\`\``
      }
    )
    .setFooter({ text: getRandomFooter() });

  return message.reply({ embeds: [embed] });
}

async function showHelp(message, prefix) {
  const p = `${prefix}welcome`;
  const embed = new EmbedBuilder()
    .setColor(COLORS.RAPHAEL)
    .setTitle('『 Welcome Commands 』')
    .setDescription('**Analysis:** Commands for greeting new members, Master.')
    .addFields(
      {
        name: '▸ Basic',
        value: [
          `\`${p} enable\` / \`${p} disable\` - Toggle system`,
          `\`${p} channel #channel\` - Set welcome channel`,
          `\`${p} test\` / \`${p} preview\` - Try the message`,
          `\`${p} reset\` - Reset all settings`
        ].join('\n')
      },
      {
        name: '▸ Content',
        value: [
          `\`${p} message <text>\` - Embed description`,
          `\`${p} greet <text>\` - Text above embed`,
          `\`${p} title <text>\` / \`${p} footer <text>\``
        ].join('\n')
      },
      {
        name: '▸ Appearance',
        value: [
          `\`${p} color #HEX\` / \`${p} image <url>\``,
          `\`${p} thumbnail <url|avatar|server|remove>\``,
          `\`${p} author <username|displayname|server|none>\``
        ].join('\n')
      },
      {
        name: '▸ Toggles',
        value: [
          `\`${p} embed|mention|dm|timestamp on/off\``,
          `\`${p} role @role\` - Role given on join`
        ].join('\n')
      },
      {
        name: '▸ Variables',
        value: '`{user}` `{username}` `{displayname}` `{tag}` `{id}` `{server}` ' +
          '`{membercount}` `{usercreated}` `{avatar}` `\\n` (new line)'
      }
    )
    .setFooter({ text: getRandomFooter() });

  return message.reply({ embeds: [embed] });
}

async function showPreview(message, guildConfig) {
  const welcome = guildConfig.features?.welcomeSystem || {};
  const payload = toPayload(buildWelcomeEmbed(message.member, welcome, guildConfig));

  await replyInfo(message, 'Welcome Preview', 'Here is how your welcome message will look, Master:');

  try {
    await message.channel.send(payload);
  } catch (error) {
    console.error('[Welcome] Preview failed:', error);
    return replyError(message, 'Preview Failed', `The preview could not be sent here, Master: ${error.message}`);
  }
}

async function sendTestWelcome(message, guildConfig, prefix) {
  const welcome = guildConfig.features?.welcomeSystem || {};
  const channelId = getWelcomeChannelId(guildConfig);
  let channel = message.channel;

  if (channelId) {
    channel = message.guild.channels.cache.get(channelId);
    if (!channel) {
      return replyError(message, 'Channel Not Found',
        `The configured welcome channel no longer exists, Master. Use \`${prefix}welcome channel #channel\` to set a new one.`);
    }
  }

  if (cannotSendIn(channel, message.guild.members.me)) {
    return replyError(message, 'Missing Permissions', `I cannot send messages with embeds in ${channel}, Master.`);
  }

  try {
    await channel.send(toPayload(buildWelcomeEmbed(message.member, welcome, guildConfig)));
  } catch (error) {
    console.error('[Welcome] Test message failed:', error);
    return replyError(message, 'Test Failed',
      `The test message could not be sent to ${channel}, Master: ${error.message}`);
  }

  return replySuccess(message, 'Test Sent',
    `${GLYPHS.SUCCESS} Test welcome message sent to ${channel}.` +
    (channelId ? '' : `\n\nNo welcome channel is set, so it was sent here. Use \`${prefix}welcome channel #channel\` to set one.`));
}

// ============================================
// Shared builders (also used by guildMemberAdd and the /welcome slash command)
// ============================================

/**
 * Build the welcome message based on settings: { embed, content }.
 * embed is null in plain text mode, where content carries the message.
 */
function buildWelcomeEmbed(member, welcome, guildConfig) {
  const welcomeMsg = parseWelcomeMessage(welcome.message || DEFAULT_WELCOME_MESSAGE, member);

  if (!welcome.embedEnabled && welcome.embedEnabled !== undefined) {
    // Plain text mode
    return { embed: null, content: clampText(welcomeMsg, LIMITS.content) };
  }

  const embed = new EmbedBuilder()
    .setColor(welcome.embedColor || guildConfig?.embedStyle?.color || DEFAULT_WELCOME_COLOR);

  // Author section
  const authorType = welcome.authorType || 'username';
  if (authorType === 'server') {
    embed.setAuthor({
      name: clampText(member.guild.name, LIMITS.author),
      iconURL: member.guild.iconURL({ size: 128 })
    });
  } else if (authorType === 'displayname') {
    embed.setAuthor({
      name: clampText(member.displayName || member.user.displayName || member.user.username, LIMITS.author),
      iconURL: member.user.displayAvatarURL({ size: 128 })
    });
  } else if (authorType !== 'none') {
    embed.setAuthor({
      name: member.user.username,
      iconURL: member.user.displayAvatarURL({ size: 128 })
    });
  }

  // Title: a single space means the title was removed
  const title = welcome.embedTitle;
  if (title?.trim()) {
    embed.setTitle(clampText(parseWelcomeMessage(title, member), LIMITS.title));
  } else if (title !== ' ') {
    embed.setTitle(clampText(parseWelcomeMessage(DEFAULT_WELCOME_TITLE, member), LIMITS.title));
  }

  embed.setDescription(clampText(welcomeMsg, LIMITS.description));

  // Thumbnail
  if (welcome.thumbnailType === 'avatar') {
    embed.setThumbnail(member.user.displayAvatarURL({ size: 256 }));
  } else if (welcome.thumbnailType === 'server') {
    embed.setThumbnail(member.guild.iconURL({ size: 256 }));
  } else if (welcome.thumbnailUrl) {
    embed.setThumbnail(welcome.thumbnailUrl);
  }

  // Footer: a single space means the footer was removed
  const footerText = welcome.footerText;
  if (footerText?.trim()) {
    embed.setFooter({ text: clampText(parseWelcomeMessage(footerText, member), LIMITS.footer) });
  } else if (footerText !== ' ') {
    embed.setFooter({ text: `Member #${member.guild.memberCount}` });
  }

  // Timestamp
  if (welcome.showTimestamp !== false) {
    embed.setTimestamp();
  }

  // Banner image
  if (welcome.bannerUrl) {
    embed.setImage(welcome.bannerUrl);
  }

  // Greeting content (text above embed)
  let content;
  if (welcome.mentionUser) {
    content = clampText(parseWelcomeMessage(welcome.greetingText || DEFAULT_GREETING, member), LIMITS.content);
  }

  return { embed, content };
}

/**
 * Parse welcome message with variables. Replacer functions keep "$" in names literal.
 */
function parseWelcomeMessage(msg, member) {
  return msg
    .replace(/{user}/gi, () => `<@${member.user.id}>`)
    .replace(/{username}/gi, () => member.user.username)
    .replace(/{displayname}/gi, () => member.displayName || member.user.displayName || member.user.username)
    .replace(/{tag}/gi, () => member.user.tag)
    .replace(/{id}/gi, () => member.user.id)
    .replace(/{server}/gi, () => member.guild.name)
    .replace(/{membercount}/gi, () => member.guild.memberCount.toString())
    .replace(/{usercreated}/gi, () => `<t:${Math.floor(member.user.createdTimestamp / 1000)}:D>`)
    .replace(/{avatar}/gi, () => member.user.displayAvatarURL({ size: 256 }))
    .replace(/\\n/g, '\n');
}

export { parseWelcomeMessage, buildWelcomeEmbed };
