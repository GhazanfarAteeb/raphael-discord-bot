import { PermissionFlagsBits } from 'discord.js';
import Guild from '../../models/Guild.js';
import { successEmbed, errorEmbed, infoEmbed, GLYPHS } from '../../utils/embeds.js';
import { getBuiltInWordCount } from '../../utils/badWordsFilter.js';
import { hasModPerms, isServerAdmin, normalizeAntiNukeAction } from '../../utils/helpers.js';

export default {
  name: 'automod',
  description: 'Configure automod settings (bad words filter with multi-language support, anti-spam, anti-raid, etc.)',
  usage: '<setting> [options]',
  aliases: ['am'],
  permissions: [PermissionFlagsBits.ManageGuild],
  cooldown: 3,

  async execute(message, args) {
    const guildConfig = await Guild.getGuild(message.guild.id, message.guild.name);

    // Check for moderator permissions (admin, mod role, or ManageGuild)
    if (!hasModPerms(message.member, guildConfig)) {
      return message.reply({
        embeds: [await errorEmbed(message.guild.id, 'Permission Denied',
          `${GLYPHS.LOCK} You need Moderator/Staff permissions to configure AutoMod.`)]
      });
    }

    if (!args[0]) {
      return showStatus(message, guildConfig);
    }

    const setting = args[0].toLowerCase();

    switch (setting) {
      case 'enable':
      case 'on':
        await Guild.updateGuild(message.guild.id, { $set: { 'features.autoMod.enabled': true } });
        return message.reply({
          embeds: [await successEmbed(message.guild.id, 'AutoMod Enabled',
            `${GLYPHS.SUCCESS} AutoMod has been enabled for this server.`)]
        });

      case 'disable':
      case 'off':
        await Guild.updateGuild(message.guild.id, { $set: { 'features.autoMod.enabled': false } });
        return message.reply({
          embeds: [await successEmbed(message.guild.id, 'AutoMod Disabled',
            `${GLYPHS.SUCCESS} AutoMod has been disabled for this server.`)]
        });

      case 'status':
        return showStatus(message, guildConfig);

      case 'badwords':
        return handleBadwords(message, args.slice(1), guildConfig);

      case 'antispam':
      case 'spam':
        return handleAntispam(message, args.slice(1), guildConfig);

      case 'antiraid':
      case 'raid':
        return handleAntiraid(message, args.slice(1), guildConfig);

      case 'antinuke':
      case 'nuke':
        return handleAntinuke(message, args.slice(1), guildConfig);

      case 'antilinks':
      case 'links':
        return handleAntilinks(message, args.slice(1), guildConfig);

      case 'antiinvites':
      case 'invites':
        return handleAntiinvites(message, args.slice(1), guildConfig);

      case 'ignore':
        return handleIgnore(message, args.slice(1), guildConfig);

      default:
        return message.reply({
          embeds: [await errorEmbed(message.guild.id, 'Unknown Setting',
            `${GLYPHS.ERROR} Unknown automod setting.\n\n` +
            `**Available settings:**\n` +
            `${GLYPHS.DOT} \`enable/disable\` - Toggle automod\n` +
            `${GLYPHS.DOT} \`status\` - View current settings\n` +
            `${GLYPHS.DOT} \`badwords\` - Configure bad words filter\n` +
            `${GLYPHS.DOT} \`antispam\` - Configure anti-spam\n` +
            `${GLYPHS.DOT} \`antiraid\` - Configure anti-raid\n` +
            `${GLYPHS.DOT} \`antinuke\` - Configure anti-nuke\n` +
            `${GLYPHS.DOT} \`antilinks\` - Configure anti-links\n` +
            `${GLYPHS.DOT} \`antiinvites\` - Configure anti-invites\n` +
            `${GLYPHS.DOT} \`ignore\` - Configure ignored channels/roles`)]
        });
    }
  }
};

async function showStatus(message, guildConfig) {
  const autoMod = guildConfig.features.autoMod;
  const builtInCount = getBuiltInWordCount();
  const badWordsTotal = (autoMod.badWords?.useBuiltInList !== false ? builtInCount : 0) + (autoMod.badWords?.words?.length || 0);

  const embed = await infoEmbed(message.guild.id, '🛡️ AutoMod Status',
    `**Overall:** ${autoMod.enabled ? '✅ Enabled' : '❌ Disabled'}\n\n` +
    `**Features:**\n` +
    `${GLYPHS.DOT} **Anti-Spam:** ${autoMod.antiSpam?.enabled ? '✅' : '❌'} (${autoMod.antiSpam?.messageLimit || 5} msgs/${autoMod.antiSpam?.timeWindow || 5}s → ${autoMod.antiSpam?.action || 'warn'})\n` +
    `${GLYPHS.DOT} **Anti-Raid:** ${autoMod.antiRaid?.enabled ? '✅' : '❌'} (${autoMod.antiRaid?.joinThreshold || 10} joins/${autoMod.antiRaid?.timeWindow || 30}s → ${autoMod.antiRaid?.action || 'lockdown'})\n` +
    `${GLYPHS.DOT} **Anti-Nuke:** ${autoMod.antiNuke?.enabled ? '✅' : '❌'} (action: ${autoMod.antiNuke?.action || 'removeRoles'})\n` +
    `${GLYPHS.DOT} **Anti-Invites:** ${autoMod.antiInvites?.enabled ? '✅' : '❌'} (action: ${autoMod.antiInvites?.action || 'delete'})\n` +
    `${GLYPHS.DOT} **Anti-Links:** ${autoMod.antiLinks?.enabled ? '✅' : '❌'} (action: ${autoMod.antiLinks?.action || 'delete'})\n` +
    `${GLYPHS.DOT} **Bad Words:** ${autoMod.badWords?.enabled ? '✅' : '❌'} (${badWordsTotal} words → ${autoMod.badWords?.action || 'delete'})\n` +
    `${GLYPHS.DOT} **Mass Mention:** ${autoMod.antiMassMention?.enabled ? '✅' : '❌'} (limit: ${autoMod.antiMassMention?.limit || 5})\n\n` +
    `Use \`automod <setting> help\` for more info on each setting.`
  );

  return message.reply({ embeds: [embed] });
}

async function handleBadwords(message, args, guildConfig) {
  if (!guildConfig.features.autoMod.badWords) {
    guildConfig.features.autoMod.badWords = { enabled: false, words: [], ignoredWords: [], action: 'delete', useBuiltInList: true, autoEscalate: true };
  }

  const action = args[0]?.toLowerCase();
  const builtInCount = getBuiltInWordCount();

  if (!action || action === 'help') {
    return message.reply({
      embeds: [await infoEmbed(message.guild.id, 'Bad Words Filter',
        `**Current Status:** ${guildConfig.features.autoMod.badWords.enabled ? '✅ Enabled' : '❌ Disabled'}\n` +
        `**Built-in Words:** ${guildConfig.features.autoMod.badWords.useBuiltInList !== false ? `✅ Using (~${builtInCount} words, multi-language)` : '❌ Disabled'}\n` +
        `**Custom Words:** ${guildConfig.features.autoMod.badWords.words?.length || 0}\n` +
        `**Ignored Words:** ${guildConfig.features.autoMod.badWords.ignoredWords?.length || 0}\n` +
        `**Action:** ${guildConfig.features.autoMod.badWords.action}\n` +
        `**Auto-Escalate:** ${guildConfig.features.autoMod.badWords.autoEscalate !== false ? '✅' : '❌'}\n\n` +
        `**Supported Languages:** English, Spanish, French, German, Russian\n` +
        `**Features:** Leetspeak detection, bypass prevention, homoglyph detection\n\n` +
        `**Commands:**\n` +
        `${GLYPHS.DOT} \`automod badwords enable\` - Enable filter\n` +
        `${GLYPHS.DOT} \`automod badwords disable\` - Disable filter\n` +
        `${GLYPHS.DOT} \`automod badwords add <words>\` - Add custom words (comma separated)\n` +
        `${GLYPHS.DOT} \`automod badwords remove <words>\` - Remove custom words\n` +
        `${GLYPHS.DOT} \`automod badwords ignore <words>\` - Whitelist/ignore words\n` +
        `${GLYPHS.DOT} \`automod badwords unignore <words>\` - Remove from whitelist\n` +
        `${GLYPHS.DOT} \`automod badwords ignoredlist\` - View ignored/whitelisted words\n` +
        `${GLYPHS.DOT} \`automod badwords list\` - List custom words\n` +
        `${GLYPHS.DOT} \`automod badwords builtin on/off\` - Toggle built-in word list\n` +
        `${GLYPHS.DOT} \`automod badwords escalate on/off\` - Auto-escalate for slurs\n` +
        `${GLYPHS.DOT} \`automod badwords action <delete|warn|timeout|kick>\` - Set action\n` +
        `${GLYPHS.DOT} \`automod badwords timeout <seconds>\` - Set timeout duration`)]
    });
  }

  switch (action) {
    case 'enable':
    case 'on':
      await Guild.updateGuild(message.guild.id, { $set: { 'features.autoMod.badWords.enabled': true } });
      return message.reply({
        embeds: [await successEmbed(message.guild.id, 'Bad Words Filter Enabled',
          `${GLYPHS.SUCCESS} Bad words filter is now enabled.`)]
      });

    case 'disable':
    case 'off':
      await Guild.updateGuild(message.guild.id, { $set: { 'features.autoMod.badWords.enabled': false } });
      return message.reply({
        embeds: [await successEmbed(message.guild.id, 'Bad Words Filter Disabled',
          `${GLYPHS.SUCCESS} Bad words filter is now disabled.`)]
      });

    case 'add': {
      const addWords = args.slice(1).join(' ').split(',').map(w => w.trim().toLowerCase()).filter(w => w);
      if (addWords.length === 0) {
        return message.reply({
          embeds: [await errorEmbed(message.guild.id, 'No Words Provided',
            'Please provide words to add (comma separated).')]
        });
      }
      const existingWords = guildConfig.features.autoMod.badWords?.words || [];
      const newWordsList = [...new Set([...existingWords, ...addWords])];
      await Guild.updateGuild(message.guild.id, { $set: { 'features.autoMod.badWords.words': newWordsList } });
      return message.reply({
        embeds: [await successEmbed(message.guild.id, 'Words Added',
          `${GLYPHS.SUCCESS} Added ${addWords.length} word(s) to the filter.\n` +
          `Total words: ${newWordsList.length}`)]
      });
    }

    case 'remove': {
      const removeWords = args.slice(1).join(' ').split(',').map(w => w.trim().toLowerCase());
      const filteredWords = (guildConfig.features.autoMod.badWords?.words || [])
        .filter(w => !removeWords.includes(w));
      await Guild.updateGuild(message.guild.id, { $set: { 'features.autoMod.badWords.words': filteredWords } });
      return message.reply({
        embeds: [await successEmbed(message.guild.id, 'Words Removed',
          `${GLYPHS.SUCCESS} Removed word(s) from the filter.\n` +
          `Total words: ${filteredWords.length}`)]
      });
    }

    case 'list': {
      const wordList = guildConfig.features.autoMod.badWords.words || [];
      if (wordList.length === 0) {
        return message.reply({
          embeds: [await infoEmbed(message.guild.id, 'Bad Words List',
            'No bad words configured.')]
        });
      }
      // Mask words for privacy
      const maskedWords = wordList.map(w => w[0] + '*'.repeat(w.length - 1)).slice(0, 30);
      return message.reply({
        embeds: [await infoEmbed(message.guild.id, 'Bad Words List',
          `**Total Words:** ${wordList.length}\n\n` +
          `**Preview (masked):**\n${maskedWords.join(', ')}${wordList.length > 30 ? '...' : ''}`)]
      });
    }

    case 'action': {
      const newAction = args[1]?.toLowerCase();
      if (!['delete', 'warn', 'timeout', 'kick'].includes(newAction)) {
        return message.reply({
          embeds: [await errorEmbed(message.guild.id, 'Invalid Action',
            'Valid actions: delete, warn, timeout, kick')]
        });
      }
      await Guild.updateGuild(message.guild.id, { $set: { 'features.autoMod.badWords.action': newAction } });
      return message.reply({
        embeds: [await successEmbed(message.guild.id, 'Action Updated',
          `${GLYPHS.SUCCESS} Bad words action set to: **${newAction}**`)]
      });
    }

    case 'timeout': {
      const duration = parseInt(args[1]);
      if (isNaN(duration) || duration < 60 || duration > 604800) {
        return message.reply({
          embeds: [await errorEmbed(message.guild.id, 'Invalid Duration',
            'Duration must be between 60 and 604800 seconds (1 min to 1 week).')]
        });
      }
      await Guild.updateGuild(message.guild.id, { $set: { 'features.autoMod.badWords.timeoutDuration': duration } });
      return message.reply({
        embeds: [await successEmbed(message.guild.id, 'Timeout Duration Updated',
          `${GLYPHS.SUCCESS} Timeout duration set to: **${duration}** seconds`)]
      });
    }

    case 'builtin': {
      const builtinToggle = args[1]?.toLowerCase();
      if (!['on', 'off', 'enable', 'disable'].includes(builtinToggle)) {
        return message.reply({
          embeds: [await errorEmbed(message.guild.id, 'Invalid Option',
            'Use `automod badwords builtin on` or `automod badwords builtin off`')]
        });
      }
      const useBuiltIn = ['on', 'enable'].includes(builtinToggle);
      await Guild.updateGuild(message.guild.id, { $set: { 'features.autoMod.badWords.useBuiltInList': useBuiltIn } });
      return message.reply({
        embeds: [await successEmbed(message.guild.id, 'Built-in Word List Updated',
          `${GLYPHS.SUCCESS} Built-in word list is now **${useBuiltIn ? 'enabled' : 'disabled'}**\n` +
          `The built-in list contains ${builtInCount} common inappropriate words.`)]
      });
    }

    case 'escalate': {
      const escalateToggle = args[1]?.toLowerCase();
      if (!['on', 'off', 'enable', 'disable'].includes(escalateToggle)) {
        return message.reply({
          embeds: [await errorEmbed(message.guild.id, 'Invalid Option',
            'Use `automod badwords escalate on` or `automod badwords escalate off`')]
        });
      }
      const autoEscalate = ['on', 'enable'].includes(escalateToggle);
      await Guild.updateGuild(message.guild.id, { $set: { 'features.autoMod.badWords.autoEscalate': autoEscalate } });
      return message.reply({
        embeds: [await successEmbed(message.guild.id, 'Auto-Escalate Updated',
          `${GLYPHS.SUCCESS} Auto-escalate is now **${autoEscalate ? 'enabled' : 'disabled'}**\n` +
          `When enabled, extreme slurs will auto-escalate to kick action.`)]
      });
    }

    case 'ignore':
    case 'whitelist': {
      const ignoreWords = args.slice(1).join(' ').split(',').map(w => w.trim().toLowerCase()).filter(w => w);
      if (ignoreWords.length === 0) {
        return message.reply({
          embeds: [await errorEmbed(message.guild.id, 'No Words Provided',
            'Please provide words to ignore (comma separated).')]
        });
      }
      const existingIgnored = guildConfig.features.autoMod.badWords?.ignoredWords || [];
      const newIgnoredList = [...new Set([...existingIgnored, ...ignoreWords])];
      await Guild.updateGuild(message.guild.id, { $set: { 'features.autoMod.badWords.ignoredWords': newIgnoredList } });
      return message.reply({
        embeds: [await successEmbed(message.guild.id, 'Words Ignored',
          `${GLYPHS.SUCCESS} Added ${ignoreWords.length} word(s) to whitelist.\n` +
          `These words will not trigger the filter.`)]
      });
    }

    case 'unignore':
    case 'unwhitelist': {
      const unignoreWords = args.slice(1).join(' ').split(',').map(w => w.trim().toLowerCase());
      const filteredIgnored = (guildConfig.features.autoMod.badWords?.ignoredWords || [])
        .filter(w => !unignoreWords.includes(w));
      await Guild.updateGuild(message.guild.id, { $set: { 'features.autoMod.badWords.ignoredWords': filteredIgnored } });
      return message.reply({
        embeds: [await successEmbed(message.guild.id, 'Words Unignored',
          `${GLYPHS.SUCCESS} Removed word(s) from whitelist.`)]
      });
    }

    case 'ignoredlist':
    case 'ignored': {
      const ignoredList = guildConfig.features.autoMod.badWords.ignoredWords || [];
      if (ignoredList.length === 0) {
        return message.reply({
          embeds: [await infoEmbed(message.guild.id, 'Ignored Words List',
            'No words are currently whitelisted/ignored.')]
        });
      }
      // Show the ignored words (these are safe to display since they're whitelisted)
      const displayWords = ignoredList.slice(0, 50).join(', ');
      return message.reply({
        embeds: [await infoEmbed(message.guild.id, 'Ignored Words List',
          `**Total Ignored Words:** ${ignoredList.length}\n\n` +
          `**Words:**\n${displayWords}${ignoredList.length > 50 ? '\n\n*...and more*' : ''}`)]
      });
    }

    default:
      return message.reply({
        embeds: [await errorEmbed(message.guild.id, 'Unknown Action',
          'Use `automod badwords help` to see available commands.')]
      });
  }
}

async function handleAntispam(message, args, guildConfig) {
  const action = args[0]?.toLowerCase();

  if (!action || action === 'help') {
    return message.reply({
      embeds: [await infoEmbed(message.guild.id, 'Anti-Spam Settings',
        `**Status:** ${guildConfig.features.autoMod.antiSpam?.enabled ? '✅ Enabled' : '❌ Disabled'}\n` +
        `**Message Limit:** ${guildConfig.features.autoMod.antiSpam?.messageLimit || 5}\n` +
        `**Time Window:** ${guildConfig.features.autoMod.antiSpam?.timeWindow || 5}s\n` +
        `**Action:** ${guildConfig.features.autoMod.antiSpam?.action || 'warn'}\n\n` +
        `**Commands:**\n` +
        `${GLYPHS.DOT} \`automod antispam enable/disable\`\n` +
        `${GLYPHS.DOT} \`automod antispam limit <number>\`\n` +
        `${GLYPHS.DOT} \`automod antispam window <seconds>\`\n` +
        `${GLYPHS.DOT} \`automod antispam action <warn|timeout|mute|kick>\``)]
    });
  }

  switch (action) {
    case 'enable':
    case 'on':
      await Guild.updateGuild(message.guild.id, { $set: { 'features.autoMod.antiSpam.enabled': true } });
      return message.reply({
        embeds: [await successEmbed(message.guild.id, 'Anti-Spam Enabled', `${GLYPHS.SUCCESS} Anti-spam is now enabled.`)]
      });

    case 'disable':
    case 'off':
      await Guild.updateGuild(message.guild.id, { $set: { 'features.autoMod.antiSpam.enabled': false } });
      return message.reply({
        embeds: [await successEmbed(message.guild.id, 'Anti-Spam Disabled', `${GLYPHS.SUCCESS} Anti-spam is now disabled.`)]
      });

    case 'limit':
      const limit = parseInt(args[1]);
      if (isNaN(limit) || limit < 2 || limit > 20) {
        return message.reply({
          embeds: [await errorEmbed(message.guild.id, 'Invalid Limit', 'Message limit must be between 2 and 20.')]
        });
      }
      await Guild.updateGuild(message.guild.id, { $set: { 'features.autoMod.antiSpam.messageLimit': limit } });
      return message.reply({
        embeds: [await successEmbed(message.guild.id, 'Limit Updated', `${GLYPHS.SUCCESS} Message limit set to: **${limit}**`)]
      });

    case 'window':
      const window = parseInt(args[1]);
      if (isNaN(window) || window < 3 || window > 30) {
        return message.reply({
          embeds: [await errorEmbed(message.guild.id, 'Invalid Window', 'Time window must be between 3 and 30 seconds.')]
        });
      }
      await Guild.updateGuild(message.guild.id, { $set: { 'features.autoMod.antiSpam.timeWindow': window } });
      return message.reply({
        embeds: [await successEmbed(message.guild.id, 'Window Updated', `${GLYPHS.SUCCESS} Time window set to: **${window}** seconds`)]
      });

    case 'action':
      const spamAction = args[1]?.toLowerCase();
      if (!['warn', 'timeout', 'mute', 'kick'].includes(spamAction)) {
        return message.reply({
          embeds: [await errorEmbed(message.guild.id, 'Invalid Action', 'Valid actions: warn, timeout, mute, kick')]
        });
      }
      await Guild.updateGuild(message.guild.id, { $set: { 'features.autoMod.antiSpam.action': spamAction } });
      return message.reply({
        embeds: [await successEmbed(message.guild.id, 'Action Updated', `${GLYPHS.SUCCESS} Anti-spam action set to: **${spamAction}**`)]
      });
  }
}

async function handleAntiraid(message, args, guildConfig) {
  if (!guildConfig.features.autoMod.antiRaid) {
    guildConfig.features.autoMod.antiRaid = { enabled: true, joinThreshold: 10, timeWindow: 30, action: 'lockdown' };
  }

  const action = args[0]?.toLowerCase();

  if (!action || action === 'help') {
    return message.reply({
      embeds: [await infoEmbed(message.guild.id, 'Anti-Raid Settings',
        `**Status:** ${guildConfig.features.autoMod.antiRaid.enabled ? '✅ Enabled' : '❌ Disabled'}\n` +
        `**Join Threshold:** ${guildConfig.features.autoMod.antiRaid.joinThreshold}\n` +
        `**Time Window:** ${guildConfig.features.autoMod.antiRaid.timeWindow}s\n` +
        `**Action:** ${guildConfig.features.autoMod.antiRaid.action}\n\n` +
        `**Commands:**\n` +
        `${GLYPHS.DOT} \`automod antiraid enable/disable\`\n` +
        `${GLYPHS.DOT} \`automod antiraid threshold <number>\`\n` +
        `${GLYPHS.DOT} \`automod antiraid window <seconds>\`\n` +
        `${GLYPHS.DOT} \`automod antiraid action <lockdown|kick|ban>\``)]
    });
  }

  switch (action) {
    case 'enable':
    case 'on':
      await Guild.updateGuild(message.guild.id, { $set: { 'features.autoMod.antiRaid.enabled': true } });
      return message.reply({
        embeds: [await successEmbed(message.guild.id, 'Anti-Raid Enabled', `${GLYPHS.SUCCESS} Anti-raid is now enabled.`)]
      });

    case 'disable':
    case 'off':
      await Guild.updateGuild(message.guild.id, { $set: { 'features.autoMod.antiRaid.enabled': false } });
      return message.reply({
        embeds: [await successEmbed(message.guild.id, 'Anti-Raid Disabled', `${GLYPHS.SUCCESS} Anti-raid is now disabled.`)]
      });

    case 'threshold':
      const threshold = parseInt(args[1]);
      if (isNaN(threshold) || threshold < 5 || threshold > 50) {
        return message.reply({
          embeds: [await errorEmbed(message.guild.id, 'Invalid Threshold', 'Join threshold must be between 5 and 50.')]
        });
      }
      await Guild.updateGuild(message.guild.id, { $set: { 'features.autoMod.antiRaid.joinThreshold': threshold } });
      return message.reply({
        embeds: [await successEmbed(message.guild.id, 'Threshold Updated', `${GLYPHS.SUCCESS} Join threshold set to: **${threshold}**`)]
      });

    case 'action':
      const raidAction = args[1]?.toLowerCase();
      if (!['lockdown', 'kick', 'ban'].includes(raidAction)) {
        return message.reply({
          embeds: [await errorEmbed(message.guild.id, 'Invalid Action', 'Valid actions: lockdown, kick, ban')]
        });
      }
      await Guild.updateGuild(message.guild.id, { $set: { 'features.autoMod.antiRaid.action': raidAction } });
      return message.reply({
        embeds: [await successEmbed(message.guild.id, 'Action Updated', `${GLYPHS.SUCCESS} Anti-raid action set to: **${raidAction}**`)]
      });
  }
}

async function handleAntinuke(message, args, guildConfig) {
  // Owner/Administrator only: staff roles must not be able to disable anti-nuke or whitelist themselves
  if (args[0] && !isServerAdmin(message.member)) {
    return message.reply({
      embeds: [await errorEmbed(message.guild.id, 'Permission Denied',
        'Anti-nuke can only be configured by the server owner or an Administrator, Master.')]
    });
  }

  if (!guildConfig.features.autoMod.antiNuke) {
    guildConfig.features.autoMod.antiNuke = {
      enabled: true,
      banThreshold: 5,
      kickThreshold: 5,
      roleDeleteThreshold: 3,
      channelDeleteThreshold: 3,
      timeWindow: 60,
      action: 'removeRoles',
      whitelistedUsers: []
    };
  }

  const action = args[0]?.toLowerCase();

  if (!action || action === 'help') {
    const antiNuke = guildConfig.features.autoMod.antiNuke;
    return message.reply({
      embeds: [await infoEmbed(message.guild.id, 'Anti-Nuke Settings',
        `**Status:** ${antiNuke.enabled ? '✅ Enabled' : '❌ Disabled'}\n` +
        `**Thresholds:**\n` +
        `${GLYPHS.DOT} Bans: ${antiNuke.banThreshold}\n` +
        `${GLYPHS.DOT} Kicks: ${antiNuke.kickThreshold}\n` +
        `${GLYPHS.DOT} Role Deletes: ${antiNuke.roleDeleteThreshold}\n` +
        `${GLYPHS.DOT} Channel Deletes: ${antiNuke.channelDeleteThreshold}\n` +
        `**Time Window:** ${antiNuke.timeWindow}s\n` +
        `**Action:** ${antiNuke.action}\n` +
        `**Whitelisted:** ${antiNuke.whitelistedUsers?.length || 0} users\n\n` +
        `**Commands:**\n` +
        `${GLYPHS.DOT} \`automod antinuke enable/disable\`\n` +
        `${GLYPHS.DOT} \`automod antinuke action <removeRoles|kick|ban>\`\n` +
        `${GLYPHS.DOT} \`automod antinuke whitelist <@user>\`\n` +
        `${GLYPHS.DOT} \`automod antinuke unwhitelist <@user>\``)]
    });
  }

  switch (action) {
    case 'enable':
    case 'on':
      await Guild.updateGuild(message.guild.id, { $set: { 'features.autoMod.antiNuke.enabled': true } });
      return message.reply({
        embeds: [await successEmbed(message.guild.id, 'Anti-Nuke Enabled', `${GLYPHS.SUCCESS} Anti-nuke is now enabled.`)]
      });

    case 'disable':
    case 'off':
      await Guild.updateGuild(message.guild.id, { $set: { 'features.autoMod.antiNuke.enabled': false } });
      return message.reply({
        embeds: [await successEmbed(message.guild.id, 'Anti-Nuke Disabled', `${GLYPHS.SUCCESS} Anti-nuke is now disabled.`)]
      });

    case 'action':
      const nukeAction = normalizeAntiNukeAction(args[1]);
      if (!nukeAction) {
        return message.reply({
          embeds: [await errorEmbed(message.guild.id, 'Invalid Action', 'Valid actions: removeRoles, kick, ban')]
        });
      }
      await Guild.updateGuild(message.guild.id, { $set: { 'features.autoMod.antiNuke.action': nukeAction } });
      return message.reply({
        embeds: [await successEmbed(message.guild.id, 'Action Updated', `${GLYPHS.SUCCESS} Anti-nuke action set to: **${nukeAction}**`)]
      });

    case 'whitelist':
      const whitelistUser = message.mentions.users.first();
      if (!whitelistUser) {
        return message.reply({
          embeds: [await errorEmbed(message.guild.id, 'Missing User', 'Please mention a user to whitelist.')]
        });
      }
      const currentWhitelist = guildConfig.features.autoMod.antiNuke?.whitelistedUsers || [];
      if (!currentWhitelist.includes(whitelistUser.id)) {
        currentWhitelist.push(whitelistUser.id);
      }
      await Guild.updateGuild(message.guild.id, { $set: { 'features.autoMod.antiNuke.whitelistedUsers': currentWhitelist } });
      return message.reply({
        embeds: [await successEmbed(message.guild.id, 'User Whitelisted', `${GLYPHS.SUCCESS} ${whitelistUser.tag} is now whitelisted from anti-nuke.`)]
      });

    case 'unwhitelist':
      const unwhitelistUser = message.mentions.users.first();
      if (!unwhitelistUser) {
        return message.reply({
          embeds: [await errorEmbed(message.guild.id, 'Missing User', 'Please mention a user to unwhitelist.')]
        });
      }
      const filteredWhitelist = (guildConfig.features.autoMod.antiNuke?.whitelistedUsers || [])
        .filter(id => id !== unwhitelistUser.id);
      await Guild.updateGuild(message.guild.id, { $set: { 'features.autoMod.antiNuke.whitelistedUsers': filteredWhitelist } });
      return message.reply({
        embeds: [await successEmbed(message.guild.id, 'User Unwhitelisted', `${GLYPHS.SUCCESS} ${unwhitelistUser.tag} is no longer whitelisted.`)]
      });
  }
}

async function handleAntilinks(message, args, guildConfig) {
  if (!guildConfig.features.autoMod.antiLinks) {
    guildConfig.features.autoMod.antiLinks = { enabled: false, whitelistedDomains: [], action: 'delete' };
  }

  const action = args[0]?.toLowerCase();

  if (!action || action === 'help') {
    return message.reply({
      embeds: [await infoEmbed(message.guild.id, 'Anti-Links Settings',
        `**Status:** ${guildConfig.features.autoMod.antiLinks.enabled ? '✅ Enabled' : '❌ Disabled'}\n` +
        `**Action:** ${guildConfig.features.autoMod.antiLinks.action}\n` +
        `**Whitelisted Domains:** ${guildConfig.features.autoMod.antiLinks.whitelistedDomains?.length || 0}\n\n` +
        `**Commands:**\n` +
        `${GLYPHS.DOT} \`automod antilinks enable/disable\`\n` +
        `${GLYPHS.DOT} \`automod antilinks action <delete|warn|timeout>\`\n` +
        `${GLYPHS.DOT} \`automod antilinks whitelist <domain>\`\n` +
        `${GLYPHS.DOT} \`automod antilinks unwhitelist <domain>\`\n` +
        `${GLYPHS.DOT} \`automod antilinks list\``)]
    });
  }

  switch (action) {
    case 'enable':
    case 'on':
      await Guild.updateGuild(message.guild.id, { $set: { 'features.autoMod.antiLinks.enabled': true } });
      return message.reply({
        embeds: [await successEmbed(message.guild.id, 'Anti-Links Enabled', `${GLYPHS.SUCCESS} Anti-links is now enabled.`)]
      });

    case 'disable':
    case 'off':
      await Guild.updateGuild(message.guild.id, { $set: { 'features.autoMod.antiLinks.enabled': false } });
      return message.reply({
        embeds: [await successEmbed(message.guild.id, 'Anti-Links Disabled', `${GLYPHS.SUCCESS} Anti-links is now disabled.`)]
      });

    case 'whitelist':
      const domain = args[1]?.toLowerCase();
      if (!domain) {
        return message.reply({
          embeds: [await errorEmbed(message.guild.id, 'Missing Domain', 'Please provide a domain to whitelist.')]
        });
      }
      const currentDomains = guildConfig.features.autoMod.antiLinks?.whitelistedDomains || [];
      if (!currentDomains.includes(domain)) {
        currentDomains.push(domain);
      }
      await Guild.updateGuild(message.guild.id, { $set: { 'features.autoMod.antiLinks.whitelistedDomains': currentDomains } });
      return message.reply({
        embeds: [await successEmbed(message.guild.id, 'Domain Whitelisted', `${GLYPHS.SUCCESS} \`${domain}\` is now whitelisted.`)]
      });

    case 'list':
      const domains = guildConfig.features.autoMod.antiLinks.whitelistedDomains || [];
      return message.reply({
        embeds: [await infoEmbed(message.guild.id, 'Whitelisted Domains',
          domains.length > 0 ? domains.map(d => `\`${d}\``).join(', ') : 'No domains whitelisted.')]
      });
  }
}

async function handleAntiinvites(message, args, guildConfig) {
  if (!guildConfig.features.autoMod.antiInvites) {
    guildConfig.features.autoMod.antiInvites = { enabled: true, action: 'delete' };
  }

  const action = args[0]?.toLowerCase();

  if (!action || action === 'help') {
    return message.reply({
      embeds: [await infoEmbed(message.guild.id, 'Anti-Invites Settings',
        `**Status:** ${guildConfig.features.autoMod.antiInvites.enabled ? '✅ Enabled' : '❌ Disabled'}\n` +
        `**Action:** ${guildConfig.features.autoMod.antiInvites.action}\n\n` +
        `**Commands:**\n` +
        `${GLYPHS.DOT} \`automod antiinvites enable/disable\`\n` +
        `${GLYPHS.DOT} \`automod antiinvites action <delete|warn|timeout|kick>\``)]
    });
  }

  switch (action) {
    case 'enable':
    case 'on':
      await Guild.updateGuild(message.guild.id, { $set: { 'features.autoMod.antiInvites.enabled': true } });
      return message.reply({
        embeds: [await successEmbed(message.guild.id, 'Anti-Invites Enabled', `${GLYPHS.SUCCESS} Anti-invites is now enabled.`)]
      });

    case 'disable':
    case 'off':
      await Guild.updateGuild(message.guild.id, { $set: { 'features.autoMod.antiInvites.enabled': false } });
      return message.reply({
        embeds: [await successEmbed(message.guild.id, 'Anti-Invites Disabled', `${GLYPHS.SUCCESS} Anti-invites is now disabled.`)]
      });

    case 'action':
      const inviteAction = args[1]?.toLowerCase();
      if (!['delete', 'warn', 'timeout', 'kick'].includes(inviteAction)) {
        return message.reply({
          embeds: [await errorEmbed(message.guild.id, 'Invalid Action', 'Valid actions: delete, warn, timeout, kick')]
        });
      }
      await Guild.updateGuild(message.guild.id, { $set: { 'features.autoMod.antiInvites.action': inviteAction } });
      return message.reply({
        embeds: [await successEmbed(message.guild.id, 'Action Updated', `${GLYPHS.SUCCESS} Anti-invites action set to: **${inviteAction}**`)]
      });
  }
}

async function handleIgnore(message, args, guildConfig) {
  const guildId = message.guild.id;
  const { getPrefix } = await import('../../utils/helpers.js');
  const prefix = await getPrefix(guildId);

  // Show help if no args
  if (!args[0]) {
    return showIgnoreHelp(message, prefix);
  }

  const action = args[0].toLowerCase();
  const type = args[1]?.toLowerCase();

  // List command
  if (action === 'list') {
    return listIgnored(message, guildConfig);
  }

  // Validate action
  if (!['add', 'remove'].includes(action)) {
    return showIgnoreHelp(message, prefix);
  }

  // Validate type for add/remove
  if (!['channel', 'role', 'channels', 'roles'].includes(type)) {
    return message.reply({
      embeds: [await errorEmbed(guildId, 'Invalid Type',
        `**Notice:** Please specify \`channel\` or \`role\`.\n\n**Usage:** \`${prefix}automod ignore <add|remove> <channel|role> <#channel/@role>\``)]
    });
  }

  const isChannel = ['channel', 'channels'].includes(type);

  // Get the target
  let target;
  if (isChannel) {
    target = message.mentions.channels.first() || message.guild.channels.cache.get(args[2]);
  } else {
    target = message.mentions.roles.first() || message.guild.roles.cache.get(args[2]);
  }

  if (!target) {
    return message.reply({
      embeds: [await errorEmbed(guildId, 'Target Required',
        `**Notice:** Please mention a ${isChannel ? 'channel' : 'role'}.\n\n**Usage:** \`${prefix}automod ignore ${action} ${type} ${isChannel ? '#channel' : '@role'}\``)]
    });
  }

  if (action === 'add') {
    return addIgnored(message, guildConfig, target, isChannel);
  } else if (action === 'remove') {
    return removeIgnored(message, guildConfig, target, isChannel);
  }
}

async function showIgnoreHelp(message, prefix) {
  const embed = await infoEmbed(message.guild.id,
    '『 AutoMod Ignore Settings 』',
    `Configure channels and roles that bypass automod.\n\n` +
    `**Commands:**\n` +
    `${GLYPHS.DOT} \`${prefix}automod ignore add channel #channel\` - Ignore a channel\n` +
    `${GLYPHS.DOT} \`${prefix}automod ignore remove channel #channel\` - Stop ignoring a channel\n` +
    `${GLYPHS.DOT} \`${prefix}automod ignore add role @role\` - Add role bypass\n` +
    `${GLYPHS.DOT} \`${prefix}automod ignore remove role @role\` - Remove role bypass\n` +
    `${GLYPHS.DOT} \`${prefix}automod ignore list\` - List all ignored channels/roles\n\n` +
    `**Note:** Ignored channels and bypass roles will not trigger any automod actions.`
  );

  return message.reply({ embeds: [embed] });
}

async function addIgnored(message, guildConfig, target, isChannel) {
  const guildId = message.guild.id;

  const field = isChannel ? 'ignoredChannels' : 'ignoredRoles';
  const currentList = guildConfig?.features?.autoMod?.[field] || [];

  if (currentList.includes(target.id)) {
    return message.reply({
      embeds: [await errorEmbed(guildId, 'Already Ignored',
        `**Notice:** ${target} is already in the automod ignore list.`)]
    });
  }

  const newList = [...currentList, target.id];
  await Guild.updateGuild(guildId, {
    $set: { [`features.autoMod.${field}`]: newList }
  });

  return message.reply({
    embeds: [await successEmbed(guildId, 'AutoMod Ignore Updated',
      `${GLYPHS.SUCCESS} Successfully added ${target} to the automod ${isChannel ? 'ignored channels' : 'bypass roles'} list.\n\n` +
      `**Effect:** AutoMod will no longer monitor ${isChannel ? 'messages in this channel' : 'users with this role'}.`)]
  });
}

async function removeIgnored(message, guildConfig, target, isChannel) {
  const guildId = message.guild.id;

  if (!guildConfig?.features?.autoMod) {
    return message.reply({
      embeds: [await errorEmbed(guildId, 'Not Found',
        `**Notice:** No automod ignore settings found.`)]
    });
  }

  const field = isChannel ? 'ignoredChannels' : 'ignoredRoles';
  const list = guildConfig.features.autoMod[field] || [];

  if (!list.includes(target.id)) {
    return message.reply({
      embeds: [await errorEmbed(guildId, 'Not Found',
        `**Notice:** ${target} is not in the automod ignore list.`)]
    });
  }

  const newList = list.filter(id => id !== target.id);
  await Guild.updateGuild(guildId, {
    $set: { [`features.autoMod.${field}`]: newList }
  });

  return message.reply({
    embeds: [await successEmbed(guildId, 'AutoMod Ignore Updated',
      `${GLYPHS.SUCCESS} Successfully removed ${target} from the automod ${isChannel ? 'ignored channels' : 'bypass roles'} list.\n\n` +
      `**Effect:** AutoMod will now monitor ${isChannel ? 'messages in this channel' : 'users with this role'}.`)]
  });
}

async function listIgnored(message, guildConfig) {
  const guildId = message.guild.id;

  const ignoredChannels = guildConfig?.features?.autoMod?.ignoredChannels || [];
  const ignoredRoles = guildConfig?.features?.autoMod?.ignoredRoles || [];

  let description = '**Ignored Channels:**\n';
  if (ignoredChannels.length === 0) {
    description += `${GLYPHS.DOT} None\n`;
  } else {
    for (const channelId of ignoredChannels) {
      const channel = message.guild.channels.cache.get(channelId);
      description += `${GLYPHS.DOT} ${channel || `<#${channelId}> (deleted)`}\n`;
    }
  }

  description += '\n**Bypass Roles:**\n';
  if (ignoredRoles.length === 0) {
    description += `${GLYPHS.DOT} None\n`;
  } else {
    for (const roleId of ignoredRoles) {
      const role = message.guild.roles.cache.get(roleId);
      description += `${GLYPHS.DOT} ${role || `<@&${roleId}> (deleted)`}\n`;
    }
  }

  const embed = await infoEmbed(guildId,
    '『 AutoMod Ignore Settings 』',
    description
  );

  return message.reply({ embeds: [embed] });
}