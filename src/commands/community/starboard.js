import { PermissionFlagsBits, ChannelType } from 'discord.js';
import Guild from '../../models/Guild.js';
import StarboardEntry from '../../models/StarboardEntry.js';
import { successEmbed, errorEmbed, infoEmbed, GLYPHS } from '../../utils/embeds.js';
import { getPrefix } from '../../utils/helpers.js';

const DEFAULT_EMOJI = '⭐';
const DEFAULT_THRESHOLD = 3;

// Custom server emoji as Discord renders it: <:name:id> or <a:name:id>
const CUSTOM_EMOJI = /^<a?:\w{2,32}:\d{17,20}>$/;

// One unicode emoji (with skin tones, ZWJ sequences, flags and keycaps).
// Prefers the exact RGI emoji set where the runtime supports the `v` flag (Node 20+).
const UNICODE_EMOJI = (() => {
  try {
    return new RegExp('^\\p{RGI_Emoji}$', 'v');
  } catch {
    return new RegExp(
      '^(?:(?:\\p{Extended_Pictographic}|\\p{Regional_Indicator}{2})(?:\\uFE0F|\\p{Emoji_Modifier})?' +
      '(?:\\u200D\\p{Extended_Pictographic}(?:\\uFE0F|\\p{Emoji_Modifier})?)*|[#*0-9]\\uFE0F?\\u20E3)$',
      'u'
    );
  }
})();

function isValidStarEmoji(input) {
  return CUSTOM_EMOJI.test(input) || UNICODE_EMOJI.test(input);
}

// Accepts a channel mention or a raw ID
function resolveChannel(message, arg) {
  return message.mentions.channels.first() ||
    message.guild.channels.cache.get(String(arg ?? '').replace(/[<#>]/g, ''));
}

function setStarboard(guildId, update) {
  return Guild.updateGuild(guildId, update);
}

export default {
  name: 'starboard',
  description: 'Configure the starboard feature',
  usage: '<enable|disable|channel|threshold|emoji|selfstar|ignore|unignore|stats>',
  aliases: ['star', 'sb'],
  category: 'config',
  permissions: {
    user: PermissionFlagsBits.ManageGuild
  },
  cooldown: 3,

  async execute(message, args) {
    const guildId = message.guild.id;

    try {
      const guildConfig = await Guild.getGuild(guildId, message.guild.name);
      const prefix = await getPrefix(guildId);
      const starboard = guildConfig?.features?.starboard || {};

      if (!args[0]) {
        return showStatus(message, starboard, prefix);
      }

      const action = args[0].toLowerCase();

      switch (action) {
        case 'enable':
        case 'on': {
          if (!starboard.channel) {
            return message.reply({
              embeds: [await errorEmbed(guildId, 'No Channel Set',
                `Please set a starboard channel first, Master: \`${prefix}starboard channel #channel\``)]
            });
          }
          await setStarboard(guildId, { $set: { 'features.starboard.enabled': true } });
          return message.reply({
            embeds: [await successEmbed(guildId, 'Starboard Enabled', 'The starboard is now active, Master.')]
          });
        }

        case 'disable':
        case 'off': {
          await setStarboard(guildId, { $set: { 'features.starboard.enabled': false } });
          return message.reply({
            embeds: [await successEmbed(guildId, 'Starboard Disabled', 'The starboard is now inactive, Master.')]
          });
        }

        case 'channel': {
          const channel = resolveChannel(message, args[1]);

          if (!channel) {
            return message.reply({
              embeds: [await errorEmbed(guildId, 'No Channel',
                `Please mention a channel or provide a channel ID, Master.\n\n**Usage:** \`${prefix}starboard channel #channel\``)]
            });
          }

          if (channel.type !== ChannelType.GuildText) {
            return message.reply({
              embeds: [await errorEmbed(guildId, 'Invalid Channel', 'Please select a text channel, Master.')]
            });
          }

          await setStarboard(guildId, { $set: { 'features.starboard.channel': channel.id } });
          return message.reply({
            embeds: [await successEmbed(guildId, 'Starboard Channel Set', `Starred messages will be posted in ${channel}, Master.`)]
          });
        }

        case 'threshold':
        case 'limit': {
          const threshold = parseInt(args[1], 10);
          if (isNaN(threshold) || threshold < 1 || threshold > 100) {
            return message.reply({
              embeds: [await errorEmbed(guildId, 'Invalid Threshold',
                `The threshold must be between 1 and 100, Master.\n\n**Usage:** \`${prefix}starboard threshold <1-100>\``)]
            });
          }
          await setStarboard(guildId, { $set: { 'features.starboard.threshold': threshold } });
          return message.reply({
            embeds: [await successEmbed(guildId, 'Threshold Updated',
              `Messages now need **${threshold}** star reaction${threshold === 1 ? '' : 's'} to reach the starboard, Master.`)]
          });
        }

        case 'emoji': {
          const emoji = args[1];
          if (!emoji || !isValidStarEmoji(emoji)) {
            return message.reply({
              embeds: [await errorEmbed(guildId, 'Invalid Emoji',
                `Please provide a single standard emoji or a custom server emoji, Master.\n\n**Usage:** \`${prefix}starboard emoji <emoji>\``)]
            });
          }
          await setStarboard(guildId, { $set: { 'features.starboard.emoji': emoji } });
          return message.reply({
            embeds: [await successEmbed(guildId, 'Emoji Updated', `Starboard reaction set to ${emoji}, Master.`)]
          });
        }

        case 'selfstar': {
          const selfOption = args[1]?.toLowerCase();
          if (!['on', 'off', 'enable', 'disable'].includes(selfOption)) {
            return message.reply({
              embeds: [await errorEmbed(guildId, 'Invalid Option',
                `Use \`${prefix}starboard selfstar on\` or \`${prefix}starboard selfstar off\`, Master.`)]
            });
          }
          const selfStar = ['on', 'enable'].includes(selfOption);
          await setStarboard(guildId, { $set: { 'features.starboard.selfStar': selfStar } });
          return message.reply({
            embeds: [await successEmbed(guildId, 'Self-Star Updated',
              `Members can ${selfStar ? 'now' : 'no longer'} star their own messages, Master.`)]
          });
        }

        case 'ignore': {
          const ignoreChannel = resolveChannel(message, args[1]);
          if (!ignoreChannel) {
            return message.reply({
              embeds: [await errorEmbed(guildId, 'No Channel',
                `Please mention a channel to ignore, Master.\n\n**Usage:** \`${prefix}starboard ignore #channel\``)]
            });
          }

          if ((starboard.ignoredChannels || []).includes(ignoreChannel.id)) {
            return message.reply({
              embeds: [await errorEmbed(guildId, 'Already Ignored', 'This channel is already ignored, Master.')]
            });
          }

          await setStarboard(guildId, { $addToSet: { 'features.starboard.ignoredChannels': ignoreChannel.id } });
          return message.reply({
            embeds: [await successEmbed(guildId, 'Channel Ignored', `${ignoreChannel} will be ignored by the starboard, Master.`)]
          });
        }

        case 'unignore': {
          const unignoreChannel = resolveChannel(message, args[1]);
          if (!unignoreChannel) {
            return message.reply({
              embeds: [await errorEmbed(guildId, 'No Channel',
                `Please mention a channel to stop ignoring, Master.\n\n**Usage:** \`${prefix}starboard unignore #channel\``)]
            });
          }

          await setStarboard(guildId, { $pull: { 'features.starboard.ignoredChannels': unignoreChannel.id } });
          return message.reply({
            embeds: [await successEmbed(guildId, 'Channel Unignored', `${unignoreChannel} will no longer be ignored, Master.`)]
          });
        }

        case 'stats':
        case 'top':
          return showStats(message);

        default:
          return showStatus(message, starboard, prefix);
      }
    } catch (error) {
      console.error('[starboard] Error:', error);
      return message.reply({
        embeds: [await errorEmbed(guildId, 'Operation Failed', 'I was unable to update the starboard settings, Master.')]
      });
    }
  }
};

async function showStatus(message, sb, prefix) {
  const channel = sb.channel ? message.guild.channels.cache.get(sb.channel) : null;
  const ignoredCount = sb.ignoredChannels?.length || 0;

  const embed = await infoEmbed(message.guild.id, 'Starboard Settings',
    `**▸ Status:** ${sb.enabled ? '◉ Active' : '◇ Inactive'}\n` +
    `**▸ Channel:** ${channel || 'Not configured'}\n` +
    `**▸ Threshold:** ${sb.threshold || DEFAULT_THRESHOLD} reactions\n` +
    `**▸ Emoji:** ${sb.emoji || DEFAULT_EMOJI}\n` +
    `**▸ Self-Star:** ${sb.selfStar ? '◉ Allowed' : '◇ Disabled'}\n` +
    `**▸ Ignored Channels:** ${ignoredCount}\n\n` +
    '**Commands:**\n' +
    `${GLYPHS.DOT} \`${prefix}starboard enable/disable\` — Toggle the starboard\n` +
    `${GLYPHS.DOT} \`${prefix}starboard channel #channel\` — Set the channel\n` +
    `${GLYPHS.DOT} \`${prefix}starboard threshold <number>\` — Set the reaction threshold\n` +
    `${GLYPHS.DOT} \`${prefix}starboard emoji <emoji>\` — Set the star emoji\n` +
    `${GLYPHS.DOT} \`${prefix}starboard selfstar on/off\` — Allow self-starring\n` +
    `${GLYPHS.DOT} \`${prefix}starboard ignore/unignore #channel\` — Ignore a channel\n` +
    `${GLYPHS.DOT} \`${prefix}starboard stats\` — View top starred messages`
  );

  return message.reply({ embeds: [embed] });
}

async function showStats(message) {
  const topStarred = await StarboardEntry.getTopStarred(message.guild.id, 10);

  if (topStarred.length === 0) {
    return message.reply({
      embeds: [await infoEmbed(message.guild.id, 'Starboard Statistics', 'No messages have been starred yet, Master.')]
    });
  }

  const statsList = topStarred.map((entry, i) =>
    `**#${i + 1}** ${GLYPHS.STAR} ${entry.starCount} star${entry.starCount === 1 ? '' : 's'} — <@${entry.authorId}>\n` +
    `${GLYPHS.DOT} [Jump to message](https://discord.com/channels/${message.guild.id}/${entry.originalChannelId}/${entry.originalMessageId})`
  ).join('\n\n');

  const embed = await infoEmbed(message.guild.id, 'Top Starred Messages', statsList);
  return message.reply({ embeds: [embed] });
}
