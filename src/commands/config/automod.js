import { PermissionFlagsBits } from 'discord.js';
import Guild from '../../models/Guild.js';
import { successEmbed, errorEmbed, infoEmbed, GLYPHS } from '../../utils/embeds.js';
import { getBuiltInWordCount } from '../../utils/badWordsFilter.js';
import { hasModPerms, isServerAdmin, normalizeAntiNukeAction, getPrefix, truncate } from '../../utils/helpers.js';

// Schema defaults, used for display when a section was never saved
const DEFAULTS = {
  antiSpam: { enabled: true, messageLimit: 5, timeWindow: 5, action: 'warn' },
  antiRaid: { enabled: true, joinThreshold: 10, timeWindow: 30, action: 'lockdown' },
  antiNuke: {
    enabled: true, banThreshold: 5, kickThreshold: 5, roleDeleteThreshold: 3,
    channelDeleteThreshold: 3, timeWindow: 60, action: 'removeRoles', whitelistedUsers: []
  },
  antiMassMention: { enabled: true, limit: 5, action: 'delete' },
  badWords: {
    enabled: false, useBuiltInList: true, words: [], ignoredWords: [],
    action: 'delete', timeoutDuration: 300, autoEscalate: true
  },
  antiLinks: { enabled: false, whitelistedDomains: [], action: 'delete' },
  antiInvites: { enabled: true, action: 'delete' }
};

const ANTI_RAID_WINDOW = { min: 5, max: 300 };
const LINK_ACTIONS = ['delete', 'warn', 'timeout'];
const DESCRIPTION_LIST_MAX = 3500;

export default {
  name: 'automod',
  category: 'config',
  description: 'Configure automod settings (bad words filter with multi-language support, anti-spam, anti-raid, etc.)',
  usage: '<setting> [options]',
  aliases: ['am'],
  permissions: [PermissionFlagsBits.ManageGuild],
  cooldown: 3,

  async execute(message, args) {
    try {
      return await runAutomodCommand(message, args);
    } catch (error) {
      console.error('[AutoMod] Command error:', error);
      return message.reply({
        embeds: [await errorEmbed(message.guild.id, 'AutoMod Error',
          'An anomaly occurred while processing this request, Master. Please try again.')]
      }).catch(() => { });
    }
  }
};

async function runAutomodCommand(message, args) {
  const guildConfig = await Guild.getGuild(message.guild.id, message.guild.name);
  const prefix = await getPrefix(message.guild.id);

  // Check for moderator permissions (admin, mod role, or ManageGuild)
  if (!hasModPerms(message.member, guildConfig)) {
    return replyError(message, 'Permission Denied',
      `${GLYPHS.LOCK} You need Moderator/Staff permissions to configure AutoMod, Master.`);
  }

  if (!args[0]) {
    return showStatus(message, guildConfig, prefix);
  }

  const setting = args[0].toLowerCase();
  const autoMod = guildConfig.features?.autoMod || {};
  const rest = args.slice(1);

  switch (setting) {
    case 'enable':
    case 'on':
      await Guild.updateGuild(message.guild.id, { $set: { 'features.autoMod.enabled': true } });
      return replySuccess(message, 'AutoMod Enabled', `${GLYPHS.SUCCESS} AutoMod has been enabled for this server.`);

    case 'disable':
    case 'off':
      await Guild.updateGuild(message.guild.id, { $set: { 'features.autoMod.enabled': false } });
      return replySuccess(message, 'AutoMod Disabled', `${GLYPHS.SUCCESS} AutoMod has been disabled for this server.`);

    case 'status':
      return showStatus(message, guildConfig, prefix);

    case 'badwords':
      return handleBadwords(message, rest, section(autoMod, 'badWords'), prefix);

    case 'antispam':
    case 'spam':
      return handleAntispam(message, rest, section(autoMod, 'antiSpam'), prefix);

    case 'antiraid':
    case 'raid':
      return handleAntiraid(message, rest, section(autoMod, 'antiRaid'), prefix);

    case 'antinuke':
    case 'nuke':
      return handleAntinuke(message, rest, section(autoMod, 'antiNuke'), prefix);

    case 'antilinks':
    case 'links':
      return handleAntilinks(message, rest, section(autoMod, 'antiLinks'), prefix);

    case 'antiinvites':
    case 'invites':
      return handleAntiinvites(message, rest, section(autoMod, 'antiInvites'), prefix);

    case 'ignore':
      return handleIgnore(message, rest, autoMod, prefix);

    default:
      return replyError(message, 'Unknown Setting',
        `${GLYPHS.ERROR} Unknown automod setting, Master.\n\n` +
        `**Available settings:**\n` +
        `${GLYPHS.DOT} \`${prefix}automod enable/disable\` - Toggle automod\n` +
        `${GLYPHS.DOT} \`${prefix}automod status\` - View current settings\n` +
        `${GLYPHS.DOT} \`${prefix}automod badwords\` - Configure bad words filter\n` +
        `${GLYPHS.DOT} \`${prefix}automod antispam\` - Configure anti-spam\n` +
        `${GLYPHS.DOT} \`${prefix}automod antiraid\` - Configure anti-raid\n` +
        `${GLYPHS.DOT} \`${prefix}automod antinuke\` - Configure anti-nuke\n` +
        `${GLYPHS.DOT} \`${prefix}automod antilinks\` - Configure anti-links\n` +
        `${GLYPHS.DOT} \`${prefix}automod antiinvites\` - Configure anti-invites\n` +
        `${GLYPHS.DOT} \`${prefix}automod ignore\` - Configure ignored channels/roles`);
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

// A section's stored settings over its defaults, without touching the cached config.
// Very old configs stored some sections as a plain boolean.
function section(autoMod, key) {
  const stored = autoMod[key];
  if (typeof stored === 'boolean') return { ...DEFAULTS[key], enabled: stored };
  return { ...DEFAULTS[key], ...(stored && typeof stored === 'object' ? stored : {}) };
}

function state(enabled) {
  return enabled ? '◉ Enabled' : '◇ Disabled';
}

// Whole numbers only: parseInt would accept "10abc"
function parseWholeNumber(value) {
  return /^\d+$/.test(String(value ?? '')) ? Number(value) : NaN;
}

function parseWordList(args) {
  return args.join(' ').split(',').map(w => w.trim().toLowerCase()).filter(Boolean);
}

/**
 * Bare lowercase hostname for a domain or URL ("https://www.YouTube.com/x" -> "youtube.com"),
 * or null if it isn't one. Used for both saving and matching anti-links whitelist entries.
 */
export function normalizeDomain(value) {
  let text = String(value ?? '').trim().toLowerCase().replace(/^\*\./, '');
  if (!text) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//.test(text)) text = `http://${text}`;

  try {
    const host = new URL(text).hostname.replace(/\.$/, '').replace(/^www\./, '');
    return host.includes('.') ? host : null;
  } catch {
    return null;
  }
}

/**
 * Whether a link's hostname is a whitelisted domain or one of its subdomains
 * ("youtube.com" allows "m.youtube.com" but not "notyoutube.com").
 */
export function isWhitelistedHost(hostname, whitelistedDomains = []) {
  const host = normalizeDomain(hostname);
  if (!host) return false;
  return whitelistedDomains.some(entry => {
    const domain = normalizeDomain(entry);
    return Boolean(domain) && (host === domain || host.endsWith(`.${domain}`));
  });
}

async function updateSetting(message, path, value) {
  await Guild.updateGuild(message.guild.id, { $set: { [path]: value } });
}

// ============================================
// Status
// ============================================

async function showStatus(message, guildConfig, prefix) {
  const autoMod = guildConfig.features?.autoMod || {};
  const antiSpam = section(autoMod, 'antiSpam');
  const antiRaid = section(autoMod, 'antiRaid');
  const antiNuke = section(autoMod, 'antiNuke');
  const antiInvites = section(autoMod, 'antiInvites');
  const antiLinks = section(autoMod, 'antiLinks');
  const badWords = section(autoMod, 'badWords');
  const antiMassMention = section(autoMod, 'antiMassMention');
  const badWordsTotal = (badWords.useBuiltInList !== false ? getBuiltInWordCount() : 0) + (badWords.words?.length || 0);

  const embed = await infoEmbed(message.guild.id, 'AutoMod Status',
    `**Overall:** ${state(autoMod.enabled)}\n` +
    `Use \`${prefix}automod <setting> help\` for more on each setting, Master.`);

  embed.addFields(
    {
      name: `${antiSpam.enabled ? '◉' : '◇'} Anti-Spam`,
      value: `${antiSpam.messageLimit} msgs / ${antiSpam.timeWindow}s\nAction: ${antiSpam.action}`,
      inline: true
    },
    {
      name: `${antiRaid.enabled ? '◉' : '◇'} Anti-Raid`,
      value: `${antiRaid.joinThreshold} joins / ${antiRaid.timeWindow}s\nAction: ${antiRaid.action}`,
      inline: true
    },
    {
      name: `${antiNuke.enabled ? '◉' : '◇'} Anti-Nuke`,
      value: `Action: ${antiNuke.action}`,
      inline: true
    },
    {
      name: `${antiInvites.enabled ? '◉' : '◇'} Anti-Invites`,
      value: `Action: ${antiInvites.action}`,
      inline: true
    },
    {
      name: `${antiLinks.enabled ? '◉' : '◇'} Anti-Links`,
      value: `Action: ${antiLinks.action}\nWhitelisted: ${antiLinks.whitelistedDomains?.length || 0}`,
      inline: true
    },
    {
      name: `${badWords.enabled ? '◉' : '◇'} Bad Words`,
      value: `${badWordsTotal} words\nAction: ${badWords.action}`,
      inline: true
    },
    {
      name: `${antiMassMention.enabled ? '◉' : '◇'} Mass Mention`,
      value: `Limit: ${antiMassMention.limit}\nAction: ${antiMassMention.action}`,
      inline: true
    }
  );

  return message.reply({ embeds: [embed] });
}

// ============================================
// Bad words
// ============================================

async function showBadwordsHelp(message, badWords, prefix) {
  const builtInCount = getBuiltInWordCount();
  const p = `${prefix}automod badwords`;
  return replyInfo(message, 'Bad Words Filter',
    `**Current Status:** ${state(badWords.enabled)}\n` +
    `**Built-in Words:** ${badWords.useBuiltInList !== false ? `◉ Using (~${builtInCount} words, multi-language)` : '◇ Disabled'}\n` +
    `**Custom Words:** ${badWords.words?.length || 0}\n` +
    `**Ignored Words:** ${badWords.ignoredWords?.length || 0}\n` +
    `**Action:** ${badWords.action}\n` +
    `**Auto-Escalate:** ${badWords.autoEscalate !== false ? '◉' : '◇'}\n\n` +
    `**Supported Languages:** English, Spanish, French, German, Russian\n` +
    `**Features:** Leetspeak detection, bypass prevention, homoglyph detection\n\n` +
    `**Commands:**\n` +
    `${GLYPHS.DOT} \`${p} enable/disable\` - Toggle the filter\n` +
    `${GLYPHS.DOT} \`${p} add <words>\` - Add custom words (comma separated)\n` +
    `${GLYPHS.DOT} \`${p} remove <words>\` - Remove custom words\n` +
    `${GLYPHS.DOT} \`${p} ignore <words>\` - Whitelist/ignore words\n` +
    `${GLYPHS.DOT} \`${p} unignore <words>\` - Remove from whitelist\n` +
    `${GLYPHS.DOT} \`${p} ignoredlist\` - View ignored/whitelisted words\n` +
    `${GLYPHS.DOT} \`${p} list\` - List custom words\n` +
    `${GLYPHS.DOT} \`${p} builtin on/off\` - Toggle built-in word list\n` +
    `${GLYPHS.DOT} \`${p} escalate on/off\` - Auto-escalate for slurs\n` +
    `${GLYPHS.DOT} \`${p} action <delete|warn|timeout|kick>\` - Set action\n` +
    `${GLYPHS.DOT} \`${p} timeout <seconds>\` - Set timeout duration`);
}

async function handleBadwords(message, args, badWords, prefix) {
  const action = args[0]?.toLowerCase();
  const p = `${prefix}automod badwords`;

  switch (action) {
    case 'enable':
    case 'on':
      await updateSetting(message, 'features.autoMod.badWords.enabled', true);
      return replySuccess(message, 'Bad Words Filter Enabled', `${GLYPHS.SUCCESS} Bad words filter is now enabled.`);

    case 'disable':
    case 'off':
      await updateSetting(message, 'features.autoMod.badWords.enabled', false);
      return replySuccess(message, 'Bad Words Filter Disabled', `${GLYPHS.SUCCESS} Bad words filter is now disabled.`);

    case 'add': {
      const addWords = parseWordList(args.slice(1));
      if (addWords.length === 0) {
        return replyError(message, 'No Words Provided',
          `Please provide words to add (comma separated), Master.\n\n**Usage:** \`${p} add word1, word2\``);
      }
      const newWordsList = [...new Set([...(badWords.words || []), ...addWords])];
      await updateSetting(message, 'features.autoMod.badWords.words', newWordsList);
      return replySuccess(message, 'Words Added',
        `${GLYPHS.SUCCESS} Added ${addWords.length} word(s) to the filter.\nTotal words: ${newWordsList.length}`);
    }

    case 'remove': {
      const removeWords = parseWordList(args.slice(1));
      if (removeWords.length === 0) {
        return replyError(message, 'No Words Provided',
          `Please provide words to remove (comma separated), Master.\n\n**Usage:** \`${p} remove word1, word2\``);
      }
      const currentWords = badWords.words || [];
      const filteredWords = currentWords.filter(w => !removeWords.includes(w));
      const removedCount = currentWords.length - filteredWords.length;
      if (removedCount === 0) {
        return replyError(message, 'Words Not Found', 'None of those words are in the custom filter list, Master.');
      }
      await updateSetting(message, 'features.autoMod.badWords.words', filteredWords);
      return replySuccess(message, 'Words Removed',
        `${GLYPHS.SUCCESS} Removed ${removedCount} word(s) from the filter.\nTotal words: ${filteredWords.length}`);
    }

    case 'list': {
      const wordList = badWords.words || [];
      if (wordList.length === 0) {
        return replyInfo(message, 'Bad Words List', 'No custom bad words configured.');
      }
      // Mask words for privacy
      const maskedWords = wordList.slice(0, 30).map(w => w[0] + '*'.repeat(w.length - 1));
      return replyInfo(message, 'Bad Words List',
        `**Total Words:** ${wordList.length}\n\n` +
        `**Preview (masked):**\n${truncate(maskedWords.join(', '), DESCRIPTION_LIST_MAX)}${wordList.length > 30 ? '...' : ''}`);
    }

    case 'action': {
      const newAction = args[1]?.toLowerCase();
      if (!['delete', 'warn', 'timeout', 'kick'].includes(newAction)) {
        return replyError(message, 'Invalid Action', 'Valid actions: delete, warn, timeout, kick');
      }
      await updateSetting(message, 'features.autoMod.badWords.action', newAction);
      return replySuccess(message, 'Action Updated', `${GLYPHS.SUCCESS} Bad words action set to: **${newAction}**`);
    }

    case 'timeout': {
      const duration = parseWholeNumber(args[1]);
      if (Number.isNaN(duration) || duration < 60 || duration > 604800) {
        return replyError(message, 'Invalid Duration',
          'Duration must be between 60 and 604800 seconds (1 min to 1 week), Master.');
      }
      await updateSetting(message, 'features.autoMod.badWords.timeoutDuration', duration);
      return replySuccess(message, 'Timeout Duration Updated', `${GLYPHS.SUCCESS} Timeout duration set to: **${duration}** seconds`);
    }

    case 'builtin': {
      const builtinToggle = args[1]?.toLowerCase();
      if (!['on', 'off', 'enable', 'disable'].includes(builtinToggle)) {
        return replyError(message, 'Invalid Option', `Use \`${p} builtin on\` or \`${p} builtin off\``);
      }
      const useBuiltIn = ['on', 'enable'].includes(builtinToggle);
      await updateSetting(message, 'features.autoMod.badWords.useBuiltInList', useBuiltIn);
      return replySuccess(message, 'Built-in Word List Updated',
        `${GLYPHS.SUCCESS} Built-in word list is now **${useBuiltIn ? 'enabled' : 'disabled'}**\n` +
        `The built-in list contains ${getBuiltInWordCount()} common inappropriate words.`);
    }

    case 'escalate': {
      const escalateToggle = args[1]?.toLowerCase();
      if (!['on', 'off', 'enable', 'disable'].includes(escalateToggle)) {
        return replyError(message, 'Invalid Option', `Use \`${p} escalate on\` or \`${p} escalate off\``);
      }
      const autoEscalate = ['on', 'enable'].includes(escalateToggle);
      await updateSetting(message, 'features.autoMod.badWords.autoEscalate', autoEscalate);
      return replySuccess(message, 'Auto-Escalate Updated',
        `${GLYPHS.SUCCESS} Auto-escalate is now **${autoEscalate ? 'enabled' : 'disabled'}**\n` +
        `When enabled, extreme slurs will auto-escalate to kick action.`);
    }

    case 'ignore':
    case 'whitelist': {
      const ignoreWords = parseWordList(args.slice(1));
      if (ignoreWords.length === 0) {
        return replyError(message, 'No Words Provided',
          `Please provide words to ignore (comma separated), Master.\n\n**Usage:** \`${p} ignore word1, word2\``);
      }
      const newIgnoredList = [...new Set([...(badWords.ignoredWords || []), ...ignoreWords])];
      await updateSetting(message, 'features.autoMod.badWords.ignoredWords', newIgnoredList);
      return replySuccess(message, 'Words Ignored',
        `${GLYPHS.SUCCESS} Added ${ignoreWords.length} word(s) to whitelist.\nThese words will not trigger the filter.`);
    }

    case 'unignore':
    case 'unwhitelist': {
      const unignoreWords = parseWordList(args.slice(1));
      if (unignoreWords.length === 0) {
        return replyError(message, 'No Words Provided',
          `Please provide words to remove from the whitelist (comma separated), Master.\n\n**Usage:** \`${p} unignore word1, word2\``);
      }
      const currentIgnored = badWords.ignoredWords || [];
      const filteredIgnored = currentIgnored.filter(w => !unignoreWords.includes(w));
      const removedCount = currentIgnored.length - filteredIgnored.length;
      if (removedCount === 0) {
        return replyError(message, 'Words Not Found', 'None of those words are on the whitelist, Master.');
      }
      await updateSetting(message, 'features.autoMod.badWords.ignoredWords', filteredIgnored);
      return replySuccess(message, 'Words Unignored', `${GLYPHS.SUCCESS} Removed ${removedCount} word(s) from whitelist.`);
    }

    case 'ignoredlist':
    case 'ignored': {
      const ignoredList = badWords.ignoredWords || [];
      if (ignoredList.length === 0) {
        return replyInfo(message, 'Ignored Words List', 'No words are currently whitelisted/ignored.');
      }
      // Whitelisted words are safe to display
      return replyInfo(message, 'Ignored Words List',
        `**Total Ignored Words:** ${ignoredList.length}\n\n` +
        `**Words:**\n${truncate(ignoredList.slice(0, 50).join(', '), DESCRIPTION_LIST_MAX)}` +
        (ignoredList.length > 50 ? '\n\n*...and more*' : ''));
    }

    default:
      return showBadwordsHelp(message, badWords, prefix);
  }
}

// ============================================
// Anti-spam
// ============================================

async function handleAntispam(message, args, antiSpam, prefix) {
  const action = args[0]?.toLowerCase();
  const p = `${prefix}automod antispam`;

  switch (action) {
    case 'enable':
    case 'on':
      await updateSetting(message, 'features.autoMod.antiSpam.enabled', true);
      return replySuccess(message, 'Anti-Spam Enabled', `${GLYPHS.SUCCESS} Anti-spam is now enabled.`);

    case 'disable':
    case 'off':
      await updateSetting(message, 'features.autoMod.antiSpam.enabled', false);
      return replySuccess(message, 'Anti-Spam Disabled', `${GLYPHS.SUCCESS} Anti-spam is now disabled.`);

    case 'limit': {
      const limit = parseWholeNumber(args[1]);
      if (Number.isNaN(limit) || limit < 2 || limit > 20) {
        return replyError(message, 'Invalid Limit', 'Message limit must be between 2 and 20, Master.');
      }
      await updateSetting(message, 'features.autoMod.antiSpam.messageLimit', limit);
      return replySuccess(message, 'Limit Updated', `${GLYPHS.SUCCESS} Message limit set to: **${limit}**`);
    }

    case 'window': {
      const window = parseWholeNumber(args[1]);
      if (Number.isNaN(window) || window < 3 || window > 30) {
        return replyError(message, 'Invalid Window', 'Time window must be between 3 and 30 seconds, Master.');
      }
      await updateSetting(message, 'features.autoMod.antiSpam.timeWindow', window);
      return replySuccess(message, 'Window Updated', `${GLYPHS.SUCCESS} Time window set to: **${window}** seconds`);
    }

    case 'action': {
      const spamAction = args[1]?.toLowerCase();
      if (!['warn', 'timeout', 'mute', 'kick'].includes(spamAction)) {
        return replyError(message, 'Invalid Action', 'Valid actions: warn, timeout, mute, kick');
      }
      await updateSetting(message, 'features.autoMod.antiSpam.action', spamAction);
      return replySuccess(message, 'Action Updated', `${GLYPHS.SUCCESS} Anti-spam action set to: **${spamAction}**`);
    }

    default:
      return replyInfo(message, 'Anti-Spam Settings',
        `**Status:** ${state(antiSpam.enabled)}\n` +
        `**Message Limit:** ${antiSpam.messageLimit}\n` +
        `**Time Window:** ${antiSpam.timeWindow}s\n` +
        `**Action:** ${antiSpam.action}\n\n` +
        `**Commands:**\n` +
        `${GLYPHS.DOT} \`${p} enable/disable\`\n` +
        `${GLYPHS.DOT} \`${p} limit <number>\`\n` +
        `${GLYPHS.DOT} \`${p} window <seconds>\`\n` +
        `${GLYPHS.DOT} \`${p} action <warn|timeout|mute|kick>\``);
  }
}

// ============================================
// Anti-raid
// ============================================

async function handleAntiraid(message, args, antiRaid, prefix) {
  const action = args[0]?.toLowerCase();
  const p = `${prefix}automod antiraid`;

  switch (action) {
    case 'enable':
    case 'on':
      await updateSetting(message, 'features.autoMod.antiRaid.enabled', true);
      return replySuccess(message, 'Anti-Raid Enabled', `${GLYPHS.SUCCESS} Anti-raid is now enabled.`);

    case 'disable':
    case 'off':
      await updateSetting(message, 'features.autoMod.antiRaid.enabled', false);
      return replySuccess(message, 'Anti-Raid Disabled', `${GLYPHS.SUCCESS} Anti-raid is now disabled.`);

    case 'threshold': {
      const threshold = parseWholeNumber(args[1]);
      if (Number.isNaN(threshold) || threshold < 5 || threshold > 50) {
        return replyError(message, 'Invalid Threshold', 'Join threshold must be between 5 and 50, Master.');
      }
      await updateSetting(message, 'features.autoMod.antiRaid.joinThreshold', threshold);
      return replySuccess(message, 'Threshold Updated', `${GLYPHS.SUCCESS} Join threshold set to: **${threshold}**`);
    }

    case 'window': {
      const window = parseWholeNumber(args[1]);
      if (Number.isNaN(window) || window < ANTI_RAID_WINDOW.min || window > ANTI_RAID_WINDOW.max) {
        return replyError(message, 'Invalid Window',
          `Time window must be between ${ANTI_RAID_WINDOW.min} and ${ANTI_RAID_WINDOW.max} seconds, Master.`);
      }
      await updateSetting(message, 'features.autoMod.antiRaid.timeWindow', window);
      return replySuccess(message, 'Window Updated',
        `${GLYPHS.SUCCESS} Anti-raid time window set to: **${window}** seconds`);
    }

    case 'action': {
      const raidAction = args[1]?.toLowerCase();
      if (!['lockdown', 'kick', 'ban'].includes(raidAction)) {
        return replyError(message, 'Invalid Action', 'Valid actions: lockdown, kick, ban');
      }
      await updateSetting(message, 'features.autoMod.antiRaid.action', raidAction);
      return replySuccess(message, 'Action Updated', `${GLYPHS.SUCCESS} Anti-raid action set to: **${raidAction}**`);
    }

    default:
      return replyInfo(message, 'Anti-Raid Settings',
        `**Status:** ${state(antiRaid.enabled)}\n` +
        `**Join Threshold:** ${antiRaid.joinThreshold}\n` +
        `**Time Window:** ${antiRaid.timeWindow}s\n` +
        `**Action:** ${antiRaid.action}\n\n` +
        `**Commands:**\n` +
        `${GLYPHS.DOT} \`${p} enable/disable\`\n` +
        `${GLYPHS.DOT} \`${p} threshold <number>\`\n` +
        `${GLYPHS.DOT} \`${p} window <seconds>\`\n` +
        `${GLYPHS.DOT} \`${p} action <lockdown|kick|ban>\``);
  }
}

// ============================================
// Anti-nuke
// ============================================

async function handleAntinuke(message, args, antiNuke, prefix) {
  const action = args[0]?.toLowerCase();
  const p = `${prefix}automod antinuke`;

  // Owner/Administrator only: staff roles must not be able to disable anti-nuke or whitelist themselves
  if (action && action !== 'help' && !isServerAdmin(message.member)) {
    return replyError(message, 'Permission Denied',
      'Anti-nuke can only be configured by the server owner or an Administrator, Master.');
  }

  switch (action) {
    case 'enable':
    case 'on':
      await updateSetting(message, 'features.autoMod.antiNuke.enabled', true);
      return replySuccess(message, 'Anti-Nuke Enabled', `${GLYPHS.SUCCESS} Anti-nuke is now enabled.`);

    case 'disable':
    case 'off':
      await updateSetting(message, 'features.autoMod.antiNuke.enabled', false);
      return replySuccess(message, 'Anti-Nuke Disabled', `${GLYPHS.SUCCESS} Anti-nuke is now disabled.`);

    case 'action': {
      const nukeAction = normalizeAntiNukeAction(args[1]);
      if (!nukeAction) {
        return replyError(message, 'Invalid Action', 'Valid actions: removeRoles, kick, ban');
      }
      await updateSetting(message, 'features.autoMod.antiNuke.action', nukeAction);
      return replySuccess(message, 'Action Updated', `${GLYPHS.SUCCESS} Anti-nuke action set to: **${nukeAction}**`);
    }

    case 'whitelist': {
      const whitelistUser = message.mentions.users.first();
      if (!whitelistUser) {
        return replyError(message, 'Missing User', 'Please mention a user to whitelist, Master.');
      }
      const currentWhitelist = antiNuke.whitelistedUsers || [];
      const newWhitelist = currentWhitelist.includes(whitelistUser.id)
        ? currentWhitelist
        : [...currentWhitelist, whitelistUser.id];
      await updateSetting(message, 'features.autoMod.antiNuke.whitelistedUsers', newWhitelist);
      return replySuccess(message, 'User Whitelisted', `${GLYPHS.SUCCESS} ${whitelistUser.tag} is now whitelisted from anti-nuke.`);
    }

    case 'unwhitelist': {
      const unwhitelistUser = message.mentions.users.first();
      if (!unwhitelistUser) {
        return replyError(message, 'Missing User', 'Please mention a user to unwhitelist, Master.');
      }
      const filteredWhitelist = (antiNuke.whitelistedUsers || []).filter(id => id !== unwhitelistUser.id);
      await updateSetting(message, 'features.autoMod.antiNuke.whitelistedUsers', filteredWhitelist);
      return replySuccess(message, 'User Unwhitelisted', `${GLYPHS.SUCCESS} ${unwhitelistUser.tag} is no longer whitelisted.`);
    }

    default:
      return replyInfo(message, 'Anti-Nuke Settings',
        `**Status:** ${state(antiNuke.enabled)}\n` +
        `**Thresholds:**\n` +
        `${GLYPHS.DOT} Bans: ${antiNuke.banThreshold}\n` +
        `${GLYPHS.DOT} Kicks: ${antiNuke.kickThreshold}\n` +
        `${GLYPHS.DOT} Role Deletes: ${antiNuke.roleDeleteThreshold}\n` +
        `${GLYPHS.DOT} Channel Deletes: ${antiNuke.channelDeleteThreshold}\n` +
        `**Time Window:** ${antiNuke.timeWindow}s\n` +
        `**Action:** ${antiNuke.action}\n` +
        `**Whitelisted:** ${antiNuke.whitelistedUsers?.length || 0} users\n\n` +
        `**Commands** (server owner or Administrator):\n` +
        `${GLYPHS.DOT} \`${p} enable/disable\`\n` +
        `${GLYPHS.DOT} \`${p} action <removeRoles|kick|ban>\`\n` +
        `${GLYPHS.DOT} \`${p} whitelist <@user>\`\n` +
        `${GLYPHS.DOT} \`${p} unwhitelist <@user>\``);
  }
}

// ============================================
// Anti-links
// ============================================

async function handleAntilinks(message, args, antiLinks, prefix) {
  const action = args[0]?.toLowerCase();
  const p = `${prefix}automod antilinks`;
  const domains = antiLinks.whitelistedDomains || [];

  switch (action) {
    case 'enable':
    case 'on':
      await updateSetting(message, 'features.autoMod.antiLinks.enabled', true);
      return replySuccess(message, 'Anti-Links Enabled', `${GLYPHS.SUCCESS} Anti-links is now enabled.`);

    case 'disable':
    case 'off':
      await updateSetting(message, 'features.autoMod.antiLinks.enabled', false);
      return replySuccess(message, 'Anti-Links Disabled', `${GLYPHS.SUCCESS} Anti-links is now disabled.`);

    case 'action': {
      const linkAction = args[1]?.toLowerCase();
      if (!LINK_ACTIONS.includes(linkAction)) {
        return replyError(message, 'Invalid Action', `Valid actions: ${LINK_ACTIONS.join(', ')}`);
      }
      await updateSetting(message, 'features.autoMod.antiLinks.action', linkAction);
      return replySuccess(message, 'Action Updated', `${GLYPHS.SUCCESS} Anti-links action set to: **${linkAction}**`);
    }

    case 'whitelist': {
      if (!args[1]) {
        return replyError(message, 'Missing Domain',
          `Please provide a domain to whitelist, Master.\n\n**Usage:** \`${p} whitelist youtube.com\``);
      }
      const domain = normalizeDomain(args[1]);
      if (!domain) {
        return replyError(message, 'Invalid Domain',
          `\`${truncate(args[1], 100)}\` is not a valid domain, Master. Example: \`youtube.com\``);
      }
      // Store bare hostnames; older entries may be URLs, so compare normalised
      const normalisedExisting = domains.map(normalizeDomain);
      if (normalisedExisting.includes(domain)) {
        return replyInfo(message, 'Already Whitelisted', `\`${domain}\` is already whitelisted, Master.`);
      }
      await updateSetting(message, 'features.autoMod.antiLinks.whitelistedDomains', [...domains, domain]);
      return replySuccess(message, 'Domain Whitelisted',
        `${GLYPHS.SUCCESS} \`${domain}\` and its subdomains are now whitelisted.`);
    }

    case 'unwhitelist': {
      if (!args[1]) {
        return replyError(message, 'Missing Domain',
          `Please provide a domain to remove from the whitelist, Master.\n\n**Usage:** \`${p} unwhitelist youtube.com\``);
      }
      const domain = normalizeDomain(args[1]);
      const remaining = domains.filter(entry => normalizeDomain(entry) !== domain);
      if (!domain || remaining.length === domains.length) {
        return replyError(message, 'Not Whitelisted',
          `\`${truncate(args[1], 100)}\` is not on the whitelist, Master.`);
      }
      await updateSetting(message, 'features.autoMod.antiLinks.whitelistedDomains', remaining);
      return replySuccess(message, 'Domain Removed', `${GLYPHS.SUCCESS} \`${domain}\` is no longer whitelisted.`);
    }

    case 'list':
      return replyInfo(message, 'Whitelisted Domains',
        domains.length > 0
          ? truncate(domains.map(d => `\`${d}\``).join(', '), DESCRIPTION_LIST_MAX)
          : 'No domains whitelisted.');

    default:
      return replyInfo(message, 'Anti-Links Settings',
        `**Status:** ${state(antiLinks.enabled)}\n` +
        `**Action:** ${antiLinks.action}\n` +
        `**Whitelisted Domains:** ${domains.length}\n\n` +
        `**Commands:**\n` +
        `${GLYPHS.DOT} \`${p} enable/disable\`\n` +
        `${GLYPHS.DOT} \`${p} action <${LINK_ACTIONS.join('|')}>\`\n` +
        `${GLYPHS.DOT} \`${p} whitelist <domain>\` - Also allows its subdomains\n` +
        `${GLYPHS.DOT} \`${p} unwhitelist <domain>\`\n` +
        `${GLYPHS.DOT} \`${p} list\``);
  }
}

// ============================================
// Anti-invites
// ============================================

async function handleAntiinvites(message, args, antiInvites, prefix) {
  const action = args[0]?.toLowerCase();
  const p = `${prefix}automod antiinvites`;

  switch (action) {
    case 'enable':
    case 'on':
      await updateSetting(message, 'features.autoMod.antiInvites.enabled', true);
      return replySuccess(message, 'Anti-Invites Enabled', `${GLYPHS.SUCCESS} Anti-invites is now enabled.`);

    case 'disable':
    case 'off':
      await updateSetting(message, 'features.autoMod.antiInvites.enabled', false);
      return replySuccess(message, 'Anti-Invites Disabled', `${GLYPHS.SUCCESS} Anti-invites is now disabled.`);

    case 'action': {
      const inviteAction = args[1]?.toLowerCase();
      if (!['delete', 'warn', 'timeout', 'kick'].includes(inviteAction)) {
        return replyError(message, 'Invalid Action', 'Valid actions: delete, warn, timeout, kick');
      }
      await updateSetting(message, 'features.autoMod.antiInvites.action', inviteAction);
      return replySuccess(message, 'Action Updated', `${GLYPHS.SUCCESS} Anti-invites action set to: **${inviteAction}**`);
    }

    default:
      return replyInfo(message, 'Anti-Invites Settings',
        `**Status:** ${state(antiInvites.enabled)}\n` +
        `**Action:** ${antiInvites.action}\n\n` +
        `**Commands:**\n` +
        `${GLYPHS.DOT} \`${p} enable/disable\`\n` +
        `${GLYPHS.DOT} \`${p} action <delete|warn|timeout|kick>\``);
  }
}

// ============================================
// Ignored channels / bypass roles
// ============================================

async function handleIgnore(message, args, autoMod, prefix) {
  if (!args[0]) {
    return showIgnoreHelp(message, prefix);
  }

  const action = args[0].toLowerCase();
  const type = args[1]?.toLowerCase();

  if (action === 'list') {
    return listIgnored(message, autoMod);
  }

  if (!['add', 'remove'].includes(action)) {
    return showIgnoreHelp(message, prefix);
  }

  if (!['channel', 'role', 'channels', 'roles'].includes(type)) {
    return replyError(message, 'Invalid Type',
      `**Notice:** Please specify \`channel\` or \`role\`.\n\n**Usage:** \`${prefix}automod ignore <add|remove> <channel|role> <#channel/@role>\``);
  }

  const isChannel = ['channel', 'channels'].includes(type);
  const target = isChannel
    ? message.mentions.channels.first() || message.guild.channels.cache.get(args[2])
    : message.mentions.roles.first() || message.guild.roles.cache.get(args[2]);

  if (!target) {
    return replyError(message, 'Target Required',
      `**Notice:** Please mention a ${isChannel ? 'channel' : 'role'}.\n\n**Usage:** \`${prefix}automod ignore ${action} ${type} ${isChannel ? '#channel' : '@role'}\``);
  }

  return action === 'add'
    ? addIgnored(message, autoMod, target, isChannel)
    : removeIgnored(message, autoMod, target, isChannel);
}

async function showIgnoreHelp(message, prefix) {
  const p = `${prefix}automod ignore`;
  return replyInfo(message, 'AutoMod Ignore Settings',
    `Configure channels and roles that bypass automod, Master.\n\n` +
    `**Commands:**\n` +
    `${GLYPHS.DOT} \`${p} add channel #channel\` - Ignore a channel\n` +
    `${GLYPHS.DOT} \`${p} remove channel #channel\` - Stop ignoring a channel\n` +
    `${GLYPHS.DOT} \`${p} add role @role\` - Add role bypass\n` +
    `${GLYPHS.DOT} \`${p} remove role @role\` - Remove role bypass\n` +
    `${GLYPHS.DOT} \`${p} list\` - List all ignored channels/roles\n\n` +
    `**Note:** Ignored channels and bypass roles will not trigger any automod actions.`);
}

async function addIgnored(message, autoMod, target, isChannel) {
  const field = isChannel ? 'ignoredChannels' : 'ignoredRoles';
  const currentList = autoMod[field] || [];

  if (currentList.includes(target.id)) {
    return replyError(message, 'Already Ignored', `**Notice:** ${target} is already in the automod ignore list.`);
  }

  await updateSetting(message, `features.autoMod.${field}`, [...currentList, target.id]);

  return replySuccess(message, 'AutoMod Ignore Updated',
    `${GLYPHS.SUCCESS} Successfully added ${target} to the automod ${isChannel ? 'ignored channels' : 'bypass roles'} list.\n\n` +
    `**Effect:** AutoMod will no longer monitor ${isChannel ? 'messages in this channel' : 'users with this role'}.`);
}

async function removeIgnored(message, autoMod, target, isChannel) {
  const field = isChannel ? 'ignoredChannels' : 'ignoredRoles';
  const list = autoMod[field] || [];

  if (!list.includes(target.id)) {
    return replyError(message, 'Not Found', `**Notice:** ${target} is not in the automod ignore list.`);
  }

  await updateSetting(message, `features.autoMod.${field}`, list.filter(id => id !== target.id));

  return replySuccess(message, 'AutoMod Ignore Updated',
    `${GLYPHS.SUCCESS} Successfully removed ${target} from the automod ${isChannel ? 'ignored channels' : 'bypass roles'} list.\n\n` +
    `**Effect:** AutoMod will now monitor ${isChannel ? 'messages in this channel' : 'users with this role'}.`);
}

async function listIgnored(message, autoMod) {
  const ignoredChannels = autoMod.ignoredChannels || [];
  const ignoredRoles = autoMod.ignoredRoles || [];

  const channelLines = ignoredChannels.length === 0
    ? [`${GLYPHS.DOT} None`]
    : ignoredChannels.map(id => `${GLYPHS.DOT} ${message.guild.channels.cache.get(id) || `<#${id}> (deleted)`}`);
  const roleLines = ignoredRoles.length === 0
    ? [`${GLYPHS.DOT} None`]
    : ignoredRoles.map(id => `${GLYPHS.DOT} ${message.guild.roles.cache.get(id) || `<@&${id}> (deleted)`}`);

  const embed = await infoEmbed(message.guild.id, 'AutoMod Ignore Settings',
    '**Analysis:** Channels and roles that bypass automod, Master.');
  embed.addFields(
    { name: '▸ Ignored Channels', value: truncate(channelLines.join('\n'), 1024) },
    { name: '▸ Bypass Roles', value: truncate(roleLines.join('\n'), 1024) }
  );

  return message.reply({ embeds: [embed] });
}
