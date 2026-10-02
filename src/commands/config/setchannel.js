import { PermissionFlagsBits, ChannelType } from 'discord.js';
import Guild from '../../models/Guild.js';
import { successEmbed, errorEmbed, GLYPHS } from '../../utils/embeds.js';
import { getPrefix, hasAdminPerms } from '../../utils/helpers.js';

// Each type and its aliases, with the config paths the channel is stored under
const CHANNEL_TYPES = [
  { names: ['modlog', 'mod'], label: 'Moderation Log', paths: ['channels.modLog'] },
  {
    names: ['alert', 'alerts', 'security'],
    label: 'Alert Log',
    paths: ['channels.alertLog', 'features.memberTracking.alertChannel', 'features.accountAge.alertChannel']
  },
  { names: ['join', 'joinlog', 'joins'], label: 'Join Log', paths: ['channels.joinLog'] }
];

export default {
  name: 'setchannel',
  description: 'Set log channels for different features',
  usage: '<modlog|alert|join> <#channel|channel_id>',
  category: 'config',
  permissions: [PermissionFlagsBits.Administrator],
  cooldown: 3,

  async execute(message, args) {
    const guildId = message.guild.id;

    try {
      const guild = await Guild.getGuild(guildId, message.guild.name);
      const prefix = await getPrefix(guildId);

      if (!hasAdminPerms(message.member, guild)) {
        return message.reply({
          embeds: [await errorEmbed(guildId, 'Permission Denied',
            `${GLYPHS.LOCK} You need Administrator permissions to set channels.`)]
        });
      }

      if (args.length < 2) {
        return message.reply({
          embeds: [await errorEmbed(guildId, 'Invalid Usage',
            `${GLYPHS.ARROW_RIGHT} Usage: \`${prefix}setchannel <type> <#channel|channel_id>\`\n\n` +
            `**Types:**\n` +
            `${GLYPHS.DOT} \`modlog\` - Moderation logs\n` +
            `${GLYPHS.DOT} \`alert\` - Security alerts\n` +
            `${GLYPHS.DOT} \`join\` - Join logs\n\n` +
            `For every other log type, use \`${prefix}setlogs\`.`)]
        });
      }

      const type = args[0].toLowerCase();
      const channelType = CHANNEL_TYPES.find(t => t.names.includes(type));

      if (!channelType) {
        return message.reply({
          embeds: [await errorEmbed(guildId, 'Unknown Type',
            `${GLYPHS.WARNING} Unknown channel type. Use \`modlog\`, \`alert\` or \`join\`.\n\n` +
            `For every other log type, use \`${prefix}setlogs\`.`)]
        });
      }

      const channelId = args[1].replace(/[<#>]/g, '');
      const channel = message.guild.channels.cache.get(channelId);
      if (!channel || channel.type !== ChannelType.GuildText) {
        return message.reply({
          embeds: [await errorEmbed(guildId, 'Channel Not Found',
            `${GLYPHS.ERROR} Could not find that text channel.`)]
        });
      }

      const update = Object.fromEntries(channelType.paths.map(path => [path, channel.id]));
      await Guild.updateGuild(guildId, { $set: update });

      return message.reply({
        embeds: [await successEmbed(guildId, 'Channel Configured',
          `${GLYPHS.SUCCESS} **${channelType.label}** channel set to ${channel}.`)]
      });
    } catch (error) {
      console.error('[SetChannel] Error:', error);
      return message.reply({
        embeds: [await errorEmbed(guildId, 'Configuration Error',
          'The channel could not be saved, Master. Please try again.')]
      }).catch(() => null);
    }
  }
};
