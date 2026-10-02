import { PermissionFlagsBits } from 'discord.js';
import Guild from '../../models/Guild.js';
import { successEmbed, errorEmbed, infoEmbed, GLYPHS } from '../../utils/embeds.js';
import { getPrefix, hasAdminPerms, isServerAdmin, getAssignableRoleError } from '../../utils/helpers.js';

// Role lists that can hold several roles, keyed by every accepted type name
const LIST_TYPES = {
  admin: { field: 'adminRoles', label: 'Admin' },
  administrator: { field: 'adminRoles', label: 'Admin' },
  mod: { field: 'moderatorRoles', label: 'Moderator' },
  moderator: { field: 'moderatorRoles', label: 'Moderator' },
  staff: { field: 'staffRoles', label: 'Staff' }
};

// Single roles; the bot hands these out itself (on join, or when muting)
const SINGLE_TYPES = {
  sus: { label: 'Sus/Radar', paths: ['roles.susRole', 'features.memberTracking.susRole'] },
  suspicious: { label: 'Sus/Radar', paths: ['roles.susRole', 'features.memberTracking.susRole'] },
  radar: { label: 'Sus/Radar', paths: ['roles.susRole', 'features.memberTracking.susRole'] },
  newaccount: { label: 'New Account', paths: ['roles.newAccountRole', 'features.accountAge.newAccountRole'] },
  new: { label: 'New Account', paths: ['roles.newAccountRole', 'features.accountAge.newAccountRole'] },
  egg: { label: 'New Account', paths: ['roles.newAccountRole', 'features.accountAge.newAccountRole'] },
  baby: { label: 'New Account', paths: ['roles.newAccountRole', 'features.accountAge.newAccountRole'] },
  muted: { label: 'Muted', paths: ['roles.mutedRole'] },
  mute: { label: 'Muted', paths: ['roles.mutedRole'] }
};

const LIST_DESCRIPTIONS = {
  adminRoles: 'can configure the bot',
  moderatorRoles: 'can use moderation commands',
  staffRoles: 'staff access'
};

// A role mention or raw ID (works for roles that have since been deleted)
function parseRoleId(arg) {
  return String(arg ?? '').match(/^(?:<@&)?(\d{17,20})>?$/)?.[1] ?? null;
}

function describeRole(guild, roleId) {
  return guild.roles.cache.has(roleId) ? `<@&${roleId}>` : `Deleted role (\`${roleId}\`)`;
}

export default {
  name: 'setrole',
  description: 'Set custom roles for different features',
  usage: '<type> <@role|role_id> | remove <admin|mod|staff> <@role|role_id> | list',
  category: 'config',
  aliases: ['configrole'],
  permissions: [PermissionFlagsBits.Administrator],
  cooldown: 3,

  async execute(message, args) {
    const guildId = message.guild.id;

    try {
      const guild = await Guild.getGuild(guildId, message.guild.name);
      const prefix = await getPrefix(guildId);

      if (!hasAdminPerms(message.member, guild)) {
        return message.reply({
          embeds: [await errorEmbed(guildId, 'Permission Denied',
            `${GLYPHS.LOCK} You need Administrator permissions to set roles.`)]
        });
      }

      const type = args[0]?.toLowerCase();

      // `list` takes no role, so it is handled before the argument-count check
      if (type === 'list') {
        return showRoleList(message, guild, prefix);
      }

      if (type === 'remove') {
        const removeType = LIST_TYPES[args[1]?.toLowerCase()];
        const removeRoleId = parseRoleId(args[2]);
        if (!removeType || !removeRoleId) {
          return message.reply({
            embeds: [await errorEmbed(guildId, 'Invalid Usage',
              `${GLYPHS.ARROW_RIGHT} Usage: \`${prefix}setrole remove <admin|mod|staff> <@role|role_id>\``)]
          });
        }
        return removeRole(message, guild, removeType, removeRoleId);
      }

      if (args.length < 2) {
        return showUsage(message, prefix);
      }

      const listType = LIST_TYPES[type];
      const singleType = SINGLE_TYPES[type];
      if (!listType && !singleType) {
        return message.reply({
          embeds: [await errorEmbed(guildId, 'Unknown Type',
            `${GLYPHS.WARNING} Unknown role type.\n\n**Valid types:** admin, mod, staff, sus, newaccount, muted`)]
        });
      }

      const role = message.guild.roles.cache.get(parseRoleId(args[1]));
      if (!role) {
        return message.reply({
          embeds: [await errorEmbed(guildId, 'Role Not Found',
            `${GLYPHS.ERROR} Could not find that role.`)]
        });
      }

      // @everyone or an integration's role here would make every member (or a bot) staff
      if (role.id === message.guild.id || role.managed) {
        return message.reply({
          embeds: [await errorEmbed(guildId, 'Role Not Allowed',
            `${role} cannot be used as a bot role, Master.`)]
        });
      }

      if (listType) {
        return addListRole(message, guild, listType, role);
      }

      // Sus/new-account roles are given to joining members automatically, so they must not carry
      // powerful permissions or sit above the configurer (an alt account would otherwise gain them)
      const roleError = getAssignableRoleError(role, message.member);
      if (roleError) {
        return message.reply({ embeds: [await errorEmbed(guildId, 'Role Not Allowed', roleError)] });
      }

      await Guild.updateGuild(guildId, {
        $set: Object.fromEntries(singleType.paths.map(path => [path, role.id]))
      });

      return message.reply({
        embeds: [await successEmbed(guildId, 'Role Configured',
          `${GLYPHS.SUCCESS} **${singleType.label}** role set to ${role}.`)]
      });
    } catch (error) {
      console.error('[SetRole] Error:', error);
      return message.reply({
        embeds: [await errorEmbed(guildId, 'Configuration Error',
          'The role could not be saved, Master. Please try again.')]
      }).catch(() => null);
    }
  }
};

async function showUsage(message, prefix) {
  const embed = await errorEmbed(message.guild.id, 'Invalid Usage',
    `${GLYPHS.ARROW_RIGHT} Usage: \`${prefix}setrole <type> <@role|role_id>\``);
  embed.addFields(
    {
      name: `${GLYPHS.ARROW_RIGHT} Types`,
      value:
        `\`admin\` - Can configure the bot (multiple allowed)\n` +
        `\`mod\` - Can use moderation commands (multiple allowed)\n` +
        `\`staff\` - Staff access (multiple allowed)\n` +
        `\`sus\` - Given to suspicious members\n` +
        `\`newaccount\` - Given to new accounts\n` +
        `\`muted\` - Given to muted members`
    },
    {
      name: `${GLYPHS.ARROW_RIGHT} Other Commands`,
      value:
        `\`${prefix}setrole remove <admin|mod|staff> <@role|role_id>\` - Remove a role\n` +
        `\`${prefix}setrole list\` - Show all configured roles`
    }
  );
  return message.reply({ embeds: [embed] });
}

async function addListRole(message, guild, listType, role) {
  const guildId = message.guild.id;

  // Only the owner or a real Administrator may create more bot admins/moderators
  if (listType.field !== 'staffRoles' && !isServerAdmin(message.member)) {
    return message.reply({
      embeds: [await errorEmbed(guildId, 'Permission Denied',
        'Only the server owner or an Administrator can grant bot admin or moderator roles, Master.')]
    });
  }

  if ((guild.roles?.[listType.field] || []).includes(role.id)) {
    return message.reply({
      embeds: [await infoEmbed(guildId, 'Already Added',
        `${GLYPHS.INFO} ${role} is already a **${listType.label}** role.`)]
    });
  }

  await Guild.updateGuild(guildId, { $addToSet: { [`roles.${listType.field}`]: role.id } });

  return message.reply({
    embeds: [await successEmbed(guildId, 'Role Configured',
      `${GLYPHS.SUCCESS} ${role} has been added as a **${listType.label}** role ` +
      `(${LIST_DESCRIPTIONS[listType.field]}).`)]
  });
}

async function showRoleList(message, guild, prefix) {
  const formatList = (ids) => ids.length
    ? ids.slice(0, 15).map(id => `${GLYPHS.DOT} ${describeRole(message.guild, id)}`).join('\n') +
      (ids.length > 15 ? `\n${GLYPHS.DOT} +${ids.length - 15} more` : '')
    : `${GLYPHS.DOT} None configured`;
  const formatSingle = (id) => id ? describeRole(message.guild, id) : 'Not set';

  const adminRoles = guild.roles?.adminRoles || [];
  const modRoles = guild.roles?.moderatorRoles || [];
  const staffRoles = guild.roles?.staffRoles || [];

  const embed = await infoEmbed(message.guild.id, 'Configured Roles',
    `${GLYPHS.INFO} Roles the bot recognises in **${message.guild.name}**.`);
  embed.addFields(
    { name: `${GLYPHS.ARROW_RIGHT} Admin Roles (can configure the bot)`, value: formatList(adminRoles) },
    { name: `${GLYPHS.ARROW_RIGHT} Moderator Roles (can use mod commands)`, value: formatList(modRoles) },
    { name: `${GLYPHS.ARROW_RIGHT} Staff Roles`, value: formatList(staffRoles) },
    {
      name: `${GLYPHS.ARROW_RIGHT} Other Roles`,
      value:
        `${GLYPHS.DOT} Sus Role: ${formatSingle(guild.roles?.susRole)}\n` +
        `${GLYPHS.DOT} New Account Role: ${formatSingle(guild.roles?.newAccountRole)}\n` +
        `${GLYPHS.DOT} Muted Role: ${formatSingle(guild.roles?.mutedRole)}`
    }
  );

  const hasDeleted = [...adminRoles, ...modRoles, ...staffRoles].some(id => !message.guild.roles.cache.has(id));
  if (hasDeleted) {
    embed.addFields({
      name: `${GLYPHS.WARNING} Deleted Roles`,
      value: `Remove them with \`${prefix}setrole remove <admin|mod|staff> <role_id>\`.`
    });
  }

  return message.reply({ embeds: [embed] });
}

async function removeRole(message, guild, listType, roleId) {
  const guildId = message.guild.id;

  if (!(guild.roles?.[listType.field] || []).includes(roleId)) {
    return message.reply({
      embeds: [await errorEmbed(guildId, 'Not Found',
        `${GLYPHS.WARNING} That role is not in the **${listType.label}** roles list.`)]
    });
  }

  await Guild.updateGuild(guildId, { $pull: { [`roles.${listType.field}`]: roleId } });

  return message.reply({
    embeds: [await successEmbed(guildId, 'Role Removed',
      `${GLYPHS.SUCCESS} ${describeRole(message.guild, roleId)} has been removed from **${listType.label}** roles.`)]
  });
}
