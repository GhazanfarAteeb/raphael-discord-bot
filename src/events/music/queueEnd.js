/**
 * Music Queue End Event Handler
 * Handles when the queue is empty
 */

import Event from "../../structures/Event.js";
import { infoEmbed } from "../../utils/embeds.js";
import musicConfig from "../../music/config.js";
import { clearNowPlaying, scheduleAutoLeave } from "../../music/RiffyManager.js";

const NOTICE_LIFETIME_MS = 30000;
const MS_PER_MINUTE = 60000;

class MusicQueueEnd extends Event {
  constructor(client, file) {
    super(client, file, {
      name: "musicQueueEnd",
    });
  }

  async run(player) {
    try {
      await clearNowPlaying(player);
      if (player.destroyed) return;

      const autoLeave = musicConfig.autoLeave ?? {};
      const leaveEnabled = autoLeave.enabled !== false;
      const timeout = autoLeave.timeout ?? 300000;

      if (leaveEnabled) {
        // Leave only if nothing has been queued or resumed by the time the countdown ends
        // (trackStart also cancels it as soon as playback resumes).
        scheduleAutoLeave(
          this.client,
          player.guildId,
          "queueEnd",
          timeout,
          (current) => !current.playing && !current.current && current.queue.isEmpty,
        );
      }

      const channel = this.client.channels.cache.get(player.textChannelId);
      if (!channel) return;

      const minutes = Math.max(1, Math.round(timeout / MS_PER_MINUTE));
      const description = leaveEnabled
        ? `**Notice:** The playback queue has concluded, Master. I will disconnect in ${minutes} minute${minutes !== 1 ? "s" : ""} unless further tracks are queued.`
        : "**Notice:** The playback queue has concluded, Master. Further tracks may be queued with `play`.";

      const msg = await channel.send({
        embeds: [await infoEmbed(player.guildId, "Queue Concluded", description)],
      });

      setTimeout(() => {
        msg.delete().catch(() => {});
      }, NOTICE_LIFETIME_MS);
    } catch (error) {
      this.client.logger.error("Error in musicQueueEnd event:", error);
    }
  }
}

export default MusicQueueEnd;
