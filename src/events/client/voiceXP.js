import Guild from '../../models/Guild.js';
import Level from '../../models/Level.js';
import { sendLevelUpAnnouncement } from '../../commands/config/levelup.js';

// Track voice sessions in memory
const voiceSessions = new Map();

export default {
  name: 'voiceStateUpdate',

  async execute(oldState, newState, client) {
    const userId = newState.member?.id || oldState.member?.id;
    const guildId = newState.guild?.id || oldState.guild?.id;

    if (!userId || !guildId) return;

    // Ignore bots
    if (newState.member?.user?.bot || oldState.member?.user?.bot) return;

    try {
      const guildConfig = await Guild.getGuild(guildId);

      // Voice XP needs the leveling system on and voice XP not switched off
      if (!guildConfig.features?.levelSystem?.enabled || guildConfig.voiceXP?.enabled === false) return;

      const sessionKey = `${guildId}-${userId}`;

      // User joined a voice channel
      if (!oldState.channelId && newState.channelId) {
        await handleVoiceJoin(newState, guildConfig, sessionKey);
      }
      // User left a voice channel
      else if (oldState.channelId && !newState.channelId) {
        await handleVoiceLeave(oldState, guildConfig, sessionKey, client);
      }
      // User switched channels
      else if (oldState.channelId !== newState.channelId) {
        await handleVoiceLeave(oldState, guildConfig, sessionKey, client);
        await handleVoiceJoin(newState, guildConfig, sessionKey);
      }
      // User muted/deafened state changed
      else if (oldState.selfMute !== newState.selfMute ||
        oldState.selfDeaf !== newState.selfDeaf ||
        oldState.serverMute !== newState.serverMute ||
        oldState.serverDeaf !== newState.serverDeaf) {
        await handleMuteDeafChange(newState, guildConfig, sessionKey);
      }

    } catch (error) {
      console.error('Voice XP Error:', error);
    }
  }
};

async function handleVoiceJoin(state, guildConfig, sessionKey) {
  const channel = state.channel;
  if (!channel) return;

  // Check if channel is excluded
  if (guildConfig.voiceXP?.excludedChannels?.includes(channel.id)) return;

  // Check if it's the AFK channel
  if (guildConfig.voiceXP?.afkChannelExcluded && channel.id === state.guild.afkChannelId) return;

  // Check mute/deafen status
  const isMuted = state.selfMute || state.serverMute;
  const isDeafened = state.selfDeaf || state.serverDeaf;

  if (guildConfig.voiceXP?.mutedExcluded && isMuted) return;
  if (guildConfig.voiceXP?.deafenedExcluded && isDeafened) return;

  // Start tracking session
  voiceSessions.set(sessionKey, {
    userId: state.member.id,
    guildId: state.guild.id,
    channelId: channel.id,
    joinedAt: Date.now(),
    earnedMs: 0, // time banked before a pause
    isPaused: false
  });
}

async function handleVoiceLeave(state, guildConfig, sessionKey, client) {
  const session = voiceSessions.get(sessionKey);
  if (!session) return;

  voiceSessions.delete(sessionKey);

  // Time before a mute/deafen pause still counts; the paused stretch does not
  const timeSpent = (session.earnedMs || 0) + (session.isPaused ? 0 : Date.now() - session.joinedAt);
  const minutesSpent = Math.floor(timeSpent / 60000);

  // Minimum 1 minute to get XP
  if (minutesSpent < 1) return;

  // Check minimum users requirement
  const channel = state.channel;
  if (channel && guildConfig.voiceXP?.minUsersRequired > 1) {
    const humanMembers = channel.members.filter(m => !m.user.bot).size;
    if (humanMembers < guildConfig.voiceXP.minUsersRequired - 1) return; // -1 because user already left
  }

  // Calculate XP
  const xpPerMinute = guildConfig.voiceXP?.xpPerMinute || 5;
  let xpEarned = minutesSpent * xpPerMinute;

  // Cap at 60 minutes worth of XP per session to prevent abuse
  xpEarned = Math.min(xpEarned, 60 * xpPerMinute);

  // Apply multipliers
  const member = state.member;
  if (member) {
    // Booster multiplier
    if (member.premiumSince && guildConfig.features?.levelSystem?.boosterMultiplier) {
      xpEarned = Math.floor(xpEarned * guildConfig.features.levelSystem.boosterMultiplier);
    }

    // Role multipliers
    if (guildConfig.features?.levelSystem?.xpMultipliers) {
      for (const mult of guildConfig.features.levelSystem.xpMultipliers) {
        if (member.roles.cache.has(mult.roleId)) {
          xpEarned = Math.floor(xpEarned * mult.multiplier);
          break;
        }
      }
    }
  }

  // Award XP - Validate required fields before database operations
  if (!session.userId || !session.guildId) {
    console.error('Voice XP Error: Missing userId or guildId in session', session);
    return;
  }

  let levelData = await Level.findOne({ userId: session.userId, guildId: session.guildId });
  if (!levelData) {
    levelData = new Level({
      userId: session.userId,
      guildId: session.guildId,
      username: member?.user?.username || 'Unknown'
    });
  }

  const oldLevel = levelData.level;
  const levelsGained = levelData.addXP(xpEarned);

  // Update voice stats
  levelData.voiceTime = (levelData.voiceTime || 0) + Math.floor(timeSpent / 1000);
  levelData.voiceXP = (levelData.voiceXP || 0) + xpEarned;

  await levelData.save();

  if (levelsGained.length === 0 || !member) return;

  // Announce with the guild's level up settings (levelup command). There is no message
  // channel to fall back to, so it goes to the configured level up channel only.
  await sendLevelUpAnnouncement({
    guild: state.guild,
    member,
    guildConfig,
    levelData,
    levelsGained,
    oldLevel,
    fields: [
      { name: '▸ Voice Time', value: formatTime(levelData.voiceTime), inline: true },
      { name: '▸ Voice XP', value: levelData.voiceXP.toLocaleString(), inline: true }
    ],
    note: '*Earned through voice activity.*'
  });

  // Role rewards do not depend on announcements being enabled
  await grantLevelRewards(member, levelsGained, guildConfig);
}

async function handleMuteDeafChange(state, guildConfig, sessionKey) {
  const session = voiceSessions.get(sessionKey);
  if (!session) return;

  const isMuted = state.selfMute || state.serverMute;
  const isDeafened = state.selfDeaf || state.serverDeaf;

  const shouldPause =
    (guildConfig.voiceXP?.mutedExcluded && isMuted) ||
    (guildConfig.voiceXP?.deafenedExcluded && isDeafened);

  if (shouldPause && !session.isPaused) {
    // Pause session - bank the time earned so far
    session.earnedMs = (session.earnedMs || 0) + (Date.now() - session.joinedAt);
    session.isPaused = true;
    session.pausedAt = Date.now();
  } else if (!shouldPause && session.isPaused) {
    // Resume session
    session.isPaused = false;
    session.joinedAt = Date.now(); // Reset join time
  }
}

async function grantLevelRewards(member, levels, guildConfig) {
  const rewards = guildConfig.features?.levelSystem?.rewards || [];
  for (const reward of rewards) {
    if (!reward.roleId || !levels.includes(Number(reward.level))) continue;
    if (member.roles.cache.has(reward.roleId)) continue;
    try {
      await member.roles.add(reward.roleId, `Level ${reward.level} reward`);
    } catch (e) {
      console.error(`Failed to add level reward role: ${e.message}`);
    }
  }
}

function formatTime(seconds) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  return `${minutes}m`;
}

// Export for use in interval
export { voiceSessions };
