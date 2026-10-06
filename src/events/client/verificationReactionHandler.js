import { Events, PermissionFlagsBits } from 'discord.js';
import Guild from '../../models/Guild.js';
import Verification from '../../models/Verification.js';
import { errorEmbed } from '../../utils/embeds.js';
import logger from '../../utils/logger.js';
import {
  logVerification,
  getVerifiedRoleProblem,
  runSecurityChecks,
  securityBlockedEmbed,
  grantVerifiedRoles,
  NOT_CONFIGURED
} from './verificationHandler.js';
import { VERIFICATION_REACTION, VERIFICATION_PANEL_TITLE } from '../../commands/moderation/verify.js';

// Reaction-type verification: a member adds the verification reaction to the guild's recorded
// panel (features.verificationSystem.panelMessageId, written by sendVerificationPanel in
// verify.js) and receives the verified role. Button and captcha panels are handled by
// verificationHandler.js; this only shares its checks, role grant, record and log.

const NOTICE_COOLDOWN_MS = 60 * 1000;
const WARNING_COOLDOWN_MS = 10 * 60 * 1000;

// `${guildId}:${userId}` -> when the member was last sent a DM notice (repeated reactions
// must not turn into repeated DMs)
const noticeCooldowns = new Map();
// `${guildId}:${problem}` -> when a configuration problem was last logged
const warningCooldowns = new Map();
// `${guildId}:${userId}` while that member's reaction is being processed
const inFlight = new Set();

function isVerificationEmoji(emoji) {
  // Unicode reaction only (no custom emoji id); some clients append a variation selector
  return !emoji?.id && emoji?.name?.replace(/️/g, '') === VERIFICATION_REACTION;
}

// Returns true when `key` was not used within `cooldownMs`, and marks it as used
function takeCooldown(map, key, cooldownMs) {
  const now = Date.now();
  const last = map.get(key);
  if (last && now - last < cooldownMs) return false;
  map.set(key, now);
  // Keep the maps small: drop expired entries now and then
  if (map.size > 1000) {
    for (const [k, t] of map) if (now - t >= cooldownMs) map.delete(k);
  }
  return true;
}

function warnQuietly(guild, problem) {
  if (takeCooldown(warningCooldowns, `${guild.id}:${problem}`, WARNING_COOLDOWN_MS)) {
    logger.warn(`[Verification] Reaction verification in ${guild.name} (${guild.id}): ${problem}`);
  }
}

// Short DM to the member (a reaction has no ephemeral reply), at most once per minute per
// guild and naming the server it is about; closed DMs are ignored
async function notifyMember(member, embed) {
  if (!embed || !takeCooldown(noticeCooldowns, `${member.guild.id}:${member.id}`, NOTICE_COOLDOWN_MS)) return;
  embed.setAuthor({ name: member.guild.name, iconURL: member.guild.iconURL() ?? undefined });
  await member.send({ embeds: [embed] }).catch(() => null);
}

// Keeps the panel clean (only my own reaction stays) when I may remove other members' reactions
async function removeMemberReaction(reaction, userId) {
  const message = reaction.message;
  const me = message.guild?.members.me;
  if (!me || !message.channel?.permissionsFor(me)?.has(PermissionFlagsBits.ManageMessages)) return;
  await reaction.users.remove(userId).catch(error => {
    logger.debug(`[Verification] Could not remove the verification reaction of ${userId}: ${error.message}`);
  });
}

/**
 * A panel posted before panels were recorded: my own message with the verification panel
 * title, in the configured verification channel when one is set. Recorded on first use, so
 * later reactions are matched by id without fetching.
 */
async function isUnrecordedPanel(message, vs) {
  if (vs.channel && message.channelId !== vs.channel) return false;

  if (message.partial) {
    try {
      await message.fetch();
    } catch {
      return false;
    }
  }
  if (message.author?.id !== message.client.user.id) return false;
  if (message.embeds[0]?.title !== VERIFICATION_PANEL_TITLE) return false;

  await Guild.updateGuild(message.guildId, {
    $set: {
      'features.verificationSystem.panelMessageId': message.id,
      'features.verificationSystem.panelChannelId': message.channelId
    }
  }).catch(error => logger.error('[Verification] Could not record the verification panel', error));
  return true;
}

async function verifyFromReaction(reaction, user, guild, guildConfig) {
  const vs = guildConfig.features.verificationSystem;

  try {
    const member = guild.members.cache.get(user.id) ?? await guild.members.fetch(user.id).catch(() => null);
    if (!member || member.user.bot) return;

    const verifiedRole = vs.role || guildConfig.roles?.verifiedRole;
    if (!verifiedRole) {
      warnQuietly(guild, 'no verified role is configured');
      await notifyMember(member, await errorEmbed(guild.id, 'Verification Unavailable', NOT_CONFIGURED));
      return;
    }

    // The role decides, not the record: a member who left and rejoined keeps a
    // "verified" record but lost the role
    if (member.roles.cache.has(verifiedRole)) return;

    const roleProblem = getVerifiedRoleProblem(guild, verifiedRole) ??
      (guild.members.me.permissions.has(PermissionFlagsBits.ManageRoles) ? null : 'I lack the Manage Roles permission');
    if (roleProblem) {
      warnQuietly(guild, `cannot assign the verified role: ${roleProblem}`);
      await notifyMember(member, await errorEmbed(guild.id, 'Verification Unavailable', NOT_CONFIGURED));
      return;
    }

    const securityResult = await runSecurityChecks(member, guildConfig);
    if (!securityResult.passed) {
      await notifyMember(member, await securityBlockedEmbed(guild.id, securityResult.issues));
      return;
    }

    try {
      await grantVerifiedRoles(member, verifiedRole, guildConfig, 'reaction');
    } catch (error) {
      logger.error(`[Verification] Could not assign the verified role to ${member.id} in ${guild.id}`, error);
      await notifyMember(member, await errorEmbed(guild.id, 'Role Not Assigned',
        'I could not assign the verified role, Master. Please contact a moderator.'));
      return;
    }

    const verification = await Verification.getVerification(guild.id, member.id);
    await verification.verify('reaction');

    await logVerification(member, 'reaction', guildConfig);
  } finally {
    await removeMemberReaction(reaction, user.id);
  }
}

export default {
  name: Events.MessageReactionAdd,

  async execute(reaction, user) {
    try {
      // Cheap filters first: most reactions are other emoji on ordinary messages
      if (!isVerificationEmoji(reaction.emoji)) return;
      if (user.id === reaction.client.user.id) return; // my own reaction on a new panel

      const message = reaction.message;
      const guild = message.guild;
      if (!guild?.available || !guild.members.me) return;

      const guildConfig = await Guild.getGuild(guild.id);
      const vs = guildConfig?.features?.verificationSystem;
      if (!vs?.enabled || vs.type !== 'reaction') return;

      if (vs.panelMessageId) {
        if (message.id !== vs.panelMessageId) return;
      } else if (!(await isUnrecordedPanel(message, vs))) {
        return;
      }

      // A double reaction (add, remove, add) must not verify and log twice
      const key = `${guild.id}:${user.id}`;
      if (inFlight.has(key)) return;
      inFlight.add(key);
      try {
        await verifyFromReaction(reaction, user, guild, guildConfig);
      } finally {
        inFlight.delete(key);
      }
    } catch (error) {
      logger.error('[Verification] Reaction verification failed', error);
    }
  }
};
