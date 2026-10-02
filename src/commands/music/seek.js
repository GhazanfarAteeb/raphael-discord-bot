/**
 * Seek Command
 * Seek to a specific position in the track
 */

import Command from "../../structures/Command.js";
import { errorEmbed, successEmbed } from "../../utils/embeds.js";
import { formatDuration } from "../../music/format.js";

const SECONDS_PER_MINUTE = 60;
const MS_PER_SECOND = 1000;

export default class Seek extends Command {
  constructor(client) {
    super(client, {
      name: "seek",
      description: {
        content: "Seek to a specific position in the track",
        usage: "<time>",
        examples: ["seek 1:30", "seek 90", "seek 2:00:00"],
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
          name: "time",
          description: "The time to seek to (e.g., 1:30 or 90)",
          type: 3, // STRING
          required: true,
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

      const track = player.current;
      if (!track) {
        return await fail("**Notice:** No audio track is currently playing, Master.");
      }

      if (track.isStream || !track.isSeekable) {
        return await fail(
          "**Notice:** The current track does not support seeking (live streams and some sources cannot be repositioned), Master.",
        );
      }

      const seekTime = parseSeekTime(args[0]);
      if (seekTime === null) {
        return await fail(
          "**Error:** Invalid time format. Use seconds (`90`), `mm:ss` or `hh:mm:ss`, Master.",
        );
      }

      const duration = Number(track.duration) || 0;
      if (seekTime >= duration) {
        return await fail(
          `**Warning:** Seek position exceeds track duration (\`${formatDuration(duration)}\`), Master.`,
        );
      }

      try {
        await player.seek(seekTime);
      } catch (error) {
        client.logger.error("[Music:seek] Seek rejected:", error);
        return await fail(
          "**Warning:** The audio node rejected the seek request, Master. Please retry.",
        );
      }

      return ctx.sendMessage({
        embeds: [
          await successEmbed(
            guildId,
            "Audio System",
            `**Confirmed.** Playback position adjusted to **${formatDuration(seekTime)}**, Master.`,
          ),
        ],
      });
    } catch (error) {
      client.logger.error("[Music:seek] Error:", error);
      return fail("**Alert:** An anomaly occurred while seeking, Master.");
    }
  }
}

/**
 * Parses "90", "1:30" or "1:02:03" into milliseconds. Every part must be a
 * non-negative integer and minutes/seconds after the first part must be below 60.
 * Returns null for anything else.
 */
function parseSeekTime(input) {
  const value = String(input ?? "").trim();
  if (!/^\d+(:\d+){0,2}$/.test(value)) return null;

  const parts = value.split(":").map(Number);
  if (parts.slice(1).some((part) => part >= SECONDS_PER_MINUTE)) return null;

  const seconds = parts.reduce((total, part) => total * SECONDS_PER_MINUTE + part, 0);
  return Number.isSafeInteger(seconds * MS_PER_SECOND) ? seconds * MS_PER_SECOND : null;
}
