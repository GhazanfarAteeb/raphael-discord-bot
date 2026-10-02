/**
 * Volume Command
 * Adjust the player volume
 */

import Command from "../../structures/Command.js";
import { errorEmbed, infoEmbed, successEmbed } from "../../utils/embeds.js";

const MIN_VOLUME = 0;
const MAX_VOLUME = 150;

export default class Volume extends Command {
  constructor(client) {
    super(client, {
      name: "volume",
      description: {
        content: "Adjust the player volume (0-150)",
        usage: "<volume>",
        examples: ["volume 50", "volume 100"],
      },
      aliases: ["vol", "v"],
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
          name: "level",
          description: "The volume level (0-150)",
          type: 4, // INTEGER
          required: false,
          min_value: 0,
          max_value: 150,
        },
      ],
    });
  }

  async run(client, ctx, args) {
    const guildId = ctx.guild.id;
    const fail = async (description) =>
      ctx.sendMessage({ embeds: [await errorEmbed(guildId, "Audio System", description)] });
    const confirm = async (description) =>
      ctx.sendMessage({ embeds: [await successEmbed(guildId, "Audio System", description)] });

    try {
      const player = client.moonlink?.players.get(guildId);

      if (!player || player.destroyed) {
        return await fail("**Warning:** No active audio session detected, Master.");
      }

      // Show current volume if no argument
      if (!args[0]) {
        return ctx.sendMessage({
          embeds: [
            await infoEmbed(
              guildId,
              "Audio System",
              `**Report:** Current audio level: **${player.volume}%**, Master.`,
            ),
          ],
        });
      }

      const input = String(args[0]).trim().replace(/%$/, "");
      const volume = /^\d+$/.test(input) ? Number(input) : NaN;

      if (!Number.isInteger(volume)) {
        return await fail("**Warning:** Please provide a valid whole number, Master.");
      }

      if (volume < MIN_VOLUME || volume > MAX_VOLUME) {
        return await fail(
          `**Warning:** Volume must be between ${MIN_VOLUME} and ${MAX_VOLUME}, Master.`,
        );
      }

      player.setVolume(volume);

      // Volume indicator based on level
      let volumeIndicator = "◉ High";
      if (volume === 0) volumeIndicator = "◇ Muted";
      else if (volume <= 30) volumeIndicator = "◈ Low";
      else if (volume <= 70) volumeIndicator = "◈ Medium";

      return await confirm(
        `**Confirmed.** Audio level set to **${volume}%** (${volumeIndicator}), Master.`,
      );
    } catch (error) {
      client.logger.error("[Music:volume] Error:", error);
      return fail("**Alert:** An anomaly occurred while adjusting the volume, Master.");
    }
  }
}
