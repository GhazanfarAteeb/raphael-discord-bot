import { Events, Collection, PermissionFlagsBits, MessageFlags, GuildOnboardingPromptType, ApplicationCommandOptionType } from 'discord.js';
import logger from '../../utils/logger.js';
import Guild from '../../models/Guild.js';
import { hasModPerms, isServerAdmin, normalizeAntiNukeAction } from '../../utils/helpers.js';

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
        content: '❌ Commands can only be used in servers, not in DMs.',
        flags: MessageFlags.Ephemeral
      }).catch(() => { });
    }

    // Check if slash commands are enabled for this guild
    const guildConfig = await Guild.getGuild(interaction.guild.id, interaction.guild.name);

    // Check if command is disabled
    if (guildConfig.slashCommands?.disabledCommands?.includes(interaction.commandName)) {
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
      const collectOptions = (options) => {
        for (const option of options) {
          switch (option.type) {
            case ApplicationCommandOptionType.SubcommandGroup:
            case ApplicationCommandOptionType.Subcommand:
              args.push(option.name);
              collectOptions(option.options ?? []);
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
            default:
              if (option.value !== undefined) args.push(String(option.value));
          }
        }
      };
      collectOptions(interaction.options.data);

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

      const errorMessage = '**Alert:** An anomaly occurred while executing this skill, Master. Please try again.';

      // Replace the deferred "thinking" placeholder rather than leaving it hanging
      if (interaction.replied || interaction.deferred) {
        await interaction.editReply({ content: errorMessage, embeds: [], components: [] }).catch(() => {});
      } else {
        await interaction.reply({ content: errorMessage, flags: MessageFlags.Ephemeral }).catch(() => {});
      }
    }
  },
};

// Handle special slash commands that need custom implementations
async function handleSpecialCommand(interaction, client, guildConfig, hasAdminRole, hasModRole) {
  const { successEmbed, errorEmbed, infoEmbed, GLYPHS } = await import('../../utils/embeds.js');

  // Commands that only require ManageGuild permission (or mod role)
  const manageGuildCommands = ['feature'];

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
  } else if (manageGuildCommands.includes(interaction.commandName)) {
    // For manage guild commands, check ManageGuild permission
    if (!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild) && !hasAdminRole && !hasModRole) {
      return interaction.reply({
        content: '**Error:** Manage Server permissions required for this function, Master.',
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

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  try {
    switch (interaction.commandName) {
      case 'automod':
        await handleAutomodCommand(interaction, guildConfig);
        break;
      case 'lockdown':
        await handleLockdownCommand(interaction, guildConfig);
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
        await handleRefreshCacheCommand(interaction, client, guildConfig);
        break;
      case 'birthdaysettings':
        await handleBirthdaySettingsCommand(interaction, guildConfig);
        break;
      case 'setbirthday':
        await handleSetBirthdayCommand(interaction, client, guildConfig);
        break;
      case 'config':
        await handleConfigCommand(interaction, guildConfig);
        break;
      case 'setup':
        await handleSetupCommand(interaction, client, guildConfig);
        break;
      case 'welcome':
        await handleWelcomeCommand(interaction, guildConfig);
        break;
      case 'manageshop':
        await handleManageshopCommand(interaction, guildConfig);
        break;
      case 'verify':
        await handleVerifyCommand(interaction, client, guildConfig);
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
        await handleGiveawayCommand(interaction, client, guildConfig);
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
      case 'setprofile':
        await handleSetprofileCommand(interaction);
        break;
      case 'confession':
        await handleConfessionCommand(interaction, client, guildConfig);
        break;
      case 'onboarding':
        await handleOnboardingCommand(interaction, guildConfig);
        break;
    }
  } catch (error) {
    console.error(`Error handling ${interaction.commandName}:`, error);
    await interaction.editReply({
      content: '**Error:** Command execution failure detected, Master.',
    });
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

    case 'status':
      const autoMod = guildConfig.features.autoMod;
      // Helper to safely check if a feature is enabled (handles boolean or object)
      const isEnabled = (feature) => {
        if (typeof feature === 'boolean') return feature;
        return feature?.enabled ?? false;
      };
      const getSpamLimit = () => typeof autoMod.antiSpam === 'object' ? autoMod.antiSpam.messageLimit : 5;
      const getSpamWindow = () => typeof autoMod.antiSpam === 'object' ? autoMod.antiSpam.timeWindow : 5;

      const statusEmbed = await infoEmbed(interaction.guild.id, '『 AutoMod Status 』',
        `**▸ Overall:** ${autoMod.enabled ? '◉ Active' : '○ Inactive'}\n\n` +
        `**Features:**\n` +
        `${GLYPHS.DOT} Anti-Spam: ${isEnabled(autoMod.antiSpam) ? '◉' : '○'} (${getSpamLimit()} msgs/${getSpamWindow()}s)\n` +
        `${GLYPHS.DOT} Anti-Raid: ${isEnabled(autoMod.antiRaid) ? '◉' : '○'} (${autoMod.antiRaid?.joinThreshold || 10} joins/${autoMod.antiRaid?.timeWindow || 30}s)\n` +
        `${GLYPHS.DOT} Anti-Nuke: ${isEnabled(autoMod.antiNuke) ? '◉' : '○'}\n` +
        `${GLYPHS.DOT} Anti-Invites: ${isEnabled(autoMod.antiInvites) ? '◉' : '○'}\n` +
        `${GLYPHS.DOT} Anti-Links: ${isEnabled(autoMod.antiLinks) ? '◉' : '○'}\n` +
        `${GLYPHS.DOT} Bad Words: ${isEnabled(autoMod.badWords) ? '◉' : '○'} (${autoMod.badWords?.words?.length || 0} words)\n` +
        `${GLYPHS.DOT} Mass Mention: ${isEnabled(autoMod.antiMassMention) ? '◉' : '○'} (limit: ${autoMod.antiMassMention?.limit || 5})`
      );
      await interaction.editReply({ embeds: [statusEmbed] });
      break;

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

async function handleLockdownCommand(interaction, guildConfig) {
  const { successEmbed, infoEmbed, GLYPHS } = await import('../../utils/embeds.js');
  const { ChannelType } = await import('discord.js');

  const action = interaction.options.getString('action');
  const reason = interaction.options.getString('reason') || 'No reason provided';

  if (action === 'on') {
    // Enable lockdown
    await Guild.updateGuild(interaction.guild.id, {
      $set: {
        'security.lockdownActive': true,
        'security.lockdownReason': reason,
        'security.lockdownBy': interaction.user.id,
        'security.lockdownAt': new Date()
      }
    });

    // Lock all text channels
    const textChannels = interaction.guild.channels.cache.filter(
      c => c.type === ChannelType.GuildText
    );

    let lockedCount = 0;
    for (const [, channel] of textChannels) {
      try {
        await channel.permissionOverwrites.edit(interaction.guild.id, {
          SendMessages: false
        }, { reason: `[Lockdown] ${reason}` });
        lockedCount++;
      } catch (error) {
        // Channel might not be editable
      }
    }

    await interaction.editReply({
      embeds: [await successEmbed(interaction.guild.id, '🔒 Server Lockdown Enabled',
        `${GLYPHS.SUCCESS} Locked ${lockedCount} channels.\n\n` +
        `**Reason:** ${reason}\n` +
        `**By:** ${interaction.user.tag}\n\n` +
        `Use \`/lockdown off\` to unlock the server.`)]
    });

    // Announce in alert channel
    if (guildConfig.channels.alertLog) {
      const alertChannel = interaction.guild.channels.cache.get(guildConfig.channels.alertLog);
      if (alertChannel) {
        await alertChannel.send({
          embeds: [await infoEmbed(interaction.guild.id, '🔒 SERVER LOCKDOWN',
            `**Activated By:** ${interaction.user.tag}\n` +
            `**Reason:** ${reason}\n` +
            `**Channels Locked:** ${lockedCount}`)]
        });
      }
    }

  } else {
    // Disable lockdown
    await Guild.updateGuild(interaction.guild.id, {
      $set: { 'security.lockdownActive': false }
    });

    // Unlock all text channels
    const textChannels = interaction.guild.channels.cache.filter(
      c => c.type === ChannelType.GuildText
    );

    let unlockedCount = 0;
    for (const [, channel] of textChannels) {
      try {
        await channel.permissionOverwrites.edit(interaction.guild.id, {
          SendMessages: null
        }, { reason: 'Lockdown ended' });
        unlockedCount++;
      } catch (error) {
        // Channel might not be editable
      }
    }

    await interaction.editReply({
      embeds: [await successEmbed(interaction.guild.id, '🔓 Server Lockdown Disabled',
        `${GLYPHS.SUCCESS} Unlocked ${unlockedCount} channels.\n\n` +
        `Server is now back to normal operation.`)]
    });
  }
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
  const { successEmbed, infoEmbed, GLYPHS } = await import('../../utils/embeds.js');

  const subcommand = interaction.options.getSubcommand();

  // Get current slashCommands config or initialize
  const slashCommandsConfig = guildConfig.slashCommands || { enabled: true, disabledCommands: [] };

  switch (subcommand) {
    case 'enable':
      const enableCmd = interaction.options.getString('command').toLowerCase();
      const enabledList = (slashCommandsConfig.disabledCommands || []).filter(c => c !== enableCmd);
      await Guild.updateGuild(interaction.guild.id, { $set: { 'slashCommands.disabledCommands': enabledList } });

      await interaction.editReply({
        embeds: [await successEmbed(interaction.guild.id, 'Command Enabled',
          `${GLYPHS.SUCCESS} Slash command \`/${enableCmd}\` is now enabled.`)]
      });
      break;

    case 'disable':
      const disableCmd = interaction.options.getString('command').toLowerCase();
      const disabledList = slashCommandsConfig.disabledCommands || [];
      if (!disabledList.includes(disableCmd)) {
        disabledList.push(disableCmd);
      }
      await Guild.updateGuild(interaction.guild.id, { $set: { 'slashCommands.disabledCommands': disabledList } });

      await interaction.editReply({
        embeds: [await successEmbed(interaction.guild.id, 'Command Disabled',
          `${GLYPHS.SUCCESS} Slash command \`/${disableCmd}\` is now disabled.`)]
      });
      break;

    case 'list':
      const { getSlashCommands } = await import('../../utils/slashCommands.js');
      const allCommands = getSlashCommands();
      const disabled = slashCommandsConfig.disabledCommands || [];

      const commandList = allCommands.map(cmd => {
        const name = cmd.name;
        const isDisabled = disabled.includes(name);
        return `${isDisabled ? '◎' : '◉'} \`/${name}\``;
      }).join('\n');

      await interaction.editReply({
        embeds: [await infoEmbed(interaction.guild.id, '『 Slash Commands 』',
          `**▸ Status:** ${slashCommandsConfig.enabled ? '◉ Active' : '◎ Inactive'}\n\n` +
          `**Commands:**\n${commandList}`)]
      });
      break;
  }
}

async function handleRefreshCacheCommand(interaction, client, guildConfig) {
  const { successEmbed, infoEmbed, GLYPHS } = await import('../../utils/embeds.js');
  const Guild = (await import('../../models/Guild.js')).default;

  const cacheType = interaction.options.getString('type') || 'all';
  const guild = interaction.guild;
  const refreshed = [];

  try {
    // Refresh Guild Settings from database
    if (cacheType === 'all' || cacheType === 'guild') {
      // Clear mongoose cache and re-fetch
      const freshGuildConfig = await Guild.findOne({ guildId: guild.id });
      if (freshGuildConfig) {
        // Force update the cached version
        Object.assign(guildConfig, freshGuildConfig.toObject());
      }
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
        refreshed.push('◎ Invites (no permission)');
      }
    }

    const embed = await successEmbed(interaction.guild.id, '『 Cache Refreshed 』',
      `**Confirmed:** Cache refresh complete for **${guild.name}**, Master.\n\n` +
      `**Refreshed:**\n${refreshed.join('\n')}\n\n` +
      `**Refreshed at:** <t:${Math.floor(Date.now() / 1000)}:F>`
    );

    await interaction.editReply({ embeds: [embed] });

  } catch (error) {
    console.error('Error refreshing cache:', error);
    const { errorEmbed } = await import('../../utils/embeds.js');
    await interaction.editReply({
      embeds: [await errorEmbed(interaction.guild.id, `Failed to refresh cache: ${error.message}`)]
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
        embeds: [await successEmbed(interaction.guild.id, '🎂 Birthday Channel Set',
          `${GLYPHS.SUCCESS} Birthday announcements will be sent to ${channel}`)]
      });
      break;
    }

    case 'role': {
      const role = interaction.options.getRole('role');
      await Guild.updateGuild(interaction.guild.id, { $set: { 'features.birthdaySystem.role': role.id } });
      await interaction.editReply({
        embeds: [await successEmbed(interaction.guild.id, '🎂 Birthday Role Set',
          `${GLYPHS.SUCCESS} Birthday role set to ${role}\n\nThis role will be assigned to users on their birthday.`)]
      });
      break;
    }

    case 'message': {
      const message = interaction.options.getString('message');
      await Guild.updateGuild(interaction.guild.id, { $set: { 'features.birthdaySystem.message': message } });
      await interaction.editReply({
        embeds: [await successEmbed(interaction.guild.id, '🎂 Birthday Message Set',
          `${GLYPHS.SUCCESS} Custom birthday message set!\n\n**Preview:**\n${message.replace('{user}', interaction.user.toString()).replace('{username}', interaction.user.username).replace('{age}', '25')}`)]
      });
      break;
    }

    case 'enable': {
      await Guild.updateGuild(interaction.guild.id, { $set: { 'features.birthdaySystem.enabled': true } });
      await interaction.editReply({
        embeds: [await successEmbed(interaction.guild.id, '🎂 Birthday System Enabled',
          `${GLYPHS.SUCCESS} Birthday celebrations are now enabled!`)]
      });
      break;
    }

    case 'disable': {
      await Guild.updateGuild(interaction.guild.id, { $set: { 'features.birthdaySystem.enabled': false } });
      await interaction.editReply({
        embeds: [await successEmbed(interaction.guild.id, '🎂 Birthday System Disabled',
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
        embeds: [await infoEmbed(interaction.guild.id, '『 Birthday Settings 』',
          `**▸ Status:** ${bs.enabled ? '◉ Active' : '◎ Inactive'}\n` +
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

// Set Birthday Handler (Admin)
async function handleSetBirthdayCommand(interaction, client, guildConfig) {
  const { successEmbed, errorEmbed, GLYPHS } = await import('../../utils/embeds.js');
  const Birthday = (await import('../../models/Birthday.js')).default;

  const user = interaction.options.getUser('user');
  const month = interaction.options.getInteger('month');
  const day = interaction.options.getInteger('day');
  const year = interaction.options.getInteger('year');
  const isPrivate = interaction.options.getBoolean('private') || false;

  // Validate date
  const testDate = new Date(year || 2000, month - 1, day);
  if (testDate.getMonth() !== month - 1 || testDate.getDate() !== day) {
    return interaction.editReply({
      embeds: [await errorEmbed(interaction.guild.id, 'Invalid Date',
        '**Error:** This date does not exist. Please verify the month and day, Master.')]
    });
  }

  try {
    // Find or create birthday
    let birthday = await Birthday.findOne({ guildId: interaction.guild.id, userId: user.id });

    if (birthday) {
      birthday.birthday = { month, day, year };
      birthday.username = user.username;
      birthday.showAge = !isPrivate;
    } else {
      birthday = new Birthday({
        guildId: interaction.guild.id,
        userId: user.id,
        username: user.username,
        birthday: { month, day, year },
        showAge: !isPrivate
      });
    }

    await birthday.save();

    // Assign birthday role if configured
    const birthdayRole = guildConfig.features.birthdaySystem.role;
    const member = await interaction.guild.members.fetch(user.id).catch(() => null);

    if (birthdayRole && member) {
      const role = interaction.guild.roles.cache.get(birthdayRole);
      if (role && !member.roles.cache.has(birthdayRole)) {
        await member.roles.add(role, 'Birthday set by admin').catch(() => { });
      }
    }

    // Send announcement in birthday channel
    const birthdayChannel = guildConfig.features.birthdaySystem.channel || guildConfig.channels.birthdayChannel;
    if (birthdayChannel) {
      const channel = interaction.guild.channels.cache.get(birthdayChannel);
      if (channel) {
        const dateStr = `${month}/${day}${year ? `/${year}` : ''}`;
        const announceEmbed = await successEmbed(interaction.guild.id, '『 Birthday Registered 』',
          `**${user}**'s birthday has been registered as **${dateStr}**, Master.\n\n` +
          `**Notice:** A special celebration will be conducted on their birthday.`
        );
        await channel.send({ embeds: [announceEmbed] }).catch(() => { });
      }
    }

    // Success message
    const dateStr = `${month}/${day}${year ? `/${year}` : ''}`;
    let description = `${GLYPHS.SUCCESS} Birthday for **${user.tag}** set to **${dateStr}**, Master.`;

    if (isPrivate) {
      description += '\n**Notice:** Age will remain concealed in announcements.';
    }

    if (year) {
      const age = birthday.getAge ? birthday.getAge() : null;
      if (age !== null) {
        description += `\n🎂 They'll turn ${age + 1} on their next birthday!`;
      }
    }

    if (birthdayRole) {
      description += `\n🎀 Birthday role assigned`;
    }

    if (birthdayChannel) {
      description += `\n📢 Announcement sent to <#${birthdayChannel}>`;
    }

    await interaction.editReply({
      embeds: [await successEmbed(interaction.guild.id, '🎂 Birthday Set!', description)]
    });

  } catch (error) {
    console.error('Error setting birthday:', error);
    await interaction.editReply({
      embeds: [await errorEmbed(interaction.guild.id, 'Error',
        'Failed to set birthday. Please try again.')]
    });
  }
}

// Config Handler
async function handleConfigCommand(interaction, guildConfig) {
  const { successEmbed, errorEmbed, infoEmbed, GLYPHS } = await import('../../utils/embeds.js');
  const subcommand = interaction.options.getSubcommand();

  switch (subcommand) {
    case 'view': {
      const config = guildConfig;
      const embed = await infoEmbed(interaction.guild.id, '『 Server Configuration 』',
        `**▸ Prefix:** \`${config.prefix}\`\n\n` +
        `**Channels:**\n` +
        `◇ Mod Log: ${config.channels.modLog ? `<#${config.channels.modLog}>` : 'Not configured'}\n` +
        `◇ Alert Log: ${config.channels.alertLog ? `<#${config.channels.alertLog}>` : 'Not configured'}\n` +
        `◇ Join Log: ${config.channels.joinLog ? `<#${config.channels.joinLog}>` : 'Not configured'}\n` +
        `◇ Birthday: ${config.channels.birthdayChannel ? `<#${config.channels.birthdayChannel}>` : 'Not configured'}\n` +
        `◇ Welcome: ${config.channels.welcomeChannel ? `<#${config.channels.welcomeChannel}>` : 'Not configured'}\n\n` +
        `**Features:**\n` +
        `◇ AutoMod: ${config.features.autoMod?.enabled ? '◉ Active' : '◎ Inactive'}\n` +
        `◇ Birthdays: ${config.features.birthdaySystem?.enabled ? '◉ Active' : '◎ Inactive'}\n` +
        `◇ Levels: ${config.features.levelSystem?.enabled ? '◉ Active' : '◎ Inactive'}\n` +
        `◇ Welcome: ${config.features.welcomeSystem?.enabled ? '◉ Active' : '◎ Inactive'}`
      );
      await interaction.editReply({ embeds: [embed] });
      break;
    }

    case 'prefix': {
      const newPrefix = interaction.options.getString('prefix');
      if (newPrefix.length > 5) {
        return interaction.editReply({
          embeds: [await errorEmbed(interaction.guild.id, 'Prefix too long (max 5 characters)')]
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

// Setup Handler
async function handleSetupCommand(interaction, client, guildConfig) {
  const { successEmbed, errorEmbed, infoEmbed, GLYPHS } = await import('../../utils/embeds.js');
  const { ChannelType } = await import('discord.js');

  // Import the setup command and run it
  try {
    const setupModule = await import('../../commands/config/setup.js');
    const setupCommand = setupModule.default;

    // Create a fake message object for the setup command
    const fakeMessage = {
      guild: interaction.guild,
      member: interaction.member,
      author: interaction.user,
      reply: async (options) => interaction.editReply(options),
      channel: interaction.channel
    };

    await setupCommand.execute(fakeMessage);
  } catch (error) {
    console.error('Setup command error:', error);
    await interaction.editReply({
      embeds: [await errorEmbed(interaction.guild.id, 'Setup Failed',
        'An error occurred during setup. Please ensure I have Administrator permissions.')]
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
          `${GLYPHS.SUCCESS} Welcome message updated!\n\n**Preview:**\n${previewMsg}`)]
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

      await interaction.editReply({
        embeds: [await infoEmbed(interaction.guild.id, '『 Welcome System Status 』',
          `**▸ Status:** ${welcome.enabled ? '◉ Active' : '○ Inactive'}\n` +
          `**▸ Channel:** ${channel || 'Not configured'}\n` +
          `**▸ Embed Mode:** ${welcome.embedEnabled !== false ? '◉' : '○'}\n` +
          `**▸ DM Welcome:** ${welcome.dmWelcome ? '◉' : '○'}\n` +
          `**▸ Mention User:** ${welcome.mentionUser ? '◉' : '○'}\n` +
          `**▸ Timestamp:** ${welcome.showTimestamp !== false ? '◉' : '○'}\n` +
          `**▸ Auto Role:** ${autoRole || 'None'}\n\n` +
          `**▸ Color:** ${welcome.embedColor || 'Default'}\n` +
          `**▸ Title:** ${welcome.embedTitle ? 'Custom' : 'Decorative stars'}\n` +
          `**▸ Author:** ${welcome.authorType || 'username'}\n` +
          `**▸ Thumbnail:** ${welcome.thumbnailType || welcome.thumbnailUrl || 'None'}\n` +
          `**▸ Banner:** ${welcome.bannerUrl ? '◉ Set' : '○ Not set'}\n\n` +
          `**Current Message:**\n\`\`\`${welcome.message || 'Welcome {user} to {server}!'}\`\`\``)]
      });
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

// Handle manageshop slash command (Backgrounds only)
async function handleManageshopCommand(interaction, guildConfig) {
  const { successEmbed, errorEmbed, infoEmbed, GLYPHS } = await import('../../utils/embeds.js');
  const { formatNumber } = await import('../../utils/helpers.js');
  const { EmbedBuilder } = await import('discord.js');

  const subcommand = interaction.options.getSubcommand();
  const coinEmoji = guildConfig.economy?.coinEmoji || '💰';

  // Initialize if not exists
  if (!guildConfig.customShopItems) {
    guildConfig.customShopItems = [];
  }

  switch (subcommand) {
    case 'add': {
      const itemName = interaction.options.getString('name');
      const price = interaction.options.getInteger('price');
      const image = interaction.options.getString('image');
      const description = interaction.options.getString('description');

      // Generate unique ID
      const itemId = `custom_${Date.now().toString(36)}_${Math.random().toString(36).substr(2, 4)}`;

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

      const embed = new EmbedBuilder()
        .setColor('#667eea')
        .setTitle('✅ Background Added to Shop')
        .addFields(
          { name: '🖼️ Name', value: itemName, inline: true },
          { name: '💰 Price', value: `${formatNumber(price)} ${coinEmoji}`, inline: true },
          { name: '🆔 ID', value: `\`${itemId}\``, inline: true }
        )
        .setImage(image)
        .setFooter({ text: 'Background preview shown above' });

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
            `${GLYPHS.INFO} No custom backgrounds in the shop yet.\n\nUse \`/manageshop add\` to add backgrounds!`)]
        });
        return;
      }

      const embed = new EmbedBuilder()
        .setTitle('🖼️ Shop Backgrounds')
        .setColor(guildConfig.embedStyle?.color || '#667eea')
        .setFooter({ text: `Total: ${guildConfig.customShopItems.length} backgrounds` });

      guildConfig.customShopItems.slice(0, 10).forEach(item => {
        const stockText = item.stock === -1 ? '∞' : item.stock;
        embed.addFields({
          name: `🖼️ ${item.name}`,
          value: `**ID:** \`${item.id}\`\n**Price:** ${formatNumber(item.price)} ${coinEmoji}\n**Stock:** ${stockText}${item.image ? `\n**Image:** [Preview](${item.image})` : ''}`,
          inline: false
        });
      });

      if (guildConfig.customShopItems.length > 10) {
        embed.setDescription(`Showing 10 of ${guildConfig.customShopItems.length} backgrounds`);
      }

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
          `**Old Price:** ${formatNumber(oldPrice)} ${coinEmoji}\n` +
          `**New Price:** ${formatNumber(newPrice)} ${coinEmoji}`)]
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

      switch (field) {
        case 'name':
          item.name = value;
          break;
        case 'description':
          item.description = value;
          break;
        case 'image':
          item.image = value;
          break;
      }

      await Guild.updateGuild(interaction.guild.id, {
        $set: { [`customShopItems.$[elem].${field}`]: value }
      }, { arrayFilters: [{ 'elem.id': itemId }] });

      await interaction.editReply({
        embeds: [await successEmbed(interaction.guild.id, 'Background Updated',
          `${GLYPHS.SUCCESS} Updated **${item.name}**'s ${field} to: **${value}**`)]
      });
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

        if (!value.startsWith('http://') && !value.startsWith('https://')) {
          await interaction.editReply({
            embeds: [await errorEmbed(interaction.guild.id, 'Invalid URL',
              `${GLYPHS.ERROR} Please provide a valid image URL starting with http:// or https://`)]
          });
          return;
        }

        await Guild.updateGuild(interaction.guild.id, { $set: { 'economy.fallbackBackground.image': value } });

        const embed = new EmbedBuilder()
          .setColor('#00FF00')
          .setTitle('✅ Fallback Background Updated')
          .setDescription(`${GLYPHS.SUCCESS} Default background image set!`)
          .setImage(value);
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

        const embed = new EmbedBuilder()
          .setColor(value)
          .setTitle('✅ Fallback Color Updated')
          .setDescription(`${GLYPHS.SUCCESS} Default background color set to: **${value}**`);
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
async function handleVerifyCommand(interaction, client, guildConfig) {
  const { successEmbed, errorEmbed, infoEmbed, GLYPHS } = await import('../../utils/embeds.js');
  const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = await import('discord.js');
  const subcommand = interaction.options.getSubcommand();

  switch (subcommand) {
    case 'setup': {
      const embed = new EmbedBuilder()
        .setColor('#5865F2')
        .setTitle('🔐 Verification Setup')
        .setDescription('To complete setup via slash command, use these subcommands:\n\n' +
          '`/verify setrole @role` - Set the verified role\n' +
          '`/verify setunverifiedrole @role` - Set the role to remove on verification\n' +
          '`/verify setchannel #channel` - Set the verification channel\n' +
          '`/verify enable` - Enable the system\n' +
          '`/verify panel` - Send the verification panel');
      await interaction.editReply({ embeds: [embed] });
      break;
    }

    case 'panel': {
      const channel = interaction.options.getChannel('channel') || interaction.channel;

      if (!guildConfig.features?.verificationSystem?.role) {
        await interaction.editReply({
          embeds: [await errorEmbed(interaction.guild.id, 'Setup Required',
            `${GLYPHS.ERROR} Please set a verified role first with \`/verify setrole @role\``)]
        });
        return;
      }

      const verificationType = guildConfig.features?.verificationSystem?.type || 'button';

      const panelEmbed = new EmbedBuilder()
        .setColor('#5865F2')
        .setTitle('🔐 Server Verification')
        .setDescription(
          verificationType === 'captcha'
            ? 'Click the button below to start captcha verification and gain access to the server!'
            : 'Click the button below to verify yourself and gain access to the server!'
        )
        .setFooter({ text: 'This helps us prevent bots and raiders.' });

      const row = new ActionRowBuilder()
        .addComponents(
          new ButtonBuilder()
            .setCustomId(verificationType === 'captcha' ? 'verify_captcha' : 'verify_button')
            .setLabel(verificationType === 'captcha' ? '🔐 Verify (Captcha)' : '✅ Verify')
            .setStyle(ButtonStyle.Success)
        );

      await channel.send({ embeds: [panelEmbed], components: [row] });
      await interaction.editReply({
        embeds: [await successEmbed(interaction.guild.id, 'Verification Panel Sent',
          `${GLYPHS.SUCCESS} Verification panel has been sent to ${channel}`)]
      });
      break;
    }

    case 'manual': {
      const user = interaction.options.getUser('user');
      const member = await interaction.guild.members.fetch(user.id).catch(() => null);

      if (!member) {
        await interaction.editReply({
          embeds: [await errorEmbed(interaction.guild.id, 'User Not Found',
            `${GLYPHS.ERROR} Could not find that user in this server.`)]
        });
        return;
      }

      const verifiedRoleId = guildConfig.features?.verificationSystem?.role || guildConfig.roles?.verifiedRole;
      if (!verifiedRoleId) {
        await interaction.editReply({
          embeds: [await errorEmbed(interaction.guild.id, 'No Verified Role',
            `${GLYPHS.ERROR} No verified role is configured. Use \`/verify setrole @role\``)]
        });
        return;
      }

      await member.roles.add(verifiedRoleId);

      // Remove unverified role if configured
      const unverifiedRoleId = guildConfig.features?.verificationSystem?.unverifiedRole;
      if (unverifiedRoleId && member.roles.cache.has(unverifiedRoleId)) {
        await member.roles.remove(unverifiedRoleId).catch(() => { });
      }

      await interaction.editReply({
        embeds: [await successEmbed(interaction.guild.id, 'User Verified',
          `${GLYPHS.SUCCESS} ${user} has been manually verified.`)]
      });
      break;
    }

    case 'status': {
      const vs = guildConfig.features?.verificationSystem || {};
      const statusEmbed = await infoEmbed(interaction.guild.id, '🔐 Verification Status',
        `**Enabled:** ${vs.enabled ? '✅ Yes' : '❌ No'}\n` +
        `**Type:** ${vs.type || 'button'}\n` +
        `**Verified Role:** ${vs.role ? `<@&${vs.role}>` : 'Not set'}\n` +
        `**Unverified Role:** ${vs.unverifiedRole ? `<@&${vs.unverifiedRole}>` : 'Not set'}\n` +
        `**Channel:** ${vs.channel ? `<#${vs.channel}>` : 'Not set'}`);
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
          `${GLYPHS.SUCCESS} Verification type set to **${type}**\n\n${typeDescriptions[type]}\n\n⚠️ **Note:** You need to re-send the verification panel with \`/verify panel\` for changes to take effect.`)]
      });
      break;
    }
  }
}

// Handle cmdchannels command
async function handleCmdchannelsCommand(interaction, guildConfig) {
  const { successEmbed, errorEmbed, infoEmbed, GLYPHS } = await import('../../utils/embeds.js');
  const { EmbedBuilder } = await import('discord.js');
  const subcommand = interaction.options.getSubcommand();

  // Initialize if not exists
  const cmdChannels = guildConfig.commandChannels || { enabled: false, channels: [], bypassRoles: [] };

  switch (subcommand) {
    case 'enable': {
      if (cmdChannels.channels.length === 0) {
        await interaction.editReply({
          embeds: [await errorEmbed(interaction.guild.id, 'No Channels Added',
            `${GLYPHS.ERROR} Please add at least one channel first with \`/cmdchannels add\``)]
        });
        return;
      }
      await Guild.updateGuild(interaction.guild.id, { $set: { 'commandChannels.enabled': true } });
      await interaction.editReply({
        embeds: [await successEmbed(interaction.guild.id, 'Channel Restrictions Enabled',
          `${GLYPHS.SUCCESS} Bot commands will now only work in allowed channels.`)]
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
      await Guild.updateGuild(interaction.guild.id, { $push: { 'commandChannels.channels': channel.id } });
      await interaction.editReply({
        embeds: [await successEmbed(interaction.guild.id, 'Channel Added',
          `${GLYPHS.SUCCESS} ${channel} has been added to allowed channels.`)]
      });
      break;
    }

    case 'remove': {
      const channel = interaction.options.getChannel('channel');
      if (!cmdChannels.channels.includes(channel.id)) {
        await interaction.editReply({
          embeds: [await errorEmbed(interaction.guild.id, 'Not Found',
            `${GLYPHS.ERROR} ${channel} is not in the allowed channels list.`)]
        });
        return;
      }
      await Guild.updateGuild(interaction.guild.id, { $pull: { 'commandChannels.channels': channel.id } });
      await interaction.editReply({
        embeds: [await successEmbed(interaction.guild.id, 'Channel Removed',
          `${GLYPHS.SUCCESS} ${channel} has been removed from allowed channels.`)]
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

      const embed = new EmbedBuilder()
        .setTitle('📢 Command Channel Settings')
        .setColor(guildConfig.embedStyle?.color || '#5865F2')
        .addFields(
          { name: '📊 Status', value: cmdChannels.enabled ? '✅ Enabled' : '❌ Disabled', inline: true },
          { name: '💬 Allowed Channels', value: channelsList, inline: false },
          { name: '👑 Bypass Roles', value: bypassList, inline: false }
        );
      await interaction.editReply({ embeds: [embed] });
      break;
    }
  }
}

// Handle logs command
async function handleLogsCommand(interaction, guildConfig) {
  const { successEmbed, infoEmbed, GLYPHS } = await import('../../utils/embeds.js');
  const { EmbedBuilder } = await import('discord.js');
  const subcommand = interaction.options.getSubcommand();

  const logTypes = {
    message: 'logging.messages',
    member: 'logging.members',
    voice: 'logging.voice',
    moderation: 'logging.moderation',
    server: 'logging.server'
  };

  const channelTypes = {
    message: 'channels.messageLog',
    member: 'channels.joinLog',
    voice: 'channels.voiceLog',
    moderation: 'channels.modLog',
    server: 'channels.serverLog'
  };

  switch (subcommand) {
    case 'enable': {
      const type = interaction.options.getString('type');
      if (type === 'all') {
        await Guild.updateGuild(interaction.guild.id, {
          $set: {
            'logging.messages': true,
            'logging.members': true,
            'logging.voice': true,
            'logging.moderation': true,
            'logging.server': true
          }
        });
        await interaction.editReply({
          embeds: [await successEmbed(interaction.guild.id, 'All Logs Enabled',
            `${GLYPHS.SUCCESS} All logging types have been enabled.`)]
        });
      } else {
        await Guild.updateGuild(interaction.guild.id, { $set: { [logTypes[type]]: true } });
        await interaction.editReply({
          embeds: [await successEmbed(interaction.guild.id, 'Logging Enabled',
            `${GLYPHS.SUCCESS} ${type.charAt(0).toUpperCase() + type.slice(1)} logging is now enabled.`)]
        });
      }
      break;
    }

    case 'disable': {
      const type = interaction.options.getString('type');
      if (type === 'all') {
        await Guild.updateGuild(interaction.guild.id, {
          $set: {
            'logging.messages': false,
            'logging.members': false,
            'logging.voice': false,
            'logging.moderation': false,
            'logging.server': false
          }
        });
        await interaction.editReply({
          embeds: [await successEmbed(interaction.guild.id, 'All Logs Disabled',
            `${GLYPHS.SUCCESS} All logging types have been disabled.`)]
        });
      } else {
        await Guild.updateGuild(interaction.guild.id, { $set: { [logTypes[type]]: false } });
        await interaction.editReply({
          embeds: [await successEmbed(interaction.guild.id, 'Logging Disabled',
            `${GLYPHS.SUCCESS} ${type.charAt(0).toUpperCase() + type.slice(1)} logging is now disabled.`)]
        });
      }
      break;
    }

    case 'channel': {
      const type = interaction.options.getString('type');
      const channel = interaction.options.getChannel('channel');
      await Guild.updateGuild(interaction.guild.id, { $set: { [channelTypes[type]]: channel.id } });
      await interaction.editReply({
        embeds: [await successEmbed(interaction.guild.id, 'Log Channel Set',
          `${GLYPHS.SUCCESS} ${type.charAt(0).toUpperCase() + type.slice(1)} logs will be sent to ${channel}`)]
      });
      break;
    }

    case 'status': {
      const logging = guildConfig.logging || {};
      const channels = guildConfig.channels || {};

      const statusEmbed = new EmbedBuilder()
        .setTitle('📋 Logging Status')
        .setColor(guildConfig.embedStyle?.color || '#5865F2')
        .addFields(
          { name: '📝 Message Logs', value: `${logging.messages ? '✅' : '❌'} ${channels.messageLog ? `<#${channels.messageLog}>` : 'No channel'}`, inline: true },
          { name: '👥 Member Logs', value: `${logging.members ? '✅' : '❌'} ${channels.joinLog ? `<#${channels.joinLog}>` : 'No channel'}`, inline: true },
          { name: '🔊 Voice Logs', value: `${logging.voice ? '✅' : '❌'} ${channels.voiceLog ? `<#${channels.voiceLog}>` : 'No channel'}`, inline: true },
          { name: '🔨 Moderation Logs', value: `${logging.moderation ? '✅' : '❌'} ${channels.modLog ? `<#${channels.modLog}>` : 'No channel'}`, inline: true },
          { name: '⚙️ Server Logs', value: `${logging.server ? '✅' : '❌'} ${channels.serverLog ? `<#${channels.serverLog}>` : 'No channel'}`, inline: true }
        );
      await interaction.editReply({ embeds: [statusEmbed] });
      break;
    }
  }
}

// Handle autorole command
async function handleAutoroleCommand(interaction, guildConfig) {
  const { successEmbed, errorEmbed, infoEmbed, GLYPHS } = await import('../../utils/embeds.js');
  const { EmbedBuilder } = await import('discord.js');
  const subcommand = interaction.options.getSubcommand();

  const autoroles = guildConfig.autorole || { enabled: true, roles: [], humanRoles: [], botRoles: [] };

  switch (subcommand) {
    case 'add': {
      const role = interaction.options.getRole('role');
      const type = interaction.options.getString('type') || 'all';

      // Prevent adding color roles to autorole
      if (role.name.startsWith('🎨 ')) {
        await interaction.editReply({
          embeds: [await errorEmbed(interaction.guild.id, 'Color Role Detected',
            `${GLYPHS.ERROR} ${role} is a color role and should not be added to auto-roles!\n\n` +
            `Color roles are meant to be selected by members via the color roles panel, not assigned automatically.`)]
        });
        return;
      }

      let targetArray;
      let displayType;
      if (type === 'humans') {
        targetArray = 'autorole.humanRoles';
        displayType = 'humans only';
      } else if (type === 'bots') {
        targetArray = 'autorole.botRoles';
        displayType = 'bots only';
      } else {
        targetArray = 'autorole.roles';
        displayType = 'all members';
      }

      await Guild.updateGuild(interaction.guild.id, {
        $addToSet: { [targetArray]: role.id },
        $set: { 'autorole.enabled': true }
      });

      await interaction.editReply({
        embeds: [await successEmbed(interaction.guild.id, 'Auto-Role Added',
          `${GLYPHS.SUCCESS} ${role} will be given to ${displayType} when they join.`)]
      });
      break;
    }

    case 'remove': {
      const role = interaction.options.getRole('role');
      await Guild.updateGuild(interaction.guild.id, {
        $pull: {
          'autorole.roles': role.id,
          'autorole.humanRoles': role.id,
          'autorole.botRoles': role.id
        }
      });
      await interaction.editReply({
        embeds: [await successEmbed(interaction.guild.id, 'Auto-Role Removed',
          `${GLYPHS.SUCCESS} ${role} has been removed from auto-roles.`)]
      });
      break;
    }

    case 'list': {
      const allRoles = (autoroles.roles || []).map(id => `<@&${id}> (all)`);
      const humanRoles = (autoroles.humanRoles || []).map(id => `<@&${id}> (humans)`);
      const botRoles = (autoroles.botRoles || []).map(id => `<@&${id}> (bots)`);
      const combined = [...allRoles, ...humanRoles, ...botRoles];

      const embed = new EmbedBuilder()
        .setTitle('🎭 Auto-Roles')
        .setColor(guildConfig.embedStyle?.color || '#5865F2')
        .setDescription(combined.length > 0 ? combined.join('\n') : '*No auto-roles configured*')
        .setFooter({ text: `Status: ${autoroles.enabled ? 'Enabled' : 'Disabled'}` });

      await interaction.editReply({ embeds: [embed] });
      break;
    }

    case 'clear': {
      await Guild.updateGuild(interaction.guild.id, {
        $set: {
          'autorole.roles': [],
          'autorole.humanRoles': [],
          'autorole.botRoles': []
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

// Feature management slash command handler
async function handleFeatureCommand(interaction, client, guildConfig) {
  const { successEmbed, errorEmbed, infoEmbed, GLYPHS } = await import('../../utils/embeds.js');
  const { EmbedBuilder } = await import('discord.js');

  const guildId = interaction.guild.id;
  const featureType = interaction.options.getString('type');
  const status = interaction.options.getString('status');
  const customCommand = interaction.options.getString('command')?.toLowerCase();

  // Define feature categories and their associated commands
  const featureCategories = {
    economy: ['balance', 'daily', 'shop', 'inventory', 'profile', 'setprofile', 'setbackground', 'claim', 'addcoins', 'rep'],
    gambling: ['slots', 'blackjack', 'coinflip', 'dice', 'roulette', 'adventure'],
    leveling: ['level', 'rank', 'top', 'leaderboard', 'xp'],
    games: ['trivia', 'tictactoe'],
    fun: ['meme', 'gif', 'poll'],
    birthdays: ['birthday', 'setbirthday', 'mybirthday', 'birthdays', 'requestbirthday', 'approvebday', 'rejectbday', 'cancelbirthday', 'removebirthday', 'birthdaypreference', 'birthdayrequests'],
    giveaways: ['giveaway', 'gstart', 'gend', 'greroll'],
    events: ['createevent', 'events', 'joinevent', 'cancelevent'],
    starboard: ['starboard'],
    tickets: ['ticket', 'ticketpanel'],
    afk: ['afk'],
    reminders: ['remind', 'reminder'],
    automod: ['automod'],
    welcome: ['welcome'],
    boost: ['boost'] // Special feature toggle
  };

  // Handle Boost System specially (feature toggle + commands)
  if (featureType === 'boost') {
    if (status === 'status') {
      const boostConfig = guildConfig.features?.boostSystem || {};
      const boostChannel = boostConfig.channel ? interaction.guild.channels.cache.get(boostConfig.channel) : null;

      const embed = new EmbedBuilder()
        .setTitle('💎 Server Boost Announcements Status')
        .setColor(boostConfig.enabled ? '#FF73FA' : '#FF4757')
        .setDescription(
          `**Status:** ${boostConfig.enabled ? '✅ Enabled' : '❌ Disabled'}\n` +
          `**Channel:** ${boostChannel ? `<#${boostChannel.id}>` : 'Not set'}\n` +
          `**Embed Mode:** ${boostConfig.embedEnabled !== false ? '✅' : '❌'}\n\n` +
          `**Configure with:**\n` +
          `• \`/boost channel\` - Set announcement channel\n` +
          `• \`/boost message\` - Customize message\n` +
          `• \`/boost test\` - Preview message`
        )
        .setFooter({ text: 'Use /feature type:boost to toggle on/off' });

      return interaction.editReply({ embeds: [embed] });
    }

    const isEnabling = status === 'enable';
    await Guild.updateGuild(guildId, {
      $set: { 'features.boostSystem.enabled': isEnabling }
    });

    return interaction.editReply({
      embeds: [await successEmbed(guildId,
        `Boost Announcements ${isEnabling ? 'Enabled' : 'Disabled'}`,
        `${GLYPHS.SUCCESS} **💎 Server Boost Announcements** have been ${isEnabling ? 'enabled' : 'disabled'}.\n\n` +
        (isEnabling
          ? `The bot will now send thank you messages when members boost the server.\n\n` +
          `**Configure with:**\n` +
          `• \`/boost channel\` - Set announcement channel\n` +
          `• \`/boost message\` - Customize message\n` +
          `• \`/boost test\` - Preview message`
          : `Boost thank you messages have been disabled.`)
      )]
    });
  }

  // Handle AI Chat specially (it's a feature toggle, not command-based)
  if (featureType === 'aichat') {
    if (status === 'status') {
      const aiConfig = guildConfig.features?.aiChat || {};
      const embed = new EmbedBuilder()
        .setTitle('🤖 AI Chat (Raphael) Status')
        .setColor(aiConfig.enabled ? '#00FF7F' : '#FF4757')
        .setDescription(
          `**Status:** ${aiConfig.enabled ? '✅ Enabled' : '❌ Disabled'}\n` +
          `**Troll Mode:** ${aiConfig.trollMode ? '😈 Enabled' : '😇 Disabled'}\n\n` +
          `**How to use:**\n` +
          `• Mention the bot: <@${client.user.id}> hello!\n` +
          `• Reply to the bot's messages\n\n` +
          `**Personality:** Raphael (from Tensura)\n` +
          `**Powered by:** Pollinations AI (Free)`
        )
        .setFooter({ text: 'Use /feature type:troll to toggle chaos mode' });

      return interaction.editReply({ embeds: [embed] });
    }

    const isEnabling = status === 'enable';
    await Guild.updateGuild(guildId, {
      $set: { 'features.aiChat.enabled': isEnabling }
    });

    return interaction.editReply({
      embeds: [await successEmbed(guildId,
        `AI Chat ${isEnabling ? 'Enabled' : 'Disabled'}`,
        `${GLYPHS.SUCCESS} **🤖 AI Chat (Raphael)** has been ${isEnabling ? 'enabled' : 'disabled'}.\n\n` +
        (isEnabling
          ? `Users can now chat with Raphael by mentioning <@${client.user.id}> or replying to the bot's messages.`
          : `The AI chat feature is now disabled.`)
      )]
    });
  }

  // Handle Troll Mode toggle
  if (featureType === 'troll') {
    if (status === 'status') {
      const aiConfig = guildConfig.features?.aiChat || {};
      const embed = new EmbedBuilder()
        .setTitle('😈 Troll Mode Status')
        .setColor(aiConfig.trollMode ? '#FF4757' : '#667eea')
        .setDescription(
          `**AI Chat:** ${aiConfig.enabled ? '✅ Enabled' : '❌ Disabled'}\n` +
          `**Troll Mode:** ${aiConfig.trollMode ? '😈 Enabled' : '😇 Disabled'}\n\n` +
          (aiConfig.trollMode
            ? `Raphael is in **chaos mode** - expect unhinged, chaotic responses! 💀`
            : `Raphael is being normal... for now.`)
        )
        .setFooter({ text: 'Enable troll mode for maximum chaos' });

      return interaction.editReply({ embeds: [embed] });
    }

    // Check if AI Chat is enabled first
    const aiEnabled = guildConfig.features?.aiChat?.enabled;
    const isEnabling = status === 'enable';

    if (!aiEnabled && isEnabling) {
      return interaction.editReply({
        embeds: [await errorEmbed(guildId, 'AI Chat Disabled',
          `${GLYPHS.ERROR} AI Chat must be enabled before you can enable Troll Mode!\n\n` +
          `Use \`/feature type:aichat status:enable\` first.`
        )]
      });
    }

    await Guild.updateGuild(guildId, {
      $set: { 'features.aiChat.trollMode': isEnabling }
    });

    return interaction.editReply({
      embeds: [await successEmbed(guildId,
        `Troll Mode ${isEnabling ? 'Enabled 😈' : 'Disabled 😇'}`,
        `${GLYPHS.SUCCESS} **Troll Mode** has been ${isEnabling ? 'enabled' : 'disabled'}.\n\n` +
        (isEnabling
          ? `Raphael is now in **chaos mode** - expect unhinged, chaotic, and absolutely based responses. 💀`
          : `Raphael is back to normal - cheeky but reasonable.`)
      )]
    });
  }

  // Get commands for the selected feature
  let commandsToManage = [];
  let featureName = '';

  if (featureType === 'custom') {
    if (!customCommand) {
      return interaction.editReply({
        embeds: [await errorEmbed(guildId, 'Missing Command',
          `${GLYPHS.ERROR} Please specify a command name using the \`command\` option.`)]
      });
    }
    commandsToManage = [customCommand];
    featureName = `Command: ${customCommand}`;
  } else {
    commandsToManage = featureCategories[featureType] || [];
    const featureNames = {
      economy: '💰 Economy',
      gambling: '🎰 Gambling',
      leveling: '📊 Leveling',
      games: '🎮 Games',
      fun: '😂 Fun',
      birthdays: '🎂 Birthdays',
      giveaways: '🎉 Giveaways',
      events: '📅 Events',
      starboard: '⭐ Starboard',
      tickets: '🎫 Tickets',
      afk: '💤 AFK',
      reminders: '⏰ Reminders',
      automod: '🛡️ AutoMod',
      welcome: '👋 Welcome',
      boost: '💎 Server Boost'
    };
    featureName = featureNames[featureType] || featureType;
  }

  // Handle status view
  if (status === 'status') {
    const disabledText = guildConfig.textCommands?.disabledCommands || [];
    const disabledSlash = guildConfig.slashCommands?.disabledCommands || [];

    const commandStatus = commandsToManage.map(cmd => {
      const textDisabled = disabledText.includes(cmd);
      const slashDisabled = disabledSlash.includes(cmd);
      const icon = (!textDisabled && !slashDisabled) ? '✅' : (textDisabled && slashDisabled) ? '❌' : '⚠️';
      return `${icon} \`${cmd}\``;
    });

    const embed = new EmbedBuilder()
      .setTitle(`${featureName} Status`)
      .setDescription(commandStatus.join('\n') || 'No commands in this category')
      .setColor('#667eea')
      .setFooter({ text: '✅ Enabled | ❌ Disabled | ⚠️ Partially disabled' });

    return interaction.editReply({ embeds: [embed] });
  }

  // Enable or disable
  const isEnabling = status === 'enable';
  const disabledText = [...(guildConfig.textCommands?.disabledCommands || [])];
  const disabledSlash = [...(guildConfig.slashCommands?.disabledCommands || [])];

  // Protected commands that cannot be disabled
  const protectedCommands = ['help', 'config', 'feature', 'setup'];

  let modifiedCount = 0;
  let skippedProtected = [];

  for (const cmd of commandsToManage) {
    if (!isEnabling && protectedCommands.includes(cmd)) {
      skippedProtected.push(cmd);
      continue;
    }

    if (isEnabling) {
      // Remove from disabled lists
      const textIdx = disabledText.indexOf(cmd);
      if (textIdx > -1) { disabledText.splice(textIdx, 1); modifiedCount++; }
      const slashIdx = disabledSlash.indexOf(cmd);
      if (slashIdx > -1) { disabledSlash.splice(slashIdx, 1); modifiedCount++; }
    } else {
      // Add to disabled lists
      if (!disabledText.includes(cmd)) { disabledText.push(cmd); modifiedCount++; }
      if (!disabledSlash.includes(cmd)) { disabledSlash.push(cmd); modifiedCount++; }
    }
  }

  await Guild.updateGuild(guildId, {
    $set: {
      'textCommands.disabledCommands': disabledText,
      'slashCommands.disabledCommands': disabledSlash
    }
  });

  let description = `${GLYPHS.SUCCESS} **${featureName}** has been ${isEnabling ? 'enabled' : 'disabled'}.\n\n`;
  description += `**Commands affected:** ${commandsToManage.length}\n`;
  description += `**Commands:** ${commandsToManage.map(c => `\`${c}\``).join(', ')}`;

  if (skippedProtected.length > 0) {
    description += `\n\n⚠️ **Skipped (protected):** ${skippedProtected.map(c => `\`${c}\``).join(', ')}`;
  }

  return interaction.editReply({
    embeds: [await successEmbed(guildId,
      `Feature ${isEnabling ? 'Enabled' : 'Disabled'}`,
      description)]
  });
}

async function handleGiveawayCommand(interaction, client, guildConfig) {
  const { successEmbed, errorEmbed, infoEmbed, GLYPHS } = await import('../../utils/embeds.js');
  const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = await import('discord.js');
  const Giveaway = (await import('../../models/Giveaway.js')).default;
  const { endGiveawayById } = await import('../../commands/community/giveaway.js');

  const subcommand = interaction.options.getSubcommand();

  switch (subcommand) {
    case 'start': {
      const durationStr = interaction.options.getString('duration');
      const winners = interaction.options.getInteger('winners');
      const prize = interaction.options.getString('prize');
      const requiredRole = interaction.options.getRole('required_role');

      // Parse duration
      const durationMatch = durationStr.match(/^(\d+)(s|m|h|d|w)$/i);
      if (!durationMatch) {
        return interaction.editReply({
          embeds: [await errorEmbed(interaction.guild.id, 'Invalid Duration',
            'Please provide a valid duration.')]
        });
      }

      const value = parseInt(durationMatch[1]);
      const unit = durationMatch[2].toLowerCase();
      const multipliers = { s: 1000, m: 60000, h: 3600000, d: 86400000, w: 604800000 };
      const duration = value * multipliers[unit];

      const endsAt = new Date(Date.now() + duration);

      // Create giveaway embed
      const embed = new EmbedBuilder()
        .setColor(guildConfig.embedStyle?.color || '#FF69B4')
        .setTitle('🎉 GIVEAWAY 🎉')
        .setDescription(
          `**Prize:** ${prize}\n\n` +
          `**Winners:** ${winners}\n` +
          `**Hosted by:** ${interaction.user}\n` +
          (requiredRole ? `**Required Role:** ${requiredRole}\n\n` : '\n') +
          `**Ends:** <t:${Math.floor(endsAt.getTime() / 1000)}:R>\n\n` +
          `Click the button below to enter!`
        )
        .setFooter({ text: 'Ends at' })
        .setTimestamp(endsAt);

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('giveaway_enter')
          .setLabel('🎉 Enter (0)')
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId('giveaway_participants')
          .setLabel('👥 Participants')
          .setStyle(ButtonStyle.Secondary)
      );

      const giveawayMessage = await interaction.channel.send({
        embeds: [embed],
        components: [row]
      });

      // Save to database
      await Giveaway.create({
        guildId: interaction.guild.id,
        channelId: interaction.channel.id,
        messageId: giveawayMessage.id,
        hostId: interaction.user.id,
        prize,
        winners,
        endsAt,
        participants: [],
        requirements: requiredRole ? { roleId: requiredRole.id } : undefined
      });

      return interaction.editReply({
        embeds: [await successEmbed(interaction.guild.id, 'Giveaway Started!',
          `${GLYPHS.SUCCESS} Giveaway for **${prize}** has started!\n` +
          `Ends <t:${Math.floor(endsAt.getTime() / 1000)}:R>`)]
      });
    }

    case 'end': {
      const messageId = interaction.options.getString('message_id');
      const giveaway = await Giveaway.findOne({ messageId, guildId: interaction.guild.id });

      if (!giveaway) {
        return interaction.editReply({
          embeds: [await errorEmbed(interaction.guild.id, 'Not Found',
            'Could not find a giveaway with that message ID.')]
        });
      }

      if (giveaway.ended) {
        return interaction.editReply({
          embeds: [await errorEmbed(interaction.guild.id, 'Already Ended',
            'This giveaway has already ended.')]
        });
      }

      await endGiveawayById(interaction.guild, giveaway);

      return interaction.editReply({
        embeds: [await successEmbed(interaction.guild.id, 'Giveaway Ended',
          `${GLYPHS.SUCCESS} The giveaway has been ended!`)]
      });
    }

    case 'reroll': {
      const messageId = interaction.options.getString('message_id');
      const giveaway = await Giveaway.findOne({ messageId, guildId: interaction.guild.id });

      if (!giveaway) {
        return interaction.editReply({
          embeds: [await errorEmbed(interaction.guild.id, 'Not Found',
            'Could not find a giveaway with that message ID.')]
        });
      }

      if (!giveaway.ended) {
        return interaction.editReply({
          embeds: [await errorEmbed(interaction.guild.id, 'Not Ended',
            'This giveaway has not ended yet. Use `/giveaway end` first.')]
        });
      }

      if (giveaway.participants.length === 0) {
        return interaction.editReply({
          embeds: [await errorEmbed(interaction.guild.id, 'No Participants',
            'There were no participants in this giveaway.')]
        });
      }

      // Pick new winners
      const newWinners = giveaway.pickWinners();
      giveaway.winnerIds = newWinners;
      await giveaway.save();

      const channel = interaction.guild.channels.cache.get(giveaway.channelId);
      if (channel) {
        const winnerMentions = newWinners.map(id => `<@${id}>`).join(', ');
        await channel.send({
          content: `🎉 **REROLL!** New winner(s): ${winnerMentions}\n**Prize:** ${giveaway.prize}`
        });
      }

      return interaction.editReply({
        embeds: [await successEmbed(interaction.guild.id, 'Giveaway Rerolled',
          `${GLYPHS.SUCCESS} New winners have been selected!`)]
      });
    }

    case 'list': {
      const giveaways = await Giveaway.getGuildGiveaways(interaction.guild.id);

      if (giveaways.length === 0) {
        return interaction.editReply({
          embeds: [await infoEmbed(interaction.guild.id, 'No Active Giveaways',
            'There are no active giveaways in this server.')]
        });
      }

      const giveawayList = giveaways.map((g, i) =>
        `**${i + 1}.** ${g.prize}\n` +
        `   ${GLYPHS.DOT} Ends: <t:${Math.floor(g.endsAt.getTime() / 1000)}:R>\n` +
        `   ${GLYPHS.DOT} Participants: ${g.participants.length}\n` +
        `   ${GLYPHS.DOT} Message ID: \`${g.messageId}\``
      ).join('\n\n');

      return interaction.editReply({
        embeds: [await infoEmbed(interaction.guild.id, '🎉 Active Giveaways', giveawayList)]
      });
    }

    case 'delete': {
      const messageId = interaction.options.getString('message_id');
      const giveaway = await Giveaway.findOneAndDelete({ messageId, guildId: interaction.guild.id });

      if (!giveaway) {
        return interaction.editReply({
          embeds: [await errorEmbed(interaction.guild.id, 'Not Found',
            'Could not find a giveaway with that message ID.')]
        });
      }

      // Try to delete the giveaway message
      try {
        const channel = interaction.guild.channels.cache.get(giveaway.channelId);
        const msg = await channel?.messages.fetch(giveaway.messageId);
        await msg?.delete();
      } catch {
        // Message might already be deleted
      }

      return interaction.editReply({
        embeds: [await successEmbed(interaction.guild.id, 'Giveaway Deleted',
          `${GLYPHS.SUCCESS} The giveaway has been cancelled and deleted.`)]
      });
    }
  }
}

async function handleAwardCommand(interaction, client, guildConfig) {
  const { successEmbed, errorEmbed, GLYPHS, createEmbed } = await import('../../utils/embeds.js');
  const { EmbedBuilder } = await import('discord.js');
  const Economy = (await import('../../models/Economy.js')).default;
  const Level = (await import('../../models/Level.js')).default;
  const ModLog = (await import('../../models/ModLog.js')).default;

  const type = interaction.options.getString('type');
  const targetUser = interaction.options.getUser('user');
  const amount = interaction.options.getInteger('amount');
  const reason = interaction.options.getString('reason') || 'No reason provided';

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
        'Automated systems cannot receive awards.')]
    });
  }

  if (amount === 0) {
    return interaction.editReply({
      embeds: [await errorEmbed(interaction.guild.id, 'Invalid Amount',
        'Amount cannot be zero.')]
    });
  }

  const guildId = interaction.guild.id;
  const isAdding = amount > 0;
  const absAmount = Math.abs(amount);

  try {
    let result;
    let leveledUp = [];
    let levelData = null;

    switch (type) {
      case 'xp': {
        levelData = await Level.findOne({ userId: targetUser.id, guildId });

        if (!levelData) {
          levelData = new Level({
            userId: targetUser.id,
            guildId,
            username: targetUser.username
          });
        }

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

        result = {
          emoji: '✨',
          typeName: 'XP',
          newValue: levelData.totalXP,
          levelInfo: `**Level:** ${levelData.level} • **Current XP:** ${levelData.xp}/${levelData.xpForNextLevel()}`
        };
        break;
      }

      case 'coins': {
        const economy = await Economy.getEconomy(targetUser.id, guildId);

        if (amount < 0) {
          economy.coins = Math.max(0, economy.coins - absAmount);
        } else {
          economy.coins += amount;
          economy.stats.totalEarned = (economy.stats.totalEarned || 0) + amount;
        }

        await economy.save();

        const coinEmoji = guildConfig.economy?.coinEmoji || '💰';

        result = {
          emoji: coinEmoji,
          typeName: 'Coins',
          newValue: economy.coins,
          levelInfo: `**Wallet:** ${economy.coins.toLocaleString()}`
        };
        break;
      }

      case 'rep': {
        const economy = await Economy.getEconomy(targetUser.id, guildId);

        if (amount < 0) {
          economy.reputation = Math.max(0, economy.reputation - absAmount);
        } else {
          economy.reputation = (economy.reputation || 0) + amount;
        }

        await economy.save();

        result = {
          emoji: '⭐',
          typeName: 'Reputation',
          newValue: economy.reputation
        };
        break;
      }
    }

    const actionWord = isAdding ? 'Added' : 'Removed';
    const embed = await successEmbed(guildId,
      `${result.emoji} ${result.typeName} ${actionWord}!`,
      `${GLYPHS.SUCCESS} Successfully ${isAdding ? 'added' : 'removed'} **${absAmount.toLocaleString()}** ${result.emoji} ${result.typeName.toLowerCase()} ${isAdding ? 'to' : 'from'} ${targetUser}!\n\n` +
      `**${targetUser.username}'s New ${result.typeName}:** ${result.newValue.toLocaleString()} ${result.emoji}` +
      (result.levelInfo ? `\n${result.levelInfo}` : '') +
      `\n\n**Reason:** ${reason}`
    );

    await interaction.editReply({ embeds: [embed] });

    // Send level up announcement if user leveled up
    if (type === 'xp' && leveledUp && leveledUp.length > 0 && levelData) {
      await announceLevelUpFromAward(interaction.guild, guildConfig, targetUser, levelData, leveledUp);
    }

    // Try to DM the user
    try {
      const dmEmbed = new EmbedBuilder()
        .setColor(isAdding ? '#00FF00' : '#FF6B6B')
        .setTitle(`${result.emoji} ${result.typeName} ${actionWord}`)
        .setDescription(
          `An administrator in **${interaction.guild.name}** has ${isAdding ? 'given you' : 'removed'} **${absAmount.toLocaleString()}** ${result.emoji} ${result.typeName.toLowerCase()}.\n\n` +
          `**Your new ${result.typeName.toLowerCase()}:** ${result.newValue.toLocaleString()} ${result.emoji}\n` +
          `**Reason:** ${reason}`
        )
        .setTimestamp();
      await targetUser.send({ embeds: [dmEmbed] });
    } catch {
      // User has DMs disabled
    }

    // Log to mod log channel
    try {
      if (guildConfig?.channels?.modLog) {
        const modLogChannel = interaction.guild.channels.cache.get(guildConfig.channels.modLog);
        if (modLogChannel) {
          const caseNumber = await ModLog.getNextCaseNumber(guildId);

          const logEmbed = await createEmbed(guildId, isAdding ? 'success' : 'warning');
          logEmbed.setTitle(`${result.emoji} ${isAdding ? 'AWARD' : 'DEDUCT'} | Case #${caseNumber}`)
            .setDescription(`**${result.typeName}** has been ${isAdding ? 'awarded to' : 'deducted from'} a member.`)
            .addFields(
              { name: `${GLYPHS.ARROW_RIGHT} User`, value: `${targetUser.tag}\n\`${targetUser.id}\``, inline: true },
              { name: `${GLYPHS.ARROW_RIGHT} Moderator`, value: `${interaction.user.tag}`, inline: true },
              { name: `${GLYPHS.ARROW_RIGHT} Amount`, value: `${isAdding ? '+' : '-'}${absAmount.toLocaleString()} ${result.emoji}`, inline: true },
              { name: `${GLYPHS.ARROW_RIGHT} New Total`, value: `${result.newValue.toLocaleString()} ${result.emoji}`, inline: true },
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
    return interaction.editReply({
      embeds: [await errorEmbed(guildId, 'Error', 'An error occurred while processing the award.')]
    });
  }
}

// Handle noxp command
async function handleNoxpCommand(interaction, guildConfig) {
  const { successEmbed, errorEmbed, infoEmbed, GLYPHS } = await import('../../utils/embeds.js');
  const { EmbedBuilder, ChannelType } = await import('discord.js');
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
            `${GLYPHS.INFO} No channels are blacklisted from earning XP.\n\nUse \`/noxp add #channel\` to add one!`)]
        });
        return;
      }

      const channelList = noXpChannels.map(id => {
        const channel = interaction.guild.channels.cache.get(id);
        return channel ? `${GLYPHS.ARROW_RIGHT} ${channel}` : `${GLYPHS.ARROW_RIGHT} <Deleted Channel>`;
      }).join('\n');

      const embed = new EmbedBuilder()
        .setColor('#5865F2')
        .setTitle('🚫 No-XP Channels')
        .setDescription(`**Blacklisted Channels:**\n\n${channelList}`)
        .setFooter({ text: `${noXpChannels.length} channel(s) blacklisted` })
        .setTimestamp();

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

      const embed = new EmbedBuilder()
        .setColor(cardOverlay.color || '#667eea')
        .setTitle('『 Server Overlay Settings 』')
        .setDescription(customizationEnabled
          ? '⚠️ **User customization is enabled** - these settings are not active.\nUse `feature disable profilecustomization` to take control.'
          : '✅ **These settings apply to all profiles.**')
        .addFields(
          {
            name: '🎨 Color',
            value: `\`${cardOverlay.color}\``,
            inline: true
          },
          {
            name: '💧 Opacity',
            value: `\`${Math.round(cardOverlay.opacity * 100)}%\``,
            inline: true
          },
          {
            name: '📋 Result',
            value: `\`${overlayRgba}\``,
            inline: true
          }
        )
        .setFooter({ text: 'Applies to both profile and level/rank cards' });

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
            `${GLYPHS.WARNING} Please provide a valid hex color.\n\n` +
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

// Handle setprofile command
async function handleSetprofileCommand(interaction) {
  const Economy = (await import('../../models/Economy.js')).default;
  const Guild = (await import('../../models/Guild.js')).default;
  const { successEmbed, errorEmbed, GLYPHS } = await import('../../utils/embeds.js');
  const { EmbedBuilder } = await import('discord.js');

  const userId = interaction.user.id;
  const guildId = interaction.guild.id;
  const subcommandGroup = interaction.options.getSubcommandGroup(false);
  const subcommand = interaction.options.getSubcommand();

  // Get guild config to check if customization is enabled (default: true)
  const guildConfig = await Guild.getGuild(guildId);
  const customizationEnabled = guildConfig.economy?.profileCustomization?.enabled !== false;

  // Helper function to convert hex to rgba
  function hexToRgba(hex, opacity) {
    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    if (!result) return null;
    const r = parseInt(result[1], 16);
    const g = parseInt(result[2], 16);
    const b = parseInt(result[3], 16);
    return `rgba(${r}, ${g}, ${b}, ${opacity})`;
  }

  // Handle overlay subcommand group
  if (subcommandGroup === 'overlay') {
    if (!customizationEnabled) {
      await interaction.editReply({
        embeds: [await errorEmbed(guildId, 'Customization Disabled',
          `${GLYPHS.WARNING} Profile customization is disabled on this server.\n\n` +
          `Server admins control the overlay using \`/setoverlay\`.`)]
      });
      return;
    }

    if (subcommand === 'color') {
      const hex = interaction.options.getString('hex');
      const hexRegex = /^#?([0-9A-Fa-f]{6})$/;
      const match = hex.match(hexRegex);

      if (!match) {
        await interaction.editReply({
          embeds: [await errorEmbed(guildId, 'Invalid Color',
            `${GLYPHS.WARNING} Invalid hex color format, Master.\n\n` +
            `**Examples:**\n◇ \`#000000\` - Black\n◇ \`#1a1a2e\` - Dark Blue`)]
        });
        return;
      }

      const hexColor = hex.startsWith('#') ? hex.toLowerCase() : `#${hex.toLowerCase()}`;
      const economy = await Economy.getEconomy(userId, guildId);
      economy.profile.overlayColor = hexColor;
      await economy.save();

      const embed = new EmbedBuilder()
        .setColor(hexColor)
        .setTitle('『 Overlay Color Updated 』')
        .setDescription(`${GLYPHS.SUCCESS} **Confirmed:** Set to \`${hexColor}\`, Master.`)
        .setFooter({ text: 'Applied to your profile and level cards.' });

      await interaction.editReply({ embeds: [embed] });
      return;
    }

    if (subcommand === 'opacity') {
      const opacityPercent = interaction.options.getInteger('percent');
      const opacity = opacityPercent / 100;

      const economy = await Economy.getEconomy(userId, guildId);
      economy.profile.overlayOpacity = opacity;
      await economy.save();

      await interaction.editReply({
        embeds: [await successEmbed(guildId, 'Overlay Opacity Updated',
          `${GLYPHS.SUCCESS} **Confirmed:** Set to \`${opacityPercent}%\`, Master.\n\n` +
          `Applied to your profile and level cards.`)]
      });
      return;
    }
  }

  switch (subcommand) {
    case 'view': {
      const economy = await Economy.getEconomy(userId, guildId);
      const profile = economy.profile || {};

      const overlayColor = profile.overlayColor || '#000000';
      const overlayOpacity = profile.overlayOpacity ?? 0.5;
      const overlayRgba = hexToRgba(overlayColor, overlayOpacity);

      const embed = new EmbedBuilder()
        .setColor('#00CED1')
        .setTitle('『 Your Profile Settings 』')
        .setDescription(customizationEnabled
          ? '**You can customize your overlay.**'
          : '**Overlay is controlled by server admins.**')
        .addFields(
          {
            name: '📄 Description',
            value: profile.description ? `\`\`\`${profile.description.substring(0, 150)}${profile.description.length > 150 ? '...' : ''}\`\`\`` : '`Not set`',
            inline: false
          },
          {
            name: '🎨 Overlay Color',
            value: `\`${overlayColor}\``,
            inline: true
          },
          {
            name: '💧 Overlay Opacity',
            value: `\`${Math.round(overlayOpacity * 100)}%\``,
            inline: true
          },
          {
            name: '📋 Result',
            value: `\`${overlayRgba}\``,
            inline: true
          },
          {
            name: '🖼️ Background',
            value: `\`${profile.background || 'default'}\``,
            inline: true
          }
        )
        .setFooter({ text: 'Use /profile to preview your card' });

      await interaction.editReply({ embeds: [embed] });
      break;
    }

    case 'reset': {
      if (!customizationEnabled) {
        await interaction.editReply({
          embeds: [await errorEmbed(guildId, 'Customization Disabled',
            `${GLYPHS.WARNING} Profile customization is disabled.\nOverlay is controlled by server admins.`)]
        });
        return;
      }

      await Economy.updateEconomy(userId, guildId, {
        $set: {
          'profile.overlayColor': '#000000',
          'profile.overlayOpacity': 0.5
        }
      });

      await interaction.editReply({
        embeds: [await successEmbed(guildId, 'Overlay Reset',
          `${GLYPHS.SUCCESS} Your overlay has been reset to default, Master.\n\n` +
          `**Default Values:**\n` +
          `◇ Color: \`#000000\`\n` +
          `◇ Opacity: \`50%\``)]
      });
      break;
    }

    case 'description': {
      const text = interaction.options.getString('text') || '';
      const economy = await Economy.getEconomy(userId, guildId);

      if (!text) {
        economy.profile.description = '';
        await economy.save();
        await interaction.editReply({
          embeds: [await successEmbed(guildId, 'Description Cleared',
            `${GLYPHS.SUCCESS} Your description has been cleared, Master.`)]
        });
      } else {
        economy.profile.description = text;
        await economy.save();
        await interaction.editReply({
          embeds: [await successEmbed(guildId, 'Description Updated',
            `${GLYPHS.SUCCESS} Your description has been updated, Master.\n\n**Length:** ${text.length}/500 characters`)]
        });
      }
      break;
    }
  }
}

// Announce level up for award command
async function announceLevelUpFromAward(guild, guildConfig, user, levelData, leveledUp) {
  try {
    const { EmbedBuilder } = await import('discord.js');
    const levelConfig = guildConfig.features?.levelSystem;

    // Check if level up announcements are enabled
    if (levelConfig?.announceLevelUp === false) return;

    const newLevel = Math.max(...leveledUp);

    // Get the level up channel
    const channelId = levelConfig?.levelUpChannel || guildConfig.channels?.levelUpChannel;
    if (!channelId) return;

    const channel = guild.channels.cache.get(channelId);
    if (!channel) return;

    // Build level up message
    let levelUpMessage = levelConfig?.levelUpMessage || '🎉 {user} leveled up to level {level}!';
    levelUpMessage = levelUpMessage
      .replace(/{user}/g, `<@${user.id}>`)
      .replace(/{username}/g, user.username)
      .replace(/{level}/g, newLevel)
      .replace(/{totalxp}/g, levelData.totalXP.toLocaleString())
      .replace(/{server}/g, guild.name);

    // Create embed
    const embed = new EmbedBuilder()
      .setColor(guildConfig.embedStyle?.color || '#FFD700')
      .setTitle('🎉 Level Up!')
      .setDescription(levelUpMessage)
      .setThumbnail(user.displayAvatarURL({ extension: 'png', size: 128 }))
      .addFields(
        { name: 'New Level', value: `**${newLevel}**`, inline: true },
        { name: 'Total XP', value: levelData.totalXP.toLocaleString(), inline: true }
      )
      .setFooter({ text: 'Awarded by admin' })
      .setTimestamp();

    await channel.send({
      content: `<@${user.id}>`,
      embeds: [embed]
    });

  } catch (error) {
    console.error('Error announcing level up:', error);
  }
}

// Handle Confession slash command
async function handleConfessionCommand(interaction, client, guildConfig) {
  const { successEmbed, errorEmbed, infoEmbed, GLYPHS } = await import('../../utils/embeds.js');
  const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType } = await import('discord.js');
  const Confession = (await import('../../models/Confession.js')).default;
  const subcommand = interaction.options.getSubcommand();

  let confessionData = await Confession.findOne({ guildId: interaction.guild.id });
  if (!confessionData) {
    confessionData = new Confession({ guildId: interaction.guild.id });
  }

  switch (subcommand) {
    case 'setup': {
      const channel = interaction.options.getChannel('channel');

      if (channel.type !== ChannelType.GuildText) {
        await interaction.editReply({
          embeds: [await errorEmbed(interaction.guild.id, 'Invalid Channel',
            `${GLYPHS.ERROR} Please select a text channel.`)]
        });
        return;
      }

      const botPerms = channel.permissionsFor(interaction.guild.members.me);
      if (!botPerms.has(['SendMessages', 'EmbedLinks'])) {
        await interaction.editReply({
          embeds: [await errorEmbed(interaction.guild.id, 'Missing Permissions',
            `${GLYPHS.ERROR} I need \`Send Messages\` and \`Embed Links\` permissions in ${channel}.`)]
        });
        return;
      }

      confessionData.channelId = channel.id;
      confessionData.enabled = true;
      await confessionData.save();

      // Send confession panel
      const panelEmbed = new EmbedBuilder()
        .setTitle('📝 Anonymous Confessions')
        .setDescription('Click the button below to submit an anonymous confession!\n\n*Your identity will remain completely anonymous to other members.*')
        .setColor('#9b59b6')
        .setFooter({ text: 'Confessions are moderated • Be respectful' });

      const row = new ActionRowBuilder()
        .addComponents(
          new ButtonBuilder()
            .setCustomId('confession_submit')
            .setLabel('Submit a confession!')
            .setStyle(ButtonStyle.Primary)
            .setEmoji('📝')
        );

      await channel.send({ embeds: [panelEmbed], components: [row] });

      await interaction.editReply({
        embeds: [await successEmbed(interaction.guild.id, 'Confession System Enabled',
          `${GLYPHS.SUCCESS} Confession system has been set up in ${channel}!\n\nA confession panel has been sent to the channel.`)]
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
      const embed = new EmbedBuilder()
        .setTitle('⚙️ Confession Settings')
        .setColor('#9b59b6')
        .addFields(
          { name: 'Status', value: confessionData.enabled ? '✅ Enabled' : '❌ Disabled', inline: true },
          { name: 'Channel', value: confessionData.channelId ? `<#${confessionData.channelId}>` : 'Not set', inline: true },
          { name: 'Total Confessions', value: `${confessionData.confessionCount}`, inline: true },
          { name: 'Cooldown', value: `${confessionData.settings.cooldown} seconds`, inline: true },
          { name: 'Allow Replies', value: confessionData.settings.allowReplies ? '✅ Yes' : '❌ No', inline: true },
          { name: 'Anonymous Replies', value: confessionData.settings.anonymousReplies ? '✅ Yes' : '❌ No', inline: true },
          { name: 'Require Approval', value: confessionData.settings.requireApproval ? '✅ Yes' : '❌ No', inline: true },
          { name: 'Min Length', value: `${confessionData.settings.minLength} chars`, inline: true },
          { name: 'Max Length', value: `${confessionData.settings.maxLength} chars`, inline: true },
          { name: 'Banned Users', value: `${confessionData.settings.bannedUsers.length} users`, inline: true }
        )
        .setTimestamp();

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

      const embed = new EmbedBuilder()
        .setTitle('📝 Pending Confessions')
        .setColor('#9b59b6')
        .setDescription(confessionData.pendingConfessions.slice(0, 10).map((c, i) =>
          `**${i + 1}.** ${c.content.substring(0, 100)}${c.content.length > 100 ? '...' : ''}\n*Submitted <t:${Math.floor(c.timestamp.getTime() / 1000)}:R>*`
        ).join('\n\n'))
        .setFooter({ text: `Showing ${Math.min(10, confessionData.pendingConfessions.length)} of ${confessionData.pendingConfessions.length} pending` });

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
      if (!channel) {
        await interaction.editReply({
          embeds: [await errorEmbed(interaction.guild.id, 'Channel Not Found',
            `${GLYPHS.ERROR} The confession channel no longer exists.`)]
        });
        return;
      }

      const pending = confessionData.pendingConfessions[id];
      confessionData.confessionCount++;
      const confessionNumber = confessionData.confessionCount;

      const confessionEmbed = new EmbedBuilder()
        .setAuthor({ name: `Anonymous Confession (#${confessionNumber})`, iconURL: interaction.guild.iconURL() })
        .setDescription(`"${pending.content}"`)
        .setColor('#9b59b6')
        .setTimestamp();

      const buttons = [
        new ButtonBuilder()
          .setCustomId('confession_submit')
          .setLabel('Submit a confession!')
          .setStyle(ButtonStyle.Primary)
          .setEmoji('📝')
      ];

      if (confessionData.settings.allowReplies) {
        buttons.push(
          new ButtonBuilder()
            .setCustomId(`confession_reply_${confessionNumber}`)
            .setLabel('Reply')
            .setStyle(ButtonStyle.Secondary)
            .setEmoji('💬')
        );
      }

      const row = new ActionRowBuilder().addComponents(buttons);
      const sentMessage = await channel.send({ embeds: [confessionEmbed], components: [row] });

      confessionData.confessions.push({
        number: confessionNumber,
        content: pending.content,
        messageId: sentMessage.id,
        userId: pending.userId,
        timestamp: new Date()
      });
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

      const panelEmbed = new EmbedBuilder()
        .setTitle('📝 Anonymous Confessions')
        .setDescription('Click the button below to submit an anonymous confession!\n\n*Your identity will remain completely anonymous to other members.*')
        .setColor('#9b59b6')
        .setFooter({ text: 'Confessions are moderated • Be respectful' });

      const row = new ActionRowBuilder()
        .addComponents(
          new ButtonBuilder()
            .setCustomId('confession_submit')
            .setLabel('Submit a confession!')
            .setStyle(ButtonStyle.Primary)
            .setEmoji('📝')
        );

      await channel.send({ embeds: [panelEmbed], components: [row] });

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

      const embed = new EmbedBuilder()
        .setTitle('📊 Confession Statistics')
        .setColor('#9b59b6')
        .addFields(
          { name: 'Total Confessions', value: `${totalConfessions}`, inline: true },
          { name: 'Total Replies', value: `${totalReplies}`, inline: true },
          { name: 'Pending Approval', value: `${pendingCount}`, inline: true },
          { name: 'Banned Users', value: `${bannedCount}`, inline: true },
          { name: 'Status', value: confessionData.enabled ? '✅ Active' : '❌ Disabled', inline: true },
          { name: 'Channel', value: confessionData.channelId ? `<#${confessionData.channelId}>` : 'Not set', inline: true }
        )
        .setTimestamp();

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

      // Helper to validate and filter prompts
      const validatePrompts = (promptsArray) => {
        return promptsArray
          .map(p => ({
            ...p,
            // Filter options to only those with at least one role or channel
            options: p.options.filter(o =>
              (o.roles && o.roles.length > 0) || (o.channels && o.channels.length > 0)
            )
          }))
          // Only keep prompts that have at least one valid option
          .filter(p => p.options && p.options.length > 0);
      };

      // Include prompts - either the updated ones or existing (mapped properly)
      if (updates.prompts !== undefined) {
        payload.prompts = validatePrompts(updates.prompts);
      } else if (prompts.size > 0) {
        payload.prompts = validatePrompts(mapPrompts());
      }

      await interaction.guild.editOnboarding(payload);
    };

    // SETTINGS GROUP
    if (group === 'settings') {
      if (subcommand === 'view') {
        const embed = new EmbedBuilder()
          .setTitle('『 Onboarding Settings 』')
          .setColor(guildConfig.embedStyle?.color || '#5865F2')
          .setDescription(`Server onboarding configuration for **${interaction.guild.name}**`)
          .addFields(
            {
              name: '📊 Status',
              value: [
                `**Enabled:** ${onboarding.enabled ? '✅ Yes' : '❌ No'}`,
                `**Mode:** ${onboarding.mode === 0 ? 'Default' : 'Advanced'}`,
              ].join('\n'),
              inline: true
            },
            {
              name: '📺 Default Channels',
              value: defaultChannelIds.length > 0
                ? defaultChannelIds.map(id => `<#${id}>`).join('\n')
                : '*No default channels*',
              inline: true
            },
            {
              name: '❓ Questions',
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

            return `**${index + 1}.** ${prompt.title}\n   └ ${prompt.options.size} options | ${flags.join(', ')}`;
          }).join('\n');

          embed.addFields({
            name: '📝 Questions List',
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
            `${GLYPHS.SUCCESS} Server onboarding has been enabled!`)]
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
        const embed = new EmbedBuilder()
          .setTitle('『 Default Channels 』')
          .setColor(guildConfig.embedStyle?.color || '#5865F2')
          .setDescription(
            defaultChannelIds.length > 0
              ? defaultChannelIds.map((id, i) => `**${i + 1}.** <#${id}>`).join('\n')
              : '*No default channels configured*'
          )
          .setFooter({ text: `${defaultChannelIds.length} default channel(s)` })
          .setTimestamp();

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
          .setColor(guildConfig.embedStyle?.color || '#5865F2');

        if (prompts.size === 0) {
          embed.setDescription('*No questions configured*');
        } else {
          const questionsList = Array.from(prompts.values()).map((prompt, index) => {
            const flags = [];
            if (prompt.required) flags.push('📌 Required');
            else flags.push('📎 Optional');
            if (prompt.singleSelect) flags.push('1️⃣ Single');
            else flags.push('🔢 Multi');

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

        embed.setFooter({ text: `${prompts.size} question(s)` });
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
            `${GLYPHS.SUCCESS} Question created with initial option!\n\n` +
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
        if (newTitle) changes.push(`Title → ${newTitle}`);
        if (required !== null) changes.push(`Required → ${required ? 'Yes' : 'No'}`);
        if (singleSelect !== null) changes.push(`Single Select → ${singleSelect ? 'Yes' : 'No'}`);

        return interaction.editReply({
          embeds: [await successEmbed(interaction.guild.id, 'Question Updated',
            `${GLYPHS.SUCCESS} Question **"${prompt.title}"** updated!\n\n${changes.join('\n') || 'No changes made'}`)]
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
          .setTitle(`『 Options: ${prompt.title} 』`)
          .setColor(guildConfig.embedStyle?.color || '#5865F2');

        if (prompt.options.size === 0) {
          embed.setDescription('*No options configured*');
        } else {
          const optionsList = Array.from(prompt.options.values()).map((opt, index) => {
            const roles = opt.roles?.size > 0
              ? `\n     Roles: ${Array.from(opt.roles.keys()).map(id => `<@&${id}>`).join(', ')}`
              : '';
            const channels = opt.channels?.size > 0
              ? `\n     Channels: ${Array.from(opt.channels.keys()).map(id => `<#${id}>`).join(', ')}`
              : '';
            const emoji = opt.emoji ? `${opt.emoji.name || opt.emoji} ` : '';

            return `**${index + 1}. ${emoji}${opt.title}**` +
              (opt.description ? `\n   ${opt.description}` : '') +
              roles + channels;
          }).join('\n\n');

          embed.setDescription(optionsList.substring(0, 4000));
        }

        embed.setFooter({ text: `${prompt.options.size} option(s)` });
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
            `${GLYPHS.SUCCESS} Option **"${title}"** added to question **"${prompt.title}"**!`)]
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