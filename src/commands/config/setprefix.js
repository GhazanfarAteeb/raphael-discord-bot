import { PermissionFlagsBits } from 'discord.js';
import Guild from '../../models/Guild.js';
import { successEmbed, errorEmbed, infoEmbed, GLYPHS } from '../../utils/embeds.js';
import { hasAdminPerms } from '../../utils/helpers.js';

const MAX_PREFIX_LENGTH = 5;

export default {
  name: 'setprefix',
  description: 'Change the bot prefix for this server',
  usage: '<new_prefix>',
  category: 'config',
  aliases: ['prefix'],
  permissions: [PermissionFlagsBits.Administrator],
  cooldown: 5,

  async execute(message, args) {
    const guildId = message.guild.id;

    try {
      const guild = await Guild.getGuild(guildId, message.guild.name);
      const currentPrefix = guild.prefix || process.env.DEFAULT_PREFIX || '!';

      // No argument (e.g. `prefix` on its own): report the current prefix
      if (!args[0]) {
        return message.reply({
          embeds: [await infoEmbed(guildId, 'Server Prefix',
            `${GLYPHS.ARROW_RIGHT} The current prefix is \`${currentPrefix}\`, Master.\n` +
            `${GLYPHS.ARROW_RIGHT} Change it with \`${currentPrefix}setprefix <new_prefix>\` (up to ${MAX_PREFIX_LENGTH} characters).`)]
        });
      }

      if (!hasAdminPerms(message.member, guild)) {
        return message.reply({
          embeds: [await errorEmbed(guildId, 'Permission Denied',
            `${GLYPHS.LOCK} You need Administrator permissions to change the prefix.`)]
        });
      }

      const newPrefix = args[0];

      if (newPrefix.length > MAX_PREFIX_LENGTH) {
        return message.reply({
          embeds: [await errorEmbed(guildId, 'Prefix Too Long',
            `${GLYPHS.WARNING} The prefix must be ${MAX_PREFIX_LENGTH} characters or fewer.`)]
        });
      }

      await Guild.updateGuild(guildId, { $set: { prefix: newPrefix } });

      return message.reply({
        embeds: [await successEmbed(guildId, 'Prefix Updated',
          `${GLYPHS.SUCCESS} The server prefix is now \`${newPrefix}\`.\n` +
          `${GLYPHS.ARROW_RIGHT} Example: \`${newPrefix}help\``)]
      });
    } catch (error) {
      console.error('[SetPrefix] Error:', error);
      return message.reply({
        embeds: [await errorEmbed(guildId, 'Configuration Error',
          'The prefix could not be updated, Master. Please try again.')]
      }).catch(() => null);
    }
  }
};
