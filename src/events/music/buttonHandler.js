/**
 * Music Button Interaction Handler
 * Handles button clicks for music controls
 */

import Event from "../../structures/Event.js";
import { MessageFlags } from "discord.js";
import { buildControlRow, truncate } from "../../music/format.js";
import { clearNowPlaying, skipCurrent } from "../../music/RiffyManager.js";

const LOOP_CYCLE = { off: "track", track: "queue", queue: "off" };
const LOOP_MESSAGES = {
  off: "**Confirmed.** Repeat mode disabled, Master.",
  track: "**Confirmed.** Now repeating the current track, Master.",
  queue: "**Confirmed.** Now repeating the entire queue, Master.",
};
const MAX_TITLE_LENGTH = 200;

class MusicButtonHandler extends Event {
  constructor(client, file) {
    super(client, file, {
      name: "interactionCreate",
    });
  }

  async run(interaction) {
    // Only handle music control buttons
    if (!interaction.isButton() || !interaction.customId.startsWith("music_")) return;

    try {
      const player = this.client.moonlink?.players.get(interaction.guildId);

      if (!player || player.destroyed) {
        return await this.notify(
          interaction,
          "**Warning:** No active audio session detected, Master.",
        );
      }

      // Check if user is in voice channel
      const memberChannel = interaction.member?.voice?.channelId;
      const clientChannel = interaction.guild?.members?.me?.voice?.channelId;

      if (!memberChannel) {
        return await this.notify(
          interaction,
          "**Warning:** Voice channel presence required for this function, Master.",
        );
      }

      if (clientChannel && memberChannel !== clientChannel) {
        return await this.notify(
          interaction,
          "**Warning:** Voice channel synchronization required, Master. Please join my current channel.",
        );
      }

      await interaction.deferUpdate();

      switch (interaction.customId) {
        case "music_pause":
          await this.handlePause(interaction, player);
          break;
        case "music_play":
          await this.handleResume(interaction, player);
          break;
        case "music_skip":
          await this.handleSkip(interaction, player);
          break;
        case "music_disconnect":
          await this.handleDisconnect(interaction, player);
          break;
        case "music_shuffle":
          await this.handleShuffle(interaction, player);
          break;
        case "music_loop":
          await this.handleLoop(interaction, player);
          break;
      }
    } catch (error) {
      this.client.logger.error("Error handling music button:", error);
      await this.notify(
        interaction,
        "**Error:** Processing failure detected. Please retry, Master.",
      );
    }
  }

  /**
   * Ephemeral notice that works whether or not the interaction was already acknowledged.
   */
  async notify(interaction, content) {
    const payload = { content, flags: MessageFlags.Ephemeral };
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.followUp(payload);
      } else {
        await interaction.reply(payload);
      }
    } catch (error) {
      this.client.logger.error("Failed to send music button notice:", error);
    }
  }

  /**
   * Redraws the control buttons from the player's actual state.
   */
  async refreshControls(interaction, player) {
    await interaction.message
      .edit({ components: [buildControlRow(player)] })
      .catch(() => {});
  }

  async handlePause(interaction, player) {
    await player.pause();
    await this.refreshControls(interaction, player);
  }

  async handleResume(interaction, player) {
    await player.resume();
    await this.refreshControls(interaction, player);
  }

  async handleSkip(interaction, player) {
    const { ok, ended, track } = await skipCurrent(player);
    const title = truncate(track?.title || "the current track", MAX_TITLE_LENGTH);

    if (!ok) {
      return this.notify(
        interaction,
        "**Warning:** The next track could not be started, Master. Please retry.",
      );
    }

    await this.notify(
      interaction,
      ended
        ? `**Confirmed.** Skipped **${title}**. The queue is empty, so the audio session has been concluded, Master.`
        : `**Confirmed.** Skipped **${title}**, Master.`,
    );
  }

  async handleDisconnect(interaction, player) {
    await clearNowPlaying(player);
    await player.destroy("Stop button");
  }

  async handleShuffle(interaction, player) {
    if (player.queue.size < 2) {
      return this.notify(
        interaction,
        "**Notice:** Insufficient queue entries for randomization, Master.",
      );
    }

    // Use moonlink's built-in queue shuffle
    player.queue.shuffle();

    await this.notify(
      interaction,
      `**Confirmed.** Queue randomized. **${player.queue.size}** tracks reordered, Master.`,
    );
  }

  async handleLoop(interaction, player) {
    // Cycle off -> track -> queue -> off (moonlink's PlayerLoop values)
    const next = LOOP_CYCLE[player.loop] ?? "track";
    player.setLoop(next);

    await this.refreshControls(interaction, player);
    await this.notify(interaction, LOOP_MESSAGES[next]);
  }
}

export default MusicButtonHandler;
