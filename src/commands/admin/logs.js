import logger from '../../utils/logger.js';
import { EmbedBuilder } from 'discord.js';
import { readdir, stat } from 'fs/promises';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import Guild from '../../models/Guild.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export default {
  name: 'botlogs',
  description: 'View bot logs and statistics',
  usage: 'botlogs [stats|clean|types]',
  aliases: ['blogs', 'systemlogs'],
  category: 'admin',
  ownerOnly: true, // bot-wide: reads and changes the bot's own logs
  permissions: [], // Custom permission check below
  execute: async (message, args) => {
    // Check for Administrator OR admin/staff/moderator roles
    const hasAdmin = message.member.permissions.has('Administrator');

    if (!hasAdmin) {
      const guildConfig = await Guild.getGuild(message.guild.id);
      const memberRoles = message.member.roles.cache.map(r => r.id);
      const adminRoles = guildConfig?.roles?.adminRoles || [];
      const staffRoles = guildConfig?.roles?.staffRoles || [];
      const modRoles = guildConfig?.roles?.moderatorRoles || [];

      const hasAdminRole = adminRoles.some(roleId => memberRoles.includes(roleId));
      const hasStaffRole = staffRoles.some(roleId => memberRoles.includes(roleId));
      const hasModRole = modRoles.some(roleId => memberRoles.includes(roleId));

      if (!hasAdminRole && !hasStaffRole && !hasModRole) {
        return message.reply('**Warning:** Administrator permission or admin/staff/moderator role required, Master.');
      }
    }
    const action = args[0]?.toLowerCase() || 'stats';

    try {
      switch (action) {
        case 'stats':
          const stats = logger.getStats();

          if (!stats) {
            return message.reply('**Error:** Could not retrieve log statistics, Master.');
          }

          const embed = new EmbedBuilder()
            .setTitle('『 Log Statistics 』')
            .setColor('#00CED1')
            .addFields(
              { name: '▸ Total Files', value: stats.totalFiles.toString(), inline: true },
              { name: '▸ Total Size', value: stats.totalSize, inline: true },
              { name: '\u200B', value: '\u200B', inline: true }
            )
            .setTimestamp();

          // Add log types
          for (const [type, data] of Object.entries(stats.filesByType)) {
            const sizeMB = (data.size / (1024 * 1024)).toFixed(2);
            embed.addFields({
              name: `${type.charAt(0).toUpperCase() + type.slice(1)} Logs`,
              value: `${data.count} file(s) • ${sizeMB} MB`,
              inline: true
            });
          }

          await message.reply({ embeds: [embed] });
          break;

        case 'clean':
          const days = parseInt(args[1]) || 30;

          if (days < 7) {
            return message.reply('**Warning:** Cannot purge logs newer than 7 days for safety, Master.');
          }

          logger.cleanOldLogs(days);
          logger.deployment(`Logs cleaned: older than ${days} days`, {
            cleanedBy: `${message.author.tag} (${message.author.id})`,
            daysKept: days
          });

          await message.reply(`**Confirmed:** Logs older than ${days} days have been purged, Master.`);
          break;

        case 'types':
          const logTypes = [
            '**app** - General application logs',
            '**error** - Error logs only',
            '**command** - Command execution logs',
            '**event** - Discord event logs',
            '**database** - Database operation logs',
            '**performance** - Performance metrics',
            '**deployment** - Deployment & build logs',
            '**startup** - Bot startup logs',
            '**debug** - Debug logs (dev only)',
            '**build** - Build information logs'
          ];

          const typesEmbed = new EmbedBuilder()
            .setTitle('📋 Log Types')
            .setDescription(logTypes.join('\n'))
            .setColor('#2ecc71')
            .setFooter({ text: 'All logs are stored in the logs/ directory' })
            .setTimestamp();

          await message.reply({ embeds: [typesEmbed] });
          break;

        case 'recent':
          const logType = args[1] || 'app';
          const logsDir = join(__dirname, '../../logs');
          const today = new Date().toISOString().split('T')[0];
          const filename = `${logType}-${today}.log`;

          try {
            const { readFile } = await import('fs/promises');
            const logPath = join(logsDir, filename);
            const content = await readFile(logPath, 'utf8');
            const lines = content.split('\n').filter(line => line.trim());
            const recentLines = lines.slice(-20); // Last 20 lines

            if (recentLines.length === 0) {
              return message.reply(`No recent logs found for type: ${logType}`);
            }

            // Truncate if too long
            let logContent = recentLines.join('\n');
            if (logContent.length > 1900) {
              logContent = logContent.slice(-1900);
            }

            const recentEmbed = new EmbedBuilder()
              .setTitle(`📄 Recent ${logType} Logs`)
              .setDescription(`\`\`\`\n${logContent}\n\`\`\``)
              .setColor('#f39c12')
              .setFooter({ text: `Showing last ${recentLines.length} lines from ${filename}` })
              .setTimestamp();

            await message.reply({ embeds: [recentEmbed] });
          } catch (error) {
            if (error.code === 'ENOENT') {
              await message.reply(`**Notice:** No log file found for today: ${filename}, Master.`);
            } else {
              logger.error('Error reading recent logs', error);
              await message.reply('**Error:** Failed to read log file, Master.');
            }
          }
          break;

        default:
          await message.reply('**Usage:** `logs [stats|clean <days>|types|recent <type>]`');
      }
    } catch (error) {
      logger.error('Logs command error', error);
      await message.reply('**Error:** An error occurred while processing the logs command, Master.');
    }
  }
};
