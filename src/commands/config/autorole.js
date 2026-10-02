import { PermissionFlagsBits } from 'discord.js';
import Guild from '../../models/Guild.js';
import { successEmbed, errorEmbed, infoEmbed, GLYPHS } from '../../utils/embeds.js';
import { getPrefix, hasAdminPerms, getAssignableRoleError } from '../../utils/helpers.js';

const MAX_DELAY_SECONDS = 600;
const FIELD_LIMIT = 1024;

// A role mention or raw ID (works for roles that have since been deleted)
function parseRoleId(arg) {
  return String(arg ?? '').match(/^(?:<@&)?(\d{17,20})>?$/)?.[1] ?? null;
}

function describeRole(guild, roleId) {
  return guild.roles.cache.has(roleId) ? `<@&${roleId}>` : `Deleted role (\`${roleId}\`)`;
}

// The delay is stored in milliseconds (the join event passes it straight to setTimeout)
function formatDelay(delayMs) {
  if (!delayMs) return 'Instant';
  const seconds = Math.round(delayMs / 1000);
  return `${seconds} second${seconds === 1 ? '' : 's'} after joining`;
}

// Join lines without passing a field limit; the rest is summarised as "and N more"
function fitLines(lines, limit = FIELD_LIMIT) {
  let text = '';
  for (let i = 0; i < lines.length; i++) {
    const line = (text ? '\n' : '') + lines[i];
    const remaining = lines.length - i - 1;
    const reserve = remaining > 0 ? `\n— and ${remaining} more`.length : 0;
    if (text.length + line.length + reserve > limit) {
      return `${text}${text ? '\n' : ''}— and ${lines.length - i} more`;
    }
    text += line;
  }
  return text;
}

function roleListValue(guild, ids) {
  if (ids.length === 0) return 'No roles configured';
  return fitLines(ids.map(id => `${GLYPHS.DOT} ${describeRole(guild, id)}`));
}

export default {
  name: 'autorole',
  description: 'Configure automatic roles assigned to new members or bots',
  usage: '<add|remove|list|delay|enable|disable|bot> [options]',
  aliases: ['joinrole', 'defaultrole'],
  category: 'config',
  permissions: [PermissionFlagsBits.Administrator],
  cooldown: 3,

  async execute(message, args) {
    const guildId = message.guild.id;

    try {
      const prefix = await getPrefix(guildId);
      const guildConfig = await Guild.getGuild(guildId, message.guild.name);

      if (!hasAdminPerms(message.member, guildConfig)) {
        return message.reply({
          embeds: [await errorEmbed(guildId, 'Permission Denied',
            `${GLYPHS.LOCK} You need Administrator permissions to manage auto roles.`)]
        });
      }

      const autoRole = {
        enabled: guildConfig.autoRole?.enabled ?? false,
        roles: guildConfig.autoRole?.roles || [],
        botRoles: guildConfig.autoRole?.botRoles || [],
        delay: guildConfig.autoRole?.delay || 0
      };
      const subcommand = args[0]?.toLowerCase();

      switch (subcommand) {
        case undefined:
          return showHelp(message, autoRole, prefix);

        case 'enable': {
          if (autoRole.roles.length === 0 && autoRole.botRoles.length === 0) {
            return message.reply({
              embeds: [await errorEmbed(guildId, 'No Roles Configured',
                `${GLYPHS.ERROR} Please add at least one role before enabling.\n\n**Usage:** \`${prefix}autorole add @role\``)]
            });
          }

          await Guild.updateGuild(guildId, { $set: { 'autoRole.enabled': true } });
          return message.reply({
            embeds: [await successEmbed(guildId, 'Auto Role Enabled',
              `${GLYPHS.SUCCESS} New members will now automatically receive the configured roles.`)]
          });
        }

        case 'disable':
          await Guild.updateGuild(guildId, { $set: { 'autoRole.enabled': false } });
          return message.reply({
            embeds: [await successEmbed(guildId, 'Auto Role Disabled',
              `${GLYPHS.SUCCESS} Auto role assignment has been disabled.`)]
          });

        case 'add':
          return addRole(message, args[1], autoRole.roles, 'roles', prefix);

        case 'remove':
          return removeRole(message, args[1], autoRole.roles, 'roles', prefix);

        case 'delay': {
          const delay = parseInt(args[1], 10);

          if (isNaN(delay) || delay < 0 || delay > MAX_DELAY_SECONDS) {
            return message.reply({
              embeds: [await errorEmbed(guildId, 'Invalid Delay',
                `${GLYPHS.ERROR} Please enter a delay between 0 and ${MAX_DELAY_SECONDS} seconds.\n\n**Usage:** \`${prefix}autorole delay <seconds>\``)]
            });
          }

          await Guild.updateGuild(guildId, { $set: { 'autoRole.delay': delay * 1000 } });
          return message.reply({
            embeds: [await successEmbed(guildId, 'Delay Updated',
              delay === 0
                ? `${GLYPHS.SUCCESS} Roles will be assigned immediately when members join.`
                : `${GLYPHS.SUCCESS} Roles will be assigned **${delay} second${delay === 1 ? '' : 's'}** after members join.`)]
          });
        }

        case 'bot': {
          const action = args[1]?.toLowerCase();

          if (action === 'add') return addRole(message, args[2], autoRole.botRoles, 'botRoles', prefix);
          if (action === 'remove') return removeRole(message, args[2], autoRole.botRoles, 'botRoles', prefix);
          if (action === 'list') {
            if (autoRole.botRoles.length === 0) {
              return message.reply({
                embeds: [await infoEmbed(guildId, 'No Bot Roles',
                  `${GLYPHS.INFO} No auto roles are configured for bots.`)]
              });
            }
            const embed = await infoEmbed(guildId, 'Bot Auto Roles',
              `${GLYPHS.INFO} Roles given to bots when they join.`);
            embed.addFields({ name: `${GLYPHS.ARROW_RIGHT} Bot Roles`, value: roleListValue(message.guild, autoRole.botRoles) });
            return message.reply({ embeds: [embed] });
          }

          return message.reply({
            embeds: [await errorEmbed(guildId, 'Invalid Action',
              `${GLYPHS.ERROR} Valid actions: \`add\`, \`remove\`, \`list\`\n\n**Usage:** \`${prefix}autorole bot add @role\``)]
          });
        }

        case 'list':
          return showList(message, autoRole);

        default:
          return message.reply({
            embeds: [await errorEmbed(guildId, 'Unknown Subcommand',
              `${GLYPHS.ERROR} Unknown subcommand: \`${subcommand}\`\n\nUse \`${prefix}autorole\` to see available options.`)]
          });
      }
    } catch (error) {
      console.error('[AutoRole] Error:', error);
      return message.reply({
        embeds: [await errorEmbed(guildId, 'Configuration Error',
          'The auto role settings could not be updated, Master. Please try again.')]
      }).catch(() => null);
    }
  }
};

async function showHelp(message, autoRole, prefix) {
  const embed = await infoEmbed(message.guild.id, 'Auto Role Configuration',
    `${GLYPHS.INFO} Automatically assign roles to new members when they join.\n\n` +
    `${GLYPHS.ARROW_RIGHT} **Status:** ${autoRole.enabled ? 'Enabled' : 'Disabled'}\n` +
    `${GLYPHS.ARROW_RIGHT} **Member Roles:** ${autoRole.roles.length}\n` +
    `${GLYPHS.ARROW_RIGHT} **Bot Roles:** ${autoRole.botRoles.length}\n` +
    `${GLYPHS.ARROW_RIGHT} **Delay:** ${formatDelay(autoRole.delay)}`);

  embed.addFields(
    {
      name: `${GLYPHS.ARROW_RIGHT} System`,
      value:
        `\`${prefix}autorole enable\` - Enable auto roles\n` +
        `\`${prefix}autorole disable\` - Disable auto roles\n` +
        `\`${prefix}autorole delay <seconds>\` - Wait before assigning (0-${MAX_DELAY_SECONDS})\n` +
        `\`${prefix}autorole list\` - Show current configuration`
    },
    {
      name: `${GLYPHS.ARROW_RIGHT} Roles`,
      value:
        `\`${prefix}autorole add @role\` - Give a role to new members\n` +
        `\`${prefix}autorole remove <@role|role_id>\` - Stop giving a role\n` +
        `\`${prefix}autorole bot add|remove <@role>\` - Roles for new bots\n` +
        `\`${prefix}autorole bot list\` - Show bot roles`
    }
  );

  return message.reply({ embeds: [embed] });
}

async function showList(message, autoRole) {
  const embed = await infoEmbed(message.guild.id, 'Auto Role Configuration',
    `${GLYPHS.ARROW_RIGHT} **Status:** ${autoRole.enabled ? 'Enabled' : 'Disabled'}\n` +
    `${GLYPHS.ARROW_RIGHT} **Delay:** ${formatDelay(autoRole.delay)}`);

  embed.addFields(
    { name: `${GLYPHS.ARROW_RIGHT} Member Roles`, value: roleListValue(message.guild, autoRole.roles) },
    { name: `${GLYPHS.ARROW_RIGHT} Bot Roles`, value: roleListValue(message.guild, autoRole.botRoles) }
  );

  return message.reply({ embeds: [embed] });
}

// `field` is 'roles' (members) or 'botRoles'; both go through the same safety checks
async function addRole(message, arg, current, field, prefix) {
  const guildId = message.guild.id;
  const forBots = field === 'botRoles';
  const usage = `${prefix}autorole ${forBots ? 'bot ' : ''}add @role`;
  const role = message.mentions.roles.first() || message.guild.roles.cache.get(parseRoleId(arg));

  if (!role) {
    return message.reply({
      embeds: [await errorEmbed(guildId, 'Role Not Found',
        `${GLYPHS.ERROR} Please mention a valid role.\n\n**Usage:** \`${usage}\``)]
    });
  }

  // @everyone, managed, above the bot or the user, or carrying moderation/admin permissions
  const roleError = getAssignableRoleError(role, message.member);
  if (roleError) {
    return message.reply({ embeds: [await errorEmbed(guildId, 'Role Not Allowed', roleError)] });
  }

  // Color roles are chosen by members from the color roles panel, never assigned on join
  if (role.name.startsWith('🎨 ')) {
    return message.reply({
      embeds: [await errorEmbed(guildId, 'Color Role Detected',
        `${GLYPHS.ERROR} ${role} is a color role and should not be added to auto roles.\n\n` +
        `Color roles are meant to be selected by members via the color roles panel, not assigned automatically.`)]
    });
  }

  if (current.includes(role.id)) {
    return message.reply({
      embeds: [await infoEmbed(guildId, 'Already Added',
        `${GLYPHS.INFO} ${role} is already in the ${forBots ? 'bot ' : ''}auto role list.`)]
    });
  }

  const updated = await Guild.updateGuild(guildId, { $addToSet: { [`autoRole.${field}`]: role.id } });
  const total = updated?.autoRole?.[field]?.length ?? current.length + 1;

  return message.reply({
    embeds: [await successEmbed(guildId, forBots ? 'Bot Role Added' : 'Role Added',
      `${GLYPHS.SUCCESS} ${role} will now be assigned to new ${forBots ? 'bots' : 'members'}.\n\n**Total Roles:** ${total}`)]
  });
}

async function removeRole(message, arg, current, field, prefix) {
  const guildId = message.guild.id;
  const forBots = field === 'botRoles';
  // Raw IDs work too, so roles that were deleted can still be removed
  const roleId = message.mentions.roles.first()?.id || parseRoleId(arg);

  if (!roleId) {
    return message.reply({
      embeds: [await errorEmbed(guildId, 'Role Not Found',
        `${GLYPHS.ERROR} Please mention a role or give its ID.\n\n` +
        `**Usage:** \`${prefix}autorole ${forBots ? 'bot ' : ''}remove <@role|role_id>\``)]
    });
  }

  if (!current.includes(roleId)) {
    return message.reply({
      embeds: [await errorEmbed(guildId, 'Not Found',
        `${GLYPHS.ERROR} ${describeRole(message.guild, roleId)} is not in the ${forBots ? 'bot ' : ''}auto role list.`)]
    });
  }

  // Prune roles that no longer exist while we are here
  const stale = current.filter(id => id !== roleId && !message.guild.roles.cache.has(id));
  const remaining = current.length - 1 - stale.length;
  await Guild.updateGuild(guildId, { $pull: { [`autoRole.${field}`]: { $in: [roleId, ...stale] } } });

  return message.reply({
    embeds: [await successEmbed(guildId, forBots ? 'Bot Role Removed' : 'Role Removed',
      `${GLYPHS.SUCCESS} ${describeRole(message.guild, roleId)} has been removed from ${forBots ? 'bot ' : ''}auto roles.\n\n` +
      `**Remaining Roles:** ${remaining}` +
      (stale.length ? `\n${GLYPHS.INFO} Also removed ${stale.length} deleted role(s).` : ''))]
  });
}
