/**
 * Music Track Start Event Handler
 * Sends now playing message with buttons when a track starts
 */

import Event from "../../structures/Event.js";
import { EmbedBuilder } from "discord.js";
import { COLORS } from "../../utils/embeds.js";
import { getRandomFooter } from "../../utils/raphael.js";
import {
  buildControlRow,
  formatTrackDuration,
  safeUrl,
  truncate,
  DISCORD_LIMITS,
} from "../../music/format.js";
import { cancelAutoLeave, clearNowPlaying } from "../../music/RiffyManager.js";

class MusicTrackStart extends Event {
  constructor(client, file) {
    super(client, file, {
      name: "musicTrackStart",
    });
  }

  async run(player, track) {
    try {
      // Playback resumed: the queue-end countdown no longer applies
      cancelAutoLeave(player.guildId, "queueEnd");
      // A new playback may report its own errors (see trackError.js)
      player.lastErrorTrack = null;

      const channel = this.client.channels.cache.get(player.textChannelId);
      if (!channel) return;

      const embed = new EmbedBuilder()
        .setColor(COLORS.RAPHAEL)
        .setAuthor({ name: "『 Audio Playback Initiated 』" })
        .setTitle(truncate(track.title || "Unknown Track", DISCORD_LIMITS.TITLE))
        .setURL(safeUrl(track.uri))
        .setThumbnail(safeUrl(track.thumbnail))
        .addFields(
          {
            name: "▸ Duration",
            value: formatTrackDuration(track),
            inline: true,
          },
          {
            name: "▸ Author",
            value: truncate(track.author || "Unknown", DISCORD_LIMITS.FIELD_VALUE),
            inline: true,
          },
          {
            name: "▸ Requested By",
            value: track.requester?.toString() || "Unknown",
            inline: true,
          },
        )
        .setFooter({ text: getRandomFooter() })
        .setTimestamp();

      // Remove the previous card (if trackEnd has not already) before posting the new one
      await clearNowPlaying(player);

      const msg = await channel.send({
        embeds: [embed],
        components: [buildControlRow(player)],
      });

      // The player may have been destroyed while the message was being sent
      if (player.destroyed) {
        await msg.delete().catch(() => {});
        return;
      }

      // Store message reference in player
      player.message = msg;
    } catch (error) {
      this.client.logger.error("Error in musicTrackStart event:", error);
    }
  }
}

export default MusicTrackStart;
