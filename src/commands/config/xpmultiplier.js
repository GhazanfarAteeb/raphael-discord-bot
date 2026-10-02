import { PermissionFlagsBits } from 'discord.js';
import Guild from '../../models/Guild.js';
import { successEmbed, errorEmbed, infoEmbed, GLYPHS } from '../../utils/embeds.js';
import { getPrefix, hasModPerms } from '../../utils/helpers.js';

// Message XP only applies role multipliers above 1 (it starts from 1 and keeps the highest),
// so lower values would silently do nothing
const MIN_ROLE_MULTIPLIER = 1;
const MAX_ROLE_MULTIPLIER = 10;
const MIN_BOOSTER_MULTIPLIER = 1;
const MAX_BOOSTER_MULTIPLIER = 5;
const DEFAULT_BOOSTER_MULTIPLIER = 1.5;
const PATH = 'features.levelSystem';

// How statsMessageTracker.js and voiceXP.js actually combine the values
const STACKING_NOTE =
  `${GLYPHS.DOT} **Text XP:** the highest matching role multiplier, plus the booster bonus ` +
  `(2x role + 1.5x booster = 2.5x).\n` +
  `${GLYPHS.DOT} **Voice XP:** the booster multiplier times the first matching role multiplier in the list ` +
  `(2x role with 1.5x booster = 3x).`;

const ROLE_ID = /^(?:<@&)?(\d{17,20})>?$/;
const NUMBER = /^\d*\.?\d+x?$/i;

function describeRole(guild, roleId) {
  return guild.roles.cache.has(roleId) ? `<@&${roleId}>` : `Deleted role (\`${roleId}\`)`;
}

export default {
  name: 'xpmultiplier',
  description: 'Manage XP multipliers for roles',
  usage: 'xpmultiplier add @role <multiplier> | xpmultiplier remove @role | xpmultiplier list | xpmultiplier booster <multiplier>',
  category: 'config',
  aliases: ['xpmult', 'xpboost', 'xpbonus'],
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
            `${GLYPHS.LOCK} You need Moderator/Staff permissions to manage XP multipliers.`)]
        });
      }

      const prefix = await getPrefix(guildId);
      const levelSystem = guildConfig.features?.levelSystem || {};
      const ctx = {
        message,
        guildId,
        prefix,
        multipliers: levelSystem.xpMultipliers || [],
        boosterMult: levelSystem.boosterMultiplier || DEFAULT_BOOSTER_MULTIPLIER
      };

      switch (args[0]?.toLowerCase()) {
        case 'add':
        case 'set':
          return addMultiplier(ctx, args.slice(1));
        case 'remove':
        case 'delete':
          return removeMultiplier(ctx, args[1]);
        case 'list':
        case 'show':
          return listMultipliers(ctx);
        case 'booster':
        case 'boost':
          return setBoosterMultiplier(ctx, args[1]);
        case 'clear':
          return clearMultipliers(ctx);
        default:
          return showHelp(ctx);
      }
    } catch (error) {
      console.error('[XPMultiplier] Error:', error);
      return message.reply({
        embeds: [await errorEmbed(guildId, 'Configuration Error',
          'The XP multipliers could not be updated, Master. Please try again.')]
      }).catch(() => null);
    }
  }
};

async function showHelp({ message, guildId, prefix, multipliers, boosterMult }) {
  const embed = await infoEmbed(guildId, 'XP Multipliers',
    `${GLYPHS.ARROW_RIGHT} **Role Multipliers:** ${multipliers.length}\n` +
    `${GLYPHS.ARROW_RIGHT} **Booster Multiplier:** ${boosterMult}x`);

  embed.addFields(
    {
      name: `${GLYPHS.ARROW_RIGHT} Commands`,
      value:
        `\`${prefix}xpmultiplier add @role <${MIN_ROLE_MULTIPLIER}-${MAX_ROLE_MULTIPLIER}>\` - Add or change a role multiplier\n` +
        `\`${prefix}xpmultiplier remove <@role|role_id>\` - Remove a multiplier\n` +
        `\`${prefix}xpmultiplier list\` - View all multipliers\n` +
        `\`${prefix}xpmultiplier booster <${MIN_BOOSTER_MULTIPLIER}-${MAX_BOOSTER_MULTIPLIER}>\` - Set the booster multiplier\n` +
        `\`${prefix}xpmultiplier clear\` - Remove all role multipliers`
    },
    {
      name: `${GLYPHS.ARROW_RIGHT} Examples`,
      value:
        `\`${prefix}xpmultiplier add @VIP 2\` - VIPs get 2x XP\n` +
        `\`${prefix}xpmultiplier booster 1.5\` - Boosters get 1.5x XP`
    },
    { name: `${GLYPHS.ARROW_RIGHT} How They Combine`, value: STACKING_NOTE }
  );

  return message.reply({ embeds: [embed] });
}

async function addMultiplier({ message, guildId, prefix, multipliers }, args) {
  // Accept the role and the number in either order: "add @VIP 2" or "add 2 @VIP"
  const role = message.mentions.roles.first() ||
    args.map(arg => message.guild.roles.cache.get(arg.match(ROLE_ID)?.[1])).find(Boolean);
  const numberArg = args.find(arg => NUMBER.test(arg) && !(role && arg.includes(role.id)));
  const multiplier = numberArg ? parseFloat(numberArg) : NaN;

  if (!role) {
    return message.reply({
      embeds: [await errorEmbed(guildId, 'No Role',
        `${GLYPHS.ERROR} Please mention a role or give its ID.\n\n` +
        `**Usage:** \`${prefix}xpmultiplier add @role <multiplier>\``)]
    });
  }

  if (isNaN(multiplier) || multiplier < MIN_ROLE_MULTIPLIER || multiplier > MAX_ROLE_MULTIPLIER) {
    return message.reply({
      embeds: [await errorEmbed(guildId, 'Invalid Multiplier',
        `${GLYPHS.ERROR} Please provide a multiplier from ${MIN_ROLE_MULTIPLIER} to ${MAX_ROLE_MULTIPLIER}. ` +
        `Values below 1 would not reduce XP, so they are not accepted.\n\n` +
        `**Usage:** \`${prefix}xpmultiplier add @role <multiplier>\`\n` +
        `**Example:** \`${prefix}xpmultiplier add @VIP 2\``)]
    });
  }

  if (multipliers.some(m => m.roleId === role.id)) {
    await Guild.updateGuild(guildId,
      { $set: { [`${PATH}.xpMultipliers.$[entry].multiplier`]: multiplier } },
      { arrayFilters: [{ 'entry.roleId': role.id }] });
  } else {
    await Guild.updateGuild(guildId, {
      $push: { [`${PATH}.xpMultipliers`]: { roleId: role.id, multiplier } }
    });
  }

  return message.reply({
    embeds: [await successEmbed(guildId, 'Multiplier Set',
      `${GLYPHS.SUCCESS} ${role} now has a **${multiplier}x** XP multiplier.\n\n` +
      `Members with this role earn ${multiplier}x XP.`)]
  });
}

async function removeMultiplier({ message, guildId, prefix, multipliers }, arg) {
  // Raw IDs work too, so multipliers for deleted roles can be removed
  const roleId = message.mentions.roles.first()?.id || arg?.match(ROLE_ID)?.[1];

  if (!roleId) {
    return message.reply({
      embeds: [await errorEmbed(guildId, 'No Role',
        `${GLYPHS.ERROR} Please mention a role or provide a role ID.\n\n` +
        `**Usage:** \`${prefix}xpmultiplier remove <@role|role_id>\``)]
    });
  }

  if (!multipliers.some(m => m.roleId === roleId)) {
    return message.reply({
      embeds: [await errorEmbed(guildId, 'Not Found',
        `${GLYPHS.ERROR} ${describeRole(message.guild, roleId)} does not have an XP multiplier.`)]
    });
  }

  await Guild.updateGuild(guildId, { $pull: { [`${PATH}.xpMultipliers`]: { roleId } } });

  return message.reply({
    embeds: [await successEmbed(guildId, 'Multiplier Removed',
      `${GLYPHS.SUCCESS} Removed the XP multiplier from ${describeRole(message.guild, roleId)}.`)]
  });
}

async function listMultipliers({ message, guildId, prefix, multipliers, boosterMult }) {
  const lines = multipliers.map(m =>
    `${GLYPHS.ARROW_RIGHT} ${describeRole(message.guild, m.roleId)} — **${m.multiplier}x**`);

  let roleValue = lines.join('\n');
  if (roleValue.length > 1024) {
    roleValue = `${roleValue.slice(0, 1000).replace(/\n[^\n]*$/, '')}\n— and more`;
  }

  const embed = await infoEmbed(guildId, 'XP Multipliers',
    `${GLYPHS.ARROW_RIGHT} **Server Booster Multiplier:** ${boosterMult}x`);
  embed.addFields(
    {
      name: `${GLYPHS.ARROW_RIGHT} Role Multipliers (${multipliers.length})`,
      value: roleValue || `No role multipliers set. Use \`${prefix}xpmultiplier add @role <multiplier>\` to add one.`
    },
    { name: `${GLYPHS.ARROW_RIGHT} How They Combine`, value: STACKING_NOTE }
  );

  return message.reply({ embeds: [embed] });
}

async function setBoosterMultiplier({ message, guildId, prefix }, arg) {
  const multiplier = parseFloat(arg);

  if (isNaN(multiplier) || multiplier < MIN_BOOSTER_MULTIPLIER || multiplier > MAX_BOOSTER_MULTIPLIER) {
    return message.reply({
      embeds: [await errorEmbed(guildId, 'Invalid Multiplier',
        `${GLYPHS.ERROR} Please provide a multiplier from ${MIN_BOOSTER_MULTIPLIER} to ${MAX_BOOSTER_MULTIPLIER}.\n\n` +
        `**Usage:** \`${prefix}xpmultiplier booster <multiplier>\`\n` +
        `**Example:** \`${prefix}xpmultiplier booster 1.5\``)]
    });
  }

  await Guild.updateGuild(guildId, { $set: { [`${PATH}.boosterMultiplier`]: multiplier } });

  return message.reply({
    embeds: [await successEmbed(guildId, 'Booster Multiplier Set',
      `${GLYPHS.SUCCESS} Server boosters now get **${multiplier}x** XP.` +
      (multiplier === 1 ? '\n\nA value of 1 gives boosters no bonus.' : ''))]
  });
}

async function clearMultipliers({ message, guildId, multipliers }) {
  if (multipliers.length === 0) {
    return message.reply({
      embeds: [await infoEmbed(guildId, 'Nothing to Clear',
        `${GLYPHS.INFO} There are no role XP multipliers to clear.`)]
    });
  }

  await Guild.updateGuild(guildId, { $set: { [`${PATH}.xpMultipliers`]: [] } });

  return message.reply({
    embeds: [await successEmbed(guildId, 'Multipliers Cleared',
      `${GLYPHS.SUCCESS} All ${multipliers.length} role XP multiplier(s) have been cleared.\n\n` +
      `The booster multiplier is unchanged.`)]
  });
}
