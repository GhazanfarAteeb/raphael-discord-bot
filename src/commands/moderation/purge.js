import { Message, MessageFlags, PermissionFlagsBits } from 'discord.js';
import { successEmbed, errorEmbed, GLYPHS } from '../../utils/embeds.js';
import { getPrefix } from '../../utils/helpers.js';
import logger from '../../utils/logger.js';

const USER_ID = /^\d{17,20}$/;
const MAX_PURGE = 100; // Discord's bulk delete and fetch limit
const BULK_DELETE_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000; // Discord refuses to bulk delete older messages
const CONFIRMATION_LIFETIME_MS = 5000;
const MISSING_PERMISSIONS = 50013;
const MISSING_ACCESS = 50001;

export default {
  name: 'purge',
  category: 'moderation',
  description: 'Delete multiple messages',
  usage: '<amount> [@user]',
  aliases: ['clean', 'delete'],
  permissions: {
    user: PermissionFlagsBits.ManageMessages,
    client: PermissionFlagsBits.ManageMessages
  },
  cooldown: 3,

  async execute(message, args) {
    const guildId = message.guild.id;
    // Bridged slash commands pass a stand-in object; only a real message can be deleted or referenced
    const isPrefixCommand = message instanceof Message;

    // Prefix: the command message is deleted, so confirmations go to the channel and expire.
    // Slash: the deferred reply is edited.
    const respond = async (embed, { expire = false } = {}) => {
      if (!isPrefixCommand) return message.reply({ embeds: [embed] });
      const sent = await message.channel.send({ embeds: [embed] }).catch(() => null);
      if (sent && expire) setTimeout(() => sent.delete().catch(() => {}), CONFIRMATION_LIFETIME_MS);
      return sent;
    };

    try {
      const prefix = await getPrefix(guildId);
      const usage = `${GLYPHS.ARROW_RIGHT} Usage: \`${prefix}purge <amount> [@user|user_id]\` — amount from 1 to ${MAX_PURGE}`;

      const amount = Number(args[0]);
      if (!args[0] || !Number.isInteger(amount) || amount < 1 || amount > MAX_PURGE) {
        return message.reply({
          embeds: [await errorEmbed(guildId, 'Invalid Usage', `**Notice:** Specify how many messages to remove, Master.\n\n${usage}`)]
        });
      }

      let targetUserId = null;
      if (args[1]) {
        targetUserId = args[1].replace(/[<@!>]/g, '');
        if (!USER_ID.test(targetUserId)) {
          return message.reply({
            embeds: [await errorEmbed(guildId, 'Invalid Usage', `**Warning:** The user filter must be a mention or a user ID, Master.\n\n${usage}`)]
          });
        }
      }

      // Look back over the last 100 messages (before the command itself), then keep the
      // newest `amount` that match: a user filter would otherwise only scan `amount` messages
      const fetched = await message.channel.messages.fetch(
        isPrefixCommand ? { limit: MAX_PURGE, before: message.id } : { limit: MAX_PURGE }
      );
      const cutoff = Date.now() - BULK_DELETE_MAX_AGE_MS;
      const toDelete = [...fetched.values()]
        .filter(m => !m.pinned)
        .filter(m => !m.flags.has(MessageFlags.Loading)) // the slash command's own pending reply
        .filter(m => m.createdTimestamp > cutoff)
        .filter(m => !targetUserId || m.author.id === targetUserId)
        .slice(0, amount);

      // The command message is removed but not counted
      if (isPrefixCommand) await message.delete().catch(() => {});

      if (toDelete.length === 0) {
        return respond(await errorEmbed(guildId, 'Nothing to Purge',
          `**Notice:** No eligible messages${targetUserId ? ` from <@${targetUserId}>` : ''} were found among the last ${MAX_PURGE}, Master. ` +
          'Pinned messages and messages older than 14 days are skipped.'), { expire: true });
      }

      const deleted = await message.channel.bulkDelete(toDelete, true);

      return respond(await successEmbed(guildId, 'Data Purge Complete',
        `**Confirmed:** Removed **${deleted.size}** message${deleted.size === 1 ? '' : 's'}${targetUserId ? ` from <@${targetUserId}>` : ''}, Master.`
      ), { expire: true });
    } catch (error) {
      logger.error('[Purge] Command failed', error);
      const description = error.code === MISSING_PERMISSIONS || error.code === MISSING_ACCESS
        ? 'I lack permission to read or delete messages in this channel, Master.'
        : 'An anomaly interrupted the purge, Master. The incident has been logged.';
      const embed = await errorEmbed(guildId, 'Purge Protocol Failed', description).catch(() => null);
      if (!embed) return null;
      return respond(embed).catch(() => null);
    }
  }
};
