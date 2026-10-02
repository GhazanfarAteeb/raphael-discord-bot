import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType, EmbedBuilder, MessageFlags } from 'discord.js';
import { errorEmbed, successEmbed, warningEmbed, COLORS, GLYPHS } from '../../utils/embeds.js';
import { getPrefix, formatNumber } from '../../utils/helpers.js';
import { getRandomFooter } from '../../utils/raphael.js';
import logger from '../../utils/logger.js';

const PAGE_SIZE = 10;
const IDLE_TIMEOUT_MS = 2 * 60 * 1000;
const PREV_ID = 'serverlist_prev';
const NEXT_ID = 'serverlist_next';

export default {
  name: 'serverlist',
  category: 'admin',
  description: 'Get a list of all servers Raphael is in with invite links (Owner only)',
  ownerOnly: true,

  async execute(message) {
    const guildId = message.guild.id;
    const { client } = message;

    try {
      const prefix = await getPrefix(guildId);
      const servers = [...client.guilds.cache.values()].sort((a, b) => b.memberCount - a.memberCount);

      if (servers.length === 0) {
        return message.reply({
          embeds: [await errorEmbed(guildId, 'No Servers Found', 'I am not currently present in any servers, Master.')]
        });
      }

      const totalPages = Math.ceil(servers.length / PAGE_SIZE);
      const totalMembers = servers.reduce((sum, g) => sum + (g.memberCount || 0), 0);
      let page = 0;

      const buildPage = () => {
        const start = page * PAGE_SIZE;
        return new EmbedBuilder()
          .setColor(COLORS.RAPHAEL)
          .setTitle(`『 Server List — Page ${page + 1}/${totalPages} 』`)
          .setDescription(
            `**Report:** I am present in **${formatNumber(servers.length)}** servers with **${formatNumber(totalMembers)}** members in total, Master.\n\n` +
            `${GLYPHS.ARROW_RIGHT} \`${prefix}invite <server name or ID>\` — Invite to one server\n` +
            `${GLYPHS.ARROW_RIGHT} \`${prefix}exportinvites\` — Export invites for every server`)
          .addFields(servers.slice(start, start + PAGE_SIZE).map((guild, index) => ({
            name: `#${start + index + 1} ${guild.name}`,
            value: `${GLYPHS.DOT} ID: \`${guild.id}\`\n${GLYPHS.DOT} Members: ${formatNumber(guild.memberCount)}`,
            inline: false
          })))
          .setFooter({ text: getRandomFooter() })
          .setTimestamp();
      };

      const buildRow = (disabled = false) => new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(PREV_ID)
          .setLabel('Previous')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(disabled || page === 0),
        new ButtonBuilder()
          .setCustomId(NEXT_ID)
          .setLabel('Next')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(disabled || page === totalPages - 1)
      );

      // Set when DMs are closed and the list falls back to the channel
      let notice = null;
      const payload = () => ({
        embeds: notice ? [notice, buildPage()] : [buildPage()],
        components: totalPages > 1 ? [buildRow()] : []
      });

      // Server names and IDs go to the owner's DMs; the channel only gets a confirmation
      let listMessage = await message.author.send(payload()).catch(() => null);
      if (listMessage) {
        await message.reply({
          embeds: [await successEmbed(guildId, 'Delivered', 'The server list has been sent to your direct messages, Master.')]
        });
      } else {
        notice = await warningEmbed(guildId, 'Direct Messages Closed',
          'I could not reach your direct messages, so the server list is posted here instead, Master.');
        listMessage = await message.reply(payload());
      }

      if (!listMessage || totalPages <= 1) return listMessage;

      const collector = listMessage.createMessageComponentCollector({
        componentType: ComponentType.Button,
        filter: i => i.customId === PREV_ID || i.customId === NEXT_ID,
        idle: IDLE_TIMEOUT_MS
      });

      collector.on('collect', async interaction => {
        try {
          if (interaction.user.id !== message.author.id) {
            return await interaction.reply({
              content: '**Notice:** These controls are reserved for my creator, Master.',
              flags: MessageFlags.Ephemeral
            });
          }

          page = interaction.customId === NEXT_ID
            ? Math.min(page + 1, totalPages - 1)
            : Math.max(page - 1, 0);

          return await interaction.update(payload());
        } catch (error) {
          logger.error('[ServerList] Failed to change page', error);
          return null;
        }
      });

      collector.on('end', async () => {
        await listMessage.edit({ components: [buildRow(true)] }).catch(() => {});
      });

      return listMessage;
    } catch (error) {
      logger.error('[ServerList] Command failed', error);
      const embed = await errorEmbed(guildId, 'Server List Failed',
        'An anomaly occurred while compiling the server list, Master. The incident has been logged.').catch(() => null);
      return message.reply(embed ? { embeds: [embed] } : { content: '**Alert:** The server list could not be compiled, Master.' }).catch(() => null);
    }
  }
};
