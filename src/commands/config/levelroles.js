import { PermissionFlagsBits } from 'discord.js';
import Guild from '../../models/Guild.js';
import { successEmbed, errorEmbed, infoEmbed, GLYPHS } from '../../utils/embeds.js';
import { getPrefix, hasModPerms, getAssignableRoleError } from '../../utils/helpers.js';

const MIN_LEVEL = 1;
const MAX_LEVEL = 100;
const PATH = 'features.levelSystem.rewards';
const ROLE_ID = /^(?:<@&)?(\d{17,20})>?$/;

function describeRole(guild, roleId) {
  return guild.roles.cache.has(roleId) ? `<@&${roleId}>` : `Deleted role (\`${roleId}\`)`;
}

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

    try {
      const guildConfig = await Guild.getGuild(guildId);

      // Check for moderator permissions (admin, mod role, or ManageGuild)
      if (!hasModPerms(message.member, guildConfig)) {
        return message.reply({
          embeds: [await errorEmbed(guildId, 'Permission Denied',
            `${GLYPHS.LOCK} You need Moderator/Staff permissions to manage level roles.`)]
        });
      }

      const ctx = {
        message,
        guildId,
        prefix: await getPrefix(guildId),
        rewards: guildConfig.features?.levelSystem?.rewards || []
      };

      switch (args[0]?.toLowerCase()) {
        case 'add':
        case 'set':
          return addReward(ctx, args.slice(1));
        case 'remove':
        case 'delete':
          return removeReward(ctx, args[1]);
        case 'list':
        case 'show':
          return listRewards(ctx);
        case 'clear':
          return clearRewards(ctx);
        default:
          return showHelp(ctx);
      }
    } catch (error) {
      console.error('[LevelRoles] Error:', error);
      return message.reply({
        embeds: [await errorEmbed(guildId, 'Configuration Error',
          'The level rewards could not be updated, Master. Please try again.')]
      }).catch(() => null);
    }
  }
};

async function showHelp({ message, guildId, prefix, rewards }) {
  const embed = await infoEmbed(guildId, 'Level Roles',
    `${GLYPHS.INFO} Members automatically receive these roles when they reach the level.\n\n` +
    `${GLYPHS.ARROW_RIGHT} **Active Rewards:** ${rewards.length}`);

  embed.addFields(
    {
      name: `${GLYPHS.ARROW_RIGHT} Commands`,
      value:
        `\`${prefix}levelroles add <level> @role\` - Add or replace a reward\n` +
        `\`${prefix}levelroles remove <level>\` - Remove a reward\n` +
        `\`${prefix}levelroles list\` - View all rewards\n` +
        `\`${prefix}levelroles clear\` - Remove all rewards`
    },
    {
      name: `${GLYPHS.ARROW_RIGHT} Examples`,
      value:
        `\`${prefix}levelroles add 5 @Active Member\`\n` +
        `\`${prefix}levelroles add 10 @Regular\``
    }
  );

  return message.reply({ embeds: [embed] });
}

async function addReward({ message, guildId, prefix, rewards }, args) {
  const level = parseInt(args[0], 10);
  const role = message.mentions.roles.first() || message.guild.roles.cache.get(args[1]?.match(ROLE_ID)?.[1]);

  if (isNaN(level) || level < MIN_LEVEL || level > MAX_LEVEL) {
    return message.reply({
      embeds: [await errorEmbed(guildId, 'Invalid Level',
        `${GLYPHS.ERROR} Please provide a valid level (${MIN_LEVEL}-${MAX_LEVEL}).\n\n` +
        `**Usage:** \`${prefix}levelroles add <level> @role\``)]
    });
  }

  if (!role) {
    return message.reply({
      embeds: [await errorEmbed(guildId, 'No Role Mentioned',
        `${GLYPHS.ERROR} Please mention a role to add.\n\n` +
        `**Usage:** \`${prefix}levelroles add ${level} @role\``)]
    });
  }

  // @everyone, managed, above the bot or the user, or carrying moderation/admin permissions
  const roleError = getAssignableRoleError(role, message.member);
  if (roleError) {
    return message.reply({ embeds: [await errorEmbed(guildId, 'Role Not Allowed', roleError)] });
  }

  const existing = rewards.find(r => r.level === level);
  if (existing) {
    await Guild.updateGuild(guildId,
      { $set: { [`${PATH}.$[reward].roleId`]: role.id } },
      { arrayFilters: [{ 'reward.level': level }] });
  } else {
    // Keep rewards sorted by level
    await Guild.updateGuild(guildId, {
      $push: { [PATH]: { $each: [{ level, roleId: role.id }], $sort: { level: 1 } } }
    });
  }

  return message.reply({
    embeds: [await successEmbed(guildId, existing ? 'Level Reward Updated' : 'Level Reward Added',
      `${GLYPHS.SUCCESS} Level **${level}** will now reward ${role}.` +
      (existing && existing.roleId !== role.id ? ` (previously ${describeRole(message.guild, existing.roleId)})` : '') +
      `\n\nMembers reaching level ${level} will automatically receive this role.`)]
  });
}

async function removeReward({ message, guildId, prefix, rewards }, arg) {
  const level = parseInt(arg, 10);

  if (isNaN(level)) {
    return message.reply({
      embeds: [await errorEmbed(guildId, 'Invalid Level',
        `${GLYPHS.ERROR} Please provide a level to remove.\n\n` +
        `**Usage:** \`${prefix}levelroles remove <level>\``)]
    });
  }

  if (!rewards.some(r => r.level === level)) {
    return message.reply({
      embeds: [await errorEmbed(guildId, 'Reward Not Found',
        `${GLYPHS.ERROR} No reward found for level **${level}**.`)]
    });
  }

  await Guild.updateGuild(guildId, { $pull: { [PATH]: { level } } });

  return message.reply({
    embeds: [await successEmbed(guildId, 'Level Reward Removed',
      `${GLYPHS.SUCCESS} Removed the reward for level **${level}**.`)]
  });
}

async function listRewards({ message, guildId, prefix, rewards }) {
  if (rewards.length === 0) {
    return message.reply({
      embeds: [await infoEmbed(guildId, 'No Level Rewards',
        `${GLYPHS.INFO} No level rewards have been set up yet.\n\n` +
        `Use \`${prefix}levelroles add <level> @role\` to add one.`)]
    });
  }

  let rewardList = [...rewards]
    .sort((a, b) => a.level - b.level)
    .map(r => `${GLYPHS.ARROW_RIGHT} **Level ${r.level}** — ${describeRole(message.guild, r.roleId)}`)
    .join('\n');
  if (rewardList.length > 4000) {
    rewardList = `${rewardList.slice(0, 3980).replace(/\n[^\n]*$/, '')}\n— and more`;
  }

  const embed = await infoEmbed(guildId, `Level Role Rewards (${rewards.length})`, rewardList);
  return message.reply({ embeds: [embed] });
}

async function clearRewards({ message, guildId, rewards }) {
  if (rewards.length === 0) {
    return message.reply({
      embeds: [await infoEmbed(guildId, 'Nothing to Clear',
        `${GLYPHS.INFO} There are no level rewards to clear.`)]
    });
  }

  await Guild.updateGuild(guildId, { $set: { [PATH]: [] } });

  return message.reply({
    embeds: [await successEmbed(guildId, 'Rewards Cleared',
      `${GLYPHS.SUCCESS} All ${rewards.length} level role reward(s) have been cleared.`)]
  });
}
