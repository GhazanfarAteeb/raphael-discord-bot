import Member from '../../models/Member.js';
import Level from '../../models/Level.js';
import Guild from '../../models/Guild.js';
import { sendLevelUpAnnouncement } from '../../commands/config/levelup.js';

// XP cooldown cache to prevent spam
const xpCooldowns = new Map(); // guildId:userId -> lastXpTime

export default {
    name: 'messageCreate',
    once: false,
    
    execute: async (message, client) => {
        // Ignore bot messages and DMs
        if (message.author.bot || !message.guild) return;
        
        try {
            const userId = message.author.id;
            const guildId = message.guild.id;
            
            // Get or create member (reassigned when a save hits a version conflict)
            let member = await Member.getMember(userId, guildId, {
                username: message.author.username,
                discriminator: message.author.discriminator,
                displayName: message.member?.displayName,
                globalName: message.author.globalName,
                avatarUrl: message.author.displayAvatarURL({ extension: 'png', size: 256 }),
                tag: message.author.tag,
                createdAt: message.author.createdAt
            });
            
            // Initialize stats if not exists
            if (!member.stats) {
                member.stats = {
                    messagesCount: 0,
                    voiceTime: 0,
                    messageHistory: [],
                    voiceHistory: [],
                    topChannels: []
                };
            }
            
            // Increment total message count
            member.stats.messagesCount = (member.stats.messagesCount || 0) + 1;
            member.stats.lastMessageAt = new Date();
            
            // Update daily message history
            const today = new Date();
            today.setHours(0, 0, 0, 0);
            
            const todayEntry = member.stats.messageHistory?.find(entry => {
                const entryDate = new Date(entry.date);
                entryDate.setHours(0, 0, 0, 0);
                return entryDate.getTime() === today.getTime();
            });
            
            if (todayEntry) {
                todayEntry.count += 1;
            } else {
                if (!member.stats.messageHistory) member.stats.messageHistory = [];
                member.stats.messageHistory.push({
                    date: today,
                    count: 1
                });
                
                // Keep only last 30 days
                if (member.stats.messageHistory.length > 30) {
                    member.stats.messageHistory = member.stats.messageHistory.slice(-30);
                }
            }
            
            // Update top channels
            if (!member.stats.topChannels) member.stats.topChannels = [];
            
            const channelEntry = member.stats.topChannels.find(ch => ch.channelId === message.channel.id);
            
            if (channelEntry) {
                channelEntry.messageCount += 1;
                channelEntry.lastMessageAt = new Date();
            } else {
                member.stats.topChannels.push({
                    channelId: message.channel.id,
                    channelName: message.channel.name,
                    messageCount: 1,
                    lastMessageAt: new Date()
                });
                
                // Keep only top 10 channels
                if (member.stats.topChannels.length > 10) {
                    member.stats.topChannels.sort((a, b) => b.messageCount - a.messageCount);
                    member.stats.topChannels = member.stats.topChannels.slice(0, 10);
                }
            }
            
            // Save with retry logic for version conflicts
            let retryCount = 0;
            const maxRetries = 3;
            
            while (retryCount < maxRetries) {
                try {
                    await member.save();
                    break; // Success, exit retry loop
                } catch (saveError) {
                    if (saveError.name === 'VersionError' && retryCount < maxRetries - 1) {
                        retryCount++;
                        // Refetch the document to get the latest version
                        member = await Member.findOne({ userId, guildId });
                        if (!member) break; // Member was deleted, exit
                        
                        // Reapply the stats update
                        member.stats = member.stats || {};
                        member.stats.messagesCount = (member.stats.messagesCount || 0) + 1;
                        member.stats.lastMessageAt = new Date();
                        
                        console.log(`[StatsTracker] Version conflict, retrying (${retryCount}/${maxRetries})`);
                        continue;
                    } else {
                        throw saveError; // Re-throw if not version error or max retries reached
                    }
                }
            }
            
            // === XP SYSTEM (Guild-Specific) ===
            await handleXPGain(message, client, userId, guildId);
            
        } catch (error) {
            console.error('Error tracking message stats:', error);
        }
    }
};

/**
 * Handle XP gain for a message
 * XP is guild-specific - each server has its own XP/levels
 */
async function handleXPGain(message, client, userId, guildId) {
    try {
        // Get guild config to check if level system is enabled
        const guildConfig = await Guild.getGuild(guildId, message.guild.name);
        
        // Check if level system is enabled
        if (!guildConfig.features?.levelSystem?.enabled) return;
        
        const levelConfig = guildConfig.features.levelSystem;
        
        // Check if channel is in no-XP list. Threads and forum posts inherit the blacklist
        // of their parent channel.
        const noXpChannels = levelConfig.noXpChannels || [];
        if (noXpChannels.includes(message.channel.id) ||
            (message.channel.parentId && noXpChannels.includes(message.channel.parentId))) {
            return; // No XP in this channel
        }
        
        // Check XP cooldown (default 60 seconds per guild)
        const cooldownKey = `${guildId}:${userId}`;
        const now = Date.now();
        const lastXpTime = xpCooldowns.get(cooldownKey) || 0;
        const cooldownMs = (levelConfig.xpCooldown || 60) * 1000;
        
        if (now - lastXpTime < cooldownMs) {
            return; // Still on cooldown, no XP
        }
        
        // Update cooldown
        xpCooldowns.set(cooldownKey, now);
        
        // Calculate XP gain (random between min and max)
        const minXP = levelConfig.minXpPerMessage || 15;
        const maxXP = levelConfig.maxXpPerMessage || 25;
        let xpGain = Math.floor(Math.random() * (maxXP - minXP + 1)) + minXP;
        
        // Apply XP multipliers
        const member = message.member;
        if (member) {
            // Check for role multipliers (use highest)
            const xpMultipliers = levelConfig.xpMultipliers || [];
            let highestMultiplier = 1;
            
            for (const mult of xpMultipliers) {
                if (member.roles.cache.has(mult.roleId) && mult.multiplier > highestMultiplier) {
                    highestMultiplier = mult.multiplier;
                }
            }
            
            // Check for booster bonus (additive)
            if (member.premiumSince) {
                const boosterMult = levelConfig.boosterMultiplier || 1.5;
                highestMultiplier += (boosterMult - 1); // Add bonus portion
            }
            
            xpGain = Math.floor(xpGain * highestMultiplier);
        }
        
        // Get or create level data for this user in this guild
        let levelData = await Level.findOne({ userId, guildId });
        
        if (!levelData) {
            levelData = new Level({
                userId,
                guildId,
                username: message.author.username,
                level: 0,
                xp: 0,
                totalXP: 0,
                messageCount: 0
            });
        }
        
        // Update username
        levelData.username = message.author.username;
        levelData.messageCount = (levelData.messageCount || 0) + 1;
        levelData.lastMessageTime = new Date();
        
        // Add XP and check for level ups
        const previousLevel = levelData.level;
        const leveledUp = levelData.addXP(xpGain);
        
        await levelData.save();
        
        // Announce level up with the guild's level up settings (levelup command)
        if (leveledUp.length > 0 && levelConfig.announceLevelUp !== false) {
            await sendLevelUpAnnouncement({
                guild: message.guild,
                member: message.member ?? message.author,
                guildConfig,
                levelData,
                levelsGained: leveledUp,
                oldLevel: previousLevel,
                fallbackChannel: message.channel
            });
        }
        
        // Check for level rewards
        if (leveledUp.length > 0 && levelConfig.rewards?.length > 0) {
            await checkLevelRewards(message, levelData, levelConfig.rewards, leveledUp);
        }
        
    } catch (error) {
        console.error('Error handling XP gain:', error);
    }
}

/**
 * Check and award level rewards (roles)
 */
async function checkLevelRewards(message, levelData, rewards, leveledUp) {
    try {
        const newLevel = Math.max(...leveledUp);
        
        // Find rewards for levels we just reached
        const earnedRewards = rewards.filter(reward => {
            const rewardLevel = parseInt(reward.level);
            return leveledUp.includes(rewardLevel) || (rewardLevel <= newLevel && 
                !levelData.rewardsClaimed?.some(r => r.level === rewardLevel));
        });
        
        for (const reward of earnedRewards) {
            if (reward.roleId) {
                const role = message.guild.roles.cache.get(reward.roleId);
                if (role && message.member) {
                    try {
                        await message.member.roles.add(role, `Level ${reward.level} reward`);
                        
                        // Track claimed reward
                        if (!levelData.rewardsClaimed) levelData.rewardsClaimed = [];
                        levelData.rewardsClaimed.push({
                            level: parseInt(reward.level),
                            roleId: reward.roleId,
                            claimedAt: new Date()
                        });
                        await levelData.save();
                        
                    } catch (error) {
                        console.error(`Failed to add level reward role: ${error.message}`);
                    }
                }
            }
        }
        
    } catch (error) {
        console.error('Error checking level rewards:', error);
    }
}

// Clean up old cooldown entries every 5 minutes
setInterval(() => {
    const now = Date.now();
    const maxAge = 5 * 60 * 1000; // 5 minutes
    
    for (const [key, time] of xpCooldowns) {
        if (now - time > maxAge) {
            xpCooldowns.delete(key);
        }
    }
}, 5 * 60 * 1000);
