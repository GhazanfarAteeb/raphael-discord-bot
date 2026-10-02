import { EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import Guild from '../../models/Guild.js';
import { getPrefix, isServerAdmin, normalizeAntiNukeAction } from '../../utils/helpers.js';
import { successEmbed, errorEmbed, infoEmbed, GLYPHS } from '../../utils/embeds.js';

export default {
  name: 'antinuke',
  description: 'Configure anti-nuke protection to prevent server raiding/nuking',
  usage: '<enable|disable|config|whitelist|status> [options]',
  aliases: ['an', 'nuke'],
  permissions: [PermissionFlagsBits.ManageGuild],
  category: 'config',
  cooldown: 3,

  async execute(message, args, client) {
    const prefix = await getPrefix(message.guild.id);
    const guildConfig = await Guild.getGuild(message.guild.id, message.guild.name);

    // Owner/Administrator only: staff roles must not be able to disable anti-nuke or whitelist themselves
    if (!isServerAdmin(message.member)) {
      return message.reply({
        embeds: [await errorEmbed(message.guild.id, 'Permission Denied',
          'Anti-nuke can only be configured by the server owner or an Administrator, Master.')]
      });
    }

    // Use the same path as automod antinuke for consistency
    if (!guildConfig.features.autoMod.antiNuke) {
      guildConfig.features.autoMod.antiNuke = {
        enabled: false,
        banThreshold: 5,
        kickThreshold: 5,
        roleDeleteThreshold: 3,
        channelDeleteThreshold: 3,
        timeWindow: 60,
        action: 'removeRoles',
        whitelistedUsers: []
      };
    }

    const antiNuke = guildConfig.features.autoMod.antiNuke;
    const subCommand = args[0]?.toLowerCase();

    switch (subCommand) {
      case 'enable':
      case 'on':
        antiNuke.enabled = true;
        await Guild.updateGuild(message.guild.id, { $set: { 'features.autoMod.antiNuke': antiNuke } });

        return message.reply({
          embeds: [new EmbedBuilder()
            .setColor('#00FF00')
            .setTitle('✅ Anti-Nuke Enabled')
            .setDescription('Server protection is now active. The bot will monitor for suspicious mass actions.')
            .addFields(
              { name: 'Current Action', value: antiNuke.action, inline: true },
              { name: 'Time Window', value: `${antiNuke.timeWindow}s`, inline: true }
            )]
        });

      case 'disable':
      case 'off':
        antiNuke.enabled = false;
        await Guild.updateGuild(message.guild.id, { $set: { 'features.autoMod.antiNuke': antiNuke } });

        return message.reply({
          embeds: [new EmbedBuilder()
            .setColor('#FF9900')
            .setTitle('⚠️ Anti-Nuke Disabled')
            .setDescription('Server protection has been disabled.')]
        });

      case 'config':
        const setting = args[1]?.toLowerCase();
        const value = args[2];

        if (!setting) {
          return message.reply({
            embeds: [await infoEmbed(message.guild.id, 'Anti-Nuke Config',
              `**Available settings:**\n` +
              `${GLYPHS.DOT} \`${prefix}antinuke config action <removeRoles|kick|ban>\`\n` +
              `${GLYPHS.DOT} \`${prefix}antinuke config timewindow <5-60>\` (seconds)\n` +
              `${GLYPHS.DOT} \`${prefix}antinuke config ban <1-20>\`\n` +
              `${GLYPHS.DOT} \`${prefix}antinuke config kick <1-20>\`\n` +
              `${GLYPHS.DOT} \`${prefix}antinuke config roledelete <1-10>\`\n` +
              `${GLYPHS.DOT} \`${prefix}antinuke config channeldelete <1-10>\``
            )]
          });
        }

        if (setting === 'action') {
          if (!normalizeAntiNukeAction(value)) {
            return message.reply({
              embeds: [await errorEmbed(message.guild.id, 'Invalid Action',
                `${GLYPHS.ERROR} Action must be: \`removeRoles\`, \`kick\`, or \`ban\``)]
            });
          }
          antiNuke.action = normalizeAntiNukeAction(value);
          await Guild.updateGuild(message.guild.id, { $set: { 'features.autoMod.antiNuke': antiNuke } });

          return message.reply({
            embeds: [await successEmbed(message.guild.id, 'Action Updated',
              `${GLYPHS.SUCCESS} Anti-nuke action set to: **${value}**`)]
          });
        }

        if (setting === 'timewindow') {
          const seconds = parseInt(value);
          if (isNaN(seconds) || seconds < 5 || seconds > 60) {
            return message.reply({
              embeds: [await errorEmbed(message.guild.id, 'Invalid Time',
                `${GLYPHS.ERROR} Time window must be between 5 and 60 seconds.`)]
            });
          }

          antiNuke.timeWindow = seconds;
          await Guild.updateGuild(message.guild.id, { $set: { 'features.autoMod.antiNuke': antiNuke } });

          return message.reply({
            embeds: [await successEmbed(message.guild.id, 'Time Window Updated',
              `${GLYPHS.SUCCESS} Time window set to **${seconds} seconds**`)]
          });
        }

        if (setting === 'ban') {
          const threshold = parseInt(value);
          if (isNaN(threshold) || threshold < 1 || threshold > 20) {
            return message.reply({
              embeds: [await errorEmbed(message.guild.id, 'Invalid Threshold',
                `${GLYPHS.ERROR} Ban threshold must be between 1 and 20.`)]
            });
          }
          antiNuke.banThreshold = threshold;
          await Guild.updateGuild(message.guild.id, { $set: { 'features.autoMod.antiNuke': antiNuke } });
          return message.reply({
            embeds: [await successEmbed(message.guild.id, 'Ban Threshold Updated',
              `${GLYPHS.SUCCESS} Ban threshold set to **${threshold}** actions`)]
          });
        }

        if (setting === 'kick') {
          const threshold = parseInt(value);
          if (isNaN(threshold) || threshold < 1 || threshold > 20) {
            return message.reply({
              embeds: [await errorEmbed(message.guild.id, 'Invalid Threshold',
                `${GLYPHS.ERROR} Kick threshold must be between 1 and 20.`)]
            });
          }
          antiNuke.kickThreshold = threshold;
          await Guild.updateGuild(message.guild.id, { $set: { 'features.autoMod.antiNuke': antiNuke } });
          return message.reply({
            embeds: [await successEmbed(message.guild.id, 'Kick Threshold Updated',
              `${GLYPHS.SUCCESS} Kick threshold set to **${threshold}** actions`)]
          });
        }

        if (setting === 'roledelete') {
          const threshold = parseInt(value);
          if (isNaN(threshold) || threshold < 1 || threshold > 10) {
            return message.reply({
              embeds: [await errorEmbed(message.guild.id, 'Invalid Threshold',
                `${GLYPHS.ERROR} Role delete threshold must be between 1 and 10.`)]
            });
          }
          antiNuke.roleDeleteThreshold = threshold;
          await Guild.updateGuild(message.guild.id, { $set: { 'features.autoMod.antiNuke': antiNuke } });
          return message.reply({
            embeds: [await successEmbed(message.guild.id, 'Role Delete Threshold Updated',
              `${GLYPHS.SUCCESS} Role delete threshold set to **${threshold}** actions`)]
          });
        }

        if (setting === 'channeldelete') {
          const threshold = parseInt(value);
          if (isNaN(threshold) || threshold < 1 || threshold > 10) {
            return message.reply({
              embeds: [await errorEmbed(message.guild.id, 'Invalid Threshold',
                `${GLYPHS.ERROR} Channel delete threshold must be between 1 and 10.`)]
            });
          }
          antiNuke.channelDeleteThreshold = threshold;
          await Guild.updateGuild(message.guild.id, { $set: { 'features.autoMod.antiNuke': antiNuke } });
          return message.reply({
            embeds: [await successEmbed(message.guild.id, 'Channel Delete Threshold Updated',
              `${GLYPHS.SUCCESS} Channel delete threshold set to **${threshold}** actions`)]
          });
        }

        return message.reply({
          embeds: [await errorEmbed(message.guild.id, 'Invalid Setting',
            `${GLYPHS.ERROR} Unknown setting: \`${setting}\`\n\nUse \`${prefix}antinuke config\` to see available options.`)]
        });

      case 'whitelist':
        const whitelistAction = args[1]?.toLowerCase();
        const user = message.mentions.users.first() || await client.users.fetch(args[2]).catch(() => null);

        if (!whitelistAction || !['add', 'remove', 'list'].includes(whitelistAction)) {
          return message.reply({
            embeds: [await infoEmbed(message.guild.id, 'Whitelist Commands',
              `**Usage:**\n` +
              `${GLYPHS.DOT} \`${prefix}antinuke whitelist add @user\` - Add user to whitelist\n` +
              `${GLYPHS.DOT} \`${prefix}antinuke whitelist remove @user\` - Remove user from whitelist\n` +
              `${GLYPHS.DOT} \`${prefix}antinuke whitelist list\` - View whitelisted users`)]
          });
        }

        if (whitelistAction === 'list') {
          if (!antiNuke.whitelistedUsers || antiNuke.whitelistedUsers.length === 0) {
            return message.reply({
              embeds: [await infoEmbed(message.guild.id, 'Whitelist Empty',
                `${GLYPHS.INFO} No users are whitelisted from anti-nuke.`)]
            });
          }

          const users = await Promise.all(
            antiNuke.whitelistedUsers.map(id => client.users.fetch(id).catch(() => null))
          );
          const userList = users.filter(u => u).map(u => `${GLYPHS.DOT} ${u.tag} (${u.id})`).join('\n');

          return message.reply({
            embeds: [new EmbedBuilder()
              .setColor('#5865F2')
              .setTitle('🛡️ Anti-Nuke Whitelist')
              .setDescription(userList || 'No valid users found')]
          });
        }

        if (!user) {
          return message.reply({
            embeds: [await errorEmbed(message.guild.id, 'User Not Found',
              `${GLYPHS.ERROR} Please mention a user or provide their ID.`)]
          });
        }

        if (!antiNuke.whitelistedUsers) {
          antiNuke.whitelistedUsers = [];
        }

        if (whitelistAction === 'add') {
          if (antiNuke.whitelistedUsers.includes(user.id)) {
            return message.reply({
              embeds: [await errorEmbed(message.guild.id, 'Already Whitelisted',
                `${GLYPHS.ERROR} ${user.tag} is already whitelisted.`)]
            });
          }

          antiNuke.whitelistedUsers.push(user.id);
          await Guild.updateGuild(message.guild.id, { $set: { 'features.autoMod.antiNuke': antiNuke } });

          return message.reply({
            embeds: [await successEmbed(message.guild.id, 'User Whitelisted',
              `${GLYPHS.SUCCESS} Added **${user.tag}** to anti-nuke whitelist.`)]
          });
        }

        if (whitelistAction === 'remove') {
          const index = antiNuke.whitelistedUsers.indexOf(user.id);
          if (index === -1) {
            return message.reply({
              embeds: [await errorEmbed(message.guild.id, 'Not Whitelisted',
                `${GLYPHS.ERROR} ${user.tag} is not whitelisted.`)]
            });
          }

          antiNuke.whitelistedUsers.splice(index, 1);
          await Guild.updateGuild(message.guild.id, { $set: { 'features.autoMod.antiNuke': antiNuke } });

          return message.reply({
            embeds: [await successEmbed(message.guild.id, 'User Removed',
              `${GLYPHS.SUCCESS} Removed **${user.tag}** from anti-nuke whitelist.`)]
          });
        }
        break;

      case 'status':
      default:
        const whitelistCount = antiNuke.whitelistedUsers?.length || 0;
        let whitelistUsers = 'None';

        if (whitelistCount > 0) {
          const users = await Promise.all(
            antiNuke.whitelistedUsers.slice(0, 5).map(id => client.users.fetch(id).catch(() => null))
          );
          whitelistUsers = users.filter(u => u).map(u => u.tag).join(', ');
          if (whitelistCount > 5) {
            whitelistUsers += ` +${whitelistCount - 5} more`;
          }
        }

        return message.reply({
          embeds: [new EmbedBuilder()
            .setColor(antiNuke.enabled ? '#00FF00' : '#FF0000')
            .setTitle('🛡️ Anti-Nuke Configuration')
            .addFields(
              { name: 'Status', value: antiNuke.enabled ? '✅ Enabled' : '❌ Disabled', inline: true },
              { name: 'Action', value: antiNuke.action || 'removeRoles', inline: true },
              { name: 'Time Window', value: `${antiNuke.timeWindow || 60}s`, inline: true },
              { name: 'Ban Threshold', value: `${antiNuke.banThreshold || 5}`, inline: true },
              { name: 'Kick Threshold', value: `${antiNuke.kickThreshold || 5}`, inline: true },
              { name: 'Role Delete Threshold', value: `${antiNuke.roleDeleteThreshold || 3}`, inline: true },
              { name: 'Channel Delete Threshold', value: `${antiNuke.channelDeleteThreshold || 3}`, inline: true },
              { name: `Whitelisted Users (${whitelistCount})`, value: whitelistUsers, inline: false }
            )
            .setFooter({ text: `Use ${prefix}antinuke enable/disable to toggle protection` })]
        });
    }
  }
};
