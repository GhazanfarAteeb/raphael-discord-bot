/**
 * Shuffle Command
 * Shuffle the queue
 */

import Command from "../../structures/Command.js";
import { errorEmbed, successEmbed, warningEmbed } from "../../utils/embeds.js";

export default class Shuffle extends Command {
  constructor(client) {
    super(client, {
      name: "shuffle",
      description: {
        content: "Shuffle the music queue",
        usage: "",
        examples: ["shuffle"],
      },
      aliases: ["sh"],
      category: "music",
      cooldown: 5,
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

      if (player.queue.size < 2) {
        return await notice(
          "**Notice:** Insufficient tracks for randomization. Minimum of 2 required, Master.",
        );
      }

      // Use moonlink's built-in queue shuffle
      player.queue.shuffle();

      return await confirm(
        `**Confirmed.** Queue randomization complete. **${player.queue.size}** tracks reordered, Master.`,
      );
    } catch (error) {
      client.logger.error("[Music:shuffle] Error:", error);
      return fail("**Alert:** An anomaly occurred while shuffling the queue, Master.");
    }
  }
}
