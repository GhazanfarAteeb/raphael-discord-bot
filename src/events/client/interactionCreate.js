import { Events, Collection, PermissionFlagsBits, MessageFlags, GuildOnboardingPromptType, ApplicationCommandOptionType, ChannelType } from 'discord.js';
import logger from '../../utils/logger.js';
import Guild from '../../models/Guild.js';
import { hasModPerms, isServerAdmin, normalizeAntiNukeAction, getAssignableRoleError } from '../../utils/helpers.js';
import { COLORS } from '../../utils/embeds.js';
import { getRandomFooter } from '../../utils/raphael.js';
import { getSlashCommands } from '../../utils/slashCommands.js';

// Names of the slash commands this build defines. A command dropped from the definitions can
// still be offered by Discord until the next registration, and must not run in the meantime.
const SLASH_COMMAND_NAMES = new Set(getSlashCommands().map(command => command.name));

// Defined option order per command and subcommand path ("ban", "goodbye embed"). Discord lists
// options in the order the user filled them in; the bridge passes them to prefix commands as
// positional args, so it puts them back in the defined order first.
const OPTION_ORDER = new Map();
for (const command of getSlashCommands()) {
  const record = (options = [], path) => {
    OPTION_ORDER.set(path, options.map(option => option.name));
    for (const option of options) {
      if (option.type === ApplicationCommandOptionType.Subcommand || option.type === ApplicationCommandOptionType.SubcommandGroup) {
        record(option.options, `${path} ${option.name}`);
      }
    }
  };
  record(command.toJSON().options, command.name);
}

// Commands /slashcommands can never disable, and that the disabled list never blocks:
// without them an administrator could lock the server out of re-enabling anything.
const PROTECTED_SLASH_COMMANDS = ['slashcommands', 'feature', 'help'];

const GENERIC_FAILURE = '**Alert:** An anomaly occurred while executing this skill, Master. Please try again.';

export default {
  name: Events.InteractionCreate,
  async execute(interaction, client) {
    // Handle autocomplete interactions
    if (interaction.isAutocomplete()) {
      return handleAutocomplete(interaction);
    }

    if (!interaction.isChatInputCommand()) return;

    // Ignore DM interactions - commands only work in guilds
    if (!interaction.guild) {
      return interaction.reply({
        content: '**Notice:** My skills can only be invoked within a server, Master, not in direct messages.',
        flags: MessageFlags.Ephemeral
      }).catch(() => { });
    }

    if (!SLASH_COMMAND_NAMES.has(interaction.commandName)) {
      return interaction.reply({
        content: '**Notice:** This skill has been retired and is no longer available, Master.',
        flags: MessageFlags.Ephemeral
      }).catch(() => { });
    }

    // Check if slash commands are enabled for this guild
    const guildConfig = await Guild.getGuild(interaction.guild.id, interaction.guild.name);

    // Check if command is disabled
    if (
      !PROTECTED_SLASH_COMMANDS.includes(interaction.commandName) &&
      guildConfig.slashCommands?.disabledCommands?.includes(interaction.commandName)
    ) {
      return interaction.reply({
        content: '**Notice:** This command has been deactivated by an administrator, Master.',
        flags: MessageFlags.Ephemeral
      });
    }

    // Check for role-based permissions
    const hasAdminRole = guildConfig.roles.adminRoles?.some(roleId =>
      interaction.member.roles.cache.has(roleId)
    );
    const hasModRole = guildConfig.roles.moderatorRoles?.some(roleId =>
      interaction.member.roles.cache.has(roleId)
    ) || guildConfig.roles.staffRoles?.some(roleId =>
      interaction.member.roles.cache.has(roleId)
    );

    // Handle special slash commands that need custom handling
    const specialCommands = ['automod', 'lockdown', 'setrole', 'setchannel', 'slashcommands', 'refreshcache', 'birthdaysettings', 'setbirthday', 'config', 'setup', 'welcome', 'manageshop', 'verify', 'cmdchannels', 'logs', 'autorole', 'feature', 'giveaway', 'award', 'noxp', 'setoverlay', 'confession', 'onboarding'];
    if (specialCommands.includes(interaction.commandName)) {
      return handleSpecialCommand(interaction, client, guildConfig, hasAdminRole, hasModRole);
    }

    const command = client.commands.get(interaction.commandName);

    if (!command) {
      console.error(`No command matching ${interaction.commandName} was found.`);
      await interaction.reply({
        content: `Command \`/${interaction.commandName}\` not found! The command may not be implemented yet.`,
        flags: MessageFlags.Ephemeral
      }).catch(console.error);
      return;
    }

    // Same gates as the prefix dispatcher: owner-only tools, then array-form permissions
    if (command.ownerOnly && interaction.user.id !== process.env.BOT_OWNER_ID) {
      return interaction.reply({
        content: '**Notice:** This skill is reserved for my creator, Master.',
        flags: MessageFlags.Ephemeral
      });
    }
    if (
      Array.isArray(command.permissions) &&
      !interaction.member.permissions.has(command.permissions) &&
      !hasModPerms(interaction.member, guildConfig)
    ) {
      return interaction.reply({
        content: '**Notice:** Your authority level is insufficient for this skill, Master.',
        flags: MessageFlags.Ephemeral
      });
    }
    if (command.permissions?.user && !interaction.member.permissions.has(command.permissions.user)) {
      return interaction.reply({
        content: '**Notice:** Your authority level is insufficient for this skill, Master.',
        flags: MessageFlags.Ephemeral
      });
    }
    if (command.permissions?.client && !interaction.guild.members.me.permissions.has(command.permissions.client)) {
      return interaction.reply({
        content: '**Alert:** I lack the required permissions to execute this skill, Master.',
        flags: MessageFlags.Ephemeral
      });
    }

    try {
      const startTime = Date.now();

      // Flatten the options into prefix-style args: subcommand group, subcommand, then the
      // option values in order, so "/goodbye channel #bye" reaches the command as
      // "goodbye channel #bye". Users, channels and roles become mention strings and are
      // also put in mentions.*, which is where the prefix commands look for them.
      const args = [];
      const mentions = {
        users: new Collection(),
        members: new Collection(),
        channels: new Collection(),
        roles: new Collection()
      };
      const collectOptions = (options, path) => {
        const order = OPTION_ORDER.get(path) ?? [];
        const ordered = [...options].sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name));
        for (const option of ordered) {
          switch (option.type) {
            case ApplicationCommandOptionType.SubcommandGroup:
            case ApplicationCommandOptionType.Subcommand:
              args.push(option.name);
              collectOptions(option.options ?? [], `${path} ${option.name}`);
              break;
            case ApplicationCommandOptionType.User:
              args.push(`<@${option.value}>`);
              if (option.user) mentions.users.set(option.user.id, option.user);
              if (option.member?.roles) mentions.members.set(option.value, option.member);
              break;
            case ApplicationCommandOptionType.Channel:
              args.push(`<#${option.value}>`);
              if (option.channel) mentions.channels.set(option.value, option.channel);
              break;
            case ApplicationCommandOptionType.Role:
              args.push(`<@&${option.value}>`);
              if (option.role) mentions.roles.set(option.value, option.role);
              break;
            case ApplicationCommandOptionType.Boolean:
              // The prefix toggles (boost, goodbye, levelup, starboard) parse on/off.
              // ban.js reads a trailing true/false as /ban's delete_messages flag.
              args.push(interaction.commandName === 'ban' ? String(option.value) : (option.value ? 'on' : 'off'));
              break;
            default:
              if (option.value !== undefined) args.push(String(option.value));
          }
        }
      };
      collectOptions(interaction.options.data, interaction.commandName);
      // Always end /ban with the flag (true is ban.js's default), so a reason that happens to
      // end in "true" or "false" is never read as delete_messages
      if (interaction.commandName === 'ban' && interaction.options.getBoolean('delete_messages') === null) {
        args.push('true');
      }

      // Convert interaction to message-like object with Collection instead of Map
      const fakeMessage = {
        author: interaction.user,
        client,
        content: `/${interaction.commandName} ${args.join(' ')}`.trim(),
        guild: interaction.guild,
        channel: interaction.channel,
        member: interaction.member,
        mentions,
        reply: async (options) => {
          try {
            if (interaction.deferred || interaction.replied) {
              return await interaction.editReply(options);
            }
            return await interaction.reply(options);
          } catch (error) {
            console.error('Error replying to interaction:', error);
            return null;
          }
        }
      };

      // Defer reply now, before heavy operations
      await interaction.deferReply().catch(() => { });

      // Resolve full members for mentioned users the interaction didn't include
      for (const user of mentions.users.values()) {
        if (!mentions.members.has(user.id) && interaction.guild) {
          const member = await interaction.guild.members.fetch(user.id).catch(() => null);
          if (member) mentions.members.set(user.id, member);
        }
      }

      // Check cooldowns
      if (command.cooldown) {
        const { cooldowns } = client;

        if (!cooldowns.has(command.name)) {
          cooldowns.set(command.name, new Map());
        }

        const now = Date.now();
        const timestamps = cooldowns.get(command.name);
        const cooldownAmount = (command.cooldown || 3) * 1000;

        if (timestamps.has(interaction.user.id)) {
          const expirationTime = timestamps.get(interaction.user.id) + cooldownAmount;

          if (now < expirationTime) {
            const timeLeft = Math.ceil((expirationTime - now) / 1000);

            // Format time left nicely
            let timeString;
            if (timeLeft >= 60) {
              const minutes = Math.floor(timeLeft / 60);
              const seconds = timeLeft % 60;
              timeString = `${minutes} minute${minutes !== 1 ? 's' : ''} ${seconds} second${seconds !== 1 ? 's' : ''}`;
            } else {
              timeString = `${timeLeft} second${timeLeft !== 1 ? 's' : ''}`;
            }

            await interaction.editReply({
              content: `**Notice:** Cooldown active. Please wait **${timeString}** before using \`${command.name}\` again (available <t:${Math.floor(expirationTime / 1000)}:R>), Master.`
            });
            return;
          }
        }

        timestamps.set(interaction.user.id, now);
        setTimeout(() => timestamps.delete(interaction.user.id), cooldownAmount);
      }

      // Execute the command
      // Wave-Music Command class (uses run method with Context)
      if (typeof command.run === 'function') {
        const Context = (await import('../../structures/Context.js')).default;
        const ctx = new Context(interaction, args);
        await command.run(client, ctx, args);
      }
      // Legacy command object (uses execute method)
      else if (typeof command.execute === 'function') {
        await command.execute(fakeMessage, args, client);
      }

      const duration = Date.now() - startTime;
      logger.command(command.name, interaction.user, interaction.guild, true);
      logger.performance(`Slash Command: ${command.name}`, duration, {
        user: interaction.user.tag,
        guild: interaction.guild?.name || 'DM'
      });

    } catch (error) {
      logger.command(command.name, interaction.user, interaction.guild, false, error);
      logger.error(`Slash command execution failed: ${command.name}`, error);
      console.error(`Error executing ${interaction.commandName}:`, error);

      // Replace the deferred "thinking" placeholder rather than leaving it hanging
      if (interaction.replied || interaction.deferred) {
        await interaction.editReply({ content: GENERIC_FAILURE, embeds: [], components: [] }).catch(() => {});
      } else {
        await interaction.reply({ content: GENERIC_FAILURE, flags: MessageFlags.Ephemeral }).catch(() => {});
      }
    }
  },
};

/**
 * Message-shaped wrapper for running a prefix command inside a slash interaction that was
 * already deferred. reply() edits the deferred reply and returns a handle whose edit() keeps
 * editing it: an ephemeral reply can't be edited through Message#edit.
 */
function createDeferredCommandMessage(interaction, client, { args = [], users = [] } = {}) {
  const editReply = async (options) => {
    try {
      await interaction.editReply(options);
    } catch (error) {
      console.error(`[/${interaction.commandName}] Failed to edit the reply:`, error);
    }
    return replyHandle;
  };
  const replyHandle = { edit: editReply };

  return {
    author: interaction.user,
    client,
    content: `/${interaction.commandName} ${args.join(' ')}`.trim(),
    guild: interaction.guild,
    channel: interaction.channel,
    member: interaction.member,
    mentions: {
      users: new Collection(users.map(user => [user.id, user])),
      members: new Collection(),
      channels: new Collection(),
      roles: new Collection()
    },
    reply: editReply
  };
}

// Handle special slash commands that need custom implementations
async function handleSpecialCommand(interaction, client, guildConfig, hasAdminRole, hasModRole) {
  // Commands that moderators/staff can use (not just admins)
  const moderatorCommands = ['welcome', 'giveaway', 'automod', 'logs', 'noxp', 'manageshop', 'confession', 'cmdchannels', 'setoverlay', 'verify', 'birthdaysettings', 'setbirthday', 'feature'];

  // Admin-only commands (require Administrator or admin role)
  // award mints currency/XP and lockdown rewrites every channel: admin-only, as in their prefix versions
  const adminOnlyCommands = ['setup', 'setrole', 'setchannel', 'config', 'slashcommands', 'autorole', 'refreshcache', 'award', 'lockdown'];

  // Check permissions based on command type
  if (adminOnlyCommands.includes(interaction.commandName)) {
    // Admin-only: require Administrator permission or admin role
    if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator) && !hasAdminRole) {
      return interaction.reply({
        content: '**Error:** Administrator permissions required for this function, Master.',
        flags: MessageFlags.Ephemeral
      });
    }
  } else if (moderatorCommands.includes(interaction.commandName)) {
    // Moderator commands: allow Admin, admin role, ManageGuild, or mod/staff role
    const hasPermission = interaction.member.permissions.has(PermissionFlagsBits.Administrator) ||
      interaction.member.permissions.has(PermissionFlagsBits.ManageGuild) ||
      hasAdminRole || hasModRole;
    if (!hasPermission) {
      return interaction.reply({
        content: '**Error:** You need Moderator/Staff permissions to use this function, Master.',
        flags: MessageFlags.Ephemeral
      });
    }
  } else {
    // Default: require Administrator permissions
    if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator) && !hasAdminRole) {
      return interaction.reply({
        content: '**Error:** Administrator permissions required for this function, Master.',
        flags: MessageFlags.Ephemeral
      });
    }
  }

  try {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  } catch (error) {
    console.error(`Could not defer /${interaction.commandName}:`, error);
    return;
  }

  // Remember whether the handler already answered, so a failure in a later side effect
  // (an alert post, a DM) can't overwrite a reply that reported success
  let answered = false;
  const editReply = interaction.editReply.bind(interaction);
  interaction.editReply = async (options) => {
    const reply = await editReply(options);
    answered = true;
    return reply;
  };

  try {
    switch (interaction.commandName) {
      case 'automod':
        await handleAutomodCommand(interaction, guildConfig);
        break;
      case 'lockdown':
        await handleLockdownCommand(interaction, client);
        break;
      case 'setrole':
        await handleSetroleCommand(interaction, guildConfig);
        break;
      case 'setchannel':
        await handleSetchannelCommand(interaction, guildConfig);
        break;
      case 'slashcommands':
        await handleSlashcommandsCommand(interaction, guildConfig);
        break;
      case 'refreshcache':
        await handleRefreshCacheCommand(interaction, client);
        break;
      case 'birthdaysettings':
        await handleBirthdaySettingsCommand(interaction, guildConfig);
        break;
      case 'setbirthday':
        await handleSetBirthdayCommand(interaction, client);
        break;
      case 'config':
        await handleConfigCommand(interaction, guildConfig);
        break;
      case 'setup':
        await handleSetupCommand(interaction, client);
        break;
      case 'welcome':
        await handleWelcomeCommand(interaction, guildConfig);
        break;
      case 'manageshop':
        await handleManageshopCommand(interaction, guildConfig);
        break;
      case 'verify':
        await handleVerifyCommand(interaction, guildConfig);
        break;
      case 'cmdchannels':
        await handleCmdchannelsCommand(interaction, guildConfig);
        break;
      case 'logs':
        await handleLogsCommand(interaction, guildConfig);
        break;
      case 'autorole':
        await handleAutoroleCommand(interaction, guildConfig);
        break;
      case 'feature':
        await handleFeatureCommand(interaction, client, guildConfig);
        break;
      case 'giveaway':
        await handleGiveawayCommand(interaction, client);
        break;
      case 'award':
        await handleAwardCommand(interaction, client, guildConfig);
        break;
      case 'noxp':
        await handleNoxpCommand(interaction, guildConfig);
        break;
      case 'setoverlay':
        await handleSetoverlayCommand(interaction, guildConfig);
        break;
      case 'confession':
        await handleConfessionCommand(interaction);
        break;
      case 'onboarding':
        await handleOnboardingCommand(interaction, guildConfig);
        break;
    }
  } catch (error) {
    console.error(`Error handling ${interaction.commandName}:`, error);
    if (answered) return;
    await interaction.editReply({ content: GENERIC_FAILURE, embeds: [], components: [] }).catch(() => { });
  }
}

async function handleAutomodCommand(interaction, guildConfig) {
  const { successEmbed, errorEmbed, infoEmbed, GLYPHS } = await import('../../utils/embeds.js');
  const subcommand = interaction.options.getSubcommand();

  switch (subcommand) {
    case 'enable':
      await Guild.updateGuild(interaction.guild.id, { $set: { 'features.autoMod.enabled': true } });
      await interaction.editReply({
        embeds: [await successEmbed(interaction.guild.id, 'AutoMod Enabled',
          `${GLYPHS.SUCCESS} AutoMod has been enabled for this server.`)]
      });
      break;

    case 'disable':
      await Guild.updateGuild(interaction.guild.id, { $set: { 'features.autoMod.enabled': false } });
      await interaction.editReply({
        embeds: [await successEmbed(interaction.guild.id, 'AutoMod Disabled',
          `${GLYPHS.SUCCESS} AutoMod has been disabled for this server.`)]
      });
      break;

    case 'status': {
      const autoMod = guildConfig.features.autoMod;
      // Helper to safely check if a feature is enabled (handles boolean or object)
      const isEnabled = (feature) => {
        if (typeof feature === 'boolean') return feature;
        return feature?.enabled ?? false;
      };
      const state = (feature) => isEnabled(feature) ? '◉ Active' : '◇ Inactive';
      const spamLimit = typeof autoMod.antiSpam === 'object' ? autoMod.antiSpam.messageLimit : 5;
      const spamWindow = typeof autoMod.antiSpam === 'object' ? autoMod.antiSpam.timeWindow : 5;

      const statusEmbed = await infoEmbed(interaction.guild.id, 'AutoMod Status',
        `**▸ Overall:** ${autoMod.enabled ? '◉ Active' : '◇ Inactive'}`);
      statusEmbed.addFields(
        { name: '▸ Anti-Spam', value: `${state(autoMod.antiSpam)}\n${spamLimit} msgs / ${spamWindow}s`, inline: true },
        { name: '▸ Anti-Raid', value: `${state(autoMod.antiRaid)}\n${autoMod.antiRaid?.joinThreshold || 10} joins / ${autoMod.antiRaid?.timeWindow || 30}s`, inline: true },
        { name: '▸ Anti-Nuke', value: state(autoMod.antiNuke), inline: true },
        { name: '▸ Anti-Invites', value: state(autoMod.antiInvites), inline: true },
        { name: '▸ Anti-Links', value: state(autoMod.antiLinks), inline: true },
        { name: '▸ Bad Words', value: `${state(autoMod.badWords)}\n${autoMod.badWords?.words?.length || 0} custom words`, inline: true },
        { name: '▸ Mass Mention', value: `${state(autoMod.antiMassMention)}\nLimit: ${autoMod.antiMassMention?.limit || 5}`, inline: true }
      );
      await interaction.editReply({ embeds: [statusEmbed] });
      break;
    }

    case 'badwords':
      await handleBadwordsSubcommand(interaction, guildConfig);
      break;

    case 'antispam':
      const spamEnabled = interaction.options.getBoolean('enabled');
      const messageLimit = interaction.options.getInteger('message_limit');
      const timeWindow = interaction.options.getInteger('time_window');

      // Ensure antiSpam is an object (fix for legacy boolean values)
      const antiSpamConfig = (!guildConfig.features.autoMod.antiSpam || typeof guildConfig.features.autoMod.antiSpam === 'boolean')
        ? { enabled: false, messageLimit: 5, timeWindow: 5, action: 'warn' }
        : { ...guildConfig.features.autoMod.antiSpam };

      antiSpamConfig.enabled = spamEnabled;
      if (messageLimit) antiSpamConfig.messageLimit = messageLimit;
      if (timeWindow) antiSpamConfig.timeWindow = timeWindow;
      await Guild.updateGuild(interaction.guild.id, { $set: { 'features.autoMod.antiSpam': antiSpamConfig } });

      await interaction.editReply({
        embeds: [await successEmbed(interaction.guild.id, 'Anti-Spam Updated',
          `${GLYPHS.SUCCESS} Anti-Spam is now ${spamEnabled ? 'enabled' : 'disabled'}.\n` +
          `${GLYPHS.DOT} Message Limit: ${antiSpamConfig.messageLimit}\n` +
          `${GLYPHS.DOT} Time Window: ${antiSpamConfig.timeWindow}s`)]
      });
      break;

    case 'antiraid':
      const raidEnabled = interaction.options.getBoolean('enabled');
      const joinThreshold = interaction.options.getInteger('join_threshold');
      const raidAction = interaction.options.getString('action');

      // Ensure antiRaid is an object (fix for legacy boolean values)
      const antiRaidConfig = (!guildConfig.features.autoMod.antiRaid || typeof guildConfig.features.autoMod.antiRaid === 'boolean')
        ? { enabled: false, joinThreshold: 10, timeWindow: 30, action: 'lockdown' }
        : { ...guildConfig.features.autoMod.antiRaid };

      antiRaidConfig.enabled = raidEnabled;
      if (joinThreshold) antiRaidConfig.joinThreshold = joinThreshold;
      if (raidAction) antiRaidConfig.action = raidAction;
      await Guild.updateGuild(interaction.guild.id, { $set: { 'features.autoMod.antiRaid': antiRaidConfig } });

      await interaction.editReply({
        embeds: [await successEmbed(interaction.guild.id, 'Anti-Raid Updated',
          `${GLYPHS.SUCCESS} Anti-Raid is now ${raidEnabled ? 'enabled' : 'disabled'}.\n` +
          `${GLYPHS.DOT} Join Threshold: ${antiRaidConfig.joinThreshold}\n` +
          `${GLYPHS.DOT} Action: ${antiRaidConfig.action}`)]
      });
      break;

    case 'antinuke':
      // Owner/Administrator only: staff roles must not be able to disable anti-nuke
      if (!isServerAdmin(interaction.member)) {
        return interaction.editReply({
          embeds: [await errorEmbed(interaction.guild.id, 'Permission Denied',
            'Anti-nuke can only be configured by the server owner or an Administrator, Master.')]
        });
      }
      const nukeEnabled = interaction.options.getBoolean('enabled');
      const nukeAction = normalizeAntiNukeAction(interaction.options.getString('action'));

      // Ensure antiNuke is an object (fix for legacy boolean values)
      // Ensure antiNuke is an object (fix for legacy boolean values)
      const antiNukeConfig = (!guildConfig.features.autoMod.antiNuke || typeof guildConfig.features.autoMod.antiNuke === 'boolean')
        ? { enabled: false, banThreshold: 5, kickThreshold: 5, roleDeleteThreshold: 3, channelDeleteThreshold: 3, timeWindow: 60, action: 'removeRoles', whitelistedUsers: [] }
        : { ...guildConfig.features.autoMod.antiNuke };

      antiNukeConfig.enabled = nukeEnabled;
      if (nukeAction) antiNukeConfig.action = nukeAction;
      await Guild.updateGuild(interaction.guild.id, { $set: { 'features.autoMod.antiNuke': antiNukeConfig } });

      await interaction.editReply({
        embeds: [await successEmbed(interaction.guild.id, 'Anti-Nuke Updated',
          `${GLYPHS.SUCCESS} Anti-Nuke is now ${nukeEnabled ? 'enabled' : 'disabled'}.\n` +
          `${GLYPHS.DOT} Action: ${antiNukeConfig.action}`)]
      });
      break;

    case 'ignore-add-channel':
      await handleIgnoreAddChannel(interaction, guildConfig);
      break;

    case 'ignore-remove-channel':
      await handleIgnoreRemoveChannel(interaction, guildConfig);
      break;

    case 'ignore-add-role':
      await handleIgnoreAddRole(interaction, guildConfig);
      break;

    case 'ignore-remove-role':
      await handleIgnoreRemoveRole(interaction, guildConfig);
      break;

    case 'ignore-list':
      await handleIgnoreList(interaction, guildConfig);
      break;

    case 'badwords-ignore':
      await handleBadwordsIgnore(interaction, guildConfig);
      break;

    case 'badwords-unignore':
      await handleBadwordsUnignore(interaction, guildConfig);
      break;

    case 'badwords-ignoredlist':
      await handleBadwordsIgnoredList(interaction, guildConfig);
      break;
  }
}

// AutoMod Ignore Handlers
async function handleIgnoreAddChannel(interaction, guildConfig) {
  const { successEmbed, errorEmbed, GLYPHS } = await import('../../utils/embeds.js');
  const channel = interaction.options.getChannel('channel');
  const guildId = interaction.guild.id;

  if (!guildConfig.features) guildConfig.features = {};
  if (!guildConfig.features.autoMod) guildConfig.features.autoMod = {};
  if (!guildConfig.features.autoMod.ignoredChannels) guildConfig.features.autoMod.ignoredChannels = [];

  if (guildConfig.features.autoMod.ignoredChannels.includes(channel.id)) {
    return interaction.editReply({
      embeds: [await errorEmbed(guildId, 'Already Ignored',
        `${channel} is already in the automod ignore list.`)]
    });
  }

  const updatedIgnoredChannels = [...(guildConfig.features?.autoMod?.ignoredChannels || []), channel.id];
  await Guild.updateGuild(guildId, { $set: { 'features.autoMod.ignoredChannels': updatedIgnoredChannels } });

  return interaction.editReply({
    embeds: [await successEmbed(guildId, 'AutoMod Ignore Updated',
      `${GLYPHS.SUCCESS} Successfully added ${channel} to the automod ignored channels list.\n\n` +
      `**Effect:** AutoMod will no longer monitor messages in this channel.`)]
  });
}

async function handleIgnoreRemoveChannel(interaction, guildConfig) {
  const { successEmbed, errorEmbed, GLYPHS } = await import('../../utils/embeds.js');
  const channel = interaction.options.getChannel('channel');
  const guildId = interaction.guild.id;

  if (!guildConfig?.features?.autoMod?.ignoredChannels) {
    return interaction.editReply({
      embeds: [await errorEmbed(guildId, 'Not Found',
        'No automod ignore settings found.')]
    });
  }

  const list = guildConfig.features.autoMod.ignoredChannels || [];

  if (!list.includes(channel.id)) {
    return interaction.editReply({
      embeds: [await errorEmbed(guildId, 'Not Found',
        `${channel} is not in the automod ignore list.`)]
    });
  }

  const filteredChannels = list.filter(id => id !== channel.id);
  await Guild.updateGuild(guildId, { $set: { 'features.autoMod.ignoredChannels': filteredChannels } });

  return interaction.editReply({
    embeds: [await successEmbed(guildId, 'AutoMod Ignore Updated',
      `${GLYPHS.SUCCESS} Successfully removed ${channel} from the automod ignored channels list.\n\n` +
      `**Effect:** AutoMod will now monitor messages in this channel.`)]
  });
}

async function handleIgnoreAddRole(interaction, guildConfig) {
  const { successEmbed, errorEmbed, GLYPHS } = await import('../../utils/embeds.js');
  const role = interaction.options.getRole('role');
  const guildId = interaction.guild.id;

  if (!guildConfig.features) guildConfig.features = {};
  if (!guildConfig.features.autoMod) guildConfig.features.autoMod = {};
  if (!guildConfig.features.autoMod.ignoredRoles) guildConfig.features.autoMod.ignoredRoles = [];

  if (guildConfig.features.autoMod.ignoredRoles.includes(role.id)) {
    return interaction.editReply({
      embeds: [await errorEmbed(guildId, 'Already Ignored',
        `${role} is already in the automod bypass list.`)]
    });
  }

  const updatedIgnoredRoles = [...(guildConfig.features?.autoMod?.ignoredRoles || []), role.id];
  await Guild.updateGuild(guildId, { $set: { 'features.autoMod.ignoredRoles': updatedIgnoredRoles } });

  return interaction.editReply({
    embeds: [await successEmbed(guildId, 'AutoMod Ignore Updated',
      `${GLYPHS.SUCCESS} Successfully added ${role} to the automod bypass roles list.\n\n` +
      `**Effect:** AutoMod will no longer monitor users with this role.`)]
  });
}

async function handleIgnoreRemoveRole(interaction, guildConfig) {
  const { successEmbed, errorEmbed, GLYPHS } = await import('../../utils/embeds.js');
  const role = interaction.options.getRole('role');
  const guildId = interaction.guild.id;

  if (!guildConfig?.features?.autoMod?.ignoredRoles) {
    return interaction.editReply({
      embeds: [await errorEmbed(guildId, 'Not Found',
        'No automod ignore settings found.')]
    });
  }

  const list = guildConfig.features.autoMod.ignoredRoles || [];

  if (!list.includes(role.id)) {
    return interaction.editReply({
      embeds: [await errorEmbed(guildId, 'Not Found',
        `${role} is not in the automod bypass list.`)]
    });
  }

  const filteredRoles = list.filter(id => id !== role.id);
  await Guild.updateGuild(guildId, { $set: { 'features.autoMod.ignoredRoles': filteredRoles } });

  return interaction.editReply({
    embeds: [await successEmbed(guildId, 'AutoMod Ignore Updated',
      `${GLYPHS.SUCCESS} Successfully removed ${role} from the automod bypass roles list.\n\n` +
      `**Effect:** AutoMod will now monitor users with this role.`)]
  });
}

async function handleIgnoreList(interaction, guildConfig) {
  const { infoEmbed, GLYPHS } = await import('../../utils/embeds.js');
  const guildId = interaction.guild.id;

  const ignoredChannels = guildConfig?.features?.autoMod?.ignoredChannels || [];
  const ignoredRoles = guildConfig?.features?.autoMod?.ignoredRoles || [];

  let description = '**Ignored Channels:**\n';
  if (ignoredChannels.length === 0) {
    description += `${GLYPHS.DOT} None\n`;
  } else {
    for (const channelId of ignoredChannels) {
      const channel = interaction.guild.channels.cache.get(channelId);
      description += `${GLYPHS.DOT} ${channel || `<#${channelId}> (deleted)`}\n`;
    }
  }

  description += '\n**Bypass Roles:**\n';
  if (ignoredRoles.length === 0) {
    description += `${GLYPHS.DOT} None\n`;
  } else {
    for (const roleId of ignoredRoles) {
      const role = interaction.guild.roles.cache.get(roleId);
      description += `${GLYPHS.DOT} ${role || `<@&${roleId}> (deleted)`}\n`;
    }
  }

  const embed = await infoEmbed(guildId,
    '『 AutoMod Ignore Settings 』',
    description
  );

  return interaction.editReply({ embeds: [embed] });
}

async function handleBadwordsSubcommand(interaction, guildConfig) {
  const { successEmbed, errorEmbed, infoEmbed, GLYPHS } = await import('../../utils/embeds.js');
  const action = interaction.options.getString('action');
  const words = interaction.options.getString('words');
  const punishment = interaction.options.getString('punishment');

  // Get current badWords config or initialize
  const badWordsConfig = guildConfig.features.autoMod.badWords || { enabled: false, words: [], action: 'delete' };

  switch (action) {
    case 'add':
      if (!words) {
        return interaction.editReply({
          embeds: [await errorEmbed(interaction.guild.id, 'Missing Words',
            'Please provide words to add (comma separated).')]
        });
      }
      const newWords = words.split(',').map(w => w.trim().toLowerCase()).filter(w => w);
      const existingWords = badWordsConfig.words || [];
      const updatedWords = [...new Set([...existingWords, ...newWords])];
      await Guild.updateGuild(interaction.guild.id, { $set: { 'features.autoMod.badWords.words': updatedWords } });

      await interaction.editReply({
        embeds: [await successEmbed(interaction.guild.id, 'Words Added',
          `${GLYPHS.SUCCESS} Added ${newWords.length} word(s) to the filter.\n` +
          `Total words: ${updatedWords.length}`)]
      });
      break;

    case 'remove':
      if (!words) {
        return interaction.editReply({
          embeds: [await errorEmbed(interaction.guild.id, 'Missing Words',
            'Please provide words to remove (comma separated).')]
        });
      }
      const removeWords = words.split(',').map(w => w.trim().toLowerCase());
      const filteredWords = (badWordsConfig.words || [])
        .filter(w => !removeWords.includes(w));
      await Guild.updateGuild(interaction.guild.id, { $set: { 'features.autoMod.badWords.words': filteredWords } });

      await interaction.editReply({
        embeds: [await successEmbed(interaction.guild.id, 'Words Removed',
          `${GLYPHS.SUCCESS} Removed words from the filter.\n` +
          `Total words: ${filteredWords.length}`)]
      });
      break;

    case 'list':
      const wordList = badWordsConfig.words || [];
      if (wordList.length === 0) {
        return interaction.editReply({
          embeds: [await infoEmbed(interaction.guild.id, 'Bad Words List',
            'No bad words configured. Use `/automod badwords add` to add words.')]
        });
      }

      // Hide actual words, just show count and masked preview
      const maskedWords = wordList.map(w => w[0] + '*'.repeat(w.length - 1)).slice(0, 20);
      await interaction.editReply({
        embeds: [await infoEmbed(interaction.guild.id, 'Bad Words List',
          `**Total Words:** ${wordList.length}\n\n` +
          `**Preview (masked):**\n${maskedWords.join(', ')}${wordList.length > 20 ? '...' : ''}\n\n` +
          `**Current Action:** ${badWordsConfig.action}`)]
      });
      break;

    case 'setaction':
      if (!punishment) {
        return interaction.editReply({
          embeds: [await errorEmbed(interaction.guild.id, 'Missing Punishment',
            'Please select a punishment action.')]
        });
      }
      await Guild.updateGuild(interaction.guild.id, { $set: { 'features.autoMod.badWords.action': punishment } });

      await interaction.editReply({
        embeds: [await successEmbed(interaction.guild.id, 'Action Updated',
          `${GLYPHS.SUCCESS} Bad words action set to: **${punishment}**`)]
      });
      break;

    case 'enable':
      await Guild.updateGuild(interaction.guild.id, { $set: { 'features.autoMod.badWords.enabled': true } });
      await interaction.editReply({
        embeds: [await successEmbed(interaction.guild.id, 'Bad Words Filter Enabled',
          `${GLYPHS.SUCCESS} Bad words filter is now enabled.`)]
      });
      break;

    case 'disable':
      await Guild.updateGuild(interaction.guild.id, { $set: { 'features.autoMod.badWords.enabled': false } });
      await interaction.editReply({
        embeds: [await successEmbed(interaction.guild.id, 'Bad Words Filter Disabled',
          `${GLYPHS.SUCCESS} Bad words filter is now disabled.`)]
      });
      break;
  }
}

// Handle badwords ignore - add words to whitelist
async function handleBadwordsIgnore(interaction, guildConfig) {
  const { successEmbed, errorEmbed, GLYPHS } = await import('../../utils/embeds.js');
  const words = interaction.options.getString('words');

  if (!words) {
    return interaction.editReply({
      embeds: [await errorEmbed(interaction.guild.id, 'Missing Words',
        'Please provide words to ignore (comma separated).')]
    });
  }

  const ignoreWords = words.split(',').map(w => w.trim().toLowerCase()).filter(w => w);
  const existingIgnored = guildConfig.features.autoMod.badWords?.ignoredWords || [];
  const updatedIgnored = [...new Set([...existingIgnored, ...ignoreWords])];

  await Guild.updateGuild(interaction.guild.id, { $set: { 'features.autoMod.badWords.ignoredWords': updatedIgnored } });

  await interaction.editReply({
    embeds: [await successEmbed(interaction.guild.id, 'Words Ignored',
      `${GLYPHS.SUCCESS} Added ${ignoreWords.length} word(s) to whitelist.\n` +
      `These words will not trigger the filter.\n\n` +
      `**Total Ignored Words:** ${updatedIgnored.length}`)]
  });
}

// Handle badwords unignore - remove words from whitelist
async function handleBadwordsUnignore(interaction, guildConfig) {
  const { successEmbed, errorEmbed, GLYPHS } = await import('../../utils/embeds.js');
  const words = interaction.options.getString('words');

  if (!words) {
    return interaction.editReply({
      embeds: [await errorEmbed(interaction.guild.id, 'Missing Words',
        'Please provide words to remove from whitelist (comma separated).')]
    });
  }

  const unignoreWords = words.split(',').map(w => w.trim().toLowerCase());
  const existingIgnored = guildConfig.features.autoMod.badWords?.ignoredWords || [];
  const updatedIgnored = existingIgnored.filter(w => !unignoreWords.includes(w));

  await Guild.updateGuild(interaction.guild.id, { $set: { 'features.autoMod.badWords.ignoredWords': updatedIgnored } });

  await interaction.editReply({
    embeds: [await successEmbed(interaction.guild.id, 'Words Unignored',
      `${GLYPHS.SUCCESS} Removed word(s) from whitelist.\n\n` +
      `**Total Ignored Words:** ${updatedIgnored.length}`)]
  });
}

// Handle badwords ignored list - view all whitelisted words
async function handleBadwordsIgnoredList(interaction, guildConfig) {
  const { infoEmbed } = await import('../../utils/embeds.js');

  const ignoredList = guildConfig.features.autoMod.badWords?.ignoredWords || [];

  if (ignoredList.length === 0) {
    return interaction.editReply({
      embeds: [await infoEmbed(interaction.guild.id, 'Ignored Words List',
        'No words are currently whitelisted/ignored.\n\n' +
        'Use `/automod badwords-ignore` to add words to the whitelist.')]
    });
  }

  // Show the ignored words (these are safe to display since they're whitelisted)
  const displayWords = ignoredList.slice(0, 50).join(', ');

  await interaction.editReply({
    embeds: [await infoEmbed(interaction.guild.id, 'Ignored Words List',
      `**Total Ignored Words:** ${ignoredList.length}\n\n` +
      `**Words:**\n${displayWords}${ignoredList.length > 50 ? '\n\n*...and more*' : ''}`)]
  });
}

// /lockdown runs the prefix command, so both save the channels' original @everyone overwrites
// to security.lockdownPermissions and restore them on unlock, whichever form locked the server
async function handleLockdownCommand(interaction, client) {
  const lockdownCommand = (await import('../../commands/moderation/lockdown.js')).default;

  const action = interaction.options.getString('action');
  const reason = interaction.options.getString('reason');
  const args = [action, ...(reason ? reason.trim().split(/\s+/) : [])];

  await lockdownCommand.execute(createDeferredCommandMessage(interaction, client, { args }), args, client);
}

async function handleSetroleCommand(interaction, guildConfig) {
  const { successEmbed, errorEmbed, GLYPHS } = await import('../../utils/embeds.js');

  const type = interaction.options.getString('type');
  const role = interaction.options.getRole('role');

  // @everyone or an integration's role here would make every member (or a bot) staff
  if (role.id === interaction.guild.id || role.managed) {
    return interaction.editReply({
      embeds: [await errorEmbed(interaction.guild.id, 'Role Not Allowed', `${role} cannot be used as a bot role, Master.`)]
    });
  }
  // Only the owner or a real Administrator may create more bot admins/moderators ('staff' also adds a moderator role)
  if (['admin', 'staff'].includes(type) && !isServerAdmin(interaction.member)) {
    return interaction.editReply({
      embeds: [await errorEmbed(interaction.guild.id, 'Permission Denied',
        'Only the server owner or an Administrator can grant bot admin or moderator roles, Master.')]
    });
  }

  let updateData = {};

  switch (type) {
    case 'staff':
      const staffRoles = guildConfig.roles?.staffRoles || [];
      const moderatorRoles = guildConfig.roles?.moderatorRoles || [];
      if (!staffRoles.includes(role.id)) staffRoles.push(role.id);
      if (!moderatorRoles.includes(role.id)) moderatorRoles.push(role.id);
      updateData = {
        'roles.staffRoles': staffRoles,
        'roles.moderatorRoles': moderatorRoles
      };
      break;
    case 'admin':
      const adminRoles = guildConfig.roles?.adminRoles || [];
      if (!adminRoles.includes(role.id)) adminRoles.push(role.id);
      updateData = { 'roles.adminRoles': adminRoles };
      break;
    case 'sus':
      updateData = {
        'roles.susRole': role.id,
        'features.memberTracking.susRole': role.id
      };
      break;
    case 'newaccount':
      updateData = { 'roles.newAccountRole': role.id };
      break;
    case 'muted':
      updateData = { 'roles.mutedRole': role.id };
      break;
  }

  await Guild.updateGuild(interaction.guild.id, { $set: updateData });

  const typeNames = {
    staff: 'Staff/Moderator',
    admin: 'Admin',
    sus: 'Suspicious Member',
    newaccount: 'New Account',
    muted: 'Muted'
  };

  await interaction.editReply({
    embeds: [await successEmbed(interaction.guild.id, 'Role Configured',
      `${GLYPHS.SUCCESS} **${typeNames[type]}** role set to ${role}`)]
  });
}

async function handleSetchannelCommand(interaction, guildConfig) {
  const { successEmbed, GLYPHS } = await import('../../utils/embeds.js');

  const type = interaction.options.getString('type');
  const channel = interaction.options.getChannel('channel');

  const channelMap = {
    'modlog': 'channels.modLog',
    'alertlog': 'channels.alertLog',
    'joinlog': 'channels.joinLog',
    'leavelog': 'channels.leaveLog',
    'messagelog': 'channels.messageLog',
    'staff': 'channels.staffChannel'
  };

  const updateKey = channelMap[type];
  if (updateKey) {
    await Guild.updateGuild(interaction.guild.id, { $set: { [updateKey]: channel.id } });
  }

  const typeNames = {
    modlog: 'Mod Log',
    alertlog: 'Alert Log',
    joinlog: 'Join Log',
    leavelog: 'Leave Log',
    messagelog: 'Message Log',
    staff: 'Staff Channel'
  };

  await interaction.editReply({
    embeds: [await successEmbed(interaction.guild.id, 'Channel Configured',
      `${GLYPHS.SUCCESS} **${typeNames[type]}** channel set to ${channel}`)]
  });
}

async function handleSlashcommandsCommand(interaction, guildConfig) {
  const { successEmbed, errorEmbed, infoEmbed, GLYPHS } = await import('../../utils/embeds.js');

  const subcommand = interaction.options.getSubcommand();
  const disabledCommands = guildConfig.slashCommands?.disabledCommands || [];
  const commandName = interaction.options.getString('command')?.trim().toLowerCase().replace(/^\//, '');

  switch (subcommand) {
    case 'enable': {
      if (!disabledCommands.includes(commandName)) {
        return interaction.editReply({
          embeds: [await errorEmbed(interaction.guild.id, 'Not Disabled',
            SLASH_COMMAND_NAMES.has(commandName)
              ? `\`/${commandName}\` is already enabled, Master.`
              : `\`/${commandName}\` is not one of my slash commands, Master. Use \`/slashcommands list\` to view them.`)]
        });
      }
      await Guild.updateGuild(interaction.guild.id, { $pull: { 'slashCommands.disabledCommands': commandName } });

      await interaction.editReply({
        embeds: [await successEmbed(interaction.guild.id, 'Command Enabled',
          `${GLYPHS.SUCCESS} Slash command \`/${commandName}\` is now enabled.`)]
      });
      break;
    }

    case 'disable': {
      if (!SLASH_COMMAND_NAMES.has(commandName)) {
        return interaction.editReply({
          embeds: [await errorEmbed(interaction.guild.id, 'Unknown Command',
            `\`/${commandName}\` is not one of my slash commands, Master. Use \`/slashcommands list\` to view them.`)]
        });
      }
      if (PROTECTED_SLASH_COMMANDS.includes(commandName)) {
        return interaction.editReply({
          embeds: [await errorEmbed(interaction.guild.id, 'Protected Command',
            `\`/${commandName}\` cannot be disabled, Master: administrators need it to manage the others.`)]
        });
      }
      await Guild.updateGuild(interaction.guild.id, { $addToSet: { 'slashCommands.disabledCommands': commandName } });

      await interaction.editReply({
        embeds: [await successEmbed(interaction.guild.id, 'Command Disabled',
          `${GLYPHS.SUCCESS} Slash command \`/${commandName}\` is now disabled.`)]
      });
      break;
    }

    case 'list': {
      const names = [...SLASH_COMMAND_NAMES].sort();
      const formatNames = (list) => truncateList(list.map(name => `\`/${name}\``).join(', '), 1024) || 'None';
      const enabled = names.filter(name => !disabledCommands.includes(name));
      const disabled = names.filter(name => disabledCommands.includes(name));

      const embed = await infoEmbed(interaction.guild.id, 'Slash Commands',
        `**▸ Status:** ${guildConfig.slashCommands?.enabled !== false ? '◉ Active' : '◇ Inactive'}`);
      embed.addFields(
        { name: `◉ Enabled (${enabled.length})`, value: formatNames(enabled) },
        { name: `◇ Disabled (${disabled.length})`, value: formatNames(disabled) }
      );
      await interaction.editReply({ embeds: [embed] });
      break;
    }
  }
}

// Shorten a comma-separated list to fit a Discord length limit, cutting at an item boundary
function truncateList(text, limit) {
  if (text.length <= limit) return text;
  const suffix = ', …';
  const cut = text.slice(0, limit - suffix.length);
  return `${cut.slice(0, cut.lastIndexOf(','))}${suffix}`;
}

async function handleRefreshCacheCommand(interaction, client) {
  const { successEmbed } = await import('../../utils/embeds.js');

  const cacheType = interaction.options.getString('type') || 'all';
  const guild = interaction.guild;
  const refreshed = [];

  try {
    // Drop the cached settings (Redis and in-memory) and reload them from the database
    if (cacheType === 'all' || cacheType === 'guild') {
      await Guild.invalidateCache(guild.id);
      await Guild.getGuild(guild.id, guild.name);
      refreshed.push('◉ Guild Settings');
    }

    // Refresh Members cache
    if (cacheType === 'all' || cacheType === 'members') {
      await guild.members.fetch();
      refreshed.push(`◉ Members (${guild.memberCount} cached)`);
    }

    // Refresh Roles cache
    if (cacheType === 'all' || cacheType === 'roles') {
      await guild.roles.fetch();
      refreshed.push(`◉ Roles (${guild.roles.cache.size} cached)`);
    }

    // Refresh Channels cache
    if (cacheType === 'all' || cacheType === 'channels') {
      await guild.channels.fetch();
      refreshed.push(`◉ Channels (${guild.channels.cache.size} cached)`);
    }

    // Refresh Invites cache
    if (cacheType === 'all' || cacheType === 'invites') {
      try {
        const invites = await guild.invites.fetch();
        client.invites.set(guild.id, new Map(invites.map(inv => [inv.code, inv.uses])));
        refreshed.push(`◉ Invites (${invites.size} cached)`);
      } catch (invErr) {
        refreshed.push('◇ Invites (no permission)');
      }
    }

    const embed = await successEmbed(interaction.guild.id, 'Cache Refreshed',
      `**Confirmed:** Cache refresh complete for **${guild.name}**, Master.\n\n` +
      `**Refreshed:**\n${refreshed.join('\n')}\n\n` +
      `**Refreshed at:** <t:${Math.floor(Date.now() / 1000)}:F>`
    );

    await interaction.editReply({ embeds: [embed] });

  } catch (error) {
    console.error('Error refreshing cache:', error);
    const { errorEmbed } = await import('../../utils/embeds.js');
    await interaction.editReply({
      embeds: [await errorEmbed(interaction.guild.id, 'Refresh Failed', `Cache refresh failed: ${error.message}`)]
    });
  }
}

// Birthday Settings Handler
async function handleBirthdaySettingsCommand(interaction, guildConfig) {
  const { successEmbed, errorEmbed, infoEmbed, GLYPHS } = await import('../../utils/embeds.js');
  const subcommand = interaction.options.getSubcommand();

  switch (subcommand) {
    case 'channel': {
      const channel = interaction.options.getChannel('channel');
      await Guild.updateGuild(interaction.guild.id, {
        $set: {
          'features.birthdaySystem.channel': channel.id,
          'channels.birthdayChannel': channel.id
        }
      });
      await interaction.editReply({
        embeds: [await successEmbed(interaction.guild.id, 'Birthday Channel Set',
          `${GLYPHS.SUCCESS} Birthday announcements will be sent to ${channel}`)]
      });
      break;
    }

    case 'role': {
      const role = interaction.options.getRole('role');
      const roleError = getAssignableRoleError(role, interaction.member);
      if (roleError) {
        return interaction.editReply({
          embeds: [await errorEmbed(interaction.guild.id, 'Role Not Allowed', roleError)]
        });
      }
      await Guild.updateGuild(interaction.guild.id, { $set: { 'features.birthdaySystem.role': role.id } });
      await interaction.editReply({
        embeds: [await successEmbed(interaction.guild.id, 'Birthday Role Set',
          `${GLYPHS.SUCCESS} Birthday role set to ${role}\n\nThis role will be assigned to users on their birthday.`)]
      });
      break;
    }

    case 'message': {
      const message = interaction.options.getString('message');
      await Guild.updateGuild(interaction.guild.id, { $set: { 'features.birthdaySystem.message': message } });
      await interaction.editReply({
        embeds: [await successEmbed(interaction.guild.id, 'Birthday Message Set',
          `${GLYPHS.SUCCESS} Custom birthday message set.\n\n**Preview:**\n${message.replace('{user}', interaction.user.toString()).replace('{username}', interaction.user.username).replace('{age}', '25')}`)]
      });
      break;
    }

    case 'enable': {
      await Guild.updateGuild(interaction.guild.id, { $set: { 'features.birthdaySystem.enabled': true } });
      await interaction.editReply({
        embeds: [await successEmbed(interaction.guild.id, 'Birthday System Enabled',
          `${GLYPHS.SUCCESS} Birthday celebrations are now enabled.`)]
      });
      break;
    }

    case 'disable': {
      await Guild.updateGuild(interaction.guild.id, { $set: { 'features.birthdaySystem.enabled': false } });
      await interaction.editReply({
        embeds: [await successEmbed(interaction.guild.id, 'Birthday System Disabled',
          `${GLYPHS.SUCCESS} Birthday celebrations are now disabled.`)]
      });
      break;
    }

    case 'status': {
      const bs = guildConfig.features.birthdaySystem;
      const channel = bs.channel ? `<#${bs.channel}>` : 'Not configured';
      const role = bs.role ? `<@&${bs.role}>` : 'Not configured';
      const message = bs.message || '**Notice:** Birthday celebration detected for {user}. Congratulations, Master.';

      await interaction.editReply({
        embeds: [await infoEmbed(interaction.guild.id, 'Birthday Settings',
          `**▸ Status:** ${bs.enabled ? '◉ Active' : '◇ Inactive'}\n` +
          `**▸ Channel:** ${channel}\n` +
          `**▸ Role:** ${role}\n` +
          `**▸ Message:** ${message}\n\n` +
          `**Variables:**\n` +
          `◇ \`{user}\` - Mentions the user\n` +
          `◇ \`{username}\` - User's name\n` +
          `◇ \`{age}\` - User's age (if year provided)`)]
      });
      break;
    }
  }
}

// /setbirthday runs the prefix command, so a staff-set birthday is recorded the same way
// (source, setBy, verification) and the role and announcement only happen on the day itself
async function handleSetBirthdayCommand(interaction, client) {
  const setBirthdayCommand = (await import('../../commands/community/setbirthday.js')).default;

  const user = interaction.options.getUser('user');
  const year = interaction.options.getInteger('year');
  // private:true hides the age, private:false shows it, unset keeps the prefix default (hidden)
  const isPrivate = interaction.options.getBoolean('private');
  const args = [
    `<@${user.id}>`,
    String(interaction.options.getInteger('month')),
    String(interaction.options.getInteger('day')),
    ...(year ? [String(year)] : []),
    ...(isPrivate === true ? ['--private'] : isPrivate === false ? ['--showage'] : [])
  ];

  await setBirthdayCommand.execute(createDeferredCommandMessage(interaction, client, { args, users: [user] }), args, client);
}

// Config Handler
async function handleConfigCommand(interaction, guildConfig) {
  const { successEmbed, errorEmbed, infoEmbed, GLYPHS } = await import('../../utils/embeds.js');
  const subcommand = interaction.options.getSubcommand();

  switch (subcommand) {
    case 'view': {
      const config = guildConfig;
      const channel = (id) => id ? `<#${id}>` : 'Not configured';
      const state = (enabled) => enabled ? '◉ Active' : '◇ Inactive';
      const embed = await infoEmbed(interaction.guild.id, 'Server Configuration',
        `**▸ Prefix:** \`${config.prefix}\``);
      embed.addFields(
        {
          name: '▸ Channels',
          value:
            `• Mod Log: ${channel(config.channels.modLog)}\n` +
            `• Alert Log: ${channel(config.channels.alertLog)}\n` +
            `• Join Log: ${channel(config.channels.joinLog)}\n` +
            `• Birthday: ${channel(config.channels.birthdayChannel)}\n` +
            `• Welcome: ${channel(config.channels.welcomeChannel)}`,
          inline: true
        },
        {
          name: '▸ Features',
          value:
            `• AutoMod: ${state(config.features.autoMod?.enabled)}\n` +
            `• Birthdays: ${state(config.features.birthdaySystem?.enabled)}\n` +
            `• Levels: ${state(config.features.levelSystem?.enabled)}\n` +
            `• Welcome: ${state(config.features.welcomeSystem?.enabled)}`,
          inline: true
        }
      );
      await interaction.editReply({ embeds: [embed] });
      break;
    }

    case 'prefix': {
      const newPrefix = interaction.options.getString('prefix');
      if (newPrefix.length > 5) {
        return interaction.editReply({
          embeds: [await errorEmbed(interaction.guild.id, 'Invalid Prefix', 'The prefix may be at most 5 characters, Master.')]
        });
      }
      await Guild.updateGuild(interaction.guild.id, { $set: { prefix: newPrefix } });
      await interaction.editReply({
        embeds: [await successEmbed(interaction.guild.id, 'Prefix Updated',
          `${GLYPHS.SUCCESS} Server prefix changed to \`${newPrefix}\``)]
      });
      break;
    }
  }
}

// Setup Handler: runs the prefix setup wizard, which reports progress by editing its first reply
async function handleSetupCommand(interaction, client) {
  const { errorEmbed } = await import('../../utils/embeds.js');

  try {
    const setupCommand = (await import('../../commands/config/setup.js')).default;
    await setupCommand.execute(createDeferredCommandMessage(interaction, client), [], client);
  } catch (error) {
    console.error('Setup command error:', error);
    await interaction.editReply({
      embeds: [await errorEmbed(interaction.guild.id, 'Setup Failed',
        'An error occurred during setup. Please ensure I have Administrator permissions, Master.')]
    });
  }
}

// Welcome Handler
async function handleWelcomeCommand(interaction, guildConfig) {
  const { successEmbed, errorEmbed, infoEmbed, GLYPHS } = await import('../../utils/embeds.js');
  const { buildWelcomeEmbed, parseWelcomeMessage } = await import('../../commands/config/welcome.js');
  const subcommand = interaction.options.getSubcommand();
  const welcome = guildConfig.features.welcomeSystem || {};

  switch (subcommand) {
    case 'enable': {
      await Guild.updateGuild(interaction.guild.id, { $set: { 'features.welcomeSystem.enabled': true } });
      await interaction.editReply({
        embeds: [await successEmbed(interaction.guild.id, 'Welcome System Enabled',
          `${GLYPHS.SUCCESS} Welcome messages are now enabled.\n\nMake sure to set a channel: \`/welcome channel\``)]
      });
      break;
    }

    case 'disable': {
      await Guild.updateGuild(interaction.guild.id, { $set: { 'features.welcomeSystem.enabled': false } });
      await interaction.editReply({
        embeds: [await successEmbed(interaction.guild.id, 'Welcome System Disabled',
          `${GLYPHS.SUCCESS} Welcome messages are now disabled.`)]
      });
      break;
    }

    case 'channel': {
      const channel = interaction.options.getChannel('channel');
      await Guild.updateGuild(interaction.guild.id, {
        $set: {
          'features.welcomeSystem.channel': channel.id,
          'channels.welcomeChannel': channel.id
        }
      });
      await interaction.editReply({
        embeds: [await successEmbed(interaction.guild.id, 'Welcome Channel Set',
          `${GLYPHS.SUCCESS} Welcome messages will be sent to ${channel}`)]
      });
      break;
    }

    case 'message': {
      const text = interaction.options.getString('text');
      await Guild.updateGuild(interaction.guild.id, { $set: { 'features.welcomeSystem.message': text } });

      // Preview the message
      const previewMsg = text
        .replace(/{user}/gi, interaction.user.toString())
        .replace(/{username}/gi, interaction.user.username)
        .replace(/{server}/gi, interaction.guild.name)
        .replace(/{membercount}/gi, interaction.guild.memberCount.toString())
        .replace(/\\n/g, '\n');

      await interaction.editReply({
        embeds: [await successEmbed(interaction.guild.id, 'Welcome Message Set',
          `${GLYPHS.SUCCESS} Welcome message updated, Master.\n\n**Preview:**\n${previewMsg}`)]
      });
      break;
    }

    case 'title': {
      const text = interaction.options.getString('text');

      if (text.toLowerCase() === 'reset' || text.toLowerCase() === 'default') {
        await Guild.updateGuild(interaction.guild.id, { $set: { 'features.welcomeSystem.embedTitle': null } });
        await interaction.editReply({
          embeds: [await successEmbed(interaction.guild.id, 'Title Reset',
            `${GLYPHS.SUCCESS} Welcome embed title reset to default decorative style.`)]
        });
      } else if (text.toLowerCase() === 'none' || text.toLowerCase() === 'remove') {
        await Guild.updateGuild(interaction.guild.id, { $set: { 'features.welcomeSystem.embedTitle': ' ' } });
        await interaction.editReply({
          embeds: [await successEmbed(interaction.guild.id, 'Title Removed',
            `${GLYPHS.SUCCESS} Welcome embed title has been removed.`)]
        });
      } else {
        await Guild.updateGuild(interaction.guild.id, { $set: { 'features.welcomeSystem.embedTitle': text } });
        await interaction.editReply({
          embeds: [await successEmbed(interaction.guild.id, 'Title Set',
            `${GLYPHS.SUCCESS} Welcome embed title set to:\n${text}`)]
        });
      }
      break;
    }

    case 'footer': {
      const text = interaction.options.getString('text');

      if (text.toLowerCase() === 'reset' || text.toLowerCase() === 'default') {
        await Guild.updateGuild(interaction.guild.id, { $set: { 'features.welcomeSystem.footerText': null } });
        await interaction.editReply({
          embeds: [await successEmbed(interaction.guild.id, 'Footer Reset',
            `${GLYPHS.SUCCESS} Footer text reset to default.`)]
        });
      } else if (text.toLowerCase() === 'none' || text.toLowerCase() === 'remove') {
        await Guild.updateGuild(interaction.guild.id, { $set: { 'features.welcomeSystem.footerText': ' ' } });
        await interaction.editReply({
          embeds: [await successEmbed(interaction.guild.id, 'Footer Removed',
            `${GLYPHS.SUCCESS} Footer has been removed.`)]
        });
      } else {
        await Guild.updateGuild(interaction.guild.id, { $set: { 'features.welcomeSystem.footerText': text } });
        await interaction.editReply({
          embeds: [await successEmbed(interaction.guild.id, 'Footer Set',
            `${GLYPHS.SUCCESS} Footer text set to: ${text}`)]
        });
      }
      break;
    }

    case 'greet': {
      const text = interaction.options.getString('text');

      if (text.toLowerCase() === 'reset' || text.toLowerCase() === 'default') {
        await Guild.updateGuild(interaction.guild.id, { $set: { 'features.welcomeSystem.greetingText': null } });
        await interaction.editReply({
          embeds: [await successEmbed(interaction.guild.id, 'Greeting Reset',
            `${GLYPHS.SUCCESS} Greeting text reset to "welcome, @user!"`)]
        });
      } else {
        await Guild.updateGuild(interaction.guild.id, { $set: { 'features.welcomeSystem.greetingText': text } });
        await interaction.editReply({
          embeds: [await successEmbed(interaction.guild.id, 'Greeting Set',
            `${GLYPHS.SUCCESS} Greeting text set to:\n${text.replace(/{user}/gi, interaction.user.toString())}`)]
        });
      }
      break;
    }

    case 'color': {
      const hex = interaction.options.getString('hex');

      if (hex.toLowerCase() === 'reset' || hex.toLowerCase() === 'default') {
        await Guild.updateGuild(interaction.guild.id, { $set: { 'features.welcomeSystem.embedColor': null } });
        await interaction.editReply({
          embeds: [await successEmbed(interaction.guild.id, 'Color Reset',
            `${GLYPHS.SUCCESS} Welcome embed color reset to default.`)]
        });
      } else if (!hex.match(/^#?[0-9A-Fa-f]{6}$/)) {
        await interaction.editReply({
          embeds: [await errorEmbed(interaction.guild.id, 'Invalid Color',
            'Please provide a valid hex color (e.g., `#5432A6`)')]
        });
      } else {
        const color = hex.startsWith('#') ? hex : `#${hex}`;
        await Guild.updateGuild(interaction.guild.id, { $set: { 'features.welcomeSystem.embedColor': color } });
        await interaction.editReply({
          embeds: [await successEmbed(interaction.guild.id, 'Color Set',
            `${GLYPHS.SUCCESS} Welcome embed color set to \`${color}\``)]
        });
      }
      break;
    }

    case 'image': {
      const url = interaction.options.getString('url');

      if (url.toLowerCase() === 'remove' || url.toLowerCase() === 'none') {
        await Guild.updateGuild(interaction.guild.id, { $set: { 'features.welcomeSystem.bannerUrl': null } });
        await interaction.editReply({
          embeds: [await successEmbed(interaction.guild.id, 'Banner Removed',
            `${GLYPHS.SUCCESS} Welcome banner has been removed.`)]
        });
      } else if (!url.match(/^https?:\/\/.+/i)) {
        await interaction.editReply({
          embeds: [await errorEmbed(interaction.guild.id, 'Invalid URL',
            'Please provide a valid image URL starting with http:// or https://')]
        });
      } else {
        await Guild.updateGuild(interaction.guild.id, { $set: { 'features.welcomeSystem.bannerUrl': url } });
        await interaction.editReply({
          embeds: [await successEmbed(interaction.guild.id, 'Banner Set',
            `${GLYPHS.SUCCESS} Welcome banner has been set.`)]
        });
      }
      break;
    }

    case 'thumbnail': {
      const type = interaction.options.getString('type');

      if (type === 'remove') {
        await Guild.updateGuild(interaction.guild.id, {
          $set: { 'features.welcomeSystem.thumbnailUrl': null, 'features.welcomeSystem.thumbnailType': null }
        });
        await interaction.editReply({
          embeds: [await successEmbed(interaction.guild.id, 'Thumbnail Removed',
            `${GLYPHS.SUCCESS} Welcome thumbnail has been removed.`)]
        });
      } else if (type === 'avatar') {
        await Guild.updateGuild(interaction.guild.id, {
          $set: { 'features.welcomeSystem.thumbnailType': 'avatar', 'features.welcomeSystem.thumbnailUrl': null }
        });
        await interaction.editReply({
          embeds: [await successEmbed(interaction.guild.id, 'Thumbnail Set',
            `${GLYPHS.SUCCESS} Thumbnail will show the user's avatar.`)]
        });
      } else if (type === 'server') {
        await Guild.updateGuild(interaction.guild.id, {
          $set: { 'features.welcomeSystem.thumbnailType': 'server', 'features.welcomeSystem.thumbnailUrl': null }
        });
        await interaction.editReply({
          embeds: [await successEmbed(interaction.guild.id, 'Thumbnail Set',
            `${GLYPHS.SUCCESS} Thumbnail will show the server icon.`)]
        });
      }
      break;
    }

    case 'author': {
      const type = interaction.options.getString('type');
      await Guild.updateGuild(interaction.guild.id, { $set: { 'features.welcomeSystem.authorType': type } });
      await interaction.editReply({
        embeds: [await successEmbed(interaction.guild.id, 'Author Setting Updated',
          `${GLYPHS.SUCCESS} Author section set to: **${type}**`)]
      });
      break;
    }

    case 'embed': {
      const enabled = interaction.options.getBoolean('enabled');
      await Guild.updateGuild(interaction.guild.id, { $set: { 'features.welcomeSystem.embedEnabled': enabled } });
      await interaction.editReply({
        embeds: [await successEmbed(interaction.guild.id, 'Embed Setting Updated',
          `${GLYPHS.SUCCESS} Welcome embeds are now **${enabled ? 'enabled' : 'disabled'}**`)]
      });
      break;
    }

    case 'mention': {
      const enabled = interaction.options.getBoolean('enabled');
      await Guild.updateGuild(interaction.guild.id, { $set: { 'features.welcomeSystem.mentionUser': enabled } });
      await interaction.editReply({
        embeds: [await successEmbed(interaction.guild.id, 'Mention Setting Updated',
          `${GLYPHS.SUCCESS} User mention above embed is now **${enabled ? 'enabled' : 'disabled'}**`)]
      });
      break;
    }

    case 'dm': {
      const enabled = interaction.options.getBoolean('enabled');
      await Guild.updateGuild(interaction.guild.id, { $set: { 'features.welcomeSystem.dmWelcome': enabled } });
      await interaction.editReply({
        embeds: [await successEmbed(interaction.guild.id, 'DM Setting Updated',
          `${GLYPHS.SUCCESS} DM welcome messages are now **${enabled ? 'enabled' : 'disabled'}**`)]
      });
      break;
    }

    case 'timestamp': {
      const enabled = interaction.options.getBoolean('enabled');
      await Guild.updateGuild(interaction.guild.id, { $set: { 'features.welcomeSystem.showTimestamp': enabled } });
      await interaction.editReply({
        embeds: [await successEmbed(interaction.guild.id, 'Timestamp Setting Updated',
          `${GLYPHS.SUCCESS} Timestamp is now **${enabled ? 'enabled' : 'disabled'}**`)]
      });
      break;
    }

    case 'role': {
      const role = interaction.options.getRole('role');

      if (!role) {
        await Guild.updateGuild(interaction.guild.id, { $set: { 'features.welcomeSystem.autoRole': null } });
        await interaction.editReply({
          embeds: [await successEmbed(interaction.guild.id, 'Auto Role Removed',
            `${GLYPHS.SUCCESS} Welcome auto role has been disabled.`)]
        });
      } else {
        const roleError = getAssignableRoleError(role, interaction.member);
        if (roleError) {
          return interaction.editReply({
            embeds: [await errorEmbed(interaction.guild.id, 'Role Not Allowed', roleError)]
          });
        }
        await Guild.updateGuild(interaction.guild.id, { $set: { 'features.welcomeSystem.autoRole': role.id } });
        await interaction.editReply({
          embeds: [await successEmbed(interaction.guild.id, 'Auto Role Set',
            `${GLYPHS.SUCCESS} New members will receive ${role}`)]
        });
      }
      break;
    }

    case 'status': {
      const channel = welcome.channel ? interaction.guild.channels.cache.get(welcome.channel) : null;
      const autoRole = welcome.autoRole ? interaction.guild.roles.cache.get(welcome.autoRole) : null;

      const flag = (enabled) => enabled ? '◉ On' : '◇ Off';
      const statusEmbed = await infoEmbed(interaction.guild.id, 'Welcome System Status',
        `**▸ Status:** ${welcome.enabled ? '◉ Active' : '◇ Inactive'}\n` +
        `**▸ Channel:** ${channel || 'Not configured'}`);
      statusEmbed.addFields(
        {
          name: '▸ Behaviour',
          value:
            `• Embed Mode: ${flag(welcome.embedEnabled !== false)}\n` +
            `• DM Welcome: ${flag(welcome.dmWelcome)}\n` +
            `• Mention User: ${flag(welcome.mentionUser)}\n` +
            `• Timestamp: ${flag(welcome.showTimestamp !== false)}\n` +
            `• Auto Role: ${autoRole || 'None'}`,
          inline: true
        },
        {
          name: '▸ Appearance',
          value:
            `• Color: ${welcome.embedColor || 'Default'}\n` +
            `• Title: ${welcome.embedTitle ? 'Custom' : 'Decorative stars'}\n` +
            `• Author: ${welcome.authorType || 'username'}\n` +
            `• Thumbnail: ${welcome.thumbnailType || welcome.thumbnailUrl || 'None'}\n` +
            `• Banner: ${welcome.bannerUrl ? 'Set' : 'Not set'}`,
          inline: true
        },
        {
          name: '▸ Current Message',
          value: `\`\`\`${(welcome.message || 'Welcome {user} to {server}!').replace(/`/g, "'").slice(0, 1000)}\`\`\``
        }
      );
      await interaction.editReply({ embeds: [statusEmbed] });
      break;
    }

    case 'test': {
      const channelId = welcome.channel || guildConfig.channels.welcomeChannel;
      const channel = channelId ? interaction.guild.channels.cache.get(channelId) : interaction.channel;

      if (!channel) {
        await interaction.editReply({
          embeds: [await errorEmbed(interaction.guild.id, 'No Channel',
            'Welcome channel is not set. Use `/welcome channel` to set one.')]
        });
        break;
      }

      // Get fresh config
      const freshConfig = await Guild.getGuild(interaction.guild.id, interaction.guild.name);
      const freshWelcome = freshConfig.features.welcomeSystem || {};

      const { embed, content } = buildWelcomeEmbed(interaction.member, freshWelcome, freshConfig);

      if (embed) {
        await channel.send({ content, embeds: [embed] });
      } else {
        const welcomeMsg = parseWelcomeMessage(freshWelcome.message || 'Welcome {user} to {server}!', interaction.member);
        await channel.send(content || welcomeMsg);
      }

      await interaction.editReply({
        embeds: [await successEmbed(interaction.guild.id, 'Test Sent',
          `${GLYPHS.SUCCESS} Test welcome message sent to ${channel}`)]
      });
      break;
    }

    case 'preview': {
      const freshConfig = await Guild.getGuild(interaction.guild.id, interaction.guild.name);
      const freshWelcome = freshConfig.features.welcomeSystem || {};

      const { embed, content } = buildWelcomeEmbed(interaction.member, freshWelcome, freshConfig);

      await interaction.editReply({
        content: content || undefined,
        embeds: embed ? [embed] : []
      });
      break;
    }

    case 'reset': {
      await Guild.updateGuild(interaction.guild.id, {
        $set: {
          'features.welcomeSystem': {
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
          }
        }
      });

      await interaction.editReply({
        embeds: [await successEmbed(interaction.guild.id, 'Welcome System Reset',
          `${GLYPHS.SUCCESS} All welcome settings have been reset to defaults.`)]
      });
      break;
    }

    case 'help': {
      await interaction.editReply({
        embeds: [
          await infoEmbed(interaction.guild.id, '『 Welcome Commands 』',
            `**Basic:**\n` +
            `${GLYPHS.DOT} \`/welcome enable\` - Enable system\n` +
            `${GLYPHS.DOT} \`/welcome disable\` - Disable system\n` +
            `${GLYPHS.DOT} \`/welcome channel\` - Set channel\n` +
            `${GLYPHS.DOT} \`/welcome test\` - Test message\n` +
            `${GLYPHS.DOT} \`/welcome preview\` - Preview\n` +
            `${GLYPHS.DOT} \`/welcome reset\` - Reset all\n\n` +
            `**Content:**\n` +
            `${GLYPHS.DOT} \`/welcome message\` - Embed description\n` +
            `${GLYPHS.DOT} \`/welcome greet\` - Text above embed\n` +
            `${GLYPHS.DOT} \`/welcome title\` - Embed title\n` +
            `${GLYPHS.DOT} \`/welcome footer\` - Footer text\n\n` +
            `**Appearance:**\n` +
            `${GLYPHS.DOT} \`/welcome color\` - Embed color\n` +
            `${GLYPHS.DOT} \`/welcome image\` - Banner image\n` +
            `${GLYPHS.DOT} \`/welcome thumbnail\` - Thumbnail\n` +
            `${GLYPHS.DOT} \`/welcome author\` - Author section\n\n` +
            `**Toggles:**\n` +
            `${GLYPHS.DOT} \`/welcome embed\` - Toggle embed\n` +
            `${GLYPHS.DOT} \`/welcome mention\` - Ping user\n` +
            `${GLYPHS.DOT} \`/welcome dm\` - DM on join\n` +
            `${GLYPHS.DOT} \`/welcome timestamp\` - Timestamp\n` +
            `${GLYPHS.DOT} \`/welcome role\` - Auto role\n\n` +
            `**Variables:** {user}, {username}, {displayname}, {server}, {membercount}, {usercreated}`
          )
        ]
      });
      break;
    }
  }
}

// Shop item text limits: names appear in embed field names (256) and descriptions in field values (1024)
const SHOP_NAME_MAX = 100;
const SHOP_DESCRIPTION_MAX = 500;

// Embed images only accept http(s) URLs; anything else makes EmbedBuilder#setImage throw
function isHttpUrl(value) {
  try {
    const { protocol } = new URL(value);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

// Handle manageshop slash command (Backgrounds only)
async function handleManageshopCommand(interaction, guildConfig) {
  const { successEmbed, errorEmbed, infoEmbed, GLYPHS } = await import('../../utils/embeds.js');
  const { formatNumber } = await import('../../utils/helpers.js');

  const subcommand = interaction.options.getSubcommand();
  const currency = guildConfig.economy?.coinName || 'coins';
  const invalidImage = async () => interaction.editReply({
    embeds: [await errorEmbed(interaction.guild.id, 'Invalid Image URL',
      `${GLYPHS.ERROR} Please provide a direct image link starting with http:// or https://, Master.`)]
  });

  // Initialize if not exists
  if (!guildConfig.customShopItems) {
    guildConfig.customShopItems = [];
  }

  switch (subcommand) {
    case 'add': {
      const itemName = interaction.options.getString('name').trim();
      const price = interaction.options.getInteger('price');
      const image = interaction.options.getString('image').trim();
      const description = interaction.options.getString('description');

      // Validate before writing: a bad URL used to throw after the item was saved, and retries duplicated it
      if (!isHttpUrl(image)) return invalidImage();
      if (itemName.length > SHOP_NAME_MAX || (description?.length ?? 0) > SHOP_DESCRIPTION_MAX) {
        return interaction.editReply({
          embeds: [await errorEmbed(interaction.guild.id, 'Text Too Long',
            `${GLYPHS.ERROR} Names are limited to ${SHOP_NAME_MAX} characters and descriptions to ${SHOP_DESCRIPTION_MAX}, Master.`)]
        });
      }

      // Generate unique ID
      const itemId = `custom_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

      const newItem = {
        id: itemId,
        name: itemName,
        description: description || 'A custom background',
        price: price,
        type: 'background',
        image: image,
        stock: -1,
        createdBy: interaction.user.id,
        createdAt: new Date()
      };

      await Guild.updateGuild(interaction.guild.id, { $push: { customShopItems: newItem } });

      const embed = await successEmbed(interaction.guild.id, 'Background Added to Shop',
        `${GLYPHS.SUCCESS} **${itemName}** is now available in the shop. Preview below, Master.`);
      embed.addFields(
        { name: '▸ Name', value: itemName, inline: true },
        { name: '▸ Price', value: `${formatNumber(price)} ${currency}`, inline: true },
        { name: '▸ ID', value: `\`${itemId}\``, inline: true }
      ).setImage(image);

      await interaction.editReply({ embeds: [embed] });
      break;
    }

    case 'remove': {
      const itemId = interaction.options.getString('id');

      const index = guildConfig.customShopItems.findIndex(item => item.id === itemId);
      if (index === -1) {
        await interaction.editReply({
          embeds: [await errorEmbed(interaction.guild.id, 'Item Not Found',
            `${GLYPHS.ERROR} No item found with ID: \`${itemId}\``)]
        });
        return;
      }

      const removedItem = guildConfig.customShopItems[index];
      await Guild.updateGuild(interaction.guild.id, { $pull: { customShopItems: { id: itemId } } });

      await interaction.editReply({
        embeds: [await successEmbed(interaction.guild.id, 'Item Removed',
          `${GLYPHS.SUCCESS} Removed **${removedItem.name}** from the shop.`)]
      });
      break;
    }

    case 'list': {
      if (guildConfig.customShopItems.length === 0) {
        await interaction.editReply({
          embeds: [await infoEmbed(interaction.guild.id, 'No Backgrounds',
            `${GLYPHS.INFO} No custom backgrounds in the shop yet.\n\nUse \`/manageshop add\` to add backgrounds, Master.`)]
        });
        return;
      }

      const total = guildConfig.customShopItems.length;
      const embed = await infoEmbed(interaction.guild.id, 'Shop Backgrounds',
        total > 10 ? `Showing 10 of ${total} backgrounds, Master.` : `${total} background(s) in the shop, Master.`);

      guildConfig.customShopItems.slice(0, 10).forEach(item => {
        const stockText = item.stock === -1 ? 'Unlimited' : item.stock;
        embed.addFields({
          name: `▸ ${item.name}`.slice(0, 256),
          value: `**ID:** \`${item.id}\`\n**Price:** ${formatNumber(item.price)} ${currency}\n**Stock:** ${stockText}${isHttpUrl(item.image) ? `\n**Image:** [Preview](${item.image})` : ''}`,
          inline: false
        });
      });

      await interaction.editReply({ embeds: [embed] });
      break;
    }

    case 'setprice': {
      const itemId = interaction.options.getString('id');
      const newPrice = interaction.options.getInteger('price');

      const item = guildConfig.customShopItems.find(i => i.id === itemId);
      if (!item) {
        await interaction.editReply({
          embeds: [await errorEmbed(interaction.guild.id, 'Item Not Found',
            `${GLYPHS.ERROR} No item found with ID: \`${itemId}\``)]
        });
        return;
      }

      const oldPrice = item.price;
      await Guild.updateGuild(interaction.guild.id, {
        $set: { 'customShopItems.$[elem].price': newPrice }
      }, { arrayFilters: [{ 'elem.id': itemId }] });

      await interaction.editReply({
        embeds: [await successEmbed(interaction.guild.id, 'Price Updated',
          `${GLYPHS.SUCCESS} Updated **${item.name}** price:\n\n` +
          `**Old Price:** ${formatNumber(oldPrice)} ${currency}\n` +
          `**New Price:** ${formatNumber(newPrice)} ${currency}`)]
      });
      break;
    }

    case 'edit': {
      const itemId = interaction.options.getString('id');
      const field = interaction.options.getString('field');
      const value = interaction.options.getString('value');

      const item = guildConfig.customShopItems.find(i => i.id === itemId);
      if (!item) {
        await interaction.editReply({
          embeds: [await errorEmbed(interaction.guild.id, 'Item Not Found',
            `${GLYPHS.ERROR} No item found with ID: \`${itemId}\``)]
        });
        return;
      }

      const newValue = value.trim();
      const limits = { name: SHOP_NAME_MAX, description: SHOP_DESCRIPTION_MAX };
      if (field === 'image' && !isHttpUrl(newValue)) return invalidImage();
      if (limits[field] && newValue.length > limits[field]) {
        return interaction.editReply({
          embeds: [await errorEmbed(interaction.guild.id, 'Text Too Long',
            `${GLYPHS.ERROR} The ${field} is limited to ${limits[field]} characters, Master.`)]
        });
      }

      await Guild.updateGuild(interaction.guild.id, {
        $set: { [`customShopItems.$[elem].${field}`]: newValue }
      }, { arrayFilters: [{ 'elem.id': itemId }] });

      const embed = await successEmbed(interaction.guild.id, 'Background Updated',
        `${GLYPHS.SUCCESS} Updated the ${field} of **${item.name}** to: ${field === 'image' ? newValue : `**${newValue}**`}`);
      if (field === 'image') embed.setImage(newValue);
      await interaction.editReply({ embeds: [embed] });
      break;
    }

    case 'stock': {
      const itemId = interaction.options.getString('id');
      const stock = interaction.options.getInteger('amount');

      const item = guildConfig.customShopItems.find(i => i.id === itemId);
      if (!item) {
        await interaction.editReply({
          embeds: [await errorEmbed(interaction.guild.id, 'Item Not Found',
            `${GLYPHS.ERROR} No item found with ID: \`${itemId}\``)]
        });
        return;
      }

      await Guild.updateGuild(interaction.guild.id, {
        $set: { 'customShopItems.$[elem].stock': stock }
      }, { arrayFilters: [{ 'elem.id': itemId }] });

      const stockText = stock === -1 ? 'Unlimited' : stock.toString();
      await interaction.editReply({
        embeds: [await successEmbed(interaction.guild.id, 'Stock Updated',
          `${GLYPHS.SUCCESS} **${item.name}** stock set to: **${stockText}**`)]
      });
      break;
    }

    case 'fallback': {
      const type = interaction.options.getString('type');
      const value = interaction.options.getString('value');

      // Initialize economy if not exists
      if (!guildConfig.economy) {
        guildConfig.economy = {};
      }
      if (!guildConfig.economy.fallbackBackground) {
        guildConfig.economy.fallbackBackground = { image: '', color: '#2C2F33' };
      }

      if (type === 'url') {
        if (!value) {
          await interaction.editReply({
            embeds: [await errorEmbed(interaction.guild.id, 'Missing URL',
              `${GLYPHS.ERROR} Please provide an image URL.`)]
          });
          return;
        }

        if (!isHttpUrl(value)) return invalidImage();

        await Guild.updateGuild(interaction.guild.id, { $set: { 'economy.fallbackBackground.image': value } });

        const embed = await successEmbed(interaction.guild.id, 'Fallback Background Updated',
          `${GLYPHS.SUCCESS} Default background image set. Preview below, Master.`);
        embed.setImage(value);
        await interaction.editReply({ embeds: [embed] });

      } else if (type === 'color') {
        if (!value) {
          await interaction.editReply({
            embeds: [await errorEmbed(interaction.guild.id, 'Missing Color',
              `${GLYPHS.ERROR} Please provide a hex color (e.g., #FF0000).`)]
          });
          return;
        }

        if (!/^#[0-9A-F]{6}$/i.test(value)) {
          await interaction.editReply({
            embeds: [await errorEmbed(interaction.guild.id, 'Invalid Color',
              `${GLYPHS.ERROR} Please provide a valid hex color (e.g., #FF0000)`)]
          });
          return;
        }

        await Guild.updateGuild(interaction.guild.id, { $set: { 'economy.fallbackBackground.color': value } });

        // Shown in the new color as a preview
        const embed = await successEmbed(interaction.guild.id, 'Fallback Color Updated',
          `${GLYPHS.SUCCESS} Default background color set to: **${value}**`);
        embed.setColor(value);
        await interaction.editReply({ embeds: [embed] });

      } else if (type === 'clear') {
        await Guild.updateGuild(interaction.guild.id, {
          $set: { 'economy.fallbackBackground': { image: '', color: '#2C2F33' } }
        });

        await interaction.editReply({
          embeds: [await successEmbed(interaction.guild.id, 'Fallback Reset',
            `${GLYPHS.SUCCESS} Default background reset to default dark theme.`)]
        });
      }
      break;
    }
  }
}
// Handle verify command
async function handleVerifyCommand(interaction, guildConfig) {
  const { successEmbed, errorEmbed, infoEmbed, GLYPHS } = await import('../../utils/embeds.js');
  const subcommand = interaction.options.getSubcommand();
  const vs = guildConfig.features?.verificationSystem || {};

  switch (subcommand) {
    case 'setup': {
      const embed = await infoEmbed(interaction.guild.id, 'Verification Setup',
        `${GLYPHS.ARROW_RIGHT} Configure verification with these subcommands, Master:`);
      embed.addFields({
        name: '▸ Steps',
        value:
          '1. `/verify setrole` — Set the verified role\n' +
          '2. `/verify setunverifiedrole` — Set the role removed on verification\n' +
          '3. `/verify setchannel` — Set the verification channel\n' +
          '4. `/verify settype` — Choose button, captcha or reaction\n' +
          '5. `/verify enable` — Enable the system\n' +
          '6. `/verify panel` — Send the verification panel'
      });
      await interaction.editReply({ embeds: [embed] });
      break;
    }

    case 'panel': {
      const channel = interaction.options.getChannel('channel') || interaction.channel;

      if (!vs.role) {
        await interaction.editReply({
          embeds: [await errorEmbed(interaction.guild.id, 'Setup Required',
            `${GLYPHS.ERROR} Please set a verified role first with \`/verify setrole\`, Master.`)]
        });
        return;
      }

      // Shared with the prefix command: posts the panel and records it, so reaction-type
      // panels are recognised by the reaction handler
      const { sendVerificationPanel, getPanelChannelError } = await import('../../commands/moderation/verify.js');
      const channelError = getPanelChannelError(channel, vs.type || 'button');
      if (channelError) {
        return interaction.editReply({
          embeds: [await errorEmbed(interaction.guild.id, 'Invalid Channel', channelError)]
        });
      }

      try {
        await sendVerificationPanel(channel, vs.type || 'button');
      } catch (error) {
        console.error('Error sending verification panel:', error);
        return interaction.editReply({
          embeds: [await errorEmbed(interaction.guild.id, 'Panel Not Sent',
            `${GLYPHS.ERROR} I could not post the panel in ${channel}. Please check my permissions there, Master.`)]
        });
      }

      await interaction.editReply({
        embeds: [await successEmbed(interaction.guild.id, 'Verification Panel Sent',
          `${GLYPHS.SUCCESS} Verification panel has been sent to ${channel}.` +
          (vs.enabled ? '' : '\n\n**Note:** The verification system is currently disabled. Use `/verify enable` to activate it.'))]
      });
      break;
    }

    case 'manual': {
      const Verification = (await import('../../models/Verification.js')).default;
      const { logManualVerification } = await import('./verificationHandler.js');

      const user = interaction.options.getUser('user');
      const member = await interaction.guild.members.fetch(user.id).catch(() => null);

      if (!member) {
        await interaction.editReply({
          embeds: [await errorEmbed(interaction.guild.id, 'User Not Found',
            `${GLYPHS.ERROR} Could not find that user in this server, Master.`)]
        });
        return;
      }

      const verifiedRoleId = vs.role || guildConfig.roles?.verifiedRole;
      if (!verifiedRoleId) {
        await interaction.editReply({
          embeds: [await errorEmbed(interaction.guild.id, 'No Verified Role',
            `${GLYPHS.ERROR} No verified role is configured. Use \`/verify setrole\`, Master.`)]
        });
        return;
      }

      try {
        await member.roles.add(verifiedRoleId, `Manually verified by ${interaction.user.tag}`);
      } catch (error) {
        return interaction.editReply({
          embeds: [await errorEmbed(interaction.guild.id, 'Verification Failed',
            `${GLYPHS.ERROR} I could not assign <@&${verifiedRoleId}>: ${error.message}`)]
        });
      }

      // Remove unverified role if configured
      if (vs.unverifiedRole && member.roles.cache.has(vs.unverifiedRole)) {
        await member.roles.remove(vs.unverifiedRole).catch(() => { });
      }

      // Record and log it the same way the prefix command does
      const verification = await Verification.getVerification(interaction.guild.id, member.id);
      await verification.verify(`staff:${interaction.user.id}`);

      await interaction.editReply({
        embeds: [await successEmbed(interaction.guild.id, 'User Verified',
          `${GLYPHS.SUCCESS} ${user} has been manually verified, Master.`)]
      });

      await logManualVerification(member, interaction.user, guildConfig);
      break;
    }

    case 'status': {
      const statusEmbed = await infoEmbed(interaction.guild.id, 'Verification Status',
        `**▸ Status:** ${vs.enabled ? '◉ Active' : '◇ Inactive'}`);
      statusEmbed.addFields(
        { name: '▸ Type', value: vs.type || 'button', inline: true },
        { name: '▸ Verified Role', value: vs.role ? `<@&${vs.role}>` : 'Not set', inline: true },
        { name: '▸ Unverified Role', value: vs.unverifiedRole ? `<@&${vs.unverifiedRole}>` : 'Not set', inline: true },
        { name: '▸ Channel', value: vs.channel ? `<#${vs.channel}>` : 'Not set', inline: true }
      );
      await interaction.editReply({ embeds: [statusEmbed] });
      break;
    }

    case 'enable': {
      await Guild.updateGuild(interaction.guild.id, { $set: { 'features.verificationSystem.enabled': true } });
      await interaction.editReply({
        embeds: [await successEmbed(interaction.guild.id, 'Verification Enabled',
          `${GLYPHS.SUCCESS} The verification system is now enabled.`)]
      });
      break;
    }

    case 'disable': {
      await Guild.updateGuild(interaction.guild.id, { $set: { 'features.verificationSystem.enabled': false } });
      await interaction.editReply({
        embeds: [await successEmbed(interaction.guild.id, 'Verification Disabled',
          `${GLYPHS.SUCCESS} The verification system is now disabled.`)]
      });
      break;
    }

    case 'setrole': {
      const role = interaction.options.getRole('role');
      // Every member who verifies receives this role, so it must be safe to hand out
      const roleError = getAssignableRoleError(role, interaction.member);
      if (roleError) {
        return interaction.editReply({
          embeds: [await errorEmbed(interaction.guild.id, 'Role Not Allowed', roleError)]
        });
      }
      await Guild.updateGuild(interaction.guild.id, {
        $set: {
          'features.verificationSystem.role': role.id,
          'roles.verifiedRole': role.id
        }
      });
      await interaction.editReply({
        embeds: [await successEmbed(interaction.guild.id, 'Verified Role Set',
          `${GLYPHS.SUCCESS} Verified role set to ${role}`)]
      });
      break;
    }

    case 'setunverifiedrole': {
      const role = interaction.options.getRole('role');
      if (role) {
        await Guild.updateGuild(interaction.guild.id, {
          $set: { 'features.verificationSystem.unverifiedRole': role.id }
        });
        await interaction.editReply({
          embeds: [await successEmbed(interaction.guild.id, 'Unverified Role Set',
            `${GLYPHS.SUCCESS} Unverified role set to ${role}\n\nThis role will be **removed** when a user verifies.`)]
        });
      } else {
        await Guild.updateGuild(interaction.guild.id, {
          $unset: { 'features.verificationSystem.unverifiedRole': '' }
        });
        await interaction.editReply({
          embeds: [await successEmbed(interaction.guild.id, 'Unverified Role Cleared',
            `${GLYPHS.SUCCESS} Unverified role has been cleared.`)]
        });
      }
      break;
    }

    case 'setchannel': {
      const channel = interaction.options.getChannel('channel');
      await Guild.updateGuild(interaction.guild.id, { $set: { 'features.verificationSystem.channel': channel.id } });
      await interaction.editReply({
        embeds: [await successEmbed(interaction.guild.id, 'Verification Channel Set',
          `${GLYPHS.SUCCESS} Verification channel set to ${channel}`)]
      });
      break;
    }

    case 'settype': {
      const type = interaction.options.getString('type');
      await Guild.updateGuild(interaction.guild.id, { $set: { 'features.verificationSystem.type': type } });

      const typeDescriptions = {
        button: 'Simple button click verification',
        captcha: 'Image captcha verification (creates private thread)',
        reaction: 'Reaction-based verification'
      };

      await interaction.editReply({
        embeds: [await successEmbed(interaction.guild.id, 'Verification Type Set',
          `${GLYPHS.SUCCESS} Verification type set to **${type}**\n\n${typeDescriptions[type]}\n\n` +
          `**Note:** Re-send the verification panel with \`/verify panel\` for the change to take effect, Master.`)]
      });
      break;
    }
  }
}

// Handle cmdchannels command
async function handleCmdchannelsCommand(interaction, guildConfig) {
  const { successEmbed, errorEmbed, infoEmbed, GLYPHS } = await import('../../utils/embeds.js');
  const subcommand = interaction.options.getSubcommand();

  const cmdChannels = {
    enabled: guildConfig.commandChannels?.enabled ?? false,
    channels: guildConfig.commandChannels?.channels || [],
    bypassRoles: guildConfig.commandChannels?.bypassRoles || []
  };
  const channelExists = (id) => interaction.guild.channels.cache.has(id);

  switch (subcommand) {
    case 'enable': {
      // Enabling with only deleted channels would block every command outside config ones
      const existing = cmdChannels.channels.filter(channelExists);
      if (existing.length === 0) {
        await interaction.editReply({
          embeds: [await errorEmbed(interaction.guild.id, 'No Channels Added',
            `${GLYPHS.ERROR} Please add at least one existing channel first with \`/cmdchannels add\`, Master.`)]
        });
        return;
      }
      const stale = cmdChannels.channels.length - existing.length;
      await Guild.updateGuild(interaction.guild.id, {
        $set: { 'commandChannels.enabled': true, 'commandChannels.channels': existing }
      });
      await interaction.editReply({
        embeds: [await successEmbed(interaction.guild.id, 'Channel Restrictions Enabled',
          `${GLYPHS.SUCCESS} Bot commands will now only work in the allowed channels.\n\n` +
          `**Allowed Channels:** ${existing.length}\n` +
          `**Bypass Roles:** ${cmdChannels.bypassRoles.length}` +
          (stale ? `\n\n${GLYPHS.INFO} Removed ${stale} deleted channel(s) from the list.` : ''))]
      });
      break;
    }

    case 'disable': {
      await Guild.updateGuild(interaction.guild.id, { $set: { 'commandChannels.enabled': false } });
      await interaction.editReply({
        embeds: [await successEmbed(interaction.guild.id, 'Channel Restrictions Disabled',
          `${GLYPHS.SUCCESS} Bot commands can now be used in any channel.`)]
      });
      break;
    }

    case 'add': {
      const channel = interaction.options.getChannel('channel');
      if (cmdChannels.channels.includes(channel.id)) {
        await interaction.editReply({
          embeds: [await errorEmbed(interaction.guild.id, 'Already Added',
            `${GLYPHS.ERROR} ${channel} is already in the allowed channels list.`)]
        });
        return;
      }
      if (!channel.isTextBased()) {
        await interaction.editReply({
          embeds: [await errorEmbed(interaction.guild.id, 'Invalid Channel Type',
            `${GLYPHS.ERROR} Please select a channel members can send messages in, Master.`)]
        });
        return;
      }
      await Guild.updateGuild(interaction.guild.id, { $addToSet: { 'commandChannels.channels': channel.id } });
      await interaction.editReply({
        embeds: [await successEmbed(interaction.guild.id, 'Channel Added',
          `${GLYPHS.SUCCESS} ${channel} has been added to allowed channels.`)]
      });
      break;
    }

    case 'remove': {
      // A deleted channel can't be picked, so its ID (or mention) is accepted as text
      const channelId = interaction.options.getChannel('channel')?.id ||
        interaction.options.getString('channel_id')?.trim().match(/^(?:<#)?(\d{17,20})>?$/)?.[1];
      if (!channelId) {
        await interaction.editReply({
          embeds: [await errorEmbed(interaction.guild.id, 'Channel Required',
            `${GLYPHS.ERROR} Please pick a \`channel\`, or give the \`channel_id\` of a deleted one, Master.`)]
        });
        return;
      }
      if (!cmdChannels.channels.includes(channelId)) {
        await interaction.editReply({
          embeds: [await errorEmbed(interaction.guild.id, 'Not Found',
            `${GLYPHS.ERROR} <#${channelId}> is not in the allowed channels list.`)]
        });
        return;
      }

      // Also drop channels that were deleted since they were added
      const stale = cmdChannels.channels.filter(id => id !== channelId && !channelExists(id));
      const remaining = cmdChannels.channels.filter(id => id !== channelId && !stale.includes(id));
      const update = { $pull: { 'commandChannels.channels': { $in: [channelId, ...stale] } } };

      // With no channels left, an active restriction would block every non-config command
      const autoDisabled = cmdChannels.enabled && remaining.length === 0;
      if (autoDisabled) update.$set = { 'commandChannels.enabled': false };

      await Guild.updateGuild(interaction.guild.id, update);

      const label = channelExists(channelId) ? `<#${channelId}>` : `Deleted channel (\`${channelId}\`)`;
      let description = `${GLYPHS.SUCCESS} ${label} has been removed from the allowed channels.\n\n` +
        `**Remaining Channels:** ${remaining.length}`;
      if (stale.length) description += `\n${GLYPHS.INFO} Also removed ${stale.length} deleted channel(s).`;
      if (autoDisabled) description += `\n\n${GLYPHS.WARNING} No allowed channels remain, so channel restrictions have been disabled.`;

      await interaction.editReply({
        embeds: [await successEmbed(interaction.guild.id, 'Channel Removed', description)]
      });
      break;
    }

    case 'bypass': {
      const action = interaction.options.getString('action');
      const role = interaction.options.getRole('role');

      if (action === 'add') {
        if (cmdChannels.bypassRoles.includes(role.id)) {
          await interaction.editReply({
            embeds: [await errorEmbed(interaction.guild.id, 'Already Added',
              `${GLYPHS.ERROR} ${role} already bypasses channel restrictions.`)]
          });
          return;
        }
        await Guild.updateGuild(interaction.guild.id, { $push: { 'commandChannels.bypassRoles': role.id } });
        await interaction.editReply({
          embeds: [await successEmbed(interaction.guild.id, 'Bypass Role Added',
            `${GLYPHS.SUCCESS} ${role} can now use commands in any channel.`)]
        });
      } else {
        if (!cmdChannels.bypassRoles.includes(role.id)) {
          await interaction.editReply({
            embeds: [await errorEmbed(interaction.guild.id, 'Not Found',
              `${GLYPHS.ERROR} ${role} is not a bypass role.`)]
          });
          return;
        }
        await Guild.updateGuild(interaction.guild.id, { $pull: { 'commandChannels.bypassRoles': role.id } });
        await interaction.editReply({
          embeds: [await successEmbed(interaction.guild.id, 'Bypass Role Removed',
            `${GLYPHS.SUCCESS} ${role} no longer bypasses channel restrictions.`)]
        });
      }
      break;
    }

    case 'list': {
      const channelsList = cmdChannels.channels.length > 0
        ? cmdChannels.channels.map(id => `<#${id}>`).join('\n')
        : '*No channels configured*';

      const bypassList = cmdChannels.bypassRoles.length > 0
        ? cmdChannels.bypassRoles.map(id => `<@&${id}>`).join('\n')
        : '*No bypass roles*';

      const embed = await infoEmbed(interaction.guild.id, 'Command Channel Settings',
        `**▸ Status:** ${cmdChannels.enabled ? '◉ Restrictions active' : '◇ Restrictions inactive'}`);
      embed.addFields(
        { name: '▸ Allowed Channels', value: truncateList(channelsList.replace(/\n/g, ', '), 1024), inline: false },
        { name: '▸ Bypass Roles', value: truncateList(bypassList.replace(/\n/g, ', '), 1024), inline: false }
      );
      await interaction.editReply({ embeds: [embed] });
      break;
    }
  }
}

// Handle logs command. Log types come from the prefix setlogs command (LOG_TYPES in
// src/commands/config/logs.js), so both forms write the same channel fields. There is no
// separate on/off flag: a log type is active while its channel is set, which is what the
// logging events check.
async function handleLogsCommand(interaction, guildConfig) {
  const { successEmbed, errorEmbed, infoEmbed, GLYPHS } = await import('../../utils/embeds.js');
  const { LOG_TYPES } = await import('../../commands/config/logs.js');
  const guildId = interaction.guild.id;
  const subcommand = interaction.options.getSubcommand();
  const rawType = interaction.options.getString('type');
  const type = rawType === 'moderation' ? 'mod' : rawType; // value used before the choices matched LOG_TYPES
  const channel = interaction.options.getChannel('channel');
  const channels = guildConfig.channels || {};

  if (type && type !== 'all' && !LOG_TYPES[type]) {
    return interaction.editReply({
      embeds: [await errorEmbed(guildId, 'Invalid Log Type', `${GLYPHS.ERROR} \`${rawType}\` is not a log type I know, Master.`)]
    });
  }
  // Same rule as setlogs: log channels must be text channels
  if (channel && channel.type !== ChannelType.GuildText) {
    return interaction.editReply({
      embeds: [await errorEmbed(guildId, 'Invalid Channel', `${GLYPHS.ERROR} Please select a text channel, Master.`)]
    });
  }

  const logs = type === 'all' ? Object.values(LOG_TYPES) : [LOG_TYPES[type]].filter(Boolean);
  const typeLabel = type === 'all' ? 'All logs' : LOG_TYPES[type]?.name;
  // Point the selected log types, and any config paths that share their channel, at channelId
  const setChannel = async (channelId) => {
    const update = {};
    for (const log of logs) {
      update[`channels.${log.field}`] = channelId;
      for (const path of log.alsoSets || []) update[path] = channelId;
    }
    await Guild.updateGuild(guildId, { $set: update });
  };

  switch (subcommand) {
    case 'enable': {
      if (channel) {
        await setChannel(channel.id);
        return interaction.editReply({
          embeds: [await successEmbed(guildId, 'Logging Enabled',
            `${GLYPHS.SUCCESS} **${typeLabel}** will now be sent to ${channel}, Master.`)]
        });
      }

      // Without a channel there is nothing to switch on: report what is already routed
      const missing = logs.filter(log => !channels[log.field]);
      if (missing.length === 0) {
        return interaction.editReply({
          embeds: [await successEmbed(guildId, 'Logging Active',
            `${GLYPHS.SUCCESS} ${logs.map(log => `**${log.name}** ${GLYPHS.ARROW_RIGHT} <#${channels[log.field]}>`).join('\n')}`)]
        });
      }
      return interaction.editReply({
        embeds: [await errorEmbed(guildId, 'Channel Required',
          `${GLYPHS.ERROR} No channel is set for: ${missing.map(log => `**${log.name}**`).join(', ')}.\n\n` +
          `Use \`/logs enable type:${rawType} channel:#channel\` to choose where these logs go, Master.`)]
      });
    }

    case 'disable': {
      await setChannel(null);
      return interaction.editReply({
        embeds: [await successEmbed(guildId, 'Logging Disabled',
          `${GLYPHS.SUCCESS} **${typeLabel}** ${type === 'all' ? 'have' : 'has'} been disabled. Set a channel again to resume, Master.`)]
      });
    }

    case 'channel': {
      await setChannel(channel.id);
      return interaction.editReply({
        embeds: [await successEmbed(guildId, 'Log Channel Set',
          `${GLYPHS.SUCCESS} **${typeLabel}** will now be sent to ${channel}.\n\n**Logs:** ${LOG_TYPES[type].description}`)]
      });
    }

    case 'status': {
      const embed = await infoEmbed(guildId, 'Logging Status',
        `${GLYPHS.ARROW_RIGHT} A log type is active while it has a channel, Master.`);
      embed.addFields(Object.values(LOG_TYPES).slice(0, 25).map(log => ({
        name: `▸ ${log.name}`,
        value: !channels[log.field]
          ? '◇ Not configured'
          : interaction.guild.channels.cache.has(channels[log.field]) ? `◉ <#${channels[log.field]}>` : '◈ Channel deleted',
        inline: true
      })));
      return interaction.editReply({ embeds: [embed] });
    }
  }
}

// Auto-roles live in the autoRole block of the schema, which the guildMemberAdd autoRole event
// reads: roles go to every human who joins, botRoles to bots.
const AUTOROLE_TARGETS = {
  all: { paths: ['autoRole.roles', 'autoRole.botRoles'], label: 'all new members and bots' },
  humans: { paths: ['autoRole.roles'], label: 'new members (humans only)' },
  bots: { paths: ['autoRole.botRoles'], label: 'bots only' }
};

// Handle autorole command
async function handleAutoroleCommand(interaction, guildConfig) {
  const { successEmbed, errorEmbed, infoEmbed, GLYPHS } = await import('../../utils/embeds.js');
  const subcommand = interaction.options.getSubcommand();
  const autoRole = guildConfig.autoRole || {};

  switch (subcommand) {
    case 'add': {
      const role = interaction.options.getRole('role');
      const target = AUTOROLE_TARGETS[interaction.options.getString('type') || 'all'];

      const roleError = getAssignableRoleError(role, interaction.member);
      if (roleError) {
        return interaction.editReply({
          embeds: [await errorEmbed(interaction.guild.id, 'Role Not Allowed', roleError)]
        });
      }

      // Color roles are picked by members from the color roles panel, never assigned automatically
      if (role.name.startsWith('🎨 ')) {
        return interaction.editReply({
          embeds: [await errorEmbed(interaction.guild.id, 'Color Role Detected',
            `${GLYPHS.ERROR} ${role} is a color role and should not be added to auto-roles, Master.\n\n` +
            `Color roles are meant to be selected by members via the color roles panel, not assigned automatically.`)]
        });
      }

      await Guild.updateGuild(interaction.guild.id, {
        $addToSet: Object.fromEntries(target.paths.map(path => [path, role.id])),
        $set: { 'autoRole.enabled': true }
      });

      await interaction.editReply({
        embeds: [await successEmbed(interaction.guild.id, 'Auto-Role Added',
          `${GLYPHS.SUCCESS} ${role} will be given to ${target.label} when they join.\n\n**Status:** Auto-roles are active.`)]
      });
      break;
    }

    case 'remove': {
      const role = interaction.options.getRole('role');
      await Guild.updateGuild(interaction.guild.id, {
        $pull: {
          'autoRole.roles': role.id,
          'autoRole.botRoles': role.id
        }
      });
      await interaction.editReply({
        embeds: [await successEmbed(interaction.guild.id, 'Auto-Role Removed',
          `${GLYPHS.SUCCESS} ${role} has been removed from auto-roles.`)]
      });
      break;
    }

    case 'list': {
      const format = (ids = []) => truncateList(ids.map(id => `<@&${id}>`).join(', '), 1024) || 'None';
      const embed = await infoEmbed(interaction.guild.id, 'Auto-Roles',
        `**▸ Status:** ${autoRole.enabled ? '◉ Active' : '◇ Inactive'}`);
      embed.addFields(
        { name: '▸ New Members', value: format(autoRole.roles), inline: false },
        { name: '▸ Bots', value: format(autoRole.botRoles), inline: false }
      );
      await interaction.editReply({ embeds: [embed] });
      break;
    }

    case 'clear': {
      await Guild.updateGuild(interaction.guild.id, {
        $set: {
          'autoRole.roles': [],
          'autoRole.botRoles': []
        }
      });
      await interaction.editReply({
        embeds: [await successEmbed(interaction.guild.id, 'Auto-Roles Cleared',
          `${GLYPHS.SUCCESS} All auto-roles have been removed.`)]
      });
      break;
    }
  }
}

// Feature management slash command handler. /feature runs the prefix feature command, so both
// use the same categories (built from the loaded commands), system flags and protected commands.
async function handleFeatureCommand(interaction, client, guildConfig) {
  const { errorEmbed, infoEmbed, GLYPHS } = await import('../../utils/embeds.js');
  const featureCommand = (await import('../../commands/config/feature.js')).default;

  const featureType = interaction.options.getString('type');
  const status = interaction.options.getString('status');
  const customCommand = interaction.options.getString('command')?.trim().toLowerCase().replace(/^\//, '');

  let target = featureType;
  if (featureType === 'custom') {
    if (!customCommand) {
      return interaction.editReply({
        embeds: [await errorEmbed(interaction.guild.id, 'Missing Command',
          `${GLYPHS.ERROR} Please specify a command name using the \`command\` option, Master.`)]
      });
    }
    target = customCommand;

    // The prefix command reports status per feature, not per command
    if (status === 'status') {
      const name = client.commands.get(customCommand)?.name ||
        client.commands.get(client.aliases?.get(customCommand))?.name ||
        (SLASH_COMMAND_NAMES.has(customCommand) ? customCommand : null);
      if (!name) {
        return interaction.editReply({
          embeds: [await errorEmbed(interaction.guild.id, 'Unknown Command',
            `${GLYPHS.ERROR} \`${customCommand}\` is not one of my commands, Master.`)]
        });
      }
      const textDisabled = guildConfig.textCommands?.disabledCommands?.includes(name);
      const slashDisabled = guildConfig.slashCommands?.disabledCommands?.includes(name);
      const embed = await infoEmbed(interaction.guild.id, `Command: ${name}`,
        `**▸ Status:** ${textDisabled && slashDisabled ? '◇ Disabled' : textDisabled || slashDisabled ? '◈ Partly disabled' : '◉ Enabled'}`);
      embed.addFields(
        { name: '▸ Text Command', value: textDisabled ? '◇ Disabled' : '◉ Enabled', inline: true },
        { name: '▸ Slash Command', value: slashDisabled ? '◇ Disabled' : '◉ Enabled', inline: true }
      );
      return interaction.editReply({ embeds: [embed] });
    }
  }

  const args = [status, target];
  await featureCommand.execute(createDeferredCommandMessage(interaction, client, { args }), args, client);
}

// /giveaway runs the prefix command's code: start goes through createGiveaway (same
// validation, message, required role and stored fields as the prefix start), and end,
// reroll, list and delete run the prefix sub-commands, so winners are drawn the same way
async function handleGiveawayCommand(interaction, client) {
  const giveawayModule = await import('../../commands/community/giveaway.js');
  const subcommand = interaction.options.getSubcommand();

  if (subcommand === 'start') {
    return giveawayModule.createGiveaway(createDeferredCommandMessage(interaction, client), {
      duration: interaction.options.getString('duration'),
      winners: interaction.options.getInteger('winners'),
      prize: interaction.options.getString('prize'),
      roleId: interaction.options.getRole('required_role')?.id ?? null
    });
  }

  const messageId = interaction.options.getString('message_id');
  const count = interaction.options.getInteger('count');
  const args = [subcommand, ...(messageId ? [messageId] : []), ...(count ? [String(count)] : [])];
  return giveawayModule.default.execute(createDeferredCommandMessage(interaction, client, { args }), args, client);
}

// Matches the /award reason option's max length
const AWARD_REASON_MAX = 500;

// Applies `amount` to a numeric Economy field in one atomic update, as the prefix award command
// does, so an award can't overwrite a change made at the same moment (a game payout, a purchase).
// Deductions floor at 0 via an update pipeline; grants are a plain $inc (plus any extra counters).
async function applyAtomicEconomyChange(userId, guildId, field, amount, extraInc = {}) {
  const Economy = (await import('../../models/Economy.js')).default;
  await Economy.getEconomy(userId, guildId); // ensure the record exists
  const update = amount > 0
    ? { $inc: { [field]: amount, ...extraInc } }
    : [{ $set: { [field]: { $max: [0, { $add: [{ $ifNull: [`$${field}`, 0] }, amount] }] } } }];
  return Economy.findOneAndUpdate({ userId, guildId }, update, { new: true });
}

async function handleAwardCommand(interaction, client, guildConfig) {
  const { successEmbed, errorEmbed, warningEmbed, GLYPHS, createEmbed } = await import('../../utils/embeds.js');
  const Level = (await import('../../models/Level.js')).default;
  const ModLog = (await import('../../models/ModLog.js')).default;

  const type = interaction.options.getString('type');
  const targetUser = interaction.options.getUser('user');
  const amount = interaction.options.getInteger('amount');
  const reason = interaction.options.getString('reason') || 'No reason provided';

  // Checked before anything is written: an over-long reason used to break the confirmation
  // embed after the award was saved, and a retry then awarded twice
  if (reason.length > AWARD_REASON_MAX) {
    return interaction.editReply({
      embeds: [await errorEmbed(interaction.guild.id, 'Reason Too Long',
        `The reason is limited to ${AWARD_REASON_MAX} characters, Master.`)]
    });
  }

  // Only the server owner may award themselves
  if (targetUser.id === interaction.user.id && interaction.user.id !== interaction.guild.ownerId) {
    return interaction.editReply({
      embeds: [await errorEmbed(interaction.guild.id, 'Invalid Target', 'You cannot award yourself, Master.')]
    });
  }

  // Check if target is a bot
  if (targetUser.bot) {
    return interaction.editReply({
      embeds: [await errorEmbed(interaction.guild.id, 'Invalid Target',
        '**Warning:** Automated systems cannot receive awards, Master.')]
    });
  }

  if (amount === 0) {
    return interaction.editReply({
      embeds: [await errorEmbed(interaction.guild.id, 'Invalid Quantity',
        '**Warning:** Please provide a valid quantity (positive to grant, negative to revoke), Master.')]
    });
  }

  const guildId = interaction.guild.id;
  const isAdding = amount > 0;
  const absAmount = Math.abs(amount);
  let applied = false;

  try {
    let result;

    switch (type) {
      case 'xp': {
        let levelData = await Level.findOne({ userId: targetUser.id, guildId });

        if (!levelData) {
          levelData = new Level({
            userId: targetUser.id,
            guildId,
            username: targetUser.username
          });
        }

        let leveledUp = [];
        if (amount < 0) {
          // Remove XP
          levelData.totalXP = Math.max(0, levelData.totalXP - absAmount);
          levelData.xp = Math.max(0, levelData.xp - absAmount);

          // Recalculate level based on totalXP
          let newLevel = 0;
          let accumulatedXP = 0;

          while (true) {
            const xpForLevel = Math.floor(100 + (newLevel * 50) + Math.pow(newLevel, 1.5) * 25);
            if (accumulatedXP + xpForLevel > levelData.totalXP) {
              levelData.level = newLevel;
              levelData.xp = levelData.totalXP - accumulatedXP;
              break;
            }
            accumulatedXP += xpForLevel;
            newLevel++;
            if (newLevel > 1000) break;
          }
        } else {
          leveledUp = levelData.addXP(amount) || [];
        }

        levelData.username = targetUser.username;
        await levelData.save();
        applied = true;

        result = {
          unit: 'XP',
          typeName: 'XP',
          newValue: levelData.totalXP,
          levelInfo: `**Level:** ${levelData.level} • **Current XP:** ${levelData.xp}/${levelData.xpForNextLevel()}`,
          leveledUp,
          levelData
        };
        break;
      }

      case 'coins': {
        const economy = await applyAtomicEconomyChange(targetUser.id, guildId, 'coins', amount,
          amount > 0 ? { 'stats.totalEarned': amount } : {});
        applied = true;

        result = {
          unit: guildConfig.economy?.coinName || 'coins',
          typeName: 'Coins',
          newValue: economy.coins,
          levelInfo: `**Wallet:** ${economy.coins.toLocaleString()}`
        };
        break;
      }

      case 'rep': {
        const economy = await applyAtomicEconomyChange(targetUser.id, guildId, 'reputation', amount);
        applied = true;

        result = {
          unit: 'reputation',
          typeName: 'Reputation',
          newValue: economy.reputation
        };
        break;
      }
    }

    const actionWord = isAdding ? 'Granted' : 'Revoked';
    const embed = await successEmbed(guildId,
      `${result.typeName} ${actionWord}`,
      `**Confirmed:** Successfully ${isAdding ? 'granted' : 'revoked'} **${absAmount.toLocaleString()}** ${result.unit} ${isAdding ? 'to' : 'from'} ${targetUser}, Master.\n\n` +
      `**${targetUser.username}'s New ${result.typeName}:** ${result.newValue.toLocaleString()}` +
      (result.levelInfo ? `\n${result.levelInfo}` : '') +
      `\n\n**Reason:** ${reason}`
    );

    await interaction.editReply({ embeds: [embed] });

    // Send level up announcement if user leveled up
    if (type === 'xp' && result.leveledUp?.length > 0) {
      await announceLevelUpFromAward(interaction.guild, guildConfig, targetUser, result.levelData, result.leveledUp);
    }

    // Try to DM the user
    try {
      const dmDescription =
        `**Notice:** An administrator in **${interaction.guild.name}** has ${isAdding ? 'granted you' : 'removed'} **${absAmount.toLocaleString()}** ${result.unit}.\n\n` +
        `${GLYPHS.ARROW_RIGHT} **New ${result.typeName} Total:** ${result.newValue.toLocaleString()}\n` +
        `${GLYPHS.ARROW_RIGHT} **Reason:** ${reason}`;
      const dmEmbed = isAdding
        ? await successEmbed(guildId, `${result.typeName} ${actionWord}`, dmDescription)
        : await warningEmbed(guildId, `${result.typeName} ${actionWord}`, dmDescription);
      await targetUser.send({ embeds: [dmEmbed] });
    } catch {
      // User has DMs disabled
    }

    // Log to mod log channel (as the prefix command's logAward does, plus the slash-only reason)
    try {
      if (guildConfig?.channels?.modLog) {
        const modLogChannel = interaction.guild.channels.cache.get(guildConfig.channels.modLog);
        if (modLogChannel) {
          const caseNumber = await ModLog.getNextCaseNumber(guildId);

          const logEmbed = await createEmbed(guildId, isAdding ? 'success' : 'warning');
          logEmbed.setTitle(`${isAdding ? GLYPHS.STAR : GLYPHS.DIAMOND} ${isAdding ? 'AWARD' : 'DEDUCT'} | Case #${caseNumber}`)
            .setDescription(`**${result.typeName}** has been ${isAdding ? 'awarded to' : 'deducted from'} a member.`)
            .addFields(
              { name: `${GLYPHS.ARROW_RIGHT} User`, value: `${targetUser.tag}\n\`${targetUser.id}\``, inline: true },
              { name: `${GLYPHS.ARROW_RIGHT} Moderator`, value: `${interaction.user.tag}`, inline: true },
              { name: `${GLYPHS.ARROW_RIGHT} Amount`, value: `${isAdding ? '+' : '-'}${absAmount.toLocaleString()} ${result.unit}`, inline: true },
              { name: `${GLYPHS.ARROW_RIGHT} New Total`, value: `${result.newValue.toLocaleString()} ${result.unit}`, inline: true },
              { name: `${GLYPHS.ARROW_RIGHT} Reason`, value: reason, inline: false }
            )
            .setThumbnail(targetUser.displayAvatarURL({ dynamic: true }))
            .setTimestamp();

          const logMessage = await modLogChannel.send({ embeds: [logEmbed] });

          // Save to database
          await ModLog.create({
            guildId,
            caseNumber,
            action: `award_${type}`,
            moderatorId: interaction.user.id,
            moderatorTag: interaction.user.tag,
            targetId: targetUser.id,
            targetTag: targetUser.tag,
            reason: `${reason} | ${isAdding ? 'Added' : 'Removed'} ${absAmount.toLocaleString()} ${result.typeName.toLowerCase()}`,
            details: {
              type,
              amount,
              newValue: result.newValue
            },
            messageId: logMessage.id,
            channelId: modLogChannel.id
          });
        }
      }
    } catch (logError) {
      console.error('Error logging award to mod log:', logError);
    }

  } catch (error) {
    console.error('Error in award command:', error);
    // Once saved, say so: reporting a plain failure invites a retry that awards twice
    return interaction.editReply({
      embeds: [await errorEmbed(guildId, 'Award Failed', applied
        ? 'The award was applied, but I could not complete the confirmation. Please do not repeat it, Master.'
        : 'An anomaly occurred while processing the award, Master. Nothing was changed.')]
    });
  }
}

// Handle noxp command
async function handleNoxpCommand(interaction, guildConfig) {
  const { successEmbed, errorEmbed, infoEmbed, GLYPHS } = await import('../../utils/embeds.js');
  const subcommand = interaction.options.getSubcommand();

  // Initialize noXpChannels array if not exists
  const noXpChannels = guildConfig.features?.levelSystem?.noXpChannels || [];

  switch (subcommand) {
    case 'add': {
      const channel = interaction.options.getChannel('channel');

      if (channel.type !== ChannelType.GuildText) {
        await interaction.editReply({
          embeds: [await errorEmbed(interaction.guild.id, 'Invalid Channel',
            `${GLYPHS.ERROR} Please select a text channel.`)]
        });
        return;
      }

      if (noXpChannels.includes(channel.id)) {
        await interaction.editReply({
          embeds: [await errorEmbed(interaction.guild.id, 'Already Blacklisted',
            `${GLYPHS.ERROR} ${channel} is already blacklisted from earning XP.`)]
        });
        return;
      }

      await Guild.updateGuild(interaction.guild.id, {
        $push: { 'features.levelSystem.noXpChannels': channel.id }
      });

      await interaction.editReply({
        embeds: [await successEmbed(interaction.guild.id, 'Channel Blacklisted',
          `${GLYPHS.SUCCESS} ${channel} has been added to the no-XP list.\n\nMessages in this channel will no longer earn XP.`)]
      });
      break;
    }

    case 'remove': {
      const channel = interaction.options.getChannel('channel');

      if (!noXpChannels.includes(channel.id)) {
        await interaction.editReply({
          embeds: [await errorEmbed(interaction.guild.id, 'Not Blacklisted',
            `${GLYPHS.ERROR} ${channel} is not in the no-XP list.`)]
        });
        return;
      }

      await Guild.updateGuild(interaction.guild.id, {
        $pull: { 'features.levelSystem.noXpChannels': channel.id }
      });

      await interaction.editReply({
        embeds: [await successEmbed(interaction.guild.id, 'Channel Removed',
          `${GLYPHS.SUCCESS} ${channel} has been removed from the no-XP list.\n\nMessages in this channel will now earn XP again.`)]
      });
      break;
    }

    case 'list': {
      if (noXpChannels.length === 0) {
        await interaction.editReply({
          embeds: [await infoEmbed(interaction.guild.id, 'No Blacklisted Channels',
            `${GLYPHS.INFO} No channels are blacklisted from earning XP.\n\nUse \`/noxp add\` to add one, Master.`)]
        });
        return;
      }

      const channelList = noXpChannels.map(id => {
        const channel = interaction.guild.channels.cache.get(id);
        return channel ? `${GLYPHS.ARROW_RIGHT} ${channel}` : `${GLYPHS.ARROW_RIGHT} <Deleted Channel>`;
      }).join('\n');

      const embed = await infoEmbed(interaction.guild.id, 'No-XP Channels',
        `**${noXpChannels.length} channel(s) blacklisted from earning XP:**\n\n${channelList}`.slice(0, 4096));

      await interaction.editReply({ embeds: [embed] });
      break;
    }

    case 'clear': {
      if (noXpChannels.length === 0) {
        await interaction.editReply({
          embeds: [await errorEmbed(interaction.guild.id, 'No Channels',
            `${GLYPHS.ERROR} There are no blacklisted channels to clear.`)]
        });
        return;
      }

      await Guild.updateGuild(interaction.guild.id, {
        $set: { 'features.levelSystem.noXpChannels': [] }
      });

      await interaction.editReply({
        embeds: [await successEmbed(interaction.guild.id, 'Channels Cleared',
          `${GLYPHS.SUCCESS} All channels have been removed from the no-XP list.`)]
      });
      break;
    }
  }
}

// Handle setoverlay command
async function handleSetoverlayCommand(interaction, guildConfig) {
  const { successEmbed, errorEmbed, GLYPHS } = await import('../../utils/embeds.js');
  const { EmbedBuilder } = await import('discord.js');
  const subcommand = interaction.options.getSubcommand();

  // Helper function to convert hex to rgba
  function hexToRgba(hex, opacity) {
    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    if (!result) return null;
    const r = parseInt(result[1], 16);
    const g = parseInt(result[2], 16);
    const b = parseInt(result[3], 16);
    return `rgba(${r}, ${g}, ${b}, ${opacity})`;
  }

  // Check if user customization is enabled
  const customizationEnabled = guildConfig.economy?.profileCustomization?.enabled !== false;

  switch (subcommand) {
    case 'view': {
      const cardOverlay = guildConfig.economy?.cardOverlay || { color: '#000000', opacity: 0.5 };
      const overlayRgba = hexToRgba(cardOverlay.color, cardOverlay.opacity);

      // Shown in the overlay color as a preview
      const embed = new EmbedBuilder()
        .setColor(cardOverlay.color || COLORS.RAPHAEL)
        .setTitle('『 Server Overlay Settings 』')
        .setDescription(customizationEnabled
          ? `${GLYPHS.ERROR} **Member customization is enabled**: these settings are not active.\n` +
            'Use `/feature type:profilecustomization status:disable` to take control, Master.'
          : `${GLYPHS.SUCCESS} **These settings apply to all profile and level cards.**`)
        .addFields(
          {
            name: '▸ Color',
            value: `\`${cardOverlay.color}\``,
            inline: true
          },
          {
            name: '▸ Opacity',
            value: `\`${Math.round(cardOverlay.opacity * 100)}%\``,
            inline: true
          },
          {
            name: '▸ Result',
            value: `\`${overlayRgba}\``,
            inline: true
          }
        )
        .setFooter({ text: getRandomFooter() });

      await interaction.editReply({ embeds: [embed] });
      break;
    }

    case 'reset': {
      const defaultSettings = { color: '#000000', opacity: 0.5 };

      await Guild.updateGuild(interaction.guild.id, {
        $set: { 'economy.cardOverlay': defaultSettings }
      });

      await interaction.editReply({
        embeds: [await successEmbed(interaction.guild.id, 'Overlay Settings Reset',
          `${GLYPHS.SUCCESS} Server overlay settings reset to default.\n\n` +
          `**Default Values:**\n` +
          `◇ Color: \`#000000\`\n` +
          `◇ Opacity: \`50%\``)]
      });
      break;
    }

    case 'color': {
      const hex = interaction.options.getString('hex');

      // Validate hex color
      const hexRegex = /^#?([0-9A-Fa-f]{6})$/;
      const match = hex.match(hexRegex);

      if (!match) {
        await interaction.editReply({
          embeds: [await errorEmbed(interaction.guild.id, 'Invalid Color',
            `${GLYPHS.ERROR} Please provide a valid hex color, Master.\n\n` +
            `**Examples:**\n` +
            `◇ \`#000000\` - Black\n` +
            `◇ \`#1a1a2e\` - Dark Blue\n` +
            `◇ \`#2C2F33\` - Discord Dark`)]
        });
        return;
      }

      const hexColor = `#${match[1].toLowerCase()}`;

      await Guild.updateGuild(interaction.guild.id, {
        $set: { 'economy.cardOverlay.color': hexColor }
      });

      await interaction.editReply({
        embeds: [await successEmbed(interaction.guild.id, 'Overlay Color Updated',
          `${GLYPHS.SUCCESS} Server overlay color set to \`${hexColor}\`\n\n` +
          `This applies to both **profile** and **level/rank** cards.`)]
      });
      break;
    }

    case 'opacity': {
      const opacityPercent = interaction.options.getInteger('percent');
      const opacity = opacityPercent / 100;

      await Guild.updateGuild(interaction.guild.id, {
        $set: { 'economy.cardOverlay.opacity': opacity }
      });

      await interaction.editReply({
        embeds: [await successEmbed(interaction.guild.id, 'Overlay Opacity Updated',
          `${GLYPHS.SUCCESS} Server overlay opacity set to \`${opacityPercent}%\`\n\n` +
          `This applies to both **profile** and **level/rank** cards.`)]
      });
      break;
    }
  }
}

// Announce a level-up from an award through the shared announcer, so awarded levels follow the
// server's level-up settings (channel, embed style, mention, placeholders) like earned ones
async function announceLevelUpFromAward(guild, guildConfig, user, levelData, leveledUp) {
  const { sendLevelUpAnnouncement } = await import('../../commands/config/levelup.js');
  const member = await guild.members.fetch(user.id).catch(() => null);
  await sendLevelUpAnnouncement({ guild, member: member ?? user, guildConfig, levelData, levelsGained: leveledUp });
}

// The confession panel, as the prefix confession command sends it; confession_submit is
// handled by confessionHandler.js
async function sendConfessionPanel(channel) {
  const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = await import('discord.js');
  const panelEmbed = new EmbedBuilder()
    .setTitle('『 Anonymous Confessions 』')
    .setDescription('Use the button below to submit an anonymous confession.\n\n*Your identity will remain hidden from other members.*')
    .setColor(COLORS.RAPHAEL)
    .setFooter({ text: 'Confessions are moderated • Be respectful' });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('confession_submit')
      .setLabel('Submit a Confession')
      .setStyle(ButtonStyle.Primary)
  );
  await channel.send({ embeds: [panelEmbed], components: [row] });
}

const yesNo = (value) => value ? '◉ Yes' : '◇ No';

// Handle Confession slash command
async function handleConfessionCommand(interaction) {
  const { successEmbed, errorEmbed, infoEmbed, GLYPHS } = await import('../../utils/embeds.js');
  const Confession = (await import('../../models/Confession.js')).default;
  const subcommand = interaction.options.getSubcommand();

  let confessionData = await Confession.findOne({ guildId: interaction.guild.id });
  if (!confessionData) {
    confessionData = new Confession({ guildId: interaction.guild.id });
  }

  const panelFailed = async (channel) => interaction.editReply({
    embeds: [await errorEmbed(interaction.guild.id, 'Panel Not Sent',
      `${GLYPHS.ERROR} I could not post the confession panel in ${channel}. Please check my permissions there, Master.`)]
  });

  switch (subcommand) {
    case 'setup': {
      const channel = interaction.options.getChannel('channel');

      if (channel.type !== ChannelType.GuildText) {
        await interaction.editReply({
          embeds: [await errorEmbed(interaction.guild.id, 'Invalid Channel',
            `${GLYPHS.ERROR} Please select a text channel, Master.`)]
        });
        return;
      }

      const botPerms = channel.permissionsFor(interaction.guild.members.me);
      if (!botPerms.has(['ViewChannel', 'SendMessages', 'EmbedLinks'])) {
        await interaction.editReply({
          embeds: [await errorEmbed(interaction.guild.id, 'Missing Permissions',
            `${GLYPHS.ERROR} I need \`View Channel\`, \`Send Messages\` and \`Embed Links\` permissions in ${channel}, Master.`)]
        });
        return;
      }

      try {
        await sendConfessionPanel(channel);
      } catch (error) {
        console.error('Error sending confession panel:', error);
        return panelFailed(channel);
      }

      confessionData.channelId = channel.id;
      confessionData.enabled = true;
      await confessionData.save();

      await interaction.editReply({
        embeds: [await successEmbed(interaction.guild.id, 'Confession System Enabled',
          `${GLYPHS.SUCCESS} Confession system has been set up in ${channel}.\n\nA confession panel has been sent to the channel.`)]
      });
      break;
    }

    case 'disable': {
      confessionData.enabled = false;
      confessionData.channelId = null;
      await confessionData.save();

      await interaction.editReply({
        embeds: [await successEmbed(interaction.guild.id, 'Confession System Disabled',
          `${GLYPHS.SUCCESS} The confession system has been disabled.`)]
      });
      break;
    }

    case 'settings': {
      const embed = await infoEmbed(interaction.guild.id, 'Confession Settings',
        `**▸ Status:** ${confessionData.enabled ? '◉ Active' : '◇ Inactive'}`);
      embed.addFields(
        { name: '▸ Channel', value: confessionData.channelId ? `<#${confessionData.channelId}>` : 'Not set', inline: true },
        { name: '▸ Total Confessions', value: `${confessionData.confessionCount}`, inline: true },
        { name: '▸ Cooldown', value: `${confessionData.settings.cooldown} seconds`, inline: true },
        { name: '▸ Allow Replies', value: yesNo(confessionData.settings.allowReplies), inline: true },
        { name: '▸ Anonymous Replies', value: yesNo(confessionData.settings.anonymousReplies), inline: true },
        { name: '▸ Require Approval', value: yesNo(confessionData.settings.requireApproval), inline: true },
        { name: '▸ Min Length', value: `${confessionData.settings.minLength} chars`, inline: true },
        { name: '▸ Max Length', value: `${confessionData.settings.maxLength} chars`, inline: true },
        { name: '▸ Banned Users', value: `${confessionData.settings.bannedUsers.length} users`, inline: true }
      );

      await interaction.editReply({ embeds: [embed] });
      break;
    }

    case 'cooldown': {
      const seconds = interaction.options.getInteger('seconds');
      confessionData.settings.cooldown = seconds;
      await confessionData.save();

      await interaction.editReply({
        embeds: [await successEmbed(interaction.guild.id, 'Cooldown Updated',
          `${GLYPHS.SUCCESS} Confession cooldown set to **${seconds} seconds**.`)]
      });
      break;
    }

    case 'replies': {
      const enabled = interaction.options.getBoolean('enabled');
      confessionData.settings.allowReplies = enabled;
      await confessionData.save();

      await interaction.editReply({
        embeds: [await successEmbed(interaction.guild.id, 'Replies Setting Updated',
          `${GLYPHS.SUCCESS} Confession replies have been ${enabled ? 'enabled' : 'disabled'}.`)]
      });
      break;
    }

    case 'anonymous-replies': {
      const enabled = interaction.options.getBoolean('enabled');
      confessionData.settings.anonymousReplies = enabled;
      await confessionData.save();

      await interaction.editReply({
        embeds: [await successEmbed(interaction.guild.id, 'Anonymous Replies Updated',
          `${GLYPHS.SUCCESS} Anonymous replies have been ${enabled ? 'enabled' : 'disabled'}.`)]
      });
      break;
    }

    case 'approval': {
      const enabled = interaction.options.getBoolean('enabled');
      confessionData.settings.requireApproval = enabled;
      await confessionData.save();

      await interaction.editReply({
        embeds: [await successEmbed(interaction.guild.id, 'Approval Setting Updated',
          `${GLYPHS.SUCCESS} Confession approval requirement has been ${enabled ? 'enabled' : 'disabled'}.`)]
      });
      break;
    }

    case 'ban': {
      const user = interaction.options.getUser('user');

      if (confessionData.settings.bannedUsers.includes(user.id)) {
        await interaction.editReply({
          embeds: [await errorEmbed(interaction.guild.id, 'Already Banned',
            `${GLYPHS.ERROR} ${user.tag} is already banned from confessions.`)]
        });
        return;
      }

      confessionData.settings.bannedUsers.push(user.id);
      await confessionData.save();

      await interaction.editReply({
        embeds: [await successEmbed(interaction.guild.id, 'User Banned',
          `${GLYPHS.SUCCESS} **${user.tag}** has been banned from submitting confessions.`)]
      });
      break;
    }

    case 'unban': {
      const user = interaction.options.getUser('user');
      const index = confessionData.settings.bannedUsers.indexOf(user.id);

      if (index === -1) {
        await interaction.editReply({
          embeds: [await errorEmbed(interaction.guild.id, 'Not Banned',
            `${GLYPHS.ERROR} ${user.tag} is not banned from confessions.`)]
        });
        return;
      }

      confessionData.settings.bannedUsers.splice(index, 1);
      await confessionData.save();

      await interaction.editReply({
        embeds: [await successEmbed(interaction.guild.id, 'User Unbanned',
          `${GLYPHS.SUCCESS} **${user.tag}** has been unbanned from confessions.`)]
      });
      break;
    }

    case 'pending': {
      if (!confessionData.pendingConfessions || confessionData.pendingConfessions.length === 0) {
        await interaction.editReply({
          embeds: [await infoEmbed(interaction.guild.id, 'No Pending Confessions',
            `${GLYPHS.INFO} There are no confessions pending approval.`)]
        });
        return;
      }

      const pendingCount = confessionData.pendingConfessions.length;
      const embed = await infoEmbed(interaction.guild.id, 'Pending Confessions',
        confessionData.pendingConfessions.slice(0, 10).map((c, i) =>
          `**${i + 1}.** ${c.content.substring(0, 100)}${c.content.length > 100 ? '...' : ''}\n*Submitted <t:${Math.floor(c.timestamp.getTime() / 1000)}:R>*`
        ).join('\n\n'));
      embed.addFields({
        name: '▸ Queue',
        value: `Showing ${Math.min(10, pendingCount)} of ${pendingCount} pending. Use \`/confession approve\` or \`/confession reject\` with the number.`
      });

      await interaction.editReply({ embeds: [embed] });
      break;
    }

    case 'approve': {
      const id = interaction.options.getInteger('id') - 1;

      if (!confessionData.pendingConfessions || !confessionData.pendingConfessions[id]) {
        await interaction.editReply({
          embeds: [await errorEmbed(interaction.guild.id, 'Confession Not Found',
            `${GLYPHS.ERROR} Could not find a pending confession with that ID.`)]
        });
        return;
      }

      const channel = interaction.guild.channels.cache.get(confessionData.channelId);
      if (!channel?.isTextBased()) {
        await interaction.editReply({
          embeds: [await errorEmbed(interaction.guild.id, 'Channel Not Found',
            `${GLYPHS.ERROR} The confession channel no longer exists.`)]
        });
        return;
      }

      // Same posting path as direct submissions and the prefix command
      const { postConfession } = await import('./confessionHandler.js');
      const pending = confessionData.pendingConfessions[id];
      let confessionNumber;
      try {
        confessionNumber = await postConfession(channel, confessionData, pending.content, pending.userId);
      } catch (error) {
        console.error('Error posting approved confession:', error);
        return interaction.editReply({
          embeds: [await errorEmbed(interaction.guild.id, 'Confession Not Posted',
            `${GLYPHS.ERROR} I could not post in ${channel}. The confession is still pending, Master.`)]
        });
      }

      confessionData.pendingConfessions.splice(id, 1);
      await confessionData.save();

      await interaction.editReply({
        embeds: [await successEmbed(interaction.guild.id, 'Confession Approved',
          `${GLYPHS.SUCCESS} Confession #${confessionNumber} has been approved and posted.`)]
      });
      break;
    }

    case 'reject': {
      const id = interaction.options.getInteger('id') - 1;

      if (!confessionData.pendingConfessions || !confessionData.pendingConfessions[id]) {
        await interaction.editReply({
          embeds: [await errorEmbed(interaction.guild.id, 'Confession Not Found',
            `${GLYPHS.ERROR} Could not find a pending confession with that ID.`)]
        });
        return;
      }

      confessionData.pendingConfessions.splice(id, 1);
      await confessionData.save();

      await interaction.editReply({
        embeds: [await successEmbed(interaction.guild.id, 'Confession Rejected',
          `${GLYPHS.SUCCESS} The confession has been rejected and removed.`)]
      });
      break;
    }

    case 'send': {
      if (!confessionData.enabled) {
        await interaction.editReply({
          embeds: [await errorEmbed(interaction.guild.id, 'System Not Enabled',
            `${GLYPHS.ERROR} Please set up the confession system first with \`/confession setup\`.`)]
        });
        return;
      }

      const channel = interaction.options.getChannel('channel') ||
        interaction.guild.channels.cache.get(confessionData.channelId);

      if (!channel) {
        await interaction.editReply({
          embeds: [await errorEmbed(interaction.guild.id, 'Channel Not Found',
            `${GLYPHS.ERROR} Could not find a valid channel.`)]
        });
        return;
      }

      try {
        await sendConfessionPanel(channel);
      } catch (error) {
        console.error('Error sending confession panel:', error);
        return panelFailed(channel);
      }

      await interaction.editReply({
        embeds: [await successEmbed(interaction.guild.id, 'Panel Sent',
          `${GLYPHS.SUCCESS} Confession panel sent to ${channel}.`)]
      });
      break;
    }

    case 'stats': {
      const totalConfessions = confessionData.confessionCount;
      const totalReplies = confessionData.confessions?.reduce((acc, c) => acc + (c.replies?.length || 0), 0) || 0;
      const pendingCount = confessionData.pendingConfessions?.length || 0;
      const bannedCount = confessionData.settings.bannedUsers?.length || 0;

      const embed = await infoEmbed(interaction.guild.id, 'Confession Statistics',
        `**▸ Status:** ${confessionData.enabled ? '◉ Active' : '◇ Inactive'}`);
      embed.addFields(
        { name: '▸ Total Confessions', value: `${totalConfessions}`, inline: true },
        { name: '▸ Total Replies', value: `${totalReplies}`, inline: true },
        { name: '▸ Pending Approval', value: `${pendingCount}`, inline: true },
        { name: '▸ Banned Users', value: `${bannedCount}`, inline: true },
        { name: '▸ Channel', value: confessionData.channelId ? `<#${confessionData.channelId}>` : 'Not set', inline: true }
      );

      await interaction.editReply({ embeds: [embed] });
      break;
    }
  }
}

// Autocomplete handler
async function handleAutocomplete(interaction) {
  if (interaction.commandName !== 'onboarding') return;

  const focusedOption = interaction.options.getFocused(true);

  try {
    const onboarding = await interaction.guild.fetchOnboarding();
    const prompts = onboarding.prompts || new Map();
    let choices = [];

    if (focusedOption.name === 'question') {
      // Return list of questions
      choices = Array.from(prompts.values()).map(p => ({
        name: p.title.substring(0, 100),
        value: p.id
      }));
    } else if (focusedOption.name === 'option') {
      // Get the selected question first
      const questionId = interaction.options.getString('question');
      if (questionId) {
        const prompt = prompts.find(p => p.id === questionId);
        if (prompt) {
          choices = Array.from(prompt.options.values()).map(o => ({
            name: o.title.substring(0, 100),
            value: o.id
          }));
        }
      }
    }

    // Filter based on what user has typed
    const filtered = choices.filter(choice =>
      choice.name.toLowerCase().includes(focusedOption.value.toLowerCase())
    );

    await interaction.respond(filtered.slice(0, 25));
  } catch (error) {
    console.error('Autocomplete error:', error);
    await interaction.respond([]);
  }
}

// An onboarding change refused before it reaches Discord; the message is shown to the user
class OnboardingEditError extends Error {}

// Onboarding command handler
async function handleOnboardingCommand(interaction, guildConfig) {
  const { successEmbed, errorEmbed, infoEmbed, GLYPHS } = await import('../../utils/embeds.js');
  const { EmbedBuilder } = await import('discord.js');

  const group = interaction.options.getSubcommandGroup();
  const subcommand = interaction.options.getSubcommand();

  try {
    const onboarding = await interaction.guild.fetchOnboarding();

    // Discord.js GuildOnboarding has defaultChannels as a Collection, extract IDs from it
    let defaultChannelIds = [];
    if (onboarding.defaultChannels && onboarding.defaultChannels.size > 0) {
      defaultChannelIds = Array.from(onboarding.defaultChannels.keys());
    }

    const prompts = onboarding.prompts || new Map();

    // Members pick onboarding roles for themselves, so a role must be safe to hand out
    // (getAssignableRoleError) before it is attached to an option
    const rejectRole = async (roleError) => interaction.editReply({
      embeds: [await errorEmbed(interaction.guild.id, 'Role Not Allowed', roleError)]
    });

    // Helper to build prompts array for update
    const mapPrompts = (modifier) => {
      return Array.from(prompts.values()).map(p => {
        const promptData = {
          id: p.id,
          title: p.title,
          singleSelect: p.singleSelect,
          required: p.required,
          inOnboarding: p.inOnboarding,
          type: p.type,
          options: Array.from(p.options.values()).map(o => {
            // Extract role/channel IDs from Collections
            const roleIds = o.roles instanceof Map || (o.roles && typeof o.roles.keys === 'function')
              ? Array.from(o.roles.keys())
              : (Array.isArray(o.roles) ? o.roles : []);
            const channelIds = o.channels instanceof Map || (o.channels && typeof o.channels.keys === 'function')
              ? Array.from(o.channels.keys())
              : (Array.isArray(o.channels) ? o.channels : []);

            return {
              id: o.id,
              title: o.title,
              description: o.description,
              emoji: o.emoji ? { id: o.emoji.id, name: o.emoji.name } : null,
              channels: channelIds,
              roles: roleIds
            };
          })
        };
        return modifier ? modifier(promptData, p) : promptData;
      });
    };

    const updateOnboarding = async (updates) => {
      const payload = {
        enabled: updates.enabled ?? onboarding.enabled
      };

      // Always include defaultChannels (Discord.js uses defaultChannels, not defaultChannelIds)
      if (updates.defaultChannels !== undefined) {
        payload.defaultChannels = updates.defaultChannels;
      } else if (defaultChannelIds.length > 0) {
        payload.defaultChannels = defaultChannelIds;
      }

      // Include prompts - either the updated ones or existing (mapped properly)
      if (updates.prompts !== undefined) {
        payload.prompts = updates.prompts;
      } else if (prompts.size > 0) {
        payload.prompts = mapPrompts();
      }

      // Discord rejects an option with no role or channel and a question with no options.
      // Refuse such an edit with the reason, rather than quietly dropping the option or question.
      for (const prompt of payload.prompts ?? []) {
        if (!prompt.options?.length) {
          throw new OnboardingEditError(
            `The question **"${prompt.title}"** would be left with no options. ` +
            `Add another option first, or delete the question with \`/onboarding questions delete\`.`);
        }
        const emptyOption = prompt.options.find(o => !o.roles?.length && !o.channels?.length);
        if (emptyOption) {
          throw new OnboardingEditError(
            `The option **"${emptyOption.title}"** in **"${prompt.title}"** would be left with no role or channel, ` +
            `and every option needs at least one. Assign another first, or remove the option with \`/onboarding options remove\`.`);
        }
      }

      await interaction.guild.editOnboarding(payload);
    };

    // SETTINGS GROUP
    if (group === 'settings') {
      if (subcommand === 'view') {
        const embed = new EmbedBuilder()
          .setTitle('『 Onboarding Settings 』')
          .setColor(COLORS.RAPHAEL)
          .setDescription(`Server onboarding configuration for **${interaction.guild.name}**, Master.`)
          .setFooter({ text: getRandomFooter() })
          .addFields(
            {
              name: '▸ Status',
              value: [
                `**Enabled:** ${onboarding.enabled ? '◉ Yes' : '◇ No'}`,
                `**Mode:** ${onboarding.mode === 0 ? 'Default' : 'Advanced'}`,
              ].join('\n'),
              inline: true
            },
            {
              name: '▸ Default Channels',
              value: defaultChannelIds.length > 0
                ? truncateList(defaultChannelIds.map(id => `<#${id}>`).join(', '), 1024)
                : '*No default channels*',
              inline: true
            },
            {
              name: '▸ Questions',
              value: `${prompts.size} question(s) configured`,
              inline: true
            }
          );

        if (prompts.size > 0) {
          const questionsList = Array.from(prompts.values()).map((prompt, index) => {
            const flags = [];
            if (prompt.required) flags.push('Required');
            if (prompt.singleSelect) flags.push('Single');
            else flags.push('Multi');

            return `**${index + 1}.** ${prompt.title}\n   › ${prompt.options.size} options | ${flags.join(', ')}`;
          }).join('\n');

          embed.addFields({
            name: '▸ Questions List',
            value: questionsList.substring(0, 1024) || '*None*',
            inline: false
          });
        }

        embed.setTimestamp();
        return interaction.editReply({ embeds: [embed] });
      }

      if (subcommand === 'enable') {
        if (defaultChannelIds.length === 0) {
          return interaction.editReply({
            embeds: [await errorEmbed(interaction.guild.id, 'Cannot Enable',
              `${GLYPHS.ERROR} You need at least **1 default channel** before enabling onboarding.\n\n` +
              `Use \`/onboarding channels add\` to add one.`)]
          });
        }

        await updateOnboarding({ enabled: true });
        return interaction.editReply({
          embeds: [await successEmbed(interaction.guild.id, 'Onboarding Enabled',
            `${GLYPHS.SUCCESS} Server onboarding has been enabled.`)]
        });
      }

      if (subcommand === 'disable') {
        await updateOnboarding({ enabled: false });
        return interaction.editReply({
          embeds: [await successEmbed(interaction.guild.id, 'Onboarding Disabled',
            `${GLYPHS.SUCCESS} Server onboarding has been disabled.`)]
        });
      }
    }

    // CHANNELS GROUP
    if (group === 'channels') {
      if (subcommand === 'list') {
        const embed = await infoEmbed(interaction.guild.id, 'Default Channels',
          defaultChannelIds.length > 0
            ? `**${defaultChannelIds.length} default channel(s):**\n\n` +
              defaultChannelIds.map((id, i) => `**${i + 1}.** <#${id}>`).join('\n').slice(0, 3900)
            : '*No default channels configured.*');

        return interaction.editReply({ embeds: [embed] });
      }

      if (subcommand === 'add') {
        const channel = interaction.options.getChannel('channel');

        if (defaultChannelIds.includes(channel.id)) {
          return interaction.editReply({
            embeds: [await errorEmbed(interaction.guild.id, 'Already Added',
              `${GLYPHS.ERROR} ${channel} is already a default channel.`)]
          });
        }

        await updateOnboarding({
          defaultChannels: [...defaultChannelIds, channel.id]
        });

        return interaction.editReply({
          embeds: [await successEmbed(interaction.guild.id, 'Channel Added',
            `${GLYPHS.SUCCESS} ${channel} has been added to default channels.`)]
        });
      }

      if (subcommand === 'remove') {
        const channel = interaction.options.getChannel('channel');

        if (!defaultChannelIds.includes(channel.id)) {
          return interaction.editReply({
            embeds: [await errorEmbed(interaction.guild.id, 'Not Found',
              `${GLYPHS.ERROR} ${channel} is not a default channel.`)]
          });
        }

        const newChannelIds = defaultChannelIds.filter(id => id !== channel.id);

        if (onboarding.enabled && newChannelIds.length === 0) {
          return interaction.editReply({
            embeds: [await errorEmbed(interaction.guild.id, 'Cannot Remove',
              `${GLYPHS.ERROR} You need at least 1 default channel while onboarding is enabled.`)]
          });
        }

        await updateOnboarding({ defaultChannels: newChannelIds });

        return interaction.editReply({
          embeds: [await successEmbed(interaction.guild.id, 'Channel Removed',
            `${GLYPHS.SUCCESS} ${channel} has been removed from default channels.`)]
        });
      }
    }

    // QUESTIONS GROUP
    if (group === 'questions') {
      if (subcommand === 'list') {
        const embed = new EmbedBuilder()
          .setTitle('『 Onboarding Questions 』')
          .setColor(COLORS.RAPHAEL);

        if (prompts.size === 0) {
          embed.setDescription('*No questions configured*');
        } else {
          const questionsList = Array.from(prompts.values()).map((prompt, index) => {
            const flags = [];
            if (prompt.required) flags.push('Required');
            else flags.push('Optional');
            if (prompt.singleSelect) flags.push('Single choice');
            else flags.push('Multiple choice');

            let optionsList = Array.from(prompt.options.values()).map(o => {
              const roleCount = o.roles?.size || 0;
              const channelCount = o.channels?.size || 0;
              return `    • ${o.title}${roleCount > 0 ? ` (${roleCount} roles)` : ''}${channelCount > 0 ? ` (${channelCount} ch)` : ''}`;
            }).join('\n');

            return `**${index + 1}. ${prompt.title}**\n` +
              `   ${flags.join(' | ')}\n` +
              (optionsList ? `${optionsList}\n` : '   *No options*\n');
          }).join('\n');

          embed.setDescription(questionsList.substring(0, 4000));
        }

        embed.setFooter({ text: `${getRandomFooter()} | ${prompts.size} question(s)` });
        embed.setTimestamp();

        return interaction.editReply({ embeds: [embed] });
      }

      if (subcommand === 'add') {
        const title = interaction.options.getString('title');
        const required = interaction.options.getBoolean('required') ?? false;
        const singleSelect = interaction.options.getBoolean('single_select') ?? false;
        const optionTitle = interaction.options.getString('option_title');
        const optionRole = interaction.options.getRole('option_role');
        const optionChannel = interaction.options.getChannel('option_channel');

        // Require at least one role or channel for the initial option
        if (!optionRole && !optionChannel) {
          return interaction.editReply({
            embeds: [await errorEmbed(interaction.guild.id, 'Role/Channel Required',
              `${GLYPHS.ERROR} Each option must have at least one **role** or **channel** assigned.\n\n` +
              `Please provide \`option_role\` or \`option_channel\`.`)]
          });
        }
        if (optionRole) {
          const roleError = getAssignableRoleError(optionRole, interaction.member);
          if (roleError) return rejectRole(roleError);
        }

        const newPrompt = {
          title: title,
          singleSelect: singleSelect,
          required: required,
          inOnboarding: true,
          type: GuildOnboardingPromptType.MultipleChoice,
          options: [{
            title: optionTitle,
            description: null,
            emoji: null,
            roles: optionRole ? [optionRole.id] : [],
            channels: optionChannel ? [optionChannel.id] : []
          }]
        };

        await updateOnboarding({
          prompts: [...mapPrompts(), newPrompt]
        });

        return interaction.editReply({
          embeds: [await successEmbed(interaction.guild.id, 'Question Created',
            `${GLYPHS.SUCCESS} Question created with its initial option.\n\n` +
            `**Question:** ${title}\n` +
            `**Option:** ${optionTitle}\n` +
            `**Single Select:** ${singleSelect ? 'Yes' : 'No'}\n` +
            `**Required:** ${required ? 'Yes' : 'No'}\n\n` +
            `Use \`/onboarding options add\` to add more options.`)]
        });
      }

      if (subcommand === 'edit') {
        const questionId = interaction.options.getString('question');
        const newTitle = interaction.options.getString('title');
        const required = interaction.options.getBoolean('required');
        const singleSelect = interaction.options.getBoolean('single_select');

        const prompt = prompts.find(p => p.id === questionId);
        if (!prompt) {
          return interaction.editReply({
            embeds: [await errorEmbed(interaction.guild.id, 'Not Found',
              `${GLYPHS.ERROR} Question not found. Please select from the dropdown.`)]
          });
        }

        const updatedPrompts = mapPrompts((promptData, original) => {
          if (original.id === questionId) {
            if (newTitle) promptData.title = newTitle;
            if (required !== null) promptData.required = required;
            if (singleSelect !== null) promptData.singleSelect = singleSelect;
          }
          return promptData;
        });

        await updateOnboarding({ prompts: updatedPrompts });

        const changes = [];
        if (newTitle) changes.push(`Title › ${newTitle}`);
        if (required !== null) changes.push(`Required › ${required ? 'Yes' : 'No'}`);
        if (singleSelect !== null) changes.push(`Single Select › ${singleSelect ? 'Yes' : 'No'}`);

        return interaction.editReply({
          embeds: [await successEmbed(interaction.guild.id, 'Question Updated',
            `${GLYPHS.SUCCESS} Question **"${prompt.title}"** updated.\n\n${changes.join('\n') || 'No changes made'}`)]
        });
      }

      if (subcommand === 'delete') {
        const questionId = interaction.options.getString('question');

        const prompt = prompts.find(p => p.id === questionId);
        if (!prompt) {
          return interaction.editReply({
            embeds: [await errorEmbed(interaction.guild.id, 'Not Found',
              `${GLYPHS.ERROR} Question not found.`)]
          });
        }

        const updatedPrompts = mapPrompts().filter(p => p.id !== questionId);
        await updateOnboarding({ prompts: updatedPrompts });

        return interaction.editReply({
          embeds: [await successEmbed(interaction.guild.id, 'Question Deleted',
            `${GLYPHS.SUCCESS} Question **"${prompt.title}"** has been deleted.`)]
        });
      }
    }

    // OPTIONS GROUP
    if (group === 'options') {
      const questionId = interaction.options.getString('question');
      const prompt = prompts.find(p => p.id === questionId);

      if (!prompt) {
        return interaction.editReply({
          embeds: [await errorEmbed(interaction.guild.id, 'Not Found',
            `${GLYPHS.ERROR} Question not found. Please select from the dropdown.`)]
        });
      }

      if (subcommand === 'list') {
        const embed = new EmbedBuilder()
          .setTitle(`『 Options: ${prompt.title} 』`.slice(0, 256))
          .setColor(COLORS.RAPHAEL);

        if (prompt.options.size === 0) {
          embed.setDescription('*No options configured*');
        } else {
          const optionsList = Array.from(prompt.options.values()).map((opt, index) => {
            const roles = opt.roles?.size > 0
              ? `\n   › Roles: ${Array.from(opt.roles.keys()).map(id => `<@&${id}>`).join(', ')}`
              : '';
            const channels = opt.channels?.size > 0
              ? `\n   › Channels: ${Array.from(opt.channels.keys()).map(id => `<#${id}>`).join(', ')}`
              : '';

            return `**${index + 1}. ${opt.title}**` +
              (opt.description ? `\n   ${opt.description}` : '') +
              roles + channels;
          }).join('\n\n');

          embed.setDescription(optionsList.substring(0, 4000));
        }

        embed.setFooter({ text: `${getRandomFooter()} | ${prompt.options.size} option(s)` });
        embed.setTimestamp();

        return interaction.editReply({ embeds: [embed] });
      }

      if (subcommand === 'add') {
        const title = interaction.options.getString('title');
        const description = interaction.options.getString('description');
        const emojiInput = interaction.options.getString('emoji');

        let emoji = null;
        if (emojiInput) {
          const customEmojiMatch = emojiInput.match(/<a?:(\w+):(\d+)>/);
          if (customEmojiMatch) {
            emoji = { id: customEmojiMatch[2], name: customEmojiMatch[1] };
          } else {
            emoji = { id: null, name: emojiInput };
          }
        }

        // Discord requires at least one role or channel for each option
        const role = interaction.options.getRole('role');
        const channel = interaction.options.getChannel('channel');

        if (!role && !channel) {
          return interaction.editReply({
            embeds: [await errorEmbed(interaction.guild.id, 'Role/Channel Required',
              `${GLYPHS.ERROR} Each option must have at least one **role** or **channel** assigned.\n\n` +
              `Please provide a \`role\` or \`channel\` option when adding.`)]
          });
        }
        if (role) {
          const roleError = getAssignableRoleError(role, interaction.member);
          if (roleError) return rejectRole(roleError);
        }

        const updatedPrompts = mapPrompts((promptData, original) => {
          if (original.id === questionId) {
            promptData.options.push({
              title: title,
              description: description || null,
              emoji: emoji,
              channels: channel ? [channel.id] : [],
              roles: role ? [role.id] : []
            });
          }
          return promptData;
        });

        await updateOnboarding({ prompts: updatedPrompts });

        return interaction.editReply({
          embeds: [await successEmbed(interaction.guild.id, 'Option Added',
            `${GLYPHS.SUCCESS} Option **"${title}"** added to question **"${prompt.title}"**.`)]
        });
      }

      if (subcommand === 'remove') {
        const optionId = interaction.options.getString('option');
        const option = prompt.options.find(o => o.id === optionId);

        if (!option) {
          return interaction.editReply({
            embeds: [await errorEmbed(interaction.guild.id, 'Not Found',
              `${GLYPHS.ERROR} Option not found. Please select from the dropdown.`)]
          });
        }

        const updatedPrompts = mapPrompts((promptData, original) => {
          if (original.id === questionId) {
            promptData.options = promptData.options.filter(o => o.id !== optionId);
          }
          return promptData;
        });

        await updateOnboarding({ prompts: updatedPrompts });

        return interaction.editReply({
          embeds: [await successEmbed(interaction.guild.id, 'Option Removed',
            `${GLYPHS.SUCCESS} Option **"${option.title}"** has been removed.`)]
        });
      }

      if (subcommand === 'role') {
        const optionId = interaction.options.getString('option');
        const role = interaction.options.getRole('role');
        const remove = interaction.options.getBoolean('remove') ?? false;

        const option = prompt.options.find(o => o.id === optionId);
        if (!option) {
          return interaction.editReply({
            embeds: [await errorEmbed(interaction.guild.id, 'Not Found',
              `${GLYPHS.ERROR} Option not found.`)]
          });
        }
        if (!remove) {
          const roleError = getAssignableRoleError(role, interaction.member);
          if (roleError) return rejectRole(roleError);
        }

        const updatedPrompts = mapPrompts((promptData, original) => {
          if (original.id === questionId) {
            const opt = promptData.options.find(o => o.id === optionId);
            if (opt) {
              if (!opt.roles) opt.roles = [];
              if (remove) {
                opt.roles = opt.roles.filter(id => id !== role.id);
              } else {
                if (!opt.roles.includes(role.id)) {
                  opt.roles.push(role.id);
                }
              }
            }
          }
          return promptData;
        });

        await updateOnboarding({ prompts: updatedPrompts });

        return interaction.editReply({
          embeds: [await successEmbed(interaction.guild.id, remove ? 'Role Removed' : 'Role Added',
            `${GLYPHS.SUCCESS} ${remove ? 'Removed' : 'Added'} ${role} ${remove ? 'from' : 'to'} option **"${option.title}"**.`)]
        });
      }

      if (subcommand === 'channel') {
        const optionId = interaction.options.getString('option');
        const channel = interaction.options.getChannel('channel');
        const remove = interaction.options.getBoolean('remove') ?? false;

        const option = prompt.options.find(o => o.id === optionId);
        if (!option) {
          return interaction.editReply({
            embeds: [await errorEmbed(interaction.guild.id, 'Not Found',
              `${GLYPHS.ERROR} Option not found.`)]
          });
        }

        const updatedPrompts = mapPrompts((promptData, original) => {
          if (original.id === questionId) {
            const opt = promptData.options.find(o => o.id === optionId);
            if (opt) {
              if (!opt.channels) opt.channels = [];
              if (remove) {
                opt.channels = opt.channels.filter(id => id !== channel.id);
              } else {
                if (!opt.channels.includes(channel.id)) {
                  opt.channels.push(channel.id);
                }
              }
            }
          }
          return promptData;
        });

        await updateOnboarding({ prompts: updatedPrompts });

        return interaction.editReply({
          embeds: [await successEmbed(interaction.guild.id, remove ? 'Channel Removed' : 'Channel Added',
            `${GLYPHS.SUCCESS} ${remove ? 'Removed' : 'Added'} ${channel} ${remove ? 'from' : 'to'} option **"${option.title}"**.`)]
        });
      }
    }

  } catch (error) {
    if (error instanceof OnboardingEditError) {
      return interaction.editReply({
        embeds: [await errorEmbed(interaction.guild.id, 'Change Not Applied', `${GLYPHS.ERROR} ${error.message}`)]
      });
    }

    console.error('Onboarding command error:', error);

    if (error.code === 50001) {
      return interaction.editReply({
        embeds: [await errorEmbed(interaction.guild.id, 'Missing Access',
          `${GLYPHS.ERROR} I don't have permission to manage onboarding.`)]
      });
    }

    if (error.code === 30029) {
      return interaction.editReply({
        embeds: [await errorEmbed(interaction.guild.id, 'Community Required',
          `${GLYPHS.ERROR} Onboarding requires a **Community Server**.\n\nEnable Community in Server Settings.`)]
      });
    }

    return interaction.editReply({
      embeds: [await errorEmbed(interaction.guild.id, 'Error',
        `${GLYPHS.ERROR} An error occurred: ${error.message}`)]
    });
  }
}