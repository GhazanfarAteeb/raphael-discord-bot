import { PermissionFlagsBits, ChannelType } from 'discord.js';
import Guild from '../../models/Guild.js';
import { successEmbed, errorEmbed, infoEmbed, GLYPHS } from '../../utils/embeds.js';
import { getPrefix, hasAdminPerms, truncate } from '../../utils/helpers.js';
import logger from '../../utils/logger.js';

const EMBED_REASON_LIMIT = 1000;
const AUDIT_REASON_LIMIT = 512;
const LOCK_WORDS = ['on', 'enable', 'lock'];
const UNLOCK_WORDS = ['off', 'disable', 'unlock'];
// Editing @everyone overwrites needs both
const REQUIRED_BOT_PERMISSIONS = [
  [PermissionFlagsBits.ManageChannels, 'Manage Channels'],
  [PermissionFlagsBits.ManageRoles, 'Manage Roles']
];

const TEXT_LOCK = {
  SendMessages: false,
  CreatePublicThreads: false,
  CreatePrivateThreads: false,
  SendMessagesInThreads: false,
  AddReactions: false
};
const VOICE_LOCK = {
  Connect: false,
  Speak: false,
  Stream: false,
  UseVAD: false
};

const isTextChannel = c => c.type === ChannelType.GuildText || c.type === ChannelType.GuildAnnouncement;
const isVoiceChannel = c => c.type === ChannelType.GuildVoice || c.type === ChannelType.GuildStageVoice;

export default {
  name: 'lockdown',
  category: 'moderation',
  description: 'Lock or unlock the server during emergencies (text, voice, threads)',
  usage: '<on|off> [reason]',
  aliases: ['lock', 'unlock'],
  // No dispatcher permission gate: the check below admits Administrators and configured admin roles
  cooldown: 10,

  async execute(message, args) {
    const guildId = message.guild.id;

    try {
      const guildConfig = await Guild.getGuild(guildId, message.guild.name);
      const prefix = await getPrefix(guildId);

      if (!hasAdminPerms(message.member, guildConfig)) {
        return message.reply({
          embeds: [await errorEmbed(guildId, 'Permission Denied',
            'Administrator privileges or a configured admin role are required, Master.')]
        });
      }

      // `lock` and `unlock` carry the action in the alias itself
      const invokedAs = getInvokedName(message.content, prefix);
      let action;
      let reasonArgs;
      if (invokedAs === 'lock' || invokedAs === 'unlock') {
        action = invokedAs === 'lock' ? 'on' : 'off';
        const words = invokedAs === 'lock' ? LOCK_WORDS : UNLOCK_WORDS;
        reasonArgs = words.includes(args[0]?.toLowerCase()) ? args.slice(1) : args;
      } else if (args[0]) {
        const word = args[0].toLowerCase();
        action = LOCK_WORDS.includes(word) ? 'on' : UNLOCK_WORDS.includes(word) ? 'off' : null;
        reasonArgs = args.slice(1);
      } else {
        const isLocked = guildConfig.security?.lockdownActive;
        return message.reply({
          embeds: [await infoEmbed(guildId, 'Security Protocol Status',
            `**Status:** ${isLocked ? `${GLYPHS.SUCCESS} Secured` : `${GLYPHS.INFO} Open`}\n\n` +
            `**Commands:**\n` +
            `${GLYPHS.INFO} \`${prefix}lockdown on [reason]\` — Activate security protocol\n` +
            `${GLYPHS.INFO} \`${prefix}lockdown off\` — Deactivate security protocol`)]
        });
      }

      if (!action) {
        return message.reply({
          embeds: [await errorEmbed(guildId, 'Invalid Usage',
            `**Notice:** Specify \`on\` or \`off\`, Master.\n\n` +
            `${GLYPHS.DOT} \`${prefix}lockdown on [reason]\` — Lock the server\n` +
            `${GLYPHS.DOT} \`${prefix}lockdown off\` — Unlock the server`)]
        });
      }

      const missing = REQUIRED_BOT_PERMISSIONS
        .filter(([flag]) => !message.guild.members.me.permissions.has(flag))
        .map(([, name]) => `**${name}**`);
      if (missing.length > 0) {
        return message.reply({
          embeds: [await errorEmbed(guildId, 'Missing Permissions',
            `I require the ${missing.join(' and ')} permission${missing.length > 1 ? 's' : ''} to change channel access, Master.`)]
        });
      }

      const reason = truncate(reasonArgs.join(' ').trim() || 'No reason provided', EMBED_REASON_LIMIT);

      if (action === 'on') {
        return await engageLockdown(message, guildConfig, reason, prefix);
      }
      return await releaseLockdown(message, guildConfig);
    } catch (error) {
      logger.error('[Lockdown] Command failed', error);
      const embed = await errorEmbed(guildId, 'Lockdown Failed',
        'An anomaly interrupted the security protocol, Master. The incident has been logged.').catch(() => null);
      return message.reply(embed ? { embeds: [embed] } : { content: '**Alert:** The security protocol failed, Master.' }).catch(() => null);
    }
  }
};

async function engageLockdown(message, guildConfig, reason, prefix) {
  const guildId = message.guild.id;

  if (guildConfig.security?.lockdownActive) {
    return message.reply({
      embeds: [await errorEmbed(guildId, 'Protocol Active',
        `**Notice:** Security protocol is already engaged, Master.\nUse \`${prefix}lockdown off\` to disengage first.`)]
    });
  }

  const textChannels = message.guild.channels.cache.filter(isTextChannel);
  const voiceChannels = message.guild.channels.cache.filter(isVoiceChannel);
  const auditReason = truncate(`[Lockdown] ${reason}`, AUDIT_REASON_LIMIT);

  const statusMsg = await message.reply({
    embeds: [await infoEmbed(guildId, 'Initiating Security Protocol',
      `Preserving permissions and securing ${textChannels.size + voiceChannels.size} channels...`)]
  });

  // Original @everyone overwrites, saved only for channels that were actually locked
  const savedPermissions = [];

  let lockedTextCount = 0;
  for (const channel of textChannels.values()) {
    try {
      const previous = readOverwrites(channel, Object.keys(TEXT_LOCK));
      await channel.permissionOverwrites.edit(guildId, TEXT_LOCK, { reason: auditReason });
      savedPermissions.push({ channelId: channel.id, channelType: 'text', permissions: previous });
      lockedTextCount++;
    } catch {
      // Channel not editable by me
    }
  }

  let lockedVoiceCount = 0;
  for (const channel of voiceChannels.values()) {
    try {
      const previous = readOverwrites(channel, Object.keys(VOICE_LOCK));
      await channel.permissionOverwrites.edit(guildId, VOICE_LOCK, { reason: auditReason });
      savedPermissions.push({ channelId: channel.id, channelType: 'voice', permissions: previous });
      lockedVoiceCount++;
    } catch {
      // Channel not editable by me
    }
  }

  // Nothing changed: leave the server marked as open
  if (savedPermissions.length === 0) {
    const failure = await errorEmbed(guildId, 'Lockdown Failed',
      'I could not secure a single channel, Master. Verify that my role can manage channel permissions.');
    return statusMsg.edit({ embeds: [failure] });
  }

  await Guild.updateGuild(guildId, {
    $set: {
      'security.lockdownActive': true,
      'security.lockdownReason': reason,
      'security.lockdownBy': message.author.id,
      'security.lockdownAt': new Date(),
      'security.lockdownPermissions': savedPermissions
    }
  });

  // Disconnect non-administrators from voice
  for (const channel of voiceChannels.values()) {
    for (const member of channel.members.values()) {
      if (!member.permissions.has(PermissionFlagsBits.Administrator)) {
        await member.voice.disconnect(auditReason).catch(() => {});
      }
    }
  }

  const skipped = textChannels.size + voiceChannels.size - savedPermissions.length;
  await statusMsg.edit({
    embeds: [await successEmbed(guildId, 'Security Protocol Engaged',
      `**Confirmed:** Secured **${lockedTextCount}** text channels and **${lockedVoiceCount}** voice channels, Master.\n\n` +
      (skipped > 0 ? `${GLYPHS.ERROR} **${skipped}** channel${skipped === 1 ? '' : 's'} could not be edited and remain open.\n\n` : '') +
      `**Active Restrictions:**\n` +
      `${GLYPHS.INFO} Text: Messages, threads, and reactions disabled\n` +
      `${GLYPHS.INFO} Voice: Connect, speak, and stream disabled\n\n` +
      `**Reason:** ${reason}\n` +
      `**Authority:** ${message.author.tag}\n\n` +
      `Use \`${prefix}lockdown off\` to disengage protocol.`)]
  });

  // Announce in alert channel
  if (guildConfig.channels?.alertLog && guildConfig.channels.alertLog !== message.channel.id) {
    const alertChannel = message.guild.channels.cache.get(guildConfig.channels.alertLog);
    if (alertChannel) {
      const staffMention = guildConfig.roles?.staffRoles?.length > 0
        ? guildConfig.roles.staffRoles.map(r => `<@&${r}>`).join(' ')
        : undefined;

      await alertChannel.send({
        content: staffMention,
        embeds: [await errorEmbed(guildId, 'Security Protocol Activated',
          `**Alert:** All channels are now restricted (text, voice and threads disabled).\n\n` +
          `**Initiated By:** ${message.author.tag}\n` +
          `**Reason:** ${reason}\n` +
          `**Text Channels Secured:** ${lockedTextCount}\n` +
          `**Voice Channels Secured:** ${lockedVoiceCount}`)]
      }).catch(err => logger.warn(`[Lockdown] Failed to announce in alert channel: ${err.message}`));
    }
  }
}

async function releaseLockdown(message, guildConfig) {
  const guildId = message.guild.id;

  if (!guildConfig.security?.lockdownActive) {
    return message.reply({
      embeds: [await errorEmbed(guildId, 'No Active Protocol', '**Notice:** Security protocol is not currently engaged, Master.')]
    });
  }

  const savedPermissions = guildConfig.security.lockdownPermissions || [];
  const hasSavedPerms = savedPermissions.length > 0;

  const statusMsg = await message.reply({
    embeds: [await infoEmbed(guildId, 'Disengaging Security Protocol',
      hasSavedPerms
        ? `Restoring ${savedPermissions.length} preserved channel permissions...`
        : 'Resetting channel permissions to default state...')]
  });

  let restoredTextCount = 0;
  let restoredVoiceCount = 0;

  if (hasSavedPerms) {
    for (const saved of savedPermissions) {
      const channel = message.guild.channels.cache.get(saved.channelId);
      if (!channel) continue;

      try {
        // Saved values are true/false for explicit overwrites and null for "inherit",
        // which permissionOverwrites.edit applies as-is
        await channel.permissionOverwrites.edit(guildId, saved.permissions, {
          reason: 'Lockdown ended - restoring original permissions'
        });
        if (saved.channelType === 'text') restoredTextCount++;
        else restoredVoiceCount++;
      } catch {
        // Channel not editable or deleted
      }
    }
  } else {
    // Fallback: reset to inherit if no saved permissions
    const reset = keys => Object.fromEntries(keys.map(key => [key, null]));
    for (const channel of message.guild.channels.cache.filter(isTextChannel).values()) {
      try {
        await channel.permissionOverwrites.edit(guildId, reset(Object.keys(TEXT_LOCK)), { reason: 'Lockdown ended' });
        restoredTextCount++;
      } catch {
        // Channel not editable
      }
    }
    for (const channel of message.guild.channels.cache.filter(isVoiceChannel).values()) {
      try {
        await channel.permissionOverwrites.edit(guildId, reset(Object.keys(VOICE_LOCK)), { reason: 'Lockdown ended' });
        restoredVoiceCount++;
      } catch {
        // Channel not editable
      }
    }
  }

  await Guild.updateGuild(guildId, {
    $set: {
      'security.lockdownActive': false,
      'security.lockdownPermissions': []
    }
  });

  await statusMsg.edit({
    embeds: [await successEmbed(guildId, 'Lockdown Deactivated',
      `${GLYPHS.SUCCESS} Restored **${restoredTextCount}** text channels and **${restoredVoiceCount}** voice channels.\n\n` +
      `${hasSavedPerms ? `${GLYPHS.SUCCESS} Original permissions have been restored.` : `${GLYPHS.WARNING} Permissions reset to default (no saved data found).`}\n` +
      `**Status:** Server operations resumed, Master.`)]
  });

  if (guildConfig.channels?.alertLog && guildConfig.channels.alertLog !== message.channel.id) {
    const alertChannel = message.guild.channels.cache.get(guildConfig.channels.alertLog);
    if (alertChannel) {
      await alertChannel.send({
        embeds: [await successEmbed(guildId, 'Lockdown Terminated',
          `**${GLYPHS.ARROW_RIGHT} Ended By:** ${message.author.tag}\n` +
          `**${GLYPHS.ARROW_RIGHT} Text Channels Restored:** ${restoredTextCount}\n` +
          `**${GLYPHS.ARROW_RIGHT} Voice Channels Restored:** ${restoredVoiceCount}\n\n` +
          `${hasSavedPerms ? `${GLYPHS.SUCCESS} Original permissions restored.` : `${GLYPHS.WARNING} Permissions reset to default.`}`)]
      }).catch(err => logger.warn(`[Lockdown] Failed to announce in alert channel: ${err.message}`));
    }
  }
}

// Current @everyone overwrite for each permission: true (allowed), false (denied) or null (inherit)
function readOverwrites(channel, keys) {
  const overwrite = channel.permissionOverwrites.cache.get(channel.guild.id);
  return Object.fromEntries(keys.map(key => {
    const flag = PermissionFlagsBits[key];
    if (overwrite?.allow.has(flag)) return [key, true];
    if (overwrite?.deny.has(flag)) return [key, false];
    return [key, null];
  }));
}

// Command word the member typed ("lockdown", "lock" or "unlock"), after the prefix or a bot mention
function getInvokedName(content, prefix) {
  const text = (content || '').trim();
  const rest = text.toLowerCase().startsWith(prefix.toLowerCase())
    ? text.slice(prefix.length)
    : text.replace(/^<@!?\d+>/, '');
  return rest.trim().split(/\s+/)[0]?.toLowerCase();
}
