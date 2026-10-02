import logger from '../../utils/logger.js';
import { EmbedBuilder } from 'discord.js';
import { readdir, readFile } from 'fs/promises';
import { join } from 'path';
import Guild from '../../models/Guild.js';
import { errorEmbed, successEmbed, warningEmbed, COLORS, GLYPHS } from '../../utils/embeds.js';
import { getPrefix } from '../../utils/helpers.js';
import { getRandomFooter } from '../../utils/raphael.js';

// File name prefixes the logger writes (`<type>-YYYY-MM-DD.log`), with what each holds
const LOG_TYPES = {
  app: 'General application logs',
  error: 'Error logs only',
  commands: 'Command execution logs',
  events: 'Discord event logs',
  database: 'Database operation logs',
  performance: 'Performance metrics',
  deployment: 'Deployment and build logs',
  startup: 'Bot startup logs',
  debug: 'Debug logs (development only)',
  build: 'Build information logs'
};
const LOG_TYPE_ALIASES = { command: 'commands', event: 'events' };
const MIN_KEEP_DAYS = 7;
const DEFAULT_KEEP_DAYS = 30;
const RECENT_LINES = 20;
const RECENT_MAX_CHARS = 1900;

export default {
  name: 'botlogs',
  description: 'View bot logs and statistics',
  usage: 'botlogs [stats|clean <days>|types|recent <type>]',
  aliases: ['blogs', 'systemlogs'],
  category: 'admin',
  ownerOnly: true, // bot-wide: reads and changes the bot's own logs
  permissions: [], // Custom permission check below
  execute: async (message, args) => {
    const guildId = message.guild.id;

    try {
      // Administrator OR admin/staff/moderator roles
      if (!message.member.permissions.has('Administrator')) {
        const guildConfig = await Guild.getGuild(guildId);
        const roles = [
          ...(guildConfig?.roles?.adminRoles || []),
          ...(guildConfig?.roles?.staffRoles || []),
          ...(guildConfig?.roles?.moderatorRoles || [])
        ];
        if (!roles.some(roleId => message.member.roles.cache.has(roleId))) {
          return message.reply({
            embeds: [await errorEmbed(guildId, 'Permission Denied',
              'Administrator permission or an admin, staff or moderator role is required, Master.')]
          });
        }
      }

      const action = args[0]?.toLowerCase() || 'stats';

      switch (action) {
        case 'stats': {
          const stats = logger.getStats();
          if (!stats) {
            return message.reply({ embeds: [await errorEmbed(guildId, 'Log Statistics', 'I could not read the log directory, Master.')] });
          }

          const embed = new EmbedBuilder()
            .setTitle('『 Log Statistics 』')
            .setColor(COLORS.RAPHAEL)
            .addFields(
              { name: `${GLYPHS.ARROW_RIGHT} Total Files`, value: stats.totalFiles.toString(), inline: true },
              { name: `${GLYPHS.ARROW_RIGHT} Total Size`, value: stats.totalSize, inline: true },
              { name: '​', value: '​', inline: true }
            )
            .setFooter({ text: getRandomFooter() })
            .setTimestamp();

          // Discord allows 25 fields; three are used above
          for (const [type, data] of Object.entries(stats.filesByType).slice(0, 22)) {
            const sizeMB = (data.size / (1024 * 1024)).toFixed(2);
            embed.addFields({
              name: `${GLYPHS.DOT} ${type.charAt(0).toUpperCase() + type.slice(1)} Logs`,
              value: `${data.count} file(s) • ${sizeMB} MB`,
              inline: true
            });
          }

          return message.reply({ embeds: [embed] });
        }

        case 'clean': {
          const days = args[1] === undefined ? DEFAULT_KEEP_DAYS : Number(args[1]);
          if (!Number.isInteger(days)) {
            return message.reply({
              embeds: [await errorEmbed(guildId, 'Invalid Usage', 'Specify the number of days of logs to keep, Master.')]
            });
          }
          if (days < MIN_KEEP_DAYS) {
            return message.reply({
              embeds: [await errorEmbed(guildId, 'Retention Too Short',
                `Logs newer than ${MIN_KEEP_DAYS} days cannot be purged, Master.`)]
            });
          }

          // cleanOldLogs reports nothing, so compare the directory before and after
          const before = new Set(await readdir(logger.logsDir));
          logger.cleanOldLogs(days);
          const after = new Set(await readdir(logger.logsDir));
          const removed = [...before].filter(file => !after.has(file)).length;

          logger.deployment(`Logs cleaned: older than ${days} days`, {
            cleanedBy: `${message.author.tag} (${message.author.id})`,
            daysKept: days,
            filesRemoved: removed
          });

          const embed = removed > 0
            ? await successEmbed(guildId, 'Logs Purged',
              `Removed **${removed}** log file${removed === 1 ? '' : 's'} older than ${days} days, Master.`)
            : await warningEmbed(guildId, 'Nothing to Purge',
              `No log files are older than ${days} days, Master. Nothing was removed.`);
          return message.reply({ embeds: [embed] });
        }

        case 'types': {
          const embed = new EmbedBuilder()
            .setTitle('『 Log Types 』')
            .setDescription(Object.entries(LOG_TYPES).map(([type, summary]) => `${GLYPHS.ARROW_RIGHT} **${type}** — ${summary}`).join('\n'))
            .setColor(COLORS.RAPHAEL)
            .setFooter({ text: 'All logs are stored in the logs/ directory' })
            .setTimestamp();

          return message.reply({ embeds: [embed] });
        }

        case 'recent': {
          const requested = (args[1] || 'app').toLowerCase();
          const logType = LOG_TYPE_ALIASES[requested] || requested;
          // Only known types reach the file path
          if (!Object.hasOwn(LOG_TYPES, logType)) {
            return message.reply({
              embeds: [await errorEmbed(guildId, 'Unknown Log Type',
                `Valid types: ${Object.keys(LOG_TYPES).map(t => `\`${t}\``).join(', ')}, Master.`)]
            });
          }

          const today = new Date().toISOString().split('T')[0];
          const filename = `${logType}-${today}.log`;

          let content;
          try {
            content = await readFile(join(logger.logsDir, filename), 'utf8');
          } catch (error) {
            if (error.code !== 'ENOENT') throw error;
            return message.reply({
              embeds: [await warningEmbed(guildId, 'No Log File', `No **${logType}** log has been written today (\`${filename}\`), Master.`)]
            });
          }

          const recentLines = content.split('\n').filter(line => line.trim()).slice(-RECENT_LINES);
          if (recentLines.length === 0) {
            return message.reply({
              embeds: [await warningEmbed(guildId, 'No Log Entries', `The **${logType}** log for today is empty, Master.`)]
            });
          }

          // Keep the newest text, and stop log content from closing the code block early
          let logContent = recentLines.join('\n').replace(/```/g, "'''");
          if (logContent.length > RECENT_MAX_CHARS) logContent = logContent.slice(-RECENT_MAX_CHARS);

          const embed = new EmbedBuilder()
            .setTitle(`『 Recent ${logType.charAt(0).toUpperCase() + logType.slice(1)} Logs 』`)
            .setDescription(`\`\`\`\n${logContent}\n\`\`\``)
            .setColor(COLORS.RAPHAEL)
            .setFooter({ text: `Showing the last ${recentLines.length} lines of ${filename}` })
            .setTimestamp();

          return message.reply({ embeds: [embed] });
        }

        default: {
          const prefix = await getPrefix(guildId);
          return message.reply({
            embeds: [await errorEmbed(guildId, 'Invalid Usage',
              `${GLYPHS.ARROW_RIGHT} Usage: \`${prefix}botlogs [stats|clean <days>|types|recent <type>]\``)]
          });
        }
      }
    } catch (error) {
      logger.error('Logs command error', error);
      const embed = await errorEmbed(guildId, 'Log Access Failed',
        'An anomaly occurred while processing the log request, Master. The incident has been logged.').catch(() => null);
      return message.reply(embed ? { embeds: [embed] } : { content: '**Alert:** The log request failed, Master.' }).catch(() => null);
    }
  }
};
