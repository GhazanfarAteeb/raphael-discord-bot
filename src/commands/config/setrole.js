import { PermissionFlagsBits } from 'discord.js';
import Guild from '../../models/Guild.js';
import { successEmbed, errorEmbed, GLYPHS } from '../../utils/embeds.js';
import { isServerAdmin } from '../../utils/helpers.js';

export default {
  name: 'setrole',
  description: 'Set custom roles for different features',
  usage: '<type> <@role|role_id>',
  aliases: ['configrole'],
  permissions: [PermissionFlagsBits.Administrator],
  cooldown: 3,

  async execute(message, args) {
    const guild = await Guild.getGuild(message.guild.id, message.guild.name);

    // Check for admin role
    const hasAdminRole = guild.roles.adminRoles?.some(roleId =>
      message.member.roles.cache.has(roleId)
    );

    if (!message.member.permissions.has(PermissionFlagsBits.Administrator) && !hasAdminRole) {
      return message.reply({
        embeds: [await errorEmbed(message.guild.id, 'Permission Denied',
          `${GLYPHS.LOCK} You need Administrator permissions to set roles.`)]
      });
    }

    if (args.length < 2) {
      const embed = await errorEmbed(message.guild.id, 'Invalid Usage',
        `${GLYPHS.ARROW_RIGHT} Usage: \`setrole <type> <@role|role_id>\`\n\n` +
        `**Types:**\n` +
        `${GLYPHS.DOT} \`admin\` - Admin role (can configure bot, multiple allowed)\n` +
        `${GLYPHS.DOT} \`mod\` - Moderator role (can use mod commands, multiple allowed)\n` +
        `${GLYPHS.DOT} \`staff\` - Staff role (can add multiple)\n` +
        `${GLYPHS.DOT} \`sus\` - Role for suspicious members\n` +
        `${GLYPHS.DOT} \`newaccount\` - Role for new accounts\n` +
        `${GLYPHS.DOT} \`muted\` - Role for muted members\n\n` +
        `**Remove roles:**\n` +
        `${GLYPHS.DOT} \`setrole remove admin @role\` - Remove an admin role\n` +
        `${GLYPHS.DOT} \`setrole remove mod @role\` - Remove a mod role\n` +
        `${GLYPHS.DOT} \`setrole list\` - Show all configured roles`
      );
      return message.reply({ embeds: [embed] });
    }

    const type = args[0].toLowerCase();

    // Handle list command
    if (type === 'list') {
      return showRoleList(message, guild);
    }

    // Handle remove command
    if (type === 'remove') {
      if (args.length < 3) {
        return message.reply({
          embeds: [await errorEmbed(message.guild.id, 'Invalid Usage',
            `${GLYPHS.ARROW_RIGHT} Usage: \`setrole remove <admin|mod|staff> @role\``)]
        });
      }
      const removeType = args[1].toLowerCase();
      const removeRoleId = args[2].replace(/[<@&>]/g, '');
      return removeRole(message, guild, removeType, removeRoleId);
    }

    const roleId = args[1].replace(/[<@&>]/g, '');

    // Verify role exists
    const role = message.guild.roles.cache.get(roleId);
    if (!role) {
      const embed = await errorEmbed(message.guild.id, 'Role Not Found',
        `${GLYPHS.ERROR} Could not find that role.`
      );
      return message.reply({ embeds: [embed] });
    }

    // @everyone or an integration's role here would make every member (or a bot) staff
    if (role.id === message.guild.id || role.managed) {
      return message.reply({
        embeds: [await errorEmbed(message.guild.id, 'Role Not Allowed',
          `${role} cannot be used as a bot role, Master.`)]
      });
    }

    // Only the owner or a real Administrator may create more bot admins/moderators
    if (['admin', 'administrator', 'mod', 'moderator'].includes(type) && !isServerAdmin(message.member)) {
      return message.reply({
        embeds: [await errorEmbed(message.guild.id, 'Permission Denied',
          'Only the server owner or an Administrator can grant bot admin or moderator roles, Master.')]
      });
    }

    let updateData = {};
    let responseText = '';

    switch (type) {
      case 'admin':
      case 'administrator': {
        const adminRoles = guild.roles?.adminRoles || [];
        if (adminRoles.includes(roleId)) {
          return message.reply({
            embeds: [await errorEmbed(message.guild.id, 'Already Added',
              `${GLYPHS.WARNING} ${role} is already an admin role.`)]
          });
        }
        adminRoles.push(roleId);
        updateData = { 'roles.adminRoles': adminRoles };
        responseText = `${role} has been added as an **Admin** role.\nUsers with this role can configure the bot.`;
        break;
      }

      case 'mod':
      case 'moderator': {
        const modRoles = guild.roles?.moderatorRoles || [];
        if (modRoles.includes(roleId)) {
          return message.reply({
            embeds: [await errorEmbed(message.guild.id, 'Already Added',
              `${GLYPHS.WARNING} ${role} is already a moderator role.`)]
          });
        }
        modRoles.push(roleId);
        updateData = { 'roles.moderatorRoles': modRoles };
        responseText = `${role} has been added as a **Moderator** role.\nUsers with this role can use moderation commands.`;
        break;
      }

      case 'staff': {
        const staffRoles = guild.roles?.staffRoles || [];
        if (staffRoles.includes(roleId)) {
          return message.reply({
            embeds: [await errorEmbed(message.guild.id, 'Already Added',
              `${GLYPHS.WARNING} ${role} is already a staff role.`)]
          });
        }
        staffRoles.push(roleId);
        updateData = { 'roles.staffRoles': staffRoles };
        responseText = `${role} has been added as a **Staff** role.`;
        break;
      }

      case 'sus':
      case 'suspicious':
      case 'radar':
        updateData = {
          'roles.susRole': roleId,
          'features.memberTracking.susRole': roleId
        };
        responseText = `**Sus/Radar** role set to ${role}`;
        break;

      case 'newaccount':
      case 'new':
      case 'egg':
      case 'baby':
        updateData = {
          'roles.newAccountRole': roleId,
          'features.accountAge.newAccountRole': roleId
        };
        responseText = `**New Account** role set to ${role}`;
        break;

      case 'muted':
      case 'mute':
        updateData = { 'roles.mutedRole': roleId };
        responseText = `**Muted** role set to ${role}`;
        break;

      default:
        return message.reply({
          embeds: [await errorEmbed(message.guild.id, 'Unknown Type',
            `${GLYPHS.WARNING} Unknown role type.\n\n**Valid types:** admin, mod, staff, sus, newaccount, muted`)]
        });
    }

    // Apply the update
    await Guild.updateGuild(message.guild.id, { $set: updateData });

    return message.reply({
      embeds: [await successEmbed(message.guild.id, 'Role Configured', `${GLYPHS.SUCCESS} ${responseText}`)]
    });
  }
};

async function showRoleList(message, guild) {
  const adminRoles = guild.roles?.adminRoles || [];
  const modRoles = guild.roles?.moderatorRoles || [];
  const staffRoles = guild.roles?.staffRoles || [];

  let description = '**Admin Roles** (can configure bot):\n';
  if (adminRoles.length === 0) {
    description += `${GLYPHS.DOT} None configured\n`;
  } else {
    for (const roleId of adminRoles) {
      const role = message.guild.roles.cache.get(roleId);
      description += `${GLYPHS.DOT} ${role || `<@&${roleId}> (deleted)`}\n`;
    }
  }

  description += '\n**Moderator Roles** (can use mod commands):\n';
  if (modRoles.length === 0) {
    description += `${GLYPHS.DOT} None configured\n`;
  } else {
    for (const roleId of modRoles) {
      const role = message.guild.roles.cache.get(roleId);
      description += `${GLYPHS.DOT} ${role || `<@&${roleId}> (deleted)`}\n`;
    }
  }

  description += '\n**Staff Roles**:\n';
  if (staffRoles.length === 0) {
    description += `${GLYPHS.DOT} None configured\n`;
  } else {
    for (const roleId of staffRoles) {
      const role = message.guild.roles.cache.get(roleId);
      description += `${GLYPHS.DOT} ${role || `<@&${roleId}> (deleted)`}\n`;
    }
  }

  description += '\n**Other Roles**:\n';
  description += `${GLYPHS.DOT} Sus Role: ${guild.roles?.susRole ? `<@&${guild.roles.susRole}>` : 'Not set'}\n`;
  description += `${GLYPHS.DOT} New Account Role: ${guild.roles?.newAccountRole ? `<@&${guild.roles.newAccountRole}>` : 'Not set'}\n`;
  description += `${GLYPHS.DOT} Muted Role: ${guild.roles?.mutedRole ? `<@&${guild.roles.mutedRole}>` : 'Not set'}`;

  const { infoEmbed } = await import('../../utils/embeds.js');
  return message.reply({
    embeds: [await infoEmbed(message.guild.id, '『 Configured Roles 』', description)]
  });
}

async function removeRole(message, guild, type, roleId) {
  const { successEmbed, errorEmbed, GLYPHS } = await import('../../utils/embeds.js');

  let updateData = {};
  let fieldName = '';

  switch (type) {
    case 'admin':
    case 'administrator': {
      const adminRoles = guild.roles?.adminRoles || [];
      if (!adminRoles.includes(roleId)) {
        return message.reply({
          embeds: [await errorEmbed(message.guild.id, 'Not Found',
            `${GLYPHS.WARNING} That role is not in the admin roles list.`)]
        });
      }
      updateData = { 'roles.adminRoles': adminRoles.filter(id => id !== roleId) };
      fieldName = 'Admin';
      break;
    }

    case 'mod':
    case 'moderator': {
      const modRoles = guild.roles?.moderatorRoles || [];
      if (!modRoles.includes(roleId)) {
        return message.reply({
          embeds: [await errorEmbed(message.guild.id, 'Not Found',
            `${GLYPHS.WARNING} That role is not in the moderator roles list.`)]
        });
      }
      updateData = { 'roles.moderatorRoles': modRoles.filter(id => id !== roleId) };
      fieldName = 'Moderator';
      break;
    }

    case 'staff': {
      const staffRoles = guild.roles?.staffRoles || [];
      if (!staffRoles.includes(roleId)) {
        return message.reply({
          embeds: [await errorEmbed(message.guild.id, 'Not Found',
            `${GLYPHS.WARNING} That role is not in the staff roles list.`)]
        });
      }
      updateData = { 'roles.staffRoles': staffRoles.filter(id => id !== roleId) };
      fieldName = 'Staff';
      break;
    }

    default:
      return message.reply({
        embeds: [await errorEmbed(message.guild.id, 'Invalid Type',
          `${GLYPHS.WARNING} Can only remove from: admin, mod, staff`)]
      });
  }

  await Guild.updateGuild(message.guild.id, { $set: updateData });

  const role = message.guild.roles.cache.get(roleId);
  return message.reply({
    embeds: [await successEmbed(message.guild.id, 'Role Removed',
      `${GLYPHS.SUCCESS} ${role || `<@&${roleId}>`} has been removed from **${fieldName}** roles.`)]
  });
}
