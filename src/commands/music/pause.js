/**
 * Pause Command
 * Pause the current track
 */

import Command from "../../structures/Command.js";
import { errorEmbed, successEmbed, warningEmbed } from "../../utils/embeds.js";
import { buildControlRow } from "../../music/format.js";

export default class Pause extends Command {
  constructor(client) {
    super(client, {
      name: "pause",
      description: {
        content: "Pause the currently playing track",
        usage: "",
        examples: ["pause"],
      },
      aliases: [],
      category: "music",
      cooldown: 3,
      args: false,
      player: {
        voice: true,
        dj: false,
        active: true,
        djPerm: null,
      },
      permissions: {
        dev: false,
        client: ["SendMessages", "ViewChannel", "EmbedLinks"],
        user: [],
      },
      slashCommand: true,
      options: [],
    });
  }

  async run(client, ctx, args) {
    const guildId = ctx.guild.id;
    const fail = async (description) =>
      ctx.sendMessage({ embeds: [await errorEmbed(guildId, "Audio System", description)] });
    const notice = async (description) =>
      ctx.sendMessage({ embeds: [await warningEmbed(guildId, "Audio System", description)] });
    const confirm = async (description) =>
      ctx.sendMessage({ embeds: [await successEmbed(guildId, "Audio System", description)] });

    try {
      const player = client.moonlink?.players.get(guildId);

      if (!player || player.destroyed) {
        return await fail("**Warning:** No active audio session detected, Master.");
      }

      if (player.paused) {
        return await notice(
          "**Notice:** Audio stream is already suspended, Master. Use `resume` to continue.",
        );
      }

      await player.pause();

      // Keep the now-playing card's Pause/Resume button in step
      await player.message
        ?.edit({ components: [buildControlRow(player)] })
        .catch(() => {});

      return await confirm("**Confirmed.** Audio stream suspended, Master.");
    } catch (error) {
      client.logger.error("[Music:pause] Error:", error);
      return fail("**Alert:** An anomaly occurred while pausing playback, Master.");
    }
  }
}
