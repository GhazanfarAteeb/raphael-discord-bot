import { Events, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags, escapeMarkdown } from 'discord.js';
import Afk from '../../models/Afk.js';
import Guild from '../../models/Guild.js';
import { createEmbed, infoEmbed, errorEmbed, GLYPHS } from '../../utils/embeds.js';

// URL regex pattern
const urlRegex = /(https?:\/\/[^\s]+)/gi;

// Image URL pattern - handles query strings like ?size=4096
const imageUrlPattern = /\.(png|jpg|jpeg|gif|webp)($|\?)/i;

// Nickname tag applied by the afk command
export const AFK_NICKNAME_TAG = '[AFK]';

const MENTIONS_PER_PAGE = 5;
const MENTION_PREVIEW_LENGTH = 40;
const PAGINATION_TIMEOUT = 5 * 60 * 1000;
const MAX_LINK_FIELDS = 5;
const MAX_REASON_LENGTH = 1500;
const MAX_NOTICES_PER_MESSAGE = 5;
const EMBED_DESCRIPTION_LIMIT = 4096;
const FIELD_VALUE_LIMIT = 1024;

export default {
  name: Events.MessageCreate,
  async execute(message, client) {
    // Skip bots and DMs
    if (message.author.bot || !message.guild) return;

    try {
      const guildConfig = await Guild.getGuild(message.guild.id, message.guild.name);

      await handleAuthorReturn(message, client, guildConfig);
      await handleAfkMentions(message);
    } catch (error) {
      console.error('[AFK] Error in AFK handler:', error);
    }
  }
};

/**
 * Clear the author's away status when they speak again
 */
async function handleAuthorReturn(message, client, guildConfig) {
  const authorAfk = await Afk.getAfk(message.guild.id, message.author.id);
  if (!authorAfk) return;

  // Sticky statuses persist through messages until `afk off` or their scheduled return
  if (authorAfk.autoRemove === false && !authorAfk.isExpired()) return;

  // The afk command manages the status itself (updating the reason, or `afk off`)
  if (isAfkCommand(message, client, guildConfig)) return;

  // Only the call that actually deletes the record announces the return (no duplicates on rapid messages)
  const removed = await Afk.removeAfk(message.guild.id, message.author.id);
  if (!removed) return;

  await restoreAfkNickname(message.member, removed);
  await sendAfkReturnSummary(message, removed);
}

/**
 * Record mentions of away members and tell the channel they are away
 */
async function handleAfkMentions(message) {
  const mentionedIds = [...message.mentions.users.values()]
    .filter((user) => user.id !== message.author.id && !user.bot)
    .map((user) => user.id);
  if (mentionedIds.length === 0) return;

  const records = await Afk.getAfkUsers(message.guild.id, mentionedIds);
  // A status past its scheduled return no longer counts as away
  const awayRecords = records.filter((record) => !record.isExpired());
  if (awayRecords.length === 0) return;

  await Afk.addMention(message.guild.id, awayRecords.map((record) => record.odId), {
    odId: message.author.id,
    username: message.author.username,
    channelId: message.channel.id,
    messageId: message.id,
    messageContent: message.content.slice(0, 100),
    timestamp: new Date()
  });

  for (const record of awayRecords.slice(0, MAX_NOTICES_PER_MESSAGE)) {
    const user = message.mentions.users.get(record.odId);
    if (!user) continue;

    const embed = await buildAwayNotice(message.guild.id, user, record);
    // Use channel.send instead of reply in case message was deleted by automod
    await message.channel.send({ embeds: [embed] }).catch(() => { });
  }

  const remaining = awayRecords.slice(MAX_NOTICES_PER_MESSAGE);
  if (remaining.length > 0) {
    const names = remaining
      .map((record) => message.mentions.users.get(record.odId))
      .filter(Boolean)
      .map((user) => `**${escapeMarkdown(user.username)}**`)
      .join(', ');
    const embed = await infoEmbed(message.guild.id, 'Away Status',
      truncate(`${GLYPHS.ARROW_RIGHT} ${remaining.length} more mentioned member(s) are also away, Master: ${names}`, EMBED_DESCRIPTION_LIMIT));
    await message.channel.send({ embeds: [embed] }).catch(() => { });
  }
}

/**
 * Notice shown when someone mentions an away member
 */
async function buildAwayNotice(guildId, user, record) {
  const { text, links } = splitAwayReason(record.reason);

  const lines = [
    `${GLYPHS.ARROW_RIGHT} **${escapeMarkdown(user.username)}** is currently away, Master.`,
    `${GLYPHS.ARROW_RIGHT} **Away for:** ${formatDuration(Date.now() - new Date(record.timestamp).getTime())}`
  ];
  if (record.scheduledReturn) {
    lines.push(`${GLYPHS.ARROW_RIGHT} **Expected return:** <t:${Math.floor(new Date(record.scheduledReturn).getTime() / 1000)}:R>`);
  }
  if (text) {
    lines.push(`${GLYPHS.ARROW_RIGHT} **Reason:** ${truncate(text, MAX_REASON_LENGTH)}`);
  }

  const embed = await createEmbed(guildId, 'info');
  embed
    .setTitle('『 Away Status 』')
    .setAuthor({
      name: truncate(user.username, 256),
      iconURL: user.displayAvatarURL()
    })
    .setDescription(truncate(lines.join('\n'), EMBED_DESCRIPTION_LIMIT));

  addAwayLinks(embed, links);
  return embed;
}

/**
 * Post the "welcome back" summary (duration plus paginated mentions) for a removed AFK record.
 * manual = true when the member cleared the status with `afk off` (replies instead of pinging).
 */
export async function sendAfkReturnSummary(message, afkRecord, { manual = false } = {}) {
  const guildId = message.guild.id;
  const authorId = message.author.id;

  // A status that lapsed at its scheduled return only counts up to that time
  const endTime = afkRecord.isExpired?.()
    ? new Date(afkRecord.scheduledReturn).getTime()
    : Date.now();
  const durationText = formatDuration(endTime - new Date(afkRecord.timestamp).getTime());

  const mentions = [...(afkRecord.mentions || [])];
  const totalMentions = Math.max(afkRecord.totalMentions || 0, mentions.length);
  const totalPages = Math.max(1, Math.ceil(mentions.length / MENTIONS_PER_PAGE));

  const buildPage = async (page) => {
    let description = manual
      ? `${GLYPHS.SUCCESS} Your away status has been cleared, Master. You were away for **${durationText}**.`
      : `${GLYPHS.SUCCESS} Welcome back, ${message.author}. You were away for **${durationText}**, Master.`;

    if (mentions.length > 0) {
      description += `\n\n${GLYPHS.ARROW_RIGHT} **You were mentioned ${totalMentions} time(s) while away:**`;
      if (totalMentions > mentions.length) {
        description += `\n*Showing the ${mentions.length} most recent.*`;
      }

      const pageMentions = mentions.slice(page * MENTIONS_PER_PAGE, (page + 1) * MENTIONS_PER_PAGE);
      for (const mention of pageMentions) {
        const content = String(mention.messageContent || '').replace(/\s+/g, ' ').trim();
        const preview = content.length > MENTION_PREVIEW_LENGTH
          ? `${content.slice(0, MENTION_PREVIEW_LENGTH)}...`
          : content;
        const sentAt = Math.floor(new Date(mention.timestamp).getTime() / 1000);
        const jumpLink = `https://discord.com/channels/${guildId}/${mention.channelId}/${mention.messageId}`;

        description += `\n${GLYPHS.DOT} **${escapeMarkdown(mention.username || 'Unknown')}** in <#${mention.channelId}> (<t:${sentAt}:R>)`;
        description += `\n› "${preview || 'No text content'}" [Jump](${jumpLink})`;
      }

      if (totalPages > 1) {
        description += `\n\n${GLYPHS.DOT} Page ${page + 1}/${totalPages}`;
      }
    }

    return await infoEmbed(guildId, manual ? 'Away Status Cleared' : 'Welcome Back',
      truncate(description, EMBED_DESCRIPTION_LIMIT));
  };

  const buildButtons = (page, paginationDisabled = false) => {
    const row = new ActionRowBuilder();

    // Pagination buttons only if there are multiple pages
    if (totalPages > 1) {
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(`afk_prev_${authorId}`)
          .setLabel('Previous')
          .setStyle(ButtonStyle.Primary)
          .setDisabled(paginationDisabled || page === 0),
        new ButtonBuilder()
          .setCustomId(`afk_next_${authorId}`)
          .setLabel('Next')
          .setStyle(ButtonStyle.Primary)
          .setDisabled(paginationDisabled || page >= totalPages - 1)
      );
    }

    // Dismiss is handled by afkButtonHandler.js
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`afk_dismiss_${authorId}`)
        .setLabel('Dismiss')
        .setStyle(ButtonStyle.Secondary)
    );

    return row;
  };

  const payload = {
    embeds: [await buildPage(0)],
    components: [buildButtons(0)]
  };

  const sentMessage = manual
    ? await message.reply(payload).catch(() => message.channel.send(payload)).catch(() => null)
    : await message.channel.send({
      ...payload,
      content: `<@${authorId}>`,
      allowedMentions: { users: [authorId] }
    }).catch(() => null);

  if (!sentMessage || totalPages <= 1) return;

  let currentPage = 0;
  const collector = sentMessage.createMessageComponentCollector({
    filter: (i) => i.customId === `afk_prev_${authorId}` || i.customId === `afk_next_${authorId}`,
    time: PAGINATION_TIMEOUT
  });

  collector.on('collect', async (interaction) => {
    try {
      if (interaction.user.id !== authorId) {
        await interaction.reply({
          embeds: [await errorEmbed(guildId, 'Access Denied', 'These controls belong to the returning member, Master.')],
          flags: MessageFlags.Ephemeral
        });
        return;
      }

      currentPage = interaction.customId.startsWith('afk_prev_')
        ? Math.max(0, currentPage - 1)
        : Math.min(totalPages - 1, currentPage + 1);

      await interaction.update({
        embeds: [await buildPage(currentPage)],
        components: [buildButtons(currentPage)]
      });
    } catch (error) {
      console.error('[AFK] Pagination error:', error);
      if (!interaction.replied && !interaction.deferred) {
        try {
          await interaction.reply({
            embeds: [await errorEmbed(guildId, 'Page Error', 'The requested page could not be displayed, Master.')],
            flags: MessageFlags.Ephemeral
          });
        } catch {
          // Interaction expired or was already acknowledged
        }
      }
    }
  });

  collector.on('end', () => {
    // Disable pagination when the collector ends; Dismiss stays usable
    sentMessage.edit({ components: [buildButtons(currentPage, true)] }).catch(() => { });
  });
}

/**
 * Remove the [AFK] nickname tag, restoring the nickname recorded when the status began.
 * Without a record, only the tag is stripped.
 */
export async function restoreAfkNickname(member, afkRecord = null) {
  try {
    if (!member?.manageable) return;

    const nickname = member.nickname;
    if (!nickname?.startsWith(AFK_NICKNAME_TAG)) return;

    const restored = afkRecord
      ? afkRecord.originalNickname ?? null
      : nickname.slice(AFK_NICKNAME_TAG.length).trim() || null;

    await member.setNickname(restored, 'Away status cleared');
  } catch {
    // Can't change nickname (permissions/hierarchy); that's fine
  }
}

/**
 * Clear AFK statuses whose scheduled return (--time) has passed and restore nicknames.
 * Intended to be called periodically from src/utils/schedulers.js.
 */
let expiryCheckRunning = false;
export async function expireScheduledAfks(client) {
  if (expiryCheckRunning) return;
  expiryCheckRunning = true;

  try {
    const due = await Afk.getScheduledReturns();

    for (const record of due) {
      try {
        // Re-check the time so a status re-set since the query is not removed
        const removed = await Afk.findOneAndDelete({ _id: record._id, scheduledReturn: { $lte: new Date() } });
        if (!removed) continue;

        const guild = client.guilds.cache.get(removed.guildId);
        if (!guild) continue;

        const member = await guild.members.fetch(removed.odId).catch(() => null);
        await restoreAfkNickname(member, removed);
      } catch (error) {
        console.error(`[AFK] Failed to expire AFK status ${record._id}:`, error);
      }
    }
  } catch (error) {
    console.error('[AFK] Scheduled return check failed:', error);
  } finally {
    expiryCheckRunning = false;
  }
}

/**
 * Split an AFK reason into its plain text and its links
 */
export function splitAwayReason(reason) {
  const value = String(reason || '');
  return {
    links: value.match(urlRegex) || [],
    text: value.replace(urlRegex, '').trim()
  };
}

/**
 * Add link fields (capped, values truncated) and an image preview to an embed
 */
export function addAwayLinks(embed, links) {
  if (!links?.length) return embed;

  const shown = links.slice(0, MAX_LINK_FIELDS);
  shown.forEach((link, index) => {
    embed.addFields({
      name: getLinkTitle(link, index, links.length),
      value: truncate(link, FIELD_VALUE_LIMIT),
      inline: false
    });
  });

  if (links.length > shown.length) {
    embed.addFields({
      name: `${GLYPHS.ARROW_RIGHT} Additional Links`,
      value: `And ${links.length - shown.length} more link(s) not shown.`,
      inline: false
    });
  }

  // If one of the links is an image, preview it
  const imageLink = links.find((link) => imageUrlPattern.test(link));
  if (imageLink && imageLink.length <= 2048) {
    embed.setImage(imageLink);
  }

  return embed;
}

/**
 * Truncate text to a Discord limit
 */
export function truncate(text, max) {
  const value = String(text ?? '');
  return value.length > max ? `${value.slice(0, max - 3)}...` : value;
}

/**
 * Whether this message invokes the afk command (by prefix or bot mention, any alias)
 */
function isAfkCommand(message, client, guildConfig) {
  if (!client?.user || !client.commands) return false;

  const prefix = guildConfig?.prefix || process.env.DEFAULT_PREFIX || '!';
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = message.content.match(new RegExp(`^(<@!?${client.user.id}>|${escaped})\\s*`, 'i'));
  if (!match) return false;

  const commandName = message.content.slice(match[0].length).trim().split(/ +/)[0]?.toLowerCase();
  if (!commandName) return false;

  const command = client.commands.get(commandName) || client.commands.get(client.aliases?.get(commandName));
  if (command?.name !== 'afk') return false;

  // A disabled afk command cannot clear the status, so let the message do it
  return !guildConfig?.textCommands?.disabledCommands?.includes('afk');
}

/**
 * Format duration in human readable format
 */
function formatDuration(ms) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

/**
 * Get a title for a link based on its domain
 */
function getLinkTitle(link, index, totalLinks) {
  let host = '';
  try {
    host = new URL(link).hostname.toLowerCase();
  } catch {
    // Not a parsable URL; falls through to the generic label
  }
  const onDomain = (...domains) => domains.some((domain) => host === domain || host.endsWith(`.${domain}`));

  let label = 'Link';
  if (onDomain('youtube.com', 'youtu.be')) label = 'YouTube';
  else if (onDomain('twitter.com', 'x.com')) label = 'Twitter/X';
  else if (onDomain('github.com')) label = 'GitHub';
  else if (onDomain('discord.gg', 'discord.com')) label = 'Discord';
  else if (onDomain('twitch.tv')) label = 'Twitch';
  else if (onDomain('instagram.com')) label = 'Instagram';
  else if (onDomain('tiktok.com')) label = 'TikTok';
  else if (onDomain('spotify.com')) label = 'Spotify';
  else if (imageUrlPattern.test(link)) label = 'Image';

  return `${GLYPHS.ARROW_RIGHT} ${label}${totalLinks > 1 ? ` ${index + 1}` : ''}`;
}
