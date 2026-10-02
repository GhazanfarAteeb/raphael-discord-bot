import { PermissionFlagsBits, ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType, MessageFlags } from 'discord.js';
import Guild from '../../models/Guild.js';
import { successEmbed, errorEmbed, warningEmbed, infoEmbed, GLYPHS } from '../../utils/embeds.js';
import { getPrefix, hasModPerms } from '../../utils/helpers.js';

const CONFIRM_TIMEOUT = 30000;
const PATH = 'settings.reactionRoles';

function jumpLink(guildId, panel) {
  return `https://discord.com/channels/${guildId}/${panel.channelId}/${panel.messageId}`;
}

// Delete a panel's message if it still exists
async function deletePanelMessage(guild, panel) {
  const channel = guild.channels.cache.get(panel.channelId);
  if (!channel?.messages) return;
  const msg = await channel.messages.fetch(panel.messageId).catch(() => null);
  if (msg) await msg.delete().catch(() => { });
}

export default {
  name: 'reactionroles',
  description: 'Manage reaction role panels',
  usage: 'reactionroles <list|remove|clear>',
  category: 'config',
  aliases: ['rr', 'rroles'],
  permissions: [PermissionFlagsBits.ManageGuild],
  cooldown: 5,

  async execute(message, args) {
    const guildId = message.guild.id;

    try {
      const subCommand = args[0]?.toLowerCase();
      const prefix = await getPrefix(guildId);
      const guildConfig = await Guild.getGuild(guildId);

      // Check for moderator permissions (admin, mod role, or ManageGuild)
      if (!hasModPerms(message.member, guildConfig)) {
        return message.reply({
          embeds: [await errorEmbed(guildId, 'Permission Denied',
            `${GLYPHS.LOCK} You need Moderator/Staff permissions to manage reaction roles.`)]
        });
      }

      const panels = guildConfig.settings?.reactionRoles?.messages || [];

      if (!subCommand || subCommand === 'list') {
        return listPanels(message, panels, prefix);
      }

      if (subCommand === 'remove' || subCommand === 'delete') {
        return removePanel(message, panels, args[1], prefix);
      }

      if (subCommand === 'clear') {
        return clearPanels(message, panels);
      }

      // Unknown subcommand (including the old `add`): show what is available
      return showHelp(message, prefix);
    } catch (error) {
      console.error('[ReactionRoles] Error:', error);
      return message.reply({
        embeds: [await errorEmbed(guildId, 'Error',
          `${GLYPHS.ERROR} An error occurred. Please try again.`)]
      }).catch(() => null);
    }
  }
};

async function showHelp(message, prefix) {
  const embed = await infoEmbed(message.guild.id, 'Reaction Roles Help',
    `${GLYPHS.INFO} Manage the reaction role panels on this server.`);
  embed.addFields(
    {
      name: `${GLYPHS.ARROW_RIGHT} Panels`,
      value:
        `\`${prefix}reactionroles list\` - List all panels\n` +
        `\`${prefix}reactionroles remove <number>\` - Remove a panel\n` +
        `\`${prefix}reactionroles clear\` - Remove all panels`
    },
    {
      name: `${GLYPHS.ARROW_RIGHT} Create a Panel`,
      value: `\`${prefix}colorroles [#channel]\` - Create a color roles panel`
    }
  );
  return message.reply({ embeds: [embed] });
}

async function listPanels(message, panels, prefix) {
  const guildId = message.guild.id;

  if (panels.length === 0) {
    return message.reply({
      embeds: [await infoEmbed(guildId, 'Reaction Roles',
        `${GLYPHS.INFO} No reaction role panels are set up.\n\n` +
        `Use \`${prefix}colorroles\` to set up a color roles panel.`)]
    });
  }

  const lines = panels.map((panel, i) => {
    const channel = message.guild.channels.cache.get(panel.channelId);
    return `**${i + 1}.** ${channel ? `${channel}` : 'Deleted channel'} — [Jump to message](${jumpLink(guildId, panel)})\n` +
      `${GLYPHS.DOT} Roles: ${panel.roles?.length || 0}`;
  });

  // Stay inside the 4096-character description limit
  let description = `**Total Panels:** ${panels.length}`;
  for (let i = 0; i < lines.length; i++) {
    if (description.length + lines[i].length + 40 > 4000) {
      description += `\n\n— and ${lines.length - i} more`;
      break;
    }
    description += `\n\n${lines[i]}`;
  }

  const embed = await infoEmbed(guildId, 'Reaction Role Panels', description);
  embed.addFields({
    name: `${GLYPHS.ARROW_RIGHT} Remove a Panel`,
    value: `\`${prefix}reactionroles remove <number>\``
  });

  return message.reply({ embeds: [embed] });
}

async function removePanel(message, panels, arg, prefix) {
  const guildId = message.guild.id;
  const panelIndex = parseInt(arg, 10) - 1;

  if (isNaN(panelIndex) || panelIndex < 0 || panelIndex >= panels.length) {
    return message.reply({
      embeds: [await errorEmbed(guildId, 'Invalid Panel',
        `${GLYPHS.ERROR} Please provide a valid panel number.\n\n` +
        `Use \`${prefix}reactionroles list\` to see all panels.`)]
    });
  }

  const panel = panels[panelIndex];
  await deletePanelMessage(message.guild, panel);
  await Guild.updateGuild(guildId, { $pull: { [`${PATH}.messages`]: { messageId: panel.messageId } } });

  return message.reply({
    embeds: [await successEmbed(guildId, 'Panel Removed',
      `${GLYPHS.SUCCESS} Reaction role panel #${panelIndex + 1} has been removed.`)]
  });
}

async function clearPanels(message, panels) {
  const guildId = message.guild.id;

  if (panels.length === 0) {
    return message.reply({
      embeds: [await infoEmbed(guildId, 'No Panels',
        `${GLYPHS.INFO} There are no reaction role panels to clear.`)]
    });
  }

  const confirmEmbed = await warningEmbed(guildId, 'Confirm Clear',
    `${GLYPHS.WARNING} Are you sure you want to remove **all ${panels.length}** reaction role panels?\n\n` +
    `This will also delete the panel messages.`);

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('rr_clear_confirm')
      .setLabel('Yes, Clear All')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId('rr_clear_cancel')
      .setLabel('Cancel')
      .setStyle(ButtonStyle.Secondary)
  );

  const confirmMsg = await message.reply({ embeds: [confirmEmbed], components: [row] });
  if (!confirmMsg) return null;

  const collector = confirmMsg.createMessageComponentCollector({
    componentType: ComponentType.Button,
    time: CONFIRM_TIMEOUT
  });
  let answered = false;

  collector.on('collect', async (interaction) => {
    try {
      if (interaction.user.id !== message.author.id) {
        return interaction.reply({
          content: 'Only the member who started this can confirm it, Master.',
          flags: MessageFlags.Ephemeral
        });
      }

      answered = true;
      collector.stop('answered');

      if (interaction.customId !== 'rr_clear_confirm') {
        return interaction.update({
          embeds: [await infoEmbed(guildId, 'Clear Cancelled',
            `${GLYPHS.INFO} No reaction role panels were removed.`)],
          components: []
        });
      }

      // Acknowledge first: deleting many panel messages can outlast the 3-second window
      await interaction.deferUpdate();

      for (const panel of panels) {
        await deletePanelMessage(message.guild, panel);
      }

      await Guild.updateGuild(guildId, {
        $set: {
          [`${PATH}.messages`]: [],
          [`${PATH}.enabled`]: false
        }
      });

      await interaction.editReply({
        embeds: [await successEmbed(guildId, 'All Panels Cleared',
          `${GLYPHS.SUCCESS} All ${panels.length} reaction role panels have been removed.`)],
        components: []
      });
    } catch (error) {
      console.error('[ReactionRoles] Clear error:', error);
      const embed = await errorEmbed(guildId, 'Clear Failed',
        `${GLYPHS.ERROR} The panels could not be cleared. Please try again.`).catch(() => null);
      if (embed) await confirmMsg.edit({ embeds: [embed], components: [] }).catch(() => { });
    }
  });

  collector.on('end', async () => {
    if (answered) return;
    try {
      await confirmMsg.edit({
        embeds: [await infoEmbed(guildId, 'Confirmation Expired',
          `${GLYPHS.INFO} No answer was given, so no reaction role panels were removed.`)],
        components: []
      });
    } catch {
      // Message was deleted
    }
  });

  return confirmMsg;
}
