/**
 * Loop Command
 * Toggle loop mode (track/queue/off)
 */

import Command from "../../structures/Command.js";
import { errorEmbed, successEmbed } from "../../utils/embeds.js";
import { buildControlRow } from "../../music/format.js";

const MODE_ALIASES = { track: "track", queue: "queue", off: "off", none: "off" };
const LOOP_CYCLE = { off: "track", track: "queue", queue: "off" };
const LOOP_MESSAGES = {
  track: "**Confirmed.** Now repeating the current track, Master.",
  queue: "**Confirmed.** Now repeating the entire queue, Master.",
  off: "**Confirmed.** Repeat mode disabled, Master.",
};

export default class Loop extends Command {
  constructor(client) {
    super(client, {
      name: "loop",
      description: {
        content: "Toggle loop mode (track, queue, or off)",
        usage: "[track|queue|off]",
        examples: ["loop", "loop track", "loop queue", "loop off"],
      },
      aliases: ["repeat"],
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
      options: [
        {
          name: "mode",
          description: "The loop mode",
          type: 3, // STRING
          required: false,
          choices: [
            { name: "Track", value: "track" },
            { name: "Queue", value: "queue" },
            { name: "Off", value: "off" },
          ],
        },
      ],
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

      const mode = args[0]?.toLowerCase();
      let newLoop;

      if (mode) {
        // moonlink's PlayerLoop is "off" | "track" | "queue"; "none" is accepted as an alias
        newLoop = Object.hasOwn(MODE_ALIASES, mode) ? MODE_ALIASES[mode] : null;
        if (!newLoop) {
          return ctx.sendMessage({
            embeds: [
              await errorEmbed(
                guildId,
                "Audio System",
                "**Warning:** Invalid mode. Valid options: `track`, `queue`, `off`, Master.",
              ),
            ],
          });
        }
      } else {
        // Toggle through modes if no argument: off -> track -> queue -> off
        newLoop = LOOP_CYCLE[player.loop] ?? "track";
      }

      player.setLoop(newLoop);

      // Keep the now-playing card's loop button in step with the new mode
      await player.message
        ?.edit({ components: [buildControlRow(player)] })
        .catch(() => {});

      return ctx.sendMessage({
        embeds: [await successEmbed(guildId, "Loop Mode", LOOP_MESSAGES[newLoop])],
      });
    } catch (error) {
      client.logger.error("[Music:loop] Error:", error);
      return ctx.sendMessage({
        embeds: [
          await errorEmbed(
            guildId,
            "Audio System",
            "**Alert:** An anomaly occurred while changing the loop mode, Master.",
          ),
        ],
      });
    }
  }
}
