import { EmbedBuilder } from "discord.js";
import { getRandomFooter } from "../../utils/raphael.js";

export default {
  name: "serverlist",
  description:
    "Get a list of all servers Raphael is in with invite links (Owner only)",
  ownerOnly: true,

  async execute(message) {
    try {
      const client = message.client;
      const guilds = client.guilds.cache;

      if (guilds.size === 0) {
        return message.reply({
          embeds: [
            new EmbedBuilder()
              .setColor(client.color.red)
              .setTitle("▸ No Servers Found")
              .setDescription(
                "RAPHAEL is not currently in any servers, Master.",
              )
              .setFooter({ text: getRandomFooter() }),
          ],
        });
      }

      // Create pages for large server lists (10 servers per page)
      const serverList = Array.from(guilds.values());
      const pageSize = 10;
      const totalPages = Math.ceil(serverList.length / pageSize);
      let currentPage = 0;

      const generatePage = (pageNum) => {
        const start = pageNum * pageSize;
        const end = start + pageSize;
        const pageServers = serverList.slice(start, end);

        const fields = [];
        pageServers.forEach((guild, index) => {
          const number = start + index + 1;
          fields.push({
            name: `${number}. ${guild.name}`,
            value: `◆ ID: \`${guild.id}\`\n◈ Members: ${guild.memberCount}`,
            inline: false,
          });
        });

        return new EmbedBuilder()
          .setColor(client.color.main)
          .setTitle(`▸ Server List (Page ${pageNum + 1}/${totalPages})`)
          .setDescription(
            `RAPHAEL is currently in **${serverList.length}** servers, Master.`,
          )
          .addFields(fields)
          .setFooter({ text: getRandomFooter() })
          .setTimestamp();
      };

      // Send first page
      const firstPageEmbed = generatePage(0);
      const embed = await message.reply({
        embeds: [firstPageEmbed],
      });

      // If more than 1 page, add reaction pagination
      if (totalPages > 1) {
        await embed.react("◀️");
        await embed.react("▶️");

        const filter = (reaction, user) => {
          return (
            ["◀️", "▶️"].includes(reaction.emoji.name) &&
            user.id === message.author.id
          );
        };

        const collector = embed.createReactionCollector({
          filter,
          time: 300000,
        });

        collector.on("collect", async (reaction) => {
          try {
            if (reaction.emoji.name === "▶️") {
              currentPage = (currentPage + 1) % totalPages;
            } else if (reaction.emoji.name === "◀️") {
              currentPage = (currentPage - 1 + totalPages) % totalPages;
            }

            await embed.edit({
              embeds: [generatePage(currentPage)],
            });

            await reaction.users.remove(message.author.id).catch(() => {});
          } catch (error) {
            console.error("[SERVERLIST] Error updating page:", error);
          }
        });

        collector.on("end", () => {
          embed.reactions.removeAll().catch(() => {});
        });
      }

      // Follow up message with invite instructions
      setTimeout(async () => {
        try {
          await message.channel.send({
            embeds: [
              new EmbedBuilder()
                .setColor(client.color.main)
                .setTitle("▸ Get Server Invites")
                .setDescription(
                  "Use the commands below:\n\n" +
                    "`!invite <server_name_or_id>` - Get an invite to a specific server\n" +
                    "`!exportinvites` - Export all server invites to a file",
                )
                .setFooter({ text: getRandomFooter() }),
            ],
          });
        } catch (error) {
          // Silently fail if unable to send follow-up
        }
      }, 500);
    } catch (error) {
      console.error("[SERVERLIST] Error:", error);
      return message.reply({
        embeds: [
          new EmbedBuilder()
            .setColor(client.color.red)
            .setTitle("▸ Error")
            .setDescription(
              `An error occurred while retrieving server list:\n\`\`\`${error.message}\`\`\``,
            )
            .setFooter({ text: getRandomFooter() }),
        ],
      });
    }
  },
};
