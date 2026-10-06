import { PermissionFlagsBits } from 'discord.js';
import Guild from '../../models/Guild.js';
import { successEmbed, errorEmbed, infoEmbed, GLYPHS } from '../../utils/embeds.js';
import { getPrefix, hasModPerms } from '../../utils/helpers.js';

const STATUS = { on: '◉', off: '◇', partial: '◈' };
const STATUS_LEGEND = `${STATUS.on} enabled  ${STATUS.off} disabled  ${STATUS.partial} partly disabled`;

// Command-based features. Names are real command names (aliases are resolved too); anything
// not loaded on this bot is skipped at runtime. `systems` are the config flags that switch the
// feature itself on or off, so disabling it stops more than its commands.
const featureCategories = {
  economy: {
    name: 'Economy',
    commands: ['balance', 'daily', 'claim', 'shop', 'inventory', 'profile', 'setprofile', 'rep']
  },
  gambling: {
    name: 'Gambling',
    commands: ['slots', 'blackjack', 'coinflip', 'dice', 'roulette', 'adventure']
  },
  leveling: {
    name: 'Leveling',
    commands: ['level', 'leaderboard', 'levelup']
  },
  games: {
    name: 'Games',
    commands: ['trivia', 'tictactoe']
  },
  fun: {
    name: 'Fun',
    commands: ['meme', 'poll']
  },
  birthdays: {
    name: 'Birthdays',
    commands: ['setbirthday', 'mybirthday', 'birthdays', 'requestbirthday', 'approvebday', 'rejectbday', 'cancelbirthday', 'removebirthday', 'birthdaypreference', 'birthdayrequests', 'birthdayconfig'],
    systems: [{ path: 'features.birthdaySystem.enabled', label: 'birthday announcements' }]
  },
  giveaways: {
    name: 'Giveaways',
    commands: ['giveaway']
  },
  events: {
    name: 'Events',
    commands: ['createevent', 'events', 'joinevent', 'cancelevent']
  },
  starboard: {
    name: 'Starboard',
    commands: ['starboard'],
    systems: [{ path: 'features.starboard.enabled', label: 'the starboard' }]
  },
  tickets: {
    name: 'Tickets',
    commands: ['ticket']
  },
  afk: {
    name: 'AFK',
    commands: ['afk']
  },
  reminders: {
    name: 'Reminders',
    commands: ['remind']
  },
  automod: {
    name: 'AutoMod',
    commands: ['automod', 'automodignore'],
    systems: [{ path: 'features.autoMod.enabled', label: 'automatic moderation' }]
  },
  welcome: {
    name: 'Welcome & Goodbye',
    commands: ['welcome', 'goodbye'],
    systems: [
      { path: 'features.welcomeSystem.enabled', label: 'welcome messages' },
      { path: 'features.leaveSystem.enabled', label: 'goodbye messages' }
    ]
  }
};

// Settings that are switched on and off rather than tied to commands
const TOGGLES = {
  boost: { name: 'Boost Announcements', aliases: ['boost', 'boostsystem', 'boosts'] },
  profilecustomization: { name: 'Profile Customization', aliases: ['profilecustomization', 'profilecustom', 'customization'] },
  aichat: { name: 'AI Chat', aliases: ['aichat', 'ai', 'raphael'] }
};

const protectedCommands = ['help', 'config', 'feature', 'setup'];

function findToggle(target) {
  return Object.keys(TOGGLES).find(key => TOGGLES[key].aliases.includes(target));
}

// Real command names for a category, aliases resolved, missing commands dropped
function resolveCommands(client, names) {
  const resolved = names
    .map(name => client.commands.get(name) || client.commands.get(client.aliases?.get(name)))
    .filter(Boolean)
    .map(command => command.name);
  return [...new Set(resolved)];
}

function featureList() {
  return [...Object.keys(featureCategories), ...Object.keys(TOGGLES)].map(f => `\`${f}\``).join(', ');
}

export default {
  name: 'feature',
  description: 'Enable or disable bot features and commands',
  usage: '<enable|disable|status> <feature|command>',
  aliases: ['features', 'toggle', 'cmd', 'command'],
  category: 'config',
  permissions: [PermissionFlagsBits.ManageGuild],
  cooldown: 3,

  async execute(message, args, client) {
    const guildId = message.guild.id;

    try {
      const guildConfig = await Guild.getGuild(guildId);

      // Check for moderator permissions (admin, mod role, or ManageGuild)
      if (!hasModPerms(message.member, guildConfig)) {
        return message.reply({
          embeds: [await errorEmbed(guildId, 'Permission Denied',
            `${GLYPHS.LOCK} You need Moderator/Staff permissions to manage features.`)]
        });
      }

      const prefix = await getPrefix(guildId);
      const action = args[0]?.toLowerCase();

      if (!action) {
        return showFeatureMenu(message, guildConfig, client, prefix);
      }

      if (action === 'list' || action === 'disabled') {
        return showDisabledList(message, guildConfig);
      }

      if (action === 'status') {
        const feature = args[1]?.toLowerCase();
        if (!feature) return showFeatureMenu(message, guildConfig, client, prefix);
        return showFeatureStatus(message, guildConfig, feature, client, prefix);
      }

      if (action === 'enable' || action === 'disable') {
        const target = args[1]?.toLowerCase();
        if (!target) {
          return message.reply({
            embeds: [await errorEmbed(guildId, 'Missing Target',
              `${GLYPHS.ERROR} Please specify a feature or command.\n\n` +
              `**Usage:**\n` +
              `${GLYPHS.ARROW_RIGHT} \`${prefix}feature ${action} <feature>\` - ${action} a feature\n` +
              `${GLYPHS.ARROW_RIGHT} \`${prefix}feature ${action} <command>\` - ${action} a single command\n\n` +
              `**Features:** ${featureList()}`)]
          });
        }
        return toggleFeature(message, guildConfig, target, action === 'enable', client, prefix);
      }

      // `feature <name>` shows that feature's status
      if (featureCategories[action] || findToggle(action) || action === 'troll' || action === 'trollmode') {
        return showFeatureStatus(message, guildConfig, action, client, prefix);
      }

      return showFeatureMenu(message, guildConfig, client, prefix);
    } catch (error) {
      console.error('[Feature] Error:', error);
      return message.reply({
        embeds: [await errorEmbed(guildId, 'Configuration Error',
          'The feature settings could not be updated, Master. Please try again.')]
      }).catch(() => null);
    }
  }
};

function getToggleState(guildConfig, key) {
  if (key === 'aichat') return Boolean(guildConfig.features?.aiChat?.enabled);
  if (key === 'profilecustomization') return guildConfig.economy?.profileCustomization?.enabled !== false; // Default true
  if (key === 'boost') return Boolean(guildConfig.features?.boostSystem?.enabled);
  return false;
}

function getDisabledLists(guildConfig) {
  return {
    text: guildConfig.textCommands?.disabledCommands || [],
    slash: guildConfig.slashCommands?.disabledCommands || []
  };
}

async function showFeatureMenu(message, guildConfig, client, prefix) {
  const { text, slash } = getDisabledLists(guildConfig);

  const categoryLines = Object.values(featureCategories).map(category => {
    const commands = resolveCommands(client, category.commands);
    const disabledCount = commands.filter(cmd => text.includes(cmd) || slash.includes(cmd)).length;
    let status = STATUS.on;
    if (commands.length && disabledCount === commands.length) status = STATUS.off;
    else if (disabledCount > 0) status = STATUS.partial;
    return `${status} **${category.name}** - ${commands.length} command${commands.length === 1 ? '' : 's'}`;
  });

  const toggleLines = Object.entries(TOGGLES).map(([key, toggle]) => {
    const enabled = getToggleState(guildConfig, key);
    let line = `${enabled ? STATUS.on : STATUS.off} **${toggle.name}** (\`${key}\`)`;
    if (key === 'aichat' && enabled) {
      line += `\n› Troll Mode: ${guildConfig.features?.aiChat?.trollMode ? 'Enabled' : 'Disabled'}`;
    }
    return line;
  });

  const embed = await infoEmbed(message.guild.id, 'Feature Management',
    `${GLYPHS.INFO} Manage bot features and commands.\n${STATUS_LEGEND}`);

  embed.addFields(
    { name: `${GLYPHS.ARROW_RIGHT} Command Features`, value: categoryLines.join('\n') },
    { name: `${GLYPHS.ARROW_RIGHT} Feature Toggles`, value: toggleLines.join('\n') },
    {
      name: `${GLYPHS.ARROW_RIGHT} Commands`,
      value:
        `\`${prefix}feature enable|disable <feature>\` - Toggle a feature\n` +
        `\`${prefix}feature enable|disable <command>\` - Toggle a single command\n` +
        `\`${prefix}feature status <feature>\` - View a feature's status\n` +
        `\`${prefix}feature list\` - List all disabled commands`
    }
  );

  return message.reply({ embeds: [embed] });
}

async function showDisabledList(message, guildConfig) {
  const guildId = message.guild.id;
  const { text, slash } = getDisabledLists(guildConfig);

  if (text.length === 0 && slash.length === 0) {
    return message.reply({
      embeds: [await infoEmbed(guildId, 'Disabled Commands',
        `${GLYPHS.SUCCESS} No commands are currently disabled. All bot features are active.`)]
    });
  }

  const format = (list, mark = '') => {
    const value = list.map(c => `\`${mark}${c}\``).join(', ');
    return value.length <= 1024 ? value : `${value.slice(0, 1000).replace(/,[^,]*$/, '')}, — and more`;
  };

  const embed = await infoEmbed(guildId, 'Disabled Commands',
    `${GLYPHS.INFO} Commands switched off on this server.`);
  if (text.length) embed.addFields({ name: `${GLYPHS.ARROW_RIGHT} Text Commands (${text.length})`, value: format(text) });
  if (slash.length) embed.addFields({ name: `${GLYPHS.ARROW_RIGHT} Slash Commands (${slash.length})`, value: format(slash, '/') });

  return message.reply({ embeds: [embed] });
}

async function showFeatureStatus(message, guildConfig, feature, client, prefix) {
  const guildId = message.guild.id;
  const toggleKey = findToggle(feature) || (feature === 'troll' || feature === 'trollmode' ? 'aichat' : null);

  if (toggleKey === 'aichat') {
    const aiConfig = guildConfig.features?.aiChat || {};
    const embed = await infoEmbed(guildId, 'AI Chat Status',
      `${GLYPHS.ARROW_RIGHT} **Status:** ${aiConfig.enabled ? 'Enabled' : 'Disabled'}\n` +
      `${GLYPHS.ARROW_RIGHT} **Troll Mode:** ${aiConfig.trollMode ? 'Enabled' : 'Disabled'}\n` +
      `${GLYPHS.ARROW_RIGHT} **Personality:** Raphael`);
    embed.addFields(
      {
        name: `${GLYPHS.ARROW_RIGHT} How to Use`,
        value: `${GLYPHS.DOT} Mention the bot and ask a question\n${GLYPHS.DOT} Reply to the bot's messages`
      },
      {
        name: `${GLYPHS.ARROW_RIGHT} Commands`,
        value:
          `\`${prefix}feature enable|disable aichat\` - Toggle AI Chat\n` +
          `\`${prefix}feature enable|disable troll\` - Toggle Troll Mode`
      }
    );
    return message.reply({ embeds: [embed] });
  }

  if (toggleKey === 'profilecustomization') {
    const profileEnabled = getToggleState(guildConfig, 'profilecustomization');
    const cardOverlay = guildConfig.economy?.cardOverlay || { color: '#000000', opacity: 0.5 };

    const embed = await infoEmbed(guildId, 'Profile Customization Status',
      `${GLYPHS.ARROW_RIGHT} **Status:** ${profileEnabled ? 'Enabled (members customise their own overlay)' : 'Disabled (server overlay applies to everyone)'}`);
    embed.addFields(profileEnabled
      ? {
        name: `${GLYPHS.ARROW_RIGHT} Member Commands`,
        value:
          `\`${prefix}setprofile overlay color <hex>\`\n` +
          `\`${prefix}setprofile overlay opacity <0-100>\`\n\n` +
          `Take control as admin: \`${prefix}feature disable profilecustomization\``
      }
      : {
        name: `${GLYPHS.ARROW_RIGHT} Server Overlay`,
        value:
          `${GLYPHS.DOT} Color: \`${cardOverlay.color}\`\n` +
          `${GLYPHS.DOT} Opacity: \`${Math.round(cardOverlay.opacity * 100)}%\`\n\n` +
          `\`${prefix}setoverlay color <hex>\` / \`${prefix}setoverlay opacity <0-100>\`\n` +
          `Let members customise again: \`${prefix}feature enable profilecustomization\``
      });
    embed.addFields({ name: `${GLYPHS.INFO} Note`, value: 'Background changes via the shop and inventory always work.' });
    return message.reply({ embeds: [embed] });
  }

  if (toggleKey === 'boost') {
    const boostConfig = guildConfig.features?.boostSystem || {};
    const boostChannel = boostConfig.channel ? message.guild.channels.cache.get(boostConfig.channel) : null;

    const embed = await infoEmbed(guildId, 'Boost Announcements Status',
      `${GLYPHS.ARROW_RIGHT} **Status:** ${boostConfig.enabled ? 'Enabled' : 'Disabled'}\n` +
      `${GLYPHS.ARROW_RIGHT} **Channel:** ${boostChannel ? `${boostChannel}` : 'Not set'}\n` +
      `${GLYPHS.ARROW_RIGHT} **Embed Mode:** ${boostConfig.embedEnabled !== false ? 'On' : 'Off'}`);
    embed.addFields({
      name: `${GLYPHS.ARROW_RIGHT} Commands`,
      value:
        `\`${prefix}feature enable|disable boost\` - Toggle boost announcements\n` +
        `\`${prefix}boost channel #channel\` - Set the boost channel\n` +
        `\`${prefix}boost message <text>\` - Set the thank-you message\n` +
        `\`${prefix}boost embed on|off\` - Toggle embed format\n` +
        `\`${prefix}boost test\` - Preview the boost message`
    });
    return message.reply({ embeds: [embed] });
  }

  const category = featureCategories[feature];
  if (!category) {
    return message.reply({
      embeds: [await errorEmbed(guildId, 'Unknown Feature',
        `${GLYPHS.ERROR} \`${feature}\` is not a valid feature.\n\n**Available features:** ${featureList()}`)]
    });
  }

  const { text, slash } = getDisabledLists(guildConfig);
  const commands = resolveCommands(client, category.commands);

  const commandStatus = commands.map(cmd => {
    const textDisabled = text.includes(cmd);
    const slashDisabled = slash.includes(cmd);
    let icon = STATUS.on;
    if (textDisabled && slashDisabled) icon = STATUS.off;
    else if (textDisabled || slashDisabled) icon = STATUS.partial;
    return `${icon} \`${cmd}\``;
  });
  const enabledCount = commands.filter(cmd => !text.includes(cmd) && !slash.includes(cmd)).length;

  const embed = await infoEmbed(guildId, `${category.name} Status`, `${GLYPHS.INFO} ${STATUS_LEGEND}`);
  embed.addFields(
    { name: `${GLYPHS.ARROW_RIGHT} Commands`, value: commandStatus.join('\n') || 'None of these commands are loaded.' },
    { name: `${GLYPHS.ARROW_RIGHT} Summary`, value: `${enabledCount}/${commands.length} commands enabled` }
  );
  if (category.systems) {
    embed.addFields({
      name: `${GLYPHS.ARROW_RIGHT} Systems`,
      value: category.systems.map(system => {
        const enabled = Boolean(system.path.split('.').reduce((value, key) => value?.[key], guildConfig));
        return `${enabled ? STATUS.on : STATUS.off} ${system.label.replace(/^./, c => c.toUpperCase())}`;
      }).join('\n')
    });
  }

  return message.reply({ embeds: [embed] });
}

async function toggleFeature(message, guildConfig, target, isEnabling, client, prefix) {
  const guildId = message.guild.id;
  const state = isEnabling ? 'enabled' : 'disabled';
  const title = `${isEnabling ? 'Enabled' : 'Disabled'}`;

  // Troll Mode (part of AI Chat)
  if (target === 'troll' || target === 'trollmode') {
    if (!guildConfig.features?.aiChat?.enabled && isEnabling) {
      return message.reply({
        embeds: [await errorEmbed(guildId, 'AI Chat Disabled',
          `${GLYPHS.ERROR} AI Chat must be enabled before Troll Mode.\n\nUse \`${prefix}feature enable aichat\` first.`)]
      });
    }

    await Guild.updateGuild(guildId, { $set: { 'features.aiChat.trollMode': isEnabling } });

    return message.reply({
      embeds: [await successEmbed(guildId, `Troll Mode ${title}`,
        `${GLYPHS.SUCCESS} **Troll Mode** has been ${state}.\n\n` +
        (isEnabling
          ? 'My replies will now be considerably more irreverent and chaotic, Master.'
          : 'My replies return to their usual composed, if occasionally cheeky, manner.'))]
    });
  }

  const toggleKey = findToggle(target);

  if (toggleKey === 'aichat') {
    await Guild.updateGuild(guildId, { $set: { 'features.aiChat.enabled': isEnabling } });
    return message.reply({
      embeds: [await successEmbed(guildId, `AI Chat ${title}`,
        `${GLYPHS.SUCCESS} **AI Chat** has been ${state}.\n\n` +
        (isEnabling
          ? `Members can now talk to me by mentioning <@${client.user.id}> or replying to my messages.`
          : 'I will no longer respond to mentions or replies with AI chat.'))]
    });
  }

  if (toggleKey === 'profilecustomization') {
    await Guild.updateGuild(guildId, { $set: { 'economy.profileCustomization.enabled': isEnabling } });
    return message.reply({
      embeds: [await successEmbed(guildId, `Profile Customization ${title}`,
        `${GLYPHS.SUCCESS} **Profile Customization** has been ${state}.\n\n` +
        (isEnabling
          ? `Members can now customise their own overlay color and opacity:\n` +
          `${GLYPHS.DOT} \`${prefix}setprofile overlay color <hex>\`\n` +
          `${GLYPHS.DOT} \`${prefix}setprofile overlay opacity <0-100>\``
          : `Members can no longer customise their overlay. Set the server-wide overlay with:\n` +
          `${GLYPHS.DOT} \`${prefix}setoverlay color <hex>\`\n` +
          `${GLYPHS.DOT} \`${prefix}setoverlay opacity <0-100>\``))]
    });
  }

  if (toggleKey === 'boost') {
    await Guild.updateGuild(guildId, { $set: { 'features.boostSystem.enabled': isEnabling } });
    return message.reply({
      embeds: [await successEmbed(guildId, `Boost Announcements ${title}`,
        `${GLYPHS.SUCCESS} **Boost Announcements** have been ${state}.\n\n` +
        (isEnabling
          ? `I will now thank members who boost the server.\n\n` +
          `**Configure with:**\n` +
          `${GLYPHS.DOT} \`${prefix}boost channel #channel\` - Set the boost channel\n` +
          `${GLYPHS.DOT} \`${prefix}boost message <text>\` - Set the thank-you message\n` +
          `${GLYPHS.DOT} \`${prefix}boost embed on|off\` - Toggle embed format`
          : 'Boost thank-you messages have been disabled.'))]
    });
  }

  const category = featureCategories[target];
  let commandsToManage;
  let featureName;

  if (category) {
    commandsToManage = resolveCommands(client, category.commands);
    featureName = category.name;
  } else {
    // A single command (or alias)
    const command = client.commands.get(target) || client.commands.get(client.aliases?.get(target));
    if (!command) {
      return message.reply({
        embeds: [await errorEmbed(guildId, 'Not Found',
          `${GLYPHS.ERROR} \`${target}\` is not a valid feature or command.\n\n` +
          `**Features:** ${featureList()}\n\nOr use a valid command name.`)]
      });
    }
    commandsToManage = [command.name];
    featureName = `Command: ${command.name}`;
  }

  const skippedProtected = isEnabling ? [] : commandsToManage.filter(cmd => protectedCommands.includes(cmd));
  const affected = commandsToManage.filter(cmd => !skippedProtected.includes(cmd));

  if (!category && affected.length === 0) {
    return message.reply({
      embeds: [await errorEmbed(guildId, 'Protected Command',
        `${GLYPHS.ERROR} \`${commandsToManage[0]}\` cannot be disabled; it is needed to manage the bot.`)]
    });
  }

  const update = isEnabling
    ? { $pull: { 'textCommands.disabledCommands': { $in: affected }, 'slashCommands.disabledCommands': { $in: affected } } }
    : { $addToSet: { 'textCommands.disabledCommands': { $each: affected }, 'slashCommands.disabledCommands': { $each: affected } } };

  // Features with their own on/off flag are switched too, so "disabled" means the system stops
  const systems = category?.systems || [];
  if (systems.length) {
    update.$set = Object.fromEntries(systems.map(system => [system.path, isEnabling]));
  }

  await Guild.updateGuild(guildId, update);

  let description = `${GLYPHS.SUCCESS} **${featureName}** has been ${state}.\n\n`;
  description += `**Commands ${state}:** ${affected.length ? affected.map(c => `\`${c}\``).join(', ') : 'none'}`;
  if (systems.length) {
    description += `\n**Also ${isEnabling ? 'switched on' : 'switched off'}:** ${systems.map(system => system.label).join(', ')}`;
  }
  if (skippedProtected.length > 0) {
    description += `\n\n${GLYPHS.WARNING} **Skipped (protected):** ${skippedProtected.map(c => `\`${c}\``).join(', ')}`;
  }

  return message.reply({
    embeds: [await successEmbed(guildId, category ? `Feature ${title}` : `Command ${title}`, description)]
  });
}
