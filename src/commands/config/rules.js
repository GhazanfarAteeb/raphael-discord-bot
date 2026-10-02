import {
  PermissionFlagsBits,
  EmbedBuilder,
  ChannelType,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  MessageFlags
} from 'discord.js';
import Guild from '../../models/Guild.js';
import { successEmbed, errorEmbed, infoEmbed, warningEmbed, GLYPHS, COLORS } from '../../utils/embeds.js';
import { hasModPerms, getPrefix } from '../../utils/helpers.js';
import { getRandomFooter } from '../../utils/raphael.js';

const DEFAULT_RULES_TITLE = '『 Server Rules 』';
// Schema defaults stored for guilds that never set a title (the old emoji one and the
// current one); both render as the default above
const SCHEMA_DEFAULT_RULES_TITLES = new Set(['📜 Server Rules', 'Server Rules']);
const DEFAULT_RULES_COLOR = '#5865F2';

// Discord limits: description 4096, all embed text in one message 6000
const LIMITS = { title: 256, footer: 2048, description: 4096, messageTotal: 6000 };
// One rule fits an embed field and keeps the published list readable
const RULE_MAX = 1000;
const LIST_CHUNK_MAX = 4000;
const CONFIRM_TIMEOUT = 30_000;
const RULES_CHANNEL_TYPES = [ChannelType.GuildText, ChannelType.GuildAnnouncement];

export default {
  name: 'rules',
  category: 'config',
  description: 'Send server rules to a channel',
  usage: '<send|set|add|remove|edit|list|preview|channel|title|color|footer|image|clear|help>',
  aliases: ['serverrules'],
  permissions: [PermissionFlagsBits.ManageGuild],
  cooldown: 5,

  async execute(message, args) {
    try {
      return await runRulesCommand(message, args);
    } catch (error) {
      console.error('[Rules] Error:', error);
      return message.reply({
        embeds: [await errorEmbed(message.guild.id, 'Rules Error',
          'An anomaly occurred while processing this request, Master. Please try again.')]
      }).catch(() => { });
    }
  }
};

async function runRulesCommand(message, args) {
  const guildConfig = await Guild.getGuild(message.guild.id, message.guild.name);
  const prefix = await getPrefix(message.guild.id);

  // Check for moderator permissions
  if (!hasModPerms(message.member, guildConfig)) {
    return replyError(message, 'Permission Denied',
      `${GLYPHS.LOCK} You need Moderator/Staff permissions to manage rules, Master.`);
  }

  if (!args[0]) {
    return showStatus(message, guildConfig, prefix);
  }

  const action = args[0].toLowerCase();
  const rest = args.slice(1);

  switch (action) {
    case 'status':
      return showStatus(message, guildConfig, prefix);

    case 'send':
    case 'post':
      return sendRules(message, rest, guildConfig, prefix);

    case 'set':
      return setAllRules(message, rest, prefix);

    case 'add':
      return addRule(message, rest, prefix);

    case 'remove':
    case 'delete':
      return removeRule(message, rest, guildConfig, prefix);

    case 'edit':
      return editRule(message, rest, guildConfig, prefix);

    case 'list':
      return listRules(message, guildConfig, prefix);

    case 'preview':
      return previewRules(message, guildConfig, prefix);

    case 'channel':
      return setChannel(message, rest, guildConfig, prefix);

    case 'title':
      return setTitle(message, rest, guildConfig, prefix);

    case 'color':
    case 'colour':
      return setColor(message, rest, guildConfig, prefix);

    case 'footer':
      return setFooter(message, rest, guildConfig, prefix);

    case 'image':
    case 'banner':
      return setBanner(message, rest, guildConfig, prefix);

    case 'clear':
      return clearRules(message);

    case 'help':
      return showHelp(message, prefix);

    default:
      return replyError(message, 'Unknown Option',
        `Unknown option: \`${action}\`\n\nUse \`${prefix}rules help\` for available commands, Master.`);
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

// Whole positive numbers only: parseInt would accept "2abc"
function parseRuleNumber(value) {
  return /^\d+$/.test(String(value ?? '')) ? Number(value) : NaN;
}

function isKeyword(value, keywords) {
  return keywords.includes(String(value ?? '').toLowerCase());
}

function clampText(text, max) {
  const value = String(text ?? '');
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

// Rules are stored with literal "\n" for line breaks
function formatRule(rule) {
  return String(rule).replace(/\\n/g, '\n');
}

function numberedRules(rules) {
  return rules.map((rule, index) => `**${index + 1}.** ${formatRule(rule)}`);
}

// Groups lines into chunks of at most `max` characters; a single over-long line is shortened
function chunkLines(lines, max, separator = '\n\n') {
  const chunks = [];
  let current = '';
  for (const rawLine of lines) {
    const line = clampText(rawLine, max);
    const next = current ? current + separator + line : line;
    if (next.length > max) {
      chunks.push(current);
      current = line;
    } else {
      current = next;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

// The first rules that fit in `max` characters, with a note about the rest
function summarizeRules(rules, max) {
  const NOTE_ROOM = 30;
  let text = '';
  let shown = 0;
  for (const line of numberedRules(rules)) {
    const next = text ? `${text}\n${line}` : line;
    if (next.length > max - NOTE_ROOM) break;
    text = next;
    shown++;
  }
  const rest = rules.length - shown;
  return rest > 0 ? `${text}${text ? '\n' : ''}…and ${rest} more` : text;
}

function getRulesTitle(rulesConfig) {
  const title = rulesConfig.title;
  return title?.trim() && !SCHEMA_DEFAULT_RULES_TITLES.has(title) ? title : DEFAULT_RULES_TITLE;
}

function getRulesFooter(rulesConfig, guild) {
  const footer = rulesConfig.footer;
  if (footer === ' ') return null; // removed
  return footer?.trim() ? footer : `${guild.name} • Please follow these rules!`;
}

function describeChannel(guild, channelId) {
  if (!channelId) return 'Not configured';
  const channel = guild.channels.cache.get(channelId);
  return channel ? `${channel}` : `${GLYPHS.ERROR} No longer exists (\`${channelId}\`)`;
}

function cannotSendIn(channel, me) {
  return !channel.permissionsFor(me)?.has([
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.EmbedLinks
  ]);
}

/**
 * The public rules embeds. Long rule sets are split over several embeds (one per message):
 * the first carries the title and thumbnail, the last the footer, banner and timestamp.
 */
function buildRulesEmbeds(guildConfig, guild) {
  const rulesConfig = guildConfig.rulesSystem || {};
  const title = clampText(getRulesTitle(rulesConfig), LIMITS.title);
  const footer = getRulesFooter(rulesConfig, guild);
  const footerText = footer ? clampText(footer, LIMITS.footer) : null;
  const color = /^#[0-9a-f]{6}$/i.test(rulesConfig.embedColor ?? '') ? rulesConfig.embedColor : DEFAULT_RULES_COLOR;

  // Each message's embed text must stay within Discord's 6000 character total
  const chunkMax = Math.min(LIMITS.description, LIMITS.messageTotal - title.length - (footerText?.length ?? 0));
  const chunks = chunkLines(numberedRules(rulesConfig.rules || []), chunkMax);
  const icon = guild.iconURL({ size: 256 });

  return chunks.map((chunk, index) => {
    const embed = new EmbedBuilder().setColor(color).setDescription(chunk);

    if (index === 0) {
      embed.setTitle(title);
      if (icon) embed.setThumbnail(icon);
    }

    if (index === chunks.length - 1) {
      if (footerText) embed.setFooter({ text: footerText });
      if (rulesConfig.bannerUrl) embed.setImage(rulesConfig.bannerUrl);
      embed.setTimestamp();
    }

    return embed;
  });
}

async function sendEmbeds(channel, embeds) {
  for (const embed of embeds) {
    await channel.send({ embeds: [embed] });
  }
}

// ============================================
// Views
// ============================================

async function showStatus(message, guildConfig, prefix) {
  const rulesConfig = guildConfig.rulesSystem || {};
  const rules = rulesConfig.rules || [];

  const embed = new EmbedBuilder()
    .setColor(COLORS.RAPHAEL)
    .setTitle('『 Server Rules System 』')
    .setDescription(`**Analysis:** Create and send server rules to any channel, Master.\nUse \`${prefix}rules help\` for all options.`)
    .addFields(
      { name: '▸ Rules Count', value: `${rules.length} rule${rules.length === 1 ? '' : 's'}`, inline: true },
      { name: '▸ Default Channel', value: describeChannel(message.guild, rulesConfig.channel), inline: true },
      { name: '▸ Title', value: clampText(getRulesTitle(rulesConfig), 200), inline: true },
      {
        name: '▸ Commands',
        value: [
          `\`${prefix}rules add <rule>\` - Add a new rule`,
          `\`${prefix}rules remove <#>\` - Remove a rule`,
          `\`${prefix}rules list\` - View all rules`,
          `\`${prefix}rules preview\` - Preview the embed`,
          `\`${prefix}rules send [#channel]\` - Send rules`
        ].join('\n')
      }
    )
    .setFooter({ text: getRandomFooter() });

  return message.reply({ embeds: [embed] });
}

async function showHelp(message, prefix) {
  const p = `${prefix}rules`;
  const embed = new EmbedBuilder()
    .setColor(COLORS.RAPHAEL)
    .setTitle('『 Rules Commands 』')
    .setDescription('**Analysis:** Commands for managing server rules, Master.')
    .addFields(
      {
        name: '▸ Rule Management',
        value: [
          `\`${p} add <rule>\` - Add a new rule`,
          `\`${p} remove <number>\` - Remove a rule by number`,
          `\`${p} edit <number> <new text>\` - Edit a rule`,
          `\`${p} set <rule1 | rule2 | ...>\` - Set all rules at once`,
          `\`${p} list\` - View all current rules`,
          `\`${p} clear\` - Remove all rules`
        ].join('\n')
      },
      {
        name: '▸ Customization',
        value: [
          `\`${p} title <text>\` / \`${p} footer <text>\``,
          `\`${p} color #hex\` / \`${p} image <url>\``,
          `\`${p} channel #channel\` - Set default channel`
        ].join('\n')
      },
      {
        name: '▸ Sending',
        value: [
          `\`${p} preview\` - Preview rules in current channel`,
          `\`${p} send\` - Send to default channel`,
          `\`${p} send #channel\` - Send to specific channel`
        ].join('\n')
      },
      {
        name: '▸ Tips',
        value: [
          `• Use \`|\` to separate multiple rules with \`${p} set\``,
          '• Rule numbers start at 1',
          `• Use \`\\n\` for line breaks within a rule (max ${RULE_MAX} characters per rule)`
        ].join('\n')
      }
    )
    .setFooter({ text: getRandomFooter() });

  return message.reply({ embeds: [embed] });
}

async function listRules(message, guildConfig, prefix) {
  const rules = guildConfig.rulesSystem?.rules || [];

  if (rules.length === 0) {
    return replyInfo(message, 'No Rules',
      `No rules have been set yet.\n\nUse \`${prefix}rules add <rule>\` to add rules.`);
  }

  const chunks = chunkLines(numberedRules(rules), LIST_CHUNK_MAX);
  const embeds = chunks.map((chunk, index) => {
    const embed = new EmbedBuilder().setColor(COLORS.RAPHAEL).setDescription(chunk);
    if (index === 0) embed.setTitle('『 Current Rules 』');
    if (index === chunks.length - 1) {
      embed.setFooter({ text: `${rules.length} rules total • Use ${prefix}rules edit <#> <text> to modify` });
    }
    return embed;
  });

  const [first, ...rest] = embeds;
  await message.reply({ embeds: [first] });
  await sendEmbeds(message.channel, rest);
}

async function previewRules(message, guildConfig, prefix) {
  const rules = guildConfig.rulesSystem?.rules || [];

  if (rules.length === 0) {
    return replyError(message, 'No Rules',
      `No rules have been set yet.\n\nUse \`${prefix}rules add <rule>\` to add rules.`);
  }

  await replyInfo(message, 'Preview', 'Here is how your rules will look, Master:');

  try {
    await sendEmbeds(message.channel, buildRulesEmbeds(guildConfig, message.guild));
  } catch (error) {
    console.error('[Rules] Preview failed:', error);
    return replyError(message, 'Preview Failed', `The preview could not be sent here, Master: ${error.message}`);
  }
}

// ============================================
// Rule management
// ============================================

async function addRule(message, args, prefix) {
  const ruleText = args.join(' ');

  if (!ruleText) {
    return replyError(message, 'Missing Rule',
      `Please provide the rule text, Master.\n\n**Usage:** \`${prefix}rules add <rule text>\``);
  }

  if (ruleText.length > RULE_MAX) {
    return replyError(message, 'Rule Too Long',
      `A rule can be at most ${RULE_MAX} characters, Master (yours is ${ruleText.length}).`);
  }

  const updated = await Guild.updateGuild(message.guild.id, {
    $push: { 'rulesSystem.rules': ruleText }
  });
  const newNumber = updated?.rulesSystem?.rules?.length ?? 1;

  return replySuccess(message, 'Rule Added',
    `${GLYPHS.SUCCESS} Rule #${newNumber} has been added:\n\n**${newNumber}.** ${formatRule(ruleText)}`);
}

async function removeRule(message, args, guildConfig, prefix) {
  const ruleNum = parseRuleNumber(args[0]);
  const rules = guildConfig.rulesSystem?.rules || [];

  if (!ruleNum) {
    return replyError(message, 'Invalid Number',
      `Please provide a valid rule number, Master.\n\n**Usage:** \`${prefix}rules remove <number>\``);
  }

  if (ruleNum > rules.length) {
    return replyError(message, 'Invalid Rule Number',
      `Rule #${ruleNum} does not exist. You have ${rules.length} rule${rules.length === 1 ? '' : 's'}.`);
  }

  const removedRule = rules[ruleNum - 1];
  const newRules = rules.filter((_, index) => index !== ruleNum - 1);

  await Guild.updateGuild(message.guild.id, {
    $set: { 'rulesSystem.rules': newRules }
  });

  return replySuccess(message, 'Rule Removed',
    `${GLYPHS.SUCCESS} Rule #${ruleNum} has been removed:\n\n~~${clampText(formatRule(removedRule), 3000)}~~`);
}

async function editRule(message, args, guildConfig, prefix) {
  const ruleNum = parseRuleNumber(args[0]);
  const newText = args.slice(1).join(' ');
  const rules = guildConfig.rulesSystem?.rules || [];

  if (!ruleNum) {
    return replyError(message, 'Invalid Number',
      `Please provide a valid rule number, Master.\n\n**Usage:** \`${prefix}rules edit <number> <new text>\``);
  }

  if (!newText) {
    return replyError(message, 'Missing Text',
      `Please provide the new rule text, Master.\n\n**Usage:** \`${prefix}rules edit <number> <new text>\``);
  }

  if (newText.length > RULE_MAX) {
    return replyError(message, 'Rule Too Long',
      `A rule can be at most ${RULE_MAX} characters, Master (yours is ${newText.length}).`);
  }

  if (ruleNum > rules.length) {
    return replyError(message, 'Invalid Rule Number',
      `Rule #${ruleNum} does not exist. You have ${rules.length} rule${rules.length === 1 ? '' : 's'}.`);
  }

  const newRules = [...rules];
  newRules[ruleNum - 1] = newText;

  await Guild.updateGuild(message.guild.id, {
    $set: { 'rulesSystem.rules': newRules }
  });

  return replySuccess(message, 'Rule Updated',
    `${GLYPHS.SUCCESS} Rule #${ruleNum} has been updated:\n\n**${ruleNum}.** ${formatRule(newText)}`);
}

async function setAllRules(message, args, prefix) {
  const rulesText = args.join(' ');

  if (!rulesText) {
    return replyInfo(message, 'Set All Rules',
      `Set multiple rules at once by separating them with \`|\`\n\n` +
      `**Usage:**\n\`${prefix}rules set Rule 1 | Rule 2 | Rule 3\`\n\n` +
      `**Example:**\n\`${prefix}rules set Be respectful | No spam | No NSFW\``);
  }

  const rules = rulesText.split('|').map(r => r.trim()).filter(r => r.length > 0);

  if (rules.length === 0) {
    return replyError(message, 'No Rules', 'No valid rules found. Make sure to separate rules with `|`, Master.');
  }

  const tooLong = rules.findIndex(rule => rule.length > RULE_MAX);
  if (tooLong !== -1) {
    return replyError(message, 'Rule Too Long',
      `Rule #${tooLong + 1} is ${rules[tooLong].length} characters; a rule can be at most ${RULE_MAX}, Master. Nothing was saved.`);
  }

  await Guild.updateGuild(message.guild.id, {
    $set: { 'rulesSystem.rules': rules }
  });

  return replySuccess(message, 'Rules Set',
    `${GLYPHS.SUCCESS} Set ${rules.length} rule${rules.length === 1 ? '' : 's'}:\n\n${summarizeRules(rules, 3000)}`);
}

async function clearRules(message) {
  const guildId = message.guild.id;
  const row = new ActionRowBuilder()
    .addComponents(
      new ButtonBuilder()
        .setCustomId('rules_clear_confirm')
        .setLabel('Yes, clear all')
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId('rules_clear_cancel')
        .setLabel('Cancel')
        .setStyle(ButtonStyle.Secondary)
    );

  const response = await message.reply({
    embeds: [await warningEmbed(guildId, 'Confirm Clear',
      'Are you sure you want to delete ALL rules, Master?\n\nThis action cannot be undone.')],
    components: [row]
  });
  if (!response) return;

  const collector = response.createMessageComponentCollector({
    componentType: ComponentType.Button,
    time: CONFIRM_TIMEOUT
  });

  collector.on('collect', async (interaction) => {
    try {
      if (interaction.user.id !== message.author.id) {
        return await interaction.reply({
          content: 'Only the member who ran this command can answer it, Master.',
          flags: MessageFlags.Ephemeral
        });
      }

      collector.stop('answered');

      if (interaction.customId === 'rules_clear_confirm') {
        await Guild.updateGuild(guildId, { $set: { 'rulesSystem.rules': [] } });
        await interaction.update({
          embeds: [await successEmbed(guildId, 'Rules Cleared', `${GLYPHS.SUCCESS} All rules have been deleted.`)],
          components: []
        });
      } else {
        await interaction.update({
          embeds: [await infoEmbed(guildId, 'Cancelled', 'Rule deletion cancelled.')],
          components: []
        });
      }
    } catch (error) {
      console.error('[Rules] Clear confirmation failed:', error);
      const failure = {
        embeds: [await errorEmbed(guildId, 'Clear Failed', 'The rules could not be cleared, Master. Please try again.')],
        components: []
      };
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp({ ...failure, flags: MessageFlags.Ephemeral }).catch(() => { });
      } else {
        await interaction.update(failure).catch(() => { });
      }
    }
  });

  collector.on('end', async (_collected, reason) => {
    if (reason !== 'time') return;
    try {
      await response.edit({
        embeds: [await infoEmbed(guildId, 'Timed Out', 'Confirmation timed out. Rules were not deleted.')],
        components: []
      });
    } catch (error) {
      console.error('[Rules] Could not mark the clear confirmation as timed out:', error.message);
    }
  });
}

// ============================================
// Sending
// ============================================

async function sendRules(message, args, guildConfig, prefix) {
  const rules = guildConfig.rulesSystem?.rules || [];

  if (rules.length === 0) {
    return replyError(message, 'No Rules',
      `No rules have been set yet.\n\nUse \`${prefix}rules add <rule>\` to add rules first.`);
  }

  // Channel from the arguments, then the default channel, then this channel
  let channel;
  if (args[0]) {
    channel = message.mentions.channels.first() || message.guild.channels.cache.get(args[0]);
    if (!channel) {
      return replyError(message, 'Channel Not Found',
        `I could not find that channel, Master.\n\n**Usage:** \`${prefix}rules send [#channel]\``);
    }
  } else if (guildConfig.rulesSystem?.channel) {
    channel = message.guild.channels.cache.get(guildConfig.rulesSystem.channel);
    if (!channel) {
      return replyError(message, 'Channel Not Found',
        `The default rules channel no longer exists, Master.\n\n` +
        `Use \`${prefix}rules channel #channel\` to set a new one, or \`${prefix}rules send #channel\`.`);
    }
  } else {
    channel = message.channel;
  }

  if (!RULES_CHANNEL_TYPES.includes(channel.type)) {
    return replyError(message, 'Invalid Channel', 'Please select a text or announcement channel, Master.');
  }

  if (cannotSendIn(channel, message.guild.members.me)) {
    return replyError(message, 'Missing Permissions', `I cannot send messages with embeds in ${channel}, Master.`);
  }

  try {
    await sendEmbeds(channel, buildRulesEmbeds(guildConfig, message.guild));
  } catch (error) {
    console.error('[Rules] Send failed:', error);
    return replyError(message, 'Send Failed', `The rules could not be sent to ${channel}, Master: ${error.message}`);
  }

  // A prefix command in the rules channel itself stays quiet so nothing sits under the rules;
  // slash commands (no react method) always need a reply to replace their placeholder
  if (channel.id !== message.channel.id || typeof message.react !== 'function') {
    return replySuccess(message, 'Rules Sent', `${GLYPHS.SUCCESS} Rules have been sent to ${channel}.`);
  }
}

// ============================================
// Settings
// ============================================

async function setChannel(message, args, guildConfig, prefix) {
  if (!args[0]) {
    return replyInfo(message, 'Default Rules Channel',
      `**Current Channel:** ${describeChannel(message.guild, guildConfig.rulesSystem?.channel)}\n\n` +
      `**Usage:**\n\`${prefix}rules channel #channel\` - Set the default channel\n` +
      `\`${prefix}rules channel none\` - Clear it`);
  }

  if (isKeyword(args[0], ['none', 'reset', 'remove'])) {
    await Guild.updateGuild(message.guild.id, {
      $set: { 'rulesSystem.channel': null }
    });
    return replySuccess(message, 'Channel Cleared',
      `${GLYPHS.SUCCESS} Default rules channel cleared. \`${prefix}rules send\` will post in the current channel.`);
  }

  const channel = message.mentions.channels.first() ||
    message.guild.channels.cache.get(args[0]);

  if (!channel) {
    return replyError(message, 'No Channel',
      `Please mention a channel or provide a channel ID, Master.\n\n**Usage:** \`${prefix}rules channel #channel\``);
  }

  if (!RULES_CHANNEL_TYPES.includes(channel.type)) {
    return replyError(message, 'Invalid Channel', 'Please select a text or announcement channel, Master.');
  }

  await Guild.updateGuild(message.guild.id, {
    $set: { 'rulesSystem.channel': channel.id }
  });

  return replySuccess(message, 'Channel Set', `${GLYPHS.SUCCESS} Default rules channel set to ${channel}.`);
}

async function setTitle(message, args, guildConfig, prefix) {
  const title = args.join(' ');

  if (!title) {
    return replyInfo(message, 'Embed Title',
      `**Current Title:** ${getRulesTitle(guildConfig.rulesSystem || {})}\n\n` +
      `**Usage:**\n\`${prefix}rules title <text>\` - Set custom title\n` +
      `\`${prefix}rules title reset\` - Reset to default`);
  }

  if (isKeyword(title, ['reset', 'default'])) {
    await Guild.updateGuild(message.guild.id, {
      $set: { 'rulesSystem.title': null }
    });
    return replySuccess(message, 'Title Reset', `${GLYPHS.SUCCESS} Rules title reset to default.`);
  }

  if (title.length > LIMITS.title) {
    return replyError(message, 'Title Too Long',
      `Embed titles can be at most ${LIMITS.title} characters, Master (yours is ${title.length}).`);
  }

  await Guild.updateGuild(message.guild.id, {
    $set: { 'rulesSystem.title': title }
  });

  return replySuccess(message, 'Title Set', `${GLYPHS.SUCCESS} Rules title set to: ${title}`);
}

async function setColor(message, args, guildConfig, prefix) {
  const colorHex = args[0];

  if (!colorHex) {
    return replyInfo(message, 'Embed Color',
      `**Current Color:** ${guildConfig.rulesSystem?.embedColor || DEFAULT_RULES_COLOR}\n\n` +
      `**Usage:**\n\`${prefix}rules color #hex\` - Set custom color\n` +
      `\`${prefix}rules color reset\` - Reset to default`);
  }

  if (isKeyword(colorHex, ['reset', 'default'])) {
    await Guild.updateGuild(message.guild.id, {
      $set: { 'rulesSystem.embedColor': null }
    });
    return replySuccess(message, 'Color Reset', `${GLYPHS.SUCCESS} Rules embed color reset to default.`);
  }

  const match = colorHex.match(/^#?([0-9a-f]{6})$/i);
  if (!match) {
    return replyError(message, 'Invalid Color', 'Please provide a six-digit hex color code (e.g., #5865F2), Master.');
  }

  const normalizedColor = `#${match[1]}`;
  await Guild.updateGuild(message.guild.id, {
    $set: { 'rulesSystem.embedColor': normalizedColor }
  });

  return replySuccess(message, 'Color Set', `${GLYPHS.SUCCESS} Rules embed color set to: ${normalizedColor}`);
}

async function setFooter(message, args, guildConfig, prefix) {
  const footerText = args.join(' ');

  if (!footerText) {
    const current = guildConfig.rulesSystem?.footer;
    return replyInfo(message, 'Embed Footer',
      `**Current Footer:** ${current?.trim() ? current : (current === ' ' ? 'Hidden' : 'Default (server name)')}\n\n` +
      `**Usage:**\n\`${prefix}rules footer <text>\` - Set footer\n` +
      `\`${prefix}rules footer none\` - Remove footer\n` +
      `\`${prefix}rules footer reset\` - Reset to default`);
  }

  if (isKeyword(footerText, ['reset', 'default'])) {
    await Guild.updateGuild(message.guild.id, {
      $set: { 'rulesSystem.footer': null }
    });
    return replySuccess(message, 'Footer Reset', `${GLYPHS.SUCCESS} Rules footer reset to default.`);
  }

  if (isKeyword(footerText, ['none', 'remove'])) {
    await Guild.updateGuild(message.guild.id, {
      $set: { 'rulesSystem.footer': ' ' }
    });
    return replySuccess(message, 'Footer Removed', `${GLYPHS.SUCCESS} Rules footer has been removed.`);
  }

  if (footerText.length > LIMITS.footer) {
    return replyError(message, 'Footer Too Long',
      `Embed footers can be at most ${LIMITS.footer} characters, Master (yours is ${footerText.length}).`);
  }

  await Guild.updateGuild(message.guild.id, {
    $set: { 'rulesSystem.footer': footerText }
  });

  return replySuccess(message, 'Footer Set', `${GLYPHS.SUCCESS} Rules footer set to: ${footerText}`);
}

async function setBanner(message, args, guildConfig, prefix) {
  const imageUrl = args[0];

  if (!imageUrl) {
    return replyInfo(message, 'Rules Banner',
      guildConfig.rulesSystem?.bannerUrl
        ? `**Current Banner:**\n${guildConfig.rulesSystem.bannerUrl}\n\nUse \`${prefix}rules image remove\` to remove it.`
        : `No banner set.\n\n**Usage:**\n\`${prefix}rules image <url>\` - Set banner\n\`${prefix}rules image remove\` - Remove banner`);
  }

  if (isKeyword(imageUrl, ['remove', 'none'])) {
    await Guild.updateGuild(message.guild.id, {
      $set: { 'rulesSystem.bannerUrl': null }
    });
    return replySuccess(message, 'Banner Removed', `${GLYPHS.SUCCESS} Rules banner has been removed.`);
  }

  if (!/^https?:\/\/\S+$/i.test(imageUrl)) {
    return replyError(message, 'Invalid URL',
      'Please provide a valid image URL starting with http:// or https://, Master.');
  }

  await Guild.updateGuild(message.guild.id, {
    $set: { 'rulesSystem.bannerUrl': imageUrl }
  });

  return replySuccess(message, 'Banner Set', `${GLYPHS.SUCCESS} Rules banner has been set.`);
}
