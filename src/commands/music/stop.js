/**
 * Stop/Disconnect Command
 * Stop playback and disconnect from voice channel
 */

import Command from "../../structures/Command.js";
import { errorEmbed, successEmbed } from "../../utils/embeds.js";
import { clearNowPlaying } from "../../music/RiffyManager.js";

// Gateway opcode 4: Voice State Update
const GATEWAY_VOICE_STATE_UPDATE = 4;

export default class Stop extends Command {
  constructor(client) {
    super(client, {
      name: "stop",
      description: {
        content: "Stop playback and disconnect from the voice channel",
        usage: "",
        examples: ["stop"],
      },
      aliases: ["disconnect", "dc", "leave", "end"],
      category: "music",
      cooldown: 3,
      args: false,
      player: {
        voice: true,
        dj: false,
        active: false,
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
        // No session, but still in a voice channel (e.g. a session lost to a restart)
        // Leave over the gateway as moonlink does (the REST route needs Move Members)
        if (!player && ctx.guild.members.me?.voice?.channelId) {
          ctx.guild.shard.send({
            op: GATEWAY_VOICE_STATE_UPDATE,
            d: { guild_id: guildId, channel_id: null, self_mute: false, self_deaf: false },
          });
          return ctx.sendMessage({
            embeds: [
              await successEmbed(
                guildId,
                "Audio System",
                "**Confirmed.** Voice connection severed, Master.",
              ),
            ],
          });
        }

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

      // Remove the now-playing card (its buttons would otherwise stay live),
      // then clear the queue, leave the channel and release the node player.
      await clearNowPlaying(player);
      await player.destroy("Stop command");

      return ctx.sendMessage({
        embeds: [
          await successEmbed(
            guildId,
            "Audio System",
            "**Confirmed.** Audio playback terminated and voice connection severed, Master.",
          ),
        ],
      });
    } catch (error) {
      client.logger.error("[Music:stop] Error:", error);
      return ctx.sendMessage({
        embeds: [
          await errorEmbed(
            guildId,
            "Audio System",
            "**Alert:** An anomaly occurred while terminating playback, Master.",
          ),
        ],
      });
    }
  }
}
