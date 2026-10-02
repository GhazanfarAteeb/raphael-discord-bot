import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType, MessageFlags, PermissionFlagsBits } from 'discord.js';
import { successEmbed, errorEmbed, COLORS, GLYPHS } from '../../utils/embeds.js';
import { getPrefix } from '../../utils/helpers.js';
import { getRandomFooter } from '../../utils/raphael.js';

const POLL_DURATION_MS = 24 * 60 * 60 * 1000; // 24 hours
const MIN_OPTIONS = 2;
const MAX_OPTIONS = 4;
const MAX_QUESTION_LENGTH = 300;
const MAX_OPTION_LENGTH = 100;
const BUTTON_OPTION_LENGTH = 40;
const POLL_BUTTON_ID = /^poll_(\d+)$/;
const SNOWFLAKE = /^\d{17,20}$/;
// Collector end reasons where the poll message no longer exists to be edited
const MESSAGE_GONE_REASONS = ['messageDelete', 'channelDelete', 'guildDelete'];

const INACTIVE_POLL_NOTICE =
  '**Notice:** This poll is no longer active, Master. Votes are held only while a poll is open ' +
  'and are not retained after it concludes or after a system restart.';

// messageId -> poll state. Polls are held in memory only and are lost on restart.
const activePolls = new Map();

export default {
  name: 'poll',
  description: 'Create an interactive consensus protocol, Master',
  usage: 'poll <question> | <option1> | <option2> | [option3] | [option4]',
  category: 'utility',
  aliases: ['vote', 'survey'],
  cooldown: 10,

  async execute(message, args) {
    const guildId = message.guild.id;
    const input = args.join(' ');
    let commandDeleted = false;

    // The command message is deleted once the poll is posted, so later notices go to the channel
    const respond = async (payload) => {
      if (!commandDeleted) {
        try {
          return await message.reply(payload);
        } catch {
          // Fall through to a plain channel message
        }
      }
      return message.channel.send(payload);
    };

    try {
      // Check for end poll command
      if (args[0]?.toLowerCase() === 'end' && !input.includes('|')) {
        return await endPoll(message, args[1]);
      }

      // Parse the poll: question | option1 | option2 | ...
      const parts = input.split('|').map(p => p.trim()).filter(p => p);

      if (parts.length < MIN_OPTIONS + 1) {
        const prefix = await getPrefix(guildId);
        const embed = await errorEmbed(guildId, 'Invalid Format',
          'Please provide a question and at least 2 options, Master.\n\n' +
          `**Usage:** \`${prefix}poll Question | Option 1 | Option 2\`\n` +
          `**Example:** \`${prefix}poll Best pizza topping? | Pepperoni | Cheese | Mushrooms\`\n\n` +
          `**To end a poll:** \`${prefix}poll end <pollId>\``
        );
        return await respond({ embeds: [embed] });
      }

      if (parts.length > MAX_OPTIONS + 1) {
        const embed = await errorEmbed(guildId, 'Too Many Options',
          `A poll supports at most ${MAX_OPTIONS} options, Master.`
        );
        return await respond({ embeds: [embed] });
      }

      const question = parts[0];
      const options = parts.slice(1);

      if (question.length > MAX_QUESTION_LENGTH || options.some(opt => opt.length > MAX_OPTION_LENGTH)) {
        const embed = await errorEmbed(guildId, 'Input Too Long',
          `The question may be at most ${MAX_QUESTION_LENGTH} characters and each option at most ${MAX_OPTION_LENGTH} characters, Master.`
        );
        return await respond({ embeds: [embed] });
      }

      const poll = {
        messageId: null,
        message: null,
        guildId,
        channelId: message.channel.id,
        question,
        options,
        votes: new Array(options.length).fill(0),
        voters: new Map(), // Map<userId, optionIndex>
        creatorId: message.author.id,
        creatorName: message.author.username,
        createdAt: Date.now(),
        endsAt: Date.now() + POLL_DURATION_MS,
        footerTag: getRandomFooter(),
        collector: null,
        closed: false,
        closing: null,
        renderQueued: false,
        renderChain: Promise.resolve()
      };

      // Delete the command message
      try {
        await message.delete();
        commandDeleted = true;
      } catch {
        // Missing permission or already deleted
      }

      const pollMsg = await message.channel.send({
        embeds: [buildPollEmbed(poll)],
        components: [buildVoteRow(options)]
      });

      poll.messageId = pollMsg.id;
      poll.message = pollMsg;
      activePolls.set(pollMsg.id, poll);

      // Handle votes
      const collector = pollMsg.createMessageComponentCollector({
        componentType: ComponentType.Button,
        time: POLL_DURATION_MS
      });
      poll.collector = collector;

      collector.on('collect', async (interaction) => {
        try {
          if (poll.closed) {
            await interaction.reply({ content: INACTIVE_POLL_NOTICE, flags: MessageFlags.Ephemeral });
            return;
          }
          await registerVote(interaction, poll);
        } catch (error) {
          console.error('[Poll] Error handling vote:', error);
          try {
            const payload = {
              content: '**Alert:** Your vote could not be processed, Master. Please try again.',
              flags: MessageFlags.Ephemeral
            };
            if (interaction.deferred || interaction.replied) await interaction.followUp(payload);
            else await interaction.reply(payload);
          } catch (replyError) {
            console.error('[Poll] Failed to report vote error:', replyError);
          }
        }
      });

      collector.on('end', async (_collected, reason) => {
        try {
          await closePoll(poll, { skipEdit: MESSAGE_GONE_REASONS.includes(reason) });
        } catch (error) {
          console.error('[Poll] Failed to finalize poll:', error);
        }
      });

      // Show the poll ID in the footer now that the message exists
      queueRender(poll);
    } catch (error) {
      console.error('[Poll] Error in poll command:', error);
      try {
        await respond({
          embeds: [await errorEmbed(guildId, 'The poll could not be processed, Master. Please try again.')]
        });
      } catch (replyError) {
        console.error('[Poll] Failed to send error reply:', replyError);
      }
    }
  }
};

/**
 * Answers a poll button whose poll is no longer held in memory (concluded, or lost on restart)
 * and disables the stale buttons. Live polls are left to their collector.
 * Intended to be called from a global InteractionCreate handler.
 * @returns {Promise<boolean>} true when the interaction was a stale poll button and was answered
 */
export async function handleInactivePollButton(interaction) {
  if (!interaction.isButton?.() || !POLL_BUTTON_ID.test(interaction.customId)) return false;
  if (activePolls.has(interaction.message?.id)) return false;

  try {
    await interaction.reply({ content: INACTIVE_POLL_NOTICE, flags: MessageFlags.Ephemeral });
  } catch (error) {
    console.error('[Poll] Failed to answer inactive poll button:', error);
    return true;
  }

  try {
    const message = interaction.message;
    if (message?.editable) {
      const rows = message.components
        .filter(row => row.type === ComponentType.ActionRow)
        .map(row => {
          const builder = ActionRowBuilder.from(row);
          builder.components.forEach(component => component.setDisabled?.(true));
          return builder;
        });
      await message.edit({ components: rows });
    }
  } catch (error) {
    console.error('[Poll] Failed to disable inactive poll buttons:', error);
  }

  return true;
}

async function registerVote(interaction, poll) {
  const match = POLL_BUTTON_ID.exec(interaction.customId);
  const optionIndex = match ? Number(match[1]) : -1;

  if (optionIndex < 0 || optionIndex >= poll.options.length) {
    await interaction.reply({ content: '**Notice:** That option is not part of this poll, Master.', flags: MessageFlags.Ephemeral });
    return;
  }

  // State changes happen synchronously, before any await, so concurrent votes cannot interleave
  const option = poll.options[optionIndex];
  const previousVote = poll.voters.get(interaction.user.id);
  let content;

  if (previousVote === optionIndex) {
    // Pressing the same option again withdraws the vote
    poll.votes[optionIndex]--;
    poll.voters.delete(interaction.user.id);
    content = `**Confirmed:** Your vote for **${option}** has been withdrawn, Master.`;
  } else {
    if (previousVote !== undefined) {
      poll.votes[previousVote]--;
    }
    poll.votes[optionIndex]++;
    poll.voters.set(interaction.user.id, optionIndex);
    content = previousVote !== undefined
      ? `**Confirmed:** Vote changed from **${poll.options[previousVote]}** to **${option}**, Master.`
      : `**Confirmed:** Vote registered for **${option}**, Master.`;
  }

  queueRender(poll);
  await interaction.reply({ content, flags: MessageFlags.Ephemeral });
}

// Coalesce message edits: at most one pending render, which always shows the latest tally,
// and edits are applied in order so an older tally never overwrites a newer one
function queueRender(poll) {
  if (poll.renderQueued || poll.closed) return;
  poll.renderQueued = true;
  poll.renderChain = poll.renderChain.then(async () => {
    poll.renderQueued = false;
    if (poll.closed) return;
    try {
      await poll.message.edit({ embeds: [buildPollEmbed(poll)] });
    } catch (error) {
      console.error('[Poll] Failed to update poll message:', error);
    }
  });
}

// Idempotent: removes the poll, stops its collector and posts the final results once
function closePoll(poll, { skipEdit = false } = {}) {
  if (poll.closing) return poll.closing;

  poll.closed = true;
  activePolls.delete(poll.messageId);
  poll.closing = poll.renderChain.then(async () => {
    if (skipEdit) return;
    await poll.message.edit({ embeds: [buildPollEmbed(poll, { concluded: true })], components: [] });
  });

  if (poll.collector && !poll.collector.ended) poll.collector.stop('ended');
  return poll.closing;
}

async function endPoll(message, messageId) {
  const guildId = message.guild.id;

  if (!messageId || !SNOWFLAKE.test(messageId)) {
    const prefix = await getPrefix(guildId);
    const embed = await errorEmbed(guildId, 'Invalid Poll ID',
      `Please provide the poll ID shown in the poll footer, Master.\n\n**Usage:** \`${prefix}poll end <pollId>\``
    );
    return message.reply({ embeds: [embed] });
  }

  const poll = activePolls.get(messageId);

  if (!poll || poll.guildId !== guildId) {
    const embed = await errorEmbed(guildId, 'Poll Not Found',
      'No active poll with that ID exists in this server, Master. Polls conclude after 24 hours and are not retained across a system restart.'
    );
    return message.reply({ embeds: [embed] });
  }

  // Check permissions
  const isModerator = message.member.permissions.has(PermissionFlagsBits.ManageMessages);
  if (poll.creatorId !== message.author.id && !isModerator) {
    const embed = await errorEmbed(guildId, 'Permission Denied',
      'Only the poll creator or a member with **Manage Messages** may end this poll, Master.'
    );
    return message.reply({ embeds: [embed] });
  }

  try {
    await closePoll(poll);
  } catch (error) {
    console.error('[Poll] Failed to post final results:', error);
    const embed = await errorEmbed(guildId, 'Poll Closed',
      'The poll has been closed, but its message could not be updated. It may have been deleted, Master.'
    );
    return message.reply({ embeds: [embed] });
  }

  const embed = await successEmbed(guildId, 'Poll Ended',
    'Consensus protocol terminated. The final results have been posted, Master.'
  );
  return message.reply({ embeds: [embed] });
}

function truncate(text, maxLength) {
  return text.length > maxLength ? `${text.substring(0, maxLength - 3)}...` : text;
}

function buildVoteRow(options) {
  return new ActionRowBuilder().addComponents(
    ...options.map((opt, i) =>
      new ButtonBuilder()
        .setCustomId(`poll_${i}`)
        .setLabel(`${i + 1}. ${truncate(opt, BUTTON_OPTION_LENGTH)}`)
        .setStyle(ButtonStyle.Secondary)
    )
  );
}

function createProgressBar(percentage) {
  const filled = Math.round(percentage / 10);
  const empty = 10 - filled;
  return '█'.repeat(filled) + '░'.repeat(empty);
}

function buildPollEmbed(poll, { concluded = false } = {}) {
  const totalVotes = poll.votes.reduce((a, b) => a + b, 0);
  const maxVotes = Math.max(...poll.votes);

  const optionLines = poll.options.map((opt, i) => {
    const votes = poll.votes[i];
    const percentage = totalVotes > 0 ? Math.round((votes / totalVotes) * 100) : 0;
    const label = `**${i + 1}.** ${opt}`;
    const marker = concluded ? `${totalVotes > 0 && votes === maxVotes ? '◆' : '◇'} ` : '';
    return `${marker}${label}\n${createProgressBar(percentage)} **${votes}** ${votes === 1 ? 'vote' : 'votes'} (${percentage}%)`;
  });

  let summary = `${GLYPHS.ARROW_RIGHT} **Total Votes:** ${totalVotes}`;

  if (concluded) {
    const winnerIndices = poll.votes.map((v, i) => (v === maxVotes ? i : -1)).filter(i => i !== -1);
    if (totalVotes === 0) {
      summary += '\n◈ No votes were recorded.';
    } else if (winnerIndices.length > 1) {
      summary += `\n◈ **Result: Tie** between ${winnerIndices.map(i => `**${poll.options[i]}**`).join(' and ')}`;
    } else {
      summary += `\n◉ **Winner:** ${poll.options[winnerIndices[0]]} with **${maxVotes}** ${maxVotes === 1 ? 'vote' : 'votes'}.`;
    }
  } else {
    summary += `\n${GLYPHS.ARROW_RIGHT} **Closes:** <t:${Math.floor(poll.endsAt / 1000)}:R>`;
  }

  const idText = poll.messageId ? `Poll ID: ${poll.messageId}` : 'Poll ID pending';

  return new EmbedBuilder()
    .setColor(concluded ? COLORS.RAPHAEL_SUCCESS : COLORS.RAPHAEL)
    .setTitle(concluded ? '『 Poll Concluded 』' : '『 Consensus Protocol 』')
    .setDescription(`**${poll.question}**\n\n${optionLines.join('\n\n')}\n\n${summary}`)
    .setFooter({
      text: concluded
        ? `Poll concluded • ${idText} • ${poll.footerTag}`
        : `Created by ${poll.creatorName} • ${idText} • ${poll.footerTag}`
    })
    .setTimestamp();
}
