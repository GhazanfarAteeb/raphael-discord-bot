import { Events, PermissionFlagsBits } from 'discord.js';
import Guild from '../../models/Guild.js';
import redis from '../../utils/redis.js';
import logger from '../../utils/logger.js';
import { getAssignableRoleError } from '../../utils/helpers.js';

// Fallback lock map when Redis is unavailable
const colorRoleLocks = new Map();
const COLOR_ROLE_LOCK_TTL_SECONDS = 10;
const BOT_REMOVAL_MARK_MS = 10000;

// Color panel reactions; these emoji are data (the panel's reactions), never bot text
const COLOR_EMOJIS = ['❤️', '🧡', '💛', '💚', '💙', '💜', '🩷', '🤍', '🖤', '🩵', '🤎', '💗'];
const EMOJI_TO_COLOR_NAME = {
  '❤️': 'Red', '🧡': 'Orange', '💛': 'Yellow', '💚': 'Green',
  '💙': 'Blue', '💜': 'Purple', '🩷': 'Pink', '🤍': 'White',
  '🖤': 'Black', '🩵': 'Cyan', '🤎': 'Brown', '💗': 'Hot Pink'
};
const COLOR_NAME_TO_EMOJI = Object.fromEntries(
  Object.entries(EMOJI_TO_COLOR_NAME).map(([emoji, name]) => [name, emoji])
);
// Name prefix of the roles the color panel hands out (role names are data)
const COLOR_ROLE_PREFIX = '🎨';

// Track bot-initiated reaction removals to prevent triggering role removal
export const botRemovedReactions = new Map();

/**
 * Why I must not hand out `role` on a reaction, or null when I can. Checked against
 * myself: covers @everyone, managed roles, my hierarchy and roles with moderation
 * permissions, which a reaction must never grant.
 */
export function getReactionRoleProblem(role) {
  const me = role.guild.members.me;
  if (!me) return 'my member data is not cached';
  if (!me.permissions.has(PermissionFlagsBits.ManageRoles)) return 'I lack the Manage Roles permission';
  return getAssignableRoleError(role, me);
}

function markBotRemoval(messageId, userId, emojiName) {
  const removeKey = `${messageId}:${userId}:${emojiName}`;
  botRemovedReactions.set(removeKey, Date.now());
  setTimeout(() => botRemovedReactions.delete(removeKey), BOT_REMOVAL_MARK_MS);
}

export default {
  name: Events.MessageReactionAdd,

  async execute(reaction, user) {
    // Ignore bots
    if (user.bot) return;

    try {
      const { emoji } = reaction;
      const guild = reaction.message.guild;

      if (!guild) return;

      const messageId = reaction.message.id;
      const channelId = reaction.message.channelId;

      // Decide from the config whether this reaction matters before fetching anything:
      // most reactions are on ordinary (often uncached) messages
      const guildConfig = await Guild.getGuild(guild.id);

      const isColorRolesPanel = guildConfig.settings?.colorRoles?.messageId === messageId;

      // Fallback: a message in the color roles channel reacted with a color emoji
      const isInColorChannel = guildConfig.settings?.colorRoles?.channelId === channelId;
      const looksLikeColorPanel = isInColorChannel && COLOR_EMOJIS.includes(emoji.name);

      const reactionMessage = guildConfig.settings?.reactionRoles?.messages?.find(
        m => m.messageId === messageId && m.channelId === channelId
      );

      if (!isColorRolesPanel && !looksLikeColorPanel && !reactionMessage) return;

      logger.debug(`[ReactionRoleAdd] ${user.id} reacted ${emoji.name} on panel ${messageId} in ${guild.id}`);

      // Fetch partial reactions
      if (reaction.partial) {
        try {
          await reaction.fetch();
        } catch (error) {
          logger.error('[ReactionRoleAdd] Failed to fetch reaction:', error);
          return;
        }
      }

      // Also fetch partial message if needed
      if (reaction.message.partial) {
        try {
          await reaction.message.fetch();
        } catch (error) {
          logger.error('[ReactionRoleAdd] Failed to fetch message:', error);
          return;
        }
      }

      const { message } = reaction;

      if (isColorRolesPanel || looksLikeColorPanel) {
        // Use Redis lock to prevent race conditions when user reacts quickly
        const lockKey = `colorRole:${guild.id}:${user.id}`;

        // Try to acquire lock (Redis or fallback to Map)
        let lockAcquired = false;
        if (redis.isAvailable()) {
          lockAcquired = await redis.acquireLock(lockKey, COLOR_ROLE_LOCK_TTL_SECONDS);
        } else if (!colorRoleLocks.has(lockKey)) {
          colorRoleLocks.set(lockKey, true);
          lockAcquired = true;
        }

        if (!lockAcquired) {
          logger.debug('[ReactionRoleAdd] Color role change already in progress for this user');
          // Already processing a color role for this user, ignore this reaction
          await reaction.users.remove(user.id).catch(() => { });
          return;
        }

        try {
          return await this.handleColorRole(reaction, user, guild, guildConfig, emoji, message);
        } finally {
          // Release lock
          if (redis.isAvailable()) {
            await redis.releaseLock(lockKey);
          } else {
            colorRoleLocks.delete(lockKey);
          }
        }
      }

      // Find the role for this emoji
      const emojiKey = emoji.id ? `<:${emoji.name}:${emoji.id}>` : emoji.name;
      const roleConfig = reactionMessage.roles.find(r => r.emoji === emojiKey || r.emoji === emoji.name);

      if (!roleConfig) {
        logger.debug(`[ReactionRoleAdd] No role configured for ${emojiKey} on ${messageId}`);
        return;
      }

      // Get the role
      const role = guild.roles.cache.get(roleConfig.roleId);
      if (!role) {
        logger.warn(`[ReactionRoleAdd] Role ${roleConfig.roleId} of panel ${messageId} no longer exists`);
        return;
      }

      const problem = getReactionRoleProblem(role);
      if (problem) {
        logger.warn(`[ReactionRoleAdd] Not assigning ${role.name} (${role.id}) in ${guild.id}: ${problem}`);
        return;
      }

      // Get the member
      const member = await guild.members.fetch(user.id).catch(() => null);
      if (!member) return;

      // Check if this is a "color role" (only one at a time)
      if (role.name.startsWith(COLOR_ROLE_PREFIX)) {
        // Remove other color roles first
        const colorRoleIds = reactionMessage.roles.map(r => r.roleId);
        const memberColorRoles = member.roles.cache.filter(r => colorRoleIds.includes(r.id));

        // Fetch the message to ensure reactions cache is populated
        let fetchedMessage = message;
        try {
          fetchedMessage = await message.fetch();
        } catch (err) {
          logger.error('[ReactionRoleAdd] Failed to fetch message for reactions:', err);
        }

        for (const [roleId, existingRole] of memberColorRoles) {
          if (roleId === role.id) continue;
          try {
            await member.roles.remove(existingRole, 'Color role change');

            // Remove their reaction from the old color
            const oldRoleConfig = reactionMessage.roles.find(r => r.roleId === roleId);
            if (oldRoleConfig) {
              const oldReaction = fetchedMessage.reactions.cache.find(r =>
                r.emoji.name === oldRoleConfig.emoji ||
                `<:${r.emoji.name}:${r.emoji.id}>` === oldRoleConfig.emoji
              );
              if (oldReaction) {
                // Mark this as a bot-removed reaction
                markBotRemoval(message.id, user.id, oldReaction.emoji.name);
                await oldReaction.users.remove(user.id).catch(() => { });
              }
            }
          } catch (err) {
            logger.warn(`[ReactionRoleAdd] Could not remove old color role ${existingRole.name}: ${err.message}`);
          }
        }
      }

      // Add the new role
      if (!member.roles.cache.has(role.id)) {
        try {
          await member.roles.add(role, 'Reaction role');
          logger.debug(`[ReactionRoleAdd] Added ${role.name} to ${member.user.tag}`);
        } catch (err) {
          logger.warn(`[ReactionRoleAdd] Could not add ${role.name} to ${member.user.tag}: ${err.message}`);
        }
      }

    } catch (error) {
      logger.error('[ReactionRoleAdd] Reaction role add error:', error);
    }
  },

  async handleColorRole(reaction, user, guild, guildConfig, emoji, message) {
    try {
      const colorRolesConfig = guildConfig.settings?.colorRoles || {};
      const emojiName = emoji.name;

      // Find the role for this emoji
      let roleConfig = colorRolesConfig.roles?.find(r => r.emoji === emojiName);

      // If no roles map, try to find by role name prefix
      if (!roleConfig) {
        const colorName = EMOJI_TO_COLOR_NAME[emojiName];
        if (!colorName) {
          logger.debug(`[handleColorRole] ${emojiName} is not a color emoji`);
          return;
        }

        const role = guild.roles.cache.find(r => r.name === `${COLOR_ROLE_PREFIX} ${colorName}`);
        if (!role) {
          logger.warn(`[handleColorRole] Color role "${colorName}" not found in ${guild.id}`);
          return;
        }

        roleConfig = { emoji: emojiName, roleId: role.id, name: colorName };
      }

      // Get the role
      const role = guild.roles.cache.get(roleConfig.roleId);
      if (!role) {
        logger.warn(`[handleColorRole] Color role ${roleConfig.roleId} no longer exists in ${guild.id}`);
        return;
      }

      const problem = getReactionRoleProblem(role);
      if (problem) {
        logger.warn(`[handleColorRole] Not assigning ${role.name} (${role.id}) in ${guild.id}: ${problem}`);
        return;
      }

      // Get the member
      const member = await guild.members.fetch(user.id).catch(() => null);
      if (!member) return;

      // Remove other color roles first (only one color at a time)
      const memberColorRoles = member.roles.cache.filter(r => r.name.startsWith(`${COLOR_ROLE_PREFIX} `));

      // Fetch the message to ensure reactions cache is populated
      let fetchedMessage = message;
      try {
        fetchedMessage = await message.fetch();
      } catch (err) {
        logger.error('[handleColorRole] Failed to fetch message for reactions:', err);
      }

      for (const [roleId, existingRole] of memberColorRoles) {
        if (roleId === role.id) continue;
        try {
          // Remove the old color role from member
          await member.roles.remove(existingRole, 'Color role change');

          // Remove their reaction from the old color
          const colorName = existingRole.name.slice(COLOR_ROLE_PREFIX.length).trim();
          const oldEmoji = COLOR_NAME_TO_EMOJI[colorName];

          if (oldEmoji) {
            const oldReaction = fetchedMessage.reactions.cache.find(r => r.emoji.name === oldEmoji);
            if (oldReaction) {
              // Mark this as a bot-removed reaction so reactionRoleRemove doesn't try to remove the role again
              markBotRemoval(message.id, user.id, oldEmoji);
              await oldReaction.users.remove(user.id).catch(() => { });
            }
          }
        } catch (err) {
          logger.warn(`[handleColorRole] Could not remove old color role ${existingRole.name}: ${err.message}`);
        }
      }

      // Add the new role
      if (!member.roles.cache.has(role.id)) {
        try {
          await member.roles.add(role, 'Color role selection');
          logger.debug(`[handleColorRole] Added ${role.name} to ${member.user.tag}`);
        } catch (err) {
          logger.warn(`[handleColorRole] Could not add ${role.name} to ${member.user.tag}: ${err.message}`);
        }
      }

    } catch (error) {
      logger.error('[handleColorRole] Color role add error:', error);
    }
  }
};
