import { REST, Routes, SlashCommandBuilder, PermissionFlagsBits, ChannelType } from 'discord.js';

// Channel types an option accepts, so the picker only offers channels its handler can use
const TEXT_CHANNELS = [ChannelType.GuildText];
const POSTABLE_CHANNELS = [ChannelType.GuildText, ChannelType.GuildAnnouncement];
const ANNOUNCEMENT_CHANNELS = [ChannelType.GuildAnnouncement];
// Anywhere members send messages (voice and stage channels have a text chat; threads have their own ID)
const MESSAGE_CHANNELS = [
  ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildVoice, ChannelType.GuildStageVoice,
  ChannelType.PublicThread, ChannelType.PrivateThread, ChannelType.AnnouncementThread
];
const ONBOARDING_CHANNELS = [
  ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildVoice,
  ChannelType.GuildStageVoice, ChannelType.GuildForum, ChannelType.GuildMedia
];

// Text limits that keep the values inside Discord's embed and audit-log limits once stored and shown
const REASON_MAX = 500;
const AUDIT_REASON_MAX = 400; // lockdown prefixes its reason before writing the 512-character audit log entry
const MESSAGE_TEXT_MAX = 1500;
const RULE_TEXT_MAX = 500; // rules are listed together in one embed description
const TITLE_MAX = 200;
const COMMAND_NAME_MAX = 32;

// /logs types: the keys of LOG_TYPES in the prefix setlogs command (src/commands/config/logs.js)
const LOG_TYPE_CHOICES = [
  { name: 'Moderation logs', value: 'mod' },
  { name: 'Message logs', value: 'message' },
  { name: 'Voice logs', value: 'voice' },
  { name: 'Member logs (roles, nicknames, bans)', value: 'member' },
  { name: 'Server logs', value: 'server' },
  { name: 'Join logs', value: 'join' },
  { name: 'Leave logs', value: 'leave' },
  { name: 'Verification logs', value: 'verification' },
  { name: 'Alert logs', value: 'alert' },
  { name: 'Ticket logs', value: 'ticket' },
  { name: 'Bot status notices', value: 'botstatus' }
];

// Define slash commands for moderation
const slashCommands = [
  // ============================================
  // HELP COMMAND - Comprehensive command list
  // ============================================
  new SlashCommandBuilder()
    .setName('help')
    .setDescription('『 RAPHAEL 』 Display available commands and system information, Master')
    .addStringOption(option =>
      option.setName('category')
        .setDescription('Select a specific category to view')
        .setRequired(false)
        .addChoices(
          { name: 'Moderation', value: 'moderation' },
          { name: 'Configuration', value: 'config' },
          { name: 'Admin', value: 'admin' },
          { name: 'Economy', value: 'economy' },
          { name: 'Community', value: 'community' },
          { name: 'Social', value: 'social' },
          { name: 'Fun', value: 'fun' },
          { name: 'Music', value: 'music' },
          { name: 'Utility', value: 'utility' },
          { name: 'Info', value: 'info' }
        ))
    .addStringOption(option =>
      option.setName('command')
        .setDescription('Get detailed help for a specific command')
        .setRequired(false)
        .setMaxLength(COMMAND_NAME_MAX)),

  // Moderation Commands
  new SlashCommandBuilder()
    .setName('ban')
    .setDescription('Ban a member from the server')
    .addUserOption(option =>
      option.setName('user')
        .setDescription('The user to ban')
        .setRequired(true))
    .addStringOption(option =>
      option.setName('reason')
        .setDescription('Reason for the ban')
        .setRequired(false)
        .setMaxLength(REASON_MAX))
    .addBooleanOption(option =>
      option.setName('delete_messages')
        .setDescription('Delete messages from this user (last 24h)')
        .setRequired(false))
    .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers),

  new SlashCommandBuilder()
    .setName('kick')
    .setDescription('Kick a member from the server')
    .addUserOption(option =>
      option.setName('user')
        .setDescription('The user to kick')
        .setRequired(true))
    .addStringOption(option =>
      option.setName('reason')
        .setDescription('Reason for the kick')
        .setRequired(false)
        .setMaxLength(REASON_MAX))
    .setDefaultMemberPermissions(PermissionFlagsBits.KickMembers),

  new SlashCommandBuilder()
    .setName('warn')
    .setDescription('Warn a member')
    .addUserOption(option =>
      option.setName('user')
        .setDescription('The user to warn')
        .setRequired(true))
    .addStringOption(option =>
      option.setName('reason')
        .setDescription('Reason for the warning')
        .setRequired(false)
        .setMaxLength(REASON_MAX))
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),

  new SlashCommandBuilder()
    .setName('timeout')
    .setDescription('Timeout a member (prevent them from sending messages)')
    .addUserOption(option =>
      option.setName('user')
        .setDescription('The user to timeout')
        .setRequired(true))
    .addStringOption(option =>
      option.setName('duration')
        .setDescription('Duration (e.g., 5m, 1h, 1d, 1w)')
        .setRequired(true)
        .addChoices(
          { name: '5 minutes', value: '5m' },
          { name: '10 minutes', value: '10m' },
          { name: '30 minutes', value: '30m' },
          { name: '1 hour', value: '1h' },
          { name: '6 hours', value: '6h' },
          { name: '12 hours', value: '12h' },
          { name: '1 day', value: '1d' },
          { name: '3 days', value: '3d' },
          { name: '1 week', value: '1w' },
          { name: 'Remove', value: 'off' }
        ))
    .addStringOption(option =>
      option.setName('reason')
        .setDescription('Reason for the timeout')
        .setRequired(false)
        .setMaxLength(REASON_MAX))
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),

  new SlashCommandBuilder()
    .setName('purge')
    .setDescription('Delete multiple messages at once')
    .addIntegerOption(option =>
      option.setName('amount')
        .setDescription('Number of messages to delete (1-100)')
        .setRequired(true)
        .setMinValue(1)
        .setMaxValue(100))
    .addUserOption(option =>
      option.setName('user')
        .setDescription('Only delete messages from this user')
        .setRequired(false))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),

  new SlashCommandBuilder()
    .setName('userhistory')
    .setDescription('View moderation history of a user')
    .addUserOption(option =>
      option.setName('user')
        .setDescription('The user to check')
        .setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),

  new SlashCommandBuilder()
    .setName('untimeout')
    .setDescription('Remove timeout from a member')
    .addUserOption(option =>
      option.setName('user')
        .setDescription('The user to remove timeout from')
        .setRequired(true))
    .addStringOption(option =>
      option.setName('reason')
        .setDescription('Reason for removing the timeout')
        .setRequired(false)
        .setMaxLength(REASON_MAX))
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),

  new SlashCommandBuilder()
    .setName('verify')
    .setDescription('Manage the verification system')
    .addSubcommand(subcommand =>
      subcommand.setName('setup')
        .setDescription('Run the verification setup wizard'))
    .addSubcommand(subcommand =>
      subcommand.setName('panel')
        .setDescription('Send a verification panel to a channel')
        .addChannelOption(option =>
          option.setName('channel')
            .setDescription('Channel to send the panel to')
            .setRequired(false)
            .addChannelTypes(POSTABLE_CHANNELS)))
    .addSubcommand(subcommand =>
      subcommand.setName('manual')
        .setDescription('Manually verify a user')
        .addUserOption(option =>
          option.setName('user')
            .setDescription('The user to verify')
            .setRequired(true)))
    .addSubcommand(subcommand =>
      subcommand.setName('status')
        .setDescription('View current verification settings'))
    .addSubcommand(subcommand =>
      subcommand.setName('enable')
        .setDescription('Enable the verification system'))
    .addSubcommand(subcommand =>
      subcommand.setName('disable')
        .setDescription('Disable the verification system'))
    .addSubcommand(subcommand =>
      subcommand.setName('setrole')
        .setDescription('Set the verified role')
        .addRoleOption(option =>
          option.setName('role')
            .setDescription('The role to give verified users')
            .setRequired(true)))
    .addSubcommand(subcommand =>
      subcommand.setName('setunverifiedrole')
        .setDescription('Set the role to remove when user verifies')
        .addRoleOption(option =>
          option.setName('role')
            .setDescription('The role to remove on verification (leave empty to clear)')
            .setRequired(false)))
    .addSubcommand(subcommand =>
      subcommand.setName('setchannel')
        .setDescription('Set the verification channel')
        .addChannelOption(option =>
          option.setName('channel')
            .setDescription('The channel for verification')
            .setRequired(true)
            .addChannelTypes(POSTABLE_CHANNELS)))
    .addSubcommand(subcommand =>
      subcommand.setName('settype')
        .setDescription('Set the verification type')
        .addStringOption(option =>
          option.setName('type')
            .setDescription('The type of verification')
            .setRequired(true)
            .addChoices(
              { name: 'Button (simple click)', value: 'button' },
              { name: 'Captcha (image verification)', value: 'captcha' },
              { name: 'Reaction (react to message)', value: 'reaction' }
            )))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  new SlashCommandBuilder()
    .setName('cmdchannels')
    .setDescription('Restrict bot commands to specific channels')
    .addSubcommand(subcommand =>
      subcommand.setName('enable')
        .setDescription('Enable channel restrictions'))
    .addSubcommand(subcommand =>
      subcommand.setName('disable')
        .setDescription('Disable channel restrictions'))
    .addSubcommand(subcommand =>
      subcommand.setName('add')
        .setDescription('Add an allowed channel')
        .addChannelOption(option =>
          option.setName('channel')
            .setDescription('The channel to allow commands in')
            .setRequired(true)
            .addChannelTypes(MESSAGE_CHANNELS)))
    .addSubcommand(subcommand =>
      subcommand.setName('remove')
        .setDescription('Remove an allowed channel')
        .addChannelOption(option =>
          option.setName('channel')
            .setDescription('The channel to remove from allowed list')
            .setRequired(false)
            .addChannelTypes(MESSAGE_CHANNELS))
        .addStringOption(option =>
          option.setName('channel_id')
            .setDescription('ID of a deleted channel to remove from the list')
            .setRequired(false)
            .setMaxLength(25)))
    .addSubcommand(subcommand =>
      subcommand.setName('bypass')
        .setDescription('Add a role that bypasses channel restrictions')
        .addStringOption(option =>
          option.setName('action')
            .setDescription('Add or remove bypass role')
            .setRequired(true)
            .addChoices(
              { name: 'Add bypass role', value: 'add' },
              { name: 'Remove bypass role', value: 'remove' }
            ))
        .addRoleOption(option =>
          option.setName('role')
            .setDescription('The role to add/remove from bypass')
            .setRequired(true)))
    .addSubcommand(subcommand =>
      subcommand.setName('list')
        .setDescription('View current channel restrictions'))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  new SlashCommandBuilder()
    .setName('logs')
    .setDescription('Configure server logging')
    .addSubcommand(subcommand =>
      subcommand.setName('enable')
        .setDescription('Enable a log type')
        .addStringOption(option =>
          option.setName('type')
            .setDescription('Type of log to enable')
            .setRequired(true)
            .addChoices({ name: 'All logs', value: 'all' }, ...LOG_TYPE_CHOICES))
        .addChannelOption(option =>
          option.setName('channel')
            .setDescription('Channel for these logs (required if none is set yet)')
            .setRequired(false)
            .addChannelTypes(TEXT_CHANNELS)))
    .addSubcommand(subcommand =>
      subcommand.setName('disable')
        .setDescription('Disable a log type')
        .addStringOption(option =>
          option.setName('type')
            .setDescription('Type of log to disable')
            .setRequired(true)
            .addChoices({ name: 'All logs', value: 'all' }, ...LOG_TYPE_CHOICES)))
    .addSubcommand(subcommand =>
      subcommand.setName('channel')
        .setDescription('Set log channel')
        .addStringOption(option =>
          option.setName('type')
            .setDescription('Type of log')
            .setRequired(true)
            .addChoices(...LOG_TYPE_CHOICES))
        .addChannelOption(option =>
          option.setName('channel')
            .setDescription('The channel for logs')
            .setRequired(true)
            .addChannelTypes(TEXT_CHANNELS)))
    .addSubcommand(subcommand =>
      subcommand.setName('status')
        .setDescription('View current logging settings'))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  new SlashCommandBuilder()
    .setName('autorole')
    .setDescription('Configure auto-role for new members')
    .addSubcommand(subcommand =>
      subcommand.setName('add')
        .setDescription('Add an auto-role')
        .addRoleOption(option =>
          option.setName('role')
            .setDescription('The role to automatically assign')
            .setRequired(true))
        .addStringOption(option =>
          option.setName('type')
            .setDescription('Type of members to assign to')
            .setRequired(false)
            .addChoices(
              { name: 'All members', value: 'all' },
              { name: 'Humans only', value: 'humans' },
              { name: 'Bots only', value: 'bots' }
            )))
    .addSubcommand(subcommand =>
      subcommand.setName('remove')
        .setDescription('Remove an auto-role')
        .addRoleOption(option =>
          option.setName('role')
            .setDescription('The role to remove from auto-assign')
            .setRequired(true)))
    .addSubcommand(subcommand =>
      subcommand.setName('list')
        .setDescription('View current auto-roles'))
    .addSubcommand(subcommand =>
      subcommand.setName('clear')
        .setDescription('Remove all auto-roles'))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles),

  // No-XP Channels Command
  new SlashCommandBuilder()
    .setName('noxp')
    .setDescription('Manage channels where XP is not earned')
    .addSubcommand(subcommand =>
      subcommand.setName('add')
        .setDescription('Blacklist a channel from earning XP')
        .addChannelOption(option =>
          option.setName('channel')
            .setDescription('The channel to blacklist')
            .setRequired(true)
            .addChannelTypes(TEXT_CHANNELS)))
    .addSubcommand(subcommand =>
      subcommand.setName('remove')
        .setDescription('Remove a channel from the blacklist')
        .addChannelOption(option =>
          option.setName('channel')
            .setDescription('The channel to remove')
            .setRequired(true)
            .addChannelTypes(TEXT_CHANNELS)))
    .addSubcommand(subcommand =>
      subcommand.setName('list')
        .setDescription('View all blacklisted channels'))
    .addSubcommand(subcommand =>
      subcommand.setName('clear')
        .setDescription('Clear all blacklisted channels'))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  // AutoMod Configuration Commands
  new SlashCommandBuilder()
    .setName('automod')
    .setDescription('Configure automod settings')
    .addSubcommand(subcommand =>
      subcommand.setName('enable')
        .setDescription('Enable automod'))
    .addSubcommand(subcommand =>
      subcommand.setName('disable')
        .setDescription('Disable automod'))
    .addSubcommand(subcommand =>
      subcommand.setName('status')
        .setDescription('View current automod settings'))
    .addSubcommand(subcommand =>
      subcommand.setName('badwords')
        .setDescription('Configure bad words filter')
        .addStringOption(option =>
          option.setName('action')
            .setDescription('Action to take')
            .setRequired(true)
            .addChoices(
              { name: 'Add words', value: 'add' },
              { name: 'Remove words', value: 'remove' },
              { name: 'List words', value: 'list' },
              { name: 'Set action', value: 'setaction' },
              { name: 'Enable', value: 'enable' },
              { name: 'Disable', value: 'disable' }
            ))
        .addStringOption(option =>
          option.setName('words')
            .setDescription('Words to add/remove (comma separated)')
            .setRequired(false))
        .addStringOption(option =>
          option.setName('punishment')
            .setDescription('Punishment for bad words')
            .setRequired(false)
            .addChoices(
              { name: 'Delete message', value: 'delete' },
              { name: 'Warn user', value: 'warn' },
              { name: 'Timeout user', value: 'timeout' },
              { name: 'Kick user', value: 'kick' }
            )))
    .addSubcommand(subcommand =>
      subcommand.setName('antispam')
        .setDescription('Configure anti-spam settings')
        .addBooleanOption(option =>
          option.setName('enabled')
            .setDescription('Enable or disable anti-spam')
            .setRequired(true))
        .addIntegerOption(option =>
          option.setName('message_limit')
            .setDescription('Number of messages allowed in time window')
            .setRequired(false)
            .setMinValue(2)
            .setMaxValue(20))
        .addIntegerOption(option =>
          option.setName('time_window')
            .setDescription('Time window in seconds')
            .setRequired(false)
            .setMinValue(3)
            .setMaxValue(30)))
    .addSubcommand(subcommand =>
      subcommand.setName('antiraid')
        .setDescription('Configure anti-raid settings')
        .addBooleanOption(option =>
          option.setName('enabled')
            .setDescription('Enable or disable anti-raid')
            .setRequired(true))
        .addIntegerOption(option =>
          option.setName('join_threshold')
            .setDescription('Number of joins to trigger raid mode')
            .setRequired(false)
            .setMinValue(5)
            .setMaxValue(50))
        .addStringOption(option =>
          option.setName('action')
            .setDescription('Action when raid is detected')
            .setRequired(false)
            .addChoices(
              { name: 'Lockdown server', value: 'lockdown' },
              { name: 'Kick new members', value: 'kick' },
              { name: 'Ban new members', value: 'ban' }
            )))
    .addSubcommand(subcommand =>
      subcommand.setName('antinuke')
        .setDescription('Configure anti-nuke settings')
        .addBooleanOption(option =>
          option.setName('enabled')
            .setDescription('Enable or disable anti-nuke')
            .setRequired(true))
        .addStringOption(option =>
          option.setName('action')
            .setDescription('Action when nuke is detected')
            .setRequired(false)
            .addChoices(
              { name: 'Remove roles', value: 'removeRoles' },
              { name: 'Kick user', value: 'kick' },
              { name: 'Ban user', value: 'ban' }
            )))
    .addSubcommand(subcommand =>
      subcommand.setName('ignore-add-channel')
        .setDescription('Add a channel to automod ignore list')
        .addChannelOption(option =>
          option.setName('channel')
            .setDescription('The channel to ignore')
            .setRequired(true)
            .addChannelTypes(MESSAGE_CHANNELS)))
    .addSubcommand(subcommand =>
      subcommand.setName('ignore-remove-channel')
        .setDescription('Remove a channel from automod ignore list')
        .addChannelOption(option =>
          option.setName('channel')
            .setDescription('The channel to stop ignoring')
            .setRequired(true)
            .addChannelTypes(MESSAGE_CHANNELS)))
    .addSubcommand(subcommand =>
      subcommand.setName('ignore-add-role')
        .setDescription('Add a role to automod bypass list')
        .addRoleOption(option =>
          option.setName('role')
            .setDescription('The role to bypass automod')
            .setRequired(true)))
    .addSubcommand(subcommand =>
      subcommand.setName('ignore-remove-role')
        .setDescription('Remove a role from automod bypass list')
        .addRoleOption(option =>
          option.setName('role')
            .setDescription('The role to remove from bypass')
            .setRequired(true)))
    .addSubcommand(subcommand =>
      subcommand.setName('ignore-list')
        .setDescription('List all automod ignore settings'))
    .addSubcommand(subcommand =>
      subcommand.setName('badwords-ignore')
        .setDescription('Add words to the bad words whitelist/ignore list')
        .addStringOption(option =>
          option.setName('words')
            .setDescription('Words to ignore (comma separated)')
            .setRequired(true)))
    .addSubcommand(subcommand =>
      subcommand.setName('badwords-unignore')
        .setDescription('Remove words from the bad words whitelist')
        .addStringOption(option =>
          option.setName('words')
            .setDescription('Words to remove from whitelist (comma separated)')
            .setRequired(true)))
    .addSubcommand(subcommand =>
      subcommand.setName('badwords-ignoredlist')
        .setDescription('View all ignored/whitelisted bad words'))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  // Lockdown Command
  new SlashCommandBuilder()
    .setName('lockdown')
    .setDescription('Lock or unlock the server')
    .addStringOption(option =>
      option.setName('action')
        .setDescription('Lock or unlock')
        .setRequired(true)
        .addChoices(
          { name: 'Lock server', value: 'on' },
          { name: 'Unlock server', value: 'off' }
        ))
    .addStringOption(option =>
      option.setName('reason')
        .setDescription('Reason for lockdown')
        .setRequired(false)
        .setMaxLength(AUDIT_REASON_MAX))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  // Set Role Command  
  new SlashCommandBuilder()
    .setName('setrole')
    .setDescription('Configure roles for bot features')
    .addStringOption(option =>
      option.setName('type')
        .setDescription('Type of role to set')
        .setRequired(true)
        .addChoices(
          { name: 'Staff/Moderator', value: 'staff' },
          { name: 'Admin', value: 'admin' },
          { name: 'Suspicious member', value: 'sus' },
          { name: 'New account', value: 'newaccount' },
          { name: 'Muted', value: 'muted' }
        ))
    .addRoleOption(option =>
      option.setName('role')
        .setDescription('The role to set')
        .setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  // Set Channel Command
  new SlashCommandBuilder()
    .setName('setchannel')
    .setDescription('Configure channels for bot features')
    .addStringOption(option =>
      option.setName('type')
        .setDescription('Type of channel to set')
        .setRequired(true)
        .addChoices(
          { name: 'Mod Log', value: 'modlog' },
          { name: 'Alert Log', value: 'alertlog' },
          { name: 'Join Log', value: 'joinlog' },
          { name: 'Leave Log', value: 'leavelog' },
          { name: 'Message Log', value: 'messagelog' },
          { name: 'Staff Channel', value: 'staff' }
        ))
    .addChannelOption(option =>
      option.setName('channel')
        .setDescription('The channel to set')
        .setRequired(true)
        .addChannelTypes(POSTABLE_CHANNELS))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  // Slash Command Management
  new SlashCommandBuilder()
    .setName('slashcommands')
    .setDescription('Manage slash commands')
    .addSubcommand(subcommand =>
      subcommand.setName('enable')
        .setDescription('Enable a slash command')
        .addStringOption(option =>
          option.setName('command')
            .setDescription('Command to enable')
            .setRequired(true)
            .setMaxLength(COMMAND_NAME_MAX)))
    .addSubcommand(subcommand =>
      subcommand.setName('disable')
        .setDescription('Disable a slash command')
        .addStringOption(option =>
          option.setName('command')
            .setDescription('Command to disable')
            .setRequired(true)
            .setMaxLength(COMMAND_NAME_MAX)))
    .addSubcommand(subcommand =>
      subcommand.setName('list')
        .setDescription('List all slash commands and their status'))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  // Refresh Cache Command
  new SlashCommandBuilder()
    .setName('refreshcache')
    .setDescription('Refresh cached data for this server')
    .addStringOption(option =>
      option.setName('type')
        .setDescription('Type of cache to refresh')
        .setRequired(false)
        .addChoices(
          { name: 'All', value: 'all' },
          { name: 'Guild Settings', value: 'guild' },
          { name: 'Members', value: 'members' },
          { name: 'Roles', value: 'roles' },
          { name: 'Channels', value: 'channels' },
          { name: 'Invites', value: 'invites' }
        ))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  // Set Overlay Command (Admin)
  new SlashCommandBuilder()
    .setName('setoverlay')
    .setDescription('Configure server-wide overlay for profile and level cards')
    .addSubcommand(subcommand =>
      subcommand
        .setName('color')
        .setDescription('Set the overlay color for all cards')
        .addStringOption(option =>
          option.setName('hex')
            .setDescription('Hex color (e.g., #000000, #1a1a2e)')
            .setRequired(true)))
    .addSubcommand(subcommand =>
      subcommand
        .setName('opacity')
        .setDescription('Set the overlay opacity for all cards')
        .addIntegerOption(option =>
          option.setName('percent')
            .setDescription('Opacity percentage (0-100)')
            .setRequired(true)
            .setMinValue(0)
            .setMaxValue(100)))
    .addSubcommand(subcommand =>
      subcommand
        .setName('view')
        .setDescription('View current overlay settings'))
    .addSubcommand(subcommand =>
      subcommand
        .setName('reset')
        .setDescription('Reset overlay settings to default'))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  // Set Profile Command (User)
  new SlashCommandBuilder()
    .setName('setprofile')
    .setDescription('Customize your profile settings')
    .addSubcommand(subcommand =>
      subcommand
        .setName('description')
        .setDescription('Set your profile description (max 500 chars)')
        .addStringOption(option =>
          option.setName('text')
            .setDescription('Your description text (leave empty to clear)')
            .setRequired(false)
            .setMaxLength(500)))
    .addSubcommandGroup(group =>
      group
        .setName('overlay')
        .setDescription('Customize your card overlay')
        .addSubcommand(subcommand =>
          subcommand
            .setName('color')
            .setDescription('Set your overlay color')
            .addStringOption(option =>
              option.setName('hex')
                .setDescription('Hex color (e.g., #000000)')
                .setRequired(true)))
        .addSubcommand(subcommand =>
          subcommand
            .setName('opacity')
            .setDescription('Set your overlay opacity')
            .addIntegerOption(option =>
              option.setName('percent')
                .setDescription('Opacity percentage (0-100)')
                .setRequired(true)
                .setMinValue(0)
                .setMaxValue(100))))
    .addSubcommand(subcommand =>
      subcommand
        .setName('view')
        .setDescription('View your current profile settings'))
    .addSubcommand(subcommand =>
      subcommand
        .setName('reset')
        .setDescription('Reset overlay customizations to default')),

  // Birthday Settings Command (Admin)
  new SlashCommandBuilder()
    .setName('birthdaysettings')
    .setDescription('Configure birthday system settings (Admin)')
    .addSubcommand(subcommand =>
      subcommand.setName('channel')
        .setDescription('Set the birthday announcement channel')
        .addChannelOption(option =>
          option.setName('channel')
            .setDescription('Channel for birthday announcements')
            .setRequired(true)
            .addChannelTypes(POSTABLE_CHANNELS)))
    .addSubcommand(subcommand =>
      subcommand.setName('role')
        .setDescription('Set the birthday role to assign')
        .addRoleOption(option =>
          option.setName('role')
            .setDescription('Role to give on birthdays')
            .setRequired(true)))
    .addSubcommand(subcommand =>
      subcommand.setName('message')
        .setDescription('Set custom birthday message')
        .addStringOption(option =>
          option.setName('message')
            .setDescription('Custom message ({user} = mention, {username} = name, {age} = age)')
            .setRequired(true)
            .setMaxLength(MESSAGE_TEXT_MAX)))
    .addSubcommand(subcommand =>
      subcommand.setName('enable')
        .setDescription('Enable the birthday system'))
    .addSubcommand(subcommand =>
      subcommand.setName('disable')
        .setDescription('Disable the birthday system'))
    .addSubcommand(subcommand =>
      subcommand.setName('status')
        .setDescription('View current birthday settings'))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  // Set Birthday Command (Admin)
  new SlashCommandBuilder()
    .setName('setbirthday')
    .setDescription('Set a member\'s birthday (Admin)')
    .addUserOption(option =>
      option.setName('user')
        .setDescription('The user to set birthday for')
        .setRequired(true))
    .addIntegerOption(option =>
      option.setName('month')
        .setDescription('Birth month (1-12)')
        .setRequired(true)
        .setMinValue(1)
        .setMaxValue(12))
    .addIntegerOption(option =>
      option.setName('day')
        .setDescription('Birth day (1-31)')
        .setRequired(true)
        .setMinValue(1)
        .setMaxValue(31))
    .addIntegerOption(option =>
      option.setName('year')
        .setDescription('Birth year (optional, for age)')
        .setRequired(false)
        .setMinValue(1900)
        .setMaxValue(new Date().getFullYear()))
    .addBooleanOption(option =>
      option.setName('private')
        .setDescription('Hide age in announcements')
        .setRequired(false))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles),

  // Config Command
  new SlashCommandBuilder()
    .setName('config')
    .setDescription('View or change server configuration')
    .addSubcommand(subcommand =>
      subcommand.setName('view')
        .setDescription('View current server configuration'))
    .addSubcommand(subcommand =>
      subcommand.setName('prefix')
        .setDescription('Change the bot prefix')
        .addStringOption(option =>
          option.setName('prefix')
            .setDescription('New prefix (1-5 characters)')
            .setRequired(true)
            .setMaxLength(5)))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  // Setup Command
  new SlashCommandBuilder()
    .setName('setup')
    .setDescription('Run the initial server setup wizard')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  // Shop Management Command (Backgrounds only)
  new SlashCommandBuilder()
    .setName('manageshop')
    .setDescription('Add, remove, or modify shop backgrounds')
    .addSubcommand(subcommand =>
      subcommand.setName('add')
        .setDescription('Add a new background to the shop')
        .addStringOption(option =>
          option.setName('name')
            .setDescription('Background name')
            .setRequired(true)
            .setMaxLength(100))
        .addIntegerOption(option =>
          option.setName('price')
            .setDescription('Background price')
            .setRequired(true)
            .setMinValue(0))
        .addStringOption(option =>
          option.setName('image')
            .setDescription('Background image URL (http or https)')
            .setRequired(true)
            .setMaxLength(1000))
        .addStringOption(option =>
          option.setName('description')
            .setDescription('Background description')
            .setRequired(false)
            .setMaxLength(500)))
    .addSubcommand(subcommand =>
      subcommand.setName('remove')
        .setDescription('Remove an item from the shop')
        .addStringOption(option =>
          option.setName('id')
            .setDescription('Item ID to remove')
            .setRequired(true)))
    .addSubcommand(subcommand =>
      subcommand.setName('list')
        .setDescription('List all custom shop items'))
    .addSubcommand(subcommand =>
      subcommand.setName('setprice')
        .setDescription('Change item price')
        .addStringOption(option =>
          option.setName('id')
            .setDescription('Item ID')
            .setRequired(true))
        .addIntegerOption(option =>
          option.setName('price')
            .setDescription('New price')
            .setRequired(true)
            .setMinValue(0)))
    .addSubcommand(subcommand =>
      subcommand.setName('edit')
        .setDescription('Edit background properties')
        .addStringOption(option =>
          option.setName('id')
            .setDescription('Background ID')
            .setRequired(true))
        .addStringOption(option =>
          option.setName('field')
            .setDescription('Field to edit')
            .setRequired(true)
            .addChoices(
              { name: 'Name', value: 'name' },
              { name: 'Description', value: 'description' },
              { name: 'Image URL', value: 'image' }
            ))
        .addStringOption(option =>
          option.setName('value')
            .setDescription('New value (name: 100, description: 500 characters; image: http or https URL)')
            .setRequired(true)
            .setMaxLength(1000)))
    .addSubcommand(subcommand =>
      subcommand.setName('stock')
        .setDescription('Set stock amount')
        .addStringOption(option =>
          option.setName('id')
            .setDescription('Item ID')
            .setRequired(true))
        .addIntegerOption(option =>
          option.setName('amount')
            .setDescription('Stock amount (-1 for unlimited)')
            .setRequired(true)
            .setMinValue(-1)))
    .addSubcommand(subcommand =>
      subcommand.setName('fallback')
        .setDescription('Set default background for profiles')
        .addStringOption(option =>
          option.setName('type')
            .setDescription('Fallback type')
            .setRequired(true)
            .addChoices(
              { name: 'Image URL', value: 'url' },
              { name: 'Color', value: 'color' },
              { name: 'Clear/Reset', value: 'clear' }
            ))
        .addStringOption(option =>
          option.setName('value')
            .setDescription('URL or hex color (e.g., #FF0000)')
            .setRequired(false)
            .setMaxLength(1000)))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  // Feature Management (Enable/Disable commands and features)
  new SlashCommandBuilder()
    .setName('feature')
    .setDescription('『 RAPHAEL 』 Enable or disable bot commands and features, Master')
    .addStringOption(option =>
      option.setName('type')
        .setDescription('Select command/feature to manage')
        .setRequired(true)
        .addChoices(
          // Economy
          { name: 'Economy (balance, daily, shop, etc.)', value: 'economy' },
          { name: 'Gambling (slots, blackjack, coinflip, etc.)', value: 'gambling' },
          { name: 'Leveling (level, leaderboard, levelup)', value: 'leveling' },
          // Fun
          { name: 'Games (trivia, tictactoe)', value: 'games' },
          { name: 'Fun (meme, gif, poll)', value: 'fun' },
          // Community
          { name: 'Birthdays', value: 'birthdays' },
          { name: 'Giveaways', value: 'giveaways' },
          { name: 'Events', value: 'events' },
          { name: 'Starboard', value: 'starboard' },
          // Server Messages
          { name: 'Welcome & Goodbye Messages', value: 'welcome' },
          { name: 'Server Boost Announcements', value: 'boost' },
          // Utility
          { name: 'Tickets', value: 'tickets' },
          { name: 'AFK', value: 'afk' },
          { name: 'Reminders', value: 'reminders' },
          // Moderation
          { name: 'AutoMod', value: 'automod' },
          // Systems
          { name: 'AI Chat (Raphael)', value: 'aichat' },
          { name: 'Troll Mode (AI Chat)', value: 'troll' },
          { name: 'Profile Customization (member overlays)', value: 'profilecustomization' },
          // Single commands
          { name: 'Custom Command (specify name)', value: 'custom' }
        ))
    .addStringOption(option =>
      option.setName('status')
        .setDescription('Enable or disable')
        .setRequired(true)
        .addChoices(
          { name: 'Enable', value: 'enable' },
          { name: 'Disable', value: 'disable' },
          { name: 'View Status', value: 'status' }
        ))
    .addStringOption(option =>
      option.setName('command')
        .setDescription('Command name (only for "Custom Command" type)')
        .setRequired(false)
        .setMaxLength(COMMAND_NAME_MAX))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  // Giveaway Command
  new SlashCommandBuilder()
    .setName('giveaway')
    .setDescription('Create and manage giveaways')
    .addSubcommand(subcommand =>
      subcommand.setName('start')
        .setDescription('Start a new giveaway')
        .addStringOption(option =>
          option.setName('duration')
            .setDescription('How long entries stay open')
            .setRequired(true)
            .addChoices(
              { name: '10 minutes', value: '10m' },
              { name: '30 minutes', value: '30m' },
              { name: '1 hour', value: '1h' },
              { name: '6 hours', value: '6h' },
              { name: '12 hours', value: '12h' },
              { name: '1 day', value: '1d' },
              { name: '3 days', value: '3d' },
              { name: '1 week', value: '1w' },
              { name: '2 weeks', value: '2w' },
              { name: '30 days (maximum)', value: '30d' }
            ))
        .addIntegerOption(option =>
          option.setName('winners')
            .setDescription('Number of winners (1-20)')
            .setRequired(true)
            .setMinValue(1)
            .setMaxValue(20))
        .addStringOption(option =>
          option.setName('prize')
            .setDescription('What is the prize?')
            .setRequired(true)
            .setMaxLength(256))
        .addRoleOption(option =>
          option.setName('required_role')
            .setDescription('Role required to enter and to win (optional)')
            .setRequired(false)))
    .addSubcommand(subcommand =>
      subcommand.setName('end')
        .setDescription('End a giveaway early')
        .addStringOption(option =>
          option.setName('message_id')
            .setDescription('Giveaway message ID or message link (see /giveaway list)')
            .setRequired(true)))
    .addSubcommand(subcommand =>
      subcommand.setName('reroll')
        .setDescription('Pick new winner(s) for an ended giveaway')
        .addStringOption(option =>
          option.setName('message_id')
            .setDescription('Giveaway message ID or message link (see /giveaway list)')
            .setRequired(true))
        .addIntegerOption(option =>
          option.setName('count')
            .setDescription('How many new winners to draw (default 1; previous winners are skipped)')
            .setRequired(false)
            .setMinValue(1)
            .setMaxValue(20)))
    .addSubcommand(subcommand =>
      subcommand.setName('list')
        .setDescription('View active and recently ended giveaways, with their message IDs'))
    .addSubcommand(subcommand =>
      subcommand.setName('delete')
        .setDescription('Cancel and delete a giveaway')
        .addStringOption(option =>
          option.setName('message_id')
            .setDescription('Giveaway message ID or message link (see /giveaway list)')
            .setRequired(true)))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  // Award Command (XP, Coins, Rep)
  new SlashCommandBuilder()
    .setName('award')
    .setDescription('Award or deduct XP, coins, or reputation from a user')
    .addStringOption(option =>
      option.setName('type')
        .setDescription('What to award')
        .setRequired(true)
        .addChoices(
          { name: 'XP (Experience)', value: 'xp' },
          { name: 'Coins (Currency)', value: 'coins' },
          { name: 'Rep (Reputation)', value: 'rep' }
        ))
    .addUserOption(option =>
      option.setName('user')
        .setDescription('The user to award')
        .setRequired(true))
    .addIntegerOption(option =>
      option.setName('amount')
        .setDescription('Amount to add (positive) or remove (negative)')
        .setRequired(true)
        .setMinValue(-10000000)
        .setMaxValue(10000000))
    .addStringOption(option =>
      option.setName('reason')
        .setDescription('Reason for the award (optional)')
        .setRequired(false)
        .setMaxLength(REASON_MAX))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  // Welcome System Command
  new SlashCommandBuilder()
    .setName('welcome')
    .setDescription('Configure welcome messages for new members')
    .addSubcommand(subcommand =>
      subcommand.setName('enable')
        .setDescription('Enable the welcome system'))
    .addSubcommand(subcommand =>
      subcommand.setName('disable')
        .setDescription('Disable the welcome system'))
    .addSubcommand(subcommand =>
      subcommand.setName('status')
        .setDescription('View current welcome settings'))
    .addSubcommand(subcommand =>
      subcommand.setName('test')
        .setDescription('Test the welcome message'))
    .addSubcommand(subcommand =>
      subcommand.setName('preview')
        .setDescription('Preview the welcome message'))
    .addSubcommand(subcommand =>
      subcommand.setName('reset')
        .setDescription('Reset all welcome settings to default'))
    .addSubcommand(subcommand =>
      subcommand.setName('help')
        .setDescription('Show all welcome commands'))
    .addSubcommand(subcommand =>
      subcommand.setName('channel')
        .setDescription('Set the welcome channel')
        .addChannelOption(option =>
          option.setName('channel')
            .setDescription('The channel to send welcome messages to')
            .setRequired(true)
            .addChannelTypes(POSTABLE_CHANNELS)))
    .addSubcommand(subcommand =>
      subcommand.setName('message')
        .setDescription('Set the welcome message (embed description)')
        .addStringOption(option =>
          option.setName('text')
            .setDescription('The welcome message text. Use {user}, {username}, {server}, {membercount}')
            .setRequired(true)
            .setMaxLength(MESSAGE_TEXT_MAX)))
    .addSubcommand(subcommand =>
      subcommand.setName('title')
        .setDescription('Set the embed title')
        .addStringOption(option =>
          option.setName('text')
            .setDescription('Title text (use "reset" for default stars, "none" to remove)')
            .setRequired(true)
            .setMaxLength(TITLE_MAX)))
    .addSubcommand(subcommand =>
      subcommand.setName('footer')
        .setDescription('Set the embed footer')
        .addStringOption(option =>
          option.setName('text')
            .setDescription('Footer text (use "reset" for default, "none" to remove)')
            .setRequired(true)
            .setMaxLength(MESSAGE_TEXT_MAX)))
    .addSubcommand(subcommand =>
      subcommand.setName('greet')
        .setDescription('Set the greeting text above the embed')
        .addStringOption(option =>
          option.setName('text')
            .setDescription('Greeting text (shown when mention is on). Use {user}')
            .setRequired(true)
            .setMaxLength(MESSAGE_TEXT_MAX)))
    .addSubcommand(subcommand =>
      subcommand.setName('color')
        .setDescription('Set the embed color')
        .addStringOption(option =>
          option.setName('hex')
            .setDescription('Hex color code (e.g., #5432A6) or "reset"')
            .setRequired(true)))
    .addSubcommand(subcommand =>
      subcommand.setName('image')
        .setDescription('Set the banner image')
        .addStringOption(option =>
          option.setName('url')
            .setDescription('Image URL or "remove" to delete')
            .setRequired(true)))
    .addSubcommand(subcommand =>
      subcommand.setName('thumbnail')
        .setDescription('Set the thumbnail')
        .addStringOption(option =>
          option.setName('type')
            .setDescription('Thumbnail type or URL')
            .setRequired(true)
            .addChoices(
              { name: 'User Avatar', value: 'avatar' },
              { name: 'Server Icon', value: 'server' },
              { name: 'Remove', value: 'remove' }
            )))
    .addSubcommand(subcommand =>
      subcommand.setName('author')
        .setDescription('Set the author section style')
        .addStringOption(option =>
          option.setName('type')
            .setDescription('Author display type')
            .setRequired(true)
            .addChoices(
              { name: 'Username (with avatar)', value: 'username' },
              { name: 'Display Name (with avatar)', value: 'displayname' },
              { name: 'Server (with icon)', value: 'server' },
              { name: 'None', value: 'none' }
            )))
    .addSubcommand(subcommand =>
      subcommand.setName('embed')
        .setDescription('Toggle embed mode')
        .addBooleanOption(option =>
          option.setName('enabled')
            .setDescription('Enable or disable embed mode')
            .setRequired(true)))
    .addSubcommand(subcommand =>
      subcommand.setName('mention')
        .setDescription('Toggle user mention above embed')
        .addBooleanOption(option =>
          option.setName('enabled')
            .setDescription('Enable or disable mentioning user')
            .setRequired(true)))
    .addSubcommand(subcommand =>
      subcommand.setName('dm')
        .setDescription('Toggle DM welcome message')
        .addBooleanOption(option =>
          option.setName('enabled')
            .setDescription('Enable or disable DM welcomes')
            .setRequired(true)))
    .addSubcommand(subcommand =>
      subcommand.setName('timestamp')
        .setDescription('Toggle timestamp in embed')
        .addBooleanOption(option =>
          option.setName('enabled')
            .setDescription('Enable or disable timestamp')
            .setRequired(true)))
    .addSubcommand(subcommand =>
      subcommand.setName('role')
        .setDescription('Set auto role for new members')
        .addRoleOption(option =>
          option.setName('role')
            .setDescription('Role to give (leave empty to remove)')
            .setRequired(false)))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  // Confession System Command
  new SlashCommandBuilder()
    .setName('confession')
    .setDescription('Configure the anonymous confession system')
    .addSubcommand(subcommand =>
      subcommand.setName('setup')
        .setDescription('Set up the confession channel')
        .addChannelOption(option =>
          option.setName('channel')
            .setDescription('The channel to post confessions in')
            .setRequired(true)
            .addChannelTypes(TEXT_CHANNELS)))
    .addSubcommand(subcommand =>
      subcommand.setName('disable')
        .setDescription('Disable the confession system'))
    .addSubcommand(subcommand =>
      subcommand.setName('settings')
        .setDescription('View current confession settings'))
    .addSubcommand(subcommand =>
      subcommand.setName('cooldown')
        .setDescription('Set confession cooldown')
        .addIntegerOption(option =>
          option.setName('seconds')
            .setDescription('Cooldown in seconds (0-3600)')
            .setRequired(true)
            .setMinValue(0)
            .setMaxValue(3600)))
    .addSubcommand(subcommand =>
      subcommand.setName('replies')
        .setDescription('Toggle confession replies')
        .addBooleanOption(option =>
          option.setName('enabled')
            .setDescription('Enable or disable replies')
            .setRequired(true)))
    .addSubcommand(subcommand =>
      subcommand.setName('anonymous-replies')
        .setDescription('Toggle anonymous replies')
        .addBooleanOption(option =>
          option.setName('enabled')
            .setDescription('Make replies anonymous')
            .setRequired(true)))
    .addSubcommand(subcommand =>
      subcommand.setName('approval')
        .setDescription('Toggle confession approval requirement')
        .addBooleanOption(option =>
          option.setName('enabled')
            .setDescription('Require approval before posting')
            .setRequired(true)))
    .addSubcommand(subcommand =>
      subcommand.setName('ban')
        .setDescription('Ban a user from confessions')
        .addUserOption(option =>
          option.setName('user')
            .setDescription('The user to ban')
            .setRequired(true)))
    .addSubcommand(subcommand =>
      subcommand.setName('unban')
        .setDescription('Unban a user from confessions')
        .addUserOption(option =>
          option.setName('user')
            .setDescription('The user to unban')
            .setRequired(true)))
    .addSubcommand(subcommand =>
      subcommand.setName('pending')
        .setDescription('View pending confessions'))
    .addSubcommand(subcommand =>
      subcommand.setName('approve')
        .setDescription('Approve a pending confession')
        .addIntegerOption(option =>
          option.setName('id')
            .setDescription('The pending confession ID')
            .setRequired(true)
            .setMinValue(1)))
    .addSubcommand(subcommand =>
      subcommand.setName('reject')
        .setDescription('Reject a pending confession')
        .addIntegerOption(option =>
          option.setName('id')
            .setDescription('The pending confession ID')
            .setRequired(true)
            .setMinValue(1)))
    .addSubcommand(subcommand =>
      subcommand.setName('send')
        .setDescription('Send confession panel to a channel')
        .addChannelOption(option =>
          option.setName('channel')
            .setDescription('Channel to send panel (defaults to confession channel)')
            .setRequired(false)
            .addChannelTypes(TEXT_CHANNELS)))
    .addSubcommand(subcommand =>
      subcommand.setName('stats')
        .setDescription('View confession statistics'))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  // Onboarding Management Command
  new SlashCommandBuilder()
    .setName('onboarding')
    .setDescription('Manage server onboarding settings, questions, and default channels')
    .addSubcommandGroup(group =>
      group.setName('settings')
        .setDescription('Manage onboarding settings')
        .addSubcommand(subcommand =>
          subcommand.setName('view')
            .setDescription('View current onboarding settings'))
        .addSubcommand(subcommand =>
          subcommand.setName('enable')
            .setDescription('Enable server onboarding'))
        .addSubcommand(subcommand =>
          subcommand.setName('disable')
            .setDescription('Disable server onboarding')))
    .addSubcommandGroup(group =>
      group.setName('channels')
        .setDescription('Manage default channels')
        .addSubcommand(subcommand =>
          subcommand.setName('list')
            .setDescription('View default channels'))
        .addSubcommand(subcommand =>
          subcommand.setName('add')
            .setDescription('Add a default channel')
            .addChannelOption(option =>
              option.setName('channel')
                .setDescription('Channel to add as default')
                .setRequired(true)
                .addChannelTypes(ONBOARDING_CHANNELS)))
        .addSubcommand(subcommand =>
          subcommand.setName('remove')
            .setDescription('Remove a default channel')
            .addChannelOption(option =>
              option.setName('channel')
                .setDescription('Channel to remove')
                .setRequired(true)
                .addChannelTypes(ONBOARDING_CHANNELS))))
    .addSubcommandGroup(group =>
      group.setName('questions')
        .setDescription('Manage onboarding questions')
        .addSubcommand(subcommand =>
          subcommand.setName('list')
            .setDescription('View all questions'))
        .addSubcommand(subcommand =>
          subcommand.setName('add')
            .setDescription('Create a new question with initial option')
            .addStringOption(option =>
              option.setName('title')
                .setDescription('Question title/text')
                .setRequired(true)
                .setMaxLength(100))
            .addStringOption(option =>
              option.setName('option_title')
                .setDescription('First option title (required)')
                .setRequired(true)
                .setMaxLength(50))
            .addRoleOption(option =>
              option.setName('option_role')
                .setDescription('Role to assign for this option (required if no channel)')
                .setRequired(false))
            .addChannelOption(option =>
              option.setName('option_channel')
                .setDescription('Channel to show for this option (required if no role)')
                .setRequired(false)
                .addChannelTypes(ONBOARDING_CHANNELS))
            .addBooleanOption(option =>
              option.setName('required')
                .setDescription('Is this question required?')
                .setRequired(false))
            .addBooleanOption(option =>
              option.setName('single_select')
                .setDescription('Can only select one answer?')
                .setRequired(false)))
        .addSubcommand(subcommand =>
          subcommand.setName('edit')
            .setDescription('Edit a question')
            .addStringOption(option =>
              option.setName('question')
                .setDescription('Select the question to edit')
                .setRequired(true)
                .setAutocomplete(true))
            .addStringOption(option =>
              option.setName('title')
                .setDescription('New title (leave empty to keep current)')
                .setRequired(false)
                .setMaxLength(100))
            .addBooleanOption(option =>
              option.setName('required')
                .setDescription('Is this question required?')
                .setRequired(false))
            .addBooleanOption(option =>
              option.setName('single_select')
                .setDescription('Can only select one answer?')
                .setRequired(false)))
        .addSubcommand(subcommand =>
          subcommand.setName('delete')
            .setDescription('Delete a question')
            .addStringOption(option =>
              option.setName('question')
                .setDescription('Select the question to delete')
                .setRequired(true)
                .setAutocomplete(true))))
    .addSubcommandGroup(group =>
      group.setName('options')
        .setDescription('Manage question options/answers')
        .addSubcommand(subcommand =>
          subcommand.setName('list')
            .setDescription('View options for a question')
            .addStringOption(option =>
              option.setName('question')
                .setDescription('Select the question')
                .setRequired(true)
                .setAutocomplete(true)))
        .addSubcommand(subcommand =>
          subcommand.setName('add')
            .setDescription('Add an option to a question')
            .addStringOption(option =>
              option.setName('question')
                .setDescription('Select the question')
                .setRequired(true)
                .setAutocomplete(true))
            .addStringOption(option =>
              option.setName('title')
                .setDescription('Option title')
                .setRequired(true)
                .setMaxLength(50))
            .addRoleOption(option =>
              option.setName('role')
                .setDescription('Role to assign when selected (required if no channel)')
                .setRequired(false))
            .addChannelOption(option =>
              option.setName('channel')
                .setDescription('Channel to show when selected (required if no role)')
                .setRequired(false)
                .addChannelTypes(ONBOARDING_CHANNELS))
            .addStringOption(option =>
              option.setName('description')
                .setDescription('Option description')
                .setRequired(false)
                .setMaxLength(100))
            .addStringOption(option =>
              option.setName('emoji')
                .setDescription('Emoji for this option')
                .setRequired(false)))
        .addSubcommand(subcommand =>
          subcommand.setName('remove')
            .setDescription('Remove an option from a question')
            .addStringOption(option =>
              option.setName('question')
                .setDescription('Select the question')
                .setRequired(true)
                .setAutocomplete(true))
            .addStringOption(option =>
              option.setName('option')
                .setDescription('Select the option to remove')
                .setRequired(true)
                .setAutocomplete(true)))
        .addSubcommand(subcommand =>
          subcommand.setName('role')
            .setDescription('Add/remove a role assignment for an option')
            .addStringOption(option =>
              option.setName('question')
                .setDescription('Select the question')
                .setRequired(true)
                .setAutocomplete(true))
            .addStringOption(option =>
              option.setName('option')
                .setDescription('Select the option')
                .setRequired(true)
                .setAutocomplete(true))
            .addRoleOption(option =>
              option.setName('role')
                .setDescription('Role to assign')
                .setRequired(true))
            .addBooleanOption(option =>
              option.setName('remove')
                .setDescription('Remove this role instead of adding?')
                .setRequired(false)))
        .addSubcommand(subcommand =>
          subcommand.setName('channel')
            .setDescription('Add/remove a channel assignment for an option')
            .addStringOption(option =>
              option.setName('question')
                .setDescription('Select the question')
                .setRequired(true)
                .setAutocomplete(true))
            .addStringOption(option =>
              option.setName('option')
                .setDescription('Select the option')
                .setRequired(true)
                .setAutocomplete(true))
            .addChannelOption(option =>
              option.setName('channel')
                .setDescription('Channel to assign')
                .setRequired(true)
                .addChannelTypes(ONBOARDING_CHANNELS))
            .addBooleanOption(option =>
              option.setName('remove')
                .setDescription('Remove this channel instead of adding?')
                .setRequired(false))))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  // ============================================
  // BOOST SYSTEM COMMAND
  // ============================================
  new SlashCommandBuilder()
    .setName('boost')
    .setDescription('『 RAPHAEL 』 Configure boost appreciation protocols and temporary booster roles, Master')
    .addSubcommand(subcommand =>
      subcommand.setName('status')
        .setDescription('Analyze current boost configuration'))
    .addSubcommand(subcommand =>
      subcommand.setName('test')
        .setDescription('Execute test boost message'))
    .addSubcommand(subcommand =>
      subcommand.setName('preview')
        .setDescription('Preview boost message in current channel'))
    .addSubcommand(subcommand =>
      subcommand.setName('reset')
        .setDescription('Reset boost message settings (also disables boost messages)'))
    .addSubcommand(subcommand =>
      subcommand.setName('channel')
        .setDescription('Designate boost message channel')
        .addChannelOption(option =>
          option.setName('channel')
            .setDescription('Target channel for boost messages')
            .setRequired(true)
            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)))
    .addSubcommand(subcommand =>
      subcommand.setName('message')
        .setDescription('Configure boost message content')
        .addStringOption(option =>
          option.setName('text')
            .setDescription('Message text. Variables: {user}, {username}, {server}, {boostcount}')
            .setRequired(true)
            .setMaxLength(MESSAGE_TEXT_MAX)))
    .addSubcommand(subcommand =>
      subcommand.setName('title')
        .setDescription('Set embed title')
        .addStringOption(option =>
          option.setName('text')
            .setDescription('Title text (use "reset" for default, "none" to remove)')
            .setRequired(true)
            .setMaxLength(TITLE_MAX)))
    .addSubcommand(subcommand =>
      subcommand.setName('footer')
        .setDescription('Set embed footer')
        .addStringOption(option =>
          option.setName('text')
            .setDescription('Footer text (use "reset" for default, "none" to remove)')
            .setRequired(true)
            .setMaxLength(MESSAGE_TEXT_MAX)))
    .addSubcommand(subcommand =>
      subcommand.setName('greeting')
        .setDescription('Set greeting text above embed')
        .addStringOption(option =>
          option.setName('text')
            .setDescription('Greeting text shown above embed. Use {user}')
            .setRequired(true)
            .setMaxLength(MESSAGE_TEXT_MAX)))
    .addSubcommand(subcommand =>
      subcommand.setName('color')
        .setDescription('Set embed color')
        .addStringOption(option =>
          option.setName('hex')
            .setDescription('Hex color code (e.g., #f47fff) or "reset"')
            .setRequired(true)))
    .addSubcommand(subcommand =>
      subcommand.setName('image')
        .setDescription('Set banner image')
        .addStringOption(option =>
          option.setName('url')
            .setDescription('Image URL or "remove" to delete')
            .setRequired(true)))
    .addSubcommand(subcommand =>
      subcommand.setName('thumbnail')
        .setDescription('Set thumbnail')
        .addStringOption(option =>
          option.setName('type')
            .setDescription('Thumbnail type or URL')
            .setRequired(true)
            .addChoices(
              { name: 'User Avatar', value: 'avatar' },
              { name: 'Server Icon', value: 'server' },
              { name: 'Remove', value: 'remove' }
            )))
    .addSubcommand(subcommand =>
      subcommand.setName('author')
        .setDescription('Set author section style')
        .addStringOption(option =>
          option.setName('type')
            .setDescription('Author display type')
            .setRequired(true)
            .addChoices(
              { name: 'Username (with avatar)', value: 'username' },
              { name: 'Display Name (with avatar)', value: 'displayname' },
              { name: 'Server (with icon)', value: 'server' },
              { name: 'None', value: 'none' }
            )))
    .addSubcommand(subcommand =>
      subcommand.setName('embed')
        .setDescription('Toggle embed mode')
        .addBooleanOption(option =>
          option.setName('enabled')
            .setDescription('Enable or disable embed mode')
            .setRequired(true)))
    .addSubcommand(subcommand =>
      subcommand.setName('mention')
        .setDescription('Toggle user mention above embed')
        .addBooleanOption(option =>
          option.setName('enabled')
            .setDescription('Enable or disable user mention')
            .setRequired(true)))
    .addSubcommand(subcommand =>
      subcommand.setName('timestamp')
        .setDescription('Toggle timestamp in embed')
        .addBooleanOption(option =>
          option.setName('enabled')
            .setDescription('Enable or disable timestamp')
            .setRequired(true)))
    .addSubcommand(subcommand =>
      subcommand.setName('role')
        .setDescription('Set temporary booster role')
        .addRoleOption(option =>
          option.setName('role')
            .setDescription('Role to assign temporarily')
            .setRequired(true)))
    .addSubcommand(subcommand =>
      subcommand.setName('give')
        .setDescription('Assign temporary booster role to user')
        .addUserOption(option =>
          option.setName('user')
            .setDescription('User to receive the role')
            .setRequired(true))
        .addStringOption(option =>
          option.setName('reason')
            .setDescription('Reason for assignment')
            .setRequired(false)
            .setMaxLength(REASON_MAX)))
    .addSubcommand(subcommand =>
      subcommand.setName('take')
        .setDescription('Remove temporary booster role from user')
        .addUserOption(option =>
          option.setName('user')
            .setDescription('User to remove role from')
            .setRequired(true)))
    .addSubcommand(subcommand =>
      subcommand.setName('duration')
        .setDescription('Set temporary role duration')
        .addIntegerOption(option =>
          option.setName('hours')
            .setDescription('Duration in hours (1-720)')
            .setRequired(true)
            .setMinValue(1)
            .setMaxValue(720)))
    .addSubcommand(subcommand =>
      subcommand.setName('list')
        .setDescription('Display active temporary booster roles'))
    .addSubcommand(subcommand =>
      subcommand.setName('clearrole')
        .setDescription('Clear temporary booster role configuration'))
    .addSubcommand(subcommand =>
      subcommand.setName('toggle')
        .setDescription('Turn boost thank you messages on or off')
        .addBooleanOption(option =>
          option.setName('enabled')
            .setDescription('Announce new boosts?')
            .setRequired(true)))
    .addSubcommandGroup(group =>
      group.setName('tier')
        .setDescription('Boost tier reward roles')
        .addSubcommand(subcommand =>
          subcommand.setName('add')
            .setDescription('Add or replace a tier reward (only 1-boost tiers are granted automatically)')
            .addIntegerOption(option =>
              option.setName('count').setDescription('Boosts required').setRequired(true).setMinValue(1).setMaxValue(100))
            .addRoleOption(option =>
              option.setName('role').setDescription('Reward role').setRequired(true))
            .addBooleanOption(option =>
              option.setName('stackable').setDescription('Keep lower tier roles (default: on)').setRequired(false)))
        .addSubcommand(subcommand =>
          subcommand.setName('remove')
            .setDescription('Remove a tier reward')
            .addIntegerOption(option =>
              option.setName('count').setDescription('Boosts required by the tier').setRequired(true).setMinValue(1).setMaxValue(100)))
        .addSubcommand(subcommand =>
          subcommand.setName('list')
            .setDescription('List the tier rewards'))
        .addSubcommand(subcommand =>
          subcommand.setName('clear')
            .setDescription('Remove all tier rewards'))
        .addSubcommand(subcommand =>
          subcommand.setName('stackable')
            .setDescription('Set whether a tier keeps lower tier roles')
            .addIntegerOption(option =>
              option.setName('count').setDescription('Boosts required by the tier').setRequired(true).setMinValue(1).setMaxValue(100))
            .addBooleanOption(option =>
              option.setName('enabled').setDescription('Keep lower tier roles?').setRequired(true)))
        .addSubcommand(subcommand =>
          subcommand.setName('message')
            .setDescription('Show the earned tier role in the boost message')
            .addBooleanOption(option =>
              option.setName('enabled').setDescription('Show the tier reward line?').setRequired(true))))
    .addSubcommandGroup(group =>
      group.setName('perks')
        .setDescription('Booster perks announcement')
        .addSubcommand(subcommand =>
          subcommand.setName('status')
            .setDescription('Show the perks announcement settings'))
        .addSubcommand(subcommand =>
          subcommand.setName('channel')
            .setDescription('Set the perks announcement channel')
            .addChannelOption(option =>
              option.setName('channel').setDescription('Text or announcement channel').setRequired(true)
                .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)))
        .addSubcommand(subcommand =>
          subcommand.setName('message')
            .setDescription('Set the perks message')
            .addStringOption(option =>
              option.setName('text').setDescription('Message or "reset". Variables: {server}, {boostcount}, {boostlevel}, {membercount}')
                .setRequired(true).setMaxLength(MESSAGE_TEXT_MAX)))
        .addSubcommand(subcommand =>
          subcommand.setName('title')
            .setDescription('Set the perks title')
            .addStringOption(option =>
              option.setName('text').setDescription('Title text or "reset"').setRequired(true).setMaxLength(TITLE_MAX)))
        .addSubcommand(subcommand =>
          subcommand.setName('color')
            .setDescription('Set the perks embed color')
            .addStringOption(option =>
              option.setName('hex').setDescription('Hex color code (e.g., #f47fff) or "reset"').setRequired(true)))
        .addSubcommand(subcommand =>
          subcommand.setName('image')
            .setDescription('Set the perks banner image')
            .addStringOption(option =>
              option.setName('url').setDescription('Image URL or "remove"').setRequired(true)))
        .addSubcommand(subcommand =>
          subcommand.setName('thumbnail')
            .setDescription('Set the perks thumbnail')
            .addStringOption(option =>
              option.setName('value').setDescription('"server", "remove" or an image URL').setRequired(true)))
        .addSubcommand(subcommand =>
          subcommand.setName('footer')
            .setDescription('Set the perks footer')
            .addStringOption(option =>
              option.setName('text').setDescription('Footer text or "reset" for the default').setRequired(true).setMaxLength(MESSAGE_TEXT_MAX)))
        .addSubcommand(subcommand =>
          subcommand.setName('tierlist')
            .setDescription('Include the tier rewards list')
            .addBooleanOption(option =>
              option.setName('enabled').setDescription('Show the tier list?').setRequired(true)))
        .addSubcommand(subcommand =>
          subcommand.setName('preview')
            .setDescription('Preview the perks announcement here'))
        .addSubcommand(subcommand =>
          subcommand.setName('publish')
            .setDescription('Post the perks announcement, or update the last one')
            .addStringOption(option =>
              option.setName('mode').setDescription('Update the last announcement (default) or post a new one').setRequired(false)
                .addChoices(
                  { name: 'Update the last announcement', value: 'update' },
                  { name: 'Post a new announcement', value: 'new' }
                )))
        .addSubcommand(subcommand =>
          subcommand.setName('reset')
            .setDescription('Reset all perks announcement settings')))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  // ============================================
  // GOODBYE SYSTEM COMMAND
  // ============================================
  new SlashCommandBuilder()
    .setName('goodbye')
    .setDescription('『 RAPHAEL 』 Configure departure message protocols, Master')
    .addSubcommand(subcommand =>
      subcommand.setName('enable')
        .setDescription('Activate goodbye message system'))
    .addSubcommand(subcommand =>
      subcommand.setName('disable')
        .setDescription('Deactivate goodbye message system'))
    .addSubcommand(subcommand =>
      subcommand.setName('status')
        .setDescription('Analyze current goodbye configuration'))
    .addSubcommand(subcommand =>
      subcommand.setName('test')
        .setDescription('Execute test goodbye message'))
    .addSubcommand(subcommand =>
      subcommand.setName('preview')
        .setDescription('Preview goodbye message in current channel'))
    .addSubcommand(subcommand =>
      subcommand.setName('reset')
        .setDescription('Reset all goodbye settings to default'))
    .addSubcommand(subcommand =>
      subcommand.setName('channel')
        .setDescription('Designate goodbye message channel')
        .addChannelOption(option =>
          option.setName('channel')
            .setDescription('Target channel for goodbye messages')
            .setRequired(true)
            .addChannelTypes(TEXT_CHANNELS)))
    .addSubcommand(subcommand =>
      subcommand.setName('message')
        .setDescription('Configure goodbye message content')
        .addStringOption(option =>
          option.setName('text')
            .setDescription('Message text. Variables: {user}, {username}, {server}, {membercount}')
            .setRequired(true)
            .setMaxLength(MESSAGE_TEXT_MAX)))
    .addSubcommand(subcommand =>
      subcommand.setName('title')
        .setDescription('Set embed title')
        .addStringOption(option =>
          option.setName('text')
            .setDescription('Title text (use "reset" for default, "none" to remove)')
            .setRequired(true)
            .setMaxLength(TITLE_MAX)))
    .addSubcommand(subcommand =>
      subcommand.setName('footer')
        .setDescription('Set embed footer')
        .addStringOption(option =>
          option.setName('text')
            .setDescription('Footer text (use "reset" for default, "none" to remove)')
            .setRequired(true)
            .setMaxLength(MESSAGE_TEXT_MAX)))
    .addSubcommand(subcommand =>
      subcommand.setName('color')
        .setDescription('Set embed color')
        .addStringOption(option =>
          option.setName('hex')
            .setDescription('Hex color code (e.g., #FF4757) or "reset"')
            .setRequired(true)))
    .addSubcommand(subcommand =>
      subcommand.setName('image')
        .setDescription('Set banner image')
        .addStringOption(option =>
          option.setName('url')
            .setDescription('Image URL or "remove" to delete')
            .setRequired(true)))
    .addSubcommand(subcommand =>
      subcommand.setName('thumbnail')
        .setDescription('Set thumbnail')
        .addStringOption(option =>
          option.setName('type')
            .setDescription('Thumbnail type')
            .setRequired(true)
            .addChoices(
              { name: 'User Avatar', value: 'avatar' },
              { name: 'Server Icon', value: 'server' },
              { name: 'Remove', value: 'remove' }
            )))
    .addSubcommand(subcommand =>
      subcommand.setName('embed')
        .setDescription('Toggle embed mode')
        .addBooleanOption(option =>
          option.setName('enabled')
            .setDescription('Enable or disable embed mode')
            .setRequired(true)))
    .addSubcommand(subcommand =>
      subcommand.setName('timestamp')
        .setDescription('Toggle timestamp in embed')
        .addBooleanOption(option =>
          option.setName('enabled')
            .setDescription('Enable or disable timestamp')
            .setRequired(true)))
    .addSubcommand(subcommand =>
      subcommand.setName('showjoindate')
        .setDescription('Toggle showing when user joined')
        .addBooleanOption(option =>
          option.setName('enabled')
            .setDescription('Show join date in goodbye message')
            .setRequired(true)))
    .addSubcommand(subcommand =>
      subcommand.setName('showmembercount')
        .setDescription('Toggle showing member count')
        .addBooleanOption(option =>
          option.setName('enabled')
            .setDescription('Show member count in goodbye message')
            .setRequired(true)))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  // ============================================
  // XP MULTIPLIER COMMAND
  // ============================================
  new SlashCommandBuilder()
    .setName('xpmultiplier')
    .setDescription('『 RAPHAEL 』 Configure XP multiplier protocols for specific roles, Master')
    .addSubcommand(subcommand =>
      subcommand.setName('add')
        .setDescription('Add XP multiplier for a role')
        .addRoleOption(option =>
          option.setName('role')
            .setDescription('Role to add multiplier for')
            .setRequired(true))
        .addNumberOption(option =>
          option.setName('multiplier')
            .setDescription('Multiplier value from 1 to 10 (e.g., 1.5 for 50% more XP)')
            .setRequired(true)
            .setMinValue(1)
            .setMaxValue(10)))
    .addSubcommand(subcommand =>
      subcommand.setName('remove')
        .setDescription('Remove XP multiplier from a role')
        .addRoleOption(option =>
          option.setName('role')
            .setDescription('Role to remove multiplier from')
            .setRequired(true)))
    .addSubcommand(subcommand =>
      subcommand.setName('list')
        .setDescription('Display all configured XP multipliers'))
    .addSubcommand(subcommand =>
      subcommand.setName('booster')
        .setDescription('Set multiplier for server boosters')
        .addNumberOption(option =>
          option.setName('multiplier')
            .setDescription('Multiplier for boosters from 1 to 5 (default: 1.5)')
            .setRequired(true)
            .setMinValue(1)
            .setMaxValue(5)))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  // ============================================
  // LEVEL ROLES COMMAND
  // ============================================
  new SlashCommandBuilder()
    .setName('levelroles')
    .setDescription('『 RAPHAEL 』 Configure role rewards for leveling up, Master')
    .addSubcommand(subcommand =>
      subcommand.setName('add')
        .setDescription('Add a level role reward')
        .addIntegerOption(option =>
          option.setName('level')
            .setDescription('Level required to earn the role')
            .setRequired(true)
            .setMinValue(1)
            .setMaxValue(100))
        .addRoleOption(option =>
          option.setName('role')
            .setDescription('Role to assign at this level')
            .setRequired(true)))
    .addSubcommand(subcommand =>
      subcommand.setName('remove')
        .setDescription('Remove a level role reward')
        .addIntegerOption(option =>
          option.setName('level')
            .setDescription('Level to remove reward from')
            .setRequired(true)
            .setMinValue(1)
            .setMaxValue(100)))
    .addSubcommand(subcommand =>
      subcommand.setName('list')
        .setDescription('Display all level role rewards'))
    .addSubcommand(subcommand =>
      subcommand.setName('clear')
        .setDescription('Remove all level role rewards'))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles),

  // ============================================
  // LEVEL UP MESSAGE COMMAND
  // ============================================
  new SlashCommandBuilder()
    .setName('levelup')
    .setDescription('『 RAPHAEL 』 Configure level up announcement protocols, Master')
    .addSubcommand(subcommand =>
      subcommand.setName('enable')
        .setDescription('Activate level up announcements'))
    .addSubcommand(subcommand =>
      subcommand.setName('disable')
        .setDescription('Deactivate level up announcements'))
    .addSubcommand(subcommand =>
      subcommand.setName('status')
        .setDescription('Analyze current level up configuration'))
    .addSubcommand(subcommand =>
      subcommand.setName('channel')
        .setDescription('Designate level up announcement channel')
        .addChannelOption(option =>
          option.setName('channel')
            .setDescription('Channel for level up messages (leave empty for current channel)')
            .setRequired(false)
            .addChannelTypes(TEXT_CHANNELS)))
    .addSubcommand(subcommand =>
      subcommand.setName('message')
        .setDescription('Configure level up message')
        .addStringOption(option =>
          option.setName('text')
            .setDescription('Message text. Variables: {user}, {level}, {xp}')
            .setRequired(true)
            .setMaxLength(MESSAGE_TEXT_MAX)))
    .addSubcommand(subcommand =>
      subcommand.setName('embed')
        .setDescription('Toggle embed mode')
        .addBooleanOption(option =>
          option.setName('enabled')
            .setDescription('Enable or disable embed mode')
            .setRequired(true)))
    .addSubcommand(subcommand =>
      subcommand.setName('color')
        .setDescription('Set embed color')
        .addStringOption(option =>
          option.setName('hex')
            .setDescription('Hex color code (e.g., #FFD700)')
            .setRequired(true)))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  // ============================================
  // STARBOARD COMMAND
  // ============================================
  new SlashCommandBuilder()
    .setName('starboard')
    .setDescription('『 RAPHAEL 』 Configure starboard system parameters, Master')
    .addSubcommand(subcommand =>
      subcommand.setName('enable')
        .setDescription('Activate starboard system'))
    .addSubcommand(subcommand =>
      subcommand.setName('disable')
        .setDescription('Deactivate starboard system'))
    .addSubcommand(subcommand =>
      subcommand.setName('status')
        .setDescription('Analyze current starboard configuration'))
    .addSubcommand(subcommand =>
      subcommand.setName('channel')
        .setDescription('Designate starboard channel')
        .addChannelOption(option =>
          option.setName('channel')
            .setDescription('Channel for starred messages')
            .setRequired(true)
            .addChannelTypes(TEXT_CHANNELS)))
    .addSubcommand(subcommand =>
      subcommand.setName('threshold')
        .setDescription('Set minimum stars required')
        .addIntegerOption(option =>
          option.setName('amount')
            .setDescription('Number of stars required (1-50)')
            .setRequired(true)
            .setMinValue(1)
            .setMaxValue(50)))
    .addSubcommand(subcommand =>
      subcommand.setName('emoji')
        .setDescription('Set star emoji')
        .addStringOption(option =>
          option.setName('emoji')
            .setDescription('Emoji to use for starring')
            .setRequired(true)))
    .addSubcommand(subcommand =>
      subcommand.setName('selfstar')
        .setDescription('Toggle self-starring')
        .addBooleanOption(option =>
          option.setName('enabled')
            .setDescription('Allow users to star their own messages')
            .setRequired(true)))
    .addSubcommand(subcommand =>
      subcommand.setName('ignore')
        .setDescription('Add channel to starboard ignore list')
        .addChannelOption(option =>
          option.setName('channel')
            .setDescription('Channel to ignore')
            .setRequired(true)
            .addChannelTypes(MESSAGE_CHANNELS)))
    .addSubcommand(subcommand =>
      subcommand.setName('unignore')
        .setDescription('Remove channel from starboard ignore list')
        .addChannelOption(option =>
          option.setName('channel')
            .setDescription('Channel to unignore')
            .setRequired(true)
            .addChannelTypes(MESSAGE_CHANNELS)))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  // ============================================
  // RULES COMMAND
  // ============================================
  new SlashCommandBuilder()
    .setName('rules')
    .setDescription('『 RAPHAEL 』 Manage and display server rules, Master')
    .addSubcommand(subcommand =>
      subcommand.setName('add')
        .setDescription('Add a new rule')
        .addStringOption(option =>
          option.setName('rule')
            .setDescription('The rule text')
            .setRequired(true)
            .setMaxLength(RULE_TEXT_MAX)))
    .addSubcommand(subcommand =>
      subcommand.setName('remove')
        .setDescription('Remove a rule')
        .addIntegerOption(option =>
          option.setName('number')
            .setDescription('Rule number to remove')
            .setRequired(true)
            .setMinValue(1)))
    .addSubcommand(subcommand =>
      subcommand.setName('edit')
        .setDescription('Edit an existing rule')
        .addIntegerOption(option =>
          option.setName('number')
            .setDescription('Rule number to edit')
            .setRequired(true)
            .setMinValue(1))
        .addStringOption(option =>
          option.setName('text')
            .setDescription('New rule text')
            .setRequired(true)
            .setMaxLength(RULE_TEXT_MAX)))
    .addSubcommand(subcommand =>
      subcommand.setName('list')
        .setDescription('Display all rules'))
    .addSubcommand(subcommand =>
      subcommand.setName('send')
        .setDescription('Send rules embed to a channel')
        .addChannelOption(option =>
          option.setName('channel')
            .setDescription('Channel to send rules to')
            .setRequired(false)
            .addChannelTypes(TEXT_CHANNELS)))
    .addSubcommand(subcommand =>
      subcommand.setName('clear')
        .setDescription('Clear all rules'))
    .addSubcommand(subcommand =>
      subcommand.setName('title')
        .setDescription('Set rules embed title')
        .addStringOption(option =>
          option.setName('text')
            .setDescription('Title for rules embed')
            .setRequired(true)
            .setMaxLength(TITLE_MAX)))
    .addSubcommand(subcommand =>
      subcommand.setName('color')
        .setDescription('Set rules embed color')
        .addStringOption(option =>
          option.setName('hex')
            .setDescription('Hex color code')
            .setRequired(true)))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  // ============================================
  // AUTOPUBLISH COMMAND
  // ============================================
  new SlashCommandBuilder()
    .setName('autopublish')
    .setDescription('『 RAPHAEL 』 Auto-publish messages in announcement channels, Master')
    .addSubcommand(subcommand =>
      subcommand.setName('enable')
        .setDescription('Enable auto-publish'))
    .addSubcommand(subcommand =>
      subcommand.setName('disable')
        .setDescription('Disable auto-publish'))
    .addSubcommand(subcommand =>
      subcommand.setName('add')
        .setDescription('Add announcement channel to auto-publish')
        .addChannelOption(option =>
          option.setName('channel')
            .setDescription('Announcement channel')
            .setRequired(true)
            .addChannelTypes(ANNOUNCEMENT_CHANNELS)))
    .addSubcommand(subcommand =>
      subcommand.setName('remove')
        .setDescription('Remove channel from auto-publish')
        .addChannelOption(option =>
          option.setName('channel')
            .setDescription('Channel to remove')
            .setRequired(true)
            .addChannelTypes(POSTABLE_CHANNELS)))
    .addSubcommand(subcommand =>
      subcommand.setName('list')
        .setDescription('View auto-publish channels'))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),

  // ============================================
  // DEPLOYMENT COMMAND (Admin)
  // ============================================
  new SlashCommandBuilder()
    .setName('deployment')
    .setDescription('『 RAPHAEL 』 Log deployment and build information, Master')
    .addSubcommand(subcommand =>
      subcommand.setName('start')
        .setDescription('Log deployment start'))
    .addSubcommand(subcommand =>
      subcommand.setName('complete')
        .setDescription('Log deployment completion')
        .addStringOption(option =>
          option.setName('version')
            .setDescription('Version number')
            .setRequired(false)))
    .addSubcommand(subcommand =>
      subcommand.setName('rollback')
        .setDescription('Log deployment rollback')
        .addStringOption(option =>
          option.setName('version')
            .setDescription('Version to rollback to')
            .setRequired(false))
        .addStringOption(option =>
          option.setName('reason')
            .setDescription('Reason for rollback')
            .setRequired(false)
            .setMaxLength(REASON_MAX)))
    .addSubcommand(subcommand =>
      subcommand.setName('status')
        .setDescription('View deployment logs status'))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  // ============================================
  // BOT LOGS COMMAND (Admin)
  // ============================================
  new SlashCommandBuilder()
    .setName('botlogs')
    .setDescription('『 RAPHAEL 』 View and manage bot log files, Master')
    .addSubcommand(subcommand =>
      subcommand.setName('stats')
        .setDescription('View log statistics'))
    .addSubcommand(subcommand =>
      subcommand.setName('clean')
        .setDescription('Clean old log files')
        .addIntegerOption(option =>
          option.setName('days')
            .setDescription('Keep logs newer than X days')
            .setRequired(true)
            .setMinValue(7)
            .setMaxValue(90)))
    .addSubcommand(subcommand =>
      subcommand.setName('types')
        .setDescription('View available log types'))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

];

export async function registerSlashCommands(client) {
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

  try {
    console.log('[RAPHAEL] Initiating slash command registration...');

    const commandData = slashCommands.map(cmd => cmd.toJSON());

    // Register globally
    await rest.put(
      Routes.applicationCommands(client.user.id),
      { body: commandData }
    );

    console.log(`[RAPHAEL] Slash commands registered globally: ${commandData.length}`);

    return commandData.length;
  } catch (error) {
    console.error('Error registering slash commands:', error);
    throw error;
  }
}

export async function registerGuildSlashCommands(client, guildId) {
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

  try {
    const commandData = slashCommands.map(cmd => cmd.toJSON());

    await rest.put(
      Routes.applicationGuildCommands(client.user.id, guildId),
      { body: commandData }
    );

    console.log(`[RAPHAEL] Slash commands registered for guild ${guildId}`);
    return true;
  } catch (error) {
    console.error(`Error registering slash commands for guild ${guildId}:`, error);
    return false;
  }
}

// Clear guild-specific commands (use this to remove duplicates)
export async function clearGuildSlashCommands(client, guildId) {
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

  try {
    await rest.put(
      Routes.applicationGuildCommands(client.user.id, guildId),
      { body: [] }
    );

    console.log(`[RAPHAEL] Cleared guild-specific slash commands for ${guildId}`);
    return true;
  } catch (error) {
    console.error(`Error clearing slash commands for guild ${guildId}:`, error);
    return false;
  }
}

export function getSlashCommands() {
  return slashCommands;
}

export default { registerSlashCommands, registerGuildSlashCommands, clearGuildSlashCommands, getSlashCommands };
