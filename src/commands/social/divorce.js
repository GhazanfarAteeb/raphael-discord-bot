import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } from 'discord.js';
import Social from '../../models/Social.js';
import { errorEmbed, infoEmbed, COLORS } from '../../utils/embeds.js';
import { getRandomFooter } from '../../utils/raphael.js';

// The member has this long to confirm
const CONFIRM_TIMEOUT = 30_000;
const MARRIAGE_FIELDS = { 'marriage.partnerId': 1, 'marriage.marriedAt': 1, 'marriage.proposedBy': 1 };
const days = (count) => `${count} day${count === 1 ? '' : 's'}`;

export default {
  name: 'divorce',
  description: 'Initiate bond dissolution protocol, Master',
  usage: '',
  aliases: ['breakup'],
  category: 'social',
  cooldown: 60,

  async execute(message, args, client) {
    const guildId = message.guild.id;
    const userId = message.author.id;

    try {
      const userSocial = await Social.getSocial(userId, guildId);

      if (!userSocial.isMarried()) {
        return message.reply({
          embeds: [await infoEmbed(guildId, 'No Bond Detected', '**Notice:** Analysis indicates you are not bound to anyone, Master.')]
        });
      }

      const partnerId = userSocial.marriage.partnerId;
      const partner = await client.users.fetch(partnerId).catch(() => null);
      const partnerName = partner?.username || 'your partner';
      const marriageDays = userSocial.getMarriageDuration() ?? 0;

      const embed = new EmbedBuilder()
        .setColor(COLORS.RAPHAEL_ERROR)
        .setTitle('『 Bond Dissolution Protocol 』')
        .setDescription(`**Confirmation Required:**\n\nDo you wish to sever the bond with **${partnerName}**, Master?\n\n▸ **Duration:** ${days(marriageDays)}`)
        .setFooter({ text: `${getRandomFooter()} | This action is irreversible` });

      const row = new ActionRowBuilder()
        .addComponents(
          new ButtonBuilder()
            .setCustomId(`divorce_confirm_${userId}`)
            .setLabel('Confirm Dissolution')
            .setStyle(ButtonStyle.Danger),
          new ButtonBuilder()
            .setCustomId(`divorce_cancel_${userId}`)
            .setLabel('Cancel')
            .setStyle(ButtonStyle.Secondary)
        );

      const confirmMsg = await message.reply({ embeds: [embed], components: [row] });

      // Only the member who asked can confirm; anyone else is told so privately
      const collector = confirmMsg.createMessageComponentCollector({
        filter: (interaction) => {
          if (interaction.user.id === userId) return true;
          interaction.reply({
            content: `Only ${message.author.username} can confirm this, Master.`,
            flags: MessageFlags.Ephemeral
          }).catch(() => {});
          return false;
        },
        time: CONFIRM_TIMEOUT,
        max: 1
      });

      collector.on('collect', async interaction => {
        try {
          if (!interaction.customId.startsWith('divorce_confirm_')) {
            const cancelEmbed = new EmbedBuilder()
              .setColor(COLORS.RAPHAEL_SUCCESS)
              .setTitle('『 Protocol Cancelled 』')
              .setDescription(`**Confirmed:** Bond with **${partnerName}** remains intact, Master.`)
              .setFooter({ text: getRandomFooter() });

            return await interaction.update({ embeds: [cancelEmbed], components: [] });
          }

          await interaction.deferUpdate();

          // Only dissolves the bond the member was shown (it may have changed since)
          const dissolved = await Social.findOneAndUpdate(
            { odId: userId, guildId, 'marriage.partnerId': partnerId },
            { $unset: MARRIAGE_FIELDS }
          );
          if (!dissolved) {
            return await interaction.editReply({
              embeds: [await infoEmbed(guildId, 'Bond Already Dissolved', `**Notice:** You are no longer bonded to **${partnerName}**, Master.`)],
              components: []
            });
          }

          // The partner's side is cleared only if it still points back at this member
          await Social.updateOne(
            { odId: partnerId, guildId, 'marriage.partnerId': userId },
            { $unset: MARRIAGE_FIELDS }
          );

          const divorceEmbed = new EmbedBuilder()
            .setColor(COLORS.RAPHAEL)
            .setTitle('『 Bond Dissolved 』')
            .setDescription(`**Confirmed:** The bond between **${message.author.username}** and **${partnerName}** has been severed.\n\n▸ **Duration:** ${days(marriageDays)}`)
            .setFooter({ text: `${getRandomFooter()} | May your paths diverge peacefully` });

          await interaction.editReply({ embeds: [divorceEmbed], components: [] });

          // Notify partner if possible
          if (partner) {
            try {
              await partner.send({
                embeds: [new EmbedBuilder()
                  .setColor(COLORS.RAPHAEL_ERROR)
                  .setTitle('『 Notification 』')
                  .setDescription(`**Notice:** **${message.author.username}** has dissolved the bond in **${message.guild.name}**, Master.`)
                  .setFooter({ text: getRandomFooter() })]
              });
            } catch (e) {
              // DMs disabled
            }
          }
        } catch (error) {
          console.error('[Divorce] Error handling confirmation:', error);
          const embed = await errorEmbed(guildId, 'Dissolution Error', 'An anomaly occurred during processing. Please try again, Master.');
          await (interaction.deferred || interaction.replied
            ? interaction.editReply({ embeds: [embed], components: [] })
            : interaction.update({ embeds: [embed], components: [] })
          ).catch(() => {});
        }
      });

      collector.on('end', async collected => {
        if (collected.size === 0) {
          await confirmMsg.edit({ components: [] }).catch(() => { });
        }
      });

    } catch (error) {
      console.error('[Divorce] Error:', error);
      return message.reply({
        embeds: [await errorEmbed(guildId, 'Dissolution Error', 'An anomaly occurred during processing. Please try again, Master.')]
      }).catch(() => {});
    }
  }
};
