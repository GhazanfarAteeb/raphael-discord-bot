import {
  Events,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  EmbedBuilder,
  MessageFlags,
  RESTJSONErrorCodes
} from 'discord.js';
import { setTimeout as sleep } from 'node:timers/promises';
import mongoose from 'mongoose';
import Poll from '../../models/Poll.js';
import { COLORS, GLYPHS } from '../../utils/embeds.js';
import logger from '../../utils/logger.js';

// Poll runtime shared with the poll command (src/commands/utility/poll.js). Polls live in the
// database (src/models/Poll.js), so votes and buttons keep working across restarts: every poll
// button is handled here (no per-message collectors), votes are atomic updates, and polls are
// ended by "poll end" or by the expiry sweep, both through concludePoll().

export const POLL_DURATION_MS = 24 * 60 * 60 * 1000; // 24 hours
export const MIN_OPTIONS = 2;
export const MAX_OPTIONS = 4;
export const POLL_BUTTON_ID = /^poll_(\d+)$/;

const BUTTON_OPTION_LENGTH = 40;
// Minimum time between two tally edits of the same poll message
const RENDER_INTERVAL_MS = 1500;
const SWEEP_INTERVAL_MS = 30 * 1000;
const SWEEP_BATCH = 25;
// Discord errors meaning the poll message can no longer be edited
const MESSAGE_GONE_CODES = new Set([
  RESTJSONErrorCodes.UnknownMessage,
  RESTJSONErrorCodes.UnknownChannel,
  RESTJSONErrorCodes.UnknownGuild,
  RESTJSONErrorCodes.MissingAccess
]);

const INACTIVE_POLL_NOTICE = '**Notice:** This poll is no longer active, Master.';
const CONCLUDED_POLL_NOTICE = '**Notice:** This poll has concluded, Master. The final results are shown on the poll.';
const VOTE_FAILED_NOTICE = '**Alert:** Your vote could not be processed, Master. Please try again.';

// messageId -> { chain, queued, lastAt }: pending tally edit of an open poll
const renders = new Map();
let sweepTimer = null;
let sweeping = false;

// ---------------------------------------------------------------------------------------------
// Display
// ---------------------------------------------------------------------------------------------

function truncate(text, maxLength) {
  return text.length > maxLength ? `${text.substring(0, maxLength - 3)}...` : text;
}

function createProgressBar(percentage) {
  const filled = Math.round(percentage / 10);
  const empty = 10 - filled;
  return '█'.repeat(filled) + '░'.repeat(empty);
}

/**
 * The vote buttons of `poll` ({ options: [{ label }] }), disabled once the poll has concluded
 * (and while a new poll is being stored).
 */
export function buildVoteRow(poll, { disabled = false } = {}) {
  return new ActionRowBuilder().addComponents(
    ...poll.options.map((opt, i) =>
      new ButtonBuilder()
        .setCustomId(`poll_${i}`)
        .setLabel(`${i + 1}. ${truncate(opt.label, BUTTON_OPTION_LENGTH)}`)
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(disabled)
    )
  );
}

/**
 * The poll embed: a stored poll, or the same shape before it is stored (messageId null).
 * @param {{ messageId?: string|null, question: string, options: { label: string, votes: string[] }[],
 *   creatorName?: string, endsAt: Date|number, footerTag?: string }} poll
 */
export function buildPollEmbed(poll, { concluded = false } = {}) {
  const votes = poll.options.map(opt => opt.votes?.length ?? 0);
  const totalVotes = votes.reduce((a, b) => a + b, 0);
  const maxVotes = Math.max(...votes);

  const optionLines = poll.options.map((opt, i) => {
    const count = votes[i];
    const percentage = totalVotes > 0 ? Math.round((count / totalVotes) * 100) : 0;
    const label = `**${i + 1}.** ${opt.label}`;
    const marker = concluded ? `${totalVotes > 0 && count === maxVotes ? '◆' : '◇'} ` : '';
    return `${marker}${label}\n${createProgressBar(percentage)} **${count}** ${count === 1 ? 'vote' : 'votes'} (${percentage}%)`;
  });

  let summary = `${GLYPHS.ARROW_RIGHT} **Total Votes:** ${totalVotes}`;

  if (concluded) {
    const winnerIndices = votes.map((v, i) => (v === maxVotes ? i : -1)).filter(i => i !== -1);
    if (totalVotes === 0) {
      summary += '\n◈ No votes were recorded.';
    } else if (winnerIndices.length > 1) {
      summary += `\n◈ **Result: Tie** between ${winnerIndices.map(i => `**${poll.options[i].label}**`).join(' and ')}`;
    } else {
      summary += `\n◉ **Winner:** ${poll.options[winnerIndices[0]].label} with **${maxVotes}** ${maxVotes === 1 ? 'vote' : 'votes'}.`;
    }
  } else {
    summary += `\n${GLYPHS.ARROW_RIGHT} **Closes:** <t:${Math.floor(new Date(poll.endsAt).getTime() / 1000)}:R>`;
  }

  const idText = poll.messageId ? `Poll ID: ${poll.messageId}` : 'Poll ID pending';
  const footerTag = poll.footerTag ? ` • ${poll.footerTag}` : '';

  return new EmbedBuilder()
    .setColor(concluded ? COLORS.RAPHAEL_SUCCESS : COLORS.RAPHAEL)
    .setTitle(concluded ? '『 Poll Concluded 』' : '『 Consensus Protocol 』')
    .setDescription(`**${poll.question}**\n\n${optionLines.join('\n\n')}\n\n${summary}`)
    .setFooter({
      text: concluded
        ? `Poll concluded • ${idText}${footerTag}`
        : `Created by ${poll.creatorName || 'Unknown'} • ${idText}${footerTag}`
    })
    .setTimestamp();
}

function isMessageGone(error) {
  return MESSAGE_GONE_CODES.has(error?.code);
}

// Edits the poll message without needing it cached (or fetched)
async function editPollMessage(client, poll, payload) {
  const channel = client.channels.cache.get(poll.channelId) ?? await client.channels.fetch(poll.channelId);
  if (!channel?.isTextBased?.()) {
    const error = new Error(`Poll channel ${poll.channelId} is not a text channel`);
    error.code = RESTJSONErrorCodes.UnknownChannel;
    throw error;
  }
  return channel.messages.edit(poll.messageId, payload);
}

/**
 * Shows the final results with disabled buttons.
 * @returns {Promise<'edited'|'gone'|'failed'>}
 */
async function showFinalResults(client, poll) {
  try {
    await editPollMessage(client, poll, {
      embeds: [buildPollEmbed(poll, { concluded: true })],
      components: [buildVoteRow(poll, { disabled: true })]
    });
    return 'edited';
  } catch (error) {
    if (isMessageGone(error)) return 'gone';
    logger.error(`[Poll] Could not post the final results of poll ${poll.messageId}`, error);
    return 'failed';
  }
}

// Coalesces tally edits: at most one pending edit per poll, at most one edit per
// RENDER_INTERVAL_MS, applied in order and always showing the latest stored tally
function queueRender(client, messageId) {
  let state = renders.get(messageId);
  if (!state) {
    state = { chain: Promise.resolve(), queued: false, lastAt: 0 };
    renders.set(messageId, state);
  }
  if (state.queued) return state.chain;

  state.queued = true;
  state.chain = state.chain.then(async () => {
    const wait = state.lastAt + RENDER_INTERVAL_MS - Date.now();
    if (wait > 0) await sleep(wait);
    state.queued = false;

    const poll = await Poll.findOne({ messageId }).lean();
    if (!poll || poll.ended) {
      // Concluded: concludePoll posts the final results itself
      if (!state.queued && renders.get(messageId) === state) renders.delete(messageId);
      return;
    }
    try {
      await editPollMessage(client, poll, { embeds: [buildPollEmbed(poll)] });
    } finally {
      state.lastAt = Date.now();
    }
  }).catch(error => {
    if (!isMessageGone(error)) logger.error(`[Poll] Could not update the tally of poll ${messageId}`, error);
  });
  return state.chain;
}

// ---------------------------------------------------------------------------------------------
// Ending
// ---------------------------------------------------------------------------------------------

/**
 * Ends the open poll matching `filter` (e.g. { messageId } or { messageId, guildId }) and posts
 * its final results. Idempotent and atomic: only the caller whose update flips `ended` from
 * false to true ends the poll and edits the message; everyone else gets { concluded: false }.
 * @returns {Promise<{ concluded: false } | { concluded: true, poll: object, message: 'edited'|'gone'|'failed' }>}
 */
export async function concludePoll(client, filter) {
  const poll = await Poll.findOneAndUpdate(
    { ...filter, ended: false },
    { $set: { ended: true, endedAt: new Date() } },
    { new: true }
  ).lean();
  if (!poll) return { concluded: false };

  // A tally edit already under way must land first, or it could overwrite the final results
  const state = renders.get(poll.messageId);
  if (state) await state.chain;
  renders.delete(poll.messageId);

  const message = await showFinalResults(client, poll);
  return { concluded: true, poll, message };
}

/**
 * Ends every poll whose time is up. Run by the poll scheduler; safe to call at any time.
 */
export async function checkExpiredPolls(client) {
  if (sweeping || mongoose.connection.readyState !== 1 || !client?.isReady?.()) return;
  sweeping = true;
  try {
    const due = await Poll.find({ ended: false, endsAt: { $lte: new Date() } })
      .sort({ endsAt: 1 })
      .limit(SWEEP_BATCH)
      .select({ messageId: 1, guildId: 1 })
      .lean();

    for (const { messageId, guildId } of due) {
      // During a guild outage the message cannot be edited yet; a guild I am no longer in is
      // ended anyway (its message is gone for me)
      const guild = client.guilds.cache.get(guildId);
      if (guild && !guild.available) continue;
      try {
        await concludePoll(client, { messageId });
      } catch (error) {
        logger.error(`[Poll] Could not end expired poll ${messageId}`, error);
      }
    }
  } catch (error) {
    logger.error('[Poll] Expired poll check failed', error);
  } finally {
    sweeping = false;
  }
}

/**
 * Starts the expiry sweep (ends overdue polls now, then every 30 seconds). Idempotent, so it
 * can be called on startup and lazily by the first interaction or poll command.
 * @returns {boolean} true when this call started it
 */
export function startPollScheduler(client) {
  if (sweepTimer || !client?.isReady?.()) return false;
  sweepTimer = setInterval(() => checkExpiredPolls(client), SWEEP_INTERVAL_MS);
  sweepTimer.unref?.();
  checkExpiredPolls(client);
  console.log('[RAPHAEL] Poll expiry monitor initialized.');
  return true;
}

// ---------------------------------------------------------------------------------------------
// Voting
// ---------------------------------------------------------------------------------------------

/**
 * Records `userId`'s press on option `optionIndex` of the open poll `poll` (single choice).
 * Pressing the option already voted for withdraws the vote; pressing another moves it there.
 * Each change is one atomic update that also requires the poll to be open, so concurrent or
 * double presses can never count a user twice and no vote lands after the poll has ended.
 * @returns {Promise<{ status: 'withdrawn'|'registered'|'changed'|'closed'|'retry', previous?: number }>}
 */
export async function castVote(poll, optionIndex, userId) {
  const now = new Date();
  const open = { _id: poll._id, ended: false, endsAt: { $gt: now } };
  const path = `options.${optionIndex}.votes`;

  const withdrawn = await Poll.findOneAndUpdate(
    { ...open, [path]: userId },
    { $pull: { [path]: userId } },
    { new: true, projection: { _id: 1 } }
  ).lean();
  if (withdrawn) return { status: 'withdrawn' };

  // Added to this option and pulled from every other one in the same update
  const update = { $addToSet: { [path]: userId } };
  const others = {};
  for (let i = 0; i < poll.options.length; i++) {
    if (i !== optionIndex) others[`options.${i}.votes`] = userId;
  }
  if (Object.keys(others).length) update.$pull = others;

  const before = await Poll.findOneAndUpdate(
    { ...open, [path]: { $ne: userId } },
    update,
    { new: false, projection: { options: 1 } }
  ).lean();
  if (before) {
    const previous = before.options.findIndex(opt => opt.votes.includes(userId));
    return previous === -1 ? { status: 'registered' } : { status: 'changed', previous };
  }

  // Neither update matched: the poll closed meanwhile, or a concurrent press of the same
  // option already recorded this vote
  const current = await Poll.findById(poll._id).lean();
  if (!current || current.ended || new Date(current.endsAt).getTime() <= now.getTime()) return { status: 'closed' };
  if (current.options[optionIndex]?.votes.includes(userId)) return { status: 'registered' };
  return { status: 'retry' };
}

// Buttons of a poll with no stored record (posted before polls were stored) are disabled
async function disableStaleButtons(message) {
  if (!message?.editable) return;
  const rows = message.components
    .filter(row => row.type === ComponentType.ActionRow)
    .map(row => {
      const builder = ActionRowBuilder.from(row);
      builder.components.forEach(component => component.setDisabled?.(true));
      return builder;
    });
  await message.edit({ components: rows });
}

async function handlePollButton(interaction) {
  const client = interaction.client;
  const optionIndex = Number(POLL_BUTTON_ID.exec(interaction.customId)[1]);
  const userId = interaction.user.id;

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const respond = content => interaction.editReply({ content });

  const poll = await Poll.findOne({ messageId: interaction.message.id }).lean();

  if (!poll) {
    await respond(INACTIVE_POLL_NOTICE);
    await disableStaleButtons(interaction.message).catch(error =>
      logger.error('[Poll] Could not disable the buttons of an inactive poll', error));
    return;
  }

  if (poll.ended) {
    await respond(CONCLUDED_POLL_NOTICE);
    // Its buttons could still be pressed, so the final edit has not landed (yet): retry it
    await showFinalResults(client, poll);
    return;
  }

  // Time is up but the sweep has not run yet: end it now
  if (new Date(poll.endsAt).getTime() <= Date.now()) {
    await respond(CONCLUDED_POLL_NOTICE);
    await concludePoll(client, { messageId: poll.messageId });
    return;
  }

  const option = poll.options[optionIndex];
  if (!option) {
    await respond('**Notice:** That option is not part of this poll, Master.');
    return;
  }

  const result = await castVote(poll, optionIndex, userId);

  switch (result.status) {
    case 'withdrawn':
      await respond(`**Confirmed:** Your vote for **${option.label}** has been withdrawn, Master.`);
      break;
    case 'changed':
      await respond(`**Confirmed:** Vote changed from **${poll.options[result.previous].label}** to **${option.label}**, Master.`);
      break;
    case 'registered':
      await respond(`**Confirmed:** Vote registered for **${option.label}**, Master.`);
      break;
    case 'closed':
      await respond(CONCLUDED_POLL_NOTICE);
      await concludePoll(client, { messageId: poll.messageId });
      return;
    default:
      await respond(VOTE_FAILED_NOTICE);
      return;
  }

  queueRender(client, poll.messageId);
}

export default {
  name: Events.InteractionCreate,

  async execute(interaction) {
    // Events load only after the client is ready, so the first interaction starts the expiry
    // sweep if nothing else has (idempotent)
    startPollScheduler(interaction.client);

    if (!interaction.isButton() || !POLL_BUTTON_ID.test(interaction.customId) || !interaction.inGuild()) return;

    try {
      await handlePollButton(interaction);
    } catch (error) {
      logger.error('[Poll] Error handling vote', error);
      try {
        if (interaction.deferred || interaction.replied) {
          await interaction.editReply({ content: VOTE_FAILED_NOTICE });
        } else {
          await interaction.reply({ content: VOTE_FAILED_NOTICE, flags: MessageFlags.Ephemeral });
        }
      } catch {
        // Interaction expired
      }
    }
  }
};
