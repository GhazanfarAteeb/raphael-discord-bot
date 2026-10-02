import { PermissionFlagsBits, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import Giveaway from '../../models/Giveaway.js';
import { createEmbed, successEmbed, errorEmbed, infoEmbed, COLORS, GLYPHS } from '../../utils/embeds.js';
import { getPrefix, truncate } from '../../utils/helpers.js';
import { getRandomFooter } from '../../utils/raphael.js';

const MAX_DURATION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const MAX_WINNERS = 20;
const MAX_PRIZE_LENGTH = 256;
const MEMBER_FETCH_CHUNK = 100;
// Discord embed descriptions are limited to 4096 characters
const DESCRIPTION_LIMIT = 4096;

const DURATION_UNITS = {
  s: 1000,
  m: 60 * 1000,
  h: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
  w: 7 * 24 * 60 * 60 * 1000
};

// Single value + unit ("30s", "2h", "1w"). Kept local: helpers.parseDuration has no weeks
// and accepts trailing junk, so it is not a drop-in replacement for this syntax.
function parseDuration(str) {
  const match = String(str ?? '').match(/^(\d+)([smhdw])$/i);
  if (!match) return null;
  return parseInt(match[1], 10) * DURATION_UNITS[match[2].toLowerCase()];
}

/**
 * The live giveaway message (embed + entry buttons). Shared by the start command and the
 * entry button handler so every update keeps the same layout.
 */
export async function buildGiveawayMessage(giveaway) {
  const endsAt = new Date(giveaway.endsAt);
  const embed = await createEmbed(giveaway.guildId, 'info');

  embed
    .setTitle('『 Lottery Protocol Active 』')
    .setDescription(
      `**▸ Prize:** ${giveaway.prize}\n\n` +
      `**▸ Recipients:** ${giveaway.winners}\n` +
      `**▸ Initiated by:** <@${giveaway.hostId}>\n\n` +
      `**▸ Concludes:** <t:${Math.floor(endsAt.getTime() / 1000)}:R>\n\n` +
      'Activate the button below to register your entry, Master.'
    )
    .setFooter({ text: `${getRandomFooter()} • Concludes at` })
    .setTimestamp(endsAt);

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('giveaway_enter')
      .setLabel(`◉ Enter (${giveaway.participants?.length || 0})`)
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId('giveaway_participants')
      .setLabel('◈ Participants')
      .setStyle(ButtonStyle.Secondary)
  );

  return { embeds: [embed], components: [row] };
}

/**
 * Draw up to `count` winners who are still members of the guild, never redrawing
 * anyone in `exclude` (previous winners). Members are checked in batches of 100.
 */
async function drawWinners(guild, giveaway, count, exclude = []) {
  // pickWinners with the full pool size returns every eligible participant in random order
  const shuffled = giveaway.pickWinners(giveaway.participants.length, exclude);
  const winners = [];

  for (let i = 0; i < shuffled.length && winners.length < count; i += MEMBER_FETCH_CHUNK) {
    const chunk = shuffled.slice(i, i + MEMBER_FETCH_CHUNK);
    const members = await guild.members.fetch({ user: chunk }).catch((error) => {
      console.error('[giveaway] Member lookup failed; drawing without the membership check:', error);
      return null;
    });
    for (const id of chunk) {
      if (winners.length >= count) break;
      if (!members || members.has(id)) winners.push(id);
    }
  }

  return winners;
}

export default {
  name: 'giveaway',
  description: 'Create and manage giveaways',
  usage: '<start|end|reroll|list|delete> [options]',
  aliases: ['gw', 'gaway'],
  category: 'community',
  permissions: {
    user: PermissionFlagsBits.ManageGuild
  },
  cooldown: 5,

  async execute(message, args) {
    try {
      const prefix = await getPrefix(message.guild.id);

      if (!args[0]) {
        return showHelp(message, prefix);
      }

      switch (args[0].toLowerCase()) {
        case 'start':
        case 'create':
          return await startGiveaway(message, args.slice(1), prefix);
        case 'end':
        case 'stop':
          return await endGiveaway(message, args[1]);
        case 'reroll':
          return await rerollGiveaway(message, args[1], args[2], prefix);
        case 'list':
          return await listGiveaways(message);
        case 'delete':
        case 'cancel':
          return await deleteGiveaway(message, args[1]);
        default:
          return showHelp(message, prefix);
      }
    } catch (error) {
      console.error('[giveaway] Error:', error);
      return message.reply({
        embeds: [await errorEmbed(message.guild.id, 'Operation Failed', 'An anomaly occurred while managing the giveaway, Master.')]
      });
    }
  }
};

async function showHelp(message, prefix) {
  const embed = await infoEmbed(message.guild.id, 'Lottery Protocol',
    '**Answer:** Available sub-commands, Master.\n\n' +
    `◇ \`${prefix}giveaway start <duration> <winners> <prize>\`\n` +
    `  Example: \`${prefix}giveaway start 1d 2 Nitro Classic\`\n\n` +
    `◇ \`${prefix}giveaway end <messageId>\` — Terminate early\n` +
    `◇ \`${prefix}giveaway reroll <messageId> [count]\` — Draw new recipients (default 1)\n` +
    `◇ \`${prefix}giveaway list\` — Display active lotteries\n` +
    `◇ \`${prefix}giveaway delete <messageId>\` — Cancel lottery\n\n` +
    '**Duration Formats** (maximum 30 days):\n' +
    '◇ `s` — seconds (30s)\n' +
    '◇ `m` — minutes (10m)\n' +
    '◇ `h` — hours (2h)\n' +
    '◇ `d` — days (1d)\n' +
    '◇ `w` — weeks (1w)'
  );
  return message.reply({ embeds: [embed] });
}

async function startGiveaway(message, args, prefix) {
  const guildId = message.guild.id;

  if (args.length < 3) {
    return message.reply({
      embeds: [await errorEmbed(guildId, 'Insufficient Parameters',
        `**Notice:** Required syntax, Master:\n\`${prefix}giveaway start <duration> <winners> <prize>\`\n` +
        `Example: \`${prefix}giveaway start 1d 2 Nitro Classic\``)]
    });
  }

  const duration = parseDuration(args[0]);
  if (!duration) {
    return message.reply({
      embeds: [await errorEmbed(guildId, 'Invalid Duration',
        '**Warning:** Please provide a valid temporal format (e.g., 30s, 10m, 2h, 1d, 1w), Master.')]
    });
  }

  if (duration > MAX_DURATION_MS) {
    return message.reply({
      embeds: [await errorEmbed(guildId, 'Invalid Duration', '**Warning:** A giveaway may run for at most 30 days, Master.')]
    });
  }

  const winners = parseInt(args[1], 10);
  if (isNaN(winners) || winners < 1 || winners > MAX_WINNERS) {
    return message.reply({
      embeds: [await errorEmbed(guildId, 'Invalid Winner Count',
        `**Warning:** Recipient count must be between 1 and ${MAX_WINNERS}, Master.`)]
    });
  }

  const prize = args.slice(2).join(' ').trim();
  if (!prize) {
    return message.reply({
      embeds: [await errorEmbed(guildId, 'Prize Required', '**Warning:** Prize description is mandatory, Master.')]
    });
  }

  if (prize.length > MAX_PRIZE_LENGTH) {
    return message.reply({
      embeds: [await errorEmbed(guildId, 'Prize Too Long',
        `**Warning:** The prize may be at most ${MAX_PRIZE_LENGTH} characters, Master.`)]
    });
  }

  const endsAt = new Date(Date.now() + duration);
  const draft = { guildId, hostId: message.author.id, prize, winners, endsAt, participants: [] };

  const giveawayMessage = await message.channel.send(await buildGiveawayMessage(draft));

  try {
    await Giveaway.create({
      ...draft,
      channelId: message.channel.id,
      messageId: giveawayMessage.id
    });
  } catch (error) {
    // Without a record the buttons would only answer "no longer exists"
    await giveawayMessage.delete().catch(() => { });
    throw error;
  }

  return message.reply({
    embeds: [await successEmbed(guildId, 'Lottery Initiated',
      `**Confirmed:** Lottery for **${prize}** has been activated, Master.\n` +
      `Concludes <t:${Math.floor(endsAt.getTime() / 1000)}:R>`)]
  });
}

async function endGiveaway(message, messageId) {
  if (!messageId) {
    return message.reply({
      embeds: [await errorEmbed(message.guild.id, 'Missing Message ID', 'Please provide the giveaway message ID, Master.')]
    });
  }

  const giveaway = await Giveaway.findOne({ messageId, guildId: message.guild.id });

  if (!giveaway) {
    return message.reply({
      embeds: [await errorEmbed(message.guild.id, 'Not Found', 'No giveaway matches that message ID, Master.')]
    });
  }

  if (giveaway.ended) {
    return message.reply({
      embeds: [await errorEmbed(message.guild.id, 'Already Ended', 'This giveaway has already ended, Master.')]
    });
  }

  await endGiveawayById(message.guild, giveaway);

  return message.reply({
    embeds: [await successEmbed(message.guild.id, 'Giveaway Ended', 'The giveaway has been concluded, Master.')]
  });
}

async function rerollGiveaway(message, messageId, countArg, prefix) {
  const guildId = message.guild.id;

  if (!messageId) {
    return message.reply({
      embeds: [await errorEmbed(guildId, 'Missing Message ID',
        `Please provide the giveaway message ID, Master.\n\n**Usage:** \`${prefix}giveaway reroll <messageId> [count]\``)]
    });
  }

  const count = countArg === undefined ? 1 : parseInt(countArg, 10);
  if (isNaN(count) || count < 1 || count > MAX_WINNERS) {
    return message.reply({
      embeds: [await errorEmbed(guildId, 'Invalid Count', `The reroll count must be between 1 and ${MAX_WINNERS}, Master.`)]
    });
  }

  const giveaway = await Giveaway.findOne({ messageId, guildId });

  if (!giveaway) {
    return message.reply({
      embeds: [await errorEmbed(guildId, 'Not Found', 'No giveaway matches that message ID, Master.')]
    });
  }

  if (!giveaway.ended) {
    return message.reply({
      embeds: [await errorEmbed(guildId, 'Not Ended',
        `This giveaway has not ended yet. Use \`${prefix}giveaway end ${messageId}\` first, Master.`)]
    });
  }

  if (giveaway.participants.length === 0) {
    return message.reply({
      embeds: [await errorEmbed(guildId, 'No Participants', 'There were no participants in this giveaway, Master.')]
    });
  }

  // Previous winners are excluded, so a reroll only ever draws someone new
  const previousWinners = giveaway.winnerIds || [];
  const newWinners = await drawWinners(message.guild, giveaway, count, previousWinners);

  if (newWinners.length === 0) {
    return message.reply({
      embeds: [await errorEmbed(guildId, 'No Eligible Participants',
        'Every remaining participant has already won or has left the server, Master.')]
    });
  }

  // Keep every winner on record so later rerolls skip them too
  await Giveaway.updateOne({ _id: giveaway._id }, { $addToSet: { winnerIds: { $each: newWinners } } });

  const channel = message.guild.channels.cache.get(giveaway.channelId);
  if (channel?.isTextBased()) {
    const winnerMentions = newWinners.map(id => `<@${id}>`).join(', ');
    await channel.send({
      content: `**Notice:** Giveaway reroll complete. New recipient${newWinners.length === 1 ? '' : 's'}: ${winnerMentions}\n**Prize:** ${giveaway.prize}`,
      allowedMentions: { users: newWinners }
    }).catch(() => { });
  }

  const shortfall = newWinners.length < count ? ` Only ${newWinners.length} eligible participant${newWinners.length === 1 ? ' was' : 's were'} available.` : '';
  return message.reply({
    embeds: [await successEmbed(guildId, 'Giveaway Rerolled',
      `${newWinners.length} new recipient${newWinners.length === 1 ? ' has' : 's have'} been selected, Master.${shortfall}`)]
  });
}

async function listGiveaways(message) {
  const giveaways = await Giveaway.getGuildGiveaways(message.guild.id);

  if (giveaways.length === 0) {
    return message.reply({
      embeds: [await infoEmbed(message.guild.id, 'No Active Giveaways', 'There are no active giveaways in this server, Master.')]
    });
  }

  const entries = giveaways.map((g, i) =>
    `**${i + 1}.** ${truncate(g.prize, 100)}\n` +
    `${GLYPHS.DOT} Ends: <t:${Math.floor(g.endsAt.getTime() / 1000)}:R>\n` +
    `${GLYPHS.DOT} Participants: ${g.participants.length}\n` +
    `${GLYPHS.DOT} Message ID: \`${g.messageId}\``
  );

  // Fill the description up to Discord's limit and summarise the rest
  let description = '';
  let shown = 0;
  for (const entry of entries) {
    const remaining = entries.length - shown - 1;
    const next = (description ? '\n\n' : '') + entry;
    const reserve = remaining > 0 ? `\n\n+${remaining} more`.length : 0;
    if ((description + next).length + reserve > DESCRIPTION_LIMIT) break;
    description += next;
    shown++;
  }
  if (shown < entries.length) {
    description += `\n\n+${entries.length - shown} more`;
  }

  const embed = await infoEmbed(message.guild.id, 'Active Distributions', description);
  return message.reply({ embeds: [embed] });
}

async function deleteGiveaway(message, messageId) {
  if (!messageId) {
    return message.reply({
      embeds: [await errorEmbed(message.guild.id, 'Missing Message ID', 'Please provide the giveaway message ID, Master.')]
    });
  }

  const giveaway = await Giveaway.findOneAndDelete({ messageId, guildId: message.guild.id });

  if (!giveaway) {
    return message.reply({
      embeds: [await errorEmbed(message.guild.id, 'Not Found', 'No giveaway matches that message ID, Master.')]
    });
  }

  // Try to delete the giveaway message
  try {
    const channel = message.guild.channels.cache.get(giveaway.channelId);
    const msg = await channel?.messages.fetch(giveaway.messageId);
    await msg?.delete();
  } catch (e) {
    // Message might already be deleted
  }

  return message.reply({
    embeds: [await successEmbed(message.guild.id, 'Giveaway Deleted', 'The giveaway has been cancelled and deleted, Master.')]
  });
}

// Export helper function for ending giveaways (used by the scheduler and the slash command)
export async function endGiveawayById(guild, giveaway) {
  // Claim the giveaway so the scheduler and a manual end cannot both draw winners
  const claimed = await Giveaway.findOneAndUpdate(
    { _id: giveaway._id, ended: false },
    { $set: { ended: true } },
    { new: true }
  );
  if (!claimed) return [];

  // Only participants who are still in the server can win
  const winners = await drawWinners(guild, claimed, claimed.winners, []);
  await Giveaway.updateOne({ _id: claimed._id }, { $set: { winnerIds: winners } });

  giveaway.ended = true;
  giveaway.winnerIds = winners;

  const channel = guild.channels.cache.get(claimed.channelId);
  if (!channel?.isTextBased()) return winners;

  try {
    const giveawayMessage = await channel.messages.fetch(claimed.messageId);
    const participantCount = claimed.participants.length;

    const embed = (await createEmbed(guild.id, 'info'))
      .setColor(COLORS.MUTED)
      .setTitle('『 Distribution Complete 』')
      .setDescription(
        `**▸ Prize:** ${claimed.prize}\n\n` +
        `**▸ Winners:** ${winners.length > 0 ? winners.map(id => `<@${id}>`).join(', ') : 'No valid participants'}\n` +
        `**▸ Hosted by:** <@${claimed.hostId}>\n\n` +
        `**▸ Participants:** ${participantCount}`
      )
      .setFooter({ text: `${getRandomFooter()} • Distribution concluded` });

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('giveaway_enter')
        .setLabel('◈ Concluded')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(true),
      new ButtonBuilder()
        .setCustomId('giveaway_participants')
        .setLabel(`◇ ${participantCount} Participants`)
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(true)
    );

    await giveawayMessage.edit({ embeds: [embed], components: [row] });
  } catch (error) {
    console.error('[giveaway] Failed to update the giveaway message:', error);
  }

  try {
    // Only the winners may be pinged; the prize text can never mention anyone else
    if (winners.length > 0) {
      const winnerMentions = winners.map(id => `<@${id}>`).join(', ');
      await channel.send({
        content: `**Confirmed:** Congratulations ${winnerMentions}. You have won **${claimed.prize}**.`,
        reply: { messageReference: claimed.messageId, failIfNotExists: false },
        allowedMentions: { users: winners, repliedUser: false }
      });
    } else {
      await channel.send({
        content: `**Notice:** No eligible participants entered for **${claimed.prize}**.`,
        reply: { messageReference: claimed.messageId, failIfNotExists: false },
        allowedMentions: { parse: [], repliedUser: false }
      });
    }
  } catch (error) {
    console.error('[giveaway] Failed to announce winners:', error);
  }

  return winners;
}
