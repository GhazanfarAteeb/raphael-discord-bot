import { PermissionFlagsBits, EmbedBuilder, ChannelType } from 'discord.js';
import Guild from '../../models/Guild.js';
import BoosterRole from '../../models/BoosterRole.js';
import { successEmbed, errorEmbed, infoEmbed, GLYPHS, COLORS } from '../../utils/embeds.js';
import { hasModPerms, getPrefix, getAssignableRoleError } from '../../utils/helpers.js';
import { getRandomFooter } from '../../utils/raphael.js';
import {
  parseBoostMessage,
  buildBoostMessage,
  getBoostMessageTemplate,
  getBoostGreetingTemplate,
  getGrantableTierRoles,
  getMissingSendPermissions,
  toImageUrl,
  DEFAULT_BOOST_COLOR,
  DETECTABLE_BOOST_COUNT
} from '../../events/client/boostHandler.js';

// Discord limits for values saved here and later shown in boost/perks embeds
const LIMITS = { title: 256, description: 4096, footer: 2048, content: 2000, embed: 6000 };
// Leaves room for the tier reward line appended to the boost message
const BOOST_MESSAGE_MAX = 4000;
// Leaves room for the tier list appended to the perks announcement
const PERKS_MESSAGE_MAX = 3000;
const MAX_LISTED_ROLES = 25;
const MAX_TIER_BOOSTS = 100;
const MAX_ROLE_HOURS = 720;
const DEFAULT_ROLE_HOURS = 24;

const DEFAULT_PERKS_TITLE = '『 Booster Perks & Rewards 』';
const DEFAULT_PERKS_MESSAGE = 'Check out the perks for our server boosters!';
// Schema defaults stored for guilds that never customised them (the old emoji one and the
// current one); both render as the defaults above
const SCHEMA_DEFAULT_PERKS_TITLES = new Set(['💎 Booster Perks & Rewards', 'Booster Perks & Rewards']);
const SCHEMA_DEFAULT_PERKS_MESSAGES = new Set(['Check out the amazing perks for our server boosters! 💎']);

const TOGGLE_VALUES = new Map([
  ['on', true], ['enable', true], ['true', true], ['yes', true],
  ['off', false], ['disable', false], ['false', false], ['no', false]
]);

const BOOST_DETECTION_NOTE =
  'Discord reports that a member boosts, not how many times, so only 1-boost tiers are granted automatically. ' +
  'Higher tiers must be assigned manually. Tier roles are removed when the member stops boosting.';

export default {
  name: 'boost',
  category: 'config',
  description: 'Configure server boost appreciation protocols, Master',
  usage: '<status|enable|disable|channel|message|embed|test|help|...>',
  aliases: ['boostmsg', 'boostthanks', 'serverboost'],
  permissions: [PermissionFlagsBits.ManageGuild],
  cooldown: 3,

  async execute(message, args) {
    try {
      return await runBoostCommand(message, args);
    } catch (error) {
      console.error('[Boost] Error:', error);
      return message.reply({
        embeds: [await errorEmbed(message.guild.id, 'Boost Configuration Error',
          'An anomaly occurred while processing this request, Master. Please try again.')]
      }).catch(() => { });
    }
  }
};

async function runBoostCommand(message, args) {
  const guildConfig = await Guild.getGuild(message.guild.id, message.guild.name);
  const prefix = await getPrefix(message.guild.id);

  // Check for moderator permissions
  if (!hasModPerms(message.member, guildConfig)) {
    return replyError(message, 'Permission Denied',
      `${GLYPHS.LOCK} You need Moderator/Staff permissions to configure boost messages, Master.`);
  }

  if (!args[0]) {
    return showStatus(message, guildConfig, prefix);
  }

  const action = args[0].toLowerCase();

  // "perks-channel", "perks-publish", ... are aliases for "perks channel", "perks publish", ...
  if (action.startsWith('perks-')) {
    return handlePerksCommand(message, ['perks', action.slice('perks-'.length), ...args.slice(1)], guildConfig, prefix);
  }

  switch (action) {
    case 'status':
      return showStatus(message, guildConfig, prefix);

    case 'enable':
    case 'on':
      return setBoostEnabled(message, true, guildConfig, prefix);

    case 'disable':
    case 'off':
      return setBoostEnabled(message, false, guildConfig, prefix);

    // "toggle on|off", the form /boost toggle arrives in
    case 'toggle': {
      const enable = parseToggle(args[1]);
      if (enable === null) {
        return replyError(message, 'Invalid Option',
          `Use \`${prefix}boost toggle on\` or \`${prefix}boost toggle off\`, Master.`);
      }
      return setBoostEnabled(message, enable, guildConfig, prefix);
    }

    case 'channel':
      return setBoostChannel(message, args, prefix);

    case 'message':
    case 'msg':
    case 'description':
    case 'desc':
      return setBoostMessage(message, args, guildConfig, prefix);

    case 'embed':
      return setBoostToggle(message, args[1], prefix, {
        path: 'features.boostSystem.embedEnabled',
        command: 'boost embed',
        title: 'Embed Setting Updated',
        describe: (on) => `Boost embeds are now **${on ? 'enabled' : 'disabled'}**.`
      });

    case 'test':
      return sendTestBoost(message, guildConfig, prefix);

    case 'image':
    case 'banner':
      return setBoostBanner(message, args, guildConfig, prefix);

    case 'thumbnail':
    case 'thumb':
      return setBoostThumbnail(message, args, guildConfig, prefix);

    case 'title':
      return setBoostTitle(message, args, guildConfig, prefix);

    case 'footer':
      return setBoostFooter(message, args, guildConfig, prefix);

    case 'color':
    case 'colour':
      return setBoostColor(message, args, guildConfig, prefix);

    case 'mention':
      return setBoostToggle(message, args[1], prefix, {
        path: 'features.boostSystem.mentionUser',
        command: 'boost mention',
        title: 'Mention Setting Updated',
        describe: (on) => `The greeting above the embed is now **${on ? 'enabled' : 'disabled'}**.`
      });

    case 'greeting':
      return setBoostGreeting(message, args, guildConfig, prefix);

    case 'preview':
      return showPreview(message, guildConfig);

    case 'help':
      return showHelp(message, prefix);

    case 'author':
      return setBoostAuthor(message, args, guildConfig, prefix);

    case 'timestamp':
      return setBoostToggle(message, args[1], prefix, {
        path: 'features.boostSystem.showTimestamp',
        command: 'boost timestamp',
        title: 'Timestamp Setting Updated',
        describe: (on) => `The timestamp is now **${on ? 'enabled' : 'disabled'}**.`
      });

    case 'tiermessage':
    case 'tierline':
      return setBoostToggle(message, args[1], prefix, {
        path: 'features.boostSystem.showTierInMessage',
        command: 'boost tiermessage',
        title: 'Tier Reward Line Updated',
        describe: (on) => `The tier reward line in the boost message is now **${on ? 'shown' : 'hidden'}**.`
      });

    case 'reset':
      return resetBoostMessage(message);

    // Booster Role System commands
    case 'role':
    case 'setrole':
      return setBoosterRole(message, args, guildConfig, prefix);

    case 'give':
    case 'assign':
      return giveBoosterRole(message, args, guildConfig, prefix);

    case 'take':
    case 'revoke':
      return removeBoosterRole(message, args, guildConfig, prefix);

    case 'list':
    case 'active':
      return listActiveBoosterRoles(message);

    case 'duration':
    case 'time':
      return setRoleDuration(message, args, prefix);

    case 'clearrole':
      return clearBoosterRole(message);

    // Boost Tier Rewards commands
    case 'tier':
    case 'tiers':
    case 'rewards':
      return handleBoostTiers(message, args, guildConfig, prefix);

    case 'addtier':
    case 'settier':
      return addBoostTier(message, args, guildConfig, prefix);

    case 'removetier':
    case 'deletetier':
      return removeBoostTier(message, args, guildConfig, prefix);

    case 'listtiers':
    case 'tierlist':
      return listBoostTiers(message, guildConfig, prefix);

    case 'cleartiers':
      return clearBoostTiers(message, guildConfig);

    case 'stackable':
      return setTierStackable(message, args, guildConfig, prefix);

    // Booster Perks Announcement commands
    case 'perks':
    case 'perk':
    case 'announcement':
      return handlePerksCommand(message, args, guildConfig, prefix);

    case 'publish':
    case 'send':
      return publishPerksAnnouncement(message, args[1], guildConfig, prefix);

    default:
      return replyError(message, 'Unknown Option',
        `Unknown option: \`${action}\`\n\nUse \`${prefix}boost help\` for available commands, Master.`);
  }
}

// ============================================
// Shared helpers
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

function parseToggle(value) {
  const key = String(value ?? '').toLowerCase();
  return TOGGLE_VALUES.has(key) ? TOGGLE_VALUES.get(key) : null;
}

// Six-digit hex only: "#abc" would be read as 0x000ABC rather than #AABBCC
function parseHexColor(value) {
  const match = String(value ?? '').match(/^#?([0-9a-f]{6})$/i);
  return match ? `#${match[1]}` : null;
}

function isValidColor(value) {
  return /^#[0-9a-f]{6}$/i.test(value ?? '');
}

// Whole positive integers only: parseInt would accept "2abc"
function parseWholeNumber(value) {
  return /^\d+$/.test(String(value ?? '')) ? Number(value) : NaN;
}

// Same check the embed builder applies, so a saved URL can never break the announcement
function isHttpUrl(value) {
  return toImageUrl(value) !== null;
}

function isKeyword(value, keywords) {
  return keywords.includes(String(value ?? '').toLowerCase());
}

function clampText(text, max) {
  const value = String(text ?? '');
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

// Keep stored text from closing the code block it is shown in
function codeBlock(text, max) {
  return `\`\`\`${clampText(text, max).replace(/```/g, "'''")}\`\`\``;
}

function flag(on) {
  return on ? '◉ On' : '◇ Off';
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

// Mirrors the thumbnail logic in buildBoostEmbed
function describeThumbnail(boost) {
  if (boost.thumbnailType === 'avatar') return 'User avatar';
  if (boost.thumbnailType === 'server') return 'Server icon';
  if (boost.thumbnailUrl) return 'Custom image';
  if (boost.thumbnailType === 'none' || boost.thumbnailType === null) return 'None';
  return 'User avatar';
}

// "" when the bot can post in the channel, otherwise a sentence naming what is missing
function describeSendProblem(channel, guild, withEmbed = true) {
  const missing = getMissingSendPermissions(channel, guild.members.me, withEmbed);
  return missing.length ? `I am missing ${missing.join(', ')} in ${channel}.` : '';
}

// The member named by `arg` (mention or ID); the first mentioned member when arg names none
async function resolveMember(message, arg) {
  // members.fetch(undefined) would fetch the whole guild, so only fetch real IDs
  const id = String(arg ?? '').replace(/^<@!?(\d+)>$/, '$1');
  if (/^\d{17,20}$/.test(id)) {
    return message.mentions.members?.get(id) ?? message.guild.members.fetch(id).catch(() => null);
  }
  return message.mentions.members?.first() ?? null;
}

// The role named by `arg` (mention or ID); the first mentioned role when arg names none
function resolveRole(message, arg) {
  const id = String(arg ?? '').replace(/^<@&(\d+)>$/, '$1');
  return message.guild.roles.cache.get(id) ?? message.mentions.roles?.first() ?? null;
}

// The channel named by `arg` (mention or ID); the first mentioned channel when arg names none
function resolveChannel(message, arg) {
  const id = String(arg ?? '').replace(/^<#(\d+)>$/, '$1');
  return message.guild.channels.cache.get(id) ?? message.mentions.channels?.first() ?? null;
}

const ANNOUNCEMENT_CHANNEL_TYPES = [ChannelType.GuildText, ChannelType.GuildAnnouncement];

function getTiers(guildConfig) {
  // Copy: guildConfig is the cached object and must not be mutated
  return (guildConfig.features?.boostSystem?.tierRewards || []).map(tier => ({ ...tier }));
}

// ============================================
// Boost thank you message
// ============================================

async function setBoostEnabled(message, enable, guildConfig, prefix) {
  await Guild.updateGuild(message.guild.id, {
    $set: { 'features.boostSystem.enabled': enable }
  });

  const boost = guildConfig.features?.boostSystem || {};
  const channel = boost.channel ? message.guild.channels.cache.get(boost.channel) : null;
  let note = '';
  if (enable && !channel) {
    note = `\n\n${GLYPHS.WARNING} No usable boost channel is set, so nothing will be announced yet. ` +
      `Use \`${prefix}boost channel #channel\` to set one.`;
  } else if (enable) {
    const problem = describeSendProblem(channel, message.guild, boost.embedEnabled !== false);
    if (problem) note = `\n\n${GLYPHS.WARNING} ${problem} Boosts cannot be announced until this is fixed.`;
  }

  return replySuccess(message, `Boost Messages ${enable ? 'Enabled' : 'Disabled'}`,
    `${GLYPHS.SUCCESS} Boost thank you messages are now **${enable ? 'enabled' : 'disabled'}**.` + note);
}

async function setBoostChannel(message, args, prefix) {
  const channel = resolveChannel(message, args[1]);

  if (!channel) {
    return replyError(message, 'No Channel',
      `Please mention a channel or provide a channel ID, Master.\n\n**Usage:** \`${prefix}boost channel #channel\``);
  }

  if (!ANNOUNCEMENT_CHANNEL_TYPES.includes(channel.type)) {
    return replyError(message, 'Invalid Channel', 'Please select a text or announcement channel, Master.');
  }

  await Guild.updateGuild(message.guild.id, {
    $set: { 'features.boostSystem.channel': channel.id }
  });

  const problem = describeSendProblem(channel, message.guild);
  return replySuccess(message, 'Boost Channel Set',
    `${GLYPHS.SUCCESS} Boost thank you messages will be sent to ${channel}.` +
    (problem ? `\n\n${GLYPHS.WARNING} ${problem} Boosts cannot be announced until this is fixed.` : ''));
}

async function setBoostMessage(message, args, guildConfig, prefix) {
  const boostMsg = args.slice(1).join(' ');

  if (!boostMsg) {
    const currentMsg = getBoostMessageTemplate(guildConfig.features?.boostSystem);
    return replyInfo(message, 'Boost Message Variables',
      `**Current Message:**\n${clampText(currentMsg, 1000)}\n\n` +
      `**Available Variables:**\n` +
      `${GLYPHS.DOT} \`{user}\` - Mentions the user\n` +
      `${GLYPHS.DOT} \`{username}\` - User's username\n` +
      `${GLYPHS.DOT} \`{displayname}\` - User's display name\n` +
      `${GLYPHS.DOT} \`{tag}\` - User's tag\n` +
      `${GLYPHS.DOT} \`{id}\` - User's ID\n` +
      `${GLYPHS.DOT} \`{server}\` - Server name\n` +
      `${GLYPHS.DOT} \`{membercount}\` - Total member count\n` +
      `${GLYPHS.DOT} \`{boostcount}\` - Total boost count\n` +
      `${GLYPHS.DOT} \`{boostlevel}\` - Server boost level\n` +
      `${GLYPHS.DOT} \`{avatar}\` - User's avatar URL\n` +
      `${GLYPHS.DOT} \`\\n\` - New line\n\n` +
      `**Example:**\n\`${prefix}boost message Thank you {user} for boosting!\\nWe now have {boostcount} boosts.\`\n` +
      `Use \`${prefix}boost message reset\` to restore the default.`);
  }

  if (isKeyword(boostMsg, ['reset', 'default'])) {
    await Guild.updateGuild(message.guild.id, {
      $set: { 'features.boostSystem.message': null }
    });
    return replySuccess(message, 'Boost Message Reset',
      `${GLYPHS.SUCCESS} The boost message has been reset to the default.`);
  }

  if (boostMsg.length > BOOST_MESSAGE_MAX) {
    return replyError(message, 'Message Too Long',
      `The boost message can be at most ${BOOST_MESSAGE_MAX} characters, Master (yours is ${boostMsg.length}).`);
  }

  await Guild.updateGuild(message.guild.id, {
    $set: { 'features.boostSystem.message': boostMsg }
  });

  return replySuccess(message, 'Boost Message Set',
    `${GLYPHS.SUCCESS} Boost message has been updated.\n\n` +
    `**Preview:**\n${clampText(parseBoostMessage(boostMsg, message.member), 1500)}`);
}

async function setBoostToggle(message, value, prefix, { path, command, title, describe }) {
  const enabled = parseToggle(value);

  if (enabled === null) {
    return replyError(message, 'Invalid Option',
      `Use \`${prefix}${command} on\` or \`${prefix}${command} off\`, Master.`);
  }

  await Guild.updateGuild(message.guild.id, { $set: { [path]: enabled } });

  return replySuccess(message, title, `${GLYPHS.SUCCESS} ${describe(enabled)}`);
}

async function setBoostBanner(message, args, guildConfig, prefix) {
  const imageUrl = args[1];

  if (!imageUrl) {
    const currentBanner = guildConfig.features?.boostSystem?.bannerUrl;
    return replyInfo(message, 'Boost Banner',
      currentBanner
        ? `**Current Banner:**\n${currentBanner}\n\nUse \`${prefix}boost image remove\` to remove it.`
        : `No banner set. Use \`${prefix}boost image <url>\` to set one, or \`${prefix}boost image remove\` to remove.`);
  }

  if (isKeyword(imageUrl, ['remove', 'none'])) {
    await Guild.updateGuild(message.guild.id, {
      $set: { 'features.boostSystem.bannerUrl': null }
    });
    return replySuccess(message, 'Banner Removed', `${GLYPHS.SUCCESS} Boost banner has been removed.`);
  }

  if (!isHttpUrl(imageUrl)) {
    return replyError(message, 'Invalid URL',
      'Please provide a valid image URL starting with http:// or https://, Master.');
  }

  await Guild.updateGuild(message.guild.id, {
    $set: { 'features.boostSystem.bannerUrl': imageUrl }
  });

  return replySuccess(message, 'Banner Set', `${GLYPHS.SUCCESS} Boost banner has been set.`);
}

async function setBoostThumbnail(message, args, guildConfig, prefix) {
  const thumbUrl = args[1];
  const boost = guildConfig.features?.boostSystem || {};

  if (!thumbUrl) {
    return replyInfo(message, 'Boost Thumbnail',
      `**Current Thumbnail:** ${describeThumbnail(boost)}` +
      (boost.thumbnailUrl ? `\n${boost.thumbnailUrl}` : '') + '\n\n' +
      `\`${prefix}boost thumbnail <url>\` - Set custom thumbnail\n` +
      `\`${prefix}boost thumbnail avatar\` - Use user's avatar\n` +
      `\`${prefix}boost thumbnail server\` - Use server icon\n` +
      `\`${prefix}boost thumbnail remove\` - Remove thumbnail`);
  }

  if (isKeyword(thumbUrl, ['remove', 'none', 'off'])) {
    await Guild.updateGuild(message.guild.id, {
      $set: { 'features.boostSystem.thumbnailUrl': null, 'features.boostSystem.thumbnailType': null }
    });
    return replySuccess(message, 'Thumbnail Removed', `${GLYPHS.SUCCESS} Boost thumbnail has been removed.`);
  }

  if (isKeyword(thumbUrl, ['avatar', 'user'])) {
    await Guild.updateGuild(message.guild.id, {
      $set: { 'features.boostSystem.thumbnailType': 'avatar', 'features.boostSystem.thumbnailUrl': null }
    });
    return replySuccess(message, 'Thumbnail Set', `${GLYPHS.SUCCESS} Thumbnail will show the user's avatar.`);
  }

  if (isKeyword(thumbUrl, ['server', 'guild'])) {
    await Guild.updateGuild(message.guild.id, {
      $set: { 'features.boostSystem.thumbnailType': 'server', 'features.boostSystem.thumbnailUrl': null }
    });
    return replySuccess(message, 'Thumbnail Set', `${GLYPHS.SUCCESS} Thumbnail will show the server icon.`);
  }

  if (!isHttpUrl(thumbUrl)) {
    return replyError(message, 'Invalid URL',
      'Please provide a valid URL, or use `avatar`, `server`, or `remove`, Master.');
  }

  await Guild.updateGuild(message.guild.id, {
    $set: { 'features.boostSystem.thumbnailUrl': thumbUrl, 'features.boostSystem.thumbnailType': 'custom' }
  });

  return replySuccess(message, 'Thumbnail Set', `${GLYPHS.SUCCESS} Boost thumbnail has been set.`);
}

async function setBoostTitle(message, args, guildConfig, prefix) {
  const titleText = args.slice(1).join(' ');

  if (!titleText) {
    const current = guildConfig.features?.boostSystem?.embedTitle;
    return replyInfo(message, 'Embed Title',
      `**Current Title:** ${current?.trim() ? current : describeTemplate(current)}\n\n` +
      `Use \`${prefix}boost title <text>\` to set a custom title.\n` +
      `Use \`${prefix}boost title reset\` for the default title.\n` +
      `Use \`${prefix}boost title none\` to remove the title entirely.\n\n` +
      `**Variables:** {username}, {server}, {boostcount}`);
  }

  if (isKeyword(titleText, ['reset', 'default'])) {
    await Guild.updateGuild(message.guild.id, {
      $set: { 'features.boostSystem.embedTitle': null }
    });
    return replySuccess(message, 'Title Reset', `${GLYPHS.SUCCESS} Boost embed title reset to the default.`);
  }

  if (isKeyword(titleText, ['none', 'remove'])) {
    await Guild.updateGuild(message.guild.id, {
      $set: { 'features.boostSystem.embedTitle': ' ' }
    });
    return replySuccess(message, 'Title Removed', `${GLYPHS.SUCCESS} Boost embed title has been removed.`);
  }

  if (titleText.length > LIMITS.title) {
    return replyError(message, 'Title Too Long',
      `Embed titles can be at most ${LIMITS.title} characters, Master (yours is ${titleText.length}).`);
  }

  await Guild.updateGuild(message.guild.id, {
    $set: { 'features.boostSystem.embedTitle': titleText }
  });

  return replySuccess(message, 'Title Set', `${GLYPHS.SUCCESS} Boost embed title set to: ${titleText}`);
}

async function setBoostFooter(message, args, guildConfig, prefix) {
  const footerText = args.slice(1).join(' ');

  if (!footerText) {
    const current = guildConfig.features?.boostSystem?.footerText;
    return replyInfo(message, 'Embed Footer',
      `**Current Footer:** ${current?.trim() ? current : (current === ' ' ? 'Hidden' : 'Boost #X (default)')}\n\n` +
      `Use \`${prefix}boost footer <text>\` to set a custom footer.\n` +
      `Use \`${prefix}boost footer reset\` for the default.\n` +
      `Use \`${prefix}boost footer none\` to remove the footer.\n\n` +
      `**Variables:** {username}, {boostcount}, {boostlevel}`);
  }

  if (isKeyword(footerText, ['reset', 'default'])) {
    await Guild.updateGuild(message.guild.id, {
      $set: { 'features.boostSystem.footerText': null }
    });
    return replySuccess(message, 'Footer Reset', `${GLYPHS.SUCCESS} Boost footer reset to the default.`);
  }

  if (isKeyword(footerText, ['none', 'remove'])) {
    await Guild.updateGuild(message.guild.id, {
      $set: { 'features.boostSystem.footerText': ' ' }
    });
    return replySuccess(message, 'Footer Removed', `${GLYPHS.SUCCESS} Boost footer has been removed.`);
  }

  if (footerText.length > LIMITS.footer) {
    return replyError(message, 'Footer Too Long',
      `Embed footers can be at most ${LIMITS.footer} characters, Master (yours is ${footerText.length}).`);
  }

  await Guild.updateGuild(message.guild.id, {
    $set: { 'features.boostSystem.footerText': footerText }
  });

  return replySuccess(message, 'Footer Set', `${GLYPHS.SUCCESS} Boost footer set to: ${footerText}`);
}

async function setBoostColor(message, args, guildConfig, prefix) {
  const colorHex = args[1];

  if (!colorHex) {
    return replyInfo(message, 'Embed Color',
      `**Current Color:** ${guildConfig.features?.boostSystem?.embedColor || DEFAULT_BOOST_COLOR}\n\n` +
      `Use \`${prefix}boost color #HEX\` to set a custom color.\n` +
      `Use \`${prefix}boost color reset\` for the default pink.`);
  }

  if (isKeyword(colorHex, ['reset', 'default'])) {
    await Guild.updateGuild(message.guild.id, {
      $set: { 'features.boostSystem.embedColor': DEFAULT_BOOST_COLOR }
    });
    return replySuccess(message, 'Color Reset', `${GLYPHS.SUCCESS} Boost embed color reset to the default pink.`);
  }

  const normalizedColor = parseHexColor(colorHex);
  if (!normalizedColor) {
    return replyError(message, 'Invalid Color',
      'Please provide a six-digit hex color code (e.g., #f47fff), Master.');
  }

  await Guild.updateGuild(message.guild.id, {
    $set: { 'features.boostSystem.embedColor': normalizedColor }
  });

  return replySuccess(message, 'Color Set', `${GLYPHS.SUCCESS} Boost embed color set to: ${normalizedColor}`);
}

async function setBoostGreeting(message, args, guildConfig, prefix) {
  const greetingText = args.slice(1).join(' ');

  if (!greetingText) {
    return replyInfo(message, 'Greeting Text',
      `**Current Greeting:**\n${clampText(getBoostGreetingTemplate(guildConfig.features?.boostSystem), 500)}\n\n` +
      `This is the text that appears above the embed (when mention is enabled).\n\n` +
      `Use \`${prefix}boost greeting <text>\` to customize.\n` +
      `Use \`${prefix}boost greeting reset\` to restore the default.\n` +
      `**Variables:** {user}, {username}, {server}`);
  }

  if (isKeyword(greetingText, ['reset', 'default'])) {
    await Guild.updateGuild(message.guild.id, {
      $set: { 'features.boostSystem.greetingText': null }
    });
    return replySuccess(message, 'Greeting Reset', `${GLYPHS.SUCCESS} Greeting text reset to the default.`);
  }

  if (greetingText.length > LIMITS.content) {
    return replyError(message, 'Greeting Too Long',
      `The greeting can be at most ${LIMITS.content} characters, Master (yours is ${greetingText.length}).`);
  }

  await Guild.updateGuild(message.guild.id, {
    $set: { 'features.boostSystem.greetingText': greetingText }
  });

  return replySuccess(message, 'Greeting Set', `${GLYPHS.SUCCESS} Greeting text set to: ${greetingText}`);
}

async function setBoostAuthor(message, args, guildConfig, prefix) {
  const authorOption = args[1]?.toLowerCase();

  if (!authorOption) {
    return replyInfo(message, 'Author Settings',
      `**Current:** ${guildConfig.features?.boostSystem?.authorType || 'username (with avatar)'}\n\n` +
      `\`${prefix}boost author username\` - Show username with avatar\n` +
      `\`${prefix}boost author displayname\` - Show display name with avatar\n` +
      `\`${prefix}boost author server\` - Show server name with icon\n` +
      `\`${prefix}boost author none\` - No author section`);
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
    return replyError(message, 'Invalid Option',
      'Valid options: `username`, `displayname`, `server`, `none`');
  }

  await Guild.updateGuild(message.guild.id, {
    $set: { 'features.boostSystem.authorType': authorType }
  });

  return replySuccess(message, 'Author Setting Updated', `${GLYPHS.SUCCESS} Author section set to: **${authorType}**`);
}

// Resets the thank you message and its appearance. Tier rewards, the perks announcement and
// the temporary booster role are separate settings and are kept.
async function resetBoostMessage(message) {
  await Guild.updateGuild(message.guild.id, {
    $set: {
      'features.boostSystem.enabled': false,
      'features.boostSystem.channel': null,
      'features.boostSystem.message': null,
      'features.boostSystem.embedEnabled': true,
      'features.boostSystem.embedColor': DEFAULT_BOOST_COLOR,
      'features.boostSystem.embedTitle': null,
      'features.boostSystem.bannerUrl': null,
      'features.boostSystem.thumbnailUrl': null,
      'features.boostSystem.thumbnailType': 'avatar',
      'features.boostSystem.footerText': null,
      'features.boostSystem.showTimestamp': true,
      'features.boostSystem.mentionUser': true,
      'features.boostSystem.greetingText': null,
      'features.boostSystem.authorType': 'username',
      'features.boostSystem.showTierInMessage': true
    }
  });

  return replySuccess(message, 'Boost Message Reset',
    `${GLYPHS.SUCCESS} All boost message settings have been reset to defaults. ` +
    `Boost messages are now disabled and the boost channel was cleared.\n\n` +
    `Tier rewards, the perks announcement and the temporary booster role were kept.`);
}

// Problems that would stop boosts from being announced or rewarded, one line each
function collectBoostProblems(guild, guildConfig) {
  const boost = guildConfig.features?.boostSystem || {};
  const roleSystem = guildConfig.features?.boosterRoleSystem || {};
  const me = guild.members.me;
  const problems = [];

  if (boost.enabled) {
    const channel = boost.channel ? guild.channels.cache.get(boost.channel) : null;
    if (!boost.channel) problems.push('Boost messages are on, but no boost channel is set.');
    else if (!channel) problems.push('The boost channel no longer exists.');
    else {
      const problem = describeSendProblem(channel, guild, boost.embedEnabled !== false);
      if (problem) problems.push(problem);
    }
  }

  for (const tier of boost.tierRewards || []) {
    const role = guild.roles.cache.get(tier.roleId);
    if (!role) {
      problems.push(`The ${tier.boostCount}-boost tier role no longer exists.`);
      continue;
    }
    const roleError = me ? getAssignableRoleError(role, me) : null;
    if (roleError) problems.push(`${tier.boostCount}-boost tier: ${roleError}`);
  }

  if (roleSystem.roleId) {
    const role = guild.roles.cache.get(roleSystem.roleId);
    const roleError = role && me ? getAssignableRoleError(role, me) : null;
    if (!role) problems.push('The temporary booster role no longer exists.');
    else if (roleError) problems.push(`Temporary booster role: ${roleError}`);
  }

  return problems;
}

async function showStatus(message, guildConfig, prefix) {
  const boost = guildConfig.features?.boostSystem || {};
  const boosterRole = guildConfig.features?.boosterRoleSystem || {};
  const role = boosterRole.roleId ? message.guild.roles.cache.get(boosterRole.roleId) : null;
  const roleText = role ? `${role}` : (boosterRole.roleId ? `${GLYPHS.ERROR} No longer exists` : 'Not set');
  const tiers = boost.tierRewards || [];
  const manualTiers = tiers.filter(tier => tier.boostCount > DETECTABLE_BOOST_COUNT).length;
  const problems = collectBoostProblems(message.guild, guildConfig);

  const embed = new EmbedBuilder()
    .setColor(COLORS.RAPHAEL)
    .setTitle('『 Boost Thank You System 』')
    .setDescription(`**Analysis:** Current boost appreciation configuration, Master.\nUse \`${prefix}boost help\` for all commands.`)
    .addFields(
      {
        name: '▸ Announcement',
        value: [
          `Status: ${boost.enabled ? '◉ Active' : '◇ Inactive'}`,
          `Channel: ${describeChannel(message.guild, boost.channel)}`,
          `Embed mode: ${flag(boost.embedEnabled !== false)}`,
          `Mention user: ${flag(boost.mentionUser !== false)}`,
          `Timestamp: ${flag(boost.showTimestamp !== false)}`,
          `Tier reward line: ${flag(boost.showTierInMessage !== false)}`
        ].join('\n'),
        inline: true
      },
      {
        name: '▸ Appearance',
        value: [
          `Color: ${boost.embedColor || DEFAULT_BOOST_COLOR}`,
          `Title: ${describeTemplate(boost.embedTitle)}`,
          `Footer: ${describeTemplate(boost.footerText)}`,
          `Author: ${boost.authorType || 'username'}`,
          `Thumbnail: ${describeThumbnail(boost)}`,
          `Banner: ${boost.bannerUrl ? 'Set' : 'Not set'}`
        ].join('\n'),
        inline: true
      },
      {
        name: '▸ Rewards',
        value: [
          `Temporary role: ${roleText}`,
          `Role duration: ${boosterRole.duration || DEFAULT_ROLE_HOURS} hours`,
          `Tier rewards: ${tiers.length}` +
            (manualTiers ? ` (${manualTiers} above 1 boost must be assigned manually)` : '')
        ].join('\n'),
        inline: false
      },
      { name: '▸ Current Message', value: codeBlock(getBoostMessageTemplate(boost), 300), inline: false }
    )
    .setFooter({ text: getRandomFooter() });

  if (problems.length > 0) {
    embed.addFields({
      name: '▸ Needs Attention',
      value: clampText(problems.map(problem => `${GLYPHS.ERROR} ${problem}`).join('\n'), 1024),
      inline: false
    });
  }

  return message.reply({ embeds: [embed] });
}

async function showHelp(message, prefix) {
  const p = `${prefix}boost`;
  const embed = new EmbedBuilder()
    .setColor(COLORS.RAPHAEL)
    .setTitle('『 Boost Commands 』')
    .setDescription('**Analysis:** Commands for boost thank you messages, booster roles and perks, Master.')
    .addFields(
      {
        name: '▸ Setup',
        value: [
          `\`${p} enable\` / \`${p} disable\` - Toggle boost messages (also \`${p} toggle on/off\`)`,
          `\`${p} channel #channel\` - Set boost channel`,
          `\`${p} test\` / \`${p} preview\` - Try the message`,
          `\`${p} reset\` - Reset message settings`
        ].join('\n')
      },
      {
        name: '▸ Content',
        value: [
          `\`${p} message <text>\` - Embed description`,
          `\`${p} greeting <text>\` - Text above embed`,
          `\`${p} title <text>\` / \`${p} footer <text>\``
        ].join('\n')
      },
      {
        name: '▸ Appearance',
        value: [
          `\`${p} color #HEX\` / \`${p} image <url>\``,
          `\`${p} thumbnail <url|avatar|server|remove>\``,
          `\`${p} author <username|displayname|server|none>\``,
          `\`${p} embed|mention|timestamp|tiermessage on/off\``
        ].join('\n')
      },
      {
        name: '▸ Temporary Booster Role',
        value: [
          `\`${p} role @role\` / \`${p} clearrole\``,
          `\`${p} give @user [reason]\` / \`${p} take @user\``,
          `\`${p} duration <hours>\` / \`${p} list\``,
          '› Given by staff, removed automatically within about a minute of expiring.'
        ].join('\n')
      },
      {
        name: '▸ Tier Rewards',
        value: [
          `\`${p} addtier <count> @role\` / \`${p} removetier <count>\``,
          `\`${p} listtiers\` / \`${p} cleartiers\` / \`${p} stackable <count> on/off\``,
          `› ${BOOST_DETECTION_NOTE}`
        ].join('\n')
      },
      {
        name: '▸ Perks Announcement',
        value: [
          `\`${p} perks\` - Status, \`${p} perks help\` - All options`,
          `\`${p} perks channel #channel\` / \`${p} perks preview\``,
          `\`${p} publish\` - Post, or update the last posted announcement`,
          `\`${p} publish new\` - Always post a new announcement`
        ].join('\n')
      },
      {
        name: '▸ Variables',
        value: '`{user}` `{username}` `{displayname}` `{tag}` `{id}` `{server}` ' +
          '`{membercount}` `{boostcount}` `{boostlevel}` `{avatar}` `\\n` (new line)'
      }
    )
    .setFooter({ text: getRandomFooter() });

  return message.reply({ embeds: [embed] });
}

// The message a real boost by `member` would produce, without pinging anyone. Shows the tier
// reward line a 1-boost member would get.
function buildSampleBoostMessage(member, boost) {
  return buildBoostMessage(member, boost, {
    tierRewards: getGrantableTierRoles(member.guild, boost),
    silent: true
  });
}

async function showPreview(message, guildConfig) {
  const boost = guildConfig.features?.boostSystem || {};
  const payload = buildSampleBoostMessage(message.member, boost);

  if (!message.channel) {
    return replyError(message, 'Preview Failed', 'I cannot post in this channel, Master.');
  }

  await replyInfo(message, 'Boost Preview', 'Here is how your boost message will look, Master:');

  try {
    await message.channel.send(payload);
  } catch (error) {
    console.error('[Boost] Preview failed:', error);
    return replyError(message, 'Preview Failed',
      `The preview could not be sent here, Master: ${error.message}`);
  }
}

async function sendTestBoost(message, guildConfig, prefix) {
  const boost = guildConfig.features?.boostSystem || {};
  let channel = message.channel;

  if (boost.channel) {
    channel = message.guild.channels.cache.get(boost.channel);
    if (!channel) {
      return replyError(message, 'Channel Not Found',
        `The configured boost channel no longer exists, Master. Use \`${prefix}boost channel #channel\` to set a new one.`);
    }
  }

  const problem = channel
    ? describeSendProblem(channel, message.guild, boost.embedEnabled !== false)
    : 'I cannot post in this channel.';
  if (problem) {
    return replyError(message, 'Missing Permissions', `${problem} Please fix this first, Master.`);
  }

  try {
    await channel.send(buildSampleBoostMessage(message.member, boost));
  } catch (error) {
    console.error('[Boost] Test message failed:', error);
    return replyError(message, 'Test Failed',
      `The test message could not be sent to ${channel}, Master: ${error.message}`);
  }

  const notes = [];
  if (!boost.channel) {
    notes.push(`No boost channel is set, so it was sent here. Use \`${prefix}boost channel #channel\` to set one.`);
  }
  if (!boost.enabled) {
    notes.push(`Boost messages are disabled, so real boosts are not announced yet. Use \`${prefix}boost enable\`.`);
  }

  return replySuccess(message, 'Test Sent',
    `${GLYPHS.SUCCESS} Test boost message sent to ${channel}.` +
    (notes.length ? `\n\n${notes.join('\n')}` : ''));
}

// ============================================
// Booster Role System Functions
// ============================================

async function setBoosterRole(message, args, guildConfig, prefix) {
  const role = resolveRole(message, args[1]);

  if (!role) {
    return replyError(message, 'Role Not Found',
      `${GLYPHS.ERROR} Please mention a valid role, Master.\n\n**Usage:** \`${prefix}boost role @role\``);
  }

  // Also covers managed roles and roles at or above my highest role
  const roleError = getAssignableRoleError(role, message.member);
  if (roleError) {
    return replyError(message, 'Role Not Allowed', roleError);
  }

  await Guild.updateGuild(message.guild.id, {
    $set: {
      'features.boosterRoleSystem.roleId': role.id,
      'features.boosterRoleSystem.enabled': true
    }
  });

  const duration = guildConfig.features?.boosterRoleSystem?.duration || DEFAULT_ROLE_HOURS;

  return replySuccess(message, 'Booster Role Set',
    `${GLYPHS.SUCCESS} The temporary booster role has been set to ${role}.\n\n` +
    `Users given this role will have it automatically removed after **${duration} hours**.`);
}

async function giveBoosterRole(message, args, guildConfig, prefix) {
  const roleSystem = guildConfig.features?.boosterRoleSystem || {};
  const boosterRoleId = roleSystem.roleId;

  if (!boosterRoleId) {
    return replyError(message, 'No Role Configured',
      `${GLYPHS.ERROR} No booster role has been configured, Master.\n\n**Usage:** \`${prefix}boost role @role\``);
  }

  if (!roleSystem.enabled) {
    return replyError(message, 'System Disabled',
      `${GLYPHS.ERROR} The booster role system is disabled, Master.\n\nSet a role first: \`${prefix}boost role @role\``);
  }

  const member = await resolveMember(message, args[1]);

  if (!member) {
    return replyError(message, 'User Not Found',
      `${GLYPHS.ERROR} Please mention a valid user, Master.\n\n**Usage:** \`${prefix}boost give @user [reason]\``);
  }

  const role = message.guild.roles.cache.get(boosterRoleId);

  if (!role) {
    return replyError(message, 'Role Not Found',
      `${GLYPHS.ERROR} The configured booster role no longer exists. Please set a new one, Master.`);
  }

  // Checked again here: the role may have been moved or given new permissions since it was set,
  // and the member giving it must be allowed to hand it out
  const roleError = getAssignableRoleError(role, message.member);
  if (roleError) {
    return replyError(message, 'Role Not Allowed', roleError);
  }

  const duration = (roleSystem.duration || DEFAULT_ROLE_HOURS) * 60 * 60 * 1000;
  const reason = args.slice(2).join(' ') || null;

  // Already has the role: start the duration again from now
  if (member.roles.cache.has(boosterRoleId)) {
    const entry = await BoosterRole.addBoosterRole(message.guild.id, member.id, boosterRoleId, duration, message.author.id, reason);
    const expiresAt = Math.floor(new Date(entry.expiresAt).getTime() / 1000);
    return replyInfo(message, 'Role Renewed',
      `${GLYPHS.INFO} ${member} already has ${role}. It will now be removed <t:${expiresAt}:R>.\n\n` +
      `**Expires:** <t:${expiresAt}:F>`);
  }

  try {
    await member.roles.add(role, `Temporary booster role given by ${message.author.tag}`);
  } catch (error) {
    console.error('[Boost] Error giving booster role:', error);
    return replyError(message, 'Error',
      `${GLYPHS.ERROR} Failed to give the booster role. Make sure I have the proper permissions, Master.`);
  }

  let entry;
  try {
    entry = await BoosterRole.addBoosterRole(message.guild.id, member.id, boosterRoleId, duration, message.author.id, reason);
  } catch (error) {
    // Without a record the role would never expire, so take it back
    console.error('[Boost] Error saving booster role expiry:', error);
    await member.roles.remove(role, 'Temporary booster role could not be tracked').catch(() => { });
    return replyError(message, 'Error',
      `${GLYPHS.ERROR} I could not save the expiry time, so the role was not given. Please try again, Master.`);
  }

  const expiresAt = Math.floor(new Date(entry.expiresAt).getTime() / 1000);
  return replySuccess(message, 'Booster Role Given',
    `${GLYPHS.SUCCESS} Successfully gave ${role} to ${member}.\n\n` +
    `**Expires:** <t:${expiresAt}:F> (<t:${expiresAt}:R>)` +
    (reason ? `\n**Reason:** ${clampText(reason, 500)}` : ''));
}

async function removeBoosterRole(message, args, guildConfig, prefix) {
  const boosterRoleId = guildConfig.features?.boosterRoleSystem?.roleId;
  const member = await resolveMember(message, args[1]);

  if (!member) {
    return replyError(message, 'User Not Found',
      `${GLYPHS.ERROR} Please mention a valid user, Master.\n\n**Usage:** \`${prefix}boost take @user\``);
  }

  // The configured role plus any temporary role still tracked for the member (the configured
  // role may have changed since it was given)
  const entries = await BoosterRole.find({ guildId: message.guild.id, userId: member.id }).lean();
  const roleIds = new Set(entries.map(entry => entry.roleId));
  if (boosterRoleId) roleIds.add(boosterRoleId);
  const heldRoles = [...roleIds]
    .filter(roleId => member.roles.cache.has(roleId))
    .map(roleId => message.guild.roles.cache.get(roleId))
    .filter(Boolean);

  if (heldRoles.length === 0 && entries.length === 0) {
    return replyError(message, boosterRoleId ? 'No Role' : 'No Role Configured', boosterRoleId
      ? `${GLYPHS.ERROR} ${member} does not have the booster role.`
      : `${GLYPHS.ERROR} No booster role has been configured, Master.`);
  }

  try {
    for (const role of heldRoles) {
      await member.roles.remove(role, `Temporary booster role taken by ${message.author.tag}`);
    }
  } catch (error) {
    console.error('[Boost] Error removing booster role:', error);
    return replyError(message, 'Error',
      `${GLYPHS.ERROR} Failed to remove the booster role. Make sure I have the proper permissions, Master.`);
  }

  await BoosterRole.removeBoosterRole(message.guild.id, member.id);

  return replySuccess(message, 'Booster Role Removed', heldRoles.length > 0
    ? `${GLYPHS.SUCCESS} Removed ${heldRoles.join(', ')} from ${member}.`
    : `${GLYPHS.SUCCESS} ${member} no longer had the booster role. Its pending expiry was cleared.`);
}

async function listActiveBoosterRoles(message) {
  const entries = await BoosterRole.getGuildEntries(message.guild.id);

  if (entries.length === 0) {
    return replyInfo(message, 'No Active Booster Roles',
      `${GLYPHS.INFO} There are no active temporary booster roles in this server.`);
  }

  const shown = entries.slice(0, MAX_LISTED_ROLES);
  const members = await message.guild.members.fetch({ user: shown.map(entry => entry.userId) })
    .catch(() => message.guild.members.cache);
  const now = Date.now();

  const fields = shown.map(entry => {
    const member = members.get(entry.userId);
    const role = message.guild.roles.cache.get(entry.roleId);
    const expiresAt = new Date(entry.expiresAt).getTime();
    const expiresTimestamp = Math.floor(expiresAt / 1000);
    const expiry = expiresAt > now
      ? `**Expires:** <t:${expiresTimestamp}:R>`
      : `**Expired:** <t:${expiresTimestamp}:R>, removal pending` +
        (entry.lastError ? ` (last attempt failed: ${clampText(entry.lastError, 80)})` : '');

    return {
      name: clampText(member ? member.user.tag : `User ID: ${entry.userId}`, 64),
      value: `**Role:** ${role ? role.toString() : 'Deleted role'}\n${expiry}` +
        (entry.reason ? `\n**Reason:** ${clampText(entry.reason, 80)}` : ''),
      inline: true
    };
  });

  // Stay under Discord's 6000 character embed limit (title, description and footer use < 400)
  const listed = [];
  let size = 400;
  for (const field of fields) {
    size += field.name.length + field.value.length;
    if (size > LIMITS.embed) break;
    listed.push(field);
  }

  const countText = entries.length > listed.length
    ? `Showing ${listed.length} of ${entries.length} temporary booster roles.`
    : `Showing ${entries.length} temporary booster role(s).`;

  const embed = new EmbedBuilder()
    .setTitle('『 Active Booster Roles 』')
    .setColor(COLORS.RAPHAEL)
    .setDescription(`**Analysis:** ${countText}\nRoles are removed automatically within about a minute of expiring.`)
    .addFields(listed)
    .setFooter({ text: getRandomFooter() });

  return message.reply({ embeds: [embed] });
}

async function setRoleDuration(message, args, prefix) {
  const hours = parseWholeNumber(args[1]);

  if (Number.isNaN(hours) || hours < 1 || hours > MAX_ROLE_HOURS) {
    return replyError(message, 'Invalid Duration',
      `${GLYPHS.ERROR} Please provide a whole number of hours between 1 and ${MAX_ROLE_HOURS} (30 days), Master.\n\n` +
      `**Usage:** \`${prefix}boost duration <hours>\``);
  }

  await Guild.updateGuild(message.guild.id, {
    $set: { 'features.boosterRoleSystem.duration': hours }
  });

  return replySuccess(message, 'Duration Updated',
    `${GLYPHS.SUCCESS} Booster role duration has been set to **${hours} hours**.\n\n` +
    `This will apply to new role assignments. Existing assignments will keep their original expiry time.`);
}

async function clearBoosterRole(message) {
  await Guild.updateGuild(message.guild.id, {
    $unset: { 'features.boosterRoleSystem.roleId': '' },
    $set: { 'features.boosterRoleSystem.enabled': false }
  });

  return replySuccess(message, 'Booster Role Cleared',
    `${GLYPHS.SUCCESS} The booster role configuration has been cleared.\n\n` +
    `**Note:** Existing role assignments will still be tracked and removed when they expire.`);
}

// ============================================
// BOOST TIER REWARDS FUNCTIONS
// ============================================

async function handleBoostTiers(message, args, guildConfig, prefix) {
  const subAction = args[1]?.toLowerCase();

  switch (subAction) {
    case undefined:
    case 'list':
      return listBoostTiers(message, guildConfig, prefix);
    case 'add':
    case 'set':
      return addBoostTier(message, args.slice(1), guildConfig, prefix);
    case 'remove':
    case 'delete':
      return removeBoostTier(message, args.slice(1), guildConfig, prefix);
    case 'clear':
      return clearBoostTiers(message, guildConfig);
    case 'stackable':
      return setTierStackable(message, args.slice(1), guildConfig, prefix);
    // "tier message on|off": the tier reward line in the boost message
    case 'message':
    case 'line':
      return setBoostToggle(message, args[2], prefix, {
        path: 'features.boostSystem.showTierInMessage',
        command: 'boost tier message',
        title: 'Tier Reward Line Updated',
        describe: (on) => `The tier reward line in the boost message is now **${on ? 'shown' : 'hidden'}**.`
      });
    default:
      return showTierHelp(message, prefix);
  }
}

async function addBoostTier(message, args, guildConfig, prefix) {
  // Usage: boost addtier <boost_count> @role [stackable]
  // or: boost tier add <boost_count> @role [stackable]
  const boostCount = parseWholeNumber(args[1]);
  const role = resolveRole(message, args[2]);

  if (Number.isNaN(boostCount) || boostCount < 1 || boostCount > MAX_TIER_BOOSTS) {
    return replyError(message, 'Invalid Boost Count',
      `${GLYPHS.ERROR} Please provide a whole boost count between 1 and ${MAX_TIER_BOOSTS}, Master.\n\n` +
      `**Usage:** \`${prefix}boost addtier <boost_count> @role [stackable]\`\n` +
      `**Example:** \`${prefix}boost addtier 1 @Booster\` - Reward for boosting`);
  }

  if (!role) {
    return replyError(message, 'No Role Specified',
      `${GLYPHS.ERROR} Please mention a role or provide a role ID, Master.\n\n` +
      `**Usage:** \`${prefix}boost addtier <boost_count> @role\`\n` +
      `**Example:** \`${prefix}boost addtier 1 @Booster\``);
  }

  // Also covers managed roles and roles at or above my highest role
  const roleError = getAssignableRoleError(role, message.member);
  if (roleError) {
    return replyError(message, 'Role Not Allowed', roleError);
  }

  const stackable = parseToggle(args[3]) ?? true;
  const currentTiers = getTiers(guildConfig);
  const existingIndex = currentTiers.findIndex(t => t.boostCount === boostCount);

  if (existingIndex !== -1) {
    currentTiers[existingIndex] = { boostCount, roleId: role.id, stackable };
  } else {
    currentTiers.push({ boostCount, roleId: role.id, stackable });
  }

  currentTiers.sort((a, b) => a.boostCount - b.boostCount);

  await Guild.updateGuild(message.guild.id, {
    $set: { 'features.boostSystem.tierRewards': currentTiers }
  });

  const detectionNote = boostCount > DETECTABLE_BOOST_COUNT
    ? `\n\n${GLYPHS.WARNING} ${BOOST_DETECTION_NOTE}`
    : `\n\nMembers receive this role when they boost and lose it when they stop boosting.`;

  return replySuccess(message, 'Boost Tier Added',
    `${GLYPHS.SUCCESS} **Tier ${boostCount}** reward has been ${existingIndex !== -1 ? 'updated' : 'added'}.\n\n` +
    `**▸ Boosts Required:** ${boostCount}+\n` +
    `**▸ Reward Role:** ${role}\n` +
    `**▸ Stackable:** ${stackable ? 'Yes (keeps lower tier roles)' : 'No (replaces lower tier roles)'}` +
    detectionNote);
}

async function removeBoostTier(message, args, guildConfig, prefix) {
  // Usage: boost removetier <boost_count>
  const boostCount = parseWholeNumber(args[1]);

  if (Number.isNaN(boostCount)) {
    return replyError(message, 'Invalid Boost Count',
      `${GLYPHS.ERROR} Please provide the boost count of the tier to remove, Master.\n\n` +
      `**Usage:** \`${prefix}boost removetier <boost_count>\`\n` +
      `**Example:** \`${prefix}boost removetier 2\` - Remove tier for 2 boosts`);
  }

  const currentTiers = getTiers(guildConfig);
  const tierIndex = currentTiers.findIndex(t => t.boostCount === boostCount);

  if (tierIndex === -1) {
    return replyError(message, 'Tier Not Found',
      `${GLYPHS.ERROR} No tier found for ${boostCount} boosts.\n\n` +
      `Use \`${prefix}boost listtiers\` to see all configured tiers.`);
  }

  const [removedTier] = currentTiers.splice(tierIndex, 1);
  const removedRole = message.guild.roles.cache.get(removedTier.roleId);

  await Guild.updateGuild(message.guild.id, {
    $set: { 'features.boostSystem.tierRewards': currentTiers }
  });

  return replySuccess(message, 'Boost Tier Removed',
    `${GLYPHS.SUCCESS} **Tier ${boostCount}** has been removed.\n\n` +
    `**▸ Removed Role:** ${removedRole || 'Unknown Role'}\n\n` +
    `Users who already have this role will keep it. Use \`${prefix}boost listtiers\` to see remaining tiers.`);
}

function formatTierLines(guild, tiers, { showStackable }) {
  return [...tiers]
    .sort((a, b) => a.boostCount - b.boostCount)
    .map(tier => {
      const role = guild.roles.cache.get(tier.roleId);
      const line = `◆ **${tier.boostCount}+ Boost${tier.boostCount === 1 ? '' : 's'}** — ${role || 'Role not found'}`;
      return showStackable ? `${line}\n   └─ Stackable: ${tier.stackable !== false ? 'Yes' : 'No'}` : line;
    })
    .join('\n');
}

async function listBoostTiers(message, guildConfig, prefix) {
  const tiers = guildConfig.features?.boostSystem?.tierRewards || [];

  if (tiers.length === 0) {
    return replyInfo(message, 'Boost Tier Rewards',
      `No boost tier rewards configured.\n\n` +
      `${GLYPHS.DOT} \`${prefix}boost addtier 1 @Booster\` - Reward members who boost\n\n` +
      BOOST_DETECTION_NOTE);
  }

  const embed = new EmbedBuilder()
    .setTitle('『 Boost Tier Rewards 』')
    .setColor(COLORS.RAPHAEL)
    .setDescription(`**Configured Tiers:**\n\n${clampText(formatTierLines(message.guild, tiers, { showStackable: true }), 3000)}`)
    .addFields(
      {
        name: '▸ Commands',
        value: [
          `\`${prefix}boost addtier <count> @role\` - Add tier`,
          `\`${prefix}boost removetier <count>\` - Remove tier`,
          `\`${prefix}boost cleartiers\` - Clear all tiers`
        ].join('\n')
      },
      { name: '▸ Detection', value: BOOST_DETECTION_NOTE }
    )
    .setFooter({ text: `${tiers.length} tier(s) configured • ${getRandomFooter()}` });

  return message.reply({ embeds: [embed] });
}

async function clearBoostTiers(message, guildConfig) {
  const tiers = guildConfig.features?.boostSystem?.tierRewards || [];

  if (tiers.length === 0) {
    return replyInfo(message, 'No Tiers to Clear', 'There are no boost tier rewards configured.');
  }

  await Guild.updateGuild(message.guild.id, {
    $set: { 'features.boostSystem.tierRewards': [] }
  });

  return replySuccess(message, 'Boost Tiers Cleared',
    `${GLYPHS.SUCCESS} All ${tiers.length} boost tier reward(s) have been removed.\n\n` +
    `Users who already have tier roles will keep them.`);
}

async function setTierStackable(message, args, guildConfig, prefix) {
  // Usage: boost stackable <boost_count> <on/off>
  const boostCount = parseWholeNumber(args[1]);
  const stackable = parseToggle(args[2]);

  if (Number.isNaN(boostCount)) {
    return replyError(message, 'Invalid Boost Count',
      `${GLYPHS.ERROR} Please provide the boost count of the tier, Master.\n\n` +
      `**Usage:** \`${prefix}boost stackable <boost_count> <on/off>\`\n` +
      `**Example:** \`${prefix}boost stackable 2 off\` - Make tier 2 replace lower tiers`);
  }

  if (stackable === null) {
    return replyError(message, 'Invalid Setting',
      `${GLYPHS.ERROR} Please specify \`on\` or \`off\`, Master.\n\n` +
      `**Stackable ON:** Users keep all lower tier roles\n` +
      `**Stackable OFF:** Higher tiers replace lower tier roles`);
  }

  const currentTiers = getTiers(guildConfig);
  const tier = currentTiers.find(t => t.boostCount === boostCount);

  if (!tier) {
    return replyError(message, 'Tier Not Found', `${GLYPHS.ERROR} No tier found for ${boostCount} boosts.`);
  }

  tier.stackable = stackable;

  await Guild.updateGuild(message.guild.id, {
    $set: { 'features.boostSystem.tierRewards': currentTiers }
  });

  return replySuccess(message, 'Tier Setting Updated',
    `${GLYPHS.SUCCESS} **Tier ${boostCount}** stackable setting is now **${stackable ? 'ON' : 'OFF'}**.\n\n` +
    (stackable
      ? 'Users will keep lower tier roles when reaching this tier.'
      : 'Lower tier roles will be removed when users reach this tier.'));
}

async function showTierHelp(message, prefix) {
  const p = `${prefix}boost`;
  const embed = new EmbedBuilder()
    .setColor(COLORS.RAPHAEL)
    .setTitle('『 Boost Tier Rewards 』')
    .setDescription('**Analysis:** Reward boosters with roles, Master.')
    .addFields(
      {
        name: '▸ Commands',
        value: [
          `\`${p} addtier <count> @role [stackable]\` - Add a tier reward`,
          `\`${p} removetier <count>\` - Remove a tier reward`,
          `\`${p} listtiers\` - View all configured tiers`,
          `\`${p} cleartiers\` - Remove all tier rewards`,
          `\`${p} stackable <count> <on/off>\` - Set whether tier roles stack`,
          `\`${p} tiermessage <on/off>\` - Show the earned tier in the boost message`
        ].join('\n')
      },
      { name: '▸ Example', value: `\`${p} addtier 1 @Booster\`` },
      { name: '▸ Detection', value: BOOST_DETECTION_NOTE },
      { name: '▸ Stackable', value: 'ON keeps lower tier roles; OFF replaces them with the higher tier.' }
    )
    .setFooter({ text: getRandomFooter() });

  return message.reply({ embeds: [embed] });
}

// ============================================
// BOOSTER PERKS ANNOUNCEMENT FUNCTIONS
// ============================================

function getPerksTitle(perks) {
  return perks.embedTitle?.trim() && !SCHEMA_DEFAULT_PERKS_TITLES.has(perks.embedTitle) ? perks.embedTitle : DEFAULT_PERKS_TITLE;
}

function getPerksMessage(perks) {
  return perks.message?.trim() && !SCHEMA_DEFAULT_PERKS_MESSAGES.has(perks.message) ? perks.message : DEFAULT_PERKS_MESSAGE;
}

async function handlePerksCommand(message, args, guildConfig, prefix) {
  const subAction = args[1]?.toLowerCase();

  switch (subAction) {
    case undefined:
    case 'status':
      return showPerksStatus(message, guildConfig, prefix);
    case 'channel':
      return setPerksChannel(message, args.slice(1), prefix);
    case 'message':
    case 'msg':
    case 'description':
    case 'desc':
      return setPerksMessage(message, args.slice(1), guildConfig, prefix);
    case 'title':
      return setPerksTitle(message, args.slice(1), prefix);
    case 'color':
    case 'colour':
      return setPerksColor(message, args.slice(1), prefix);
    case 'image':
    case 'banner':
      return setPerksBanner(message, args.slice(1), prefix);
    case 'thumbnail':
    case 'thumb':
      return setPerksThumbnail(message, args.slice(1), prefix);
    case 'footer':
      return setPerksFooter(message, args.slice(1), prefix);
    case 'preview':
      return previewPerksAnnouncement(message, guildConfig);
    case 'publish':
    case 'send':
      return publishPerksAnnouncement(message, args[2], guildConfig, prefix);
    case 'tierlist':
    case 'showtiers':
      return togglePerksTierList(message, args.slice(1), prefix);
    case 'reset':
      return resetPerksSettings(message);
    default:
      return showPerksHelp(message, prefix);
  }
}

async function showPerksStatus(message, guildConfig, prefix) {
  const perks = guildConfig.features?.boostSystem?.perksAnnouncement || {};
  const tiers = guildConfig.features?.boostSystem?.tierRewards || [];
  const thumbnail = perks.thumbnailType === 'none'
    ? 'None'
    : (perks.thumbnailType === 'custom' && perks.thumbnailUrl ? 'Custom image' : 'Server icon');

  const embed = new EmbedBuilder()
    .setColor(COLORS.RAPHAEL)
    .setTitle('『 Booster Perks Announcement 』')
    .setDescription(
      `**Analysis:** Current perks announcement configuration, Master.\n` +
      `Use \`${prefix}boost perks help\` for all commands and \`${prefix}boost publish\` to send it.`)
    .addFields(
      {
        name: '▸ Settings',
        value: [
          `Channel: ${describeChannel(message.guild, perks.channel)}`,
          `Show tier list: ${flag(perks.showTierList !== false)}`,
          `Configured tiers: ${tiers.length}`
        ].join('\n'),
        inline: true
      },
      {
        name: '▸ Appearance',
        value: [
          `Color: ${perks.embedColor || DEFAULT_BOOST_COLOR}`,
          `Title: ${perks.embedTitle && !SCHEMA_DEFAULT_PERKS_TITLES.has(perks.embedTitle) ? 'Custom' : 'Default'}`,
          `Banner: ${perks.bannerUrl ? 'Set' : 'Not set'}`,
          `Thumbnail: ${thumbnail}`
        ].join('\n'),
        inline: true
      },
      { name: '▸ Current Message', value: codeBlock(getPerksMessage(perks), 300), inline: false },
      {
        name: '▸ Last Published',
        value: perks.lastPublished
          ? `<t:${Math.floor(new Date(perks.lastPublished).getTime() / 1000)}:F>`
          : 'Never published',
        inline: false
      }
    )
    .setFooter({ text: getRandomFooter() });

  return message.reply({ embeds: [embed] });
}

async function setPerksChannel(message, args, prefix) {
  const channel = resolveChannel(message, args[1]);

  if (!channel) {
    return replyError(message, 'No Channel',
      `${GLYPHS.ERROR} Please mention a channel or provide a channel ID, Master.\n\n` +
      `**Usage:** \`${prefix}boost perks channel #booster-perks\``);
  }

  if (!ANNOUNCEMENT_CHANNEL_TYPES.includes(channel.type)) {
    return replyError(message, 'Invalid Channel', 'Please select a text or announcement channel, Master.');
  }

  await Guild.updateGuild(message.guild.id, {
    $set: { 'features.boostSystem.perksAnnouncement.channel': channel.id }
  });

  const problem = describeSendProblem(channel, message.guild);
  return replySuccess(message, 'Perks Channel Set',
    `${GLYPHS.SUCCESS} Booster perks announcements will be sent to ${channel}.\n\n` +
    `Use \`${prefix}boost publish\` to send the announcement.` +
    (problem ? `\n\n${GLYPHS.WARNING} ${problem} Publishing will fail until this is fixed.` : ''));
}

async function setPerksMessage(message, args, guildConfig, prefix) {
  const perksMsg = args.slice(1).join(' ');

  if (!perksMsg) {
    const currentMsg = getPerksMessage(guildConfig.features?.boostSystem?.perksAnnouncement || {});
    return replyInfo(message, 'Perks Message',
      `**Current Message:**\n${clampText(currentMsg, 1500)}\n\n` +
      `**Usage:** \`${prefix}boost perks message <your message>\`\n` +
      `Use \`${prefix}boost perks message reset\` to restore the default.\n\n` +
      `**Variables:**\n` +
      `${GLYPHS.DOT} \`{server}\` - Server name\n` +
      `${GLYPHS.DOT} \`{boostcount}\` - Total boost count\n` +
      `${GLYPHS.DOT} \`{boostlevel}\` - Server boost level\n` +
      `${GLYPHS.DOT} \`{membercount}\` - Member count\n` +
      `${GLYPHS.DOT} \`\\n\` - New line`);
  }

  if (isKeyword(perksMsg, ['reset', 'default'])) {
    await Guild.updateGuild(message.guild.id, {
      $set: { 'features.boostSystem.perksAnnouncement.message': null }
    });
    return replySuccess(message, 'Perks Message Reset', `${GLYPHS.SUCCESS} The perks message has been reset to the default.`);
  }

  if (perksMsg.length > PERKS_MESSAGE_MAX) {
    return replyError(message, 'Message Too Long',
      `The perks message can be at most ${PERKS_MESSAGE_MAX} characters, leaving room for the tier list, Master ` +
      `(yours is ${perksMsg.length}).`);
  }

  await Guild.updateGuild(message.guild.id, {
    $set: { 'features.boostSystem.perksAnnouncement.message': perksMsg }
  });

  return replySuccess(message, 'Perks Message Updated',
    `${GLYPHS.SUCCESS} Booster perks message has been updated.\n\n` +
    `**New Message:**\n${clampText(perksMsg, 200)}`);
}

async function setPerksTitle(message, args, prefix) {
  const title = args.slice(1).join(' ');

  if (!title) {
    return replyError(message, 'No Title',
      `${GLYPHS.ERROR} Please provide a title, Master.\n\n` +
      `**Usage:** \`${prefix}boost perks title Booster Perks & Rewards\`\n` +
      `Use \`${prefix}boost perks title reset\` to reset to default.`);
  }

  if (isKeyword(title, ['reset', 'default'])) {
    await Guild.updateGuild(message.guild.id, {
      $unset: { 'features.boostSystem.perksAnnouncement.embedTitle': '' }
    });
    return replySuccess(message, 'Title Reset', `${GLYPHS.SUCCESS} Perks embed title has been reset to default.`);
  }

  if (title.length > LIMITS.title) {
    return replyError(message, 'Title Too Long',
      `Embed titles can be at most ${LIMITS.title} characters, Master (yours is ${title.length}).`);
  }

  await Guild.updateGuild(message.guild.id, {
    $set: { 'features.boostSystem.perksAnnouncement.embedTitle': title }
  });

  return replySuccess(message, 'Title Updated', `${GLYPHS.SUCCESS} Perks embed title set to: **${title}**`);
}

async function setPerksColor(message, args, prefix) {
  const color = args[1];

  if (!color) {
    return replyError(message, 'No Color',
      `${GLYPHS.ERROR} Please provide a hex color code, Master.\n\n` +
      `**Usage:** \`${prefix}boost perks color #f47fff\``);
  }

  if (isKeyword(color, ['reset', 'default'])) {
    await Guild.updateGuild(message.guild.id, {
      $set: { 'features.boostSystem.perksAnnouncement.embedColor': DEFAULT_BOOST_COLOR }
    });
    return replySuccess(message, 'Color Reset',
      `${GLYPHS.SUCCESS} Perks embed color has been reset to default (${DEFAULT_BOOST_COLOR}).`);
  }

  const finalColor = parseHexColor(color);
  if (!finalColor) {
    return replyError(message, 'Invalid Color',
      `${GLYPHS.ERROR} Please provide a six-digit hex color code (e.g., #f47fff), Master.`);
  }

  await Guild.updateGuild(message.guild.id, {
    $set: { 'features.boostSystem.perksAnnouncement.embedColor': finalColor }
  });

  return replySuccess(message, 'Color Updated', `${GLYPHS.SUCCESS} Perks embed color set to: **${finalColor}**`);
}

async function setPerksBanner(message, args, prefix) {
  const url = args[1];

  if (!url) {
    return replyError(message, 'No URL',
      `${GLYPHS.ERROR} Please provide an image URL, Master.\n\n` +
      `**Usage:** \`${prefix}boost perks image <url>\`\n` +
      `Use \`${prefix}boost perks image remove\` to remove.`);
  }

  if (isKeyword(url, ['remove', 'reset', 'none'])) {
    await Guild.updateGuild(message.guild.id, {
      $unset: { 'features.boostSystem.perksAnnouncement.bannerUrl': '' }
    });
    return replySuccess(message, 'Banner Removed', `${GLYPHS.SUCCESS} Perks banner image has been removed.`);
  }

  if (!isHttpUrl(url)) {
    return replyError(message, 'Invalid URL',
      `${GLYPHS.ERROR} Please provide a valid image URL starting with http:// or https://, Master.`);
  }

  await Guild.updateGuild(message.guild.id, {
    $set: { 'features.boostSystem.perksAnnouncement.bannerUrl': url }
  });

  return replySuccess(message, 'Banner Set', `${GLYPHS.SUCCESS} Perks banner image has been updated.`);
}

async function setPerksThumbnail(message, args, prefix) {
  const value = args[1];

  if (!value) {
    return replyInfo(message, 'Thumbnail Options',
      `**Usage:** \`${prefix}boost perks thumbnail <option>\`\n\n` +
      `**Options:**\n` +
      `${GLYPHS.DOT} \`server\` - Server icon\n` +
      `${GLYPHS.DOT} \`<url>\` - Custom image URL\n` +
      `${GLYPHS.DOT} \`remove\` - No thumbnail`);
  }

  if (isKeyword(value, ['server', 'guild'])) {
    await Guild.updateGuild(message.guild.id, {
      $set: { 'features.boostSystem.perksAnnouncement.thumbnailType': 'server' },
      $unset: { 'features.boostSystem.perksAnnouncement.thumbnailUrl': '' }
    });
    return replySuccess(message, 'Thumbnail Updated', `${GLYPHS.SUCCESS} Perks thumbnail set to server icon.`);
  }

  if (isKeyword(value, ['remove', 'none'])) {
    await Guild.updateGuild(message.guild.id, {
      $set: { 'features.boostSystem.perksAnnouncement.thumbnailType': 'none' },
      $unset: { 'features.boostSystem.perksAnnouncement.thumbnailUrl': '' }
    });
    return replySuccess(message, 'Thumbnail Removed', `${GLYPHS.SUCCESS} Perks thumbnail has been removed.`);
  }

  // Custom URL, saved exactly as given (URL paths are case-sensitive)
  if (isHttpUrl(value)) {
    await Guild.updateGuild(message.guild.id, {
      $set: {
        'features.boostSystem.perksAnnouncement.thumbnailType': 'custom',
        'features.boostSystem.perksAnnouncement.thumbnailUrl': value
      }
    });
    return replySuccess(message, 'Thumbnail Updated', `${GLYPHS.SUCCESS} Perks thumbnail set to custom image.`);
  }

  return replyError(message, 'Invalid Option',
    `${GLYPHS.ERROR} Invalid option. Use \`server\`, \`remove\`, or a valid image URL, Master.`);
}

async function setPerksFooter(message, args, prefix) {
  const footer = args.slice(1).join(' ');

  if (!footer) {
    return replyError(message, 'No Footer',
      `${GLYPHS.ERROR} Please provide footer text, Master.\n\n` +
      `**Usage:** \`${prefix}boost perks footer Thank you for supporting us!\`\n` +
      `Use \`${prefix}boost perks footer reset\` to remove.`);
  }

  if (isKeyword(footer, ['reset', 'remove'])) {
    await Guild.updateGuild(message.guild.id, {
      $unset: { 'features.boostSystem.perksAnnouncement.footerText': '' }
    });
    return replySuccess(message, 'Footer Removed', `${GLYPHS.SUCCESS} Perks footer has been removed.`);
  }

  if (footer.length > LIMITS.footer) {
    return replyError(message, 'Footer Too Long',
      `Embed footers can be at most ${LIMITS.footer} characters, Master (yours is ${footer.length}).`);
  }

  await Guild.updateGuild(message.guild.id, {
    $set: { 'features.boostSystem.perksAnnouncement.footerText': footer }
  });

  return replySuccess(message, 'Footer Updated', `${GLYPHS.SUCCESS} Perks footer set to: **${footer}**`);
}

async function togglePerksTierList(message, args, prefix) {
  const enabled = parseToggle(args[1]);

  if (enabled === null) {
    return replyError(message, 'Invalid Option',
      `${GLYPHS.ERROR} Use \`${prefix}boost perks tierlist on\` or \`off\`, Master.\n\n` +
      `When enabled, the tier rewards list will be automatically included in the perks announcement.`);
  }

  await Guild.updateGuild(message.guild.id, {
    $set: { 'features.boostSystem.perksAnnouncement.showTierList': enabled }
  });

  return replySuccess(message, 'Tier List Setting Updated',
    `${GLYPHS.SUCCESS} Auto tier list in perks announcement is now **${enabled ? 'enabled' : 'disabled'}**.`);
}

async function previewPerksAnnouncement(message, guildConfig) {
  const embed = buildPerksEmbed(message.guild, guildConfig);

  if (!message.channel) {
    return replyError(message, 'Preview Failed', 'I cannot post in this channel, Master.');
  }

  await replyInfo(message, 'Perks Preview', 'Here is how your booster perks announcement will look, Master:');

  try {
    await message.channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
  } catch (error) {
    console.error('[BOOST PERKS] Preview failed:', error);
    return replyError(message, 'Preview Failed', `The preview could not be sent here, Master: ${error.message}`);
  }
}

// The announcement posted by the last publish, if it is still in `channel`
async function findPublishedPerks(channel, messageId) {
  if (!messageId) return null;
  const existing = await channel.messages.fetch(messageId).catch(() => null);
  return existing?.author?.id === channel.client.user.id ? existing : null;
}

// option "new" posts a fresh announcement; otherwise the last one is updated when it still exists
async function publishPerksAnnouncement(message, option, guildConfig, prefix) {
  const perks = guildConfig.features?.boostSystem?.perksAnnouncement || {};
  const channelId = perks.channel;
  const forceNew = isKeyword(option, ['new', 'repost']);

  if (!channelId) {
    return replyError(message, 'No Channel Set',
      `${GLYPHS.ERROR} Please set a perks announcement channel first, Master.\n\n` +
      `**Usage:** \`${prefix}boost perks channel #booster-perks\``);
  }

  const channel = message.guild.channels.cache.get(channelId);
  if (!channel) {
    return replyError(message, 'Channel Not Found',
      `${GLYPHS.ERROR} The configured perks channel no longer exists. Please set a new one, Master.`);
  }

  const problem = describeSendProblem(channel, message.guild);
  if (problem) {
    return replyError(message, 'Missing Permissions', `${GLYPHS.ERROR} ${problem} Please fix this first, Master.`);
  }

  const embed = buildPerksEmbed(message.guild, guildConfig);
  const payload = { content: null, embeds: [embed], allowedMentions: { parse: [] } };
  const existing = forceNew ? null : await findPublishedPerks(channel, perks.messageId);

  let posted;
  try {
    posted = existing ? await existing.edit(payload) : await channel.send(payload);
  } catch (error) {
    console.error('[BOOST PERKS] Error publishing announcement:', error);
    return replyError(message, 'Failed to Publish',
      `${GLYPHS.ERROR} Failed to send the announcement, Master: ${error.message}`);
  }

  await Guild.updateGuild(message.guild.id, {
    $set: {
      'features.boostSystem.perksAnnouncement.lastPublished': new Date(),
      'features.boostSystem.perksAnnouncement.messageId': posted.id
    }
  });

  return replySuccess(message, existing ? 'Announcement Updated' : 'Announcement Published', existing
    ? `${GLYPHS.SUCCESS} The booster perks announcement in ${channel} has been updated: ${posted.url}\n\n` +
      `Use \`${prefix}boost publish new\` to post a new one instead.`
    : `${GLYPHS.SUCCESS} Booster perks announcement has been sent to ${channel}: ${posted.url}`);
}

async function resetPerksSettings(message) {
  const base = 'features.boostSystem.perksAnnouncement';
  await Guild.updateGuild(message.guild.id, {
    $set: {
      [`${base}.channel`]: null,
      [`${base}.message`]: null,
      [`${base}.embedEnabled`]: true,
      [`${base}.embedColor`]: DEFAULT_BOOST_COLOR,
      [`${base}.embedTitle`]: null,
      [`${base}.bannerUrl`]: null,
      [`${base}.thumbnailType`]: 'server',
      [`${base}.thumbnailUrl`]: null,
      [`${base}.footerText`]: null,
      [`${base}.showTimestamp`]: true,
      [`${base}.showTierList`]: true,
      [`${base}.lastPublished`]: null,
      [`${base}.messageId`]: null
    }
  });

  return replySuccess(message, 'Perks Settings Reset',
    `${GLYPHS.SUCCESS} All booster perks announcement settings have been reset to defaults.`);
}

// The public tier list: whole lines only, tiers whose role was deleted left out
function formatPerksTierList(guild, tiers, maxLength) {
  const lines = [...tiers]
    .sort((a, b) => a.boostCount - b.boostCount)
    .map(tier => ({ tier, role: guild.roles.cache.get(tier.roleId) }))
    .filter(({ role }) => role)
    .map(({ tier, role }) => `◆ **${tier.boostCount}+ Boost${tier.boostCount === 1 ? '' : 's'}** — ${role}`);

  const kept = [];
  let length = 0;
  for (const [index, line] of lines.entries()) {
    // Room for this line and, when more follow, the "and N more" line
    const moreLength = index < lines.length - 1 ? 30 : 0;
    if (length + line.length + 1 + moreLength > maxLength) {
      kept.push(`› and ${lines.length - index} more`);
      break;
    }
    kept.push(line);
    length += line.length + 1;
  }
  return kept.join('\n');
}

function buildPerksEmbed(guild, guildConfig) {
  const perks = guildConfig.features?.boostSystem?.perksAnnouncement || {};
  const tiers = guildConfig.features?.boostSystem?.tierRewards || [];

  const title = clampText(getPerksTitle(perks), LIMITS.title);
  const footer = perks.footerText?.trim()
    ? clampText(perks.footerText, LIMITS.footer)
    : `Server Boost Level: ${guild.premiumTier} • ${guild.premiumSubscriptionCount || 0} Boosts`;

  const embed = new EmbedBuilder()
    .setColor(isValidColor(perks.embedColor) ? perks.embedColor : DEFAULT_BOOST_COLOR)
    .setTitle(title)
    .setFooter({ text: footer });

  // Parse message with variables (replacer functions keep "$" in names literal)
  const text = getPerksMessage(perks)
    .replace(/{server}/gi, () => guild.name)
    .replace(/{boostcount}/gi, () => String(guild.premiumSubscriptionCount || 0))
    .replace(/{boostlevel}/gi, () => String(guild.premiumTier ?? 0))
    .replace(/{membercount}/gi, () => String(guild.memberCount ?? 0))
    .replace(/\\n/g, '\n');

  // Keep the whole embed under Discord's 6000 character limit
  const room = Math.min(LIMITS.description, LIMITS.embed - title.length - footer.length);
  let description = clampText(text, room);

  if (perks.showTierList !== false && tiers.length > 0) {
    const heading = '\n\n**Tier Rewards:**\n';
    const tierList = formatPerksTierList(guild, tiers, room - description.length - heading.length);
    if (tierList) description += heading + tierList;
  }

  embed.setDescription(description);

  // Thumbnail
  if (perks.thumbnailType === 'server' || !perks.thumbnailType) {
    embed.setThumbnail(guild.iconURL({ size: 256 }));
  } else if (perks.thumbnailType === 'custom') {
    embed.setThumbnail(toImageUrl(perks.thumbnailUrl));
  }

  // Banner
  const banner = toImageUrl(perks.bannerUrl);
  if (banner) embed.setImage(banner);

  // Timestamp
  if (perks.showTimestamp !== false) {
    embed.setTimestamp();
  }

  return embed;
}

async function showPerksHelp(message, prefix) {
  const p = `${prefix}boost perks`;
  const embed = new EmbedBuilder()
    .setColor(COLORS.RAPHAEL)
    .setTitle('『 Booster Perks Announcement 』')
    .setDescription('**Analysis:** A customizable announcement of booster perks, separate from the boost thank you channel, Master.')
    .addFields(
      {
        name: '▸ Setup',
        value: [
          `\`${p} channel #channel\` - Set announcement channel`,
          `\`${p} tierlist on/off\` - Include the tier rewards list`,
          `\`${p} reset\` - Reset all settings`
        ].join('\n')
      },
      {
        name: '▸ Content',
        value: [
          `\`${p} message <text>\` - Set description`,
          `\`${p} title <text>\` / \`${p} footer <text>\``,
          `\`${p} color #HEX\` / \`${p} image <url>\``,
          `\`${p} thumbnail <server|url|remove>\``
        ].join('\n')
      },
      {
        name: '▸ Publishing',
        value: [
          `\`${p} preview\` - Preview announcement`,
          `\`${prefix}boost publish\` - Post it, or update the one posted last`,
          `\`${prefix}boost publish new\` - Post a new announcement`
        ].join('\n')
      },
      { name: '▸ Variables', value: '`{server}` `{boostcount}` `{boostlevel}` `{membercount}` `\\n` (new line)' }
    )
    .setFooter({ text: getRandomFooter() });

  return message.reply({ embeds: [embed] });
}
