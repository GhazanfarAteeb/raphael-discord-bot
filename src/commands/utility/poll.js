import { PermissionFlagsBits } from 'discord.js';
import Poll from '../../models/Poll.js';
import { successEmbed, errorEmbed } from '../../utils/embeds.js';
import { getPrefix } from '../../utils/helpers.js';
import { getRandomFooter } from '../../utils/raphael.js';
import {
  POLL_DURATION_MS,
  MIN_OPTIONS,
  MAX_OPTIONS,
  buildPollEmbed,
  buildVoteRow,
  concludePoll,
  startPollScheduler
} from '../../events/client/pollButtonHandler.js';

// Polls are stored (src/models/Poll.js); votes, the tally and expiry are handled by
// src/events/client/pollButtonHandler.js, so polls keep working across restarts.

const MAX_QUESTION_LENGTH = 300;
const MAX_OPTION_LENGTH = 100;
const SNOWFLAKE = /^\d{17,20}$/;

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

    // Polls that expired while I was offline are ended by the sweep (idempotent)
    startPollScheduler(message.client);

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

      const draft = {
        messageId: null,
        question,
        options: options.map(label => ({ label, votes: [] })),
        creatorName: message.author.username,
        endsAt: new Date(Date.now() + POLL_DURATION_MS),
        footerTag: getRandomFooter()
      };

      // Delete the command message
      try {
        await message.delete();
        commandDeleted = true;
      } catch {
        // Missing permission or already deleted
      }

      // The buttons stay disabled until the poll is stored, so no vote can arrive before its record
      const pollMsg = await message.channel.send({
        embeds: [buildPollEmbed(draft)],
        components: [buildVoteRow(draft, { disabled: true })]
      });

      let poll;
      try {
        poll = (await Poll.create({
          ...draft,
          guildId,
          channelId: message.channel.id,
          messageId: pollMsg.id,
          creatorId: message.author.id
        })).toObject();
      } catch (error) {
        await pollMsg.delete().catch(() => { });
        throw error;
      }

      // Show the poll ID in the footer and open voting
      try {
        await pollMsg.edit({ embeds: [buildPollEmbed(poll)], components: [buildVoteRow(poll)] });
      } catch (error) {
        // Deleted straight away; the stored poll is ended by the expiry sweep
        console.error('[Poll] Failed to open the poll for voting:', error);
      }
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

async function endPoll(message, messageId) {
  const guildId = message.guild.id;

  if (!messageId || !SNOWFLAKE.test(messageId)) {
    const prefix = await getPrefix(guildId);
    const embed = await errorEmbed(guildId, 'Invalid Poll ID',
      `Please provide the poll ID shown in the poll footer, Master.\n\n**Usage:** \`${prefix}poll end <pollId>\``
    );
    return message.reply({ embeds: [embed] });
  }

  const poll = await Poll.findOne({ messageId, guildId }).lean();

  if (!poll) {
    const embed = await errorEmbed(guildId, 'Poll Not Found',
      'No poll with that ID exists in this server, Master. Use the poll ID shown in the poll footer.'
    );
    return message.reply({ embeds: [embed] });
  }

  const alreadyConcluded = async () => message.reply({
    embeds: [await errorEmbed(guildId, 'Poll Already Concluded',
      'That poll has already concluded, Master. Its final results are shown on the poll.')]
  });

  if (poll.ended) return alreadyConcluded();

  // Check permissions
  const isModerator = message.member.permissions.has(PermissionFlagsBits.ManageMessages);
  if (poll.creatorId !== message.author.id && !isModerator) {
    const embed = await errorEmbed(guildId, 'Permission Denied',
      'Only the poll creator or a member with **Manage Messages** may end this poll, Master.'
    );
    return message.reply({ embeds: [embed] });
  }

  const result = await concludePoll(message.client, { messageId, guildId });

  // Ended by its expiry (or another moderator) in the meantime
  if (!result.concluded) return alreadyConcluded();

  if (result.message !== 'edited') {
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
