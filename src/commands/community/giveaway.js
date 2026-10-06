import { PermissionFlagsBits, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import Giveaway from '../../models/Giveaway.js';
import { createEmbed, successEmbed, errorEmbed, infoEmbed, COLORS, GLYPHS } from '../../utils/embeds.js';
import { getPrefix, truncate } from '../../utils/helpers.js';
import { getRandomFooter } from '../../utils/raphael.js';

const MIN_DURATION_MS = 10 * 1000; // 10 seconds
const MAX_DURATION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const MAX_WINNERS = 20;
const MAX_PRIZE_LENGTH = 256;
const MEMBER_FETCH_CHUNK = 100;
const MEMBER_FETCH_TIMEOUT_MS = 30 * 1000;
// Discord embed descriptions are limited to 4096 characters
const DESCRIPTION_LIMIT = 4096;
// Concluded giveaways shown by `list`, so their IDs can be found for a reroll
const RECENT_ENDED_LIMIT = 10;
// Entry count updates are batched: at most one edit of a giveaway message per window
const REFRESH_DELAY_MS = 3000;
// Discord error codes for a channel or message that no longer exists
const MISSING_TARGET_CODES = new Set([10003, 10008]);

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
  const match = String(str ?? '').trim().match(/^(\d+)([smhdw])$/i);
  if (!match) return null;
  return parseInt(match[1], 10) * DURATION_UNITS[match[2].toLowerCase()];
}

/**
 * The giveaway message ID from a raw ID or a message link. "Copy Message Link" is available
 * to everyone, while copying an ID needs developer mode, so both are accepted.
 */
export function parseGiveawayMessageId(input) {
  const text = String(input ?? '').trim();
  const link = text.match(/^<?https?:\/\/(?:\w+\.)?discord(?:app)?\.com\/channels\/(?:\d+|@me)\/\d+\/(\d{17,20})\/?>?$/i);
  if (link) return link[1];
  return /^\d{17,20}$/.test(text) ? text : null;
}

function messageLink(giveaway) {
  return `https://discord.com/channels/${giveaway.guildId}/${giveaway.channelId}/${giveaway.messageId}`;
}

/**
 * The role a member must hold to enter and to win, or null. A role that has since been
 * deleted no longer applies (nobody could meet it).
 */
export function requiredRoleId(guild, giveaway) {
  const roleId = giveaway.requirements?.roleId;
  if (!roleId) return null;
  if (guild && !guild.roles.cache.has(roleId)) return null;
  return roleId;
}

async function resolveChannel(guild, channelId) {
  const channel = guild.channels.cache.get(channelId) ??
    await guild.channels.fetch(channelId).catch(() => null);
  return channel?.isTextBased?.() ? channel : null;
}

function logUnlessMissing(context, error) {
  if (!MISSING_TARGET_CODES.has(error?.code)) console.error(`[giveaway] ${context}:`, error);
}

// Edits of one giveaway message run one at a time, so an entry count update that started
// before the giveaway ended can never land after (and overwrite) the concluded version
const editQueues = new Map();
function queueMessageEdit(messageId, task) {
  const run = (editQueues.get(messageId) ?? Promise.resolve())
    .then(task)
    .catch(error => logUnlessMissing('Failed to update the giveaway message', error));
  editQueues.set(messageId, run);
  run.finally(() => {
    if (editQueues.get(messageId) === run) editQueues.delete(messageId);
  });
  return run;
}

// Entry count updates: every click within REFRESH_DELAY_MS shares one edit, built from the
// stored giveaway at the time of the edit (so the count is always the current one)
const pendingRefreshes = new Map();
export function scheduleGiveawayRefresh(guild, giveaway) {
  const { messageId, channelId } = giveaway;
  if (pendingRefreshes.has(messageId)) return;

  const timer = setTimeout(() => {
    pendingRefreshes.delete(messageId);
    queueMessageEdit(messageId, async () => {
      const current = await Giveaway.findOne({ messageId }).lean();
      if (!current || current.ended) return;
      const channel = await resolveChannel(guild, channelId);
      if (channel) await channel.messages.edit(messageId, await buildGiveawayMessage(current));
    });
  }, REFRESH_DELAY_MS);
  timer.unref?.();
  pendingRefreshes.set(messageId, timer);
}

function cancelGiveawayRefresh(messageId) {
  clearTimeout(pendingRefreshes.get(messageId));
  pendingRefreshes.delete(messageId);
}

/**
 * The live giveaway message (embed + entry buttons). Shared by both start commands and the
 * entry button handler so every update keeps the same layout.
 */
export async function buildGiveawayMessage(giveaway) {
  const endsAt = new Date(giveaway.endsAt);
  const roleId = giveaway.requirements?.roleId;
  const embed = await createEmbed(giveaway.guildId, 'info');

  embed
    .setTitle('『 Lottery Protocol Active 』')
    .setDescription(
      `**▸ Prize:** ${giveaway.prize}\n\n` +
      `**▸ Recipients:** ${giveaway.winners}\n` +
      `**▸ Initiated by:** <@${giveaway.hostId}>\n` +
      (roleId ? `**▸ Requirement:** the <@&${roleId}> role\n` : '') +
      `\n**▸ Concludes:** <t:${Math.floor(endsAt.getTime() / 1000)}:R>\n\n` +
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

// The concluded giveaway message: results, the ID needed for a reroll, buttons disabled
export async function buildEndedGiveawayMessage(giveaway) {
  const winners = giveaway.winnerIds || [];
  const participantCount = giveaway.participants?.length || 0;
  const roleId = giveaway.requirements?.roleId;

  const embed = (await createEmbed(giveaway.guildId, 'info'))
    .setColor(COLORS.MUTED)
    .setTitle('『 Distribution Complete 』')
    .setDescription(
      `**▸ Prize:** ${giveaway.prize}\n\n` +
      `**▸ Winners:** ${winners.length > 0 ? winners.map(id => `<@${id}>`).join(', ') : 'No eligible participants'}\n` +
      `**▸ Hosted by:** <@${giveaway.hostId}>\n` +
      (roleId ? `**▸ Requirement:** the <@&${roleId}> role\n` : '') +
      `\n**▸ Participants:** ${participantCount}\n` +
      `**▸ Giveaway ID:** \`${giveaway.messageId}\``
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

  return { embeds: [embed], components: [row] };
}

/**
 * Draw up to `count` winners who are still members of the guild (not bots) and still hold the
 * required role, never redrawing anyone in `exclude` (previous winners). Members are checked
 * in batches of 100. Needs a hydrated giveaway document (pickWinners).
 */
async function drawWinners(guild, giveaway, count, exclude = []) {
  // pickWinners with the full pool size returns every eligible participant in random order
  const shuffled = giveaway.pickWinners(giveaway.participants.length, exclude);
  const roleId = requiredRoleId(guild, giveaway);
  const winners = [];

  for (let i = 0; i < shuffled.length && winners.length < count; i += MEMBER_FETCH_CHUNK) {
    const chunk = shuffled.slice(i, i + MEMBER_FETCH_CHUNK);
    const members = await guild.members.fetch({ user: chunk, time: MEMBER_FETCH_TIMEOUT_MS }).catch((error) => {
      console.error('[giveaway] Member lookup failed; drawing without the membership check:', error);
      return null;
    });
    for (const id of chunk) {
      if (winners.length >= count) break;
      if (members) {
        const member = members.get(id);
        if (!member || member.user?.bot) continue;
        if (roleId && !member.roles.cache.has(roleId)) continue;
      }
      winners.push(id);
    }
  }

  return winners;
}

// Reply to the giveaway message when allowed (a reply needs Read Message History)
function replyToGiveaway(channel, messageId) {
  const me = channel.guild?.members.me;
  const canReply = me && channel.permissionsFor?.(me)?.has(PermissionFlagsBits.ReadMessageHistory);
  return canReply ? { reply: { messageReference: messageId, failIfNotExists: false } } : {};
}

export default {
  name: 'giveaway',
  description: 'Create and manage giveaways',
  usage: '<start|end|reroll|list|delete> [options]',
  aliases: ['gw', 'gaway'],
  category: 'community',
  // Array form: Manage Server, or a configured admin/moderator/staff role (as /giveaway allows)
  permissions: [PermissionFlagsBits.ManageGuild],
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
          return await endGiveaway(message, args[1], prefix);
        case 'reroll':
          return await rerollGiveaway(message, args[1], args[2], prefix);
        case 'list':
          return await listGiveaways(message);
        case 'delete':
        case 'cancel':
          return await deleteGiveaway(message, args[1], prefix);
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
    `◇ \`${prefix}giveaway start <duration> <winners> [@role] <prize>\`\n` +
    `  Example: \`${prefix}giveaway start 1d 2 Nitro Classic\`\n` +
    '  A role mentioned before the prize is required to enter and to win.\n\n' +
    `◇ \`${prefix}giveaway end <messageId>\` — Terminate early\n` +
    `◇ \`${prefix}giveaway reroll <messageId> [count]\` — Draw new recipients (default 1)\n` +
    `◇ \`${prefix}giveaway list\` — Active and recently concluded lotteries, with their IDs\n` +
    `◇ \`${prefix}giveaway delete <messageId>\` — Cancel lottery\n\n` +
    'The message ID may also be given as a message link (Copy Message Link).\n\n' +
    '**Duration Formats** (10 seconds to 30 days):\n' +
    '◇ `s` — seconds (30s)\n' +
    '◇ `m` — minutes (10m)\n' +
    '◇ `h` — hours (2h)\n' +
    '◇ `d` — days (1d)\n' +
    '◇ `w` — weeks (1w)'
  );
  return message.reply({ embeds: [embed] });
}

// start <duration> <winners> [@role] <prize>
async function startGiveaway(message, args, prefix) {
  if (args.length < 3) {
    return message.reply({
      embeds: [await errorEmbed(message.guild.id, 'Insufficient Parameters',
        `**Notice:** Required syntax, Master:\n\`${prefix}giveaway start <duration> <winners> [@role] <prize>\`\n` +
        `Example: \`${prefix}giveaway start 1d 2 Nitro Classic\``)]
    });
  }

  const roleId = args[2].match(/^<@&(\d{17,20})>$/)?.[1] ?? null;
  return createGiveaway(message, {
    duration: args[0],
    winners: /^\d+$/.test(args[1]) ? Number(args[1]) : NaN,
    prize: args.slice(roleId ? 3 : 2).join(' '),
    roleId
  });
}

/**
 * Validate, post and store a giveaway. Used by the prefix command and /giveaway start, so
 * both accept the same input. `message` is a message, or the slash command's message-like
 * wrapper (guild, channel, author, reply).
 */
export async function createGiveaway(message, { duration: durationInput, winners, prize: prizeInput, roleId = null }) {
  const guildId = message.guild.id;
  const fail = async (title, description) => message.reply({ embeds: [await errorEmbed(guildId, title, description)] });

  const duration = parseDuration(durationInput);
  if (!duration) {
    return fail('Invalid Duration', '**Warning:** Please provide a valid temporal format (e.g., 30s, 10m, 2h, 1d, 1w), Master.');
  }
  if (duration < MIN_DURATION_MS || duration > MAX_DURATION_MS) {
    return fail('Invalid Duration', '**Warning:** A giveaway may run for at least 10 seconds and at most 30 days, Master.');
  }

  if (!Number.isInteger(winners) || winners < 1 || winners > MAX_WINNERS) {
    return fail('Invalid Winner Count', `**Warning:** Recipient count must be between 1 and ${MAX_WINNERS}, Master.`);
  }

  const prize = String(prizeInput ?? '').trim();
  if (!prize) {
    return fail('Prize Required', '**Warning:** Prize description is mandatory, Master.');
  }
  if (prize.length > MAX_PRIZE_LENGTH) {
    return fail('Prize Too Long', `**Warning:** The prize may be at most ${MAX_PRIZE_LENGTH} characters, Master.`);
  }

  if (roleId) {
    if (roleId === guildId) {
      return fail('Invalid Requirement', '**Warning:** Every member holds @everyone. Choose a specific role, or omit the requirement, Master.');
    }
    if (!message.guild.roles.cache.has(roleId)) {
      return fail('Role Not Found', '**Warning:** The required role does not exist in this server, Master.');
    }
  }

  const channel = message.channel;
  if (!channel?.isTextBased?.()) {
    return fail('Unsupported Channel', '**Warning:** Giveaways can only be posted in a text channel, Master.');
  }

  const endsAt = new Date(Date.now() + duration);
  const draft = {
    guildId,
    hostId: message.author.id,
    prize,
    winners,
    endsAt,
    participants: [],
    ...(roleId ? { requirements: { roleId } } : {})
  };

  let giveawayMessage;
  try {
    giveawayMessage = await channel.send(await buildGiveawayMessage(draft));
  } catch (error) {
    console.error('[giveaway] Could not post the giveaway:', error);
    return fail('Giveaway Not Started',
      `${GLYPHS.ERROR} I could not post the giveaway in this channel. I require View Channel, Send Messages and Embed Links here, Master.`);
  }

  try {
    await Giveaway.create({
      ...draft,
      channelId: channel.id,
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
      `**▸ Concludes:** <t:${Math.floor(endsAt.getTime() / 1000)}:R>\n` +
      (roleId ? `**▸ Requirement:** the <@&${roleId}> role\n` : '') +
      `**▸ Message ID:** \`${giveawayMessage.id}\` — [Jump to giveaway](${giveawayMessage.url})`)]
  });
}

// Shared by end, reroll and delete: the message ID (or link) from the arguments
async function resolveMessageIdArg(message, input, usage) {
  const messageId = parseGiveawayMessageId(input);
  if (messageId) return messageId;
  await message.reply({
    embeds: [await errorEmbed(message.guild.id, input ? 'Invalid Message ID' : 'Missing Message ID',
      'Please provide the giveaway message ID or message link, Master. ' +
      `\`giveaway list\` shows the IDs.\n\n**Usage:** \`${usage}\``)]
  });
  return null;
}

async function endGiveaway(message, idArg, prefix) {
  const guildId = message.guild.id;
  const messageId = await resolveMessageIdArg(message, idArg, `${prefix}giveaway end <messageId>`);
  if (!messageId) return;

  const giveaway = await Giveaway.findOne({ messageId, guildId });

  if (!giveaway) {
    return message.reply({
      embeds: [await errorEmbed(guildId, 'Not Found', 'No giveaway matches that message ID, Master.')]
    });
  }

  if (giveaway.ended) {
    return message.reply({
      embeds: [await errorEmbed(guildId, 'Already Ended', 'This giveaway has already ended, Master.')]
    });
  }

  const winners = await endGiveawayById(message.guild, giveaway);

  if (winners === null) {
    // The scheduler (or another moderator) ended it at the same moment
    return message.reply({
      embeds: [await errorEmbed(guildId, 'Already Ended', 'This giveaway has already ended, Master.')]
    });
  }

  return message.reply({
    embeds: [await successEmbed(guildId, 'Giveaway Ended',
      `**Confirmed:** The giveaway for **${giveaway.prize}** has been concluded, Master.\n` +
      `**▸ Winners:** ${winners.length > 0 ? winners.map(id => `<@${id}>`).join(', ') : 'No eligible participants'}`)]
  });
}

async function rerollGiveaway(message, idArg, countArg, prefix) {
  const guildId = message.guild.id;
  const usage = `${prefix}giveaway reroll <messageId> [count]`;
  const messageId = await resolveMessageIdArg(message, idArg, usage);
  if (!messageId) return;

  const count = countArg === undefined ? 1 : (/^\d+$/.test(countArg) ? Number(countArg) : NaN);
  if (!Number.isInteger(count) || count < 1 || count > MAX_WINNERS) {
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
        'Every remaining participant has already won, has left the server, or lacks the required role, Master.')]
    });
  }

  // Keep every winner on record so later rerolls skip them too. The filter makes two
  // simultaneous rerolls unable to both hand out the same member.
  const recorded = await Giveaway.findOneAndUpdate(
    { _id: giveaway._id, winnerIds: { $nin: newWinners } },
    { $addToSet: { winnerIds: { $each: newWinners } } },
    { new: true }
  );
  if (!recorded) {
    return message.reply({
      embeds: [await errorEmbed(guildId, 'Reroll Conflict', 'Another reroll of this giveaway completed at the same moment. Please try again, Master.')]
    });
  }

  const winnerMentions = newWinners.map(id => `<@${id}>`).join(', ');
  let announced = false;
  const channel = await resolveChannel(message.guild, giveaway.channelId);
  if (channel) {
    try {
      await channel.send({
        content: `**Notice:** Giveaway reroll complete. New recipient${newWinners.length === 1 ? '' : 's'}: ${winnerMentions}\n**Prize:** ${giveaway.prize}`,
        ...replyToGiveaway(channel, giveaway.messageId),
        allowedMentions: { users: newWinners, repliedUser: false }
      });
      announced = true;
    } catch (error) {
      console.error('[giveaway] Failed to announce the reroll:', error);
    }
  }

  const shortfall = newWinners.length < count
    ? `\nOnly ${newWinners.length} eligible participant${newWinners.length === 1 ? ' was' : 's were'} available.`
    : '';
  const notPosted = announced ? '' : '\n**Notice:** I could not announce this in the giveaway channel; please inform the recipients, Master.';
  return message.reply({
    embeds: [await successEmbed(guildId, 'Giveaway Rerolled',
      `**Confirmed:** ${newWinners.length} new recipient${newWinners.length === 1 ? ' has' : 's have'} been selected, Master.\n` +
      `**▸ New recipients:** ${winnerMentions}${shortfall}${notPosted}`)]
  });
}

function formatListEntry(g, index, ended) {
  const when = new Date(ended ? (g.endedAt ?? g.endsAt) : g.endsAt);
  return `**${index + 1}.** ${truncate(g.prize, 100)}\n` +
    `${GLYPHS.DOT} Channel: <#${g.channelId}>\n` +
    `${GLYPHS.DOT} ${ended ? 'Ended' : 'Ends'}: <t:${Math.floor(when.getTime() / 1000)}:R>\n` +
    `${GLYPHS.DOT} Participants: ${g.participantCount}` +
    (ended ? ` — Winners drawn: ${g.winnerIds?.length || 0}` : '') + '\n' +
    `${GLYPHS.DOT} Message ID: \`${g.messageId}\` — [Jump](${messageLink(g)})`;
}

// Fill the description up to Discord's limit and summarise what did not fit
function fitDescription(blocks) {
  const totalEntries = blocks.filter(block => block.entry).length;
  let description = '';
  let shownEntries = 0;

  for (const block of blocks) {
    const remaining = totalEntries - shownEntries - (block.entry ? 1 : 0);
    const next = (description ? '\n\n' : '') + block.text;
    const reserve = remaining > 0 ? `\n\n+${remaining} more`.length : 0;
    if ((description + next).length + reserve > DESCRIPTION_LIMIT) break;
    description += next;
    if (block.entry) shownEntries++;
  }

  if (shownEntries < totalEntries) {
    description += `\n\n+${totalEntries - shownEntries} more`;
  }
  return description;
}

async function listGiveaways(message) {
  const guildId = message.guild.id;
  const [active, ended] = await Promise.all([
    Giveaway.listGuildGiveaways(guildId, { ended: false }),
    Giveaway.listGuildGiveaways(guildId, { ended: true, limit: RECENT_ENDED_LIMIT })
  ]);

  if (active.length === 0 && ended.length === 0) {
    return message.reply({
      embeds: [await infoEmbed(guildId, 'No Giveaways', 'There are no active or recently concluded giveaways in this server, Master.')]
    });
  }

  const blocks = [{ text: '**▸ Active**' }];
  if (active.length === 0) blocks.push({ text: '◇ None' });
  active.forEach((g, i) => blocks.push({ text: formatListEntry(g, i, false), entry: true }));

  if (ended.length > 0) {
    blocks.push({ text: '**▸ Recently Concluded** — use these IDs to reroll' });
    ended.forEach((g, i) => blocks.push({ text: formatListEntry(g, i, true), entry: true }));
  }

  const embed = await infoEmbed(guildId, 'Lottery Registry', fitDescription(blocks));
  return message.reply({ embeds: [embed] });
}

async function deleteGiveaway(message, idArg, prefix) {
  const guildId = message.guild.id;
  const messageId = await resolveMessageIdArg(message, idArg, `${prefix}giveaway delete <messageId>`);
  if (!messageId) return;

  const giveaway = await Giveaway.findOneAndDelete({ messageId, guildId });

  if (!giveaway) {
    return message.reply({
      embeds: [await errorEmbed(guildId, 'Not Found', 'No giveaway matches that message ID, Master.')]
    });
  }

  cancelGiveawayRefresh(messageId);

  // Remove the giveaway message too (it may already be gone)
  const channel = await resolveChannel(message.guild, giveaway.channelId);
  await channel?.messages.delete(giveaway.messageId).catch(error => logUnlessMissing('Failed to delete the giveaway message', error));

  return message.reply({
    embeds: [await successEmbed(guildId, 'Giveaway Deleted',
      giveaway.ended
        ? 'The concluded giveaway and its record have been deleted, Master. It can no longer be rerolled.'
        : 'The giveaway has been cancelled and deleted, Master. No winners were drawn.')]
  });
}

/**
 * End a giveaway: close entries, draw, claim, announce. Used by the scheduler and by
 * `end`. Resolves to the winner IDs, or null if the giveaway was already ended (or deleted).
 */
export async function endGiveawayById(guild, giveaway) {
  // Close entries first: a giveaway ended early must not take entries during the draw
  const now = new Date();
  await Giveaway.updateOne({ _id: giveaway._id, ended: false, endsAt: { $gt: now } }, { $set: { endsAt: now } });

  const current = await Giveaway.findOne({ _id: giveaway._id, ended: false });
  if (!current) return null;

  // Only participants who are still in the server (and still hold the required role) can win
  const winners = await drawWinners(guild, current, current.winners);

  // Claim and record the result in one write, so the scheduler and a manual end cannot both
  // draw, and a restart between the draw and the announcement loses nothing
  const claimed = await Giveaway.findOneAndUpdate(
    { _id: current._id, ended: false },
    { $set: { ended: true, endedAt: new Date(), winnerIds: winners, announced: false } },
    { new: true }
  );
  if (!claimed) return null;

  await announceGiveawayResults(guild, claimed);
  return winners;
}

/**
 * Post the results of a claimed giveaway: update the giveaway message, announce in its
 * channel, or (if the channel is gone or closed to me) tell the winners and host by DM.
 * Also used by the scheduler to finish announcements interrupted by a restart.
 */
export async function announceGiveawayResults(guild, giveaway) {
  cancelGiveawayRefresh(giveaway.messageId);
  const winners = giveaway.winnerIds || [];
  const channel = await resolveChannel(guild, giveaway.channelId);
  let posted = false;

  if (channel) {
    await queueMessageEdit(giveaway.messageId, async () => {
      await channel.messages.edit(giveaway.messageId, await buildEndedGiveawayMessage(giveaway));
    });

    const shortfall = winners.length > 0 && winners.length < giveaway.winners
      ? `\n**Notice:** Only ${winners.length} of ${giveaway.winners} recipients could be drawn from the eligible participants.`
      : '';
    try {
      // Only the winners may be pinged; the prize text can never mention anyone else
      await channel.send({
        content: winners.length > 0
          ? `**Confirmed:** Congratulations ${winners.map(id => `<@${id}>`).join(', ')}. You have won **${giveaway.prize}**.${shortfall}`
          : `**Notice:** No eligible participants remained for **${giveaway.prize}**.`,
        ...replyToGiveaway(channel, giveaway.messageId),
        allowedMentions: { users: winners, repliedUser: false }
      });
      posted = true;
    } catch (error) {
      console.error('[giveaway] Failed to announce winners:', error);
    }
  }

  if (!posted) await sendResultsByDirectMessage(guild, giveaway, winners);

  await Giveaway.updateOne({ _id: giveaway._id }, { $set: { announced: true } });
}

// Fallback when the results cannot be posted in the giveaway channel
async function sendResultsByDirectMessage(guild, giveaway, winners) {
  const send = (userId, content) => guild.client.users.send(userId, { content, allowedMentions: { parse: [] } })
    .catch(() => { }); // DMs closed

  for (const userId of winners) {
    await send(userId,
      `**Notice:** You have won **${giveaway.prize}** in **${guild.name}**, Master. ` +
      'The announcement could not be posted in the server, so I am informing you directly.');
  }

  await send(giveaway.hostId,
    `**Notice:** Your giveaway for **${giveaway.prize}** in **${guild.name}** has concluded, ` +
    'but I could not post the results in its channel, Master.\n' +
    `**▸ Winners:** ${winners.length > 0 ? winners.map(id => `<@${id}>`).join(', ') : 'No eligible participants'}\n` +
    `**▸ Giveaway ID:** \`${giveaway.messageId}\``);
}
