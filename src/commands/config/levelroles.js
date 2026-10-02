import { EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import Guild from '../../models/Guild.js';
import { successEmbed, errorEmbed, infoEmbed, GLYPHS } from '../../utils/embeds.js';
import { getPrefix, hasModPerms, getAssignableRoleError } from '../../utils/helpers.js';

export default {
  name: 'levelroles',
  description: 'Manage level-up role rewards',
  usage: 'levelroles add <level> @role | levelroles remove <level> | levelroles list',
  category: 'config',
  aliases: ['lvlroles', 'levelrewards', 'rankrewards'],
  permissions: [PermissionFlagsBits.ManageGuild],
  cooldown: 5,

  async execute(message, args) {
    const guildId = message.guild.id;
    const guildConfig = await Guild.getGuild(guildId);

    // Check for moderator permissions (admin, mod role, or ManageGuild)
    if (!hasModPerms(message.member, guildConfig)) {
      return message.reply({
        embeds: [await errorEmbed(guildId, 'Permission Denied',
          `${GLYPHS.LOCK} You need Moderator/Staff permissions to manage level roles.`)]
      });
    }

    const subCommand = args[0]?.toLowerCase();

    // Initialize rewards array if not exists
    if (!guildConfig.features.levelSystem.rewards) {
      guildConfig.features.levelSystem.rewards = [];
    }

    // No args - show help
    if (!subCommand) {
      return this.showHelp(message, guildId, guildConfig);
    }

    switch (subCommand) {
      case 'add':
      case 'set':
        return this.addReward(message, args.slice(1), guildConfig, guildId);
      case 'remove':
      case 'delete':
        return this.removeReward(message, args.slice(1), guildConfig, guildId);
      case 'list':
      case 'show':
        return this.listRewards(message, guildConfig, guildId);
      case 'clear':
        return this.clearRewards(message, guildConfig, guildId);
      default:
        return this.showHelp(message, guildId, guildConfig);
    }
  },

  async showHelp(message, guildId, guildConfig) {
    const rewards = guildConfig.features.levelSystem.rewards || [];
    const prefix = await getPrefix(guildId);

    const embed = new EmbedBuilder()
      .setColor('#5865F2')
      .setTitle('🎖️ Level Roles System')
      .setDescription(
        `**Active Rewards:** ${rewards.length}\n\n` +
        `**Commands:**\n` +
        `${GLYPHS.ARROW_RIGHT} \`${prefix}levelroles add <level> @role\` - Add reward\n` +
        `${GLYPHS.ARROW_RIGHT} \`${prefix}levelroles remove <level>\` - Remove reward\n` +
        `${GLYPHS.ARROW_RIGHT} \`${prefix}levelroles list\` - View all rewards\n` +
        `${GLYPHS.ARROW_RIGHT} \`${prefix}levelroles clear\` - Remove all rewards\n\n` +
        `**Example:**\n` +
        `\`${prefix}levelroles add 5 @Active Member\`\n` +
        `\`${prefix}levelroles add 10 @Regular\``
      )
      .setFooter({ text: 'Users automatically receive roles when reaching the level!' })
      .setTimestamp();

    return message.reply({ embeds: [embed] });
  },

  async addReward(message, args, guildConfig, guildId) {
    const level = parseInt(args[0]);
    const role = message.mentions.roles.first();
    const prefix = await getPrefix(guildId);

    if (!level || isNaN(level) || level < 1 || level > 100) {
      const embed = await errorEmbed(guildId, 'Invalid Level',
        `${GLYPHS.ERROR} Please provide a valid level (1-100).\n\n` +
        `**Usage:** \`${prefix}levelroles add <level> @role\``
      );
      return message.reply({ embeds: [embed] });
    }

    if (!role) {
      const embed = await errorEmbed(guildId, 'No Role Mentioned',
        `${GLYPHS.ERROR} Please mention a role to add.\n\n` +
        `**Usage:** \`${prefix}levelroles add ${level} @role\``
      );
      return message.reply({ embeds: [embed] });
    }

    const roleError = getAssignableRoleError(role, message.member);
    if (roleError) {
      return message.reply({ embeds: [await errorEmbed(guildId, 'Role Not Allowed', roleError)] });
    }

    // Check if role is manageable
    if (role.position >= message.guild.members.me.roles.highest.position) {
      const embed = await errorEmbed(guildId, 'Role Too High',
        `${GLYPHS.ERROR} I cannot manage ${role}. It's higher than my highest role.`
      );
      return message.reply({ embeds: [embed] });
    }

    // Check if level already has a reward
    const existingIndex = guildConfig.features.levelSystem.rewards.findIndex(r => r.level === level);

    if (existingIndex !== -1) {
      // Update existing
      guildConfig.features.levelSystem.rewards[existingIndex].roleId = role.id;
    } else {
      // Add new
      guildConfig.features.levelSystem.rewards.push({
        level,
        roleId: role.id
      });
    }

    // Sort rewards by level
    guildConfig.features.levelSystem.rewards.sort((a, b) => a.level - b.level);

    await guildConfig.save();

    // Clear cache
    if (global.guildCache) global.guildCache.delete(guildId);

    const embed = await successEmbed(guildId, 'Level Reward Added',
      `${GLYPHS.SUCCESS} Level **${level}** will now reward ${role}!\n\n` +
      `Users reaching level ${level} will automatically receive this role.`
    );
    return message.reply({ embeds: [embed] });
  },

  async removeReward(message, args, guildConfig, guildId) {
    const level = parseInt(args[0]);
    const prefix = await getPrefix(guildId);

    if (!level || isNaN(level)) {
      const embed = await errorEmbed(guildId, 'Invalid Level',
        `${GLYPHS.ERROR} Please provide a level to remove.\n\n` +
        `**Usage:** \`${prefix}levelroles remove <level>\``
      );
      return message.reply({ embeds: [embed] });
    }

    const existingIndex = guildConfig.features.levelSystem.rewards.findIndex(r => r.level === level);

    if (existingIndex === -1) {
      const embed = await errorEmbed(guildId, 'Reward Not Found',
        `${GLYPHS.ERROR} No reward found for level **${level}**.`
      );
      return message.reply({ embeds: [embed] });
    }

    guildConfig.features.levelSystem.rewards.splice(existingIndex, 1);
    await guildConfig.save();

    // Clear cache
    if (global.guildCache) global.guildCache.delete(guildId);

    const embed = await successEmbed(guildId, 'Level Reward Removed',
      `${GLYPHS.SUCCESS} Removed the reward for level **${level}**.`
    );
    return message.reply({ embeds: [embed] });
  },

  async listRewards(message, guildConfig, guildId) {
    const rewards = guildConfig.features.levelSystem.rewards || [];
    const prefix = await getPrefix(guildId);

    if (rewards.length === 0) {
      const embed = await infoEmbed(guildId, 'No Level Rewards',
        `${GLYPHS.INFO} No level rewards have been set up yet.\n\n` +
        `Use \`${prefix}levelroles add <level> @role\` to add one!`
      );
      return message.reply({ embeds: [embed] });
    }

    const rewardList = rewards.map(r => {
      const role = message.guild.roles.cache.get(r.roleId);
      return `**Level ${r.level}** → ${role ? role : `<Deleted Role>`}`;
    }).join('\n');

    const embed = new EmbedBuilder()
      .setColor('#5865F2')
      .setTitle('🎖️ Level Role Rewards')
      .setDescription(rewardList)
      .setFooter({ text: `${rewards.length} reward(s) configured` })
      .setTimestamp();

    return message.reply({ embeds: [embed] });
  },

  async clearRewards(message, guildConfig, guildId) {
    if (guildConfig.features.levelSystem.rewards.length === 0) {
      const embed = await errorEmbed(guildId, 'No Rewards',
        `${GLYPHS.ERROR} There are no level rewards to clear.`
      );
      return message.reply({ embeds: [embed] });
    }

    guildConfig.features.levelSystem.rewards = [];
    await guildConfig.save();

    // Clear cache
    if (global.guildCache) global.guildCache.delete(guildId);

    const embed = await successEmbed(guildId, 'Rewards Cleared',
      `${GLYPHS.SUCCESS} All level role rewards have been cleared.`
    );
    return message.reply({ embeds: [embed] });
  }
};
