import {
  Events,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  UserSelectMenuBuilder,
  StringSelectMenuBuilder,
  PermissionFlagsBits,
  MessageFlags
} from 'discord.js';
import Guild from '../../models/Guild.js';
import TempVoice from '../../models/TempVoice.js';
import { successEmbed, errorEmbed, infoEmbed, GLYPHS } from '../../utils/embeds.js';
import {
  CHANNEL_NAME_MAX,
  USER_LIMIT_MAX,
  buildTempChannelName,
  swapOwnerOverwrites
} from './tempVoiceHandler.js';

const BITRATE_MIN_KBPS = 8;
const BITRATE_MAX_KBPS = 96;
const STATUS_MAX = 50;
const INVITE_MAX_AGE_SECONDS = 3600;
const INVITE_MAX_USES = 10;
const FIELD_VALUE_MAX = 1024;

// Discord API error codes
const UNKNOWN_CHANNEL = 10003;
const UNKNOWN_MESSAGE = 10008;
const UNKNOWN_WEBHOOK = 10015;
const UNKNOWN_INTERACTION = 10062;
const INTERACTION_ALREADY_ACKNOWLEDGED = 40060;
const MISSING_ACCESS = 50001;
const MISSING_PERMISSIONS = 50013;

// The interaction expired or its channel is gone: nothing can be shown any more
const UNANSWERABLE_ERRORS = new Set([
  UNKNOWN_CHANNEL,
  UNKNOWN_MESSAGE,
  UNKNOWN_WEBHOOK,
  UNKNOWN_INTERACTION,
  INTERACTION_ALREADY_ACKNOWLEDGED
]);

// Restricting @everyone also restricts me unless I hold my own overwrite; without it I
// could no longer see, manage or delete the channel once it empties
const BOT_ACCESS_OVERWRITES = Object.freeze({
  ViewChannel: true,
  Connect: true,
  ManageChannels: true
});

const NO_CHANNEL = 'You do not currently own a temporary voice channel, Master.';

// Interface actions that work without owning a channel
const NO_CHANNEL_REQUIRED = new Set(['claim', 'info']);

const PRIVACY_ACTIONS = {
  lock: {
    label: 'Lock',
    description: 'Only permitted users can join your channel',
    overwrite: { Connect: false },
    restricts: true,
    locked: true,
    title: 'Channel Locked',
    text: 'Only permitted users can join your channel now, Master.'
  },
  unlock: {
    label: 'Unlock',
    description: 'Everyone can join your channel',
    overwrite: { Connect: null },
    locked: false,
    title: 'Channel Unlocked',
    text: 'Everyone can join your channel now, Master.'
  },
  invisible: {
    label: 'Invisible',
    description: 'Only permitted users can see your channel',
    overwrite: { ViewChannel: false },
    restricts: true,
    title: 'Channel Hidden',
    text: 'Only permitted users can see your channel now, Master.'
  },
  visible: {
    label: 'Visible',
    description: 'Everyone can see your channel',
    overwrite: { ViewChannel: null },
    title: 'Channel Visible',
    text: 'Your channel is visible to everyone again, Master.'
  },
  close_chat: {
    label: 'Close Chat',
    description: 'Disable the channel chat for everyone without explicit access',
    overwrite: { SendMessages: false },
    title: 'Chat Closed',
    text: 'The chat of your channel is now closed to everyone without explicit access, Master.'
  },
  open_chat: {
    label: 'Open Chat',
    description: 'Everyone can write in the channel chat',
    overwrite: { SendMessages: null },
    title: 'Chat Opened',
    text: 'Everyone can write in the chat of your channel again, Master.'
  }
};

const USER_ACTIONS = {
  permit: {
    title: 'Permit User',
    prompt: 'Select the user who may join your channel, Master.',
    placeholder: 'Select a user to permit'
  },
  reject: {
    title: 'Reject User',
    prompt: 'Select the user who may no longer see or join your channel, Master.',
    placeholder: 'Select a user to reject'
  },
  kick: {
    title: 'Kick User',
    prompt: 'Select the user to remove from your channel, Master.',
    placeholder: 'Select a user to kick'
  },
  transfer: {
    title: 'Transfer Ownership',
    prompt: 'Select the member in your channel who will become its owner, Master.',
    placeholder: 'Select the new owner'
  }
};

export default {
  name: Events.InteractionCreate,
  async execute(interaction) {
    const handler = getHandler(interaction);
    if (!handler || !interaction.inCachedGuild()) return;

    try {
      await handler(interaction);
    } catch (error) {
      console.error(`[TempVoice] Interface action ${interaction.customId} failed:`, error);
      await sendError(interaction, 'Operation Failed',
        `The operation could not be completed, Master. ${describeError(error)}`);
    }
  }
};

function getHandler(interaction) {
  if (interaction.isButton() && interaction.customId.startsWith('tempvc_')) return handleTempVCButton;
  if (interaction.isModalSubmit() && interaction.customId.startsWith('tempvc_modal_')) return handleTempVCModal;
  if (interaction.isUserSelectMenu() && interaction.customId.startsWith('tempvc_select_')) return handleTempVCUserSelect;
  if (interaction.isStringSelectMenu() && interaction.customId.startsWith('tempvc_privacy_')) return handlePrivacySelect;
  return null;
}

/**
 * Show a result: a select menu replaces its own ephemeral prompt, a deferred interaction
 * edits its reply, everything else gets a new ephemeral reply
 */
async function sendEmbed(interaction, embed) {
  try {
    if (interaction.deferred || interaction.replied) {
      return await interaction.editReply({ content: null, embeds: [embed], components: [] });
    }
    if (interaction.isAnySelectMenu()) {
      return await interaction.update({ content: null, embeds: [embed], components: [] });
    }
    return await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  } catch (error) {
    if (UNANSWERABLE_ERRORS.has(error.code)) {
      console.warn(`[TempVoice] Could not respond to ${interaction.customId}: ${error.message}`);
      return null;
    }
    throw error;
  }
}

async function sendSuccess(interaction, title, description) {
  return sendEmbed(interaction, await successEmbed(interaction.guildId, title, description));
}

async function sendInfo(interaction, title, description) {
  return sendEmbed(interaction, await infoEmbed(interaction.guildId, title, description));
}

// Never throws: used from the top-level catch
async function sendError(interaction, title, description) {
  try {
    return await sendEmbed(interaction, await errorEmbed(interaction.guildId, title, description));
  } catch (error) {
    console.error('[TempVoice] Could not send error response:', error);
    return null;
  }
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

function auditReason(interaction, action) {
  return `${action} by the temp voice owner ${interaction.user.tag}`;
}

// Whole numbers only ("5abc" is not 5)
function parseWholeNumber(raw) {
  const value = String(raw ?? '').trim();
  return /^\d+$/.test(value) ? Number(value) : null;
}

/**
 * The temp channel the user owns, or null
 */
async function getUserTempChannel(interaction) {
  const { guild, member, user } = interaction;

  const record = await TempVoice.findUserChannel(guild.id, user.id);
  if (record) {
    const channel = guild.channels.cache.get(record.channelId);
    if (channel) return channel;

    // The channel was deleted by hand; drop the stale record
    await TempVoice.deleteOne({ _id: record._id });
  }

  // The voice channel they are in, if they own it
  const voiceChannel = member.voice.channel;
  if (voiceChannel) {
    const channelData = await TempVoice.findByChannel(voiceChannel.id);
    if (channelData?.ownerId === user.id) return voiceChannel;
  }

  return null;
}

async function sendNoChannel(interaction) {
  const guildConfig = await Guild.getGuild(interaction.guild.id, interaction.guild.name);
  const createChannelId = guildConfig?.features?.tempVoice?.createChannelId;
  const hint = createChannelId && interaction.guild.channels.cache.has(createChannelId)
    ? `Join <#${createChannelId}> to create one.`
    : 'Join the Join to Create channel to create one.';
  return sendError(interaction, 'No Channel', `${NO_CHANNEL} ${hint}`);
}

/**
 * Give me my own overwrite before @everyone is restricted, so the channel stays manageable
 */
async function keepBotAccess(channel) {
  const me = channel.guild.members.me;
  if (!me || me.permissions.has(PermissionFlagsBits.Administrator)) return;

  try {
    await channel.permissionOverwrites.edit(me.id, BOT_ACCESS_OVERWRITES, {
      reason: 'Keeping access to a restricted temp voice channel'
    });
  } catch (error) {
    console.warn(`[TempVoice] Could not add my own overwrite to ${channel.id}:`, error.message);
  }
}

/**
 * Handle TempVoice interface buttons
 */
async function handleTempVCButton(interaction) {
  const action = interaction.customId.slice('tempvc_'.length);

  let channel = null;
  if (!NO_CHANNEL_REQUIRED.has(action)) {
    channel = await getUserTempChannel(interaction);
    if (!channel) return sendNoChannel(interaction);
  }

  switch (action) {
    case 'name':
      return showNameModal(interaction);
    case 'limit':
      return showLimitModal(interaction);
    case 'bitrate':
      return showBitrateModal(interaction);
    case 'status':
      return showStatusModal(interaction);
    case 'privacy':
      return showPrivacyMenu(interaction);
    case 'hide':
      return toggleHide(interaction, channel);
    case 'permit':
    case 'reject':
    case 'kick':
    case 'transfer':
      return showUserSelectMenu(interaction, action);
    case 'invite':
      return sendInvite(interaction, channel);
    case 'claim':
      return claimChannel(interaction);
    case 'delete':
      return deleteChannel(interaction, channel);
    case 'info':
      return showChannelInfo(interaction);
    default:
      return sendError(interaction, 'Unknown Action', 'That control is not recognised, Master.');
  }
}

function buildModal(customId, title, input) {
  return new ModalBuilder()
    .setCustomId(customId)
    .setTitle(title)
    .addComponents(new ActionRowBuilder().addComponents(input));
}

async function showNameModal(interaction) {
  const input = new TextInputBuilder()
    .setCustomId('channel_name')
    .setLabel('Choose a name for your voice channel')
    .setPlaceholder('Leave blank to restore the default name')
    .setStyle(TextInputStyle.Short)
    .setMaxLength(CHANNEL_NAME_MAX)
    .setRequired(false);

  return interaction.showModal(buildModal('tempvc_modal_name', 'Rename Channel', input));
}

async function showLimitModal(interaction) {
  const input = new TextInputBuilder()
    .setCustomId('user_limit')
    .setLabel(`User limit (0 = unlimited, max ${USER_LIMIT_MAX})`)
    .setPlaceholder(`A whole number from 0 to ${USER_LIMIT_MAX}`)
    .setStyle(TextInputStyle.Short)
    .setMaxLength(String(USER_LIMIT_MAX).length)
    .setRequired(true);

  return interaction.showModal(buildModal('tempvc_modal_limit', 'Set User Limit', input));
}

async function showBitrateModal(interaction) {
  const input = new TextInputBuilder()
    .setCustomId('bitrate')
    .setLabel(`Audio bitrate (${BITRATE_MIN_KBPS}-${BITRATE_MAX_KBPS} kbps)`)
    .setPlaceholder(`A whole number from ${BITRATE_MIN_KBPS} to ${BITRATE_MAX_KBPS}`)
    .setStyle(TextInputStyle.Short)
    .setMaxLength(String(BITRATE_MAX_KBPS).length)
    .setRequired(true);

  return interaction.showModal(buildModal('tempvc_modal_bitrate', 'Set Bitrate', input));
}

async function showStatusModal(interaction) {
  const input = new TextInputBuilder()
    .setCustomId('channel_status')
    .setLabel('Set a status for your voice channel')
    .setPlaceholder('e.g. Listening to music (blank to clear)')
    .setStyle(TextInputStyle.Short)
    .setMaxLength(STATUS_MAX)
    .setRequired(false);

  return interaction.showModal(buildModal('tempvc_modal_status', 'Set Channel Status', input));
}

async function showPrivacyMenu(interaction) {
  const menu = new StringSelectMenuBuilder()
    .setCustomId('tempvc_privacy_select')
    .setPlaceholder('Select a privacy option')
    .addOptions(Object.entries(PRIVACY_ACTIONS).map(([value, option]) => ({
      value,
      label: option.label,
      description: option.description
    })));

  const embed = await infoEmbed(interaction.guildId, 'Privacy Settings',
    '**Notice:** Select who may join, see or write in your channel, Master.');

  return interaction.reply({
    embeds: [embed],
    components: [new ActionRowBuilder().addComponents(menu)],
    flags: MessageFlags.Ephemeral
  });
}

async function handlePrivacySelect(interaction) {
  const channel = await getUserTempChannel(interaction);
  if (!channel) return sendError(interaction, 'No Channel', NO_CHANNEL);

  const choice = interaction.values[0];
  const option = Object.hasOwn(PRIVACY_ACTIONS, choice) ? PRIVACY_ACTIONS[choice] : null;
  if (!option) {
    return sendError(interaction, 'Unknown Option', 'That privacy option is not recognised, Master.');
  }

  if (option.restricts) await keepBotAccess(channel);

  await channel.permissionOverwrites.edit(interaction.guild.id, option.overwrite, {
    reason: auditReason(interaction, `Privacy set to ${option.label}`)
  });

  if (option.locked !== undefined) {
    await TempVoice.findOneAndUpdate({ channelId: channel.id }, { locked: option.locked });
  }

  return sendSuccess(interaction, option.title, option.text);
}

async function toggleHide(interaction, channel) {
  const everyone = channel.permissionOverwrites.cache.get(interaction.guild.id);
  const hide = !everyone?.deny.has(PermissionFlagsBits.ViewChannel);

  if (hide) await keepBotAccess(channel);

  await channel.permissionOverwrites.edit(interaction.guild.id, {
    ViewChannel: hide ? false : null
  }, { reason: auditReason(interaction, hide ? 'Hidden' : 'Shown') });

  return sendSuccess(interaction, hide ? 'Channel Hidden' : 'Channel Visible',
    hide
      ? 'Your channel is now **hidden** from the channel list, Master.'
      : 'Your channel is now **visible** to everyone, Master.');
}

async function showUserSelectMenu(interaction, action) {
  const config = USER_ACTIONS[action];

  const menu = new UserSelectMenuBuilder()
    .setCustomId(`tempvc_select_${action}`)
    .setPlaceholder(config.placeholder)
    .setMinValues(1)
    .setMaxValues(1);

  const embed = await infoEmbed(interaction.guildId, config.title, `**Notice:** ${config.prompt}`);

  return interaction.reply({
    embeds: [embed],
    components: [new ActionRowBuilder().addComponents(menu)],
    flags: MessageFlags.Ephemeral
  });
}

async function sendInvite(interaction, channel) {
  const invite = await channel.createInvite({
    maxAge: INVITE_MAX_AGE_SECONDS,
    maxUses: INVITE_MAX_USES,
    unique: true,
    reason: auditReason(interaction, 'Invite created')
  });

  return sendInfo(interaction, 'Channel Invite Created',
    `**Notice:** Your invite link is ready, Master.\n${invite.url}\n\n` +
    `*Expires in 1 hour or after ${INVITE_MAX_USES} uses.*`);
}

async function claimChannel(interaction) {
  const { guild, user } = interaction;
  const voiceChannel = interaction.member.voice.channel;
  if (!voiceChannel) {
    return sendError(interaction, 'Not in Voice', 'You must be in a voice channel to claim it, Master.');
  }

  const tempData = await TempVoice.findByChannel(voiceChannel.id);
  if (!tempData) {
    return sendError(interaction, 'Not a Temp Channel', 'This is not a temporary voice channel, Master.');
  }

  if (tempData.ownerId === user.id) {
    return sendError(interaction, 'Already Owner', 'You already own this channel, Master.');
  }

  if (voiceChannel.members.has(tempData.ownerId)) {
    return sendError(interaction, 'Owner Present',
      'The owner is still in the channel, Master. It cannot be claimed.');
  }

  // Owning two channels would leave every owner control acting on an arbitrary one
  const ownedRecord = await TempVoice.findUserChannel(guild.id, user.id);
  if (ownedRecord) {
    if (guild.channels.cache.has(ownedRecord.channelId)) {
      return sendError(interaction, 'Already Own a Channel',
        `You already own <#${ownedRecord.channelId}>, Master. Delete it or transfer it before claiming another.`);
    }
    await TempVoice.deleteOne({ _id: ownedRecord._id });
  }

  // Swap the overwrites as an ownership transfer does, then record the new owner
  await swapOwnerOverwrites(voiceChannel, tempData.ownerId, user.id);
  tempData.ownerId = user.id;
  await tempData.save();

  return sendSuccess(interaction, 'Channel Claimed', `You are now the owner of **${voiceChannel.name}**, Master.`);
}

async function deleteChannel(interaction, channel) {
  const tempData = await TempVoice.findByChannel(channel.id);
  if (!tempData) {
    return sendError(interaction, 'Channel Not Found', 'No record of this temporary channel exists, Master.');
  }

  // The interface may live in this channel's own chat; answer before it disappears
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  try {
    await channel.delete(auditReason(interaction, 'Deleted'));
  } catch (error) {
    if (error.code !== UNKNOWN_CHANNEL) throw error;
  }

  // Only drop the record once the channel is gone, so a failed delete stays tracked
  await TempVoice.deleteOne({ _id: tempData._id });

  return sendSuccess(interaction, 'Channel Deleted', 'Your temporary voice channel has been deleted, Master.');
}

async function showChannelInfo(interaction) {
  const voiceChannel = interaction.member.voice.channel ?? await getUserTempChannel(interaction);
  if (!voiceChannel) {
    return sendError(interaction, 'Not in Voice', 'You must be in a voice channel to see its info, Master.');
  }

  const tempData = await TempVoice.findByChannel(voiceChannel.id);
  if (!tempData) {
    return sendError(interaction, 'Not a Temp Channel', 'This is not a temporary voice channel, Master.');
  }

  const created = tempData.createdAt
    ? `<t:${Math.floor(tempData.createdAt.getTime() / 1000)}:R>`
    : 'Unknown';

  const embed = await infoEmbed(interaction.guildId, 'Channel Info',
    `**Notice:** Current state of **${voiceChannel.name}**, Master.`);

  embed.addFields(
    { name: `${GLYPHS.ARROW_RIGHT} Owner`, value: `<@${tempData.ownerId}>`, inline: true },
    { name: `${GLYPHS.ARROW_RIGHT} Members`, value: `${voiceChannel.members.size}/${voiceChannel.userLimit || 'Unlimited'}`, inline: true },
    { name: `${GLYPHS.ARROW_RIGHT} Bitrate`, value: `${Math.floor(voiceChannel.bitrate / 1000)} kbps`, inline: true },
    { name: `${GLYPHS.ARROW_RIGHT} Locked`, value: tempData.locked ? 'Yes' : 'No', inline: true },
    { name: `${GLYPHS.ARROW_RIGHT} Created`, value: created, inline: true }
  );

  if (tempData.customStatus) {
    embed.addFields({
      name: `${GLYPHS.ARROW_RIGHT} Status`,
      value: tempData.customStatus.slice(0, FIELD_VALUE_MAX),
      inline: true
    });
  }

  return sendEmbed(interaction, embed);
}

/**
 * Handle TempVoice modal submissions
 */
async function handleTempVCModal(interaction) {
  // Channel edits share a rate limit (renames: two per ten minutes) and may wait well
  // past the three seconds an undeferred interaction allows
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const action = interaction.customId.slice('tempvc_modal_'.length);
  const channel = await getUserTempChannel(interaction);
  if (!channel) return sendError(interaction, 'No Channel', NO_CHANNEL);

  switch (action) {
    case 'name':
      return renameChannel(interaction, channel);
    case 'limit':
      return setUserLimit(interaction, channel);
    case 'bitrate':
      return setBitrate(interaction, channel);
    case 'status':
      return setStatus(interaction, channel);
    default:
      return sendError(interaction, 'Unknown Action', 'That form is not recognised, Master.');
  }
}

async function renameChannel(interaction, channel) {
  let name = interaction.fields.getTextInputValue('channel_name').trim();

  // Blank restores the server's default name
  if (!name) {
    const guildConfig = await Guild.getGuild(interaction.guild.id, interaction.guild.name);
    name = buildTempChannelName(guildConfig?.features?.tempVoice?.defaultName, interaction.member);
  }

  await channel.setName(name, auditReason(interaction, 'Renamed'));
  await TempVoice.findOneAndUpdate({ channelId: channel.id }, { name });

  return sendSuccess(interaction, 'Channel Renamed', `Your channel has been renamed to **${name}**, Master.`);
}

async function setUserLimit(interaction, channel) {
  const limit = parseWholeNumber(interaction.fields.getTextInputValue('user_limit'));
  if (limit === null || limit > USER_LIMIT_MAX) {
    return sendError(interaction, 'Invalid Limit',
      `The limit must be a whole number from 0 (unlimited) to ${USER_LIMIT_MAX}, Master.`);
  }

  await channel.setUserLimit(limit, auditReason(interaction, 'User limit changed'));
  await TempVoice.findOneAndUpdate({ channelId: channel.id }, { userLimit: limit });

  return sendSuccess(interaction, 'Limit Set', `The user limit is now **${limit || 'Unlimited'}**, Master.`);
}

async function setBitrate(interaction, channel) {
  const bitrate = parseWholeNumber(interaction.fields.getTextInputValue('bitrate'));
  if (bitrate === null || bitrate < BITRATE_MIN_KBPS || bitrate > BITRATE_MAX_KBPS) {
    return sendError(interaction, 'Invalid Bitrate',
      `The bitrate must be a whole number from ${BITRATE_MIN_KBPS} to ${BITRATE_MAX_KBPS} kbps, Master.`);
  }

  await channel.setBitrate(bitrate * 1000, auditReason(interaction, 'Bitrate changed'));

  return sendSuccess(interaction, 'Bitrate Set', `The channel bitrate is now **${bitrate} kbps**, Master.`);
}

async function setStatus(interaction, channel) {
  const status = interaction.fields.getTextInputValue('channel_status').trim().slice(0, STATUS_MAX);

  // Voice channels have no status field I can set; it is kept for the channel info
  await TempVoice.findOneAndUpdate({ channelId: channel.id }, { customStatus: status || null });

  if (!status) {
    return sendSuccess(interaction, 'Status Cleared', 'Your channel status has been cleared, Master.');
  }

  return sendSuccess(interaction, 'Status Set',
    `Your channel status is now **${status}**, Master.\n` +
    '*Voice channels do not display it; it appears in the channel info.*');
}

/**
 * Handle TempVoice user select menus
 */
async function handleTempVCUserSelect(interaction) {
  const action = interaction.customId.slice('tempvc_select_'.length);
  const channel = await getUserTempChannel(interaction);
  if (!channel) return sendError(interaction, 'No Channel', NO_CHANNEL);

  const targetUser = interaction.users.first();
  if (!targetUser) {
    return sendError(interaction, 'No User', 'Please select a user, Master.');
  }

  // Rejecting me would hide the channel from me, and I could no longer delete it once it empties
  if (targetUser.bot) {
    return sendError(interaction, 'Invalid User', 'This action cannot be performed on a bot, Master.');
  }

  // Rejecting yourself would deny your own overwrite and disconnect you
  if (targetUser.id === interaction.user.id) {
    return sendError(interaction, 'Invalid User', 'You cannot perform this action on yourself, Master.');
  }

  const targetMember = await interaction.guild.members.fetch(targetUser.id).catch(() => null);
  if (!targetMember) {
    return sendError(interaction, 'Member Not Found', 'That user is not a member of this server, Master.');
  }

  switch (action) {
    case 'permit':
      return permitUser(interaction, channel, targetMember);
    case 'reject':
      return rejectUser(interaction, channel, targetMember);
    case 'kick':
      return kickUser(interaction, channel, targetMember);
    case 'transfer':
      return transferOwnership(interaction, channel, targetMember);
    default:
      return sendError(interaction, 'Unknown Action', 'That action is not recognised, Master.');
  }
}

async function permitUser(interaction, channel, target) {
  await channel.permissionOverwrites.edit(target.id, {
    Connect: true,
    ViewChannel: true
  }, { reason: auditReason(interaction, 'User permitted') });

  return sendSuccess(interaction, 'User Permitted', `${target} may now join your channel, Master.`);
}

async function rejectUser(interaction, channel, target) {
  await channel.permissionOverwrites.edit(target.id, {
    Connect: false,
    ViewChannel: false
  }, { reason: auditReason(interaction, 'User rejected') });

  // A rejected user who is already inside is removed
  if (target.voice.channelId === channel.id) {
    await target.voice.disconnect(auditReason(interaction, 'User rejected')).catch(() => null);
  }

  return sendSuccess(interaction, 'User Rejected', `${target} can no longer see or join your channel, Master.`);
}

async function kickUser(interaction, channel, target) {
  if (target.voice.channelId !== channel.id) {
    return sendError(interaction, 'User Not in Channel', 'That user is not in your voice channel, Master.');
  }

  await target.voice.disconnect(auditReason(interaction, 'User kicked'));

  return sendSuccess(interaction, 'User Kicked', `${target} has been removed from your channel, Master.`);
}

async function transferOwnership(interaction, channel, target) {
  const { guild } = interaction;

  if (target.voice.channelId !== channel.id) {
    return sendError(interaction, 'User Not in Channel', 'The new owner must be in your voice channel, Master.');
  }

  // Owning two channels would leave every owner control acting on an arbitrary one
  const ownedRecord = await TempVoice.findUserChannel(guild.id, target.id);
  if (ownedRecord && ownedRecord.channelId !== channel.id) {
    if (guild.channels.cache.has(ownedRecord.channelId)) {
      return sendError(interaction, 'Already Owns a Channel',
        `${target} already owns <#${ownedRecord.channelId}>, Master.`);
    }
    await TempVoice.deleteOne({ _id: ownedRecord._id });
  }

  // The rename below is rate limited and can wait far longer than three seconds
  await interaction.deferUpdate();

  // Grant the new owner's overwrites before removing the old owner's
  await swapOwnerOverwrites(channel, interaction.user.id, target.id);

  const guildConfig = await Guild.getGuild(guild.id, guild.name);
  const newName = buildTempChannelName(guildConfig?.features?.tempVoice?.defaultName, target);

  // Record the new owner before renaming: renames are rate limited and can fail
  await TempVoice.findOneAndUpdate({ channelId: channel.id }, { ownerId: target.id, name: newName });

  // Notify the new owner; DMs may be closed
  try {
    const dmEmbed = await infoEmbed(guild.id, 'Channel Ownership Transferred',
      `**Notice:** You are now the owner of **${newName}** in **${guild.name}**, Master.`);
    await target.send({ embeds: [dmEmbed] });
  } catch {
    // DMs disabled
  }

  let renamed = true;
  try {
    await channel.setName(newName, 'Temp voice ownership transferred');
  } catch (error) {
    renamed = false;
    console.warn(`[TempVoice] Could not rename ${channel.id} after a transfer:`, error.message);
  }

  return sendSuccess(interaction, 'Ownership Transferred',
    `${target} is now the owner of **${renamed ? newName : channel.name}**, Master.\n` +
    (renamed
      ? 'The channel has been renamed and its permissions updated.'
      : 'Its permissions have been updated; the channel could not be renamed.'));
}
