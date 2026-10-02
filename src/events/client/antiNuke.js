import { Events, AuditLogEvent, Collection } from 'discord.js';
import Guild from '../../models/Guild.js';
import { errorEmbed, GLYPHS } from '../../utils/embeds.js';

// Cache for tracking potentially dangerous actions
const actionCache = new Collection(); // guildId -> { userId -> { bans: [], kicks: [], roleDeletes: [], channelDeletes: [] } }

const ACTION_LABELS = {
  removeroles: 'Remove Roles',
  kick: 'Kick',
  ban: 'Ban'
};

const VIOLATION_LABELS = {
  bans: 'Bans',
  kicks: 'Kicks',
  roleDeletes: 'Role deletions',
  channelDeletes: 'Channel deletions'
};

export default {
  name: 'antiNuke',

  // Initialize the anti-nuke system
  async initialize(client) {
    // Listen to various audit log events
    client.on(Events.GuildBanAdd, async (ban) => {
      await this.trackAction(client, ban.guild, 'ban');
    });

    client.on(Events.GuildMemberRemove, async (member) => {
      // Check if it was a kick via audit log
      await this.checkForKick(client, member);
    });

    client.on(Events.GuildRoleDelete, async (role) => {
      await this.trackAction(client, role.guild, 'roleDelete', role);
    });

    client.on(Events.ChannelDelete, async (channel) => {
      if (channel.guild) {
        await this.trackAction(client, channel.guild, 'channelDelete', channel);
      }
    });

    console.log('[RAPHAEL] Anti-nuke protection initialized');
  },

  async checkForKick(client, member) {
    try {
      // Verify guild still exists and bot is in it
      if (!member.guild || !client.guilds.cache.has(member.guild.id)) return;
      
      const fetchedLogs = await member.guild.fetchAuditLogs({
        limit: 1,
        type: AuditLogEvent.MemberKick,
      });

      const kickLog = fetchedLogs.entries.first();
      if (!kickLog) return;

      const { target, executor, createdTimestamp } = kickLog;

      // Check if this is the kick we're looking for (within last 5 seconds)
      if (target?.id === member.user.id && Date.now() - createdTimestamp < 5000) {
        await this.trackAction(client, member.guild, 'kick', null, executor);
      }
    } catch (error) {
      // Likely missing audit log permissions or guild unavailable
      if (error.code !== 10004) { // Ignore "Unknown Guild" errors
        console.error('checkForKick error:', error.message);
      }
    }
  },

  async trackAction(client, guild, actionType, item = null, executor = null) {
    try {
      // Verify guild still exists and bot is in it
      if (!guild || !client.guilds.cache.has(guild.id)) return;
      
      const guildConfig = await Guild.getGuild(guild.id, guild.name);
      const antiNuke = guildConfig?.features?.autoMod?.antiNuke;

      if (!antiNuke?.enabled) return;

      // Get executor from audit logs if not provided
      if (!executor) {
        try {
          // Double-check guild is still accessible
          if (!client.guilds.cache.has(guild.id)) return;
          
          const auditLogType = {
            ban: AuditLogEvent.MemberBanAdd,
            kick: AuditLogEvent.MemberKick,
            roleDelete: AuditLogEvent.RoleDelete,
            channelDelete: AuditLogEvent.ChannelDelete
          }[actionType];

          const fetchedLogs = await guild.fetchAuditLogs({
            limit: 1,
            type: auditLogType,
          });

          const logEntry = fetchedLogs.entries.first();
          if (logEntry && Date.now() - logEntry.createdTimestamp < 5000) {
            executor = logEntry.executor;
          }
        } catch (error) {
          // Ignore "Unknown Guild" errors (bot removed from guild)
          if (error.code === 10004) return;
          console.error('Failed to fetch audit log:', error.message);
          return;
        }
      }

      if (!executor || executor.id === client.user.id) return;

      // Skip whitelisted users
      if (antiNuke.whitelistedUsers?.includes(executor.id)) return;

      // Skip server owner
      if (executor.id === guild.ownerId) return;

      // Initialize cache for guild
      if (!actionCache.has(guild.id)) {
        actionCache.set(guild.id, new Collection());
      }

      const guildCache = actionCache.get(guild.id);

      // Initialize cache for user
      if (!guildCache.has(executor.id)) {
        guildCache.set(executor.id, {
          bans: [],
          kicks: [],
          roleDeletes: [],
          channelDeletes: []
        });
      }

      const userCache = guildCache.get(executor.id);
      const now = Date.now();
      const timeWindow = antiNuke.timeWindow * 1000;

      // Clean old entries
      const cleanOldEntries = (arr) => arr.filter(t => now - t < timeWindow);
      userCache.bans = cleanOldEntries(userCache.bans);
      userCache.kicks = cleanOldEntries(userCache.kicks);
      userCache.roleDeletes = cleanOldEntries(userCache.roleDeletes);
      userCache.channelDeletes = cleanOldEntries(userCache.channelDeletes);

      // Add new entry
      const cacheKey = {
        ban: 'bans',
        kick: 'kicks',
        roleDelete: 'roleDeletes',
        channelDelete: 'channelDeletes'
      }[actionType];

      userCache[cacheKey].push(now);

      // Check thresholds
      const thresholds = {
        bans: antiNuke.banThreshold,
        kicks: antiNuke.kickThreshold,
        roleDeletes: antiNuke.roleDeleteThreshold,
        channelDeletes: antiNuke.channelDeleteThreshold
      };

      const violations = [];
      for (const [key, threshold] of Object.entries(thresholds)) {
        if (userCache[key].length >= threshold) {
          violations.push(`${VIOLATION_LABELS[key]}: ${userCache[key].length}/${threshold}`);
        }
      }

      if (violations.length > 0) {
        await this.handleNukeAttempt(client, guild, guildConfig, executor, violations, antiNuke.action);

        // Clear user's cache after action
        guildCache.delete(executor.id);
      }

    } catch (error) {
      console.error('Anti-nuke tracking error:', error);
    }
  },

  // Applies the configured action to the executor; throws when Discord refuses it
  async applyNukeAction(guild, executor, executorMember, action) {
    // Lowercased: older configs saved the action as 'removeroles'
    switch (String(action || 'removeRoles').toLowerCase()) {
      case 'removeroles':
        // Remove all roles from the user
        if (executorMember.manageable) {
          const rolesToRemove = executorMember.roles.cache.filter(r => r.id !== guild.id && !r.managed); // managed (integration/booster) roles can't be removed and would fail the whole call
          await executorMember.roles.remove(rolesToRemove, '[Anti-Nuke] Suspicious activity detected');
        }
        break;

      case 'kick':
        if (executorMember.kickable) {
          await executorMember.kick('[Anti-Nuke] Suspicious activity detected');
        }
        break;

      case 'ban':
        if (executorMember.bannable) {
          await guild.members.ban(executor.id, {
            reason: '[Anti-Nuke] Suspicious activity detected',
            deleteMessageSeconds: 86400
          });
        }
        break;
    }
  },

  // What the configured action did, for the alert
  async describeOutcome(guild, executor, action) {
    const normalized = String(action || 'removeRoles').toLowerCase();
    const label = ACTION_LABELS[normalized] || `Unknown action "${String(action)}"`;

    const executorMember = await guild.members.fetch(executor.id).catch(() => null);
    if (!executorMember) {
      return `${label} (not applied: the executor is no longer a member)`;
    }

    // The same checks the action itself makes before acting
    const permitted = {
      removeroles: executorMember.manageable,
      kick: executorMember.kickable,
      ban: executorMember.bannable
    }[normalized];

    if (!permitted) {
      return ACTION_LABELS[normalized]
        ? `${label} (not applied: I lack the permission or role position to act on the executor)`
        : `${label} (no action applied)`;
    }

    try {
      await this.applyNukeAction(guild, executor, executorMember, action);
      return label;
    } catch (error) {
      console.error('[Anti-Nuke] Failed to apply the configured action:', error);
      return `${label} (failed: ${error.message})`;
    }
  },

  async handleNukeAttempt(client, guild, guildConfig, executor, violations, action) {
    console.log(`[Anti-Nuke] Nuke attempt detected in ${guild.name} by ${executor.tag}: ${violations.join(', ')}`);

    // The alert goes out even when the action could not be applied
    const outcome = await this.describeOutcome(guild, executor, action);

    try {
      // Send alert to staff
      if (guildConfig.channels?.alertLog) {
        const alertChannel = guild.channels.cache.get(guildConfig.channels.alertLog);
        if (alertChannel) {
          const embed = await errorEmbed(guild.id, 'Nuke Attempt Detected',
            `**Executor:** ${executor.tag} (${executor.id})\n\n` +
            `**Violations:**\n${violations.map(v => `${GLYPHS.ERROR} ${v}`).join('\n')}\n\n` +
            `**Action Taken:** ${outcome}\n\n` +
            `${GLYPHS.WARNING} Review the audit log immediately, Master.`
          );

          const staffMention = guildConfig.roles?.staffRoles?.length > 0
            ? guildConfig.roles.staffRoles.map(r => `<@&${r}>`).join(' ')
            : '';

          await alertChannel.send({
            content: staffMention || '@here',
            embeds: [embed]
          });
        }
      }

      // DM the server owner
      try {
        const owner = await guild.fetchOwner();
        const dmEmbed = await errorEmbed(guild.id, 'Nuke Attempt on Your Server',
          `**Server:** ${guild.name}\n` +
          `**Executor:** ${executor.tag} (${executor.id})\n\n` +
          `**Violations:**\n${violations.map(v => `${GLYPHS.DOT} ${v}`).join('\n')}\n\n` +
          `**Action Taken:** ${outcome}\n\n` +
          `Please review your server's audit log, Master.`
        );
        await owner.send({ embeds: [dmEmbed] }).catch(() => { });
      } catch (error) {
        console.error('Failed to DM server owner:', error);
      }

    } catch (error) {
      console.error('Failed to handle nuke attempt:', error);
    }
  }
};

// Cleanup cache periodically (every 5 minutes)
setInterval(() => {
  const now = Date.now();
  const maxAge = 120000; // 2 minutes

  for (const [guildId, userCache] of actionCache) {
    for (const [userId, data] of userCache) {
      const hasRecentActions =
        data.bans.some(t => now - t < maxAge) ||
        data.kicks.some(t => now - t < maxAge) ||
        data.roleDeletes.some(t => now - t < maxAge) ||
        data.channelDeletes.some(t => now - t < maxAge);

      if (!hasRecentActions) {
        userCache.delete(userId);
      }
    }

    if (userCache.size === 0) {
      actionCache.delete(guildId);
    }
  }
}, 300000);
