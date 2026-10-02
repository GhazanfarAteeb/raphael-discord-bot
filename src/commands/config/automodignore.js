import { PermissionFlagsBits } from 'discord.js';
import Guild from '../../models/Guild.js';
import { successEmbed, errorEmbed, infoEmbed, GLYPHS } from '../../utils/embeds.js';
import { getPrefix, hasModPerms } from '../../utils/helpers.js';

const FIELD_LIMIT = 1024;
const CHANNEL_ID = /^(?:<#)?(\d{17,20})>?$/;
const ROLE_ID = /^(?:<@&)?(\d{17,20})>?$/;

// Join lines without passing a field limit; the rest is summarised as "and N more"
function fitLines(lines, limit = FIELD_LIMIT) {
  let text = '';
  for (let i = 0; i < lines.length; i++) {
    const line = (text ? '\n' : '') + lines[i];
    const remaining = lines.length - i - 1;
    const reserve = remaining > 0 ? `\n— and ${remaining} more`.length : 0;
    if (text.length + line.length + reserve > limit) {
      return `${text}${text ? '\n' : ''}— and ${lines.length - i} more`;
    }
    text += line;
  }
  return text;
}

function describe(guild, id, isChannel) {
  if (isChannel) return guild.channels.cache.has(id) ? `<#${id}>` : `Deleted channel (\`${id}\`)`;
  return guild.roles.cache.has(id) ? `<@&${id}>` : `Deleted role (\`${id}\`)`;
}

export default {
  name: 'automodignore',
  description: 'Configure automod ignore settings for channels and roles (alias for automod ignore)',
  usage: 'automodignore <add|remove|list> [channel|role] [#channel/@role]',
  category: 'config',
  aliases: ['amignore', 'automodexclude'],
  permissions: [PermissionFlagsBits.ManageGuild],
  cooldown: 3,

  async execute(message, args) {
    const guildId = message.guild.id;

    try {
      const prefix = await getPrefix(guildId);
      const guildConfig = await Guild.getGuild(guildId);

      // Check for moderator permissions (admin, mod role, or ManageGuild)
      if (!hasModPerms(message.member, guildConfig)) {
        return message.reply({
          embeds: [await errorEmbed(guildId, 'Permission Denied',
            `${GLYPHS.LOCK} You need Moderator/Staff permissions to configure automod ignore settings.`)]
        });
      }

      const action = args[0]?.toLowerCase();
      const type = args[1]?.toLowerCase();

      if (action === 'list') {
        return listIgnored(message, guildConfig);
      }

      if (action !== 'add' && action !== 'remove') {
        return showHelp(message, prefix);
      }

      if (!['channel', 'role', 'channels', 'roles'].includes(type)) {
        return message.reply({
          embeds: [await errorEmbed(guildId, 'Invalid Type',
            `**Notice:** Please specify \`channel\` or \`role\`, Master.\n\n**Usage:** \`${prefix}automodignore <add|remove> <channel|role> <#channel/@role>\``)]
        });
      }

      const isChannel = type.startsWith('channel');
      const field = isChannel ? 'ignoredChannels' : 'ignoredRoles';
      const current = guildConfig.features?.autoMod?.[field] || [];

      // Adding needs a live channel/role; removing also takes a raw ID so deleted ones can be cleaned up
      let targetId;
      if (action === 'add') {
        const target = isChannel
          ? message.mentions.channels.first() || message.guild.channels.cache.get(args[2]?.match(CHANNEL_ID)?.[1])
          : message.mentions.roles.first() || message.guild.roles.cache.get(args[2]?.match(ROLE_ID)?.[1]);
        targetId = target?.id;
      } else {
        targetId = isChannel
          ? message.mentions.channels.first()?.id || args[2]?.match(CHANNEL_ID)?.[1]
          : message.mentions.roles.first()?.id || args[2]?.match(ROLE_ID)?.[1];
      }

      if (!targetId) {
        return message.reply({
          embeds: [await errorEmbed(guildId, 'Target Required',
            `**Notice:** Please mention a ${isChannel ? 'channel' : 'role'}${action === 'remove' ? ' or give its ID' : ''}, Master.\n\n` +
            `**Usage:** \`${prefix}automodignore ${action} ${isChannel ? 'channel #channel' : 'role @role'}\``)]
        });
      }

      const label = describe(message.guild, targetId, isChannel);
      const listName = isChannel ? 'ignored channels' : 'bypass roles';

      if (action === 'add') {
        if (current.includes(targetId)) {
          return message.reply({
            embeds: [await infoEmbed(guildId, 'Already Ignored',
              `${GLYPHS.INFO} ${label} is already in the automod ${listName} list, Master.`)]
          });
        }

        await Guild.updateGuild(guildId, { $addToSet: { [`features.autoMod.${field}`]: targetId } });

        return message.reply({
          embeds: [await successEmbed(guildId, 'AutoMod Ignore Updated',
            `${GLYPHS.SUCCESS} Added ${label} to the automod ${listName} list, Master.\n\n` +
            `**Effect:** AutoMod will no longer monitor ${isChannel ? 'messages in this channel' : 'users with this role'}.`)]
        });
      }

      if (!current.includes(targetId)) {
        return message.reply({
          embeds: [await errorEmbed(guildId, 'Not Found',
            `**Notice:** ${label} is not in the automod ${listName} list, Master.`)]
        });
      }

      await Guild.updateGuild(guildId, { $pull: { [`features.autoMod.${field}`]: targetId } });

      return message.reply({
        embeds: [await successEmbed(guildId, 'AutoMod Ignore Updated',
          `${GLYPHS.SUCCESS} Removed ${label} from the automod ${listName} list, Master.\n\n` +
          `**Effect:** AutoMod will now monitor ${isChannel ? 'messages in this channel' : 'users with this role'}.`)]
      });
    } catch (error) {
      console.error('[AutoModIgnore] Error:', error);
      return message.reply({
        embeds: [await errorEmbed(guildId, 'Configuration Error',
          'The automod ignore list could not be updated, Master. Please try again.')]
      }).catch(() => null);
    }
  }
};

async function showHelp(message, prefix) {
  const embed = await infoEmbed(message.guild.id, 'AutoMod Ignore Settings',
    `${GLYPHS.INFO} Channels and roles listed here never trigger automod actions.`);

  embed.addFields(
    {
      name: `${GLYPHS.ARROW_RIGHT} Channels`,
      value:
        `\`${prefix}automodignore add channel #channel\` - Ignore a channel\n` +
        `\`${prefix}automodignore remove channel <#channel|channel_id>\` - Stop ignoring a channel`
    },
    {
      name: `${GLYPHS.ARROW_RIGHT} Roles`,
      value:
        `\`${prefix}automodignore add role @role\` - Add a bypass role\n` +
        `\`${prefix}automodignore remove role <@role|role_id>\` - Remove a bypass role`
    },
    {
      name: `${GLYPHS.ARROW_RIGHT} Other`,
      value:
        `\`${prefix}automodignore list\` - List ignored channels and bypass roles\n` +
        `Also available as \`${prefix}automod ignore\` and \`/automod ignore-*\`.`
    }
  );

  return message.reply({ embeds: [embed] });
}

async function listIgnored(message, guildConfig) {
  const ignoredChannels = guildConfig.features?.autoMod?.ignoredChannels || [];
  const ignoredRoles = guildConfig.features?.autoMod?.ignoredRoles || [];

  const embed = await infoEmbed(message.guild.id, 'AutoMod Ignore Settings',
    `${GLYPHS.INFO} AutoMod skips these channels and members with these roles.`);
  embed.addFields(
    {
      name: `${GLYPHS.ARROW_RIGHT} Ignored Channels (${ignoredChannels.length})`,
      value: ignoredChannels.length
        ? fitLines(ignoredChannels.map(id => `${GLYPHS.DOT} ${describe(message.guild, id, true)}`))
        : `${GLYPHS.DOT} None`
    },
    {
      name: `${GLYPHS.ARROW_RIGHT} Bypass Roles (${ignoredRoles.length})`,
      value: ignoredRoles.length
        ? fitLines(ignoredRoles.map(id => `${GLYPHS.DOT} ${describe(message.guild, id, false)}`))
        : `${GLYPHS.DOT} None`
    }
  );

  return message.reply({ embeds: [embed] });
}
