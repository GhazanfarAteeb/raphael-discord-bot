import { Events, Collection, PermissionFlagsBits, ChannelType, EmbedBuilder } from 'discord.js';
import Guild from '../../models/Guild.js';
import { errorEmbed, warningEmbed, COLORS, GLYPHS } from '../../utils/embeds.js';
import { getPrefix } from '../../utils/helpers.js';
import { getRandomFooter } from '../../utils/raphael.js';

// Cache for tracking joins
const joinCache = new Collection(); // guildId -> { joins: [{ userId, timestamp }], raidMode: boolean }

const DEFAULT_JOIN_THRESHOLD = 10;
const DEFAULT_TIME_WINDOW_SECONDS = 30;
const RAID_MODE_DURATION_MS = 300000; // 5 minutes
const ALERT_JOIN_LIST_SIZE = 10;
const BAN_DELETE_MESSAGE_SECONDS = 86400;
const AUDIT_REASON = '[Anti-Raid] Raid protection active';

const ACTION_LABELS = {
  lockdown: 'Lockdown',
  kick: 'Kick',
  ban: 'Ban'
};

function describeAction(action) {
  return ACTION_LABELS[action] || String(action || 'none');
}

export default {
  name: Events.GuildMemberAdd,
  priority: 1, // Run before other member add handlers

  async execute(member, client) {
    try {
      const guildConfig = await Guild.getGuild(member.guild.id, member.guild.name);
      const antiRaid = guildConfig?.features?.autoMod?.antiRaid;

      if (!antiRaid?.enabled) return;

      const guildId = member.guild.id;
      const now = Date.now();

      // Initialize cache for guild
      if (!joinCache.has(guildId)) {
        joinCache.set(guildId, {
          joins: [],
          raidMode: false,
          lockdownActive: false
        });
      }

      const guildCache = joinCache.get(guildId);

      // Clean old joins outside time window
      const timeWindow = (antiRaid.timeWindow || DEFAULT_TIME_WINDOW_SECONDS) * 1000;
      guildCache.joins = guildCache.joins.filter(j => now - j.timestamp < timeWindow);

      // Add this join
      guildCache.joins.push({
        userId: member.user.id,
        timestamp: now
      });

      // Check if we've exceeded the threshold
      if (guildCache.joins.length >= (antiRaid.joinThreshold || DEFAULT_JOIN_THRESHOLD)) {
        if (!guildCache.raidMode) {
          guildCache.raidMode = true;
          await this.handleRaidDetected(member.guild, client, guildConfig, guildCache.joins, antiRaid.action);
        }

        // Take action on this member based on configured action
        await this.handleRaidMember(member, guildConfig, antiRaid.action);
      }

    } catch (error) {
      console.error('Anti-raid error:', error);
    }
  },

  async handleRaidDetected(guild, client, guildConfig, recentJoins, action) {
    console.log(`[Anti-Raid] Raid detected in ${guild.name}: ${recentJoins.length} members joined rapidly`);

    try {
      // Send alert to staff
      if (guildConfig.channels?.alertLog) {
        const alertChannel = guild.channels.cache.get(guildConfig.channels.alertLog);
        if (alertChannel) {
          const joinList = recentJoins.slice(-ALERT_JOIN_LIST_SIZE).map(j => `<@${j.userId}>`).join(', ');

          const embed = await errorEmbed(guild.id, 'Raid Detected',
            `**${recentJoins.length} members** joined in rapid succession, Master.\n\n` +
            `**Recent Joins:**\n${joinList}\n\n` +
            `**Action Being Taken:** ${describeAction(action)}\n\n` +
            `${GLYPHS.WARNING} Review immediately and take additional action if needed.`
          );

          const staffMention = guildConfig.roles?.staffRoles?.length > 0
            ? guildConfig.roles.staffRoles.map(r => `<@&${r}>`).join(' ')
            : '@here';

          await alertChannel.send({
            content: staffMention,
            embeds: [embed]
          }).catch(error => console.error('[Anti-Raid] Failed to send raid alert:', error.message));
        }
      }

      // If action is lockdown, lock all channels
      if (action === 'lockdown') {
        await this.enableLockdown(guild, guildConfig, 'Raid detected - automatic lockdown');
      }

      // DM server owner
      try {
        const owner = await guild.fetchOwner();
        const prefix = await getPrefix(guild.id);
        const dmEmbed = await errorEmbed(guild.id, 'Raid Detected on Your Server',
          `**Server:** ${guild.name}\n` +
          `**Members Joined:** ${recentJoins.length}\n\n` +
          `**Action Taken:** ${describeAction(action)}\n\n` +
          `Use \`${prefix}antiraid disable\` if this was a false positive, Master.\n` +
          `Use \`${prefix}lockdown off\` to end lockdown mode.`
        );
        await owner.send({ embeds: [dmEmbed] }).catch(() => { });
      } catch (error) {
        console.error('Failed to DM server owner:', error);
      }

      // Auto-disable raid mode after 5 minutes
      setTimeout(() => {
        const cache = joinCache.get(guild.id);
        if (cache) {
          cache.raidMode = false;
          cache.joins = [];
        }
      }, RAID_MODE_DURATION_MS);

    } catch (error) {
      console.error('Error handling raid:', error);
    }
  },

  // Built without a database read: it is sent once per member during a raid
  buildRemovalNotice(guild, removal) {
    return new EmbedBuilder()
      .setColor(COLORS.RAPHAEL_WARNING)
      .setTitle('『 Anti-Raid Protection 』')
      .setDescription(
        `**Notice:** You were ${removal} **${guild.name}** by its anti-raid protection.\n\n` +
        (removal === 'kicked from'
          ? 'If this was a mistake, please try rejoining later.'
          : 'If this was a mistake, please contact a server administrator.')
      )
      .setFooter({ text: getRandomFooter() })
      .setTimestamp();
  },

  async handleRaidMember(member, guildConfig, action) {
    try {
      switch (action) {
        case 'kick':
          if (member.kickable) {
            try {
              await member.send({ embeds: [this.buildRemovalNotice(member.guild, 'kicked from')] }).catch(() => { });
              await member.kick(AUDIT_REASON);
            } catch (error) {
              console.error('Failed to kick raid member:', error);
            }
          }
          break;

        case 'ban':
          if (member.bannable) {
            try {
              await member.send({ embeds: [this.buildRemovalNotice(member.guild, 'banned from')] }).catch(() => { });
              await member.ban({
                reason: AUDIT_REASON,
                deleteMessageSeconds: BAN_DELETE_MESSAGE_SECONDS
              });
            } catch (error) {
              console.error('Failed to ban raid member:', error);
            }
          }
          break;

        case 'lockdown':
          // Just lock channels, don't kick/ban
          // Optionally assign a verification role
          if (guildConfig.roles?.susRole) {
            const susRole = member.guild.roles.cache.get(guildConfig.roles.susRole);
            if (susRole && member.manageable && susRole.editable) {
              await member.roles.add(susRole, AUDIT_REASON);
            }
          }
          break;
      }
    } catch (error) {
      console.error('Error handling raid member:', error);
    }
  },

  async enableLockdown(guild, guildConfig, reason) {
    console.log(`[Anti-Raid] Enabling lockdown in ${guild.name}`);

    try {
      // A manual lockdown is already holding the original permissions; locking again
      // would overwrite them with the locked values
      if (guildConfig.security?.lockdownActive) {
        console.log(`[Anti-Raid] Lockdown already active in ${guild.name}; leaving it in place`);
        return;
      }

      // Lock all text channels, keeping each channel's original @everyone Send Messages
      // overwrite so `lockdown off` restores it exactly
      const textChannels = guild.channels.cache.filter(c => c.type === ChannelType.GuildText);
      const savedPermissions = [];

      for (const channel of textChannels.values()) {
        const previous = readSendMessagesOverwrite(channel);
        try {
          await channel.permissionOverwrites.edit(guild.id, {
            SendMessages: false
          }, { reason: `[Anti-Raid] ${reason}` });
          savedPermissions.push({ channelId: channel.id, channelType: 'text', permissions: { SendMessages: previous } });
        } catch (error) {
          // Channel might not be editable
        }
      }

      if (savedPermissions.length === 0) {
        console.warn(`[Anti-Raid] Could not lock any channel in ${guild.name}`);
        return;
      }

      // Guild.getGuild returns a plain cached object: writes go through updateGuild
      await Guild.updateGuild(guild.id, {
        $set: {
          'security.lockdownActive': true,
          'security.lockdownReason': reason,
          'security.lockdownBy': guild.client.user.id,
          'security.lockdownAt': new Date(),
          'security.lockdownPermissions': savedPermissions
        }
      });

      const cache = joinCache.get(guild.id);
      if (cache) {
        cache.lockdownActive = true;
      }

      // Announce the lockdown in the alert channel
      if (guildConfig.channels?.alertLog) {
        const alertChannel = guild.channels.cache.get(guildConfig.channels.alertLog);
        if (alertChannel) {
          const prefix = await getPrefix(guild.id);
          const embed = await warningEmbed(guild.id, 'Server Lockdown Enabled',
            `**Notice:** The server has been locked down, Master.\n**Reason:** ${reason}\n\n` +
            `${GLYPHS.ARROW_RIGHT} **Channels Locked:** ${savedPermissions.length} of ${textChannels.size}\n` +
            `${GLYPHS.ARROW_RIGHT} Regular members cannot send messages until the lockdown is lifted.\n\n` +
            `Staff: use \`${prefix}lockdown off\` to end the lockdown.`
          );
          await alertChannel.send({ embeds: [embed] })
            .catch(error => console.error('[Anti-Raid] Failed to announce lockdown:', error.message));
        }
      }

    } catch (error) {
      console.error('Error enabling lockdown:', error);
    }
  }
};

// Current @everyone Send Messages overwrite: true (allowed), false (denied) or null (inherit)
function readSendMessagesOverwrite(channel) {
  const overwrite = channel.permissionOverwrites.cache.get(channel.guild.id);
  if (overwrite?.allow.has(PermissionFlagsBits.SendMessages)) return true;
  if (overwrite?.deny.has(PermissionFlagsBits.SendMessages)) return false;
  return null;
}

// Cleanup old cache entries periodically
setInterval(() => {
  const now = Date.now();
  const maxAge = RAID_MODE_DURATION_MS;

  for (const [guildId, data] of joinCache) {
    // Clean old joins
    data.joins = data.joins.filter(j => now - j.timestamp < maxAge);

    // Reset raid mode if no recent joins
    if (data.joins.length === 0 && data.raidMode) {
      data.raidMode = false;
    }

    if (data.joins.length === 0 && !data.raidMode) {
      joinCache.delete(guildId);
    }
  }
}, 60000);
