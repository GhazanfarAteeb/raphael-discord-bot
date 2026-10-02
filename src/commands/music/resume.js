/**
 * Resume Command
 * Resume paused playback
 */

import Command from "../../structures/Command.js";
import { errorEmbed, successEmbed, warningEmbed } from "../../utils/embeds.js";
import { buildControlRow } from "../../music/format.js";

export default class Resume extends Command {
  constructor(client) {
    super(client, {
      name: "resume",
      description: {
        content: "Resume the paused track",
        usage: "",
        examples: ["resume"],
      },
      aliases: ["unpause"],
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

      if (!player.paused) {
        return await notice("**Notice:** Audio stream is already active, Master.");
      }

      await player.resume();

      // Keep the now-playing card's Pause/Resume button in step
      await player.message
        ?.edit({ components: [buildControlRow(player)] })
        .catch(() => {});

      return await confirm("**Confirmed.** Audio stream resumed, Master.");
    } catch (error) {
      client.logger.error("[Music:resume] Error:", error);
      return fail("**Alert:** An anomaly occurred while resuming playback, Master.");
    }
  }
}
