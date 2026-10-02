import Guild from '../../models/Guild.js';
import { EmbedBuilder } from 'discord.js';
import { COLORS, GLYPHS } from '../../utils/embeds.js';
import { getRandomFooter } from '../../utils/raphael.js';
import { getAssignableRoleError } from '../../utils/helpers.js';

export default {
  name: 'guildMemberAdd',

  async execute(member, client) {
    // Ignore partial members
    if (member.partial) {
      try {
        await member.fetch();
      } catch {
        return;
      }
    }

    try {
      const guildConfig = await Guild.getGuild(member.guild.id, member.guild.name);

      // Roles may sit under autoRole (prefix command) or the legacy autorole key; either can enable the system
      if (!guildConfig.autoRole?.enabled && !guildConfig.autorole?.enabled) return;

      // Get roles based on whether the member is a bot or user
      // Combine roles from both possible config locations
      let rolesToAssign;
      if (member.user.bot) {
        rolesToAssign = [
          ...(guildConfig.autoRole?.botRoles || []),
          ...(guildConfig.autorole?.botRoles || [])
        ];
      } else {
        rolesToAssign = [
          ...(guildConfig.autoRole?.roles || []),
          ...(guildConfig.autorole?.roles || []),
          ...(guildConfig.autorole?.humanRoles || [])
        ];
      }

      // Remove duplicates
      rolesToAssign = [...new Set(rolesToAssign)];

      if (rolesToAssign.length === 0) return;

      const me = member.guild.members.me;

      // Filter valid roles
      const validRoles = rolesToAssign.filter(roleId => {
        const role = member.guild.roles.cache.get(roleId);
        if (!role) return false;
        // Re-check at join time: a role configured earlier may since have moved above the bot,
        // become managed, or been given moderation/admin permissions
        const roleError = getAssignableRoleError(role, me);
        if (roleError) {
          console.log(`[AutoRole] Skipping role "${role.name}" in ${member.guild.name}: ${roleError}`);
          return false;
        }
        // Skip color roles - they should never be auto-assigned
        // Color roles are meant to be selected via reaction roles panel
        if (role.name.startsWith('🎨 ')) {
          console.log(`[AutoRole] Skipping color role "${role.name}" - color roles should not be auto-assigned`);
          return false;
        }
        return true;
      });

      if (validRoles.length === 0) return;

      // Delay is stored in milliseconds (check both config locations)
      const delay = guildConfig.autoRole?.delay || guildConfig.autorole?.delay || 0;

      const assignRoles = async () => {
        try {
          // Re-fetch member to make sure they're still in the guild
          const freshMember = await member.guild.members.fetch(member.id).catch(() => null);
          if (!freshMember) return; // Member left

          // Add all roles
          await freshMember.roles.add(validRoles, 'Auto Role on Join');

          // Log to member log channel if configured
          const logChannel = guildConfig.channels?.memberLog
            ? member.guild.channels.cache.get(guildConfig.channels.memberLog)
            : null;
          if (logChannel) {
            const embed = new EmbedBuilder()
              .setTitle('『 Auto Role Assigned 』')
              .setDescription(
                `${GLYPHS.ARROW_RIGHT} **Member:** ${freshMember.user.tag} (${freshMember})\n` +
                `${GLYPHS.ARROW_RIGHT} **Roles:** ${validRoles.map(id => `<@&${id}>`).join(', ')}`
              )
              .setColor(COLORS.RAPHAEL_SUCCESS)
              .setFooter({ text: getRandomFooter() })
              .setTimestamp();
            logChannel.send({ embeds: [embed], allowedMentions: { parse: [] } }).catch(() => {});
          }
        } catch (error) {
          console.error(`[AutoRole] Failed to assign roles to ${member.user.tag}:`, error.message);
        }
      };

      if (delay > 0) {
        setTimeout(assignRoles, delay);
      } else {
        await assignRoles();
      }

    } catch (error) {
      console.error('[AutoRole] Error in guildMemberAdd:', error);
    }
  }
};
