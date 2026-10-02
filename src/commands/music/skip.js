/**
 * Skip Command
 * Skip the current track
 */

import Command from "../../structures/Command.js";
import { errorEmbed, successEmbed } from "../../utils/embeds.js";
import { truncate } from "../../music/format.js";
import { skipCurrent } from "../../music/RiffyManager.js";

const MAX_TITLE_LENGTH = 200;

export default class Skip extends Command {
  constructor(client) {
    super(client, {
      name: "skip",
      description: {
        content: "Skip the currently playing track",
        usage: "",
        examples: ["skip"],
      },
      aliases: ["s", "next"],
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

    try {
      const player = client.moonlink?.players.get(guildId);

      if (!player || player.destroyed) {
        return ctx.sendMessage({
          embeds: [
            await errorEmbed(
              guildId,
              "Audio System",
              "**Warning:** No audio playback system detected, Master.",
            ),
          ],
        });
      }

      const { ok, ended, track } = await skipCurrent(player);
      const title = truncate(track?.title || "the current track", MAX_TITLE_LENGTH);

      if (!ok) {
        return ctx.sendMessage({
          embeds: [
            await errorEmbed(
              guildId,
              "Audio System",
              "**Warning:** The next track could not be started, Master. Please retry.",
            ),
          ],
        });
      }

      return ctx.sendMessage({
        embeds: [
          await successEmbed(
            guildId,
            "Track Skipped",
            ended
              ? `**Confirmed.** Skipped **${title}**. The queue is empty, so the audio session has been concluded, Master.`
              : `**Confirmed.** Skipped **${title}**, Master.`,
          ),
        ],
      });
    } catch (error) {
      client.logger.error("[Music:skip] Error:", error);
      return ctx.sendMessage({
        embeds: [
          await errorEmbed(
            guildId,
            "Audio System",
            "**Alert:** An anomaly occurred while skipping the track, Master.",
          ),
        ],
      });
    }
  }
}
