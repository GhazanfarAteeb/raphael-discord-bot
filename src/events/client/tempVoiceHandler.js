import { Events, ChannelType, PermissionFlagsBits } from 'discord.js';
import Guild from '../../models/Guild.js';
import TempVoice from '../../models/TempVoice.js';
import { getPrefix } from '../../utils/helpers.js';
import { infoEmbed } from '../../utils/embeds.js';

// Discord limits and error codes
export const CHANNEL_NAME_MAX = 100;
export const USER_LIMIT_MAX = 99;
const UNKNOWN_CHANNEL = 10003;
const UNKNOWN_OVERWRITE = 10009;
const TARGET_NOT_IN_VOICE = 40032;

export const DEFAULT_CHANNEL_NAME = "{user}'s Channel";

// Overwrites the owner of a temp channel holds on it
export const OWNER_OVERWRITES = Object.freeze({
  ViewChannel: true,
  Connect: true,
  ManageChannels: true,
  MuteMembers: true,
  DeafenMembers: true,
  MoveMembers: true
});

// Creating a temp channel grants the owner the overwrites above, which Discord only
// allows when the bot holds those permissions itself
export const TEMP_CHANNEL_CREATE_PERMISSIONS = Object.freeze([
  PermissionFlagsBits.ManageChannels,
  PermissionFlagsBits.MoveMembers,
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.Connect,
  PermissionFlagsBits.MuteMembers,
  PermissionFlagsBits.DeafenMembers
]);

// A member who joins the join-to-create channel twice in quick succession would
// otherwise get two channels
const pendingCreations = new Set();

export default {
  name: Events.VoiceStateUpdate,
  async execute(oldState, newState, client) {
    try {
      // Mute, deafen and stream changes keep the member in the same channel
      if (oldState.channelId === newState.channelId) return;

      const guild = newState.guild ?? oldState.guild;
      if (!guild) return;

      const guildConfig = await Guild.getGuild(guild.id, guild.name);
      const tempVoice = guildConfig?.features?.tempVoice;
      if (!tempVoice?.enabled) return;

      // Joined the join-to-create channel
      let returnedToId = null;
      if (newState.channelId && newState.channelId === tempVoice.createChannelId) {
        returnedToId = await createTempChannel(newState, tempVoice);
      }

      // Left a channel. An owner who joined the join-to-create channel from their own
      // channel was just moved back into it; the cache still shows it empty until the
      // move arrives, so it must not be deleted or handed to someone else.
      if (oldState.channelId && oldState.channelId !== returnedToId) {
        await checkAndDeleteTempChannel(oldState, tempVoice);
      }
    } catch (error) {
      console.error('[TempVoice] Error handling voice state update:', error);
    }
  }
};

/**
 * Build a temp channel name from the guild template, kept within Discord's limit
 */
export function buildTempChannelName(template, member) {
  // Function replacers: a display name containing "$&" must not be read as a pattern
  const name = truncateChannelName(
    (template || DEFAULT_CHANNEL_NAME)
      .replace(/{user}/gi, () => member.displayName)
      .replace(/{username}/gi, () => member.user.username)
      .replace(/{tag}/gi, () => member.user.tag)
      .trim()
  );
  return name || truncateChannelName(`${member.user.username}'s Channel`);
}

function truncateChannelName(name) {
  let truncated = name.slice(0, CHANNEL_NAME_MAX);
  // Do not leave half of a surrogate pair at the cut
  if (/[\uD800-\uDBFF]$/.test(truncated)) truncated = truncated.slice(0, -1);
  return truncated;
}

/**
 * Give the new owner the owner overwrites, then remove the old owner's
 */
export async function swapOwnerOverwrites(channel, oldOwnerId, newOwnerId) {
  await channel.permissionOverwrites.edit(newOwnerId, OWNER_OVERWRITES, {
    reason: 'Temp voice ownership changed'
  });

  if (!oldOwnerId || oldOwnerId === newOwnerId) return;

  try {
    await channel.permissionOverwrites.delete(oldOwnerId, 'Temp voice ownership changed');
  } catch (error) {
    if (error.code !== UNKNOWN_OVERWRITE) {
      console.warn(`[TempVoice] Could not remove the previous owner's overwrites in ${channel.id}:`, error.message);
    }
  }
}

/**
 * Delete a channel; a channel that is already gone counts as deleted
 * @returns {Promise<boolean>} whether the channel no longer exists
 */
async function deleteChannelSafely(channel, reason) {
  try {
    await channel.delete(reason);
    return true;
  } catch (error) {
    if (error.code === UNKNOWN_CHANNEL) return true;
    console.error(`[TempVoice] Failed to delete channel ${channel.id}:`, error.message);
    return false;
  }
}

/**
 * Delete a temp channel, then its record. The record is kept when the channel could
 * not be deleted, so the startup cleanup can retry instead of leaving an untracked channel.
 */
async function removeTempChannel(tempData, channel, reason) {
  const gone = channel ? await deleteChannelSafely(channel, reason) : true;
  if (!gone) return false;

  await TempVoice.deleteOne({ _id: tempData._id });
  return true;
}

/**
 * Delete every live temp channel of a guild and its records (used when the system is disabled)
 * @returns {Promise<{ removed: number, failed: number }>}
 */
export async function removeGuildTempChannels(guild, reason = 'Temporary voice channels disabled') {
  const records = await TempVoice.getGuildChannels(guild.id);
  let removed = 0;
  let failed = 0;

  for (const record of records) {
    const channel = guild.channels.cache.get(record.channelId);
    try {
      if (await removeTempChannel(record, channel, reason)) {
        if (channel) removed++;
      } else {
        failed++;
      }
    } catch (error) {
      failed++;
      console.error(`[TempVoice] Failed to remove temp channel record ${record.channelId}:`, error);
    }
  }

  return { removed, failed };
}

/**
 * Create a temp channel for a member who joined the join-to-create channel, or move them
 * back to the one they already own
 * @returns {Promise<string|null>} the channel the member was moved into
 */
async function createTempChannel(voiceState, tempVoice) {
  const { member, guild } = voiceState;
  if (!member || member.user.bot) return null;

  const lockKey = `${guild.id}:${member.id}`;
  if (pendingCreations.has(lockKey)) return null;
  pendingCreations.add(lockKey);

  try {
    const existing = await TempVoice.findUserChannel(guild.id, member.id);

    // The member may have left the join channel while the records were being read
    if (member.voice.channelId !== tempVoice.createChannelId) return null;

    if (existing) {
      const channel = guild.channels.cache.get(existing.channelId);
      if (channel) {
        await member.voice.setChannel(channel, 'Returning the owner to their temporary voice channel');
        return channel.id;
      }
      // The channel was deleted by hand; drop the stale record
      await TempVoice.deleteOne({ _id: existing._id });
    }

    // A configured category that was deleted would make the create call fail
    const configuredCategory = tempVoice.categoryId ? guild.channels.cache.get(tempVoice.categoryId) : null;
    const parent = configuredCategory?.type === ChannelType.GuildCategory
      ? configuredCategory
      : voiceState.channel?.parent ?? null;

    const me = guild.members.me;
    const botPermissions = me ? (parent ? me.permissionsIn(parent) : me.permissions) : null;
    const missing = botPermissions ? botPermissions.missing(TEMP_CHANNEL_CREATE_PERMISSIONS) : ['(bot member not cached)'];
    if (missing.length) {
      console.warn(`[TempVoice] Cannot create a temp channel in ${guild.name} (${guild.id}); missing: ${missing.join(', ')}`);
      return null;
    }

    const channelName = buildTempChannelName(tempVoice.defaultName, member);
    const userLimit = normalizeUserLimit(tempVoice.defaultLimit);

    const newChannel = await guild.channels.create({
      name: channelName,
      type: ChannelType.GuildVoice,
      parent: parent?.id ?? null,
      userLimit,
      reason: `Temporary voice channel for ${member.user.tag}`,
      permissionOverwrites: [
        {
          id: guild.id,
          allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect]
        },
        {
          // The bot's own access, so a later lock/hide that denies @everyone can't lock
          // Raphael out of a channel it has to clean up
          id: guild.members.me.id,
          allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.ManageChannels]
        },
        {
          id: member.id,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.Connect,
            PermissionFlagsBits.ManageChannels,
            PermissionFlagsBits.MuteMembers,
            PermissionFlagsBits.DeafenMembers,
            PermissionFlagsBits.MoveMembers
          ]
        }
      ]
    });

    // An untracked channel would never be cleaned up
    try {
      await TempVoice.create({
        guildId: guild.id,
        channelId: newChannel.id,
        ownerId: member.id,
        createdFromId: tempVoice.createChannelId,
        name: channelName,
        userLimit
      });
    } catch (error) {
      await deleteChannelSafely(newChannel, 'Temp voice record could not be saved');
      throw error;
    }

    try {
      await member.voice.setChannel(newChannel, 'Moving the owner into their temporary voice channel');
    } catch (error) {
      // The member left before the move: nobody will ever join or leave the new channel,
      // so no event would delete it
      await TempVoice.deleteOne({ channelId: newChannel.id });
      await deleteChannelSafely(newChannel, 'Temp voice channel owner left before being moved');
      if (error.code !== TARGET_NOT_IN_VOICE) {
        console.warn(`[TempVoice] Could not move ${member.user.tag} into their new channel:`, error.message);
      }
      return null;
    }

    console.log(`[TempVoice] Created temp voice channel "${channelName}" for ${member.user.tag}`);
    return newChannel.id;
  } catch (error) {
    console.error('[TempVoice] Error creating temp voice channel:', error);
    return null;
  } finally {
    pendingCreations.delete(lockKey);
  }
}

function normalizeUserLimit(limit) {
  const value = Number(limit);
  return Number.isInteger(value) && value >= 0 && value <= USER_LIMIT_MAX ? value : 0;
}

async function checkAndDeleteTempChannel(voiceState, tempVoice) {
  const channelId = voiceState.channelId;
  if (channelId === tempVoice.createChannelId) return;

  const tempData = await TempVoice.findByChannel(channelId);
  if (!tempData) return;

  const guild = voiceState.guild;
  const channel = guild.channels.cache.get(channelId);

  // Deleted by hand, or no humans left (a bot alone would keep it alive forever)
  const humans = channel ? channel.members.filter(m => !m.user.bot) : null;
  if (!channel || humans.size === 0) {
    try {
      if (await removeTempChannel(tempData, channel, 'Temp voice channel empty') && channel) {
        console.log(`[TempVoice] Deleted empty temp voice channel: ${tempData.name}`);
      }
    } catch (error) {
      console.error('[TempVoice] Error deleting temp voice channel:', error);
    }
    return;
  }

  // The owner left while others remain: hand the channel to one of them
  if (voiceState.id === tempData.ownerId) {
    await transferOwnership(channel, tempData, guild, tempVoice, humans.first());
  }
}

async function transferOwnership(channel, tempData, guild, tempVoice, newOwner) {
  try {
    const oldOwnerId = tempData.ownerId;
    const newChannelName = buildTempChannelName(tempVoice.defaultName, newOwner);

    await swapOwnerOverwrites(channel, oldOwnerId, newOwner.id);

    // Record the new owner before renaming: renames are rate limited (twice per ten
    // minutes) and the request can wait a long time
    tempData.ownerId = newOwner.id;
    tempData.name = newChannelName;
    await tempData.save();

    console.log(`[TempVoice] Transferred temp voice channel ownership from ${oldOwnerId} to ${newOwner.user.tag}`);

    channel.setName(newChannelName, 'Temp voice ownership transferred').catch(error => {
      if (error.code !== UNKNOWN_CHANNEL) {
        console.warn(`[TempVoice] Could not rename ${channel.id} after an ownership transfer:`, error.message);
      }
    });

    // Notify the new owner; DMs may be closed
    try {
      const prefix = await getPrefix(guild.id);
      const embed = await infoEmbed(guild.id, 'Channel Ownership Transferred',
        `**Notice:** You are now the owner of **${newChannelName}** in **${guild.name}**, Master.\n\n` +
        `Use \`${prefix}tempvc\` or the voice interface to manage your channel.`);
      await newOwner.send({ embeds: [embed] });
    } catch {
      // DMs disabled
    }
  } catch (error) {
    console.error('[TempVoice] Error transferring temp voice channel ownership:', error);
  }
}

// Cleanup function for orphaned temp channels (run on bot startup)
export async function cleanupTempChannels(client) {
  let allTempChannels;
  try {
    allTempChannels = await TempVoice.find({});
  } catch (error) {
    console.error('[TempVoice] Error loading temp channels for cleanup:', error);
    return;
  }

  for (const tempData of allTempChannels) {
    try {
      const guild = client.guilds.cache.get(tempData.guildId);
      if (!guild) {
        // Guild no longer accessible, delete record
        await TempVoice.deleteOne({ _id: tempData._id });
        continue;
      }

      // An outage leaves the guild cached without its channels; that is not a deletion
      if (!guild.available) continue;

      const channel = guild.channels.cache.get(tempData.channelId);
      if (!channel) {
        // Channel no longer exists, delete record
        await TempVoice.deleteOne({ _id: tempData._id });
        continue;
      }

      if (channel.members.filter(m => !m.user.bot).size === 0) {
        if (await removeTempChannel(tempData, channel, 'Temp voice channel cleanup on startup')) {
          console.log(`[TempVoice] Cleaned up orphaned temp channel: ${tempData.name}`);
        }
      }
    } catch (error) {
      console.error(`[TempVoice] Error cleaning up temp channel ${tempData.channelId}:`, error);
    }
  }
}
