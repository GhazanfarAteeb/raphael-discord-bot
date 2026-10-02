import { PermissionFlagsBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } from 'discord.js';
import { BirthdayRequest } from '../../models/Birthday.js';
import Guild from '../../models/Guild.js';
import { errorEmbed, COLORS } from '../../utils/embeds.js';
import { getPrefix } from '../../utils/helpers.js';
import { getRandomFooter } from '../../utils/raphael.js';
import { formatDate } from './requestbirthday.js';

const FILTERS = ['open', 'approved', 'rejected', 'cancelled', 'all'];
const FILTER_LABELS = { open: 'Open', approved: 'Approved', rejected: 'Rejected', cancelled: 'Cancelled', all: 'All' };
const STATUS_GLYPHS = { open: '◇', approved: '◉', rejected: '◆', cancelled: '—' };
const PRIORITY_LABELS = { low: '◇ Low', normal: '◈ Normal', high: '◆ High' };
const TICKETS_SHOWN = 10;
const BUTTON_TIMEOUT_MS = 2 * 60 * 1000;

// Priority is stored as a string, so sort on an explicit rank: high first, then normal, then low
const PRIORITY_RANK = {
  $switch: {
    branches: [
      { case: { $eq: ['$priority', 'high'] }, then: 0 },
      { case: { $eq: ['$priority', 'low'] }, then: 2 }
    ],
    default: 1
  }
};

async function buildDashboard(guildId, filter, prefix, client) {
  const match = filter === 'all' ? { guildId } : { guildId, status: filter };

  const [requests, total, stats] = await Promise.all([
    BirthdayRequest.aggregate([
      { $match: match },
      { $addFields: { priorityRank: PRIORITY_RANK } },
      { $sort: { priorityRank: 1, createdAt: -1 } },
      { $limit: TICKETS_SHOWN }
    ]),
    BirthdayRequest.countDocuments(match),
    BirthdayRequest.aggregate([
      { $match: { guildId } },
      { $group: { _id: '$status', count: { $sum: 1 } } }
    ])
  ]);

  const statCounts = { open: 0, approved: 0, rejected: 0, cancelled: 0 };
  stats.forEach(s => { statCounts[s._id] = s.count; });

  const embed = new EmbedBuilder()
    .setColor(COLORS.RAPHAEL)
    .setTitle('『 Birthday Ticket Dashboard 』')
    .setDescription(
      '**Analysis:** Birthday ticket overview, Master.\n\n' +
      `${STATUS_GLYPHS.open} Open: **${statCounts.open}** • ` +
      `${STATUS_GLYPHS.approved} Approved: **${statCounts.approved}** • ` +
      `${STATUS_GLYPHS.rejected} Rejected: **${statCounts.rejected}** • ` +
      `${STATUS_GLYPHS.cancelled} Cancelled: **${statCounts.cancelled}**\n\n` +
      `Currently showing: **${FILTER_LABELS[filter]}** (${total} ticket${total === 1 ? '' : 's'})`
    )
    .setFooter({ text: `${getRandomFooter()} • ${prefix}birthdayrequests <${FILTERS.join('|')}>` })
    .setTimestamp();

  if (requests.length === 0) {
    embed.addFields({ name: '▸ No Tickets', value: `No ${filter === 'all' ? '' : `${filter} `}birthday tickets found.` });
  } else {
    const users = await Promise.all(requests.map(r => client.users.fetch(r.userId).catch(() => null)));

    requests.forEach((request, i) => {
      const ticketNum = `#${String(request.ticketNumber).padStart(4, '0')}`;
      let value = `**Birthday:** ${formatDate(request.requestedBirthday)}\n` +
        `**Status:** ${STATUS_GLYPHS[request.status] || '◇'} ${request.status}\n` +
        `**Priority:** ${PRIORITY_LABELS[request.priority] || PRIORITY_LABELS.normal}`;

      if (request.status !== 'open' && request.reviewedBy) {
        value += `\n**Reviewer:** <@${request.reviewedBy}>`;
      }
      if (request.staffNotes?.length > 0) {
        value += `\n**Notes:** ${request.staffNotes.length}`;
      }

      embed.addFields({
        name: `${ticketNum} — ${users[i]?.tag || 'Unknown User'}`,
        value,
        inline: true
      });
    });

    if (total > requests.length) {
      embed.addFields({ name: '▸ More Tickets', value: `+${total - requests.length} more not shown.` });
    }
  }

  const row = new ActionRowBuilder().addComponents(
    FILTERS.map(f => new ButtonBuilder()
      .setCustomId(`bday_list_${f}`)
      .setLabel(f === 'all' ? 'All' : `${FILTER_LABELS[f]} (${statCounts[f]})`)
      .setStyle(f === filter ? ButtonStyle.Primary : ButtonStyle.Secondary))
  );

  return { embeds: [embed], components: [row] };
}

export default {
  name: 'birthdayrequests',
  description: 'View birthday tickets',
  usage: '[open|approved|rejected|cancelled|all]',
  aliases: ['bdayrequests', 'bdaytickets', 'birthdaytickets'],
  category: 'community',
  permissions: [PermissionFlagsBits.ManageRoles],
  execute: async (message, args) => {
    const guildId = message.guild.id;

    try {
      const guildConfig = await Guild.getGuild(guildId, message.guild.name);
      const isStaff = message.member.permissions.has(PermissionFlagsBits.ManageRoles) ||
        message.member.permissions.has(PermissionFlagsBits.Administrator) ||
        (guildConfig?.roles?.staffRoles || []).some(roleId => message.member.roles.cache.has(roleId));

      if (!isStaff) {
        return message.reply({
          embeds: [await errorEmbed(guildId, 'Permission Denied', 'Staff permissions are required for this skill, Master.')]
        });
      }

      const prefix = await getPrefix(guildId);
      const filter = args[0]?.toLowerCase() || 'open';

      if (!FILTERS.includes(filter)) {
        return message.reply({
          embeds: [await errorEmbed(guildId, 'Invalid Filter',
            `Please use one of: \`${FILTERS.join('`, `')}\`, Master.\n\n**Usage:** \`${prefix}birthdayrequests [filter]\``)]
        });
      }

      const reply = await message.reply(await buildDashboard(guildId, filter, prefix, message.client));

      // The filter buttons switch the dashboard in place for the member who ran the command
      const collector = reply.createMessageComponentCollector({ time: BUTTON_TIMEOUT_MS });

      collector.on('collect', async (interaction) => {
        try {
          if (interaction.user.id !== message.author.id) {
            return interaction.reply({
              content: '**Notice:** Only the member who opened this dashboard can use these buttons, Master.',
              flags: MessageFlags.Ephemeral
            });
          }

          const nextFilter = interaction.customId.replace('bday_list_', '');
          if (!FILTERS.includes(nextFilter)) return interaction.deferUpdate();

          await interaction.deferUpdate();
          await interaction.editReply(await buildDashboard(guildId, nextFilter, prefix, message.client));
        } catch (error) {
          console.error('[birthdayrequests] Button error:', error);
        }
      });

      collector.on('end', () => {
        reply.edit({ components: [] }).catch(() => { });
      });

    } catch (error) {
      console.error('[birthdayrequests] Error:', error);
      return message.reply({
        embeds: [await errorEmbed(guildId, 'Operation Failed', 'I was unable to load the birthday tickets, Master.')]
      });
    }
  }
};
