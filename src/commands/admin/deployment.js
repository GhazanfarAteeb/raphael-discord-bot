import logger from '../../utils/logger.js';
import { readFileSync } from 'fs';
import { PermissionFlagsBits } from 'discord.js';
import Guild from '../../models/Guild.js';
import { successEmbed, errorEmbed, warningEmbed, infoEmbed, GLYPHS } from '../../utils/embeds.js';
import { getPrefix, hasAdminPerms } from '../../utils/helpers.js';

const ACTIONS = ['start', 'complete', 'rollback', 'status'];

// Version recorded in deployment logs, read once from package.json
const BOT_VERSION = (() => {
  try {
    return JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')).version || 'unknown';
  } catch {
    return 'unknown';
  }
})();

export default {
  name: 'deployment',
  description: 'Log deployment and build information',
  usage: 'deployment <start|complete [version]|rollback [version] [reason]|status>',
  category: 'admin',
  ownerOnly: true, // bot-wide: reads and changes the bot's own logs
  permissions: [PermissionFlagsBits.Administrator],
  execute: async (message, args) => {
    const guildId = message.guild.id;

    try {
      const guildConfig = await Guild.getGuild(guildId);
      if (!hasAdminPerms(message.member, guildConfig)) {
        return message.reply({
          embeds: [await errorEmbed(guildId, 'Permission Denied', 'Administrator permission or a configured admin role is required, Master.')]
        });
      }

      const action = args[0]?.toLowerCase();
      if (!ACTIONS.includes(action)) {
        const prefix = await getPrefix(guildId);
        return message.reply({
          embeds: [await errorEmbed(guildId, 'Invalid Usage',
            `${GLYPHS.ARROW_RIGHT} Usage: \`${prefix}deployment <start|complete [version]|rollback [version] [reason]|status>\``)]
        });
      }

      const actor = `${message.author.tag} (${message.author.id})`;
      const guildLabel = `${message.guild.name} (${message.guild.id})`;

      switch (action) {
        case 'start': {
          logger.deployment('Deployment started', {
            initiatedBy: actor,
            guild: guildLabel,
            timestamp: new Date().toISOString(),
            version: BOT_VERSION
          });
          return message.reply({
            embeds: [await successEmbed(guildId, 'Deployment Started',
              `Deployment of v${BOT_VERSION} has been logged, Master. Details are in the deployment log.`)]
          });
        }

        case 'complete': {
          const version = args[1] || BOT_VERSION;
          logger.deployment('Deployment completed successfully', {
            version,
            completedBy: actor,
            guild: guildLabel,
            timestamp: new Date().toISOString(),
            status: 'success'
          });
          return message.reply({
            embeds: [await successEmbed(guildId, 'Deployment Complete', `Deployment of v${version.slice(0, 100)} has been logged as complete, Master.`)]
          });
        }

        case 'rollback': {
          const previousVersion = args[1] || 'previous';
          const reason = args.slice(2).join(' ') || 'No reason provided';
          logger.deployment('Deployment rollback initiated', {
            rollbackTo: previousVersion,
            initiatedBy: actor,
            guild: guildLabel,
            timestamp: new Date().toISOString(),
            reason
          });
          return message.reply({
            embeds: [await warningEmbed(guildId, 'Rollback Logged',
              `Rollback to **${previousVersion.slice(0, 100)}** has been logged, Master.`)]
          });
        }

        case 'status': {
          const stats = logger.getStats();
          if (!stats) {
            return message.reply({ embeds: [await errorEmbed(guildId, 'Log Statistics', 'I could not read the log directory, Master.')] });
          }

          const embed = await infoEmbed(guildId, 'Deployment & Build Logs',
            `Current version: **v${BOT_VERSION}**`);
          embed.addFields(
            { name: `${GLYPHS.ARROW_RIGHT} Total Log Files`, value: String(stats.totalFiles), inline: true },
            { name: `${GLYPHS.ARROW_RIGHT} Total Size`, value: stats.totalSize, inline: true }
          );

          const byType = Object.entries(stats.filesByType)
            .map(([type, data]) => `${GLYPHS.DOT} ${type}: ${data.count} file(s), ${(data.size / (1024 * 1024)).toFixed(2)} MB`)
            .join('\n');
          if (byType) embed.addFields({ name: `${GLYPHS.ARROW_RIGHT} Logs by Type`, value: byType.slice(0, 1024) });

          return message.reply({ embeds: [embed] });
        }
      }
      return null;
    } catch (error) {
      logger.error('Deployment command error', error);
      const embed = await errorEmbed(guildId, 'Deployment Log Failed',
        'An anomaly occurred while processing the deployment command, Master.').catch(() => null);
      return message.reply(embed ? { embeds: [embed] } : { content: '**Alert:** The deployment command failed, Master.' }).catch(() => null);
    }
  }
};
