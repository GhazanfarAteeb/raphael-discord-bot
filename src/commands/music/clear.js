/**
 * Clear Command
 * Clear the music queue
 */

import Command from "../../structures/Command.js";
import { errorEmbed, successEmbed, warningEmbed } from "../../utils/embeds.js";

export default class Clear extends Command {
  constructor(client) {
    super(client, {
      name: "clearqueue",
      description: {
        content: "Clear the music queue",
        usage: "",
        examples: ["clearqueue"],
      },
      aliases: ["cq", "emptyqueue"],
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

      if (player.queue.isEmpty) {
        return await notice("**Notice:** The queue is already empty, Master.");
      }

      const queueLength = player.queue.size;
      player.queue.clear();

      return await confirm(
        `**Confirmed.** Queue purged. **${queueLength}** track${queueLength !== 1 ? "s" : ""} removed, Master.`,
      );
    } catch (error) {
      client.logger.error("[Music:clear] Error:", error);
      return fail("**Alert:** An anomaly occurred while clearing the queue, Master.");
    }
  }
}
