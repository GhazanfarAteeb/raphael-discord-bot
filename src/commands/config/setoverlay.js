import { PermissionFlagsBits } from 'discord.js';
import Guild from '../../models/Guild.js';
import { successEmbed, errorEmbed, infoEmbed, GLYPHS } from '../../utils/embeds.js';
import { getPrefix, hasModPerms } from '../../utils/helpers.js';

const DEFAULT_OVERLAY = { color: '#000000', opacity: 0.5 };

// Helper function to convert hex to rgba
function hexToRgba(hex, opacity) {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (!result) return null;
  const r = parseInt(result[1], 16);
  const g = parseInt(result[2], 16);
  const b = parseInt(result[3], 16);
  return `rgba(${r}, ${g}, ${b}, ${opacity})`;
}

// While members may customise their own cards, the server overlay is stored but not applied
function customizationNote(prefix) {
  return {
    name: `${GLYPHS.WARNING} Not Active Yet`,
    value:
      'Profile customisation is enabled, so members still use their own overlays.\n' +
      `Run \`${prefix}feature disable profilecustomization\` to apply this overlay to every card.`
  };
}

export default {
  name: 'setoverlay',
  description: 'Configure server-wide overlay for profile and level cards (when customization is disabled)',
  usage: 'setoverlay <color|opacity|view|reset> [value]',
  aliases: ['overlay', 'cardoverlay'],
  category: 'config',
  permissions: [PermissionFlagsBits.Administrator],
  cooldown: 5,

  async execute(message, args) {
    const guildId = message.guild.id;

    try {
      const prefix = await getPrefix(guildId);
      const guildConfig = await Guild.getGuild(guildId);

      // Check for moderator permissions (admin, mod role, or ManageGuild)
      if (!hasModPerms(message.member, guildConfig)) {
        return message.reply({
          embeds: [await errorEmbed(guildId, 'Permission Denied',
            `${GLYPHS.LOCK} You need Moderator/Staff permissions to configure overlays.`)]
        });
      }

      const customizationEnabled = guildConfig.economy?.profileCustomization?.enabled !== false;

      if (!args[0]) {
        return showHelp(message, prefix, customizationEnabled, guildConfig);
      }

      const setting = args[0].toLowerCase();
      const value = args[1];

      if (setting === 'view' || setting === 'show' || setting === 'status') {
        return showOverlaySettings(message, prefix, customizationEnabled, guildConfig);
      }

      if (setting === 'reset') {
        return resetOverlaySettings(message, prefix, customizationEnabled);
      }

      if (setting === 'color' || setting === 'colour') {
        if (!value) {
          return message.reply({
            embeds: [await errorEmbed(guildId, 'Missing Value',
              `${GLYPHS.WARNING} Please provide a hex color.\n\n` +
              `**Usage:** \`${prefix}setoverlay color #000000\``)]
          });
        }
        return setOverlayColor(message, prefix, customizationEnabled, value);
      }

      if (setting === 'opacity') {
        if (!value) {
          return message.reply({
            embeds: [await errorEmbed(guildId, 'Missing Value',
              `${GLYPHS.WARNING} Please provide an opacity value (0-100).\n\n` +
              `**Usage:** \`${prefix}setoverlay opacity 50\``)]
          });
        }
        return setOverlayOpacity(message, prefix, customizationEnabled, value);
      }

      return message.reply({
        embeds: [await errorEmbed(guildId, 'Invalid Setting',
          `${GLYPHS.WARNING} Unknown setting. Use \`color\`, \`opacity\`, \`view\`, or \`reset\`.`)]
      });
    } catch (error) {
      console.error('[SetOverlay] Error:', error);
      return message.reply({
        embeds: [await errorEmbed(guildId, 'Configuration Error',
          'The overlay settings could not be updated, Master. Please try again.')]
      }).catch(() => null);
    }
  }
};

async function showHelp(message, prefix, customizationEnabled, guildConfig) {
  const cardOverlay = guildConfig.economy?.cardOverlay || DEFAULT_OVERLAY;

  const embed = await infoEmbed(message.guild.id, 'Server Overlay Settings',
    `${GLYPHS.INFO} Configure the server-wide overlay drawn on profile and level cards.\n\n` +
    `${GLYPHS.ARROW_RIGHT} **Color:** \`${cardOverlay.color}\`\n` +
    `${GLYPHS.ARROW_RIGHT} **Opacity:** \`${Math.round(cardOverlay.opacity * 100)}%\`\n` +
    `${GLYPHS.ARROW_RIGHT} **State:** ${customizationEnabled ? 'Stored, not applied (members customise their own)' : 'Applied to every card'}`);

  embed.addFields({
    name: `${GLYPHS.ARROW_RIGHT} Commands`,
    value:
      `\`${prefix}setoverlay color <hex>\` - e.g. \`#1a1a2e\`\n` +
      `\`${prefix}setoverlay opacity <0-100>\` - e.g. \`60\`\n` +
      `\`${prefix}setoverlay view\` - View current settings\n` +
      `\`${prefix}setoverlay reset\` - Reset to #000000 at 50%`
  });
  if (customizationEnabled) embed.addFields(customizationNote(prefix));

  return message.reply({ embeds: [embed] });
}

async function showOverlaySettings(message, prefix, customizationEnabled, guildConfig) {
  const cardOverlay = guildConfig.economy?.cardOverlay || DEFAULT_OVERLAY;

  const embed = await infoEmbed(message.guild.id, 'Server Overlay Settings',
    customizationEnabled
      ? `${GLYPHS.WARNING} Members can customise their own cards, so these settings are not active.`
      : `${GLYPHS.SUCCESS} These settings apply to every profile and level card.`);

  // Preview the overlay color itself
  if (hexToRgba(cardOverlay.color, 1)) embed.setColor(cardOverlay.color);

  embed.addFields(
    { name: `${GLYPHS.ARROW_RIGHT} Color`, value: `\`${cardOverlay.color}\``, inline: true },
    { name: `${GLYPHS.ARROW_RIGHT} Opacity`, value: `\`${Math.round(cardOverlay.opacity * 100)}%\``, inline: true },
    { name: `${GLYPHS.ARROW_RIGHT} Result`, value: `\`${hexToRgba(cardOverlay.color, cardOverlay.opacity) ?? 'Invalid color'}\``, inline: true }
  );
  if (customizationEnabled) embed.addFields(customizationNote(prefix));

  return message.reply({ embeds: [embed] });
}

async function setOverlayColor(message, prefix, customizationEnabled, value) {
  const guildId = message.guild.id;

  if (!/^#?[0-9A-Fa-f]{6}$/.test(value)) {
    return message.reply({
      embeds: [await errorEmbed(guildId, 'Invalid Color',
        `${GLYPHS.WARNING} Please provide a valid hex color.\n\n` +
        `**Examples:**\n` +
        `${GLYPHS.INFO} \`#000000\` - Black\n` +
        `${GLYPHS.INFO} \`#1a1a2e\` - Dark Blue\n` +
        `${GLYPHS.INFO} \`#2C2F33\` - Discord Dark`)]
    });
  }

  const hexColor = value.startsWith('#') ? value.toLowerCase() : `#${value.toLowerCase()}`;

  await Guild.updateGuild(guildId, {
    $set: { 'economy.cardOverlay.color': hexColor }
  });

  const embed = await successEmbed(guildId, 'Overlay Color Updated',
    `${GLYPHS.SUCCESS} Server overlay color set to \`${hexColor}\`.\n\n` +
    `This applies to both **profile** and **level/rank** cards.`);
  if (customizationEnabled) embed.addFields(customizationNote(prefix));

  return message.reply({ embeds: [embed] });
}

async function setOverlayOpacity(message, prefix, customizationEnabled, value) {
  const guildId = message.guild.id;
  const opacityPercent = Math.round(parseFloat(value)); // "50" and "50%" both read as 50

  if (Number.isNaN(opacityPercent) || opacityPercent < 0 || opacityPercent > 100) {
    return message.reply({
      embeds: [await errorEmbed(guildId, 'Invalid Opacity',
        `${GLYPHS.WARNING} Please provide a value between 0 and 100.\n\n` +
        `**Examples:**\n` +
        `${GLYPHS.INFO} \`0\` - Fully transparent\n` +
        `${GLYPHS.INFO} \`50\` - Half opacity\n` +
        `${GLYPHS.INFO} \`100\` - Fully opaque`)]
    });
  }

  await Guild.updateGuild(guildId, {
    $set: { 'economy.cardOverlay.opacity': opacityPercent / 100 }
  });

  const embed = await successEmbed(guildId, 'Overlay Opacity Updated',
    `${GLYPHS.SUCCESS} Server overlay opacity set to \`${opacityPercent}%\`.\n\n` +
    `This applies to both **profile** and **level/rank** cards.`);
  if (customizationEnabled) embed.addFields(customizationNote(prefix));

  return message.reply({ embeds: [embed] });
}

async function resetOverlaySettings(message, prefix, customizationEnabled) {
  const guildId = message.guild.id;

  await Guild.updateGuild(guildId, {
    $set: { 'economy.cardOverlay': { ...DEFAULT_OVERLAY } }
  });

  const embed = await successEmbed(guildId, 'Overlay Settings Reset',
    `${GLYPHS.SUCCESS} Server overlay settings reset to default.\n\n` +
    `${GLYPHS.ARROW_RIGHT} **Color:** \`${DEFAULT_OVERLAY.color}\`\n` +
    `${GLYPHS.ARROW_RIGHT} **Opacity:** \`${DEFAULT_OVERLAY.opacity * 100}%\``);
  if (customizationEnabled) embed.addFields(customizationNote(prefix));

  return message.reply({ embeds: [embed] });
}
