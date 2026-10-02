import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType, MessageFlags, escapeMarkdown } from 'discord.js';
import Level from '../../models/Level.js';
import Economy from '../../models/Economy.js';
import Member from '../../models/Member.js';
import Guild from '../../models/Guild.js';
import { createEmbed, errorEmbed, GLYPHS } from '../../utils/embeds.js';
import { getRandomFooter } from '../../utils/raphael.js';

const PER_PAGE = 10;
const COLLECTOR_TIME_MS = 120000; // 2 minutes
const RANK_GLYPHS = ['◆', '◈', '◇'];
// Only a custom guild emoji is shown next to the currency; unicode defaults stay out of bot text
const CUSTOM_EMOJI = /^<a?:\w{2,32}:\d{17,20}>$/;

const TYPE_ALIASES = {
  coins: 'coins',
  level: 'level',
  lvl: 'level',
  messages: 'messages',
  xp: 'xp',
  rep: 'rep',
  reputation: 'rep'
};

export default {
  name: 'leaderboard',
  aliases: ['lb', 'top'],
  description: 'View server leaderboards (xp, coins, rep, or level)',
  usage: 'leaderboard [type] [page]',
  category: 'utility',
  cooldown: 10,

  async execute(message, args) {
    const guildId = message.guild.id;

    try {
      // Determine leaderboard type
      let type = 'level'; // default to level
      let page = 1;

      const requestedType = TYPE_ALIASES[args[0]?.toLowerCase()];
      if (requestedType) {
        type = requestedType;
        page = parseInt(args[1]) || 1;
      } else {
        page = parseInt(args[0]) || 1;
      }

      // Get guild config for coin settings
      const guildConfig = await Guild.getGuild(guildId);
      const coinEmoji = guildConfig?.economy?.coinEmoji || '';
      const coinName = guildConfig?.economy?.coinName || 'coins';
      const coinIcon = CUSTOM_EMOJI.test(coinEmoji) ? `${coinEmoji} ` : '';

      const board = getBoard(type, coinName, coinIcon);
      const context = { message, guildId, type, board };

      const view = await buildView(context, page);

      if (!view.total) {
        // Still show disabled pagination buttons
        return message.reply({ embeds: [view.embed], components: [createPaginationRow(1, 1, type, true)] });
      }

      let currentPage = view.page;
      let maxPage = view.maxPage;

      const reply = await message.reply({
        embeds: [view.embed],
        components: [createPaginationRow(currentPage, maxPage, type)]
      });

      // Create collector for pagination
      const collector = reply.createMessageComponentCollector({
        componentType: ComponentType.Button,
        filter: i => i.user.id === message.author.id,
        time: COLLECTOR_TIME_MS
      });

      collector.on('ignore', async (i) => {
        try {
          await i.reply({
            content: '**Notice:** These controls respond only to the member who requested this leaderboard, Master.',
            flags: MessageFlags.Ephemeral
          });
        } catch (error) {
          console.error('[Leaderboard] Failed to answer a foreign button press:', error);
        }
      });

      // Page changes run one at a time so rapid presses cannot race each other
      let pending = Promise.resolve();

      collector.on('collect', async (i) => {
        try {
          await i.deferUpdate();
        } catch (error) {
          console.error('[Leaderboard] Failed to acknowledge pagination:', error);
          return;
        }

        pending = pending.then(async () => {
          try {
            const action = i.customId.split('_')[1]; // first, prev, page, next, last
            let targetPage = currentPage;

            if (action === 'first') targetPage = 1;
            else if (action === 'prev') targetPage = currentPage - 1;
            else if (action === 'next') targetPage = currentPage + 1;
            else if (action === 'last') targetPage = Number.MAX_SAFE_INTEGER; // clamped to the live page count
            else return;

            const next = await buildView(context, targetPage);
            currentPage = next.page;
            maxPage = next.maxPage;

            await i.editReply({
              embeds: [next.embed],
              components: [createPaginationRow(currentPage, maxPage, type, !next.total)]
            });
          } catch (error) {
            console.error('[Leaderboard] Error handling pagination:', error);
            try {
              await i.followUp({
                embeds: [await errorEmbed(guildId, 'Page Unavailable', 'The requested page could not be retrieved, Master. Please try again.')],
                flags: MessageFlags.Ephemeral
              });
            } catch (followUpError) {
              console.error('[Leaderboard] Failed to report pagination error:', followUpError);
            }
          }
        });
      });

      collector.on('end', async () => {
        try {
          // Disable all buttons when collector ends, on the page last shown
          await pending;
          await reply.edit({ components: [createPaginationRow(currentPage, maxPage, type, true)] });
        } catch {
          // Message may have been deleted
        }
      });

    } catch (error) {
      console.error('[Leaderboard] Error fetching leaderboard:', error);
      try {
        return await message.reply({
          embeds: [await errorEmbed(guildId, 'Leaderboard Error', 'The leaderboard could not be retrieved, Master. Please try again later.')]
        });
      } catch (replyError) {
        console.error('[Leaderboard] Failed to send error reply:', replyError);
      }
    }
  }
};

// Leaderboard definitions. sortFields are all descending; userId breaks ties so that pages
// are stable and a member's rank matches the position they are listed at.
function getBoard(type, coinName, coinIcon) {
  const coinLabel = coinName.charAt(0).toUpperCase() + coinName.slice(1);

  const boards = {
    coins: {
      model: Economy,
      title: `${coinLabel} Leaderboard`,
      sortFields: ['coins'],
      select: 'userId coins',
      format: (row) => `${(row.coins || 0).toLocaleString()} ${coinIcon}${coinName}`
    },
    rep: {
      model: Economy,
      title: 'Reputation Leaderboard',
      sortFields: ['reputation'],
      select: 'userId reputation',
      format: (row) => `${(row.reputation || 0).toLocaleString()} reputation`
    },
    // Message totals are tracked on Member (statsMessageTracker); Economy.stats.messagesCount is never incremented
    messages: {
      model: Member,
      title: 'Messages Leaderboard',
      sortFields: ['stats.messagesCount'],
      select: 'userId username displayName stats.messagesCount',
      format: (row) => `${(row.stats?.messagesCount || 0).toLocaleString()} messages`
    },
    level: {
      model: Level,
      title: 'Level Leaderboard',
      sortFields: ['level', 'xp'],
      select: 'userId username level xp',
      format: (row) => `Level **${row.level || 0}** • ${(row.xp || 0).toLocaleString()} XP`
    },
    xp: {
      model: Level,
      title: 'XP Leaderboard',
      sortFields: ['totalXP', 'level'],
      select: 'userId username totalXP level',
      format: (row) => `${(row.totalXP || 0).toLocaleString()} XP • Level ${row.level || 0}`
    }
  };

  const board = boards[type] || boards.level;
  const [primaryField] = board.sortFields;

  return {
    ...board,
    filter: (guildId) => ({ guildId, [primaryField]: { $gt: 0 } }),
    sort: Object.fromEntries([...board.sortFields.map(field => [field, -1]), ['userId', 1]])
  };
}

// Read a dotted path such as "stats.messagesCount" from a lean document
function readPath(doc, path) {
  return path.split('.').reduce((value, key) => (value == null ? undefined : value[key]), doc);
}

// Requester's 1-based position under the same ordering as the pages, or null when unranked
async function getRequesterRank(board, guildId, userId) {
  const doc = await board.model.findOne({ guildId, userId }).select(board.sortFields.join(' ')).lean();
  if (!doc) return null;

  const values = board.sortFields.map(field => readPath(doc, field) ?? 0);
  if (!(values[0] > 0)) return null;

  // Entries ahead: a higher value on some sort field with all earlier fields equal,
  // or all fields equal and a smaller userId (the tie-breaker)
  const ahead = board.sortFields.map((field, index) => {
    const clause = {};
    for (let j = 0; j < index; j++) clause[board.sortFields[j]] = values[j];
    clause[field] = { $gt: values[index] };
    return clause;
  });
  const tie = { userId: { $lt: userId } };
  board.sortFields.forEach((field, j) => { tie[field] = values[j]; });
  ahead.push(tie);

  const count = await board.model.countDocuments({ ...board.filter(guildId), $or: ahead });
  return count + 1;
}

async function resolveNames(guild, rows) {
  return Promise.all(rows.map(async (row) => {
    const member = guild.members.cache.get(row.userId)
      ?? await guild.members.fetch(row.userId).catch(() => null);
    const name = member?.user.username || row.username || row.displayName || 'Unknown User';
    return escapeMarkdown(name);
  }));
}

// Count, fetch one page and the requester's rank, then build the embed
async function buildView({ message, guildId, board }, requestedPage) {
  const filter = board.filter(guildId);
  const total = await board.model.countDocuments(filter);
  const maxPage = Math.max(1, Math.ceil(total / PER_PAGE));
  const page = Math.max(1, Math.min(requestedPage, maxPage));

  const [rows, rank] = await Promise.all([
    total
      ? board.model.find(filter).sort(board.sort).skip((page - 1) * PER_PAGE).limit(PER_PAGE).select(board.select).lean()
      : [],
    getRequesterRank(board, guildId, message.author.id)
  ]);

  const names = await resolveNames(message.guild, rows);

  const lines = rows.map((row, index) => {
    const position = (page - 1) * PER_PAGE + index + 1;
    const marker = position <= RANK_GLYPHS.length ? RANK_GLYPHS[position - 1] : GLYPHS.DOT;
    return `${marker} **#${position}** — **${names[index]}**\n${GLYPHS.ARROW_RIGHT} ${board.format(row)}`;
  });

  const embed = await createEmbed(guildId, 'info');
  embed
    .setTitle(`『 ${board.title} 』`)
    .setThumbnail(message.guild.iconURL())
    .setFooter({ text: `Page ${page}/${maxPage} • ${getRandomFooter()}` });

  if (!total) {
    embed.setDescription('**Analysis:** No one has been ranked on this leaderboard yet, Master. Continued activity will populate it.');
    return { embed, page, maxPage, total };
  }

  embed
    .setDescription(lines.join('\n\n') || 'No data available.')
    .addFields({
      name: `${GLYPHS.ARROW_RIGHT} Your Position`,
      value: rank
        ? `#${rank.toLocaleString()} of ${total.toLocaleString()} ranked entries`
        : `Not yet ranked • ${total.toLocaleString()} ranked entries`
    });

  return { embed, page, maxPage, total };
}

// Create pagination buttons row
function createPaginationRow(currentPage, maxPage, type, forceDisabled = false) {
  const atStart = forceDisabled || currentPage <= 1;
  const atEnd = forceDisabled || currentPage >= maxPage;

  // Use unique identifiers for each button action to avoid duplicate custom_id
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`lb_first_${type}_${currentPage}`)
      .setLabel('First')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(atStart),
    new ButtonBuilder()
      .setCustomId(`lb_prev_${type}_${currentPage}`)
      .setLabel('Previous')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(atStart),
    new ButtonBuilder()
      .setCustomId(`lb_page_${type}_${currentPage}`)
      .setLabel(`${currentPage}/${maxPage}`)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(true),
    new ButtonBuilder()
      .setCustomId(`lb_next_${type}_${currentPage}`)
      .setLabel('Next')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(atEnd),
    new ButtonBuilder()
      .setCustomId(`lb_last_${type}_${currentPage}`)
      .setLabel('Last')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(atEnd)
  );
}
