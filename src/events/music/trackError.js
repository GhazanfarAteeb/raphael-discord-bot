/**
 * Music Track Error Event Handler
 * Handles errors during track playback
 */

import Event from "../../structures/Event.js";
import { errorEmbed } from "../../utils/embeds.js";
import { truncate } from "../../music/format.js";

const MAX_TITLE_LENGTH = 200;
const MAX_REASON_LENGTH = 300;

class MusicTrackError extends Event {
  constructor(client, file) {
    super(client, file, {
      name: "musicTrackError",
    });
  }

  async run(player, track, payload) {
    try {
      this.client.logger.error(`Track error for ${track?.title}:`, payload);

      // moonlink may report several exceptions for one track; announce it once
      const trackKey = track?.encoded ?? track?.title;
      if (trackKey && player.lastErrorTrack === trackKey) return;
      player.lastErrorTrack = trackKey;

      const channel = this.client.channels.cache.get(player.textChannelId);
      if (!channel) return;

      const exception = payload?.exception;
      const reason = exception?.message
        ? `\n\n▸ **Reason:** ${truncate(exception.message, MAX_REASON_LENGTH)}`
        : "";

      // moonlink abandons the track on a fatal ("fault") exception; otherwise it keeps
      // playing and only skips after repeated exceptions, so the outcome is stated as such.
      const outcome =
        exception?.severity === "fault"
          ? "The track has been abandoned; playback proceeds to the next queue entry, if any."
          : "Playback continues if the audio node recovers; otherwise the next queue entry will follow.";

      await channel.send({
        embeds: [
          await errorEmbed(
            player.guildId,
            "Playback Error",
            `**Error:** Track processing failure detected for **${truncate(track?.title || "Unknown Track", MAX_TITLE_LENGTH)}**, Master.${reason}\n\n**Notice:** ${outcome}`,
          ),
        ],
      });
    } catch (error) {
      this.client.logger.error("Error in musicTrackError event:", error);
    }
  }
}

export default MusicTrackError;
