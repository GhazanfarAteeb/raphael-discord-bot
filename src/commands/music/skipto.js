/**
 * Skip To Command
 * Skip to a specific track in the queue
 */

import Command from "../../structures/Command.js";
import { errorEmbed, successEmbed, warningEmbed } from "../../utils/embeds.js";
import { truncate } from "../../music/format.js";

const MAX_TITLE_LENGTH = 200;

export default class SkipTo extends Command {
  constructor(client) {
    super(client, {
      name: "skipto",
      description: {
        content: "Skip to a specific track in the queue",
        usage: "<position>",
        examples: ["skipto 5", "skipto 2"],
      },
      aliases: ["jump"],
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
          description: "The position of the track to skip to",
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

    try {
      const player = client.moonlink?.players.get(guildId);

      if (!player || player.destroyed) {
        return await fail("**Warning:** No active audio session detected, Master.");
      }

      if (player.queue.isEmpty) {
        return ctx.sendMessage({
          embeds: [
            await warningEmbed(
              guildId,
              "Audio System",
              "**Notice:** The queue is currently empty, Master.",
            ),
          ],
        });
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

      const index = position - 1;
      const targetTrack = player.queue.get(index);

      // Queue loop: the current track and the jumped-over tracks stay in the rotation
      if (player.loop === "queue") {
        const passed = player.queue.slice(0, index);
        if (player.current) passed.unshift(player.current);
        player.queue.add(passed);
      }

      // jump() drops every track before the target, so skip() then plays it next
      // (skip(index) would only pull that one track and leave the earlier ones queued)
      if (!player.queue.jump(index)) {
        return await fail("**Warning:** The requested queue position could not be reached, Master.");
      }

      const started = await player.skip();
      if (!started) {
        return await fail(
          "**Warning:** The selected track could not be started, Master. Please retry.",
        );
      }

      return ctx.sendMessage({
        embeds: [
          await successEmbed(
            guildId,
            "Track Skipped",
            `**Confirmed.** Skipped to **${truncate(targetTrack?.title || "track", MAX_TITLE_LENGTH)}** at position **#${position}**, Master.`,
          ),
        ],
      });
    } catch (error) {
      client.logger.error("[Music:skipto] Error:", error);
      return fail("**Alert:** An anomaly occurred while skipping ahead, Master.");
    }
  }
}
