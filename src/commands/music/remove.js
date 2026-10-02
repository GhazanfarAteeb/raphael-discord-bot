/**
 * Remove Command
 * Remove a track from the queue
 */

import Command from "../../structures/Command.js";
import { errorEmbed, successEmbed, warningEmbed } from "../../utils/embeds.js";
import { truncate } from "../../music/format.js";

const MAX_TITLE_LENGTH = 200;

export default class Remove extends Command {
  constructor(client) {
    super(client, {
      name: "remove",
      description: {
        content: "Remove a track from the queue by position",
        usage: "<position>",
        examples: ["remove 3", "remove 1"],
      },
      aliases: [],
      category: "music",
      cooldown: 3,
      args: true,
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
      options: [
        {
          name: "position",
          description: "The position of the track to remove",
          type: 4, // INTEGER
          required: true,
          min_value: 1,
        },
      ],
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
        return await notice("**Notice:** The queue is currently empty, Master.");
      }

      const input = String(args[0] ?? "").trim();
      const position = /^\d+$/.test(input) ? Number(input) : NaN;

      if (!Number.isInteger(position)) {
        return await fail("**Error:** Please provide a valid position number, Master.");
      }

      const size = player.queue.size;
      if (position < 1 || position > size) {
        return await fail(
          `**Error:** Invalid position. Queue contains ${size} track${size !== 1 ? "s" : ""}, Master.`,
        );
      }

      const removed = player.queue.remove(position - 1);

      return await confirm(
        `**Confirmed.** Removed **${truncate(removed?.title || "track", MAX_TITLE_LENGTH)}** from position **#${position}**, Master.`,
      );
    } catch (error) {
      client.logger.error("[Music:remove] Error:", error);
      return fail("**Alert:** An anomaly occurred while removing the track, Master.");
    }
  }
}
