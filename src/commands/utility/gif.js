import { getPrefix, escapeMarkdown, truncate } from '../../utils/helpers.js';
import { errorEmbed, infoEmbed, warningEmbed } from '../../utils/embeds.js';

const TENOR_SEARCH_URL = 'https://tenor.googleapis.com/v2/search';
const FETCH_TIMEOUT_MS = 10000;
const RESULT_LIMIT = 50;
// Pick from the most relevant results only, for variety without drifting off-topic
const RANDOM_POOL = 20;
// Shown query length (titles allow 256 characters, the frame adds 4)
const QUERY_DISPLAY_MAX = 200;

export default {
  name: 'gif',
  description: 'Search and retrieve animated images from Tenor, Master',
  usage: 'gif <search query>',
  aliases: ['giphy', 'tenor'],
  category: 'utility',
  cooldown: 3,

  execute: async (message, args) => {
    const guildId = message.guild.id;

    try {
      if (!args.length) {
        const prefix = await getPrefix(guildId);
        return message.reply({
          embeds: [await warningEmbed(guildId, 'Query Required', `A search query is required, Master.\nUsage: \`${prefix}gif <search term>\``)]
        });
      }

      // The key must come from the environment; it is never logged or shown
      const apiKey = process.env.TENOR_API_KEY;
      if (!apiKey) {
        return message.reply({
          embeds: [await warningEmbed(
            guildId,
            'Service Unavailable',
            'GIF search is not configured on this instance, Master. The bot owner must provide a Tenor API key (`TENOR_API_KEY`) to enable it.'
          )]
        });
      }

      const searchQuery = args.join(' ');
      const titleQuery = truncate(searchQuery, QUERY_DISPLAY_MAX);
      const shownQuery = escapeMarkdown(titleQuery);

      const params = new URLSearchParams({
        q: searchQuery,
        key: apiKey,
        client_key: 'jura_bot',
        limit: String(RESULT_LIMIT),
        media_filter: 'gif',
        contentfilter: 'medium',
        ar_range: 'standard'
      });

      let response;
      try {
        response = await fetch(`${TENOR_SEARCH_URL}?${params}`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      } catch (error) {
        // Log only the failure reason: the request URL carries the API key
        console.error('[gif] Tenor request failed:', error?.cause?.code || error?.name || 'unknown error');
        return message.reply({
          embeds: [await warningEmbed(guildId, 'Retrieval Failed', 'The Tenor archive could not be reached, Master. Please retry shortly.')]
        });
      }

      if (!response.ok) {
        console.error(`[gif] Tenor responded with status ${response.status}`);
        const keyRejected = [400, 401, 403].includes(response.status);
        return message.reply({
          embeds: [await warningEmbed(
            guildId,
            'Retrieval Failed',
            keyRejected
              ? 'The Tenor service rejected this request, Master. The configured API key may be invalid or restricted; the bot owner should review it.'
              : 'The Tenor service is currently unavailable, Master. Please retry shortly.'
          )]
        });
      }

      let data;
      try {
        data = await response.json();
      } catch {
        console.error('[gif] Tenor returned a malformed response');
        return message.reply({
          embeds: [await warningEmbed(guildId, 'Retrieval Failed', 'The Tenor service returned an unreadable response, Master. Please retry shortly.')]
        });
      }

      const results = Array.isArray(data?.results)
        ? data.results.filter(result => result?.media_formats?.gif?.url)
        : [];

      if (results.length === 0) {
        return message.reply({
          embeds: [await infoEmbed(
            guildId,
            'No Results',
            `**Analysis:** No results were found for **${shownQuery}**, Master.\n\n` +
            '**Suggestions:**\n' +
            '◇ Try simpler or more common terms\n' +
            '◇ Use English keywords\n' +
            '◇ Try related words (e.g., "happy" instead of "joyful")\n' +
            '◇ Verify spelling'
          )]
        });
      }

      const randomGif = results[Math.floor(Math.random() * Math.min(results.length, RANDOM_POOL))];

      const embed = await infoEmbed(
        guildId,
        titleQuery,
        `**Analysis:** Animated image retrieved for **${shownQuery}**, Master.\n› Powered by Tenor • selected from ${results.length} result${results.length === 1 ? '' : 's'}`
      );
      embed.setImage(randomGif.media_formats.gif.url);

      return message.reply({ embeds: [embed] });

    } catch (error) {
      console.error('[gif] Command error:', error?.message || error);
      try {
        await message.reply({
          embeds: [await errorEmbed(guildId, 'Retrieval Failed', 'GIF acquisition failed, Master. The external service may be unavailable. Please retry.')]
        });
      } catch {
        // Reply failed too (message deleted or no permission); nothing more to do
      }
    }
  }
};
