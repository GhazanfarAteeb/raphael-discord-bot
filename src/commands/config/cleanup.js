import { PermissionFlagsBits, ChannelType, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType } from 'discord.js';
import Guild from '../../models/Guild.js';
import { successEmbed, errorEmbed, warningEmbed, infoEmbed, GLYPHS, COLORS } from '../../utils/embeds.js';
import RateLimitQueue from '../../utils/RateLimitQueue.js';
import { getPrefix } from '../../utils/helpers.js';
import { getRandomFooter } from '../../utils/raphael.js';
import {
  LOG_CHANNELS, COMMUNITY_CHANNELS, TICKET_PANEL_CHANNEL, COLOR_ROLES_CHANNEL, SYSTEM_ROLES, LEVEL_ROLES,
  LOGS_CATEGORY, TICKETS_CATEGORY, hasSetupName, getPath
} from './setup.js';
import { COLOR_OPTIONS, colorRoleName } from './colorroles.js';

const CONFIRM_TIMEOUT = 60000;
const LIST_LIMIT = 15;
// Setup creates at most 20 roles and 14 channels, so the confirmation can list every one
const CONFIRM_LIST_LIMIT = 25;
const MAX_DESCRIPTION = 4096;
const CLEANUP_REASON = 'RAPHAEL Cleanup';

const SETUP_CHANNEL_DEFS = [...LOG_CHANNELS, ...COMMUNITY_CHANNELS, TICKET_PANEL_CHANNEL, COLOR_ROLES_CHANNEL];
const COLOR_ROLE_NAMES = new Set(COLOR_OPTIONS.map(c => colorRoleName(c.name)));

// Every config path that can hold an ID setup records; only the deleted IDs are cleared
const ID_PATHS = [
  ...SETUP_CHANNEL_DEFS.flatMap(def => def.paths),
  ...TICKETS_CATEGORY.paths,
  ...SYSTEM_ROLES.flatMap(def => def.paths)
];

function clipDescription(text) {
  return text.length > MAX_DESCRIPTION ? `${text.slice(0, MAX_DESCRIPTION - 1)}…` : text;
}

function listSection(title, items, limit = LIST_LIMIT) {
  if (items.length === 0) return '';
  const lines = items.slice(0, limit).map(item => `${GLYPHS.DOT} ${item}`);
  if (items.length > limit) lines.push(`... and ${items.length - limit} more`);
  return `**${title} (${items.length}):**\n${lines.join('\n')}\n\n`;
}

/**
 * What cleanup would delete: only IDs recorded in the guild config by setup (or the color
 * roles panel) that still carry a name setup gives them. Renamed or foreign items are kept.
 */
function planCleanup(guild, guildConfig) {
  const channels = new Map();
  const categories = new Map();
  const roles = new Map();
  const kept = new Map(); // id -> reason

  const keep = (item, label, reason) => {
    if (!channels.has(item.id) && !roles.has(item.id) && !categories.has(item.id)) {
      kept.set(item.id, `${label} — ${reason}`);
    }
  };

  // Channels recorded by setup
  for (const def of SETUP_CHANNEL_DEFS) {
    for (const path of def.paths) {
      const id = getPath(guildConfig, path);
      const channel = id ? guild.channels.cache.get(id) : null;
      if (!channel || channel.type === ChannelType.GuildCategory || channels.has(channel.id)) continue;
      if (hasSetupName(channel.name, def)) {
        channels.set(channel.id, channel);
        kept.delete(channel.id);
      } else {
        keep(channel, `#${channel.name}`, 'renamed or not created by setup');
      }
    }
  }

  // Categories: the recorded ticket category, and the category holding the recorded log channels.
  // Deleted only when every channel inside it is deleted too.
  const candidateCategories = [];
  for (const path of TICKETS_CATEGORY.paths) {
    const category = guild.channels.cache.get(getPath(guildConfig, path) ?? '');
    if (category?.type === ChannelType.GuildCategory) candidateCategories.push([category, TICKETS_CATEGORY]);
  }
  for (const def of LOG_CHANNELS) {
    const parent = def.paths.map(p => guild.channels.cache.get(getPath(guildConfig, p) ?? '')?.parent).find(Boolean);
    if (parent?.type === ChannelType.GuildCategory) candidateCategories.push([parent, LOGS_CATEGORY]);
  }
  for (const [category, def] of candidateCategories) {
    if (categories.has(category.id)) continue;
    if (!hasSetupName(category.name, def)) {
      keep(category, `Category ${category.name}`, 'renamed or not created by setup');
      continue;
    }
    const others = guild.channels.cache.filter(c => c.parentId === category.id && !channels.has(c.id));
    if (others.size > 0) {
      keep(category, `Category ${category.name}`, `contains ${others.size} other channel${others.size === 1 ? '' : 's'}`);
      continue;
    }
    categories.set(category.id, category);
    kept.delete(category.id);
  }

  // Roles recorded by setup. Without Manage Roles every role looks uneditable; the
  // permission check reports that instead.
  const canManageRoles = guild.members.me.permissions.has(PermissionFlagsBits.ManageRoles);
  const considerRole = (role, isSetupRole) => {
    if (!role || roles.has(role.id)) return;
    if (!isSetupRole) return keep(role, `@${role.name}`, 'renamed or not created by setup');
    if (role.managed || (canManageRoles && !role.editable)) return keep(role, `@${role.name}`, 'above my highest role or managed');
    roles.set(role.id, role);
    kept.delete(role.id);
  };

  for (const def of SYSTEM_ROLES) {
    for (const path of def.paths) {
      const role = guild.roles.cache.get(getPath(guildConfig, path) ?? '');
      if (role) considerRole(role, hasSetupName(role.name, def));
    }
  }

  // Level rewards: only the roles setup created (custom reward roles are left alone)
  for (const reward of guildConfig.features?.levelSystem?.rewards || []) {
    const role = guild.roles.cache.get(reward.roleId ?? '');
    if (role && LEVEL_ROLES.some(def => hasSetupName(role.name, def))) considerRole(role, true);
  }

  // Color roles recorded by setup or by the colorroles panel
  const colorSettings = guildConfig.settings?.colorRoles || {};
  const panelEntry = (guildConfig.settings?.reactionRoles?.messages || [])
    .find(m => colorSettings.messageId && m.messageId === colorSettings.messageId);
  const colorRoleIds = [
    ...(colorSettings.roles || []).map(r => r.roleId),
    ...(panelEntry?.roles || []).map(r => r.roleId)
  ];
  for (const roleId of colorRoleIds) {
    const role = guild.roles.cache.get(roleId ?? '');
    if (role) considerRole(role, COLOR_ROLE_NAMES.has(role.name));
  }

  return { channels, categories, roles, kept };
}

function missingPermissions(guild, plan) {
  const me = guild.members.me;
  const missing = [];
  if ((plan.channels.size > 0 || plan.categories.size > 0) && !me.permissions.has(PermissionFlagsBits.ManageChannels)) {
    missing.push('Manage Channels');
  }
  if (plan.roles.size > 0 && !me.permissions.has(PermissionFlagsBits.ManageRoles)) {
    missing.push('Manage Roles');
  }
  return missing;
}

export default {
  name: 'cleanup',
  category: 'config',
  description: 'Remove the roles and channels created by the bot during setup',
  usage: '',
  aliases: ['unsetup', 'removesetup'],
  permissions: [PermissionFlagsBits.Administrator],
  cooldown: 30,

  async execute(message) {
    const guildId = message.guild.id;
    const guild = message.guild;

    // HIGHEST AUTHORITY - Only Discord Administrator permission allowed (no admin role bypass)
    if (!message.member.permissions.has(PermissionFlagsBits.Administrator)) {
      return message.reply({
        embeds: [await errorEmbed(guildId, 'Permission Denied',
          `${GLYPHS.LOCK} This command requires the Discord Administrator permission, Master.\n\n` +
          `**Note:** Admin roles cannot bypass this check for safety reasons.`)]
      });
    }

    let confirmMsg = null;

    try {
      const guildConfig = await Guild.getGuild(guildId);
      const prefix = await getPrefix(guildId);
      const plan = planCleanup(guild, guildConfig);
      const totalItems = plan.channels.size + plan.categories.size + plan.roles.size;
      const keptSection = listSection('Kept', [...plan.kept.values()]);

      if (totalItems === 0) {
        return message.reply({
          embeds: [await infoEmbed(guildId, 'Nothing to Clean', clipDescription(
            `${GLYPHS.INFO} No roles or channels recorded by setup were found, Master.\n\n` +
            `Either setup was never run or its items were already removed.\n\n${keptSection}`.trim()))]
        });
      }

      const missing = missingPermissions(guild, plan);
      if (missing.length > 0) {
        return message.reply({
          embeds: [await errorEmbed(guildId, 'Missing Permissions',
            `${GLYPHS.ERROR} I need these permissions to clean up, Master:\n` +
            missing.map(p => `${GLYPHS.DOT} ${p}`).join('\n'))]
        });
      }

      const confirmEmbed = await warningEmbed(guildId, 'Cleanup Confirmation', clipDescription(
        `${GLYPHS.WARNING} **This will permanently delete exactly these items:**\n\n` +
        listSection('Channels', [...plan.channels.values()].map(c => `#${c.name}`), CONFIRM_LIST_LIMIT) +
        listSection('Categories', [...plan.categories.values()].map(c => c.name), CONFIRM_LIST_LIMIT) +
        listSection('Roles', [...plan.roles.values()].map(r => `@${r.name}`), CONFIRM_LIST_LIMIT) +
        keptSection +
        `**Total: ${totalItems} items.** This cannot be undone.\n` +
        `Only the configuration entries pointing at deleted items are cleared.\n\n` +
        `Confirm within ${CONFIRM_TIMEOUT / 1000} seconds, Master.`
      ));

      const buttons = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('cleanup_confirm')
          .setLabel('Confirm Cleanup')
          .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
          .setCustomId('cleanup_cancel')
          .setLabel('Cancel')
          .setStyle(ButtonStyle.Secondary)
      );

      confirmMsg = await message.reply({ embeds: [confirmEmbed], components: [buttons] });

      let interaction;
      try {
        interaction = await confirmMsg.awaitMessageComponent({
          filter: i => i.user.id === message.author.id && ['cleanup_confirm', 'cleanup_cancel'].includes(i.customId),
          componentType: ComponentType.Button,
          time: CONFIRM_TIMEOUT
        });
      } catch {
        const timeoutEmbed = await errorEmbed(guildId, 'Cleanup Timed Out',
          `${GLYPHS.ERROR} No response received within ${CONFIRM_TIMEOUT / 1000} seconds.\n\nNothing was deleted, Master.`
        );
        return confirmMsg.edit({ embeds: [timeoutEmbed], components: [] }).catch(() => null);
      }

      if (interaction.customId === 'cleanup_cancel') {
        const cancelEmbed = await infoEmbed(guildId, 'Cleanup Cancelled',
          'Cleanup has been cancelled. No changes were made, Master.'
        );
        return interaction.update({ embeds: [cancelEmbed], components: [] });
      }

      await interaction.update({
        embeds: [new EmbedBuilder()
          .setColor(COLORS.RAPHAEL)
          .setDescription(`${GLYPHS.LOADING} Cleaning up... This may take a moment due to rate limiting.`)
          .setFooter({ text: getRandomFooter() })
        ],
        components: []
      });

      const deleted = [];
      const failed = [];
      const deletedIds = new Set();
      const queue = RateLimitQueue.forDiscord();

      const runJobs = async jobs => {
        const settled = await Promise.allSettled(jobs.map(job => queue.add(job.fn, job.label)));
        settled.forEach((result, i) => {
          if (result.status === 'rejected') failed.push(`${jobs[i].label}: ${result.reason?.message ?? result.reason}`);
        });
      };

      // Channels first, then their now-empty categories, then roles
      await runJobs([...plan.channels.values()].map(channel => ({
        label: `#${channel.name}`,
        fn: async () => {
          await channel.delete(CLEANUP_REASON);
          deletedIds.add(channel.id);
          deleted.push(`Channel: #${channel.name}`);
        }
      })));

      await runJobs([...plan.categories.values()].map(category => ({
        label: `Category ${category.name}`,
        fn: async () => {
          // Never take other channels with it: skip if anything is still inside
          const remaining = guild.channels.cache.filter(c => c.parentId === category.id);
          if (remaining.size > 0) {
            throw new Error(`still contains ${remaining.size} channel${remaining.size === 1 ? '' : 's'}`);
          }
          await category.delete(CLEANUP_REASON);
          deletedIds.add(category.id);
          deleted.push(`Category: ${category.name}`);
        }
      })));

      await runJobs([...plan.roles.values()].map(role => ({
        label: `@${role.name}`,
        fn: async () => {
          await role.delete(CLEANUP_REASON);
          deletedIds.add(role.id);
          deleted.push(`Role: @${role.name}`);
        }
      })));

      // Clear only the config entries that pointed at something deleted
      let clearedEntries = 0;
      if (deletedIds.size > 0) {
        const freshConfig = await Guild.getGuild(guildId);
        const $unset = {};
        for (const path of ID_PATHS) {
          const id = getPath(freshConfig, path);
          if (id && deletedIds.has(id)) $unset[path] = '';
        }

        const colorSettings = freshConfig.settings?.colorRoles || {};
        const colorChannelGone = colorSettings.channelId && deletedIds.has(colorSettings.channelId);
        if (colorChannelGone && colorSettings.messageId) $unset['settings.colorRoles.messageId'] = '';

        const $pull = {};
        const deletedRoleIds = [...deletedIds].filter(id => plan.roles.has(id));
        if (deletedRoleIds.length > 0) {
          $pull['features.levelSystem.rewards'] = { roleId: { $in: deletedRoleIds } };
          $pull['settings.colorRoles.roles'] = { roleId: { $in: deletedRoleIds } };
        }
        if (colorChannelGone && colorSettings.messageId) {
          $pull['settings.reactionRoles.messages'] = { messageId: colorSettings.messageId };
        }

        const update = {};
        if (Object.keys($unset).length > 0) update.$unset = $unset;
        if (Object.keys($pull).length > 0) update.$pull = $pull;
        clearedEntries = Object.keys($unset).length;

        if (Object.keys(update).length > 0) {
          await Guild.updateGuild(guildId, update);
        }
      }

      const summary =
        listSection('Deleted', deleted) +
        listSection('Failed', failed.map(f => f.slice(0, 150))) +
        `${GLYPHS.ARROW_RIGHT} ${clearedEntries} configuration entr${clearedEntries === 1 ? 'y' : 'ies'} cleared; all other settings were kept.\n` +
        `Use \`${prefix}setup\` to set up the bot again.`;

      const resultEmbed = failed.length > 0
        ? await warningEmbed(guildId, 'Cleanup Completed with Errors',
          clipDescription(`${GLYPHS.WARNING} Some items could not be deleted, Master.\n\n${summary}`))
        : await successEmbed(guildId, 'Cleanup Complete',
          clipDescription(`${GLYPHS.SUCCESS} Cleanup finished, Master.\n\n${summary}`));

      await confirmMsg.edit({ embeds: [resultEmbed], components: [] });

    } catch (error) {
      console.error('Cleanup error:', error);
      const errEmbed = await errorEmbed(guildId, 'Cleanup Failed',
        `${GLYPHS.ERROR} An error occurred during cleanup, Master.\n\n**Error:** ${String(error.message).slice(0, 500)}`
      );
      if (confirmMsg) {
        return confirmMsg.edit({ embeds: [errEmbed], components: [] }).catch(() => message.reply({ embeds: [errEmbed] }));
      }
      return message.reply({ embeds: [errEmbed] });
    }
  }
};
