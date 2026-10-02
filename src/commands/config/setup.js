import { PermissionFlagsBits, ChannelType, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import Guild from '../../models/Guild.js';
import { successEmbed, infoEmbed, errorEmbed, warningEmbed, GLYPHS, COLORS } from '../../utils/embeds.js';
import { getPrefix } from '../../utils/helpers.js';
import { getRandomFooter } from '../../utils/raphael.js';
import RateLimitQueue from '../../utils/RateLimitQueue.js';
import {
  COLOR_OPTIONS, COLOR_CHANNEL_NAME, colorRoleName, buildColorPanelEmbed, validatePanelSettings, moveColorRolesBelowBot
} from './colorroles.js';

// ==================== WHAT SETUP CREATES ====================
// Shared with cleanup.js, which only deletes recorded IDs that still carry one of these names.
// `legacy` are the (emoji) names earlier versions created; `find` adopts an existing text channel.

export const LOGS_CATEGORY = { name: 'Logs', legacy: ['📋 Logs'], match: 'logs' };
export const TICKETS_CATEGORY = {
  name: 'Tickets', legacy: ['🎫 Tickets'], match: 'ticket',
  paths: ['channels.ticketCategory', 'features.ticketSystem.category']
};

export const LOG_CHANNELS = [
  { key: 'modLog', name: 'mod-log', find: ['mod-log'], legacy: ['🔨-mod-log'], paths: ['channels.modLog'] },
  {
    key: 'alertLog', name: 'alert-log', find: ['alert-log'], legacy: ['🚨-alert-log'],
    paths: ['channels.alertLog', 'features.memberTracking.alertChannel', 'features.accountAge.alertChannel']
  },
  { key: 'joinLog', name: 'join-log', find: ['join-log'], legacy: ['📥-join-log'], paths: ['channels.joinLog'] },
  { key: 'botStatus', name: 'bot-status', find: ['bot-status'], legacy: ['🤖-bot-status'], paths: ['channels.botStatus'] },
  { key: 'messageLog', name: 'message-log', find: ['message-log'], legacy: ['💬-message-log'], paths: ['channels.messageLog'] },
  { key: 'voiceLog', name: 'voice-log', find: ['voice-log'], legacy: ['🔊-voice-log'], paths: ['channels.voiceLog'] },
  { key: 'memberLog', name: 'member-log', find: ['member-log'], legacy: ['👤-member-log'], paths: ['channels.memberLog'] },
  { key: 'serverLog', name: 'server-log', find: ['server-log'], legacy: ['⚙️-server-log'], paths: ['channels.serverLog'] },
  {
    key: 'ticketLog', name: 'ticket-logs', find: ['ticket-log'], legacy: ['📝-ticket-logs'],
    paths: ['channels.ticketLog', 'features.ticketSystem.logChannel']
  }
];

export const COMMUNITY_CHANNELS = [
  {
    key: 'birthday', name: 'birthdays', find: ['birthday'], legacy: ['🎂-birthdays'],
    paths: ['features.birthdaySystem.channel', 'channels.birthdayChannel']
  },
  {
    key: 'events', name: 'events', find: ['events'], legacy: ['📅-events'],
    paths: ['features.eventSystem.channel', 'channels.eventChannel']
  },
  {
    key: 'levelUp', name: 'level-ups', find: ['level-up'], legacy: ['🎉-level-ups'],
    paths: ['features.levelSystem.levelUpChannel', 'channels.levelUpChannel']
  },
  {
    key: 'welcome', name: 'welcome', find: ['welcome'], legacy: ['👋-welcome'],
    paths: ['features.welcomeSystem.channel', 'channels.welcomeChannel']
  }
];

export const TICKET_PANEL_CHANNEL = {
  key: 'ticketPanel', name: 'create-ticket', find: ['create-ticket', 'ticket-panel'], legacy: ['🎫-create-ticket'],
  paths: ['channels.ticketPanelChannel']
};

export const COLOR_ROLES_CHANNEL = {
  key: 'colorRoles', name: COLOR_CHANNEL_NAME, find: ['color-role', 'get-color'],
  legacy: ['🎨-color-roles', '🎨・color-roles'], paths: ['settings.colorRoles.channelId']
};

export const SYSTEM_ROLES = [
  {
    key: 'susRole', name: 'Sus/Radar', legacy: ['🚨 Sus/Radar'], color: '#ff9900', reason: 'Suspicious member tracking',
    paths: ['roles.susRole', 'features.memberTracking.susRole']
  },
  {
    key: 'newAccountRole', name: 'New Account', legacy: ['🥚 New Account'], color: '#ffff00', reason: 'New account tracking',
    paths: ['roles.newAccountRole', 'features.accountAge.newAccountRole']
  },
  {
    key: 'mutedRole', name: 'Muted', legacy: ['🔇 Muted'], color: '#808080', reason: 'Mute functionality',
    permissions: [], paths: ['roles.mutedRole']
  }
];

export const LEVEL_ROLES = [
  { level: 5, name: 'Level 5', legacy: ['⭐ Level 5'], color: '#43B581' },
  { level: 10, name: 'Level 10', legacy: ['🌟 Level 10'], color: '#FAA61A' },
  { level: 20, name: 'Level 20', legacy: ['✨ Level 20'], color: '#F47B67' },
  { level: 30, name: 'Level 30', legacy: ['💫 Level 30'], color: '#7289DA' },
  { level: 50, name: 'Level 50', legacy: ['🏆 Level 50'], color: '#FFD700' }
];

// Defaults applied leaf by leaf, never as whole objects, so custom words, whitelists and
// ignored channels/roles survive. Toggles that setup turns on are forced on the first run only;
// every other value is written only when the guild has none.
const AUTOMOD_DEFAULTS = {
  'features.autoMod.enabled': true,
  'features.autoMod.antiSpam.enabled': true,
  'features.autoMod.antiSpam.messageLimit': 5,
  'features.autoMod.antiSpam.timeWindow': 5,
  'features.autoMod.antiSpam.action': 'warn',
  'features.autoMod.antiRaid.enabled': true,
  'features.autoMod.antiRaid.joinThreshold': 10,
  'features.autoMod.antiRaid.timeWindow': 30,
  'features.autoMod.antiRaid.action': 'lockdown',
  'features.autoMod.antiNuke.enabled': true,
  'features.autoMod.antiNuke.banThreshold': 5,
  'features.autoMod.antiNuke.kickThreshold': 5,
  'features.autoMod.antiNuke.roleDeleteThreshold': 3,
  'features.autoMod.antiNuke.channelDeleteThreshold': 3,
  'features.autoMod.antiNuke.timeWindow': 60,
  'features.autoMod.antiNuke.action': 'removeRoles',
  'features.autoMod.antiMassMention.enabled': true,
  'features.autoMod.antiMassMention.limit': 5,
  'features.autoMod.antiMassMention.action': 'delete',
  'features.autoMod.badWords.enabled': true,
  'features.autoMod.badWords.useBuiltInList': true,
  'features.autoMod.badWords.action': 'delete',
  'features.autoMod.badWords.timeoutDuration': 300,
  'features.autoMod.badWords.autoEscalate': true,
  'features.autoMod.antiRoleSpam.enabled': true,
  'features.autoMod.antiRoleSpam.cooldown': 60,
  'features.autoMod.antiLinks.enabled': false,
  'features.autoMod.antiLinks.action': 'delete',
  'features.autoMod.antiInvites.enabled': true,
  'features.autoMod.antiInvites.action': 'delete'
};

const FEATURE_TOGGLES = {
  'features.levelSystem.enabled': true,
  'features.ticketSystem.enabled': true
};

const REQUIRED_BOT_PERMISSIONS = [
  ['Manage Roles', PermissionFlagsBits.ManageRoles],
  ['Manage Channels', PermissionFlagsBits.ManageChannels],
  ['Manage Messages', PermissionFlagsBits.ManageMessages],
  ['Add Reactions', PermissionFlagsBits.AddReactions],
  ['Read Message History', PermissionFlagsBits.ReadMessageHistory],
  ['View Channels', PermissionFlagsBits.ViewChannel],
  ['Send Messages', PermissionFlagsBits.SendMessages],
  ['Embed Links', PermissionFlagsBits.EmbedLinks]
];

// What the muted role is denied, per channel kind
const MUTE_DENIES = {
  text: ['SendMessages', 'AddReactions', 'CreatePublicThreads', 'CreatePrivateThreads', 'SendMessagesInThreads'],
  forum: ['SendMessages', 'SendMessagesInThreads', 'CreatePublicThreads', 'AddReactions'],
  voice: ['Speak', 'SendMessages', 'AddReactions'],
  stage: ['Speak', 'RequestToSpeak', 'SendMessages', 'AddReactions']
};
const MUTE_KIND_BY_TYPE = {
  [ChannelType.GuildText]: 'text',
  [ChannelType.GuildAnnouncement]: 'text',
  [ChannelType.GuildForum]: 'forum',
  [ChannelType.GuildMedia]: 'forum',
  [ChannelType.GuildVoice]: 'voice',
  [ChannelType.GuildStageVoice]: 'stage'
};

const TEXT_CHANNEL_TYPES = [ChannelType.GuildText, ChannelType.GuildAnnouncement];
const PANEL_SEARCH_LIMIT = 50;
const SUMMARY_LIST_LIMIT = 10;
const SETUP_REASON = 'RAPHAEL Setup';

// ==================== HELPERS ====================

export function normalizeName(name) {
  return String(name ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** True when `name` is one setup gives (or gave) this item, ignoring emoji and punctuation. */
export function hasSetupName(name, def) {
  const normalized = normalizeName(name);
  return [def.name, ...(def.legacy || [])].some(n => normalizeName(n) === normalized);
}

export function getPath(obj, path) {
  return path.split('.').reduce((value, key) => value?.[key], obj);
}

function plural(count, word) {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

function listLines(items, glyph) {
  const shown = items.slice(0, SUMMARY_LIST_LIMIT).map(item => `${glyph} ${item}`);
  if (items.length > SUMMARY_LIST_LIMIT) shown.push(`... and ${items.length - SUMMARY_LIST_LIMIT} more`);
  return shown.join('\n');
}

export default {
  name: 'setup',
  category: 'config',
  description: 'Initial server setup wizard',
  usage: '',
  aliases: ['initialize'],
  permissions: [PermissionFlagsBits.Administrator],
  cooldown: 30,

  async execute(message) {
    const guild = message.guild;
    const guildId = guild.id;
    let setupMsg = null;

    try {
      const guildConfig = await Guild.getGuild(guildId, guild.name);

      // Check for admin role
      const hasAdminRole = guildConfig.roles?.adminRoles?.some(roleId =>
        message.member.roles.cache.has(roleId)
      );

      if (!message.member.permissions.has(PermissionFlagsBits.Administrator) && !hasAdminRole) {
        return message.reply({
          embeds: [await errorEmbed(guildId, 'Permission Denied',
            `${GLYPHS.LOCK} You need Administrator permissions to run setup, Master.`)]
        });
      }

      // Works for the slash /setup wrapper too, whose message object has no `client`
      const me = guild.members.me ?? await guild.members.fetchMe();
      const missing = REQUIRED_BOT_PERMISSIONS.filter(([, flag]) => !me.permissions.has(flag)).map(([label]) => label);
      if (missing.length > 0) {
        return message.reply({
          embeds: [await errorEmbed(guildId, 'Missing Permissions',
            `${GLYPHS.ERROR} I need these permissions before I can set up the server, Master:\n` +
            missing.map(p => `${GLYPHS.DOT} ${p}`).join('\n'))]
        });
      }

      const prefix = await getPrefix(guildId);
      const embed = await infoEmbed(guildId, 'Setting Up RAPHAEL',
        `${GLYPHS.LOADING} Starting setup process...\n\n` +
        `This may take a minute as roles and channels are created safely.`
      );
      setupMsg = await message.reply({ embeds: [embed] });

      const progress = async text => {
        embed.setDescription(`${GLYPHS.LOADING} ${text}`);
        await setupMsg.edit({ embeds: [embed] }).catch(() => null);
      };

      // Rate-limited queue for Discord API calls. Every job is collected and settled, so a
      // failure is reported instead of escaping as an unhandled rejection.
      const queue = RateLimitQueue.forDiscord();
      const created = [];
      const failures = [];
      const runJobs = async jobs => {
        const settled = await Promise.allSettled(jobs.map(job => queue.add(job.fn, job.label)));
        return settled.map((result, i) => {
          if (result.status === 'fulfilled') return result.value;
          failures.push(`${jobs[i].label}: ${result.reason?.message ?? result.reason}`);
          return null;
        });
      };

      // A guild that never stored any of setup's core IDs is being set up for the first time
      const isFirstRun = !guildConfig.channels?.modLog && !guildConfig.roles?.mutedRole &&
        !guildConfig.channels?.ticketPanelChannel;

      const channelById = (id, types) => {
        const channel = id ? guild.channels.cache.get(id) : null;
        return channel && (!types || types.includes(channel.type)) ? channel : null;
      };
      const storedChannel = def => def.paths.map(p => channelById(getPath(guildConfig, p), TEXT_CHANNEL_TYPES)).find(Boolean);
      const namedTextChannel = def => guild.channels.cache.find(c =>
        c.type === ChannelType.GuildText && def.find.some(f => normalizeName(c.name).includes(normalizeName(f))));
      const roleByName = def => guild.roles.cache.find(r => hasSetupName(r.name, def));

      const results = { channels: {}, roles: {}, categories: {} };

      // ==================== PHASE 1: LOG CHANNELS ====================
      await progress('Creating log channels...');

      const textChannelJob = (def, options) => ({
        label: `Channel: #${def.name}`,
        fn: async () => {
          const channel = await guild.channels.create({
            name: def.name,
            type: ChannelType.GuildText,
            reason: SETUP_REASON,
            ...options
          });
          created.push(`Channel: #${channel.name}`);
          results.channels[def.key] = channel;
          return channel;
        }
      });

      const missingLogChannels = [];
      for (const def of LOG_CHANNELS) {
        const existing = storedChannel(def) ?? namedTextChannel(def);
        if (existing) results.channels[def.key] = existing;
        else missingLogChannels.push(def);
      }

      // A logs category is only needed for log channels that still have to be created:
      // the category the stored log channels live in, else one named "Logs" (symbols ignored)
      if (missingLogChannels.length > 0) {
        results.categories.logs = LOG_CHANNELS.map(def => results.channels[def.key]?.parent)
          .find(parent => parent?.type === ChannelType.GuildCategory) ??
          guild.channels.cache.find(c => c.type === ChannelType.GuildCategory && normalizeName(c.name) === LOGS_CATEGORY.match);

        if (!results.categories.logs) {
          [results.categories.logs] = await runJobs([{
            label: `Category: ${LOGS_CATEGORY.name}`,
            fn: async () => {
              const category = await guild.channels.create({
                name: LOGS_CATEGORY.name,
                type: ChannelType.GuildCategory,
                permissionOverwrites: [
                  { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
                  { id: me.id, allow: [PermissionFlagsBits.ViewChannel] }
                ],
                reason: `${SETUP_REASON} - Logs category`
              });
              created.push(`Category: ${category.name}`);
              return category;
            }
          }]);
        }

        await runJobs(missingLogChannels.map(def =>
          textChannelJob(def, { parent: results.categories.logs?.id, reason: `${SETUP_REASON} - Log channel` })));
      }

      // ==================== PHASE 2: ROLES ====================
      await progress('Creating roles...');

      const roleJobs = [];

      // System roles: stored ID, then name (current or legacy), then create
      for (const def of SYSTEM_ROLES) {
        const stored = def.paths.map(p => guild.roles.cache.get(getPath(guildConfig, p) ?? '')).find(Boolean);
        const existing = stored ?? roleByName(def);
        if (existing) {
          results.roles[def.key] = existing;
          continue;
        }
        roleJobs.push({
          label: `Role: ${def.name}`,
          fn: async () => {
            const role = await guild.roles.create({
              name: def.name,
              color: def.color,
              permissions: def.permissions,
              reason: `${SETUP_REASON} - ${def.reason}`
            });
            created.push(`Role: ${role.name}`);
            results.roles[def.key] = role;
            return role;
          }
        });
      }

      // Level roles: only for levels that have no reward yet, so custom rewards stay as they are
      const existingRewards = guildConfig.features?.levelSystem?.rewards || [];
      const rewardedLevels = new Set(existingRewards
        .filter(r => r.roleId && guild.roles.cache.has(r.roleId))
        .map(r => Number(r.level)));
      const levelRoles = [];
      for (const def of LEVEL_ROLES) {
        if (rewardedLevels.has(def.level)) continue;
        const existing = roleByName(def);
        if (existing) {
          levelRoles.push({ level: def.level, role: existing });
          continue;
        }
        roleJobs.push({
          label: `Role: ${def.name}`,
          fn: async () => {
            const role = await guild.roles.create({
              name: def.name,
              color: def.color,
              reason: `${SETUP_REASON} - Level ${def.level} reward`
            });
            created.push(`Role: ${role.name}`);
            levelRoles.push({ level: def.level, role });
            return role;
          }
        });
      }

      // Color roles: stored mapping, then name, then create just below my highest role
      const storedColorRoles = guildConfig.settings?.colorRoles?.roles || [];
      const targetPosition = Math.max(1, me.roles.highest.position - 1);
      const colorRoles = [];
      const existingColorRoles = [];
      for (const colorData of COLOR_OPTIONS) {
        const mapped = storedColorRoles.find(r => r.name === colorData.name || r.emoji === colorData.emoji);
        const existing = (mapped && guild.roles.cache.get(mapped.roleId)) ??
          guild.roles.cache.find(r => r.name === colorRoleName(colorData.name));
        if (existing) {
          colorRoles.push({ colorData, role: existing });
          existingColorRoles.push(existing);
          continue;
        }
        roleJobs.push({
          label: `Role: ${colorRoleName(colorData.name)}`,
          fn: async () => {
            const role = await guild.roles.create({
              name: colorRoleName(colorData.name),
              color: colorData.color,
              permissions: [],
              position: targetPosition,
              reason: `${SETUP_REASON} - Color roles`
            });
            created.push(`Role: ${role.name}`);
            colorRoles.push({ colorData, role });
            return role;
          }
        });
      }

      // Existing color roles are moved up in one request, as the color only shows when they are high
      const lowColorRoles = existingColorRoles.filter(r => r.position < targetPosition - COLOR_OPTIONS.length);
      if (lowColorRoles.length > 0) {
        roleJobs.push({
          label: 'Move existing color roles',
          fn: () => moveColorRolesBelowBot(guild, lowColorRoles)
        });
      }

      await runJobs(roleJobs);
      // Keep the panel order stable regardless of which roles had to be created
      colorRoles.sort((a, b) => COLOR_OPTIONS.indexOf(a.colorData) - COLOR_OPTIONS.indexOf(b.colorData));
      levelRoles.sort((a, b) => a.level - b.level);

      // ==================== PHASE 3: MUTED ROLE PERMISSIONS ====================
      await progress('Applying muted role permissions...');

      const muteStats = { applied: 0, unchanged: 0, skipped: 0 };
      const mutedRole = results.roles.mutedRole;
      if (mutedRole) {
        const muteJobs = [];
        for (const channel of guild.channels.cache.values()) {
          const kind = MUTE_KIND_BY_TYPE[channel.type];
          if (!kind) continue;

          const myPerms = channel.permissionsFor(me);
          if (!myPerms?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ManageRoles])) {
            muteStats.skipped++;
            continue;
          }

          // Only deny what I hold in this channel: Discord rejects overwrites beyond that
          const denies = MUTE_DENIES[kind].filter(perm => myPerms.has(PermissionFlagsBits[perm]));
          const current = channel.permissionOverwrites.cache.get(mutedRole.id);
          if (denies.length === 0 || current?.deny.has(denies.map(perm => PermissionFlagsBits[perm]))) {
            muteStats.unchanged++;
            continue;
          }

          muteJobs.push({
            label: `Muted permissions: #${channel.name}`,
            fn: async () => {
              await channel.permissionOverwrites.edit(mutedRole,
                Object.fromEntries(denies.map(perm => [perm, false])),
                { reason: `${SETUP_REASON} - Muted role` });
              muteStats.applied++;
            }
          });
        }
        await runJobs(muteJobs);
      }

      // ==================== PHASE 4: TICKETS CATEGORY ====================
      await progress('Preparing the tickets category...');

      results.categories.tickets = TICKETS_CATEGORY.paths
        .map(p => channelById(getPath(guildConfig, p), [ChannelType.GuildCategory])).find(Boolean) ??
        guild.channels.cache.find(c => c.type === ChannelType.GuildCategory && normalizeName(c.name).includes(TICKETS_CATEGORY.match));

      if (!results.categories.tickets) {
        [results.categories.tickets] = await runJobs([{
          label: `Category: ${TICKETS_CATEGORY.name}`,
          fn: async () => {
            const category = await guild.channels.create({
              name: TICKETS_CATEGORY.name,
              type: ChannelType.GuildCategory,
              permissionOverwrites: [
                { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
                { id: me.id, allow: [PermissionFlagsBits.ViewChannel] }
              ],
              reason: `${SETUP_REASON} - Tickets category`
            });
            created.push(`Category: ${category.name}`);
            return category;
          }
        }]);
      }

      // ==================== PHASE 5: COMMUNITY CHANNELS ====================
      await progress('Creating community channels...');

      const channelJobs = [];
      for (const def of COMMUNITY_CHANNELS) {
        const existing = storedChannel(def) ?? namedTextChannel(def);
        if (existing) results.channels[def.key] = existing;
        else channelJobs.push(textChannelJob(def));
      }

      const ticketPanelChannel = storedChannel(TICKET_PANEL_CHANNEL) ?? namedTextChannel(TICKET_PANEL_CHANNEL);
      if (ticketPanelChannel) {
        results.channels.ticketPanel = ticketPanelChannel;
      } else {
        channelJobs.push(textChannelJob(TICKET_PANEL_CHANNEL, {
          permissionOverwrites: [
            { id: guild.id, allow: [PermissionFlagsBits.ViewChannel], deny: [PermissionFlagsBits.SendMessages] },
            { id: me.id, allow: [PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks] }
          ],
          reason: `${SETUP_REASON} - Ticket panel`
        }));
      }

      const colorChannel = storedChannel(COLOR_ROLES_CHANNEL) ?? namedTextChannel(COLOR_ROLES_CHANNEL);
      if (colorChannel) {
        results.channels.colorRoles = colorChannel;
      } else {
        channelJobs.push(textChannelJob(COLOR_ROLES_CHANNEL, {
          topic: 'React to get a color role. You can only have one color at a time.',
          permissionOverwrites: [
            {
              id: guild.id,
              deny: [PermissionFlagsBits.SendMessages],
              allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.AddReactions, PermissionFlagsBits.ReadMessageHistory]
            },
            {
              id: me.id,
              allow: [PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageMessages, PermissionFlagsBits.AddReactions, PermissionFlagsBits.EmbedLinks]
            }
          ],
          reason: `${SETUP_REASON} - Color roles`
        }));
      }

      await runJobs(channelJobs);

      // ==================== PHASE 6: PANELS & REACTIONS ====================
      await progress('Setting up panels and reactions...');

      // Ticket panel: only when the panel channel has none of my create_ticket panels yet
      let ticketPanelStatus = 'not available';
      if (results.channels.ticketPanel) {
        const recent = await results.channels.ticketPanel.messages.fetch({ limit: PANEL_SEARCH_LIMIT }).catch(() => null);
        const hasPanel = recent?.some(m => m.author.id === me.id &&
          m.components.some(row => row.components?.some(c => c.customId === 'create_ticket')));

        if (hasPanel) {
          ticketPanelStatus = 'already posted';
        } else {
          const ticketEmbed = new EmbedBuilder()
            .setColor(COLORS.RAPHAEL)
            .setTitle('『 Support Tickets 』')
            .setDescription(
              '**Need assistance? Open a support ticket.**\n\n' +
              'Press the button below to create a new ticket.\n' +
              'The support team will assist you as soon as possible.\n\n' +
              '**▸ Guidelines:**\n' +
              '• Be patient and respectful\n' +
              '• Provide clear details about your issue\n' +
              '• One issue per ticket'
            )
            .setFooter({ text: getRandomFooter() })
            .setTimestamp();

          const ticketButton = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId('create_ticket')
              .setLabel('Create Ticket')
              .setStyle(ButtonStyle.Primary)
          );

          const [sent] = await runJobs([{
            label: 'Ticket panel',
            fn: () => results.channels.ticketPanel.send({ embeds: [ticketEmbed], components: [ticketButton] })
          }]);
          ticketPanelStatus = sent ? 'posted' : 'failed';
        }
      }

      // Color panel: only when the stored panel message no longer exists
      const colorSettings = guildConfig.settings?.colorRoles || {};
      let colorPanelStatus = 'not available';
      let colorMessage = null;
      const storedPanelChannel = channelById(colorSettings.channelId, TEXT_CHANNEL_TYPES);
      const storedPanel = storedPanelChannel && colorSettings.messageId
        ? await storedPanelChannel.messages.fetch(colorSettings.messageId).catch(() => null)
        : null;

      if (storedPanel) {
        colorPanelStatus = 'already posted';
        results.channels.colorRoles = storedPanelChannel;
      } else if (results.channels.colorRoles && colorRoles.length === 0) {
        colorPanelStatus = 'skipped (no color roles)';
      } else if (results.channels.colorRoles) {
        const panelError = validatePanelSettings(colorSettings);
        if (panelError) {
          failures.push(`Color roles panel: ${panelError}`);
          colorPanelStatus = 'failed';
        } else {
          [colorMessage] = await runJobs([{
            label: 'Color roles panel',
            fn: () => results.channels.colorRoles.send({ embeds: [buildColorPanelEmbed(colorSettings)] })
          }]);
          colorPanelStatus = colorMessage ? 'posted' : 'failed';

          if (colorMessage) {
            await runJobs(colorRoles.map(({ colorData }) => ({
              label: `Reaction ${colorData.name}`,
              fn: () => colorMessage.react(colorData.emoji)
            })));
          }
        }
      }

      // ==================== PHASE 7: SAVE CONFIGURATION ====================
      await progress('Saving configuration...');

      const update = {};
      // IDs are written only where nothing usable is stored (unset, or pointing at a deleted item)
      const setIdIfUnset = (path, id) => {
        if (!id) return;
        const current = getPath(guildConfig, path);
        if (current && (guild.channels.cache.has(current) || guild.roles.cache.has(current))) return;
        update[path] = id;
      };
      const setValueIfUnset = (path, value) => {
        const current = getPath(guildConfig, path);
        if (current === undefined || current === null) update[path] = value;
      };

      for (const def of [...LOG_CHANNELS, ...COMMUNITY_CHANNELS, TICKET_PANEL_CHANNEL]) {
        for (const path of def.paths) setIdIfUnset(path, results.channels[def.key]?.id);
      }
      for (const path of TICKETS_CATEGORY.paths) setIdIfUnset(path, results.categories.tickets?.id);
      for (const def of SYSTEM_ROLES) {
        for (const path of def.paths) setIdIfUnset(path, results.roles[def.key]?.id);
      }

      for (const [path, value] of Object.entries({ ...AUTOMOD_DEFAULTS, ...FEATURE_TOGGLES })) {
        if (isFirstRun && value === true && path.endsWith('.enabled')) update[path] = true;
        else setValueIfUnset(path, value);
      }

      // Level rewards: add setup's roles for levels without a reward, keep everything else
      const newRewards = levelRoles.filter(({ role }) => !existingRewards.some(r => r.roleId === role.id));
      if (newRewards.length > 0) {
        update['features.levelSystem.rewards'] = [
          ...existingRewards.map(r => ({ level: r.level, roleId: r.roleId })),
          ...newRewards.map(({ level, role }) => ({ level, roleId: role.id }))
        ].sort((a, b) => a.level - b.level);
      }

      // Color roles: only the panel location and role mapping, never the customisation
      const colorMapping = colorRoles.map(({ colorData, role }) => ({ emoji: colorData.emoji, roleId: role.id, name: colorData.name }));
      const mappingIsStale = storedColorRoles.length === 0 || storedColorRoles.some(r => !guild.roles.cache.has(r.roleId));
      if (colorMessage) {
        update['settings.colorRoles.enabled'] = true;
        update['settings.colorRoles.channelId'] = results.channels.colorRoles.id;
        update['settings.colorRoles.messageId'] = colorMessage.id;
        update['settings.colorRoles.roles'] = colorMapping;
      } else {
        setIdIfUnset('settings.colorRoles.channelId', results.channels.colorRoles?.id);
        if (mappingIsStale && colorMapping.length > 0) update['settings.colorRoles.roles'] = colorMapping;
        if (isFirstRun && storedPanel) update['settings.colorRoles.enabled'] = true;
      }

      if (Object.keys(update).length > 0) {
        await Guild.updateGuild(guildId, { $set: update });
      }

      // ==================== PHASE 8: SUMMARY ====================
      const logCount = LOG_CHANNELS.filter(def => results.channels[def.key]).length;
      const levelRewardCount = rewardedLevels.size + levelRoles.length;
      const systems = [
        `${GLYPHS.ARROW_RIGHT} AutoMod & Security — ${isFirstRun ? 'enabled' : 'existing settings kept'}`,
        `${GLYPHS.ARROW_RIGHT} Leveling — ${plural(levelRewardCount, 'level reward')}`,
        `${GLYPHS.ARROW_RIGHT} Tickets — ${results.categories.tickets ? 'category ready' : 'no category'}, panel ${ticketPanelStatus}`,
        `${GLYPHS.ARROW_RIGHT} Color Roles — ${plural(colorRoles.length, 'color')}, panel ${colorPanelStatus}`,
        `${GLYPHS.ARROW_RIGHT} Logging — ${logCount}/${LOG_CHANNELS.length} log channels`,
        `${GLYPHS.ARROW_RIGHT} Muted Role — ${mutedRole
          ? `applied to ${plural(muteStats.applied, 'channel')}, ${muteStats.unchanged} already set, ${muteStats.skipped} not accessible`
          : 'not available'}`
      ];

      let summary =
        `**Created ${plural(created.length, 'item')}:**\n${created.length ? listLines(created, GLYPHS.ARROW_RIGHT) : 'Nothing new was needed.'}\n\n` +
        `**Systems:**\n${systems.join('\n')}\n\n`;
      if (failures.length > 0) {
        summary += `**Failed (${failures.length}):**\n${listLines(failures.map(f => f.slice(0, 150)), GLYPHS.ERROR)}\n\n`;
      }
      summary += `Use \`${prefix}help\` to see all available commands.`;

      const resultEmbed = failures.length > 0
        ? await warningEmbed(guildId, 'Setup Completed with Errors',
          `${GLYPHS.WARNING} Setup finished, but some steps failed, Master.\n\n${summary}`)
        : await successEmbed(guildId, 'Setup Complete',
          `${GLYPHS.SUCCESS} RAPHAEL has been set up, Master.\n\n${summary}`);

      await setupMsg.edit({ embeds: [resultEmbed] });

      // Announce activation in the mod log on the first setup only
      if (isFirstRun && results.channels.modLog) {
        try {
          const welcomeEmbed = await infoEmbed(guildId, 'RAPHAEL Activated',
            `**Notice:** Thank you for choosing RAPHAEL, Master.\n\n` +
            `${GLYPHS.SHIELD} Moderation and security features are now active.\n` +
            `${GLYPHS.RADAR} Monitoring for suspicious activity has begun.\n` +
            `${GLYPHS.ARROW_RIGHT} AutoMod is active.\n\n` +
            `Use \`${prefix}help\` to see all available commands.`
          );
          await results.channels.modLog.send({ embeds: [welcomeEmbed] });
        } catch (error) {
          console.error('Setup: could not post the activation notice:', error.message);
        }
      }

    } catch (error) {
      console.error('Setup error:', error);
      const errEmbed = await errorEmbed(guildId, 'Setup Failed',
        `${GLYPHS.ERROR} An error occurred during setup, Master.\n\n` +
        `**Error:** ${String(error.message).slice(0, 500)}\n\n` +
        `Please ensure I have the permissions listed above and try again.`
      );
      if (setupMsg) await setupMsg.edit({ embeds: [errEmbed] }).catch(() => message.reply({ embeds: [errEmbed] }));
      else await message.reply({ embeds: [errEmbed] });
    }
  }
};
