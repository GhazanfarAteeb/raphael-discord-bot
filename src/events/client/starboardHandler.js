import { Events, EmbedBuilder } from 'discord.js';
import Guild from '../../models/Guild.js';
import StarboardEntry from '../../models/StarboardEntry.js';
import { GLYPHS } from '../../utils/embeds.js';

const DEFAULT_STAR_EMOJI = '⭐';
const DEFAULT_THRESHOLD = 3;
const DESCRIPTION_MAX = 4000;

// Discord API error codes
const UNKNOWN_MESSAGE = 10008;

// Reactions on one message are handled one at a time, so two stars arriving together
// cannot both create a starboard post
const messageQueues = new Map(); // original message id -> tail of its promise chain

function runExclusive(messageId, task) {
  const previous = messageQueues.get(messageId) ?? Promise.resolve();
  const current = previous.catch(() => { }).then(task);
  const tail = current.catch(() => { });
  messageQueues.set(messageId, tail);
  tail.then(() => {
    if (messageQueues.get(messageId) === tail) messageQueues.delete(messageId);
  });
  return current;
}

export default {
  name: Events.MessageReactionAdd,
  async execute(reaction, user) {
    // Ignore bot reactions
    if (user.bot) return;

    try {
      await runExclusive(reaction.message.id, () => handleReactionAdd(reaction, user));
    } catch (error) {
      console.error('[Starboard] Error handling star reaction:', error);
    }
  }
};

// The configured star emoji (a server setting: data, not bot text)
function isStarReaction(reaction, starEmoji) {
  return reaction.emoji.name === starEmoji || reaction.emoji.toString() === starEmoji;
}

// Fetch whatever the reaction event left partial
async function resolveReaction(reaction) {
  if (reaction.partial) await reaction.fetch();
  if (reaction.message.partial) await reaction.message.fetch();
}

// The starboard post's text line: the configured star emoji with the count is data
function starLine(starEmoji, count, channelId) {
  return `${starEmoji} **${count}** ${GLYPHS.DOT} <#${channelId}>`;
}

async function handleReactionAdd(reaction, user) {
  const guild = reaction.message.guild;
  if (!guild) return;

  const guildConfig = await Guild.getGuild(guild.id, guild.name);
  const starboard = guildConfig?.features?.starboard;

  // Check if starboard is enabled
  if (!starboard?.enabled) return;

  // Check if it's the star emoji (known without fetching)
  const starEmoji = starboard.emoji || DEFAULT_STAR_EMOJI;
  if (!isStarReaction(reaction, starEmoji)) return;

  // Check if channel is ignored
  if (starboard.ignoredChannels?.includes(reaction.message.channelId)) return;

  // Check if it's the starboard channel (prevent starring starboard messages)
  if (reaction.message.channelId === starboard.channel) return;

  await resolveReaction(reaction);
  const message = reaction.message;

  // Check for self-starring
  if (!starboard.selfStar && message.author?.id === user.id) {
    // Remove the reaction
    await reaction.users.remove(user.id).catch(() => { });
    return;
  }

  // Get reaction count
  const reactionCount = reaction.count;

  // Check threshold
  if (reactionCount < (starboard.threshold || DEFAULT_THRESHOLD)) return;

  const starboardChannel = guild.channels.cache.get(starboard.channel);
  if (!starboardChannel) return;

  // Check if already on starboard
  let entry = await StarboardEntry.findByOriginalMessage(guild.id, message.id);

  if (entry) {
    // Update existing entry
    if (!entry.starrers.includes(user.id)) {
      entry.starrers.push(user.id);
    }
    entry.starCount = reactionCount;
    await entry.save();

    // Update starboard message
    try {
      const starboardMessage = await starboardChannel.messages.fetch(entry.starboardMessageId);
      await starboardMessage.edit({
        content: starLine(starEmoji, reactionCount, message.channelId),
        embeds: [createStarboardEmbed(message, reactionCount)]
      });
      return;
    } catch (error) {
      if (error.code !== UNKNOWN_MESSAGE) {
        console.error('[Starboard] Error updating starboard message:', error);
        return;
      }
      // The post was deleted by hand: drop the stale entry and post it again
      await StarboardEntry.findByIdAndDelete(entry._id);
      entry = null;
    }
  }

  // Create new starboard entry
  const starboardMessage = await starboardChannel.send({
    content: starLine(starEmoji, reactionCount, message.channelId),
    embeds: [createStarboardEmbed(message, reactionCount)]
  });

  await StarboardEntry.create({
    guildId: guild.id,
    originalMessageId: message.id,
    originalChannelId: message.channelId,
    starboardMessageId: starboardMessage.id,
    authorId: message.author.id,
    starCount: reactionCount,
    starrers: [user.id]
  });
}

function createStarboardEmbed(message, starCount) {
  const embed = new EmbedBuilder()
    .setColor(getStarColor(starCount))
    .setAuthor({
      name: message.author.tag,
      iconURL: message.author.displayAvatarURL()
    })
    .setTimestamp(message.createdTimestamp)
    .setFooter({ text: `ID: ${message.id}` });

  // Add message content
  if (message.content) {
    embed.setDescription(message.content.slice(0, DESCRIPTION_MAX));
  }

  // Add image if present
  const attachment = message.attachments.first();
  if (attachment && attachment.contentType?.startsWith('image/')) {
    embed.setImage(attachment.url);
  }

  // Check for embeds with images
  if (message.embeds.length > 0) {
    const embedImage = message.embeds[0].image || message.embeds[0].thumbnail;
    if (embedImage && !embed.data.image) {
      embed.setImage(embedImage.url);
    }
  }

  // Add jump link
  embed.addFields({
    name: `${GLYPHS.ARROW_RIGHT} Source`,
    value: `[Jump to message](${message.url})`
  });

  return embed;
}

// Get color based on star count
function getStarColor(count) {
  if (count >= 20) return '#FFD700'; // Gold
  if (count >= 15) return '#FFA500'; // Orange
  if (count >= 10) return '#FFFF00'; // Yellow
  if (count >= 5) return '#FFFACD';  // Light yellow
  return '#FFFFFF'; // White
}

// Export handler for reaction remove
export async function handleReactionRemove(reaction, user) {
  if (user.bot) return;

  try {
    await runExclusive(reaction.message.id, () => handleStarRemoved(reaction, user));
  } catch (error) {
    console.error('[Starboard] Error handling star removal:', error);
  }
}

async function handleStarRemoved(reaction, user) {
  const guild = reaction.message.guild;
  if (!guild) return;

  const guildConfig = await Guild.getGuild(guild.id, guild.name);
  const starboard = guildConfig?.features?.starboard;

  if (!starboard?.enabled) return;

  const starEmoji = starboard.emoji || DEFAULT_STAR_EMOJI;
  if (!isStarReaction(reaction, starEmoji)) return;

  const entry = await StarboardEntry.findByOriginalMessage(guild.id, reaction.message.id);
  if (!entry) return;

  await resolveReaction(reaction);
  const message = reaction.message;
  const reactionCount = reaction.count ?? 0;

  // Remove from starrers
  entry.starrers = entry.starrers.filter(id => id !== user.id);
  entry.starCount = reactionCount;
  await entry.save();

  const starboardChannel = guild.channels.cache.get(starboard.channel);
  if (!starboardChannel) return;

  try {
    const starboardMessage = await starboardChannel.messages.fetch(entry.starboardMessageId);

    // If below threshold, delete from starboard
    if (reactionCount < (starboard.threshold || DEFAULT_THRESHOLD)) {
      await starboardMessage.delete();
      await StarboardEntry.findByIdAndDelete(entry._id);
    } else {
      // Update count
      await starboardMessage.edit({
        content: starLine(starEmoji, reactionCount, message.channelId),
        embeds: [createStarboardEmbed(message, reactionCount)]
      });
    }
  } catch (error) {
    if (error.code === UNKNOWN_MESSAGE) {
      // The post was deleted by hand
      await StarboardEntry.findByIdAndDelete(entry._id);
      return;
    }
    console.error('[Starboard] Error handling reaction remove:', error);
  }
}
