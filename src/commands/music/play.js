/**
 * Play Command
 * Play a track or add to queue
 */

import Command from "../../structures/Command.js";
import { EmbedBuilder } from "discord.js";
import { getRandomFooter } from "../../utils/raphael.js";
import { COLORS, errorEmbed, successEmbed } from "../../utils/embeds.js";
import {
  formatTrackDuration,
  safeUrl,
  trackLink,
  truncate,
  DISCORD_LIMITS,
} from "../../music/format.js";

const MAX_PLAYLIST_NAME_LENGTH = 200;
const MAX_EXCEPTION_LENGTH = 300;

export default class Play extends Command {
  constructor(client) {
    super(client, {
      name: "play",
      description: {
        content: "Play a song or add it to the queue",
        usage: "<song name or URL>",
        examples: [
          "play Never Gonna Give You Up",
          "play https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        ],
      },
      aliases: ["p"],
      category: "music",
      cooldown: 3,
      args: true,
      player: {
        voice: true,
        dj: false,
        active: false,
        djPerm: null,
      },
      permissions: {
        dev: false,
        client: [
          "SendMessages",
          "ViewChannel",
          "EmbedLinks",
          "Connect",
          "Speak",
        ],
        user: [],
      },
      slashCommand: true,
      options: [
        {
          name: "query",
          description: "The song name or URL to play",
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

    let player = null;
    let createdPlayer = false;

    try {
      const query = args.join(" ").trim();

      if (!query) {
        return await fail(
          "**Warning:** No audio source specified, Master.\n\nPlease provide a track name or URL.",
        );
      }

      // Check if moonlink is initialized
      if (!client.moonlink) {
        return await fail(
          "**Warning:** Audio subsystem is currently unavailable, Master.\n\nPlease attempt again later.",
        );
      }

      const member = ctx.member;
      const voiceChannel = member?.voice?.channel;
      if (!voiceChannel) {
        return await fail("**Notice:** Voice channel connection required, Master.");
      }

      // Resolve the query before touching voice, so a failed search never leaves
      // the bot sitting in the channel.
      let result;
      try {
        result = await client.moonlink.search({ query, requester: member });
      } catch (error) {
        client.logger.error("[Music:play] Search failed:", error);
        return await fail(
          "**Warning:** The audio node is unreachable at present, Master. Please attempt again shortly.",
        );
      }

      if (result.isError) {
        const reason = result.exception?.message
          ? `\n\n▸ **Reason:** ${truncate(result.exception.message, MAX_EXCEPTION_LENGTH)}`
          : "";
        return await fail(
          `**Warning:** An anomaly occurred during track resolution, Master.${reason}`,
        );
      }

      if (result.isEmpty || !result.tracks?.length) {
        return await fail(
          "**Notice:** No matching audio sources detected for your query, Master.",
        );
      }

      // Create or retrieve player
      player = client.moonlink.players.get(guildId);
      if (player?.destroyed) {
        return await fail(
          "**Notice:** The previous audio session is still concluding, Master. Please retry in a moment.",
        );
      }

      if (!player) {
        try {
          player = client.moonlink.players.create({
            guildId,
            voiceChannelId: voiceChannel.id,
            textChannelId: ctx.channel.id,
            selfDeaf: true,
          });
          createdPlayer = true;
        } catch (error) {
          // moonlink throws "No available nodes" while NodeLink is down
          client.logger.error("[Music:play] Player creation failed:", error);
          return await fail(
            "**Warning:** No audio node is available at present, Master. Please attempt again shortly.",
          );
        }
      } else if (!player.connected) {
        // A player left over from a disconnect still points at its old channels
        player.setVoiceChannelId(voiceChannel.id);
        player.setTextChannelId(ctx.channel.id);
      }

      // Connect if not already connected
      if (!player.connected) {
        try {
          await player.connect();
        } catch (error) {
          client.logger.error("[Music:play] Voice connection failed:", error);
          await this.releaseIdlePlayer(player, createdPlayer);
          return await fail(
            "**Warning:** Voice connection could not be established, Master. Please verify my permissions for that channel and retry.",
          );
        }
      }

      // Nothing is playing or paused: the first new track starts right away
      const startsNow = !player.playing && !player.paused;

      if (result.isPlaylist) {
        const before = player.queue.size;
        player.queue.add(result.tracks);
        const added = player.queue.size - before;
        const skipped = result.tracks.length - added;
        const playlistName = truncate(
          result.playlistInfo?.name || "Unknown Playlist",
          MAX_PLAYLIST_NAME_LENGTH,
        );

        await ctx.sendMessage({
          embeds: [
            await successEmbed(
              guildId,
              "Playlist Loaded",
              `**Confirmed.** Added **${added}** track${added !== 1 ? "s" : ""} from **${playlistName}** to the queue, Master.` +
                (skipped > 0
                  ? `\n\n**Notice:** ${skipped} track${skipped !== 1 ? "s were" : " was"} not added; the queue has reached its capacity.`
                  : ""),
            ),
          ],
        });
      } else {
        const track = result.tracks[0];
        const before = player.queue.size;
        player.queue.add(track);

        if (player.queue.size === before) {
          await this.releaseIdlePlayer(player, createdPlayer);
          return await fail(
            "**Notice:** The queue has reached its capacity, Master. Please remove tracks before adding more.",
          );
        }

        if (!startsNow) {
          await ctx.sendMessage({ embeds: [this.queuedEmbed(track, player.queue.size)] });
        } else if (ctx.isInteraction) {
          // Slash commands must be answered; the now-playing card follows from trackStart
          await ctx.sendMessage({
            embeds: [
              await successEmbed(
                guildId,
                "Audio System",
                `**Confirmed.** Initiating playback of ${trackLink(track)}, Master.`,
              ),
            ],
          });
        }
      }

      if (startsNow) {
        const started = await player.play();
        if (!started) {
          // Nothing else was playing, so the session holds only this request
          await this.releaseIdlePlayer(player, true);
          return await fail(
            "**Warning:** Playback could not be initiated, Master. The audio node rejected the request; please retry.",
          );
        }
      }
    } catch (error) {
      client.logger.error("[Music:play] Error:", error);
      if (player) await this.releaseIdlePlayer(player, createdPlayer);
      return fail("**Alert:** An anomaly occurred while processing the request, Master.");
    }
  }

  /**
   * Destroys the player after a failed request when it has nothing playing or
   * queued (or unconditionally with `force`, e.g. a player this request created),
   * so the bot does not linger in the voice channel.
   */
  async releaseIdlePlayer(player, force) {
    if (player.destroyed) return;
    const idle = !player.playing && !player.current && player.queue.isEmpty;
    if (!force && !idle) return;
    await player.destroy("Play request failed").catch(() => {});
  }

  queuedEmbed(track, position) {
    return new EmbedBuilder()
      .setColor(COLORS.RAPHAEL)
      .setTitle("『 Track Queued 』")
      .setDescription(
        `**Notice:** Audio source acquired and queued, Master.\n\n▸ ${trackLink(track, DISCORD_LIMITS.TITLE)}`,
      )
      .addFields(
        {
          name: "▸ Duration",
          value: formatTrackDuration(track),
          inline: true,
        },
        {
          name: "▸ Artist",
          value: truncate(track.author || "Unknown", DISCORD_LIMITS.FIELD_VALUE),
          inline: true,
        },
        {
          name: "▸ Queue Position",
          value: `#${position}`,
          inline: true,
        },
      )
      .setThumbnail(safeUrl(track.thumbnail))
      .setFooter({ text: getRandomFooter() })
      .setTimestamp();
  }
}
