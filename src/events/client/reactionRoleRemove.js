import { Events } from 'discord.js';
import Guild from '../../models/Guild.js';
import { botRemovedReactions } from './reactionRoleAdd.js';
import logger from '../../utils/logger.js';

// Color panel reactions; these emoji are data (the panel's reactions), never bot text
const EMOJI_TO_COLOR_NAME = {
  '❤️': 'Red', '🧡': 'Orange', '💛': 'Yellow', '💚': 'Green',
  '💙': 'Blue', '💜': 'Purple', '🩷': 'Pink', '🤍': 'White',
  '🖤': 'Black', '🩵': 'Cyan', '🤎': 'Brown', '💗': 'Hot Pink'
};
const COLOR_EMOJIS = Object.keys(EMOJI_TO_COLOR_NAME);
// Name prefix of the roles the color panel hands out (role names are data)
const COLOR_ROLE_PREFIX = '🎨';

// Remove `role` from the member if I can; hierarchy and permission problems are logged, not thrown
async function removeRoleQuietly(member, role, reason, logPrefix) {
  if (!member.roles.cache.has(role.id)) return;

  if (!role.editable) {
    logger.warn(`${logPrefix} Cannot remove ${role.name} (${role.id}) in ${role.guild.id}: it is managed or not below my highest role, or I lack Manage Roles`);
    return;
  }

  try {
    await member.roles.remove(role, reason);
    logger.debug(`${logPrefix} Removed ${role.name} from ${member.user.tag}`);
  } catch (err) {
    logger.warn(`${logPrefix} Could not remove ${role.name} from ${member.user.tag}: ${err.message}`);
  }
}

export default {
  name: Events.MessageReactionRemove,

  async execute(reaction, user) {
    // Ignore bots
    if (user.bot) return;

    try {
      const { emoji } = reaction;
      const guild = reaction.message.guild;

      if (!guild) return;

      const messageId = reaction.message.id;
      const channelId = reaction.message.channelId;

      // Check if this was a bot-initiated removal (from switching colors)
      const removeKey = `${messageId}:${user.id}:${emoji.name}`;
      if (botRemovedReactions.has(removeKey)) {
        // This reaction was removed by the bot during color switching, don't remove the role
        botRemovedReactions.delete(removeKey);
        return;
      }

      // Decide from the config whether this reaction matters before fetching anything
      const guildConfig = await Guild.getGuild(guild.id);

      const isColorRolesPanel = guildConfig.settings?.colorRoles?.messageId === messageId;

      // Fallback: a message in the color roles channel with a color emoji
      const isInColorChannel = guildConfig.settings?.colorRoles?.channelId === channelId;
      const looksLikeColorPanel = isInColorChannel && COLOR_EMOJIS.includes(emoji.name);

      const reactionMessage = guildConfig.settings?.reactionRoles?.messages?.find(
        m => m.messageId === messageId && m.channelId === channelId
      );

      if (!isColorRolesPanel && !looksLikeColorPanel && !reactionMessage) return;

      logger.debug(`[ReactionRoleRemove] ${user.id} removed ${emoji.name} on panel ${messageId} in ${guild.id}`);

      if (isColorRolesPanel || looksLikeColorPanel) {
        return await this.handleColorRoleRemove(reaction, user, guild, guildConfig, emoji);
      }

      // Find the role for this emoji
      const emojiKey = emoji.id ? `<:${emoji.name}:${emoji.id}>` : emoji.name;
      const roleConfig = reactionMessage.roles.find(r => r.emoji === emojiKey || r.emoji === emoji.name);

      if (!roleConfig) {
        logger.debug(`[ReactionRoleRemove] No role configured for ${emojiKey} on ${messageId}`);
        return;
      }

      // Get the role
      const role = guild.roles.cache.get(roleConfig.roleId);
      if (!role) {
        logger.warn(`[ReactionRoleRemove] Role ${roleConfig.roleId} of panel ${messageId} no longer exists`);
        return;
      }

      // Get the member
      const member = await guild.members.fetch(user.id).catch(() => null);
      if (!member) return;

      await removeRoleQuietly(member, role, 'Reaction role removed', '[ReactionRoleRemove]');

    } catch (error) {
      logger.error('[ReactionRoleRemove] Reaction role remove error:', error);
    }
  },

  async handleColorRoleRemove(reaction, user, guild, guildConfig, emoji) {
    try {
      const colorRolesConfig = guildConfig.settings?.colorRoles || {};
      const emojiName = emoji.name;

      // Find the role for this emoji
      let roleConfig = colorRolesConfig.roles?.find(r => r.emoji === emojiName);

      // If no roles map, try to find by role name prefix
      if (!roleConfig) {
        const colorName = EMOJI_TO_COLOR_NAME[emojiName];
        if (!colorName) {
          logger.debug(`[handleColorRoleRemove] ${emojiName} is not a color emoji`);
          return;
        }

        const role = guild.roles.cache.find(r => r.name === `${COLOR_ROLE_PREFIX} ${colorName}`);
        if (!role) {
          logger.warn(`[handleColorRoleRemove] Color role "${colorName}" not found in ${guild.id}`);
          return;
        }

        roleConfig = { emoji: emojiName, roleId: role.id, name: colorName };
      }

      // Get the role
      const role = guild.roles.cache.get(roleConfig.roleId);
      if (!role) {
        logger.warn(`[handleColorRoleRemove] Color role ${roleConfig.roleId} no longer exists in ${guild.id}`);
        return;
      }

      // Get the member
      const member = await guild.members.fetch(user.id).catch(() => null);
      if (!member) return;

      // Remove the role only if user manually removed their reaction
      await removeRoleQuietly(member, role, 'Color role removed by user', '[handleColorRoleRemove]');

    } catch (error) {
      logger.error('[handleColorRoleRemove] Color role remove error:', error);
    }
  }
};
