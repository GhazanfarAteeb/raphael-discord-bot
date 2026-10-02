import { PermissionFlagsBits, ChannelType, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import Guild from '../../models/Guild.js';
import TempVoice from '../../models/TempVoice.js';
import { successEmbed, errorEmbed, warningEmbed, infoEmbed, GLYPHS, COLORS } from '../../utils/embeds.js';
import { getRandomFooter } from '../../utils/raphael.js';
import { getPrefix } from '../../utils/helpers.js';
import {
  CHANNEL_NAME_MAX,
  DEFAULT_CHANNEL_NAME,
  TEMP_CHANNEL_CREATE_PERMISSIONS,
  buildTempChannelName,
  swapOwnerOverwrites,
  removeGuildTempChannels
} from '../../events/client/tempVoiceHandler.js';

const BITRATE_MIN_KBPS = 8;
const BITRATE_MAX_KBPS = 96;

// Discord API error codes
const UNKNOWN_CHANNEL = 10003;
const MISSING_ACCESS = 50001;
const MISSING_PERMISSIONS = 50013;

const TEMPVC_DEFAULTS = {
  enabled: false,
  createChannelId: null,
  categoryId: null,
  interfaceChannelId: null,
  defaultName: DEFAULT_CHANNEL_NAME,
  defaultLimit: 0
};

const ADMIN_ACTIONS = ['setup', 'disable', 'category', 'defaultname', 'defaultlimit', 'resend'];

// Setup creates the channels, and the owner controls edit channel overwrites (Manage Roles)
const SETUP_BOT_PERMISSIONS = [
  ...TEMP_CHANNEL_CREATE_PERMISSIONS,
  PermissionFlagsBits.ManageRoles,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.EmbedLinks,
  PermissionFlagsBits.ReadMessageHistory
];

const NO_CHANNEL = 'You do not currently own a temporary voice channel, Master.';

// Button configuration for TempVoice interface
const TEMPVC_BUTTONS = {
  row1: [
    { id: 'tempvc_name', label: 'Name', style: ButtonStyle.Secondary },
    { id: 'tempvc_limit', label: 'Limit', style: ButtonStyle.Secondary },
    { id: 'tempvc_privacy', label: 'Privacy', style: ButtonStyle.Secondary },
    { id: 'tempvc_bitrate', label: 'Bitrate', style: ButtonStyle.Secondary },
    { id: 'tempvc_status', label: 'Status', style: ButtonStyle.Secondary }
  ],
  row2: [
    { id: 'tempvc_permit', label: 'Permit', style: ButtonStyle.Success },
    { id: 'tempvc_reject', label: 'Reject', style: ButtonStyle.Danger },
    { id: 'tempvc_invite', label: 'Invite', style: ButtonStyle.Primary },
    { id: 'tempvc_kick', label: 'Kick', style: ButtonStyle.Danger },
    { id: 'tempvc_info', label: 'Info', style: ButtonStyle.Secondary }
  ],
  row3: [
    { id: 'tempvc_claim', label: 'Claim', style: ButtonStyle.Primary },
    { id: 'tempvc_transfer', label: 'Transfer', style: ButtonStyle.Primary },
    { id: 'tempvc_delete', label: 'Delete', style: ButtonStyle.Danger }
  ]
};

const CONTROL_DESCRIPTIONS = [
  ['NAME', 'Rename the channel'],
  ['LIMIT', 'Set the user limit'],
  ['PRIVACY', 'Lock, unlock, hide or show the channel'],
  ['BITRATE', 'Set the audio quality'],
  ['STATUS', 'Set the channel status'],
  ['PERMIT', 'Authorize a user'],
  ['REJECT', 'Deny a user access'],
  ['INVITE', 'Create an invite link'],
  ['KICK', 'Remove a user'],
  ['INFO', 'Display channel information'],
  ['CLAIM', 'Claim an abandoned channel'],
  ['TRANSFER', 'Transfer ownership'],
  ['DELETE', 'Delete the channel']
];

/**
 * Create the TempVoice interface embed and buttons
 */
function createInterfaceEmbed(prefix) {
  const embed = new EmbedBuilder()
    .setColor(COLORS.RAPHAEL)
    .setTitle('『 Voice Channel Interface 』')
    .setDescription(
      '**Notice:** This interface controls temporary voice channels, Master.\n' +
      'Join the join-to-create channel first; the controls act on the channel you own.\n' +
      `Additional commands are available via \`${prefix}tempvc\`.\n\n` +
      '**Available Controls:**\n' +
      CONTROL_DESCRIPTIONS.map(([label, text]) => `${GLYPHS.ARROW_RIGHT} \`${label}\` — ${text}`).join('\n') +
      '\n\n*Press the buttons below to execute commands.*'
    )
    .setFooter({ text: getRandomFooter() });

  const rows = Object.values(TEMPVC_BUTTONS).map(buttons =>
    new ActionRowBuilder().addComponents(
      buttons.map(btn => new ButtonBuilder()
        .setCustomId(btn.id)
        .setLabel(btn.label)
        .setStyle(btn.style))
    )
  );

  return { embed, rows };
}

export default {
  name: 'tempvc',
  description: 'Configure temporary voice channels',
  usage: '<setup|disable|resend|category|defaultname|defaultlimit|name|limit|lock|unlock|hide|unhide|kick|permit|reject|claim|transfer|bitrate|info>',
  aliases: ['tempvoice', 'vc', 'voice'],
  category: 'utility',
  cooldown: 3,

  async execute(message, args) {
    try {
      const guildConfig = await Guild.getGuild(message.guild.id, message.guild.name);
      const prefix = await getPrefix(message.guild.id);
      const tempVoice = { ...TEMPVC_DEFAULTS, ...(guildConfig?.features?.tempVoice ?? {}) };

      const action = args[0]?.toLowerCase();
      if (!action) {
        return await showStatus(message, tempVoice, prefix);
      }

      if (ADMIN_ACTIONS.includes(action) && !message.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
        return await replyError(message, 'Permission Denied',
          'The Manage Server permission is required for this command, Master.');
      }

      switch (action) {
        case 'setup':
          return await setupTempVC(message, tempVoice, prefix);

        case 'resend':
          return await resendInterface(message, tempVoice, prefix);

        case 'disable':
          return await disableTempVC(message, prefix);

        case 'category':
          return await setCategory(message, args[1]);

        case 'defaultname':
          return await setDefaultName(message, args.slice(1).join(' '), prefix);

        case 'defaultlimit':
          return await setDefaultLimit(message, args[1]);

        // User commands for their own temp channel
        case 'name':
        case 'rename':
          return await renameChannel(message, args.slice(1).join(' '), prefix);

        case 'limit':
          return await setLimit(message, args[1]);

        case 'lock':
          return await lockChannel(message, true);

        case 'unlock':
          return await lockChannel(message, false);

        case 'kick':
          return await kickUser(message);

        case 'permit':
        case 'allow':
          return await permitUser(message, true);

        case 'reject':
        case 'deny':
          return await permitUser(message, false);

        case 'claim':
          return await claimChannel(message);

        case 'transfer':
          return await transferOwnership(message, tempVoice);

        case 'hide':
          return await hideChannel(message, true);

        case 'unhide':
        case 'show':
          return await hideChannel(message, false);

        case 'bitrate':
          return await setBitrate(message, args[1]);

        case 'info':
          return await channelInfo(message);

        default:
          return await showStatus(message, tempVoice, prefix);
      }
    } catch (error) {
      console.error('[TempVC] Command error:', error);
      return replyError(message, 'Operation Failed',
        `The operation could not be completed, Master. ${describeError(error)}`);
    }
  }
};

async function replyError(message, title, description) {
  try {
    return await message.reply({ embeds: [await errorEmbed(message.guild.id, title, description)] });
  } catch (error) {
    console.error('[TempVC] Could not send error reply:', error);
    return null;
  }
}

async function replySuccess(message, title, description) {
  return message.reply({ embeds: [await successEmbed(message.guild.id, title, description)] });
}

function describeError(error) {
  if (error?.code === MISSING_PERMISSIONS || error?.code === MISSING_ACCESS) {
    return 'I lack the Discord permissions required for this action.';
  }
  if (error?.code === UNKNOWN_CHANNEL) {
    return 'The channel no longer exists.';
  }
  return 'Please try again shortly.';
}

function formatPermission(name) {
  return name.replace(/([a-z])([A-Z])/g, '$1 $2');
}

// 0 (unlimited) to 99, whole numbers only ("5abc" is not 5)
function parseUserLimit(raw) {
  return /^\d{1,2}$/.test(raw ?? '') ? Number(raw) : null;
}

async function showStatus(message, tv, prefix) {
  const { guild } = message;
  const createChannel = tv.createChannelId ? guild.channels.cache.get(tv.createChannelId) : null;
  const category = tv.categoryId ? guild.channels.cache.get(tv.categoryId) : null;
  const interfaceChannel = tv.interfaceChannelId ? guild.channels.cache.get(tv.interfaceChannelId) : null;

  // Check if user has a temp channel
  const userChannel = await getUserTempChannel(message);
  const cmd = `${prefix}tempvc`;

  const embed = await infoEmbed(guild.id, 'Voice Channel System',
    `**▸ Status:** ${tv.enabled ? `${GLYPHS.SUCCESS} Active` : `${GLYPHS.INFO} Inactive`}\n` +
    `**▸ Join to Create:** ${createChannel ?? 'Not configured'}\n` +
    `**▸ Interface:** ${interfaceChannel ?? 'Not configured'}\n` +
    `**▸ Category:** ${category ?? 'Automatic'}\n` +
    `**▸ Default Name:** ${tv.defaultName || DEFAULT_CHANNEL_NAME}\n` +
    `**▸ Default Limit:** ${tv.defaultLimit || 'Unlimited'}\n\n` +
    (userChannel ? `**Your Channel:** ${userChannel}\n\n` : '') +
    `**Administrator Commands:**\n` +
    `${GLYPHS.DOT} \`${cmd} setup\` — Initialize the system\n` +
    `${GLYPHS.DOT} \`${cmd} disable\` — Deactivate the system and remove active channels\n` +
    `${GLYPHS.DOT} \`${cmd} resend\` — Resend the interface\n` +
    `${GLYPHS.DOT} \`${cmd} category <id>\` — Set the category for new channels\n` +
    `${GLYPHS.DOT} \`${cmd} defaultname <name>\` — Set the default name\n` +
    `${GLYPHS.DOT} \`${cmd} defaultlimit <0-99>\` — Set the default limit\n\n` +
    `**User Commands:** Use the buttons in ${interfaceChannel ?? 'the interface channel'} or:\n` +
    `${GLYPHS.DOT} \`${cmd} name <name>\` — Rename your channel\n` +
    `${GLYPHS.DOT} \`${cmd} limit <0-99>\` — Set the user limit\n` +
    `${GLYPHS.DOT} \`${cmd} lock/unlock\` — Lock or unlock your channel\n` +
    `${GLYPHS.DOT} \`${cmd} hide/unhide\` — Hide or show your channel\n` +
    `${GLYPHS.DOT} \`${cmd} permit/reject @user\` — Authorize or deny a user\n` +
    `${GLYPHS.DOT} \`${cmd} kick @user\` — Remove a user\n` +
    `${GLYPHS.DOT} \`${cmd} transfer @user\` — Transfer ownership\n` +
    `${GLYPHS.DOT} \`${cmd} claim\` — Claim an abandoned channel\n` +
    `${GLYPHS.DOT} \`${cmd} bitrate <${BITRATE_MIN_KBPS}-${BITRATE_MAX_KBPS}>\` — Set the audio bitrate\n` +
    `${GLYPHS.DOT} \`${cmd} info\` — Display channel information`
  );

  return message.reply({ embeds: [embed] });
}

async function setupTempVC(message, tv, prefix) {
  const { guild } = message;

  const me = guild.members.me ?? await guild.members.fetchMe();
  const missing = me.permissions.missing(SETUP_BOT_PERMISSIONS);
  if (missing.length) {
    return replyError(message, 'Insufficient Permissions',
      'I require the following permissions to manage temporary voice channels, Master:\n' +
      missing.map(name => `${GLYPHS.DOT} ${formatPermission(name)}`).join('\n'));
  }

  // A stored ID of a deleted channel (or the wrong kind of channel) is recreated
  const findChannel = (id, type) => {
    const channel = id ? guild.channels.cache.get(id) : null;
    return channel?.type === type ? channel : null;
  };

  const reason = `Temp voice setup by ${message.author.tag}`;
  const created = [];
  let category;
  let createChannel;
  let interfaceChannel;

  try {
    category = findChannel(tv.categoryId, ChannelType.GuildCategory);
    if (!category) {
      category = await guild.channels.create({
        name: 'Temp Voice',
        type: ChannelType.GuildCategory,
        reason,
        permissionOverwrites: [
          {
            id: guild.id,
            allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect]
          }
        ]
      });
      created.push(category);
    }

    // Create "Join to Create" channel
    createChannel = findChannel(tv.createChannelId, ChannelType.GuildVoice);
    if (!createChannel) {
      createChannel = await guild.channels.create({
        name: 'Join to Create',
        type: ChannelType.GuildVoice,
        parent: category.id,
        reason,
        permissionOverwrites: [
          {
            id: guild.id,
            allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect]
          }
        ]
      });
      created.push(createChannel);
    }

    // Create Interface text channel
    interfaceChannel = findChannel(tv.interfaceChannelId, ChannelType.GuildText);
    if (!interfaceChannel) {
      interfaceChannel = await guild.channels.create({
        name: 'interface',
        type: ChannelType.GuildText,
        parent: category.id,
        reason,
        permissionOverwrites: [
          {
            id: guild.id,
            allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory],
            deny: [PermissionFlagsBits.SendMessages]
          },
          {
            id: message.client.user.id,
            allow: [PermissionFlagsBits.SendMessages, PermissionFlagsBits.ViewChannel, PermissionFlagsBits.EmbedLinks]
          }
        ]
      });
      created.push(interfaceChannel);

      // Send the interface embed with buttons
      const { embed, rows } = createInterfaceEmbed(prefix);
      await interfaceChannel.send({ embeds: [embed], components: rows });
    }

    await Guild.updateGuild(guild.id, {
      $set: {
        'features.tempVoice.enabled': true,
        'features.tempVoice.categoryId': category.id,
        'features.tempVoice.createChannelId': createChannel.id,
        'features.tempVoice.interfaceChannelId': interfaceChannel.id
      }
    });
  } catch (error) {
    console.error('[TempVC] Setup failed:', error);

    // Nothing was saved, so remove what this attempt created to keep the server and the configuration in step
    const removed = await rollbackChannels(created);
    let outcome = 'The configuration is unchanged.';
    if (created.length && removed === created.length) {
      outcome = 'The channels created during this attempt have been removed; the configuration is unchanged.';
    } else if (created.length) {
      outcome = 'Some channels created during this attempt could not be removed; please delete them manually. The configuration is unchanged.';
    }

    return replyError(message, 'Setup Failed',
      `The temporary voice system could not be set up, Master. ${describeError(error)}\n\n${outcome}`);
  }

  return replySuccess(message, 'Temp VC Setup Complete',
    'Temporary voice channels are now enabled, Master.\n\n' +
    `**▸ Join to Create:** ${createChannel}\n` +
    `**▸ Interface:** ${interfaceChannel}\n` +
    `**▸ Category:** ${category}\n\n` +
    `Members can join ${createChannel} to create their own voice channel, ` +
    `and manage it with the buttons in ${interfaceChannel}.`);
}

/**
 * Delete channels created by a failed setup, newest first (children before their category)
 * @returns {Promise<number>} how many are gone
 */
async function rollbackChannels(channels) {
  let removed = 0;
  for (const channel of [...channels].reverse()) {
    try {
      await channel.delete('Temp voice setup failed; removing the partial setup');
      removed++;
    } catch (error) {
      if (error.code === UNKNOWN_CHANNEL) {
        removed++;
      } else {
        console.error(`[TempVC] Could not remove channel ${channel.id} after a failed setup:`, error);
      }
    }
  }
  return removed;
}

async function disableTempVC(message, prefix) {
  const { guild } = message;

  // Disable first: deleting the channels disconnects their members, and the voice
  // handler must not act on those events
  await Guild.updateGuild(guild.id, {
    $set: { 'features.tempVoice.enabled': false }
  });

  const { removed, failed } = await removeGuildTempChannels(guild,
    `Temporary voice channels disabled by ${message.author.tag}`);

  const lines = ['Temporary voice channels are now disabled, Master.'];
  if (removed) {
    lines.push(`${GLYPHS.ARROW_RIGHT} Removed **${removed}** active temporary channel${removed === 1 ? '' : 's'}.`);
  }

  if (failed) {
    lines.push(
      `${GLYPHS.ARROW_RIGHT} **${failed}** temporary channel${failed === 1 ? '' : 's'} could not be removed. ` +
      `Please grant me Manage Channels and run \`${prefix}tempvc disable\` again, or delete ${failed === 1 ? 'it' : 'them'} manually.`
    );
    return message.reply({
      embeds: [await warningEmbed(guild.id, 'Temp VC Disabled', lines.join('\n'))]
    });
  }

  return replySuccess(message, 'Temp VC Disabled', lines.join('\n'));
}

async function resendInterface(message, tv, prefix) {
  const interfaceChannel = tv.interfaceChannelId
    ? message.guild.channels.cache.get(tv.interfaceChannelId)
    : null;

  if (!interfaceChannel) {
    return replyError(message, 'No Interface Channel',
      `The interface channel was not found, Master. Please run \`${prefix}tempvc setup\` first.`);
  }

  // Delete old messages in interface channel (last 10)
  try {
    const messages = await interfaceChannel.messages.fetch({ limit: 10 });
    await interfaceChannel.bulkDelete(messages, true);
  } catch {
    // Ignore errors, messages might be too old
  }

  // Send new interface
  const { embed, rows } = createInterfaceEmbed(prefix);
  await interfaceChannel.send({ embeds: [embed], components: rows });

  return replySuccess(message, 'Interface Resent',
    `The voice channel interface has been resent in ${interfaceChannel}, Master.`);
}

async function setCategory(message, categoryId) {
  const category = categoryId ? message.guild.channels.cache.get(categoryId.trim()) : null;

  if (!category || category.type !== ChannelType.GuildCategory) {
    return replyError(message, 'Invalid Category',
      'Please provide a valid category ID, Master.');
  }

  await Guild.updateGuild(message.guild.id, {
    $set: { 'features.tempVoice.categoryId': category.id }
  });

  return replySuccess(message, 'Category Set',
    `Temporary voice channels will be created in **${category.name}**, Master.`);
}

async function setDefaultName(message, rawName, prefix) {
  const name = rawName.trim();
  if (!name) {
    return replyError(message, 'No Name',
      `Please provide a default channel name, Master: \`${prefix}tempvc defaultname <name>\`.\n` +
      'Use `{user}` as a placeholder for the member\'s display name.');
  }

  if (name.length > CHANNEL_NAME_MAX) {
    return replyError(message, 'Name Too Long',
      `Channel names are limited to ${CHANNEL_NAME_MAX} characters, Master; the provided name has ${name.length}.`);
  }

  await Guild.updateGuild(message.guild.id, {
    $set: { 'features.tempVoice.defaultName': name }
  });

  return replySuccess(message, 'Default Name Set',
    `The default channel name is now **${name}**, Master.`);
}

async function setDefaultLimit(message, rawLimit) {
  const limit = parseUserLimit(rawLimit);
  if (limit === null) {
    return replyError(message, 'Invalid Limit',
      'The limit must be a whole number from 0 (unlimited) to 99, Master.');
  }

  await Guild.updateGuild(message.guild.id, {
    $set: { 'features.tempVoice.defaultLimit': limit }
  });

  return replySuccess(message, 'Default Limit Set',
    `The default user limit is now **${limit || 'Unlimited'}**, Master.`);
}

async function getUserTempChannel(message) {
  // Check if user owns a temp channel
  const tempChannel = await TempVoice.findUserChannel(message.guild.id, message.author.id);

  if (tempChannel) {
    const channel = message.guild.channels.cache.get(tempChannel.channelId);
    if (channel) return channel;

    // The channel was deleted by hand; drop the stale record
    await TempVoice.deleteOne({ _id: tempChannel._id });
  }

  // Check if they're in a temp channel they own
  const voiceChannel = message.member.voice.channel;
  if (voiceChannel) {
    const channelData = await TempVoice.findByChannel(voiceChannel.id);
    if (channelData && channelData.ownerId === message.author.id) {
      return voiceChannel;
    }
  }

  return null;
}

async function renameChannel(message, rawName, prefix) {
  const name = rawName.trim();
  if (!name) {
    return replyError(message, 'No Name',
      `Please provide a new channel name, Master: \`${prefix}tempvc name <new name>\`.`);
  }

  if (name.length > CHANNEL_NAME_MAX) {
    return replyError(message, 'Name Too Long',
      `Channel names are limited to ${CHANNEL_NAME_MAX} characters, Master; the provided name has ${name.length}.`);
  }

  const channel = await getUserTempChannel(message);
  if (!channel) {
    return replyError(message, 'No Channel', NO_CHANNEL);
  }

  await channel.setName(name, `Renamed by its owner ${message.author.tag}`);
  await TempVoice.findOneAndUpdate(
    { channelId: channel.id },
    { name }
  );

  return replySuccess(message, 'Channel Renamed',
    `Your channel has been renamed to **${name}**, Master.`);
}

async function setLimit(message, rawLimit) {
  const limit = parseUserLimit(rawLimit);
  if (limit === null) {
    return replyError(message, 'Invalid Limit',
      'The limit must be a whole number from 0 (unlimited) to 99, Master.');
  }

  const channel = await getUserTempChannel(message);
  if (!channel) {
    return replyError(message, 'No Channel', NO_CHANNEL);
  }

  await channel.setUserLimit(limit);
  await TempVoice.findOneAndUpdate(
    { channelId: channel.id },
    { userLimit: limit }
  );

  return replySuccess(message, 'Limit Set',
    `The user limit is now **${limit || 'Unlimited'}**, Master.`);
}

async function lockChannel(message, lock) {
  const channel = await getUserTempChannel(message);
  if (!channel) {
    return replyError(message, 'No Channel', NO_CHANNEL);
  }

  await channel.permissionOverwrites.edit(message.guild.id, {
    Connect: lock ? false : null
  });

  await TempVoice.findOneAndUpdate(
    { channelId: channel.id },
    { locked: lock }
  );

  return replySuccess(message, lock ? 'Channel Locked' : 'Channel Unlocked',
    `Your channel is now **${lock ? 'locked' : 'unlocked'}**, Master.`);
}

async function kickUser(message) {
  const target = message.mentions.members?.first();
  if (!target) {
    return replyError(message, 'No User',
      'Please mention a user to kick, Master.');
  }

  const channel = await getUserTempChannel(message);
  if (!channel) {
    return replyError(message, 'No Channel', NO_CHANNEL);
  }

  if (!target.voice.channel || target.voice.channel.id !== channel.id) {
    return replyError(message, 'User Not in Channel',
      'That user is not in your voice channel, Master.');
  }

  await target.voice.disconnect();

  return replySuccess(message, 'User Kicked',
    `${target} has been removed from your channel, Master.`);
}

async function permitUser(message, allow) {
  const target = message.mentions.members?.first();
  if (!target) {
    return replyError(message, 'No User',
      'Please mention a user, Master.');
  }

  // Rejecting yourself would deny your own overwrite; rejecting me would hide the
  // channel from me, and I could no longer delete it once it empties
  if (target.id === message.author.id || target.id === message.client.user.id) {
    return replyError(message, 'Invalid User',
      'You cannot permit or reject yourself or me, Master.');
  }

  const channel = await getUserTempChannel(message);
  if (!channel) {
    return replyError(message, 'No Channel', NO_CHANNEL);
  }

  await channel.permissionOverwrites.edit(target.id, {
    Connect: allow,
    ViewChannel: allow
  });

  // A rejected user who is already inside is removed, as with the interface button
  if (!allow && target.voice.channelId === channel.id) {
    await target.voice.disconnect().catch(() => null);
  }

  return replySuccess(message, allow ? 'User Permitted' : 'User Rejected',
    `${target} has been ${allow ? 'permitted to join' : 'rejected from'} your channel, Master.`);
}

async function claimChannel(message) {
  const voiceChannel = message.member.voice.channel;
  if (!voiceChannel) {
    return replyError(message, 'Not in Voice',
      'You must be in a voice channel to claim it, Master.');
  }

  const tempData = await TempVoice.findByChannel(voiceChannel.id);
  if (!tempData) {
    return replyError(message, 'Not a Temp Channel',
      'This is not a temporary voice channel, Master.');
  }

  if (tempData.ownerId === message.author.id) {
    return replyError(message, 'Already Owner',
      'You already own this channel, Master.');
  }

  // Check if original owner is still in channel
  if (voiceChannel.members.has(tempData.ownerId)) {
    return replyError(message, 'Owner Present',
      'The owner is still in the channel, Master. It cannot be claimed.');
  }

  // Owning two channels would leave every owner command acting on an arbitrary one
  const ownedRecord = await TempVoice.findUserChannel(message.guild.id, message.author.id);
  if (ownedRecord) {
    if (message.guild.channels.cache.has(ownedRecord.channelId)) {
      return replyError(message, 'Already Own a Channel',
        `You already own <#${ownedRecord.channelId}>, Master. Delete it or transfer it before claiming another.`);
    }
    await TempVoice.deleteOne({ _id: ownedRecord._id });
  }

  // Swap the overwrites as an ownership transfer does, then record the new owner
  const oldOwnerId = tempData.ownerId;
  await swapOwnerOverwrites(voiceChannel, oldOwnerId, message.author.id);

  tempData.ownerId = message.author.id;
  await tempData.save();

  return replySuccess(message, 'Channel Claimed',
    `You are now the owner of **${voiceChannel.name}**, Master.`);
}

async function transferOwnership(message, tv) {
  const target = message.mentions.members?.first();
  if (!target) {
    return replyError(message, 'No User',
      'Please mention a user to transfer ownership to, Master.');
  }

  if (target.user.bot) {
    return replyError(message, 'Invalid User',
      'Ownership cannot be transferred to a bot, Master.');
  }

  if (target.id === message.author.id) {
    return replyError(message, 'Invalid User',
      'You already own this channel, Master.');
  }

  const channel = await getUserTempChannel(message);
  if (!channel) {
    return replyError(message, 'No Channel', NO_CHANNEL);
  }

  if (!target.voice.channel || target.voice.channel.id !== channel.id) {
    return replyError(message, 'User Not in Channel',
      'That user must be in your voice channel, Master.');
  }

  // Grant the new owner's overwrites before removing the old owner's
  await swapOwnerOverwrites(channel, message.author.id, target.id);

  const newName = buildTempChannelName(tv.defaultName, target);

  // Record the new owner before renaming: renames are rate limited and can fail
  await TempVoice.findOneAndUpdate(
    { channelId: channel.id },
    { ownerId: target.id, name: newName }
  );

  let renamed = true;
  try {
    await channel.setName(newName, 'Temp voice ownership transferred');
  } catch (error) {
    renamed = false;
    console.warn(`[TempVC] Could not rename ${channel.id} after a transfer:`, error.message);
  }

  return replySuccess(message, 'Ownership Transferred',
    `${target} is now the owner of **${renamed ? newName : channel.name}**, Master.\n` +
    (renamed
      ? 'The channel has been renamed and its permissions updated.'
      : 'Its permissions have been updated; the channel could not be renamed.'));
}

async function hideChannel(message, hide) {
  const channel = await getUserTempChannel(message);
  if (!channel) {
    return replyError(message, 'No Channel', NO_CHANNEL);
  }

  await channel.permissionOverwrites.edit(message.guild.id, {
    ViewChannel: hide ? false : null
  });

  return replySuccess(message, hide ? 'Channel Hidden' : 'Channel Visible',
    `Your channel is now **${hide ? 'hidden from' : 'visible to'}** everyone, Master.`);
}

async function setBitrate(message, rawBitrate) {
  const bitrate = /^\d+$/.test(rawBitrate ?? '') ? Number(rawBitrate) : NaN;
  if (!(bitrate >= BITRATE_MIN_KBPS && bitrate <= BITRATE_MAX_KBPS)) {
    return replyError(message, 'Invalid Bitrate',
      `The bitrate must be a whole number from ${BITRATE_MIN_KBPS} to ${BITRATE_MAX_KBPS} kbps, Master.`);
  }

  const channel = await getUserTempChannel(message);
  if (!channel) {
    return replyError(message, 'No Channel', NO_CHANNEL);
  }

  await channel.setBitrate(bitrate * 1000); // Convert to bps

  return replySuccess(message, 'Bitrate Set',
    `The channel bitrate is now **${bitrate} kbps**, Master.`);
}

async function channelInfo(message) {
  const channel = await getUserTempChannel(message);
  const voiceChannel = message.member.voice.channel;

  // Try to get info for the channel user is in if they don't own one
  const targetChannel = channel || voiceChannel;
  if (!targetChannel) {
    return replyError(message, 'No Channel',
      'You are not in a temporary voice channel, Master.');
  }

  const tempData = await TempVoice.findByChannel(targetChannel.id);
  if (!tempData) {
    return replyError(message, 'Not a Temp Channel',
      'This is not a temporary voice channel, Master.');
  }

  const owner = await message.guild.members.fetch(tempData.ownerId).catch(() => null);
  const memberCount = targetChannel.members.size;
  const userLimit = targetChannel.userLimit || 'Unlimited';
  const bitrate = Math.floor(targetChannel.bitrate / 1000);
  const created = tempData.createdAt
    ? `<t:${Math.floor(tempData.createdAt.getTime() / 1000)}:R>`
    : 'Unknown';

  const embed = await infoEmbed(message.guild.id, 'Channel Info',
    `**▸ Channel:** ${targetChannel.name}\n` +
    `**▸ Owner:** ${owner ? owner.user.tag : 'Unknown'}\n` +
    `**▸ Members:** ${memberCount}/${userLimit}\n` +
    `**▸ Bitrate:** ${bitrate} kbps\n` +
    `**▸ Locked:** ${tempData.locked ? 'Yes' : 'No'}\n` +
    (tempData.customStatus ? `**▸ Status:** ${tempData.customStatus}\n` : '') +
    `**▸ Created:** ${created}`
  );

  return message.reply({ embeds: [embed] });
}
