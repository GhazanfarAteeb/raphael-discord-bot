import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType, MessageFlags, PermissionFlagsBits } from 'discord.js';
import Guild from '../../models/Guild.js';
import Verification from '../../models/Verification.js';
import { successEmbed, errorEmbed, infoEmbed, COLORS, GLYPHS } from '../../utils/embeds.js';
import { getPrefix, getAssignableRoleError } from '../../utils/helpers.js';
import { getRandomFooter } from '../../utils/raphael.js';
import { logManualVerification } from '../../events/client/verificationHandler.js';
import logger from '../../utils/logger.js';

// Wizard buttons must not start with "verify_": verificationHandler claims every such
// customId as a member pressing the verification panel
const SETUP_PREFIX = 'vsetup_';
const STEP_TIMEOUT_MS = 60000;
const VERIFICATION_TYPES = [
  { type: 'button', label: 'Button', style: ButtonStyle.Primary, summary: 'Members press a button to verify' },
  { type: 'captcha', label: 'Captcha', style: ButtonStyle.Success, summary: 'Members solve a captcha code' },
  { type: 'reaction', label: 'Reaction', style: ButtonStyle.Secondary, summary: 'Members react to verify' }
];
const TYPE_NAMES = VERIFICATION_TYPES.map(t => t.type);
const PANEL_PERMISSIONS = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks];

// Shared with verificationReactionHandler.js. The reaction is a Discord reaction on the panel,
// never bot text; the title identifies panels posted before panels were recorded.
export const VERIFICATION_REACTION = '✅';
export const VERIFICATION_PANEL_TITLE = '『 Server Verification 』';

export default {
  name: 'verify',
  description: 'Setup or manage the verification system',
  usage: '<setup|panel|config|manual|status> [options]',
  aliases: ['verification'],
  category: 'moderation',
  permissions: [PermissionFlagsBits.ManageGuild],
  cooldown: 5,

  async execute(message, args) {
    const guildId = message.guild.id;

    try {
      const prefix = await getPrefix(guildId);
      const subCommand = args[0]?.toLowerCase();

      if (!subCommand) {
        const embed = await infoEmbed(guildId, 'Verification System',
          'Verification restricts server access until new members confirm they are human, Master.');
        embed.addFields(
          { name: `${GLYPHS.ARROW_RIGHT} ${prefix}verify setup`, value: 'Guided setup wizard', inline: true },
          { name: `${GLYPHS.ARROW_RIGHT} ${prefix}verify panel [#channel]`, value: 'Deploy the verification panel', inline: true },
          { name: `${GLYPHS.ARROW_RIGHT} ${prefix}verify config <option>`, value: 'Adjust individual settings', inline: true },
          { name: `${GLYPHS.ARROW_RIGHT} ${prefix}verify manual @user`, value: 'Verify a member manually', inline: true },
          { name: `${GLYPHS.ARROW_RIGHT} ${prefix}verify status`, value: 'View the current configuration', inline: true }
        );
        return message.reply({ embeds: [embed] });
      }

      const guildConfig = await Guild.getGuild(guildId);

      switch (subCommand) {
        case 'setup':
          return await runSetup(message, prefix);

        case 'panel': {
          const vs = guildConfig.features?.verificationSystem;
          if (!vs?.enabled) {
            return message.reply({
              embeds: [await errorEmbed(guildId, 'Not Configured',
                `The verification system is not active. Run \`${prefix}verify setup\` first, Master.`)]
            });
          }

          const channel = message.mentions.channels.first() || message.channel;
          const channelError = getPanelChannelError(channel, vs.type);
          if (channelError) {
            return message.reply({ embeds: [await errorEmbed(guildId, 'Invalid Channel', channelError)] });
          }

          try {
            await sendVerificationPanel(channel, vs.type);
          } catch (error) {
            logger.error(`[Verify] Could not post the verification panel in ${channel.id} (${guildId})`, error);
            return message.reply({
              embeds: [await errorEmbed(guildId, 'Panel Not Sent',
                `I could not post the panel in ${channel}, Master. Please check my permissions there.`)]
            });
          }

          if (channel.id !== message.channel.id) {
            return message.reply({
              embeds: [await successEmbed(guildId, 'Panel Deployed', `Verification panel deployed to ${channel}, Master.`)]
            });
          }
          return null;
        }

        case 'manual':
          return await manualVerify(message, guildConfig, prefix);

        case 'config':
          return await configure(message, args, prefix);

        case 'status': {
          const vs = guildConfig.features?.verificationSystem;
          const role = vs?.role ? message.guild.roles.cache.get(vs.role) : null;
          const unverifiedRole = vs?.unverifiedRole ? message.guild.roles.cache.get(vs.unverifiedRole) : null;
          const channel = vs?.channel ? message.guild.channels.cache.get(vs.channel) : null;
          const panel = vs?.panelMessageId && vs?.panelChannelId
            ? `[View panel](https://discord.com/channels/${guildId}/${vs.panelChannelId}/${vs.panelMessageId}) in <#${vs.panelChannelId}>`
            : 'Not recorded';

          const embed = new EmbedBuilder()
            .setColor(vs?.enabled ? COLORS.RAPHAEL_SUCCESS : COLORS.RAPHAEL_ERROR)
            .setTitle('『 Verification Status 』')
            .addFields(
              { name: `${GLYPHS.ARROW_RIGHT} Status`, value: vs?.enabled ? `${GLYPHS.SUCCESS} Active` : `${GLYPHS.INFO} Inactive`, inline: true },
              { name: `${GLYPHS.ARROW_RIGHT} Type`, value: vs?.type || 'Not configured', inline: true },
              { name: `${GLYPHS.ARROW_RIGHT} Verified Role`, value: role ? role.toString() : 'Not configured', inline: true },
              { name: `${GLYPHS.ARROW_RIGHT} Unverified Role`, value: unverifiedRole ? unverifiedRole.toString() : 'Not configured', inline: true },
              { name: `${GLYPHS.ARROW_RIGHT} Channel`, value: channel ? channel.toString() : 'Not configured', inline: true },
              { name: `${GLYPHS.ARROW_RIGHT} Panel`, value: panel, inline: true }
            )
            .setFooter({ text: getRandomFooter() })
            .setTimestamp();

          return message.reply({ embeds: [embed] });
        }

        default:
          return message.reply({
            embeds: [await errorEmbed(guildId, 'Invalid Usage',
              `Unknown subcommand \`${subCommand.slice(0, 50).replace(/`/g, '')}\`. Use \`${prefix}verify\` for guidance, Master.`)]
          });
      }
    } catch (error) {
      logger.error('[Verify] Command failed', error);
      const embed = await errorEmbed(guildId, 'Verification Error',
        'An anomaly interrupted the verification command, Master. The incident has been logged.').catch(() => null);
      return message.reply(embed ? { embeds: [embed] } : { content: '**Alert:** The verification command failed, Master.' }).catch(() => null);
    }
  }
};

// Three-step wizard: type (buttons), verified role, panel channel. Nothing is saved until
// the final step succeeds, so an abandoned wizard leaves the existing configuration intact.
async function runSetup(message, prefix) {
  const guildId = message.guild.id;

  const buildRow = (disabled = false) => new ActionRowBuilder().addComponents(
    VERIFICATION_TYPES.map(({ type, label, style }) => new ButtonBuilder()
      .setCustomId(`${SETUP_PREFIX}${type}`)
      .setLabel(label)
      .setStyle(style)
      .setDisabled(disabled))
  );

  const intro = await infoEmbed(guildId, 'Verification Setup — Step 1 of 3',
    'Select the verification method new members must complete, Master.');
  intro.addFields(VERIFICATION_TYPES.map(({ label, summary }) => ({ name: `${GLYPHS.ARROW_RIGHT} ${label}`, value: summary, inline: true })));

  const setupMsg = await message.reply({ embeds: [intro], components: [buildRow()] });

  const collector = setupMsg.createMessageComponentCollector({
    componentType: ComponentType.Button,
    filter: i => i.customId.startsWith(SETUP_PREFIX),
    time: STEP_TIMEOUT_MS
  });

  collector.on('collect', async interaction => {
    try {
      if (interaction.user.id !== message.author.id) {
        return await interaction.reply({
          content: '**Notice:** This setup session belongs to another administrator, Master.',
          flags: MessageFlags.Ephemeral
        });
      }
      collector.stop('selected');

      const type = interaction.customId.slice(SETUP_PREFIX.length);
      if (!TYPE_NAMES.includes(type)) return null;

      const roleStep = await infoEmbed(guildId, 'Verification Setup — Step 2 of 3',
        `Verification type recorded as **${type}**, Master.\n\n` +
        'Mention the role verified members should receive.\n*Example: @Verified or @Member*');
      await interaction.update({ embeds: [roleStep], components: [] });

      const roleReply = await awaitMention(message, m => m.mentions.roles.first());
      if (!roleReply) return await sendTimedOut(message, prefix);

      const role = roleReply.value;
      const roleError = getAssignableRoleError(role, message.member);
      if (roleError) {
        return await roleReply.message.reply({
          embeds: [await errorEmbed(guildId, 'Invalid Role', `${roleError} Run \`${prefix}verify setup\` again with a different role.`)]
        });
      }

      const channelStep = await infoEmbed(guildId, 'Verification Setup — Step 3 of 3',
        `Verified role recorded as ${role}, Master.\n\n` +
        'Mention the channel where the verification panel should be posted.\n*Example: #verify or #welcome*');
      await message.channel.send({ embeds: [channelStep] });

      const channelReply = await awaitMention(message, m => m.mentions.channels.first());
      if (!channelReply) return await sendTimedOut(message, prefix);

      const channel = channelReply.value;
      const channelError = getPanelChannelError(channel, type);
      if (channelError) {
        return await channelReply.message.reply({
          embeds: [await errorEmbed(guildId, 'Invalid Channel', `${channelError} Run \`${prefix}verify setup\` again with a different channel.`)]
        });
      }

      await sendVerificationPanel(channel, type);

      await Guild.updateGuild(guildId, {
        $set: {
          'features.verificationSystem.type': type,
          'features.verificationSystem.role': role.id,
          'features.verificationSystem.channel': channel.id,
          'features.verificationSystem.enabled': true,
          'roles.verifiedRole': role.id
        }
      });

      const complete = await successEmbed(guildId, 'Verification System Configured',
        `**Confirmed:** Verification system is now active, Master.\n\n` +
        `**${GLYPHS.ARROW_RIGHT} Type:** ${type}\n` +
        `**${GLYPHS.ARROW_RIGHT} Role:** ${role}\n` +
        `**${GLYPHS.ARROW_RIGHT} Channel:** ${channel}\n\n` +
        'New members will require verification for server access.');
      complete.setFooter({ text: `Use ${prefix}verify panel to resend the panel` });

      return await message.channel.send({ embeds: [complete] });
    } catch (error) {
      logger.error('[Verify] Setup wizard failed', error);
      const embed = await errorEmbed(guildId, 'Setup Failed',
        'An anomaly interrupted the setup, Master. No changes were saved unless confirmed above.').catch(() => null);
      if (embed) await message.channel.send({ embeds: [embed] }).catch(() => {});
      return null;
    }
  });

  collector.on('end', async (_collected, reason) => {
    if (reason === 'selected') return; // the selection already replaced the buttons
    try {
      const expired = await infoEmbed(guildId, 'Verification Setup — Expired',
        `No verification method was selected within 60 seconds. Run \`${prefix}verify setup\` again when ready, Master.`);
      await setupMsg.edit({ embeds: [expired], components: [buildRow(true)] });
    } catch {
      // Setup message deleted
    }
  });

  return setupMsg;
}

// The next message from the command author for which `pick` returns a value, or null on timeout
async function awaitMention(message, pick) {
  const collected = await message.channel.awaitMessages({
    filter: m => m.author.id === message.author.id && Boolean(pick(m)),
    max: 1,
    time: STEP_TIMEOUT_MS
  });
  const reply = collected.first();
  return reply ? { message: reply, value: pick(reply) } : null;
}

async function sendTimedOut(message, prefix) {
  const embed = await errorEmbed(message.guild.id, 'Setup Timed Out',
    `No response was received within 60 seconds. Run \`${prefix}verify setup\` again when ready, Master. No changes were saved.`);
  return message.channel.send({ embeds: [embed] });
}

async function manualVerify(message, guildConfig, prefix) {
  const guildId = message.guild.id;
  const targetMember = message.mentions.members?.first();
  if (!targetMember) {
    return message.reply({
      embeds: [await errorEmbed(guildId, 'Invalid Usage', `Mention the member to verify: \`${prefix}verify manual @user\`, Master.`)]
    });
  }

  const verifiedRole = guildConfig.features?.verificationSystem?.role || guildConfig.roles?.verifiedRole;
  if (!verifiedRole) {
    return message.reply({
      embeds: [await errorEmbed(guildId, 'Not Configured', `No verified role is configured. Run \`${prefix}verify setup\` first, Master.`)]
    });
  }

  try {
    await targetMember.roles.add(verifiedRole);
  } catch (error) {
    logger.error(`[Verify] Failed to add the verified role to ${targetMember.id} in ${guildId}`, error);
    return message.reply({
      embeds: [await errorEmbed(guildId, 'Verification Failed',
        'I could not assign the verified role, Master. Confirm that it still exists and sits below my highest role.')]
    });
  }

  // Remove unverified role if configured
  const unverifiedRole = guildConfig.features?.verificationSystem?.unverifiedRole;
  if (unverifiedRole && targetMember.roles.cache.has(unverifiedRole)) {
    await targetMember.roles.remove(unverifiedRole).catch(() => {});
  }

  const verification = await Verification.getVerification(guildId, targetMember.id);
  await verification.verify(`staff:${message.author.id}`);

  await logManualVerification(targetMember, message.author, guildConfig);

  return message.reply({
    embeds: [await successEmbed(guildId, 'Member Verified', `**${targetMember.user.username}** has been manually verified, Master.`)]
  });
}

async function configure(message, args, prefix) {
  const guildId = message.guild.id;
  const setting = args[1]?.toLowerCase();
  const value = args.slice(2).join(' ').trim().toLowerCase();

  const showOptions = async (lead) => {
    const embed = await infoEmbed(guildId, 'Verification Config', lead);
    embed.addFields(
      { name: `${GLYPHS.ARROW_RIGHT} type <button|captcha|reaction>`, value: 'Set the verification type' },
      { name: `${GLYPHS.ARROW_RIGHT} role <@role>`, value: 'Set the verified role' },
      { name: `${GLYPHS.ARROW_RIGHT} unverifiedrole <@role|remove>`, value: 'Set the role removed on verification' },
      { name: `${GLYPHS.ARROW_RIGHT} channel <#channel>`, value: 'Set the verification channel' },
      { name: `${GLYPHS.ARROW_RIGHT} enable | disable`, value: 'Toggle the verification system' }
    );
    return message.reply({ embeds: [embed] });
  };

  const confirm = async (title, description) => message.reply({ embeds: [await successEmbed(guildId, title, description)] });
  const reject = async (title, description) => message.reply({ embeds: [await errorEmbed(guildId, title, description)] });

  switch (setting) {
    case undefined:
      return showOptions(`Usage: \`${prefix}verify config <option> [value]\`, Master.`);

    case 'type': {
      if (!TYPE_NAMES.includes(value)) {
        return reject('Invalid Usage', 'The type must be `button`, `captcha` or `reaction`, Master.');
      }
      await Guild.updateGuild(guildId, { $set: { 'features.verificationSystem.type': value } });
      return confirm('Verification Updated',
        `Verification type set to **${value}**, Master. Run \`${prefix}verify panel\` to deploy a matching panel.`);
    }

    case 'role': {
      const role = message.mentions.roles.first();
      if (!role) return reject('Invalid Usage', 'Please mention a role, Master.');
      const roleError = getAssignableRoleError(role, message.member);
      if (roleError) return reject('Invalid Role', roleError);
      await Guild.updateGuild(guildId, {
        $set: {
          'features.verificationSystem.role': role.id,
          'roles.verifiedRole': role.id
        }
      });
      return confirm('Verification Updated', `Verified role set to ${role}, Master.`);
    }

    case 'unverifiedrole': {
      if (value === 'remove' || value === 'none') {
        await Guild.updateGuild(guildId, { $unset: { 'features.verificationSystem.unverifiedRole': '' } });
        return confirm('Verification Updated', 'Unverified role cleared, Master.');
      }
      const unverifiedRole = message.mentions.roles.first();
      if (!unverifiedRole) return reject('Invalid Usage', 'Please mention a role, or use `remove` to clear it, Master.');
      await Guild.updateGuild(guildId, { $set: { 'features.verificationSystem.unverifiedRole': unverifiedRole.id } });
      return confirm('Verification Updated',
        `Unverified role set to ${unverifiedRole}. It will be **removed** when a member verifies, Master.`);
    }

    case 'channel': {
      const channel = message.mentions.channels.first();
      if (!channel) return reject('Invalid Usage', 'Please mention a channel, Master.');
      if (!channel.isTextBased()) return reject('Invalid Channel', `${channel} is not a text channel, Master.`);
      await Guild.updateGuild(guildId, { $set: { 'features.verificationSystem.channel': channel.id } });
      return confirm('Verification Updated', `Verification channel set to ${channel}, Master.`);
    }

    case 'enable':
      await Guild.updateGuild(guildId, { $set: { 'features.verificationSystem.enabled': true } });
      return confirm('Verification Activated', 'Verification system activated, Master.');

    case 'disable':
      await Guild.updateGuild(guildId, { $set: { 'features.verificationSystem.enabled': false } });
      return confirm('Verification Deactivated', '**Notice:** Verification system deactivated, Master.');

    default:
      return showOptions(`**Notice:** \`${setting.slice(0, 50).replace(/`/g, '')}\` is not a recognised option, Master.`);
  }
}

// Why the panel cannot be posted in `channel`, or null if it can (also for the /verify slash command)
export function getPanelChannelError(channel, type) {
  if (!channel?.isTextBased?.()) return `${channel ?? 'That channel'} is not a text channel, Master.`;
  const me = channel.guild.members.me;
  const needed = type === 'reaction' ? [...PANEL_PERMISSIONS, PermissionFlagsBits.AddReactions] : PANEL_PERMISSIONS;
  if (!channel.permissionsFor(me)?.has(needed)) {
    return `I lack permission to post the panel in ${channel}, Master. I need View Channel, Send Messages and Embed Links${type === 'reaction' ? ', and Add Reactions' : ''}.`;
  }
  return null;
}

/**
 * Posts the verification panel for `type` in `channel` and records it as the guild's panel
 * (features.verificationSystem.panelMessageId / panelChannelId); reaction verification only
 * accepts the recorded panel. Buttons for the button and captcha types (custom IDs handled by
 * verificationHandler.js), a reaction for the reaction type (verificationReactionHandler.js).
 * Throws when the panel cannot be posted. A reaction panel that cannot be completed (the
 * reaction or the record failed) is deleted again before throwing, so it never sits there
 * unanswered; a button panel works without the record, so that failure is only logged.
 * @param {import('discord.js').GuildTextBasedChannel} channel
 * @param {'button'|'captcha'|'reaction'} [type]
 * @returns {Promise<import('discord.js').Message>} the posted panel
 */
export async function sendVerificationPanel(channel, type = 'button') {
  const panelType = TYPE_NAMES.includes(type) ? type : 'button';
  const instructions = {
    button: '**Activate the button below to proceed.**',
    captcha: '**Activate the button below to receive a verification code.**',
    reaction: '**Apply the reaction below to verify.**'
  };

  const embed = new EmbedBuilder()
    .setColor(COLORS.RAPHAEL)
    .setTitle(VERIFICATION_PANEL_TITLE)
    .setDescription(`**Notice:** Access to this server requires verification, Master.\n\n${instructions[panelType]}`)
    .setFooter({ text: 'Security protocol active.' });

  let panel;
  if (panelType === 'reaction') {
    panel = await channel.send({ embeds: [embed] });
    try {
      await panel.react(VERIFICATION_REACTION);
    } catch (error) {
      await panel.delete().catch(() => { });
      throw error;
    }
  } else {
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`verify_${panelType}`)
        .setLabel(panelType === 'captcha' ? 'Get Captcha' : 'Verify')
        .setStyle(ButtonStyle.Success)
    );
    panel = await channel.send({ embeds: [embed], components: [row] });
  }

  try {
    await Guild.updateGuild(channel.guild.id, {
      $set: {
        'features.verificationSystem.panelMessageId': panel.id,
        'features.verificationSystem.panelChannelId': channel.id
      }
    });
  } catch (error) {
    if (panelType === 'reaction') {
      await panel.delete().catch(() => { });
      throw error;
    }
    logger.error(`[Verify] Could not record the verification panel ${panel.id} in ${channel.guild.id}`, error);
  }

  return panel;
}
