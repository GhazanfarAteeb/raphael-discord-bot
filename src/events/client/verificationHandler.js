import {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  AttachmentBuilder,
  MessageFlags,
  UserFlagsBitField
} from 'discord.js';
import Guild from '../../models/Guild.js';
import Verification from '../../models/Verification.js';
import { generateCaptchaImage, generateCaptchaCode } from '../../utils/captchaGenerator.js';
import { successEmbed, errorEmbed, warningEmbed, infoEmbed, COLORS, GLYPHS } from '../../utils/embeds.js';
import { getAssignableRoleError } from '../../utils/helpers.js';
import { getRandomFooter } from '../../utils/raphael.js';

// Rate limiting for verification attempts
const verificationCooldowns = new Map();
const COOLDOWN_DURATION = 30000; // 30 seconds between attempts

const CAPTCHA_LENGTH = 6;
const CAPTCHA_MAX_ATTEMPTS = 3;
const CAPTCHA_LIFETIME_MS = 5 * 60 * 1000;
const CAPTCHA_MAX_MESSAGES = 10;
const DAY_MS = 24 * 60 * 60 * 1000;
const SUCCESS_THREAD_DELETE_MS = 10000;
const END_THREAD_DELETE_MS = 5000;
const CANCEL_THREAD_DELETE_MS = 2000;
const THREAD_NAME_MAX = 100;

const NOT_CONFIGURED = 'Verification is not properly configured, Master. Please contact an administrator.';

function capitalize(text) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// The verification log, falling back to the member log
function getVerificationLogChannel(guild, guildConfig) {
  const logChannelId = guildConfig?.channels?.verificationLog || guildConfig?.channels?.memberLog;
  return logChannelId ? guild.channels.cache.get(logChannelId) : null;
}

// Helper function to log verification events
async function logVerification(member, verificationType, guildConfig) {
  try {
    const logChannel = getVerificationLogChannel(member.guild, guildConfig);
    if (!logChannel) return;

    const embed = new EmbedBuilder()
      .setTitle('『 Member Verified 』')
      .setColor(COLORS.RAPHAEL_SUCCESS)
      .setDescription(`${GLYPHS.SUCCESS} **${member.user.username}** has completed verification.`)
      .addFields(
        { name: `${GLYPHS.ARROW_RIGHT} Member`, value: `${member.user.tag} (${member})`, inline: true },
        { name: `${GLYPHS.ARROW_RIGHT} Verification Type`, value: capitalize(verificationType), inline: true },
        { name: `${GLYPHS.ARROW_RIGHT} Verified By`, value: 'System (self-verification)', inline: true }
      )
      .setThumbnail(member.user.displayAvatarURL())
      .setFooter({ text: `User ID: ${member.id}` })
      .setTimestamp();

    await logChannel.send({ embeds: [embed] });
  } catch (error) {
    console.error('[Verification] Error logging verification:', error);
  }
}

// Helper function to log manual verification
async function logManualVerification(member, executor, guildConfig) {
  try {
    const logChannel = getVerificationLogChannel(member.guild, guildConfig);
    if (!logChannel) return;

    const verifiedByText = executor.bot
      ? `${executor.username} (bot)`
      : `${executor.username} (${executor})`;

    const embed = new EmbedBuilder()
      .setTitle('『 Member Manually Verified 』')
      .setColor(COLORS.RAPHAEL)
      .setDescription(`${GLYPHS.SUCCESS} **${member.user.username}** was verified by staff.`)
      .addFields(
        { name: `${GLYPHS.ARROW_RIGHT} Member`, value: `${member.user.tag} (${member})`, inline: true },
        { name: `${GLYPHS.ARROW_RIGHT} Verification Type`, value: 'Manual', inline: true },
        { name: `${GLYPHS.ARROW_RIGHT} Verified By`, value: verifiedByText, inline: true }
      )
      .setThumbnail(member.user.displayAvatarURL())
      .setFooter({ text: `User ID: ${member.id}` })
      .setTimestamp();

    await logChannel.send({ embeds: [embed] });
  } catch (error) {
    console.error('[Verification] Error logging manual verification:', error);
  }
}

// Export the manual verification logger for use in verify command, and the shared
// verification steps for the reaction panel (verificationReactionHandler.js)
export {
  logManualVerification,
  logVerification,
  getVerifiedRoleProblem,
  runSecurityChecks,
  securityBlockedEmbed,
  grantVerifiedRoles,
  NOT_CONFIGURED
};

export default {
  name: 'interactionCreate',

  async execute(interaction, client) {
    // Only verification panel buttons ("verify_"; the setup wizard uses "vsetup_") and
    // captcha thread buttons
    if (!interaction.isButton() || !interaction.inCachedGuild()) return;

    try {
      if (interaction.customId.startsWith('verify_')) {
        await handleVerifyButton(interaction, client);
      } else if (interaction.customId.startsWith('captcha_')) {
        await handleCaptchaButton(interaction, client);
      }
    } catch (error) {
      console.error(`[Verification] ${interaction.customId} failed:`, error);
      await sendEphemeral(interaction,
        await errorEmbed(interaction.guildId, 'Verification Failed',
          'An error occurred during verification, Master. Please try again.').catch(() => null));
    }
  }
};

// Ephemeral answer that never throws (the interaction may already be answered or expired)
async function sendEphemeral(interaction, embed) {
  if (!embed) return null;
  try {
    if (interaction.deferred || interaction.replied) {
      return await interaction.editReply({ content: null, embeds: [embed], components: [] });
    }
    return await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  } catch (error) {
    console.error('[Verification] Could not respond to interaction:', error.message);
    return null;
  }
}

// Why the configured verified role cannot be given out, or null when it can
function getVerifiedRoleProblem(guild, roleId) {
  const role = guild.roles.cache.get(roleId);
  if (!role) return `the verified role ${roleId} no longer exists`;
  if (!guild.members.me) return 'my member data is not cached';
  // Checked against myself: covers @everyone, managed roles, my hierarchy and roles
  // with moderation permissions, which must never be handed out by a button
  return getAssignableRoleError(role, guild.members.me);
}

async function handleVerifyButton(interaction, client) {
  const guildId = interaction.guild.id;
  const userId = interaction.user.id;
  const member = interaction.member;

  const guildConfig = await Guild.getGuild(guildId);

  const verifiedRole = guildConfig.features?.verificationSystem?.role || guildConfig.roles?.verifiedRole;
  if (!verifiedRole) {
    return sendEphemeral(interaction, await errorEmbed(guildId, 'Not Configured', NOT_CONFIGURED));
  }

  // The role decides, not the record: a member who left and rejoined keeps a
  // "verified" record but lost the role
  if (member.roles.cache.has(verifiedRole)) {
    return sendEphemeral(interaction, await infoEmbed(guildId, 'Already Verified',
      '**Notice:** You are already verified, Master.'));
  }

  const roleProblem = getVerifiedRoleProblem(interaction.guild, verifiedRole);
  if (roleProblem) {
    console.warn(`[Verification] Cannot assign the verified role in ${interaction.guild.name} (${guildId}): ${roleProblem}`);
    return sendEphemeral(interaction, await errorEmbed(guildId, 'Not Configured', NOT_CONFIGURED));
  }

  const verification = await Verification.getVerification(guildId, userId);
  const type = interaction.customId.split('_')[1];

  if (type === 'button') {
    await handleButtonVerification(interaction, verification, verifiedRole, guildConfig);
  } else if (type === 'captcha') {
    await handleCaptchaVerification(interaction, verification, verifiedRole, guildConfig);
  }
}

// Pre-verification security checks
async function runSecurityChecks(member, guildConfig) {
  const issues = [];
  const settings = guildConfig.features?.verificationSystem?.securityChecks || {};

  // Account age check
  if (settings.minAccountAge) {
    const accountAge = Date.now() - member.user.createdTimestamp;
    const minAge = settings.minAccountAge * DAY_MS;
    if (accountAge < minAge) {
      const daysOld = Math.floor(accountAge / DAY_MS);
      issues.push(`${GLYPHS.WARNING} Account too new (${daysOld} days old; at least ${settings.minAccountAge} days required)`);
    }
  }

  // Avatar check - accounts without avatars are often bots/spam
  if (settings.requireAvatar && !member.user.avatar) {
    issues.push(`${GLYPHS.WARNING} No profile avatar set`);
  }

  // Discord's spammer flag (unusual DM activity)
  if (member.user.flags?.has(UserFlagsBitField.Flags.Spammer)) {
    issues.push(`${GLYPHS.ALERT} Account flagged by Discord for unusual activity`);
  }

  return {
    passed: issues.length === 0,
    issues
  };
}

async function securityBlockedEmbed(guildId, issues) {
  const embed = await warningEmbed(guildId, 'Verification Blocked',
    `**Notice:** Your account did not pass the security checks, Master.\n\n${issues.join('\n')}`);
  return embed.setFooter({ text: 'Please contact a moderator if you believe this is an error.' });
}

// Give the verified role and drop the unverified one
async function grantVerifiedRoles(member, verifiedRole, guildConfig, method) {
  await member.roles.add(verifiedRole, `Verified (${method})`);

  const unverifiedRole = guildConfig.features?.verificationSystem?.unverifiedRole;
  if (unverifiedRole && member.roles.cache.has(unverifiedRole)) {
    await member.roles.remove(unverifiedRole, `Verified (${method})`).catch(() => { });
  }
}

async function handleButtonVerification(interaction, verification, verifiedRole, guildConfig) {
  const member = interaction.member;
  const guildId = interaction.guild.id;

  // Run security checks
  const securityResult = await runSecurityChecks(member, guildConfig);
  if (!securityResult.passed) {
    return sendEphemeral(interaction, await securityBlockedEmbed(guildId, securityResult.issues));
  }

  await grantVerifiedRoles(member, verifiedRole, guildConfig, 'button');
  await verification.verify('button');

  // Log the verification
  await logVerification(member, 'button', guildConfig);

  return sendEphemeral(interaction, await successEmbed(guildId, 'Verification Complete',
    'You have been verified and now have access to the server, Master. Welcome.'));
}

async function handleCaptchaVerification(interaction, verification, verifiedRole, guildConfig) {
  const member = interaction.member;
  const userId = interaction.user.id;
  const guildId = interaction.guild.id;

  // Check cooldown
  const cooldownKey = `${guildId}_${userId}`;
  const cooldownEnd = verificationCooldowns.get(cooldownKey);
  if (cooldownEnd && Date.now() < cooldownEnd) {
    const remaining = Math.ceil((cooldownEnd - Date.now()) / 1000);
    return sendEphemeral(interaction, await warningEmbed(guildId, 'Please Wait',
      `Please wait ${remaining} seconds before trying again, Master.`));
  }

  // Run security checks
  const securityResult = await runSecurityChecks(member, guildConfig);
  if (!securityResult.passed) {
    return sendEphemeral(interaction, await securityBlockedEmbed(guildId, securityResult.issues));
  }

  // Check if user already has a pending verification thread
  if (verification.captcha?.threadId) {
    const existingThread = await interaction.guild.channels.fetch(verification.captcha.threadId).catch(() => null);
    if (existingThread) {
      return sendEphemeral(interaction, await infoEmbed(guildId, 'Thread Already Open',
        `**Notice:** You already have a verification thread open, Master: ${existingThread}`));
    }
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  let thread;
  try {
    // Create a private thread for verification (fallback to public if private fails)
    try {
      thread = await interaction.channel.threads.create({
        name: `verify-${interaction.user.username}`.slice(0, THREAD_NAME_MAX),
        type: ChannelType.PrivateThread,
        autoArchiveDuration: 60, // Auto archive after 1 hour
        invitable: false, // Only mods can add people
        reason: `Verification thread for ${interaction.user.tag}`
      });
    } catch (privateThreadError) {
      console.log('[Verification] Private thread creation failed, trying a public thread:', privateThreadError.message);
      // Private threads may be unavailable in this channel
      thread = await interaction.channel.threads.create({
        name: `verify-${interaction.user.username}-${Date.now().toString(36)}`.slice(0, THREAD_NAME_MAX),
        type: ChannelType.PublicThread,
        autoArchiveDuration: 60,
        reason: `Verification thread for ${interaction.user.tag}`
      });
    }
  } catch (error) {
    console.error('[Verification] Captcha thread creation error:', error);
    console.error('[Verification] Error details:', {
      code: error.code,
      message: error.message,
      channelType: interaction.channel?.type,
      guildId: interaction.guild?.id,
      permissions: interaction.guild?.members?.me?.permissionsIn(interaction.channel)?.toArray()
    });
    return sendEphemeral(interaction, await errorEmbed(guildId, 'Thread Not Created',
      'I could not create a verification thread, Master. I need the Create Private Threads (or Create Public Threads) ' +
      'and Send Messages in Threads permissions here. Please contact a moderator.'));
  }

  try {
    // Add the user to the thread
    await thread.members.add(userId);

    // Generate captcha
    const captchaCode = generateCaptchaCode(CAPTCHA_LENGTH);
    const captchaBuffer = await generateCaptchaImage(captchaCode);

    // Save captcha data with thread ID
    verification.captcha = {
      code: captchaCode,
      attempts: 0,
      maxAttempts: CAPTCHA_MAX_ATTEMPTS,
      expiresAt: new Date(Date.now() + CAPTCHA_LIFETIME_MS),
      threadId: thread.id
    };
    verification.pendingVerification = true;
    await verification.save();

    // Create captcha image attachment
    const attachment = new AttachmentBuilder(captchaBuffer, { name: 'captcha.png' });

    // Create buttons for the captcha thread
    const row = new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId(`captcha_refresh_${userId}`)
          .setLabel('New Code')
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId(`captcha_cancel_${userId}`)
          .setLabel('Cancel')
          .setStyle(ButtonStyle.Danger)
      );

    // Send captcha in thread
    const captchaEmbed = new EmbedBuilder()
      .setColor(COLORS.RAPHAEL)
      .setTitle('『 Captcha Verification 』')
      .setDescription(
        `**Notice:** ${interaction.user}, type the code shown in the image below to verify, Master.\n\n` +
        `${GLYPHS.ARROW_RIGHT} The code is not case-sensitive\n` +
        `${GLYPHS.ARROW_RIGHT} You have ${CAPTCHA_MAX_ATTEMPTS} attempts and 5 minutes\n` +
        `${GLYPHS.ARROW_RIGHT} Press **New Code** if the image is hard to read`
      )
      .setImage('attachment://captcha.png')
      .setFooter({ text: `Attempts: 0/${CAPTCHA_MAX_ATTEMPTS} • Expires in 5 minutes` })
      .setTimestamp();

    await thread.send({
      content: `${interaction.user}`,
      embeds: [captchaEmbed],
      files: [attachment],
      components: [row]
    });

    // Set up message collector for captcha responses
    const filter = m => m.author.id === userId && !m.author.bot;
    const collector = thread.createMessageCollector({
      filter,
      time: CAPTCHA_LIFETIME_MS,
      max: CAPTCHA_MAX_MESSAGES
    });

    collector.on('collect', async (message) => {
      try {
        await handleCaptchaAnswer(message, collector, thread, member, verifiedRole, guildConfig);
      } catch (error) {
        console.error('[Verification] Error checking captcha answer:', error);
      }
    });

    collector.on('end', async (collected, reason) => {
      if (reason === 'success') return;

      // Set cooldown
      verificationCooldowns.set(cooldownKey, Date.now() + COOLDOWN_DURATION);
      setTimeout(() => verificationCooldowns.delete(cooldownKey), COOLDOWN_DURATION);

      const endMessages = {
        max_attempts: 'Too many failed attempts, Master. Please wait 30 seconds and try again.',
        time: 'Verification timed out, Master. Please try again.',
        cancelled: 'Verification cancelled, Master.'
      };

      try {
        const endEmbed = await warningEmbed(guildId, 'Verification Ended',
          endMessages[reason] || 'Verification ended, Master. Please try again.');
        await thread.send({ embeds: [endEmbed] }).catch(() => null);

        // Clear pending verification
        const currentVerification = await Verification.getVerification(guildId, userId);
        currentVerification.pendingVerification = false;
        currentVerification.captcha = undefined;
        await currentVerification.save();

        // Delete thread after delay
        setTimeout(() => {
          thread.delete().catch(() => { });
        }, END_THREAD_DELETE_MS);
      } catch (error) {
        console.error('[Verification] Error closing captcha session:', error);
      }
    });

    // Reply to original interaction
    return sendEphemeral(interaction, await successEmbed(guildId, 'Verification Thread Created',
      `A private verification thread has been created for you, Master: ${thread}\n\nPlease enter the captcha code there.`));
  } catch (error) {
    // The thread exists but the captcha could not be set up in it
    thread.delete().catch(() => { });
    throw error;
  }
}

async function handleCaptchaAnswer(message, collector, thread, member, verifiedRole, guildConfig) {
  const guildId = member.guild.id;
  const input = message.content.trim().toUpperCase();

  // Refresh verification data
  const currentVerification = await Verification.getVerification(guildId, member.id);

  if (!currentVerification.captcha?.code) {
    collector.stop('expired');
    return;
  }

  const result = currentVerification.checkCaptcha(input);
  await currentVerification.save();

  if (!result.valid) {
    if (currentVerification.captcha.attempts >= currentVerification.captcha.maxAttempts) {
      collector.stop('max_attempts');
      return;
    }

    const failEmbed = await errorEmbed(guildId, 'Incorrect Code', `${result.error}`);
    await thread.send({ embeds: [failEmbed] });
    return;
  }

  // Success
  collector.stop('success');

  try {
    await grantVerifiedRoles(member, verifiedRole, guildConfig, 'captcha');
  } catch (error) {
    console.error('[Verification] Error adding the verified role:', error);
    await thread.send({
      embeds: [await errorEmbed(guildId, 'Role Not Assigned',
        'I could not assign the verified role, Master. Please contact a moderator.')]
    }).catch(() => null);
    return;
  }

  await currentVerification.verify('captcha');

  // Log the verification
  await logVerification(member, 'captcha', guildConfig);

  const doneEmbed = await successEmbed(guildId, 'Verification Complete',
    'You have been verified and now have access to the server, Master.\n\nThis thread will be deleted in 10 seconds.');
  await thread.send({ embeds: [doneEmbed] }).catch(() => null);

  // Delete thread after delay
  setTimeout(() => {
    thread.delete().catch(() => { });
  }, SUCCESS_THREAD_DELETE_MS);
}

// Handle captcha button interactions (refresh, cancel)
async function handleCaptchaButton(interaction, client) {
  const [, action, targetUserId] = interaction.customId.split('_');
  const guildId = interaction.guild.id;

  // Only allow the target user
  if (interaction.user.id !== targetUserId) {
    return sendEphemeral(interaction, await errorEmbed(guildId, 'Not Your Verification',
      'This verification belongs to another member, Master.'));
  }

  const verification = await Verification.getVerification(guildId, targetUserId);

  if (action === 'cancel') {
    verification.pendingVerification = false;
    verification.captcha = undefined;
    await verification.save();

    await interaction.reply({
      embeds: [await warningEmbed(guildId, 'Verification Cancelled', 'Verification cancelled, Master.')]
    });

    // Delete thread after short delay
    setTimeout(() => {
      interaction.channel?.delete().catch(() => { });
    }, CANCEL_THREAD_DELETE_MS);
    return;
  }

  if (action === 'refresh') {
    // Generate new captcha
    const newCode = generateCaptchaCode(CAPTCHA_LENGTH);
    const captchaBuffer = await generateCaptchaImage(newCode);

    // Field by field: spreading the nested Mongoose object would copy its internals
    verification.set('captcha.code', newCode);
    verification.set('captcha.attempts', 0);
    verification.set('captcha.maxAttempts', CAPTCHA_MAX_ATTEMPTS);
    verification.set('captcha.expiresAt', new Date(Date.now() + CAPTCHA_LIFETIME_MS));
    await verification.save();

    const attachment = new AttachmentBuilder(captchaBuffer, { name: 'captcha.png' });

    const refreshEmbed = new EmbedBuilder()
      .setColor(COLORS.RAPHAEL)
      .setTitle('『 New Captcha Code 』')
      .setDescription('**Notice:** A fresh code has been generated, Master. Type it below to verify.')
      .setImage('attachment://captcha.png')
      .setFooter({ text: `Attempts reset • Expires in 5 minutes • ${getRandomFooter()}` })
      .setTimestamp();

    await interaction.reply({ embeds: [refreshEmbed], files: [attachment] });
  }
}

// Legacy modal handler (for backwards compatibility)
export async function handleCaptchaModal(interaction, client) {
  if (!interaction.isModalSubmit()) return;
  if (!interaction.customId.startsWith('verify_captcha_modal_')) return;

  // Redirect to thread-based verification
  return sendEphemeral(interaction, await infoEmbed(interaction.guildId, 'Captcha Updated',
    '**Notice:** Please use the verification button to start the new captcha verification process, Master.'));
}
