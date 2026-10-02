import { PermissionFlagsBits, EmbedBuilder, ChannelType } from 'discord.js';
import Guild from '../../models/Guild.js';
import { successEmbed, errorEmbed, infoEmbed, GLYPHS, COLORS } from '../../utils/embeds.js';
import { hasModPerms, getPrefix } from '../../utils/helpers.js';
import { getRandomFooter } from '../../utils/raphael.js';

const DEFAULT_LEAVE_MESSAGE = 'Goodbye {username}! We hope to see you again.';
const DEFAULT_LEAVE_TITLE = '『 Goodbye 』';
const DEFAULT_LEAVE_COLOR = '#FF4757';

// Discord embed limits
const LIMITS = { title: 256, description: 4096, footer: 2048, content: 2000 };

const TOGGLE_VALUES = new Map([
  ['on', true], ['enable', true], ['true', true], ['yes', true],
  ['off', false], ['disable', false], ['false', false], ['no', false]
]);

export default {
  name: 'goodbye',
  category: 'config',
  description: 'Configure departure notification protocols, Master',
  usage: '<status|enable|disable|channel|message|embed|test|help|...>',
  // No "leave" alias: the music stop command uses it
  aliases: ['leavemsg', 'farewell'],
  permissions: [PermissionFlagsBits.ManageGuild],
  cooldown: 3,

  async execute(message, args) {
    try {
      return await runGoodbyeCommand(message, args);
    } catch (error) {
      console.error('[Goodbye] Error:', error);
      return message.reply({
        embeds: [await errorEmbed(message.guild.id, 'Goodbye Configuration Error',
          'An anomaly occurred while processing this request, Master. Please try again.')]
      }).catch(() => { });
    }
  }
};

async function runGoodbyeCommand(message, args) {
  const guildConfig = await Guild.getGuild(message.guild.id, message.guild.name);
  const prefix = await getPrefix(message.guild.id);
  const leave = guildConfig.features?.leaveSystem || {};

  // Check for moderator permissions
  if (!hasModPerms(message.member, guildConfig)) {
    return replyError(message, 'Permission Denied',
      `${GLYPHS.LOCK} You need Moderator/Staff permissions to configure goodbye messages, Master.`);
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
      await updateLeave(message, { enabled: true });
      const needsChannel = !(leave.channel && message.guild.channels.cache.has(leave.channel));
      return replySuccess(message, 'Goodbye System Enabled',
        `${GLYPHS.SUCCESS} Goodbye messages are now enabled.` +
        (needsChannel ? `\n\nNo usable goodbye channel is set. Use \`${prefix}goodbye channel #channel\` to set one.` : ''));
    }

    case 'disable':
    case 'off':
      await updateLeave(message, { enabled: false });
      return replySuccess(message, 'Goodbye System Disabled', `${GLYPHS.SUCCESS} Goodbye messages are now disabled.`);

    case 'channel': {
      if (!args[1]) {
        return replyInfo(message, 'Goodbye Channel',
          `**Current Channel:** ${describeChannel(message.guild, leave.channel)}\n\n` +
          `Use \`${prefix}goodbye channel #channel\` to change it.`);
      }

      const channel = message.mentions.channels.first() ||
        message.guild.channels.cache.get(args[1]);

      if (!channel) {
        return replyError(message, 'No Channel',
          `Please mention a channel or provide a channel ID, Master.\n\n**Usage:** \`${prefix}goodbye channel #channel\``);
      }

      if (channel.type !== ChannelType.GuildText) {
        return replyError(message, 'Invalid Channel', 'Please select a text channel, Master.');
      }

      await updateLeave(message, { channel: channel.id });
      return replySuccess(message, 'Goodbye Channel Set', `${GLYPHS.SUCCESS} Goodbye messages will be sent to ${channel}.`);
    }

    case 'message':
    case 'msg':
    case 'description':
    case 'desc': {
      const leaveMsg = args.slice(1).join(' ');

      if (!leaveMsg) {
        return replyInfo(message, 'Goodbye Message Variables',
          `**Current Message:**\n${clampText(leave.message || DEFAULT_LEAVE_MESSAGE, 1000)}\n\n` +
          `**Available Variables:**\n${variableLines()}\n\n` +
          `**Example:**\n\`${prefix}goodbye message Goodbye {username}!\\nWe now have {membercount} members.\`\n` +
          `Use \`${prefix}goodbye message reset\` to restore the default.`);
      }

      if (isKeyword(leaveMsg, ['reset', 'default'])) {
        await updateLeave(message, { message: null });
        return replySuccess(message, 'Goodbye Message Reset', `${GLYPHS.SUCCESS} The goodbye message has been reset to the default.`);
      }

      if (leaveMsg.length > LIMITS.description) {
        return replyError(message, 'Message Too Long',
          `The goodbye message can be at most ${LIMITS.description} characters, Master (yours is ${leaveMsg.length}).`);
      }

      await updateLeave(message, { message: leaveMsg });
      return replySuccess(message, 'Goodbye Message Set',
        `${GLYPHS.SUCCESS} Goodbye message has been updated.\n\n` +
        `**Preview:**\n${clampText(parseLeaveMessage(leaveMsg, message.member), 1500)}`);
    }

    case 'embed':
      return setToggle(message, args[1], prefix, 'embed', 'embedEnabled',
        on => `Goodbye embeds are now **${on ? 'enabled' : 'disabled'}**.`);

    case 'joindate':
    case 'showjoindate':
      return setToggle(message, args[1], prefix, 'joindate', 'showJoinDate',
        on => `Showing the join date is now **${on ? 'enabled' : 'disabled'}**.`);

    case 'membercount':
    case 'showmembercount':
      return setToggle(message, args[1], prefix, 'membercount', 'showMemberCount',
        on => `Showing the member count is now **${on ? 'enabled' : 'disabled'}**.`);

    case 'timestamp':
      return setToggle(message, args[1], prefix, 'timestamp', 'showTimestamp',
        on => `The timestamp is now **${on ? 'enabled' : 'disabled'}**.`);

    case 'test':
      return sendTestGoodbye(message, guildConfig, prefix);

    case 'image':
    case 'banner': {
      const imageUrl = args[1];

      if (!imageUrl) {
        return replyInfo(message, 'Goodbye Banner',
          leave.bannerUrl
            ? `**Current Banner:**\n${leave.bannerUrl}\n\nUse \`${prefix}goodbye image remove\` to remove it.`
            : `No banner set. Use \`${prefix}goodbye image <url>\` to set one, or \`${prefix}goodbye image remove\` to remove.`);
      }

      if (isKeyword(imageUrl, ['remove', 'none'])) {
        await updateLeave(message, { bannerUrl: null });
        return replySuccess(message, 'Banner Removed', `${GLYPHS.SUCCESS} Goodbye banner has been removed.`);
      }

      if (!isHttpUrl(imageUrl)) {
        return replyError(message, 'Invalid URL',
          'Please provide a valid image URL starting with http:// or https://, Master.');
      }

      await updateLeave(message, { bannerUrl: imageUrl });
      return replySuccess(message, 'Banner Set', `${GLYPHS.SUCCESS} Goodbye banner has been set.`);
    }

    case 'thumbnail':
    case 'thumb': {
      const thumbUrl = args[1];

      if (!thumbUrl) {
        return replyInfo(message, 'Goodbye Thumbnail',
          `**Current Thumbnail:** ${describeThumbnail(leave)}` +
          (leave.thumbnailUrl ? `\n${leave.thumbnailUrl}` : '') + '\n\n' +
          `\`${prefix}goodbye thumbnail <url>\` - Set custom thumbnail\n` +
          `\`${prefix}goodbye thumbnail avatar\` - Use user's avatar\n` +
          `\`${prefix}goodbye thumbnail server\` - Use server icon\n` +
          `\`${prefix}goodbye thumbnail remove\` - Remove thumbnail`);
      }

      if (isKeyword(thumbUrl, ['remove', 'none', 'off'])) {
        await updateLeave(message, { thumbnailUrl: null, thumbnailType: null });
        return replySuccess(message, 'Thumbnail Removed', `${GLYPHS.SUCCESS} Goodbye thumbnail has been removed.`);
      }

      if (isKeyword(thumbUrl, ['avatar', 'user'])) {
        await updateLeave(message, { thumbnailType: 'avatar', thumbnailUrl: null });
        return replySuccess(message, 'Thumbnail Set', `${GLYPHS.SUCCESS} Thumbnail will show the user's avatar.`);
      }

      if (isKeyword(thumbUrl, ['server', 'guild'])) {
        await updateLeave(message, { thumbnailType: 'server', thumbnailUrl: null });
        return replySuccess(message, 'Thumbnail Set', `${GLYPHS.SUCCESS} Thumbnail will show the server icon.`);
      }

      if (!isHttpUrl(thumbUrl)) {
        return replyError(message, 'Invalid URL',
          'Please provide a valid URL, or use `avatar`, `server`, or `remove`, Master.');
      }

      await updateLeave(message, { thumbnailUrl: thumbUrl, thumbnailType: 'custom' });
      return replySuccess(message, 'Thumbnail Set', `${GLYPHS.SUCCESS} Goodbye thumbnail has been set.`);
    }

    case 'title': {
      const titleText = args.slice(1).join(' ');

      if (!titleText) {
        return replyInfo(message, 'Embed Title',
          `**Current Title:** ${leave.embedTitle?.trim() ? leave.embedTitle : describeTemplate(leave.embedTitle)}\n\n` +
          `Use \`${prefix}goodbye title <text>\` to set a custom title.\n` +
          `Use \`${prefix}goodbye title reset\` for the default.\n` +
          `Use \`${prefix}goodbye title none\` to remove the title.\n\n` +
          `**Variables:** {username}, {server}, {membercount}`);
      }

      if (isKeyword(titleText, ['reset', 'default'])) {
        await updateLeave(message, { embedTitle: null });
        return replySuccess(message, 'Title Reset', `${GLYPHS.SUCCESS} Goodbye embed title reset to the default.`);
      }

      if (isKeyword(titleText, ['none', 'remove'])) {
        await updateLeave(message, { embedTitle: ' ' });
        return replySuccess(message, 'Title Removed', `${GLYPHS.SUCCESS} Goodbye embed title has been removed.`);
      }

      if (titleText.length > LIMITS.title) {
        return replyError(message, 'Title Too Long',
          `Embed titles can be at most ${LIMITS.title} characters, Master (yours is ${titleText.length}).`);
      }

      await updateLeave(message, { embedTitle: titleText });
      return replySuccess(message, 'Title Set', `${GLYPHS.SUCCESS} Goodbye embed title set to: ${titleText}`);
    }

    case 'footer': {
      const footerText = args.slice(1).join(' ');

      if (!footerText) {
        return replyInfo(message, 'Embed Footer',
          `**Current Footer:** ${leave.footerText?.trim() ? leave.footerText : (leave.footerText === ' ' ? 'Hidden' : 'Server name (default)')}\n\n` +
          `Use \`${prefix}goodbye footer <text>\` to set a custom footer.\n` +
          `Use \`${prefix}goodbye footer reset\` for the default.\n` +
          `Use \`${prefix}goodbye footer none\` to remove the footer.\n\n` +
          `**Variables:** {username}, {membercount}`);
      }

      if (isKeyword(footerText, ['reset', 'default'])) {
        await updateLeave(message, { footerText: null });
        return replySuccess(message, 'Footer Reset', `${GLYPHS.SUCCESS} Goodbye footer reset to the default.`);
      }

      if (isKeyword(footerText, ['none', 'remove'])) {
        await updateLeave(message, { footerText: ' ' });
        return replySuccess(message, 'Footer Removed', `${GLYPHS.SUCCESS} Goodbye footer has been removed.`);
      }

      if (footerText.length > LIMITS.footer) {
        return replyError(message, 'Footer Too Long',
          `Embed footers can be at most ${LIMITS.footer} characters, Master (yours is ${footerText.length}).`);
      }

      await updateLeave(message, { footerText });
      return replySuccess(message, 'Footer Set', `${GLYPHS.SUCCESS} Goodbye footer set to: ${footerText}`);
    }

    case 'color':
    case 'colour': {
      const colorHex = args[1];

      if (!colorHex) {
        return replyInfo(message, 'Embed Color',
          `**Current Color:** ${leave.embedColor || DEFAULT_LEAVE_COLOR}\n\n` +
          `Use \`${prefix}goodbye color #HEX\` to set a custom color.\n` +
          `Use \`${prefix}goodbye color reset\` for the default red.`);
      }

      if (isKeyword(colorHex, ['reset', 'default'])) {
        await updateLeave(message, { embedColor: DEFAULT_LEAVE_COLOR });
        return replySuccess(message, 'Color Reset', `${GLYPHS.SUCCESS} Goodbye embed color reset to the default red.`);
      }

      const match = colorHex.match(/^#?([0-9a-f]{6})$/i);
      if (!match) {
        return replyError(message, 'Invalid Color', 'Please provide a six-digit hex color code (e.g., #FF4757), Master.');
      }

      const normalizedColor = `#${match[1]}`;
      await updateLeave(message, { embedColor: normalizedColor });
      return replySuccess(message, 'Color Set', `${GLYPHS.SUCCESS} Goodbye embed color set to: ${normalizedColor}`);
    }

    case 'preview':
      return showPreview(message, guildConfig);

    case 'reset':
      await updateLeave(message, {
        enabled: false,
        channel: null,
        message: null,
        embedEnabled: true,
        embedColor: DEFAULT_LEAVE_COLOR,
        embedTitle: null,
        bannerUrl: null,
        thumbnailType: 'avatar',
        thumbnailUrl: null,
        footerText: null,
        showTimestamp: true,
        showJoinDate: true,
        showMemberCount: true
      });
      return replySuccess(message, 'Goodbye System Reset', `${GLYPHS.SUCCESS} All goodbye settings have been reset to defaults.`);

    case 'help':
      return showHelp(message, prefix);

    default:
      return replyError(message, 'Unknown Option',
        `Unknown option: \`${action}\`\n\nUse \`${prefix}goodbye help\` for available commands, Master.`);
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

// Writes the given leaveSystem fields with dotted paths so other fields are kept
function updateLeave(message, fields) {
  const $set = {};
  for (const [key, value] of Object.entries(fields)) {
    $set[`features.leaveSystem.${key}`] = value;
  }
  return Guild.updateGuild(message.guild.id, { $set });
}

async function setToggle(message, value, prefix, command, field, describe) {
  const enabled = parseToggle(value);

  if (enabled === null) {
    return replyError(message, 'Invalid Option',
      `Use \`${prefix}goodbye ${command} on\` or \`${prefix}goodbye ${command} off\`, Master.`);
  }

  await updateLeave(message, { [field]: enabled });
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

// Mirrors the thumbnail logic in buildLeaveEmbed
function describeThumbnail(leave) {
  if (leave.thumbnailType === 'avatar') return 'User avatar';
  if (leave.thumbnailType === 'server') return 'Server icon';
  if (leave.thumbnailUrl) return 'Custom image';
  return 'None';
}

function variableLines() {
  return [
    `${GLYPHS.DOT} \`{user}\` - Mentions the user (won't ping after leave)`,
    `${GLYPHS.DOT} \`{username}\` - User's username`,
    `${GLYPHS.DOT} \`{displayname}\` - User's display name`,
    `${GLYPHS.DOT} \`{tag}\` - User's tag`,
    `${GLYPHS.DOT} \`{id}\` - User's ID`,
    `${GLYPHS.DOT} \`{server}\` - Server name`,
    `${GLYPHS.DOT} \`{membercount}\` - Current member count`,
    `${GLYPHS.DOT} \`{joindate}\` - When they joined`,
    `${GLYPHS.DOT} \`{duration}\` - How long they were here`,
    `${GLYPHS.DOT} \`{avatar}\` - User's avatar URL`,
    `${GLYPHS.DOT} \`\\n\` - New line`
  ].join('\n');
}

function cannotSendIn(channel, me) {
  return !channel.permissionsFor(me)?.has([
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.EmbedLinks
  ]);
}

// ============================================
// Views
// ============================================

async function showStatus(message, guildConfig, prefix) {
  const leave = guildConfig.features?.leaveSystem || {};
  const flag = on => (on ? '◉ On' : '◇ Off');

  const embed = new EmbedBuilder()
    .setColor(COLORS.RAPHAEL)
    .setTitle('『 Goodbye Message System 』')
    .setDescription(`**Analysis:** Farewell messages sent when members leave, Master.\nUse \`${prefix}goodbye help\` for all commands.`)
    .addFields(
      {
        name: '▸ Delivery',
        value: [
          `Status: ${leave.enabled ? '◉ Active' : '◇ Inactive'}`,
          `Channel: ${describeChannel(message.guild, leave.channel)}`,
          `Embed mode: ${flag(leave.embedEnabled !== false)}`
        ].join('\n'),
        inline: true
      },
      {
        name: '▸ Appearance',
        value: [
          `Color: ${leave.embedColor || DEFAULT_LEAVE_COLOR}`,
          `Title: ${describeTemplate(leave.embedTitle)}`,
          `Footer: ${describeTemplate(leave.footerText)}`,
          `Thumbnail: ${describeThumbnail(leave)}`,
          `Join date: ${flag(leave.showJoinDate !== false)}`,
          `Member count: ${flag(leave.showMemberCount !== false)}`
        ].join('\n'),
        inline: true
      },
      {
        name: '▸ Current Message',
        value: `\`\`\`${clampText(leave.message || DEFAULT_LEAVE_MESSAGE, 300).replace(/```/g, "'''")}\`\`\``
      }
    )
    .setFooter({ text: getRandomFooter() });

  return message.reply({ embeds: [embed] });
}

async function showHelp(message, prefix) {
  const p = `${prefix}goodbye`;
  const embed = new EmbedBuilder()
    .setColor(COLORS.RAPHAEL)
    .setTitle('『 Goodbye Commands 』')
    .setDescription('**Analysis:** Commands for customizing goodbye messages, Master.')
    .addFields(
      {
        name: '▸ Basic Setup',
        value: [
          `\`${p} enable\` / \`${p} disable\` - Toggle goodbye messages`,
          `\`${p} channel #channel\` - Set goodbye channel`,
          `\`${p} message <text>\` - Set farewell message`,
          `\`${p} reset\` - Reset all settings`
        ].join('\n')
      },
      {
        name: '▸ Embed Customization',
        value: [
          `\`${p} embed on/off\` - Toggle embed mode`,
          `\`${p} color #hex\` / \`${p} title <text>\` / \`${p} footer <text>\``,
          `\`${p} image <url>\` / \`${p} thumbnail <url|avatar|server|remove>\``
        ].join('\n')
      },
      {
        name: '▸ Display Options',
        value: `\`${p} joindate|membercount|timestamp on/off\``
      },
      {
        name: '▸ Preview & Test',
        value: [
          `\`${p} test\` - Send a test message to the goodbye channel`,
          `\`${p} preview\` - Preview in the current channel`
        ].join('\n')
      },
      {
        name: '▸ Variables',
        value: '`{user}` `{username}` `{displayname}` `{tag}` `{id}` `{server}` ' +
          '`{membercount}` `{joindate}` `{duration}` `{avatar}` `\\n` (new line)'
      }
    )
    .setFooter({ text: getRandomFooter() });

  return message.reply({ embeds: [embed] });
}

async function showPreview(message, guildConfig) {
  const leave = guildConfig.features?.leaveSystem || {};

  await replyInfo(message, 'Goodbye Preview', 'Here is how your goodbye message will look, Master:');

  try {
    await message.channel.send(buildLeavePayload(message.member, leave, guildConfig));
  } catch (error) {
    console.error('[Goodbye] Preview failed:', error);
    return replyError(message, 'Preview Failed', `The preview could not be sent here, Master: ${error.message}`);
  }
}

async function sendTestGoodbye(message, guildConfig, prefix) {
  const leave = guildConfig.features?.leaveSystem || {};
  let channel = message.channel;

  if (leave.channel) {
    channel = message.guild.channels.cache.get(leave.channel);
    if (!channel) {
      return replyError(message, 'Channel Not Found',
        `The configured goodbye channel no longer exists, Master. Use \`${prefix}goodbye channel #channel\` to set a new one.`);
    }
  }

  if (cannotSendIn(channel, message.guild.members.me)) {
    return replyError(message, 'Missing Permissions', `I cannot send messages with embeds in ${channel}, Master.`);
  }

  try {
    await channel.send(buildLeavePayload(message.member, leave, guildConfig));
  } catch (error) {
    console.error('[Goodbye] Test message failed:', error);
    return replyError(message, 'Test Failed',
      `The test message could not be sent to ${channel}, Master: ${error.message}`);
  }

  return replySuccess(message, 'Test Sent',
    `${GLYPHS.SUCCESS} Test goodbye message sent to ${channel}.` +
    (leave.channel ? '' : `\n\nNo goodbye channel is set, so it was sent here. Use \`${prefix}goodbye channel #channel\` to set one.`));
}

// ============================================
// Shared builders (also used by guildMemberRemove)
// ============================================

/**
 * The goodbye message as a send payload: an embed, or plain text when embed mode is off.
 * Used by the real goodbye message, the test and the preview so they always match.
 */
function buildLeavePayload(member, leave, guildConfig) {
  if (leave.embedEnabled === false) {
    return { content: clampText(parseLeaveMessage(leave.message || DEFAULT_LEAVE_MESSAGE, member), LIMITS.content) };
  }
  return { embeds: [buildLeaveEmbed(member, leave, guildConfig)] };
}

/**
 * Build the goodbye embed based on settings
 */
function buildLeaveEmbed(member, leave) {
  const leaveMsg = parseLeaveMessage(leave.message || DEFAULT_LEAVE_MESSAGE, member);

  const embed = new EmbedBuilder()
    .setColor(/^#[0-9a-f]{6}$/i.test(leave.embedColor ?? '') ? leave.embedColor : DEFAULT_LEAVE_COLOR);

  // Author section - show user info
  embed.setAuthor({
    name: member.user.username,
    iconURL: member.user.displayAvatarURL({ size: 128 })
  });

  // Title: a single space means the title was removed
  const title = leave.embedTitle;
  if (title?.trim()) {
    embed.setTitle(clampText(parseLeaveMessage(title, member), LIMITS.title));
  } else if (title !== ' ') {
    embed.setTitle(DEFAULT_LEAVE_TITLE);
  }

  embed.setDescription(clampText(leaveMsg, LIMITS.description));

  // Thumbnail
  if (leave.thumbnailType === 'avatar') {
    embed.setThumbnail(member.user.displayAvatarURL({ size: 256 }));
  } else if (leave.thumbnailType === 'server') {
    embed.setThumbnail(member.guild.iconURL({ size: 256 }));
  } else if (leave.thumbnailUrl) {
    embed.setThumbnail(leave.thumbnailUrl);
  }

  // Join date and member count, each with its own toggle
  if (leave.showJoinDate !== false && member.joinedTimestamp) {
    embed.addFields({ name: '▸ Joined', value: `<t:${Math.floor(member.joinedTimestamp / 1000)}:R>`, inline: true });
  }
  if (leave.showMemberCount !== false) {
    embed.addFields({ name: '▸ Member Count', value: `${member.guild.memberCount}`, inline: true });
  }

  // Footer: a single space means the footer was removed
  const footerText = leave.footerText;
  if (footerText?.trim()) {
    embed.setFooter({ text: clampText(parseLeaveMessage(footerText, member), LIMITS.footer) });
  } else if (footerText !== ' ') {
    embed.setFooter({ text: member.guild.name });
  }

  // Timestamp
  if (leave.showTimestamp !== false) {
    embed.setTimestamp();
  }

  // Banner image
  if (leave.bannerUrl) {
    embed.setImage(leave.bannerUrl);
  }

  return embed;
}

/**
 * Parse leave message with variables. Replacer functions keep "$" in names literal.
 */
function parseLeaveMessage(msg, member) {
  const joinedTimestamp = member.joinedTimestamp ? Math.floor(member.joinedTimestamp / 1000) : null;
  const duration = member.joinedTimestamp ? getDuration(member.joinedTimestamp) : 'Unknown';

  return msg
    .replace(/{user}/gi, () => `<@${member.user.id}>`)
    .replace(/{username}/gi, () => member.user.username)
    .replace(/{displayname}/gi, () => member.displayName || member.user.displayName || member.user.username)
    .replace(/{tag}/gi, () => member.user.tag)
    .replace(/{id}/gi, () => member.user.id)
    .replace(/{server}/gi, () => member.guild.name)
    .replace(/{membercount}/gi, () => member.guild.memberCount.toString())
    .replace(/{joindate}/gi, () => (joinedTimestamp ? `<t:${joinedTimestamp}:D>` : 'Unknown'))
    .replace(/{duration}/gi, () => duration)
    .replace(/{avatar}/gi, () => member.user.displayAvatarURL({ size: 256 }))
    .replace(/\\n/g, '\n');
}

function plural(count, unit) {
  return `${count} ${unit}${count === 1 ? '' : 's'}`;
}

function getDuration(joinedTimestamp) {
  const diff = Date.now() - joinedTimestamp;
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));
  const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));

  if (days >= 365) return plural(Math.floor(days / 365), 'year');
  if (days >= 30) return plural(Math.floor(days / 30), 'month');
  if (days > 0) return plural(days, 'day');
  if (hours > 0) return plural(hours, 'hour');
  return 'less than an hour';
}

export { parseLeaveMessage, buildLeaveEmbed, buildLeavePayload };
