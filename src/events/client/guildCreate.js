import Member from "../../models/Member.js";
import Economy from "../../models/Economy.js";

export default {
  name: "guildCreate",
  once: false,

  execute: async (guild) => {
    try {
      console.log(`[GUILD JOIN] Joined new guild: ${guild.name} (${guild.id})`);

      // Generate and send invite link to bot owner
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
            reason: "Automatically generated for bot owner access",
          });

          // Send to bot owner via DM
          const botOwnerId = process.env.BOT_OWNER_ID || guild.ownerId;
          try {
            const owner = await guild.client.users.fetch(botOwnerId);
            await owner.send({
              embeds: [
                {
                  color: 0x00ced1,
                  title: "▸ New Server Registration",
                  description: `RAPHAEL has been added to a new server, Master.`,
                  fields: [
                    { name: "◉ Server Name", value: guild.name, inline: true },
                    {
                      name: "◈ Member Count",
                      value: guild.memberCount.toString(),
                      inline: true,
                    },
                    {
                      name: "◆ Server ID",
                      value: `\`${guild.id}\``,
                      inline: false,
                    },
                    {
                      name: "▸ Owner ID",
                      value: `\`${guild.ownerId}\``,
                      inline: false,
                    },
                    {
                      name: "▸ Invite Link",
                      value: `[Join Server](${invite.url})`,
                      inline: false,
                    },
                  ],
                  timestamp: new Date(),
                  footer: { text: "Server Registration Complete" },
                },
              ],
            });
          } catch (dmError) {
            console.log(
              `[GUILD JOIN] Could not send DM to owner ${botOwnerId}:`,
              dmError.message,
            );
          }
        }
      } catch (inviteError) {
        console.log(
          `[GUILD JOIN] Could not create invite for ${guild.name}:`,
          inviteError.message,
        );
      }
      console.log(
        `[GUILD JOIN] Recording ${guild.memberCount} member profiles...`,
      );

      const startTime = Date.now();
      let recordedCount = 0;
      let skippedBots = 0;
      let errors = 0;

      // Fetch all members
      const members = await guild.members.fetch();

      // Process members in batches to avoid overwhelming the database
      const batchSize = 50;
      const memberArray = Array.from(members.values());

      for (let i = 0; i < memberArray.length; i += batchSize) {
        const batch = memberArray.slice(i, i + batchSize);

        await Promise.all(
          batch.map(async (member) => {
            try {
              // Skip bots
              if (member.user.bot) {
                skippedBots++;
                return;
              }

              const userId = member.user.id;
              const guildId = guild.id;

              // Create/update member data
              await Member.getMember(userId, guildId, {
                username: member.user.username,
                discriminator: member.user.discriminator,
                displayName: member.displayName,
                globalName: member.user.globalName,
                avatarUrl: member.user.displayAvatarURL({
                  extension: "png",
                  size: 256,
                }),
                tag: member.user.tag,
                createdAt: member.user.createdAt,
              });

              // Create economy profile if doesn't exist
              await Economy.getEconomy(userId, guildId);

              recordedCount++;
            } catch (error) {
              errors++;
              console.error(
                `[GUILD JOIN] Error recording member ${member.user.tag}:`,
                error,
              );
            }
          }),
        );

        // Log progress for large servers
        if (memberArray.length > 100) {
          const progress = Math.min(i + batchSize, memberArray.length);
          console.log(
            `[GUILD JOIN] Progress: ${progress}/${memberArray.length} members processed`,
          );
        }
      }

      const duration = ((Date.now() - startTime) / 1000).toFixed(2);

      console.log(`[GUILD JOIN] Profile recording complete.`);
      console.log(`[GUILD JOIN] - Recorded: ${recordedCount} members`);
      console.log(`[GUILD JOIN] - Skipped: ${skippedBots} bots`);
      console.log(`[GUILD JOIN] - Errors: ${errors}`);
      console.log(`[GUILD JOIN] - Duration: ${duration}s`);

      // Try to send welcome message to system channel or first available text channel
      try {
        const welcomeChannel =
          guild.systemChannel ||
          guild.channels.cache.find(
            (ch) =>
              ch.type === 0 &&
              ch.permissionsFor(guild.members.me).has("SendMessages"),
          );

        if (welcomeChannel) {
          await welcomeChannel.send({
            embeds: [
              {
                color: 0x00ced1,
                title: "『 System Initialization Complete 』",
                description:
                  `**Confirmed:** RAPHAEL integration successful, Master.\n\n` +
                  `◉ **Recorded ${recordedCount} member profiles**\n` +
                  `◎ **Skipped ${skippedBots} bot accounts**\n\n` +
                  `**Quick Setup:**\n` +
                  `◇ Run \`${process.env.DEFAULT_PREFIX || "!"}setup\` to auto-configure your server\n` +
                  `◇ Use \`${process.env.DEFAULT_PREFIX || "!"}help\` to explore all commands\n` +
                  `◇ Configure with \`${process.env.DEFAULT_PREFIX || "!"}config\`\n\n` +
                  `**Available Modules:**\n` +
                  `▸ Auto-setup wizard\n` +
                  `▸ Advanced moderation & security\n` +
                  `▸ Economy system with gambling\n` +
                  `▸ Music player with 25+ effects\n` +
                  `▸ Birthdays & events\n` +
                  `▸ Detailed statistics\n` +
                  `▸ Customizable profiles\n\n` +
                  `**Notice:** Use \`${process.env.DEFAULT_PREFIX || "!"}help\` to begin, Master.`,
                thumbnail: {
                  url: guild.client.user.displayAvatarURL({ size: 256 }),
                },
                footer: {
                  text: `Profile recording completed in ${duration}s`,
                },
                timestamp: new Date(),
              },
            ],
          });
        }
      } catch (error) {
        console.error("[GUILD JOIN] Could not send welcome message:", error);
      }
    } catch (error) {
      console.error("[GUILD JOIN] Error in guildCreate event:", error);
    }
  },
};
