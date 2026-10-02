import { Events, EmbedBuilder } from 'discord.js';
import Guild from '../../models/Guild.js';

// Discord tells us that a member boosts (premiumSince), not how many boosts they hold, so a
// new boost always counts as one. Tier rewards above 1 boost cannot be detected automatically.
export const DETECTABLE_BOOST_COUNT = 1;

export const DEFAULT_BOOST_COLOR = '#f47fff';
const DEFAULT_BOOST_TITLE = '『 Server Boost 』';
const DEFAULT_BOOST_MESSAGE = 'Thank you {user} for boosting {server}!';
const DEFAULT_BOOST_GREETING = '{user} just boosted the server!';

// Earlier schema defaults (with emoji) still stored for guilds that never customised the text
const LEGACY_BOOST_MESSAGES = new Set(['Thank you {user} for boosting {server}! 🎉']);
const LEGACY_BOOST_GREETINGS = new Set(['💎 {user} just boosted the server!']);

// Discord message and embed limits
const LIMITS = { title: 256, description: 4096, footer: 2048, author: 256, content: 2000 };
const HEX_COLOR = /^#[0-9a-f]{6}$/i;

export default {
  name: Events.GuildMemberUpdate,
  async execute(oldMember, newMember) {
    // Only trigger when someone starts boosting (not when they stop)
    const wasBoosting = oldMember.premiumSince !== null;
    const isBoosting = newMember.premiumSince !== null;
    if (wasBoosting || !isBoosting) return;

    try {
      const guildConfig = await Guild.getGuild(newMember.guild.id, newMember.guild.name);
      const boostSettings = guildConfig.features?.boostSystem;
      if (!boostSettings) return;

      // Tier rewards are their own feature: grant them even when the announcement is off
      // or its channel is missing
      const tierReward = await handleBoostTierRewards(newMember, boostSettings, DETECTABLE_BOOST_COUNT);

      if (!boostSettings.enabled || !boostSettings.channel) return;

      const channel = newMember.guild.channels.cache.get(boostSettings.channel);
      if (!channel) {
        console.warn(`[BOOST] Configured boost channel ${boostSettings.channel} no longer exists in ${newMember.guild.name}`);
        return;
      }

      const { embed, content } = buildBoostEmbed(newMember, boostSettings, guildConfig, DETECTABLE_BOOST_COUNT, tierReward);
      await channel.send(embed ? { content, embeds: [embed] } : { content });

      console.log(`[BOOST] ${newMember.user.tag} boosted ${newMember.guild.name}`);
    } catch (error) {
      console.error('[BOOST] Error handling new boost:', error);
    }
  }
};

/**
 * The boost message template, ignoring the old emoji schema default
 */
export function getBoostMessageTemplate(boost = {}) {
  return boost.message && !LEGACY_BOOST_MESSAGES.has(boost.message) ? boost.message : DEFAULT_BOOST_MESSAGE;
}

/**
 * The greeting template shown above the embed, ignoring the old emoji schema default
 */
export function getBoostGreetingTemplate(boost = {}) {
  return boost.greetingText && !LEGACY_BOOST_GREETINGS.has(boost.greetingText)
    ? boost.greetingText
    : DEFAULT_BOOST_GREETING;
}

function clamp(text, max) {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * Handle assigning boost tier reward roles
 */
async function handleBoostTierRewards(member, boostSettings, boostCount) {
  const tierRewards = boostSettings.tierRewards || [];
  if (tierRewards.length === 0) return null;

  // Sort tiers by boost count (ascending)
  const sortedTiers = [...tierRewards].sort((a, b) => a.boostCount - b.boostCount);

  // Find the highest tier the user qualifies for
  let qualifiedTier = null;
  const rolesToAdd = [];

  for (const tier of sortedTiers) {
    if (boostCount >= tier.boostCount && tier.roleId) {
      if (tier.stackable) {
        // Stackable: add this role without removing others
        rolesToAdd.push(tier.roleId);
      } else {
        // Non-stackable: only keep the highest tier
        qualifiedTier = tier;
      }
    }
  }

  if (!qualifiedTier && rolesToAdd.length === 0) return null;

  try {
    if (qualifiedTier) {
      // Remove lower tier roles and add only the highest
      for (const tier of sortedTiers) {
        if (tier.boostCount < qualifiedTier.boostCount && tier.roleId) {
          const roleToRemove = member.guild.roles.cache.get(tier.roleId);
          if (roleToRemove && member.roles.cache.has(tier.roleId)) {
            await member.roles.remove(roleToRemove, 'Boost tier upgrade - replacing with higher tier');
          }
        }
      }

      const roleToAdd = member.guild.roles.cache.get(qualifiedTier.roleId);
      if (roleToAdd && !member.roles.cache.has(qualifiedTier.roleId)) {
        await member.roles.add(roleToAdd, `Boost tier reward (${qualifiedTier.boostCount}+ boosts)`);
      }
      return qualifiedTier;
    }

    // Stackable mode: add all qualified roles
    for (const roleId of rolesToAdd) {
      const role = member.guild.roles.cache.get(roleId);
      if (role && !member.roles.cache.has(roleId)) {
        await member.roles.add(role, 'Boost tier reward');
      }
    }

    // Return the highest tier for display
    return sortedTiers.filter(t => boostCount >= t.boostCount).pop() || null;
  } catch (error) {
    console.error('[BOOST] Error assigning tier reward roles:', error);
    return null;
  }
}

/**
 * Build the boost thank you message based on settings: { embed, content }.
 * embed is null in plain text mode, where content carries the message.
 */
function buildBoostEmbed(member, boost, guildConfig, boostCount = DETECTABLE_BOOST_COUNT, tierReward = null) {
  const boostMsg = parseBoostMessage(getBoostMessageTemplate(boost), member, boostCount);

  if (boost.embedEnabled === false) {
    // Plain text mode
    return { embed: null, content: clamp(boostMsg, LIMITS.content) };
  }

  const embed = new EmbedBuilder()
    .setColor(HEX_COLOR.test(boost.embedColor ?? '') ? boost.embedColor : DEFAULT_BOOST_COLOR);

  // Author section
  const authorType = boost.authorType || 'username';
  if (authorType === 'server') {
    embed.setAuthor({
      name: clamp(member.guild.name, LIMITS.author),
      iconURL: member.guild.iconURL({ size: 128 })
    });
  } else if (authorType === 'displayname') {
    embed.setAuthor({
      name: clamp(member.displayName || member.user.displayName || member.user.username, LIMITS.author),
      iconURL: member.user.displayAvatarURL({ size: 128 })
    });
  } else if (authorType !== 'none') {
    embed.setAuthor({
      name: member.user.username,
      iconURL: member.user.displayAvatarURL({ size: 128 })
    });
  }

  // Title: a single space means the title was removed
  const title = boost.embedTitle;
  if (title?.trim()) {
    embed.setTitle(clamp(parseBoostMessage(title, member, boostCount), LIMITS.title));
  } else if (title !== ' ') {
    embed.setTitle(DEFAULT_BOOST_TITLE);
  }

  // Description, with the tier reward line when one was earned
  let tierLine = '';
  if (boost.showTierInMessage !== false && tierReward) {
    const tierRole = member.guild.roles.cache.get(tierReward.roleId);
    if (tierRole) {
      tierLine = `\n\n◆ **Tier Reward Unlocked**\nYou have earned the ${tierRole} role.`;
    }
  }
  embed.setDescription(clamp(boostMsg, LIMITS.description - tierLine.length) + tierLine);

  // Thumbnail
  if (boost.thumbnailType === 'avatar') {
    embed.setThumbnail(member.user.displayAvatarURL({ size: 256 }));
  } else if (boost.thumbnailType === 'server') {
    embed.setThumbnail(member.guild.iconURL({ size: 256 }));
  } else if (boost.thumbnailUrl) {
    embed.setThumbnail(boost.thumbnailUrl);
  } else if (boost.thumbnailType !== 'none' && boost.thumbnailType !== null) {
    // Default to avatar if no specific type set
    embed.setThumbnail(member.user.displayAvatarURL({ size: 256 }));
  }

  // Footer: a single space means the footer was removed
  const footerText = boost.footerText;
  if (footerText?.trim()) {
    embed.setFooter({ text: clamp(parseBoostMessage(footerText, member, boostCount), LIMITS.footer) });
  } else if (footerText !== ' ') {
    embed.setFooter({ text: `Boost #${member.guild.premiumSubscriptionCount || 1}` });
  }

  // Timestamp
  if (boost.showTimestamp !== false) {
    embed.setTimestamp();
  }

  // Banner image
  if (boost.bannerUrl) {
    embed.setImage(boost.bannerUrl);
  }

  // Greeting content (text above embed)
  let content;
  if (boost.mentionUser !== false) {
    content = clamp(parseBoostMessage(getBoostGreetingTemplate(boost), member, boostCount), LIMITS.content);
  }

  return { embed, content };
}

/**
 * Parse boost message with variables. Replacer functions keep "$" in names literal.
 */
function parseBoostMessage(msg, member, boostCount = DETECTABLE_BOOST_COUNT) {
  return msg
    .replace(/{user}/gi, () => `<@${member.user.id}>`)
    .replace(/{username}/gi, () => member.user.username)
    .replace(/{displayname}/gi, () => member.displayName || member.user.displayName || member.user.username)
    .replace(/{tag}/gi, () => member.user.tag)
    .replace(/{id}/gi, () => member.user.id)
    .replace(/{server}/gi, () => member.guild.name)
    .replace(/{membercount}/gi, () => member.guild.memberCount.toString())
    .replace(/{boostcount}/gi, () => (member.guild.premiumSubscriptionCount || 0).toString())
    .replace(/{boostlevel}/gi, () => member.guild.premiumTier.toString())
    .replace(/{userboosts}/gi, () => boostCount.toString())
    .replace(/{avatar}/gi, () => member.user.displayAvatarURL({ size: 256 }))
    .replace(/\\n/g, '\n');
}

export { parseBoostMessage, buildBoostEmbed, handleBoostTierRewards };
