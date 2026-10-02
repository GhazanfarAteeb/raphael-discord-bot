import { PermissionFlagsBits } from 'discord.js';
import Guild from '../../models/Guild.js';
import { getPrefix, isServerAdmin, normalizeAntiNukeAction } from '../../utils/helpers.js';
import { successEmbed, errorEmbed, warningEmbed, infoEmbed, GLYPHS } from '../../utils/embeds.js';

const PATH = 'features.autoMod.antiNuke';

// Schema defaults, used for display when a guild has no stored anti-nuke settings
const DEFAULTS = {
  enabled: false,
  banThreshold: 5,
  kickThreshold: 5,
  roleDeleteThreshold: 3,
  channelDeleteThreshold: 3,
  timeWindow: 60,
  action: 'removeRoles',
  whitelistedUsers: []
};

// `antinuke config <setting> <value>` thresholds: config key, label and allowed range
const THRESHOLDS = {
  ban: { key: 'banThreshold', label: 'Ban threshold', min: 1, max: 20 },
  kick: { key: 'kickThreshold', label: 'Kick threshold', min: 1, max: 20 },
  roledelete: { key: 'roleDeleteThreshold', label: 'Role delete threshold', min: 1, max: 10 },
  channeldelete: { key: 'channelDeleteThreshold', label: 'Channel delete threshold', min: 1, max: 10 }
};

const USER_ID = /^(?:<@!?)?(\d{17,20})>?$/;

// Update for `changes`: dotted paths when the guild already stores anti-nuke settings, otherwise
// the whole object with defaults, so the anti-nuke event never reads missing thresholds
function antiNukeUpdate(stored, antiNuke, changes) {
  if (!stored) return { $set: { [PATH]: { ...antiNuke, ...changes } } };
  return { $set: Object.fromEntries(Object.entries(changes).map(([key, value]) => [`${PATH}.${key}`, value])) };
}

export default {
  name: 'antinuke',
  description: 'Configure anti-nuke protection to prevent server raiding/nuking',
  usage: '<enable|disable|config|whitelist|status> [options]',
  aliases: ['an', 'nuke'],
  permissions: [PermissionFlagsBits.ManageGuild],
  category: 'config',
  cooldown: 3,

  async execute(message, args, client) {
    const guildId = message.guild.id;

    try {
      // Owner/Administrator only: staff roles must not be able to disable anti-nuke or whitelist themselves
      if (!isServerAdmin(message.member)) {
        return message.reply({
          embeds: [await errorEmbed(guildId, 'Permission Denied',
            'Anti-nuke can only be configured by the server owner or an Administrator, Master.')]
        });
      }

      const prefix = await getPrefix(guildId);
      const guildConfig = await Guild.getGuild(guildId, message.guild.name);
      const stored = guildConfig.features?.autoMod?.antiNuke;
      const antiNuke = { ...DEFAULTS, ...(stored || {}) };
      const save = changes => Guild.updateGuild(guildId, antiNukeUpdate(stored, antiNuke, changes));
      const subCommand = args[0]?.toLowerCase();

      switch (subCommand) {
        case 'enable':
        case 'on': {
          await save({ enabled: true });
          const embed = await successEmbed(guildId, 'Anti-Nuke Enabled',
            `${GLYPHS.SUCCESS} Server protection is now active. I will monitor for suspicious mass actions, Master.`);
          embed.addFields(
            { name: `${GLYPHS.ARROW_RIGHT} Action`, value: antiNuke.action, inline: true },
            { name: `${GLYPHS.ARROW_RIGHT} Time Window`, value: `${antiNuke.timeWindow}s`, inline: true }
          );
          return message.reply({ embeds: [embed] });
        }

        case 'disable':
        case 'off':
          await save({ enabled: false });
          return message.reply({
            embeds: [await warningEmbed(guildId, 'Anti-Nuke Disabled',
              `${GLYPHS.WARNING} Server protection has been disabled. Mass bans, kicks and deletions will no longer be stopped.`)]
          });

        case 'config':
          return configure(message, args.slice(1), prefix, save);

        case 'whitelist':
          return manageWhitelist(message, args.slice(1), { stored, antiNuke, save }, prefix, client);

        case 'status':
        default:
          return showStatus(message, antiNuke, prefix, client);
      }
    } catch (error) {
      console.error('[AntiNuke] Error:', error);
      return message.reply({
        embeds: [await errorEmbed(guildId, 'Configuration Error',
          'The anti-nuke settings could not be updated, Master. Please try again.')]
      }).catch(() => null);
    }
  }
};

async function configure(message, args, prefix, save) {
  const guildId = message.guild.id;
  const setting = args[0]?.toLowerCase();
  const value = args[1];

  if (!setting) {
    return message.reply({
      embeds: [await infoEmbed(guildId, 'Anti-Nuke Config',
        `**Available settings:**\n` +
        `${GLYPHS.DOT} \`${prefix}antinuke config action <removeRoles|kick|ban>\`\n` +
        `${GLYPHS.DOT} \`${prefix}antinuke config timewindow <5-60>\` (seconds)\n` +
        `${GLYPHS.DOT} \`${prefix}antinuke config ban <1-20>\`\n` +
        `${GLYPHS.DOT} \`${prefix}antinuke config kick <1-20>\`\n` +
        `${GLYPHS.DOT} \`${prefix}antinuke config roledelete <1-10>\`\n` +
        `${GLYPHS.DOT} \`${prefix}antinuke config channeldelete <1-10>\``)]
    });
  }

  if (setting === 'action') {
    const action = normalizeAntiNukeAction(value);
    if (!action) {
      return message.reply({
        embeds: [await errorEmbed(guildId, 'Invalid Action',
          `${GLYPHS.ERROR} Action must be: \`removeRoles\`, \`kick\`, or \`ban\``)]
      });
    }
    await save({ action });
    return message.reply({
      embeds: [await successEmbed(guildId, 'Action Updated',
        `${GLYPHS.SUCCESS} Anti-nuke action set to: **${action}**`)]
    });
  }

  if (setting === 'timewindow') {
    const seconds = parseInt(value);
    if (isNaN(seconds) || seconds < 5 || seconds > 60) {
      return message.reply({
        embeds: [await errorEmbed(guildId, 'Invalid Time',
          `${GLYPHS.ERROR} Time window must be between 5 and 60 seconds.`)]
      });
    }
    await save({ timeWindow: seconds });
    return message.reply({
      embeds: [await successEmbed(guildId, 'Time Window Updated',
        `${GLYPHS.SUCCESS} Time window set to **${seconds} seconds**`)]
    });
  }

  const threshold = THRESHOLDS[setting];
  if (threshold) {
    const amount = parseInt(value);
    if (isNaN(amount) || amount < threshold.min || amount > threshold.max) {
      return message.reply({
        embeds: [await errorEmbed(guildId, 'Invalid Threshold',
          `${GLYPHS.ERROR} ${threshold.label} must be between ${threshold.min} and ${threshold.max}.`)]
      });
    }
    await save({ [threshold.key]: amount });
    return message.reply({
      embeds: [await successEmbed(guildId, `${threshold.label.replace(/^./, c => c.toUpperCase())} Updated`,
        `${GLYPHS.SUCCESS} ${threshold.label} set to **${amount}** actions`)]
    });
  }

  return message.reply({
    embeds: [await errorEmbed(guildId, 'Invalid Setting',
      `${GLYPHS.ERROR} Unknown setting: \`${setting}\`\n\nUse \`${prefix}antinuke config\` to see available options.`)]
  });
}

async function manageWhitelist(message, args, { stored, antiNuke, save }, prefix, client) {
  const guildId = message.guild.id;
  const action = args[0]?.toLowerCase();
  const whitelisted = antiNuke.whitelistedUsers || [];

  if (!['add', 'remove', 'list'].includes(action)) {
    return message.reply({
      embeds: [await infoEmbed(guildId, 'Whitelist Commands',
        `**Usage:**\n` +
        `${GLYPHS.DOT} \`${prefix}antinuke whitelist add @user\` - Add user to whitelist\n` +
        `${GLYPHS.DOT} \`${prefix}antinuke whitelist remove @user\` - Remove user from whitelist\n` +
        `${GLYPHS.DOT} \`${prefix}antinuke whitelist list\` - View whitelisted users`)]
    });
  }

  if (action === 'list') {
    if (whitelisted.length === 0) {
      return message.reply({
        embeds: [await infoEmbed(guildId, 'Whitelist Empty',
          `${GLYPHS.INFO} No users are whitelisted from anti-nuke.`)]
      });
    }

    const users = await Promise.all(whitelisted.map(id => client.users.fetch(id).catch(() => null)));
    const userList = whitelisted
      .map((id, i) => `${GLYPHS.DOT} ${users[i] ? `${users[i].tag} (${id})` : `Unknown user (${id})`}`)
      .join('\n');

    return message.reply({
      embeds: [await infoEmbed(guildId, 'Anti-Nuke Whitelist', userList.slice(0, 4000))]
    });
  }

  // Only fetch when the argument is a mention or ID: anything else is not a user
  const userId = message.mentions.users.first()?.id || args[1]?.match(USER_ID)?.[1];
  const user = userId ? await client.users.fetch(userId).catch(() => null) : null;

  if (!user) {
    return message.reply({
      embeds: [await errorEmbed(guildId, 'User Not Found',
        `${GLYPHS.ERROR} Please mention a user or provide their ID.`)]
    });
  }

  if (action === 'add') {
    if (whitelisted.includes(user.id)) {
      return message.reply({
        embeds: [await infoEmbed(guildId, 'Already Whitelisted',
          `${GLYPHS.INFO} ${user.tag} is already whitelisted.`)]
      });
    }

    if (stored) {
      await Guild.updateGuild(guildId, { $addToSet: { [`${PATH}.whitelistedUsers`]: user.id } });
    } else {
      await save({ whitelistedUsers: [...whitelisted, user.id] });
    }
    return message.reply({
      embeds: [await successEmbed(guildId, 'User Whitelisted',
        `${GLYPHS.SUCCESS} Added **${user.tag}** to the anti-nuke whitelist.`)]
    });
  }

  // action === 'remove'
  if (!whitelisted.includes(user.id)) {
    return message.reply({
      embeds: [await errorEmbed(guildId, 'Not Whitelisted',
        `${GLYPHS.ERROR} ${user.tag} is not whitelisted.`)]
    });
  }

  await Guild.updateGuild(guildId, { $pull: { [`${PATH}.whitelistedUsers`]: user.id } });
  return message.reply({
    embeds: [await successEmbed(guildId, 'User Removed',
      `${GLYPHS.SUCCESS} Removed **${user.tag}** from the anti-nuke whitelist.`)]
  });
}

async function showStatus(message, antiNuke, prefix, client) {
  const whitelisted = antiNuke.whitelistedUsers || [];
  let whitelistUsers = 'None';

  if (whitelisted.length > 0) {
    const users = await Promise.all(
      whitelisted.slice(0, 5).map(id => client.users.fetch(id).catch(() => null))
    );
    whitelistUsers = users.map((u, i) => u?.tag || whitelisted[i]).join(', ');
    if (whitelisted.length > 5) {
      whitelistUsers += ` +${whitelisted.length - 5} more`;
    }
  }

  const embed = await infoEmbed(message.guild.id, 'Anti-Nuke Configuration',
    antiNuke.enabled
      ? `${GLYPHS.SUCCESS} Protection is **active**.`
      : `${GLYPHS.WARNING} Protection is **inactive**. Enable it with \`${prefix}antinuke enable\`.`);

  embed.addFields(
    { name: `${GLYPHS.ARROW_RIGHT} Action`, value: antiNuke.action, inline: true },
    { name: `${GLYPHS.ARROW_RIGHT} Time Window`, value: `${antiNuke.timeWindow}s`, inline: true },
    { name: `${GLYPHS.ARROW_RIGHT} Ban Threshold`, value: `${antiNuke.banThreshold}`, inline: true },
    { name: `${GLYPHS.ARROW_RIGHT} Kick Threshold`, value: `${antiNuke.kickThreshold}`, inline: true },
    { name: `${GLYPHS.ARROW_RIGHT} Role Delete Threshold`, value: `${antiNuke.roleDeleteThreshold}`, inline: true },
    { name: `${GLYPHS.ARROW_RIGHT} Channel Delete Threshold`, value: `${antiNuke.channelDeleteThreshold}`, inline: true },
    { name: `${GLYPHS.ARROW_RIGHT} Whitelisted Users (${whitelisted.length})`, value: whitelistUsers.slice(0, 1024) },
    {
      name: `${GLYPHS.ARROW_RIGHT} Commands`,
      value:
        `\`${prefix}antinuke enable|disable\` - Toggle protection\n` +
        `\`${prefix}antinuke config\` - Thresholds and action\n` +
        `\`${prefix}antinuke whitelist\` - Trusted users`
    }
  );

  return message.reply({ embeds: [embed] });
}
