/**
 * Queue Command
 * Display the current music queue with pagination buttons
 */

import Command from "../../structures/Command.js";
import {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
} from "discord.js";
import { getRandomFooter } from "../../utils/raphael.js";
import { COLORS, errorEmbed, warningEmbed } from "../../utils/embeds.js";
import {
  formatQueueDuration,
  formatTrackDuration,
  safeUrl,
  trackLink,
} from "../../music/format.js";

const PAGE_SIZE = 10;
const COLLECTOR_TIMEOUT_MS = 120000;
const NOW_PLAYING_TITLE_LENGTH = 50;
const QUEUE_TITLE_LENGTH = 40;
// Field values are capped at 1024 characters; leave room for the "...and N more" note
const QUEUE_FIELD_BUDGET = 980;

export default class Queue extends Command {
  constructor(client) {
    super(client, {
      name: "queue",
      description: {
        content: "Display the current music queue",
        usage: "[page]",
        examples: ["queue", "queue 2"],
      },
      aliases: ["q"],
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
      options: [
        {
          name: "page",
          description: "The page of the queue to display",
          type: 4, // INTEGER
          required: false,
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
              "Audio Queue",
              "**Warning:** No audio playback system detected, Master.",
            ),
          ],
        });
      }

      // Check if nothing is playing
      if (!player.current && player.queue.isEmpty) {
        return ctx.sendMessage({
          embeds: [
            await warningEmbed(
              guildId,
              "Audio Queue",
              "**Notice:** The audio queue is vacant, Master. Use `play` to add tracks.",
            ),
          ],
        });
      }

      // The queue can change while the pages are open, so every render reads it afresh
      const pageCount = () => Math.max(1, Math.ceil(player.queue.size / PAGE_SIZE));
      const clampPage = (value) => Math.min(Math.max(1, value), pageCount());

      let currentPage = clampPage(parseInt(args[0], 10) || 1);

      const message = await ctx.sendMessage({
        embeds: [this.buildEmbed(player, currentPage, pageCount())],
        components: pageCount() > 1 ? [this.buildButtons(currentPage, pageCount())] : [],
      });

      // If only one page, no need for collector
      if (pageCount() <= 1 || !message?.createMessageComponentCollector) return;

      const collector = message.createMessageComponentCollector({
        time: COLLECTOR_TIMEOUT_MS,
      });

      collector.on("collect", async (interaction) => {
        try {
          if (interaction.user.id !== ctx.author.id) {
            return await interaction.reply({
              content: "**Notice:** These controls belong to the member who requested the queue, Master.",
              flags: MessageFlags.Ephemeral,
            });
          }

          switch (interaction.customId) {
            case "queue_first":
              currentPage = 1;
              break;
            case "queue_prev":
              currentPage -= 1;
              break;
            case "queue_next":
              currentPage += 1;
              break;
            case "queue_last":
              currentPage = pageCount();
              break;
          }
          currentPage = clampPage(currentPage);

          await interaction.update({
            embeds: [this.buildEmbed(player, currentPage, pageCount())],
            components: [this.buildButtons(currentPage, pageCount())],
          });
        } catch (error) {
          client.logger.error("[Music:queue] Page change failed:", error);
        }
      });

      collector.on("end", async () => {
        // Disable all buttons when collector ends
        await message
          .edit({ components: [this.buildButtons(currentPage, pageCount(), true)] })
          .catch(() => {});
      });
    } catch (error) {
      client.logger.error("[Music:queue] Error:", error);
      return ctx.sendMessage({
        embeds: [
          await errorEmbed(
            guildId,
            "Audio Queue",
            "**Alert:** An anomaly occurred while retrieving the queue, Master.",
          ),
        ],
      });
    }
  }

  buildEmbed(player, currentPage, totalPages) {
    const current = player.current;
    const queue = player.queue.tracks || [];
    const startIndex = (currentPage - 1) * PAGE_SIZE;

    const embed = new EmbedBuilder()
      .setColor(COLORS.RAPHAEL)
      .setTitle("『 Audio Queue 』")
      .setThumbnail(safeUrl(current?.thumbnail));

    // Now playing - truncate title if too long
    if (current) {
      embed.setDescription(
        `**▸ Currently Processing:**\n${trackLink(current, NOW_PLAYING_TITLE_LENGTH)} \`[${formatTrackDuration(current)}]\`\nRequested by: ${current.requester?.toString() || "Unknown"}`,
      );
    }

    // Queue list - kept within the 1024-character field limit
    let queueList = "";
    const queueSlice = queue.slice(startIndex, startIndex + PAGE_SIZE);
    for (let i = 0; i < queueSlice.length; i++) {
      const track = queueSlice[i];
      const line = `**${startIndex + i + 1}.** ${trackLink(track, QUEUE_TITLE_LENGTH)} \`[${formatTrackDuration(track)}]\`\n`;

      if ((queueList + line).length > QUEUE_FIELD_BUDGET) {
        queueList += `*...and ${queueSlice.length - i} more on this page*`;
        break;
      }
      queueList += line;
    }

    const size = player.queue.size;
    embed.addFields({
      name: size > 0 ? `▸ Up Next (${size} track${size !== 1 ? "s" : ""})` : "▸ Up Next",
      value: queueList.trim() || "No tracks in queue",
    });

    embed.setFooter({
      text: `Page ${currentPage}/${totalPages} • ${size} track${size !== 1 ? "s" : ""} • Total: ${formatQueueDuration(queue)} • ${getRandomFooter()}`,
    });
    embed.setTimestamp();

    return embed;
  }

  buildButtons(currentPage, totalPages, disableAll = false) {
    return new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("queue_first")
        .setLabel("First")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(disableAll || currentPage === 1),
      new ButtonBuilder()
        .setCustomId("queue_prev")
        .setLabel("Previous")
        .setStyle(ButtonStyle.Primary)
        .setDisabled(disableAll || currentPage === 1),
      new ButtonBuilder()
        .setCustomId("queue_page")
        .setLabel(`${currentPage}/${totalPages}`)
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(true),
      new ButtonBuilder()
        .setCustomId("queue_next")
        .setLabel("Next")
        .setStyle(ButtonStyle.Primary)
        .setDisabled(disableAll || currentPage === totalPages),
      new ButtonBuilder()
        .setCustomId("queue_last")
        .setLabel("Last")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(disableAll || currentPage === totalPages),
    );
  }
}
