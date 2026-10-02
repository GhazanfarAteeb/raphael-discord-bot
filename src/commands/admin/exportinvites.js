import { EmbedBuilder, AttachmentBuilder } from "discord.js";
import { getRandomFooter } from "../../utils/raphael.js";

export default {
  name: "exportinvites",
  description: "Export all server invites to a text file (Owner only)",
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

      // Create loading message
      const loadingEmbed = new EmbedBuilder()
        .setColor(client.color.main)
        .setTitle("▸ Generating Invites")
        .setDescription("Processing " + guilds.size + " servers...")
        .setFooter({ text: getRandomFooter() });

      const statusMessage = await message.reply({ embeds: [loadingEmbed] });

      const invites = [];
      let successCount = 0;
      let failedCount = 0;

      // Process each guild
      for (const guild of guilds.values()) {
        try {
          const channel = guild.channels.cache.find(
            (ch) =>
              ch.isTextBased() &&
              ch
                .permissionsFor(guild.members.me)
                .has(["CreateInstantInvite", "ViewChannel"]),
          );

          if (channel) {
            const invite = await channel.createInvite({
              maxAge: 0,
              maxUses: 0,
              reason: "Bulk export by owner",
            });

            invites.push({
              name: guild.name,
              id: guild.id,
              members: guild.memberCount,
              owner: guild.ownerId,
              inviteUrl: invite.url,
            });

            successCount++;
          } else {
            invites.push({
              name: guild.name,
              id: guild.id,
              members: guild.memberCount,
              owner: guild.ownerId,
              inviteUrl: "PERMISSION_DENIED",
            });

            failedCount++;
          }
        } catch (error) {
          invites.push({
            name: guild.name,
            id: guild.id,
            members: guild.memberCount,
            owner: guild.ownerId,
            inviteUrl: `ERROR: ${error.message}`,
          });

          failedCount++;
        }
      }

      // Generate formatted text content
      const timestamp = new Date().toLocaleString();
      let content = `RAPHAEL SERVER INVITES EXPORT\n`;
      content += `Generated: ${timestamp}\n`;
      content += `Total Servers: ${guilds.size}\n`;
      content += `Successfully Generated: ${successCount}\n`;
      content += `Failed/Restricted: ${failedCount}\n`;
      content += `\n${"=".repeat(80)}\n\n`;

      invites.forEach((invite, index) => {
        content += `${index + 1}. ${invite.name}\n`;
        content += `   Server ID: ${invite.id}\n`;
        content += `   Members: ${invite.members}\n`;
        content += `   Owner ID: ${invite.owner}\n`;
        content += `   Invite: ${invite.inviteUrl}\n\n`;
      });

      // Create attachment
      const buffer = Buffer.from(content, "utf-8");
      const attachment = new AttachmentBuilder(buffer).setName(
        `raphael-invites-${Date.now()}.txt`,
      );

      // Send success embed with file
      const successEmbed = new EmbedBuilder()
        .setColor(client.color.main)
        .setTitle("▸ Export Complete")
        .addFields(
          {
            name: "◈ Total Servers",
            value: guilds.size.toString(),
            inline: true,
          },
          {
            name: "◆ Successfully Generated",
            value: successCount.toString(),
            inline: true,
          },
          {
            name: "▸ Failed/Restricted",
            value: failedCount.toString(),
            inline: true,
          },
        )
        .setDescription(`Exported **${successCount}** invite links to file.`)
        .setFooter({ text: getRandomFooter() })
        .setTimestamp();

      await statusMessage.edit({ embeds: [successEmbed], files: [attachment] });
    } catch (error) {
      console.error("[EXPORTINVITES] Error:", error);
      return message.reply({
        embeds: [
          new EmbedBuilder()
            .setColor(message.client.color.red)
            .setTitle("▸ Error")
            .setDescription(
              `An error occurred while exporting invites:\n\`\`\`${error.message}\`\`\``,
            )
            .setFooter({ text: getRandomFooter() }),
        ],
      });
    }
  },
};
