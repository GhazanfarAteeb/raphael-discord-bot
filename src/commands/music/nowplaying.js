/**
 * NowPlaying Command
 * Display the currently playing track
 */

import Command from "../../structures/Command.js";
import { EmbedBuilder } from "discord.js";
import { getRandomFooter } from "../../utils/raphael.js";
import { COLORS, errorEmbed, warningEmbed } from "../../utils/embeds.js";
import {
  currentPosition,
  formatDuration,
  progressBar,
  safeUrl,
  truncate,
  DISCORD_LIMITS,
} from "../../music/format.js";

export default class NowPlaying extends Command {
  constructor(client) {
    super(client, {
      name: "nowplaying",
      description: {
        content: "Display information about the currently playing track",
        usage: "",
        examples: ["nowplaying"],
      },
      aliases: ["np", "current"],
      category: "music",
      cooldown: 3,
      args: false,
      player: {
        voice: false,
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

      if (!player || !player.current) {
        return ctx.sendMessage({
          embeds: [
            await warningEmbed(
              guildId,
              "Audio Playback",
              "**Notice:** No audio track is currently playing, Master.",
            ),
          ],
        });
      }

      const track = player.current;
      const live = Boolean(track.isStream);
      const duration = live ? 0 : Number(track.duration) || 0;
      const position = currentPosition(player);
      const timeline = live
        ? `${formatDuration(position)} / Live`
        : `${formatDuration(position)} / ${formatDuration(duration)}`;

      const embed = new EmbedBuilder()
        .setColor(COLORS.RAPHAEL)
        .setAuthor({ name: "『 Audio Playback 』" })
        .setTitle(truncate(track.title || "Unknown Track", DISCORD_LIMITS.TITLE))
        .setURL(safeUrl(track.uri))
        .setThumbnail(safeUrl(track.thumbnail))
        .setDescription(
          `**Notice:** ${player.paused ? "Audio stream suspended" : "Currently processing audio stream"}, Master.\n\n${progressBar(position, duration)}\n\`${timeline}\``,
        )
        .addFields(
          {
            name: "▸ Artist",
            value: truncate(track.author || "Unknown", DISCORD_LIMITS.FIELD_VALUE),
            inline: true,
          },
          {
            name: "▸ Requested By",
            value: track.requester?.toString() || "Unknown",
            inline: true,
          },
          { name: "▸ Volume", value: `${player.volume}%`, inline: true },
        );

      // Add loop status if enabled
      if (player.loop === "track" || player.loop === "queue") {
        embed.addFields({
          name: "▸ Loop Mode",
          value: player.loop === "track" ? "◉ Track Repeat" : "◉ Queue Repeat",
          inline: true,
        });
      }

      // Add queue info
      if (player.queue.size > 0) {
        embed.addFields({
          name: "▸ Queue Status",
          value: `${player.queue.size} track${player.queue.size !== 1 ? "s" : ""} pending`,
          inline: true,
        });
      }

      embed.setFooter({ text: getRandomFooter() });
      embed.setTimestamp();

      return ctx.sendMessage({ embeds: [embed] });
    } catch (error) {
      client.logger.error("[Music:nowplaying] Error:", error);
      return ctx.sendMessage({
        embeds: [
          await errorEmbed(
            guildId,
            "Audio Playback",
            "**Alert:** An anomaly occurred while retrieving playback data, Master.",
          ),
        ],
      });
    }
  }
}
