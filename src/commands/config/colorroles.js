import {
  EmbedBuilder, PermissionFlagsBits, ChannelType, ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType
} from 'discord.js';
import Guild from '../../models/Guild.js';
import { successEmbed, errorEmbed, infoEmbed, warningEmbed, GLYPHS, COLORS } from '../../utils/embeds.js';
import { getPrefix, hasModPerms } from '../../utils/helpers.js';
import { getRandomFooter } from '../../utils/raphael.js';

// Color roles are recognised by this name prefix in reactionRoleAdd/Remove, autoRole and
// autorole (one color at a time, never auto-assigned), so it has to stay as it is
export const COLOR_ROLE_PREFIX = '🎨 ';

// Default color options. The emoji are the panel's reactions (reactionRoleAdd maps them back)
export const COLOR_OPTIONS = [
  { emoji: '❤️', name: 'Red', color: '#FF0000' },
  { emoji: '🧡', name: 'Orange', color: '#FF8000' },
  { emoji: '💛', name: 'Yellow', color: '#FFFF00' },
  { emoji: '💚', name: 'Green', color: '#00FF00' },
  { emoji: '💙', name: 'Blue', color: '#0080FF' },
  { emoji: '💜', name: 'Purple', color: '#8000FF' },
  { emoji: '🩷', name: 'Pink', color: '#FF80C0' },
  { emoji: '🤍', name: 'White', color: '#FFFFFF' },
  { emoji: '🖤', name: 'Black', color: '#000001' },
  { emoji: '🩵', name: 'Cyan', color: '#00FFFF' },
  { emoji: '🤎', name: 'Brown', color: '#8B4513' },
  { emoji: '💗', name: 'Hot Pink', color: '#FF69B4' }
];

export const COLOR_CHANNEL_NAME = 'color-roles';

const DEFAULT_PANEL = {
  title: 'Color Roles',
  description: '**React to get a color role!**\nYou can only have one color at a time.',
  color: '#667eea',
  footer: 'Click a reaction to get/remove a color role'
};

// Earlier default title still stored in existing guild documents
const LEGACY_PANEL_TITLES = new Set(['🎨 Color Roles']);

const LIMITS = { title: 256, description: 4096, footer: 2048, embedTotal: 6000 };
const CONFIRM_TIMEOUT = 30000;
const REACTION_DELAY = 300;

// Reaction legend under the panel description
const PANEL_LEGEND = COLOR_OPTIONS.map(c => `${c.emoji} → \`${c.name}\``).join('\n');
const MAX_PANEL_DESCRIPTION = LIMITS.description - PANEL_LEGEND.length - 2;

const MANAGE_PANEL_PERMISSIONS = [PermissionFlagsBits.ManageRoles, PermissionFlagsBits.ManageChannels];
const BOT_SETUP_PERMISSIONS = [
  ['Manage Roles', PermissionFlagsBits.ManageRoles],
  ['Manage Channels', PermissionFlagsBits.ManageChannels],
  ['Manage Messages', PermissionFlagsBits.ManageMessages],
  ['Add Reactions', PermissionFlagsBits.AddReactions],
  ['Read Message History', PermissionFlagsBits.ReadMessageHistory],
  ['Send Messages', PermissionFlagsBits.SendMessages],
  ['Embed Links', PermissionFlagsBits.EmbedLinks]
];

export function colorRoleName(colorName) {
  return `${COLOR_ROLE_PREFIX}${colorName}`;
}

function safeColor(value, fallback) {
  if (typeof value === 'string' && /^#?[0-9a-f]{6}$/i.test(value)) {
    return value.startsWith('#') ? value : `#${value}`;
  }
  return fallback;
}

function isHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/** Panel text with defaults applied (the old emoji default title counts as unset). */
export function getPanelSettings(settings = {}) {
  return {
    title: !settings.title || LEGACY_PANEL_TITLES.has(settings.title) ? DEFAULT_PANEL.title : settings.title,
    description: settings.description || DEFAULT_PANEL.description,
    color: safeColor(settings.embedColor, DEFAULT_PANEL.color),
    footer: settings.footerText || DEFAULT_PANEL.footer,
    image: settings.image,
    thumbnail: settings.thumbnail
  };
}

/** Why these panel settings cannot be posted (Discord embed limits), or null. */
export function validatePanelSettings(settings = {}) {
  const panel = getPanelSettings(settings);
  if (panel.title.length > LIMITS.title) {
    return `The panel title is ${panel.title.length} characters; Discord allows ${LIMITS.title}.`;
  }
  if (panel.description.length > MAX_PANEL_DESCRIPTION) {
    return `The panel description is ${panel.description.length} characters; with the color list it may be at most ${MAX_PANEL_DESCRIPTION}.`;
  }
  if (panel.footer.length > LIMITS.footer) {
    return `The panel footer is ${panel.footer.length} characters; Discord allows ${LIMITS.footer}.`;
  }
  const total = panel.title.length + panel.description.length + PANEL_LEGEND.length + 2 + panel.footer.length;
  if (total > LIMITS.embedTotal) {
    return `The panel text totals ${total} characters; Discord allows ${LIMITS.embedTotal} per embed.`;
  }
  return null;
}

/** The color roles panel embed (call validatePanelSettings first to report problems). */
export function buildColorPanelEmbed(settings = {}) {
  const panel = getPanelSettings(settings);
  const embed = new EmbedBuilder()
    .setColor(panel.color)
    .setTitle(panel.title.slice(0, LIMITS.title))
    .setDescription(`${panel.description.slice(0, MAX_PANEL_DESCRIPTION)}\n\n${PANEL_LEGEND}`)
    .setFooter({ text: panel.footer.slice(0, LIMITS.footer) })
    .setTimestamp();

  if (panel.image && isHttpUrl(panel.image)) embed.setImage(panel.image);
  if (panel.thumbnail && isHttpUrl(panel.thumbnail)) embed.setThumbnail(panel.thumbnail);

  return embed;
}

/** Move the given color roles to just below the bot's highest role, in one request. */
export async function moveColorRolesBelowBot(guild, roles) {
  const targetPosition = Math.max(1, guild.members.me.roles.highest.position - 1);
  const rolePositions = [];
  let pos = targetPosition;
  for (const role of roles) {
    rolePositions.push({ role: role.id, position: pos });
    pos = Math.max(1, pos - 1);
  }
  if (rolePositions.length > 0) await guild.roles.setPositions(rolePositions);
  return targetPosition;
}

function missingBotPermissions(guild) {
  const me = guild.members.me;
  return BOT_SETUP_PERMISSIONS.filter(([, flag]) => !me.permissions.has(flag)).map(([label]) => label);
}

function statusEmbed(text) {
  return new EmbedBuilder()
    .setColor(COLORS.RAPHAEL)
    .setDescription(`${GLYPHS.LOADING} ${text}`)
    .setFooter({ text: getRandomFooter() });
}

export default {
  name: 'colorroles',
  category: 'config',
  description: 'Set up a color reaction roles channel and panel',
  usage: '<setup|settings|preview|refresh|fixposition|delete|set <option> <value>>',
  aliases: ['colorpanel', 'colormenu', 'reactioncolors'],
  permissions: [PermissionFlagsBits.ManageGuild],
  cooldown: 5,

  async execute(message, args) {
    const guildId = message.guild.id;
    const subCommand = args[0]?.toLowerCase();

    try {
      const guildConfig = await Guild.getGuild(guildId);
      const prefix = await getPrefix(guildId);

      // Check for moderator permissions (admin, mod role, or ManageGuild)
      if (!hasModPerms(message.member, guildConfig)) {
        return message.reply({
          embeds: [await errorEmbed(guildId, 'Permission Denied',
            `${GLYPHS.LOCK} You need Moderator/Staff permissions to manage color roles, Master.`)]
        });
      }

      // Creating or deleting channels and roles needs the matching Discord permissions,
      // not just a staff role
      if (['setup', 'create', 'delete', 'remove'].includes(subCommand) &&
        !message.member.permissions.has(MANAGE_PANEL_PERMISSIONS)) {
        return message.reply({
          embeds: [await errorEmbed(guildId, 'Permission Denied',
            `${GLYPHS.LOCK} Creating or deleting the color roles channel requires the **Manage Roles** and **Manage Channels** permissions, Master.`)]
        });
      }

      if (['fixposition', 'fixpos', 'position'].includes(subCommand) &&
        !message.member.permissions.has(PermissionFlagsBits.ManageRoles)) {
        return message.reply({
          embeds: [await errorEmbed(guildId, 'Permission Denied',
            `${GLYPHS.LOCK} Moving roles requires the **Manage Roles** permission, Master.`)]
        });
      }

      // No args - show help
      if (!subCommand) {
        return await this.showHelp(message, guildConfig, prefix);
      }

      // Setup command - creates channel and panel
      if (subCommand === 'setup' || subCommand === 'create') {
        return await this.setupColorRoles(message, guildConfig, prefix);
      }

      // Set command - edit preferences
      if (subCommand === 'set' || subCommand === 'edit') {
        return await this.setPreference(message, args.slice(1), guildConfig, prefix);
      }

      // Preview command
      if (subCommand === 'preview') {
        return await this.previewPanel(message, guildConfig);
      }

      // Refresh/update command
      if (subCommand === 'refresh' || subCommand === 'update') {
        return await this.refreshPanel(message, guildConfig, prefix);
      }

      // Delete command
      if (subCommand === 'delete' || subCommand === 'remove') {
        return await this.deletePanel(message, guildConfig, prefix);
      }

      // Fix position command - moves color roles to top
      if (subCommand === 'fixposition' || subCommand === 'fixpos' || subCommand === 'position') {
        return await this.fixRolePositions(message, prefix);
      }

      // Settings/info command
      if (subCommand === 'settings' || subCommand === 'info') {
        return await this.showSettings(message, guildConfig, prefix);
      }

      // Unknown subcommand - show help
      return await this.showHelp(message, guildConfig, prefix);

    } catch (error) {
      console.error('Color roles error:', error);
      const embed = await errorEmbed(guildId, 'Error',
        `${GLYPHS.ERROR} An error occurred, Master. Please try again.\n\n**Error:** ${String(error.message).slice(0, 500)}`
      );
      return message.reply({ embeds: [embed] }).catch(() => null);
    }
  },

  async showHelp(message, guildConfig, prefix) {
    const hasPanel = !!guildConfig.settings?.colorRoles?.messageId;

    const embed = new EmbedBuilder()
      .setColor(COLORS.RAPHAEL)
      .setTitle('『 Color Roles System 』')
      .setDescription(
        `**▸ Status:** ${hasPanel ? '◉ Active' : '◇ Not configured'}\n\n` +
        `**Commands:**\n` +
        `${GLYPHS.ARROW_RIGHT} \`${prefix}colorroles setup\` — Create channel & panel\n` +
        `${GLYPHS.ARROW_RIGHT} \`${prefix}colorroles settings\` — View current settings\n` +
        `${GLYPHS.ARROW_RIGHT} \`${prefix}colorroles preview\` — Preview the panel\n` +
        `${GLYPHS.ARROW_RIGHT} \`${prefix}colorroles refresh\` — Update the existing panel\n` +
        `${GLYPHS.ARROW_RIGHT} \`${prefix}colorroles fixposition\` — Move roles below mine\n` +
        `${GLYPHS.ARROW_RIGHT} \`${prefix}colorroles delete\` — Delete panel & channel\n\n` +
        `**Customization:**\n` +
        `${GLYPHS.ARROW_RIGHT} \`${prefix}colorroles set title <text>\`\n` +
        `${GLYPHS.ARROW_RIGHT} \`${prefix}colorroles set description <text>\`\n` +
        `${GLYPHS.ARROW_RIGHT} \`${prefix}colorroles set color <hex>\`\n` +
        `${GLYPHS.ARROW_RIGHT} \`${prefix}colorroles set image <url>\`\n` +
        `${GLYPHS.ARROW_RIGHT} \`${prefix}colorroles set thumbnail <url>\`\n` +
        `${GLYPHS.ARROW_RIGHT} \`${prefix}colorroles set footer <text>\``
      )
      .setFooter({ text: getRandomFooter() })
      .setTimestamp();

    return message.reply({ embeds: [embed] });
  },

  async fixRolePositions(message, prefix) {
    const guildId = message.guild.id;
    let statusMsg = null;

    try {
      const allColorRoles = message.guild.roles.cache.filter(r => r.name.startsWith(COLOR_ROLE_PREFIX));

      if (allColorRoles.size === 0) {
        const embed = await errorEmbed(guildId, 'No Color Roles',
          `${GLYPHS.ERROR} No color roles found in this server.\n\nRun \`${prefix}colorroles setup\` first, Master.`
        );
        return message.reply({ embeds: [embed] });
      }

      if (!message.guild.members.me.permissions.has(PermissionFlagsBits.ManageRoles)) {
        return message.reply({
          embeds: [await errorEmbed(guildId, 'Missing Permissions',
            `${GLYPHS.ERROR} I need the **Manage Roles** permission to move roles, Master.`)]
        });
      }

      statusMsg = await message.reply({
        embeds: [statusEmbed(`Moving ${allColorRoles.size} color roles below my highest role...`)]
      });

      await moveColorRolesBelowBot(message.guild, [...allColorRoles.values()]);

      const embed = await successEmbed(guildId, 'Roles Repositioned',
        `${GLYPHS.SUCCESS} Moved ${allColorRoles.size} color roles to the top, Master.\n\n` +
        `Color roles are now positioned just below my highest role.`
      );
      return statusMsg.edit({ embeds: [embed] });

    } catch (error) {
      console.error('Fix position error:', error);
      const embed = await errorEmbed(guildId, 'Failed to Reposition',
        `${GLYPHS.ERROR} Failed to move roles.\n\n**Error:** ${String(error.message).slice(0, 500)}\n\n` +
        `Make sure my role is higher than the color roles, Master.`
      );
      // Replace the "Moving..." status instead of leaving it behind
      if (statusMsg) return statusMsg.edit({ embeds: [embed] }).catch(() => message.reply({ embeds: [embed] }));
      return message.reply({ embeds: [embed] });
    }
  },

  async setupColorRoles(message, guildConfig, prefix) {
    const guildId = message.guild.id;
    const guild = message.guild;
    const settings = guildConfig.settings?.colorRoles || {};

    // Already set up only if the stored panel still exists
    if (settings.messageId && settings.channelId) {
      const existingChannel = guild.channels.cache.get(settings.channelId);
      const existingPanel = existingChannel?.isTextBased()
        ? await existingChannel.messages.fetch(settings.messageId).catch(() => null)
        : null;
      if (existingPanel) {
        const embed = await errorEmbed(guildId, 'Already Set Up',
          `${GLYPHS.ERROR} A color roles panel already exists in ${existingChannel}, Master.\n\n` +
          `Use \`${prefix}colorroles refresh\` to update it, or\n` +
          `Use \`${prefix}colorroles delete\` to remove it first.`
        );
        return message.reply({ embeds: [embed] });
      }
    }

    const missing = missingBotPermissions(guild);
    if (missing.length > 0) {
      return message.reply({
        embeds: [await errorEmbed(guildId, 'Missing Permissions',
          `${GLYPHS.ERROR} I need these permissions to set up color roles, Master:\n` +
          missing.map(p => `${GLYPHS.DOT} ${p}`).join('\n'))]
      });
    }

    // Validate before creating anything, so a bad title cannot leave a half-built setup
    const validationError = validatePanelSettings(settings);
    if (validationError) {
      return message.reply({
        embeds: [await errorEmbed(guildId, 'Panel Settings Invalid',
          `${GLYPHS.ERROR} ${validationError}\n\nAdjust it with \`${prefix}colorroles set\`, Master.`)]
      });
    }

    const statusMsg = await message.reply({
      embeds: [statusEmbed('Setting up the color roles system... This may take a moment.')]
    });

    let colorChannel = null;
    const createdRoles = [];

    try {
      // 1. Create the channel
      const category = message.channel.parent;
      colorChannel = await guild.channels.create({
        name: COLOR_CHANNEL_NAME,
        type: ChannelType.GuildText,
        parent: category?.id,
        topic: 'React to get a color role. You can only have one color at a time.',
        permissionOverwrites: [
          {
            id: guild.id, // @everyone
            deny: [PermissionFlagsBits.SendMessages],
            allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.AddReactions, PermissionFlagsBits.ReadMessageHistory]
          },
          {
            id: guild.members.me.id, // Bot
            allow: [PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageMessages, PermissionFlagsBits.AddReactions, PermissionFlagsBits.EmbedLinks]
          }
        ],
        reason: 'Color roles setup'
      });

      // 2. Create roles if they don't exist, just below the bot's highest role
      const targetPosition = Math.max(1, guild.members.me.roles.highest.position - 1);
      const colorRoles = [];
      let existingCount = 0;
      let failedCount = 0;

      for (const colorData of COLOR_OPTIONS) {
        let role = guild.roles.cache.find(r => r.name === colorRoleName(colorData.name));

        if (role) {
          existingCount++;
        } else {
          try {
            role = await guild.roles.create({
              name: colorRoleName(colorData.name),
              color: colorData.color,
              reason: 'Color roles setup',
              permissions: [],
              position: targetPosition
            });
            createdRoles.push(role);
          } catch (err) {
            console.error(`Failed to create role ${colorData.name}:`, err);
            failedCount++;
            continue;
          }
        }
        colorRoles.push({ colorData, role });
      }

      if (colorRoles.length === 0) {
        throw new Error('No color roles could be created.');
      }

      // 2.5 Reposition all color roles to be near the top (below bot's role)
      try {
        const allColorRoles = guild.roles.cache.filter(r => r.name.startsWith(COLOR_ROLE_PREFIX));
        await moveColorRolesBelowBot(guild, [...allColorRoles.values()]);
      } catch (err) {
        console.error('Failed to reposition color roles:', err);
        // Continue anyway, roles will still work just might not show color
      }

      // 3. Send the panel
      const colorMessage = await colorChannel.send({ embeds: [buildColorPanelEmbed(settings)] });

      // 4. Add reactions
      for (const { colorData } of colorRoles) {
        try {
          await colorMessage.react(colorData.emoji);
          await new Promise(resolve => setTimeout(resolve, REACTION_DELAY));
        } catch (err) {
          console.error(`Failed to add reaction ${colorData.emoji}:`, err);
        }
      }

      // 5. Save to database (copies, never the cached config object)
      const rolesMapping = colorRoles.map(({ colorData, role }) => ({
        emoji: colorData.emoji,
        roleId: role.id,
        name: colorData.name
      }));
      const reactionMessages = (guildConfig.settings?.reactionRoles?.messages || [])
        .filter(m => m.messageId !== settings.messageId)
        .map(m => ({ messageId: m.messageId, channelId: m.channelId, roles: m.roles }));
      reactionMessages.push({
        messageId: colorMessage.id,
        channelId: colorChannel.id,
        roles: rolesMapping.map(({ emoji, roleId }) => ({ emoji, roleId }))
      });

      await Guild.updateGuild(guildId, {
        $set: {
          'settings.reactionRoles.enabled': true,
          'settings.reactionRoles.messages': reactionMessages,
          'settings.colorRoles.enabled': true,
          'settings.colorRoles.channelId': colorChannel.id,
          'settings.colorRoles.messageId': colorMessage.id,
          'settings.colorRoles.roles': rolesMapping
        }
      });

      const successEmb = await successEmbed(guildId, 'Color Roles Setup Complete',
        `${GLYPHS.SUCCESS} The color roles system is now active, Master.\n\n` +
        `**Channel:** ${colorChannel}\n` +
        `**Roles Created:** ${createdRoles.length}\n` +
        `**Roles Existing:** ${existingCount}\n` +
        (failedCount > 0 ? `**Roles Failed:** ${failedCount}\n` : '') +
        `\nUse \`${prefix}colorroles set\` to customize the panel.`
      );

      await statusMsg.edit({ embeds: [successEmb] });

    } catch (error) {
      console.error('Setup error:', error);

      // Roll back what this run created so a retry does not duplicate the channel
      if (colorChannel) await colorChannel.delete('Color roles setup failed').catch(() => null);
      for (const role of createdRoles) {
        await role.delete('Color roles setup failed').catch(() => null);
      }

      const embed = await errorEmbed(guildId, 'Setup Failed',
        `${GLYPHS.ERROR} Failed to set up color roles, Master. The channel and roles created by this attempt were removed.\n\n` +
        `**Error:** ${String(error.message).slice(0, 500)}`
      );
      await statusMsg.edit({ embeds: [embed] }).catch(() => message.reply({ embeds: [embed] }));
    }
  },

  async setPreference(message, args, guildConfig, prefix) {
    const guildId = message.guild.id;
    const option = args[0]?.toLowerCase();
    const value = args.slice(1).join(' ');

    if (!option) {
      const embed = await infoEmbed(guildId, 'Set Preference',
        `**Available Options:**\n\n` +
        `${GLYPHS.ARROW_RIGHT} \`title\` — Panel title\n` +
        `${GLYPHS.ARROW_RIGHT} \`description\` — Panel description\n` +
        `${GLYPHS.ARROW_RIGHT} \`color\` — Embed color (hex)\n` +
        `${GLYPHS.ARROW_RIGHT} \`image\` — Large image/banner URL\n` +
        `${GLYPHS.ARROW_RIGHT} \`thumbnail\` — Small image URL\n` +
        `${GLYPHS.ARROW_RIGHT} \`footer\` — Footer text\n\n` +
        `**Example:**\n` +
        `\`${prefix}colorroles set title Pick Your Color\`\n` +
        `\`${prefix}colorroles set image https://example.com/banner.gif\``
      );
      return message.reply({ embeds: [embed] });
    }

    if (!value && option !== 'image' && option !== 'thumbnail') {
      const embed = await errorEmbed(guildId, 'Missing Value',
        `${GLYPHS.ERROR} Please provide a value for \`${option.slice(0, 50)}\`, Master.\n\n` +
        `Use \`${prefix}colorroles set ${option.slice(0, 50)} none\` to reset to default.`
      );
      return message.reply({ embeds: [embed] });
    }

    // Work on a copy: the config may be the shared cached object
    const settings = { ...(guildConfig.settings?.colorRoles || {}) };
    const update = {};
    let settingName = '';
    let displayValue = value;

    switch (option) {
      case 'title':
        settings.title = value === 'none' ? DEFAULT_PANEL.title : value;
        update['settings.colorRoles.title'] = settings.title;
        settingName = 'Title';
        break;

      case 'description':
      case 'desc':
        settings.description = value === 'none'
          ? DEFAULT_PANEL.description
          : value.replace(/\\n/g, '\n'); // Allow \n for new lines
        update['settings.colorRoles.description'] = settings.description;
        settingName = 'Description';
        break;

      case 'color':
      case 'embedcolor':
        if (!/^#?[0-9A-Fa-f]{6}$/.test(value) && value !== 'none') {
          const embed = await errorEmbed(guildId, 'Invalid Color',
            `${GLYPHS.ERROR} Please provide a valid hex color, Master.\n\n` +
            `**Example:** \`#667eea\` or \`667eea\``
          );
          return message.reply({ embeds: [embed] });
        }
        settings.embedColor = value === 'none' ? DEFAULT_PANEL.color : (value.startsWith('#') ? value : `#${value}`);
        update['settings.colorRoles.embedColor'] = settings.embedColor;
        settingName = 'Embed Color';
        displayValue = settings.embedColor;
        break;

      case 'image':
      case 'banner':
      case 'gif':
        if (value === 'none' || !value) {
          settings.image = null;
          displayValue = 'Removed';
        } else if (!value.match(/^https?:\/\/.+\.(png|jpg|jpeg|gif|webp)(\?.*)?$/i) && !value.includes('tenor.com') && !value.includes('giphy.com')) {
          const embed = await errorEmbed(guildId, 'Invalid URL',
            `${GLYPHS.ERROR} Please provide a valid image URL, Master.\n\n` +
            `Supported: png, jpg, gif, webp, tenor, giphy`
          );
          return message.reply({ embeds: [embed] });
        } else {
          settings.image = value;
        }
        update['settings.colorRoles.image'] = settings.image;
        settingName = 'Image/Banner';
        break;

      case 'thumbnail':
      case 'thumb':
      case 'icon':
        if (value === 'none' || !value) {
          settings.thumbnail = null;
          displayValue = 'Removed';
        } else if (!value.match(/^https?:\/\/.+\.(png|jpg|jpeg|gif|webp)(\?.*)?$/i) && !value.includes('tenor.com') && !value.includes('giphy.com')) {
          const embed = await errorEmbed(guildId, 'Invalid URL',
            `${GLYPHS.ERROR} Please provide a valid image URL, Master.\n\n` +
            `Supported: png, jpg, gif, webp, tenor, giphy`
          );
          return message.reply({ embeds: [embed] });
        } else {
          settings.thumbnail = value;
        }
        update['settings.colorRoles.thumbnail'] = settings.thumbnail;
        settingName = 'Thumbnail';
        break;

      case 'footer':
      case 'footertext':
        settings.footerText = value === 'none' ? DEFAULT_PANEL.footer : value;
        update['settings.colorRoles.footerText'] = settings.footerText;
        settingName = 'Footer';
        break;

      default: {
        const embed = await errorEmbed(guildId, 'Unknown Option',
          `${GLYPHS.ERROR} Unknown option: \`${option.slice(0, 50)}\`\n\n` +
          `Valid options: title, description, color, image, thumbnail, footer`
        );
        return message.reply({ embeds: [embed] });
      }
    }

    // Reject values the panel could not be posted with
    const validationError = validatePanelSettings(settings);
    if (validationError) {
      const embed = await errorEmbed(guildId, 'Value Too Long', `${GLYPHS.ERROR} ${validationError}`);
      return message.reply({ embeds: [embed] });
    }

    // Only the changed field, so the rest of the color roles config is left alone
    await Guild.updateGuild(guildId, { $set: update });

    const shown = String(displayValue);
    const embed = await successEmbed(guildId, 'Setting Updated',
      `${GLYPHS.SUCCESS} **${settingName}** has been updated, Master.\n\n` +
      `**New Value:** ${shown.length > 100 ? `${shown.substring(0, 100)}...` : shown}\n\n` +
      `${settings.messageId ? `Use \`${prefix}colorroles refresh\` to apply changes.` : `Use \`${prefix}colorroles setup\` to create the panel.`}`
    );
    return message.reply({ embeds: [embed] });
  },

  async previewPanel(message, guildConfig) {
    const settings = guildConfig.settings?.colorRoles || {};
    const validationError = validatePanelSettings(settings);
    if (validationError) {
      return message.reply({
        embeds: [await errorEmbed(message.guild.id, 'Panel Settings Invalid', `${GLYPHS.ERROR} ${validationError}`)]
      });
    }

    return message.reply({
      content: '**Preview of your color roles panel:**',
      embeds: [buildColorPanelEmbed(settings)]
    });
  },

  async refreshPanel(message, guildConfig, prefix) {
    const guildId = message.guild.id;
    const settings = guildConfig.settings?.colorRoles;

    if (!settings?.messageId || !settings?.channelId) {
      const embed = await errorEmbed(guildId, 'No Panel Found',
        `${GLYPHS.ERROR} No color roles panel exists, Master.\n\n` +
        `Use \`${prefix}colorroles setup\` to create one.`
      );
      return message.reply({ embeds: [embed] });
    }

    try {
      const channel = message.guild.channels.cache.get(settings.channelId);
      if (!channel) {
        const embed = await errorEmbed(guildId, 'Channel Not Found',
          `${GLYPHS.ERROR} The color roles channel was deleted, Master.\n\n` +
          `Use \`${prefix}colorroles setup\` to create a new panel.`
        );
        return message.reply({ embeds: [embed] });
      }

      const panelMessage = await channel.messages.fetch(settings.messageId).catch(() => null);
      if (!panelMessage) {
        const embed = await errorEmbed(guildId, 'Message Not Found',
          `${GLYPHS.ERROR} The panel message was deleted, Master.\n\n` +
          `Use \`${prefix}colorroles delete\` then \`${prefix}colorroles setup\` to recreate it.`
        );
        return message.reply({ embeds: [embed] });
      }

      const validationError = validatePanelSettings(settings);
      if (validationError) {
        const embed = await errorEmbed(guildId, 'Panel Settings Invalid', `${GLYPHS.ERROR} ${validationError}`);
        return message.reply({ embeds: [embed] });
      }

      await panelMessage.edit({ embeds: [buildColorPanelEmbed(settings)] });

      const successEmb = await successEmbed(guildId, 'Panel Updated',
        `${GLYPHS.SUCCESS} The color roles panel has been refreshed, Master.`
      );
      return message.reply({ embeds: [successEmb] });

    } catch (error) {
      console.error('Refresh error:', error);
      const embed = await errorEmbed(guildId, 'Refresh Failed',
        `${GLYPHS.ERROR} Failed to refresh the panel, Master.\n\n**Error:** ${String(error.message).slice(0, 500)}`
      );
      return message.reply({ embeds: [embed] });
    }
  },

  async deletePanel(message, guildConfig, prefix) {
    const guildId = message.guild.id;
    const settings = guildConfig.settings?.colorRoles;

    if (!settings?.channelId) {
      const embed = await errorEmbed(guildId, 'No Panel Found',
        `${GLYPHS.ERROR} No color roles panel exists to delete, Master.`
      );
      return message.reply({ embeds: [embed] });
    }

    const channel = message.guild.channels.cache.get(settings.channelId);
    if (channel && !message.guild.members.me.permissions.has(PermissionFlagsBits.ManageChannels)) {
      return message.reply({
        embeds: [await errorEmbed(guildId, 'Missing Permissions',
          `${GLYPHS.ERROR} I need the **Manage Channels** permission to delete ${channel}, Master.`)]
      });
    }

    const confirmEmbed = await warningEmbed(guildId, 'Delete Color Roles Panel',
      `${GLYPHS.WARNING} This will permanently delete ${channel ? `the channel ${channel} and its panel` : 'the stored panel (its channel no longer exists)'}.\n\n` +
      `The color roles themselves and your customization settings are kept.\n\n` +
      `Confirm within ${CONFIRM_TIMEOUT / 1000} seconds, Master.`
    );
    const buttons = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('colorroles_delete_confirm')
        .setLabel('Delete Panel')
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId('colorroles_delete_cancel')
        .setLabel('Cancel')
        .setStyle(ButtonStyle.Secondary)
    );

    const confirmMsg = await message.reply({ embeds: [confirmEmbed], components: [buttons] });

    let interaction;
    try {
      interaction = await confirmMsg.awaitMessageComponent({
        filter: i => i.user.id === message.author.id &&
          ['colorroles_delete_confirm', 'colorroles_delete_cancel'].includes(i.customId),
        componentType: ComponentType.Button,
        time: CONFIRM_TIMEOUT
      });
    } catch {
      const embed = await errorEmbed(guildId, 'Deletion Timed Out',
        `${GLYPHS.ERROR} No confirmation received. Nothing was deleted, Master.`);
      return confirmMsg.edit({ embeds: [embed], components: [] }).catch(() => null);
    }

    try {
      if (interaction.customId === 'colorroles_delete_cancel') {
        const embed = await infoEmbed(guildId, 'Deletion Cancelled', 'Nothing was deleted, Master.');
        return interaction.update({ embeds: [embed], components: [] });
      }

      await interaction.update({ embeds: [statusEmbed('Deleting the color roles panel...')], components: [] });

      // Re-read the channel: it may have been deleted while waiting for confirmation
      const target = message.guild.channels.cache.get(settings.channelId);
      if (target) await target.delete('Color roles panel deleted');

      const freshConfig = await Guild.getGuild(guildId);
      const filteredMessages = (freshConfig.settings?.reactionRoles?.messages || [])
        .filter(m => m.messageId !== settings.messageId)
        .map(m => ({ messageId: m.messageId, channelId: m.channelId, roles: m.roles }));

      await Guild.updateGuild(guildId, {
        $set: {
          'settings.reactionRoles.messages': filteredMessages,
          'settings.colorRoles.channelId': null,
          'settings.colorRoles.messageId': null
        }
      });

      const embed = await successEmbed(guildId, 'Panel Deleted',
        `${GLYPHS.SUCCESS} The color roles panel and channel have been deleted, Master.\n\n` +
        `Your customization settings are preserved.\n` +
        `Use \`${prefix}colorroles setup\` to create a new panel.`
      );
      return confirmMsg.edit({ embeds: [embed], components: [] });

    } catch (error) {
      console.error('Delete error:', error);
      const embed = await errorEmbed(guildId, 'Delete Failed',
        `${GLYPHS.ERROR} Failed to delete the panel, Master.\n\n**Error:** ${String(error.message).slice(0, 500)}`
      );
      return confirmMsg.edit({ embeds: [embed], components: [] }).catch(() => message.reply({ embeds: [embed] }));
    }
  },

  async showSettings(message, guildConfig, prefix) {
    const settings = guildConfig.settings?.colorRoles || {};
    const panel = getPanelSettings(settings);
    const hasPanel = !!settings.messageId;

    const embed = new EmbedBuilder()
      .setColor(COLORS.RAPHAEL)
      .setTitle('『 Color Roles Settings 』')
      .setDescription(`Customize with \`${prefix}colorroles set <option> <value>\`, Master.`)
      .addFields(
        {
          name: '▸ Status',
          value: hasPanel ? `◉ Active in <#${settings.channelId}>` : '◇ Not configured',
          inline: true
        },
        {
          name: '▸ Title',
          value: `\`${panel.title.slice(0, 200)}\``,
          inline: true
        },
        {
          name: '▸ Embed Color',
          value: `\`${panel.color}\``,
          inline: true
        },
        {
          name: '▸ Description',
          value: settings.description
            ? settings.description.substring(0, 100) + (settings.description.length > 100 ? '...' : '')
            : 'Default',
          inline: false
        },
        {
          name: '▸ Image/Banner',
          value: settings.image ? `[View Image](${settings.image})` : 'Not configured',
          inline: true
        },
        {
          name: '▸ Thumbnail',
          value: settings.thumbnail ? `[View](${settings.thumbnail})` : 'Not set',
          inline: true
        },
        {
          name: '▸ Footer',
          value: `\`${(settings.footerText || 'Default').slice(0, 200)}\``,
          inline: true
        }
      )
      .setFooter({ text: getRandomFooter() })
      .setTimestamp();

    if (settings.thumbnail && isHttpUrl(settings.thumbnail)) embed.setThumbnail(settings.thumbnail);

    return message.reply({ embeds: [embed] });
  }
};
