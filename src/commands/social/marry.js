import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } from 'discord.js';
import Social from '../../models/Social.js';
import { MARRIAGE_PROPOSAL_TIMEOUT } from '../../utils/gameConfig.js';
import { errorEmbed, infoEmbed, COLORS } from '../../utils/embeds.js';
import { getPrefix } from '../../utils/helpers.js';
import { getRandomFooter } from '../../utils/raphael.js';

const PROPOSAL_TIMEOUT_MS = MARRIAGE_PROPOSAL_TIMEOUT * 1000;
const WEDDING_IMAGE = 'https://media.giphy.com/media/26FLdmIp6wJr91JAI/giphy.gif';

// Removes the proposal from `proposerId` stored on the recipient's profile
function withdrawProposal(recipientId, guildId, proposerId) {
  return Social.updateOne({ odId: recipientId, guildId }, { $pull: { pendingProposals: { odId: proposerId } } });
}

// Bonds both members, but only if neither has married someone else in the meantime: each side
// is a conditional update on an unset partner, and the first is undone if the second fails.
// Returns null on success, or which side was no longer free.
async function establishBond(proposerId, recipientId, guildId) {
  const marriedAt = new Date();

  const proposer = await Social.findOneAndUpdate(
    { odId: proposerId, guildId, 'marriage.partnerId': null },
    { $set: { 'marriage.partnerId': recipientId, 'marriage.marriedAt': marriedAt, 'marriage.proposedBy': proposerId } },
    { new: true }
  );
  if (!proposer) return { unavailable: 'proposer' };

  const recipient = await Social.findOneAndUpdate(
    { odId: recipientId, guildId, 'marriage.partnerId': null },
    {
      $set: { 'marriage.partnerId': proposerId, 'marriage.marriedAt': marriedAt, 'marriage.proposedBy': proposerId },
      $pull: { pendingProposals: { odId: proposerId } }
    },
    { new: true }
  );
  if (!recipient) {
    await Social.updateOne(
      { odId: proposerId, guildId, 'marriage.partnerId': recipientId, 'marriage.marriedAt': marriedAt },
      { $unset: { 'marriage.partnerId': 1, 'marriage.marriedAt': 1, 'marriage.proposedBy': 1 } }
    );
    return { unavailable: 'recipient' };
  }

  // First marriage badge (addBadge skips members who already have it); the bond stands even if this fails
  try {
    await proposer.addBadge(Social.BADGES.FIRST_MARRIAGE);
    await recipient.addBadge(Social.BADGES.FIRST_MARRIAGE);
  } catch (error) {
    console.error('[Marry] Error awarding the first marriage badge:', error);
  }

  return { marriedAt };
}

export default {
  name: 'marry',
  description: 'Initiate a bonding proposal with another user, Master',
  usage: '<@user>',
  aliases: ['propose', 'wedding'],
  category: 'social',
  cooldown: 30,

  async execute(message, args, client) {
    const guildId = message.guild.id;
    const userId = message.author.id;

    try {
      const prefix = await getPrefix(guildId);
      const targetUser = message.mentions.users.first();

      if (!targetUser) {
        return message.reply({
          embeds: [await infoEmbed(guildId, 'Subject Required',
            `**Notice:** Please specify a subject for your proposal, Master.\n\n**Syntax:** \`${prefix}marry @user\``)]
        });
      }

      if (targetUser.id === userId) {
        return message.reply({ embeds: [await errorEmbed(guildId, 'Invalid Subject', 'Self-bonding is not a valid operation, Master.')] });
      }

      if (targetUser.bot) {
        return message.reply({ embeds: [await errorEmbed(guildId, 'Invalid Subject', 'Automated systems cannot participate in bonding rituals, Master.')] });
      }

      const userSocial = await Social.getSocial(userId, guildId);
      const targetSocial = await Social.getSocial(targetUser.id, guildId);

      // Check if already married
      if (userSocial.isMarried()) {
        const partner = await client.users.fetch(userSocial.marriage.partnerId).catch(() => null);
        return message.reply({
          embeds: [await infoEmbed(guildId, 'Existing Bond',
            `**Notice:** You are already bonded to **${partner?.username || 'someone'}**, Master. Use \`${prefix}divorce\` to dissolve the union first.`)]
        });
      }

      if (targetSocial.isMarried()) {
        const partner = await client.users.fetch(targetSocial.marriage.partnerId).catch(() => null);
        return message.reply({
          embeds: [await infoEmbed(guildId, 'Existing Bond',
            `**Notice:** **${targetUser.username}** is already bonded to **${partner?.username || 'someone'}**, Master.`)]
        });
      }

      // Expire proposals past their time limit, then register this one; the $ne condition makes
      // the check and the insert one step, so two proposals at once can't both pass
      const now = new Date();
      await Social.updateOne(
        { odId: targetUser.id, guildId },
        { $pull: { pendingProposals: { timestamp: { $lt: new Date(now.getTime() - PROPOSAL_TIMEOUT_MS) } } } }
      );
      const registered = await Social.updateOne(
        { odId: targetUser.id, guildId, 'pendingProposals.odId': { $ne: userId } },
        { $push: { pendingProposals: { odId: userId, timestamp: now } } }
      );
      if (registered.modifiedCount === 0) {
        return message.reply({
          embeds: [await infoEmbed(guildId, 'Proposal Pending',
            `**Notice:** You already have a pending proposal to **${targetUser.username}**, Master.`)]
        });
      }

      // Create proposal embed
      const embed = new EmbedBuilder()
        .setColor(COLORS.RAPHAEL)
        .setTitle('『 Bonding Proposal 』')
        .setDescription(`**${message.author.username}** is requesting a permanent bond with **${targetUser.username}**.\n\n${targetUser}, do you accept this proposal?`)
        .setThumbnail(message.author.displayAvatarURL())
        .setFooter({ text: `${getRandomFooter()} | Expires in ${MARRIAGE_PROPOSAL_TIMEOUT} seconds` });

      const row = new ActionRowBuilder()
        .addComponents(
          new ButtonBuilder()
            .setCustomId(`marry_accept_${userId}_${targetUser.id}`)
            .setLabel('Accept')
            .setStyle(ButtonStyle.Success),
          new ButtonBuilder()
            .setCustomId(`marry_reject_${userId}_${targetUser.id}`)
            .setLabel('Reject')
            .setStyle(ButtonStyle.Danger)
        );

      let proposalMsg;
      try {
        proposalMsg = await message.reply({
          content: `${targetUser}`,
          embeds: [embed],
          components: [row]
        });
      } catch (error) {
        await withdrawProposal(targetUser.id, guildId, userId).catch(() => {});
        throw error;
      }

      await Social.updateOne(
        { odId: targetUser.id, guildId, 'pendingProposals.odId': userId },
        { $set: { 'pendingProposals.$.message': proposalMsg.id } }
      ).catch(error => console.error('[Marry] Error recording proposal message:', error));

      // Only the recipient's answer counts; anyone else is told so privately
      const collector = proposalMsg.createMessageComponentCollector({
        filter: (interaction) => {
          if (interaction.user.id === targetUser.id) return true;
          interaction.reply({
            content: interaction.user.id === userId
              ? 'Only the recipient can respond to this proposal, Master.'
              : `This proposal is addressed to ${targetUser.username}, Master.`,
            flags: MessageFlags.Ephemeral
          }).catch(() => {});
          return false;
        },
        time: PROPOSAL_TIMEOUT_MS,
        max: 1
      });

      collector.on('collect', async interaction => {
        try {
          if (interaction.customId.startsWith('marry_accept_')) {
            await interaction.deferUpdate();
            const result = await establishBond(userId, targetUser.id, guildId);

            if (result.unavailable) {
              await withdrawProposal(targetUser.id, guildId, userId);
              const who = result.unavailable === 'proposer' ? message.author.username : targetUser.username;
              const voidEmbed = new EmbedBuilder()
                .setColor(COLORS.RAPHAEL_ERROR)
                .setTitle('『 Proposal Void 』')
                .setDescription(`**Notice:** **${who}** has formed another bond since this proposal was made. The proposal is void, Master.`)
                .setFooter({ text: getRandomFooter() });
              return await interaction.editReply({ content: null, embeds: [voidEmbed], components: [] });
            }

            const weddingEmbed = new EmbedBuilder()
              .setColor(COLORS.RAPHAEL_SUCCESS)
              .setTitle('『 Bond Established 』')
              .setDescription(
                `**Confirmed:** **${message.author.username}** and **${targetUser.username}** are now bonded.\n\n` +
                `**Status:** Union successfully registered <t:${Math.floor(result.marriedAt.getTime() / 1000)}:D>. May your bond endure.`
              )
              .setImage(WEDDING_IMAGE)
              .setFooter({ text: getRandomFooter() });

            return await interaction.editReply({ content: null, embeds: [weddingEmbed], components: [] });
          }

          // Rejected
          const rejectEmbed = new EmbedBuilder()
            .setColor(COLORS.RAPHAEL_ERROR)
            .setTitle('『 Proposal Declined 』')
            .setDescription(`**Notice:** **${targetUser.username}** has declined the proposal from **${message.author.username}**.`)
            .setFooter({ text: getRandomFooter() });

          await interaction.update({ content: null, embeds: [rejectEmbed], components: [] });
          await withdrawProposal(targetUser.id, guildId, userId)
            .catch(error => console.error('[Marry] Error removing declined proposal:', error));
        } catch (error) {
          console.error('[Marry] Error handling response:', error);
          await withdrawProposal(targetUser.id, guildId, userId).catch(() => {});
          const embed = await errorEmbed(guildId, 'Proposal Error', 'An anomaly occurred while processing the response, Master. Please propose again.');
          await (interaction.deferred || interaction.replied
            ? interaction.editReply({ content: null, embeds: [embed], components: [] })
            : interaction.update({ content: null, embeds: [embed], components: [] })
          ).catch(() => {});
        }
      });

      collector.on('end', async collected => {
        if (collected.size > 0) return;
        try {
          await withdrawProposal(targetUser.id, guildId, userId);

          const expiredEmbed = new EmbedBuilder()
            .setColor(COLORS.RAPHAEL_WARNING)
            .setTitle('『 Proposal Expired 』')
            .setDescription(`**Notice:** The proposal from **${message.author.username}** to **${targetUser.username}** has exceeded the time limit.`)
            .setFooter({ text: getRandomFooter() });

          await proposalMsg.edit({ content: null, embeds: [expiredEmbed], components: [] }).catch(() => { });
        } catch (error) {
          console.error('[Marry] Error expiring proposal:', error);
        }
      });

    } catch (error) {
      console.error('[Marry] Error:', error);
      return message.reply({
        embeds: [await errorEmbed(guildId, 'Proposal Error', 'An anomaly occurred while processing the proposal, Master.')]
      }).catch(() => {});
    }
  }
};
