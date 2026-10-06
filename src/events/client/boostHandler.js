import { Events, EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import Guild from '../../models/Guild.js';
import BoosterRole, { BoostTierGrant } from '../../models/BoosterRole.js';
import { getAssignableRoleError } from '../../utils/helpers.js';

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
const LIMITS = { title: 256, description: 4096, footer: 2048, author: 256, content: 2000, embed: 6000 };
const HEX_COLOR = /^#[0-9a-f]{6}$/i;

// A boost counts as new only while its premiumSince is this recent. Members swept from the
// member cache come back as partials whose premiumSince reads as null, so without this check
// any later update of an existing booster (a nickname, a role) would be announced as a new
// boost. It also keeps a boost missed during a disconnect from being announced hours later.
export const BOOST_FRESH_MS = 10 * 60 * 1000;

// premiumSince already handled per member, so an event delivered twice is announced once
const handledBoosts = new Map();

export default {
  name: Events.GuildMemberUpdate,
  async execute(oldMember, newMember) {
    const change = getBoostChange(oldMember, newMember);
    if (change === 'start') return handleNewBoost(newMember);
    if (change === 'end') return handleBoostEnded(newMember, { definite: true });
    // Unknown earlier state and not boosting now: take back rewards this bot gave for a boost
    if (oldMember.partial && !newMember.premiumSinceTimestamp) {
      return handleBoostEnded(newMember, { definite: false });
    }
  }
};

/**
 * 'start' when the update is a new boost, 'end' when the member definitely stopped boosting,
 * otherwise null. A partial old member has unknown boost state: it counts as a new boost only
 * when premiumSince is fresh, and never as an ended boost.
 */
export function getBoostChange(oldMember, newMember, now = Date.now()) {
  const newSince = newMember.premiumSinceTimestamp ?? null;
  const oldSince = oldMember.partial ? null : (oldMember.premiumSinceTimestamp ?? null);

  if (newSince) {
    if (!oldMember.partial && oldSince === newSince) return null;
    return Math.abs(now - newSince) <= BOOST_FRESH_MS ? 'start' : null;
  }

  return !oldMember.partial && oldSince ? 'end' : null;
}

// Synchronous check-and-set, so two deliveries of the same boost can't both pass
function claimBoost(member, now = Date.now()) {
  for (const [key, since] of handledBoosts) {
    if (Math.abs(now - since) > BOOST_FRESH_MS) handledBoosts.delete(key);
  }

  const key = `${member.guild.id}:${member.id}`;
  if (handledBoosts.get(key) === member.premiumSinceTimestamp) return false;
  handledBoosts.set(key, member.premiumSinceTimestamp);
  return true;
}

async function handleNewBoost(member) {
  if (!claimBoost(member)) return;
  const { guild } = member;

  try {
    const guildConfig = await Guild.getGuild(guild.id, guild.name);
    const boost = guildConfig.features?.boostSystem;
    if (!boost) return;

    // Tier rewards are their own feature: granted even when the announcement is off
    const tierRewards = await grantBoostTierRewards(member, boost);

    if (!boost.enabled || !boost.channel) return;

    const channel = guild.channels.cache.get(boost.channel);
    if (!channel) {
      console.warn(`[BOOST] Configured boost channel ${boost.channel} no longer exists in ${guild.name}`);
      return;
    }

    const missing = getMissingSendPermissions(channel, guild.members.me, boost.embedEnabled !== false);
    if (missing.length > 0) {
      console.warn(`[BOOST] Cannot announce in #${channel.name} (${guild.name}): missing ${missing.join(', ')}`);
      return;
    }

    // The member update can arrive before the guild update with the new boost count
    await guild.fetch().catch(() => null);

    await channel.send(buildBoostMessage(member, boost, { tierRewards }));
    console.log(`[BOOST] ${member.user.tag} boosted ${guild.name}`);
  } catch (error) {
    console.error('[BOOST] Error handling new boost:', error);
  }
}

/**
 * Tier reward roles are kept only while boosting. definite: the member was seen boosting and
 * stopped, so every tier role goes. Otherwise (earlier state unknown) only the tier roles this
 * bot added for a boost are taken back, never ones given some other way.
 */
async function handleBoostEnded(member, { definite }) {
  const { guild } = member;
  if (definite) handledBoosts.delete(`${guild.id}:${member.id}`);

  try {
    const guildConfig = await Guild.getGuild(guild.id, guild.name);
    const tiers = guildConfig.features?.boostSystem?.tierRewards || [];
    const held = [...new Set(tiers.map(tier => tier.roleId).filter(Boolean))]
      .filter(roleId => member.roles.cache.has(roleId));

    if (held.length === 0) {
      if (definite) await BoostTierGrant.deleteMany({ guildId: guild.id, userId: member.id }).catch(() => {});
      return;
    }

    let toRemove = held;
    if (!definite) {
      const grants = await BoostTierGrant.find({ guildId: guild.id, userId: member.id }).lean();
      const granted = new Set(grants.map(grant => grant.roleId));
      toRemove = held.filter(roleId => granted.has(roleId));
      if (toRemove.length === 0) return;
    }

    // A role the member also holds as a temporary booster role follows that role's expiry
    const tempEntries = await BoosterRole.find({ guildId: guild.id, userId: member.id }).lean().catch(() => []);
    const keep = new Set(tempEntries.map(entry => entry.roleId));

    const removed = [];
    for (const roleId of toRemove) {
      if (keep.has(roleId)) continue;
      const role = guild.roles.cache.get(roleId);
      if (!role) continue;
      if (!role.editable) {
        console.warn(`[BOOST] Cannot remove tier role ${role.name} from ${member.user.tag} in ${guild.name}: role is not manageable`);
        continue;
      }
      try {
        await member.roles.remove(role, 'No longer boosting the server');
        removed.push(role.name);
      } catch (error) {
        console.warn(`[BOOST] Failed to remove tier role ${role.name} from ${member.user.tag}:`, error.message);
      }
    }

    await BoostTierGrant.deleteMany({ guildId: guild.id, userId: member.id }).catch(() => {});
    if (removed.length > 0) {
      console.log(`[BOOST] Removed tier rewards (${removed.join(', ')}) from ${member.user.tag} in ${guild.name}: no longer boosting`);
    }
  } catch (error) {
    console.error('[BOOST] Error handling ended boost:', error);
  }
}

/**
 * The boost message template, ignoring the old emoji schema default
 */
export function getBoostMessageTemplate(boost = {}) {
  return boost.message?.trim() && !LEGACY_BOOST_MESSAGES.has(boost.message) ? boost.message : DEFAULT_BOOST_MESSAGE;
}

/**
 * The greeting template shown above the embed, ignoring the old emoji schema default
 */
export function getBoostGreetingTemplate(boost = {}) {
  return boost.greetingText?.trim() && !LEGACY_BOOST_GREETINGS.has(boost.greetingText)
    ? boost.greetingText
    : DEFAULT_BOOST_GREETING;
}

function clamp(text, max) {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * An http(s) URL Discord will accept for an embed image, or null
 */
export function toImageUrl(value) {
  if (typeof value !== 'string' || !value) return null;
  try {
    const { protocol } = new URL(value);
    return protocol === 'http:' || protocol === 'https:' ? value : null;
  } catch {
    return null;
  }
}

/**
 * Names of the permissions the bot lacks to post in `channel` (empty when it can post)
 */
export function getMissingSendPermissions(channel, me, withEmbed = true) {
  if (!channel?.isTextBased?.()) return ['a text channel'];
  if (!me) return [];

  const permissions = channel.permissionsFor(me);
  const needed = [
    ['View Channel', PermissionFlagsBits.ViewChannel],
    ['Send Messages', PermissionFlagsBits.SendMessages]
  ];
  if (withEmbed) needed.push(['Embed Links', PermissionFlagsBits.EmbedLinks]);

  return needed.filter(([, flag]) => !permissions?.has(flag)).map(([name]) => name);
}

/**
 * Which tiers a member with `boostCount` boosts gets, and which lower tiers they replace.
 * Walking up the tiers, a stackable tier is added to the ones below it and a non-stackable
 * tier replaces them.
 */
export function resolveTierRewards(tierRewards = [], boostCount = DETECTABLE_BOOST_COUNT) {
  const qualified = tierRewards
    .filter(tier => tier?.roleId && Number(tier.boostCount) <= boostCount)
    .sort((a, b) => a.boostCount - b.boostCount);

  let grant = [];
  for (const tier of qualified) {
    grant = tier.stackable === false ? [tier] : [...grant, tier];
  }

  const grantedRoles = new Set(grant.map(tier => tier.roleId));
  const replace = qualified.filter(tier => !grantedRoles.has(tier.roleId));
  return { grant, replace };
}

/**
 * The tier reward roles a new booster would receive that exist and can be assigned.
 * Used by the preview, so it shows the same reward line as a real boost.
 */
export function getGrantableTierRoles(guild, boost = {}) {
  const me = guild.members.me;
  return resolveTierRewards(boost.tierRewards || []).grant
    .map(tier => guild.roles.cache.get(tier.roleId))
    .filter(role => role && (!me || !getAssignableRoleError(role, me)));
}

/**
 * Give a new booster their tier reward roles. Returns the reward roles the member now holds.
 */
async function grantBoostTierRewards(member, boost, boostCount = DETECTABLE_BOOST_COUNT) {
  const { grant, replace } = resolveTierRewards(boost.tierRewards || [], boostCount);
  if (grant.length === 0) return [];

  const { guild } = member;
  const me = guild.members.me;
  const held = [];

  for (const tier of grant) {
    const role = guild.roles.cache.get(tier.roleId);
    if (!role) {
      console.warn(`[BOOST] Tier reward role ${tier.roleId} (${tier.boostCount} boosts) no longer exists in ${guild.name}`);
      continue;
    }
    if (held.some(heldRole => heldRole.id === role.id)) continue;

    // Re-checked here: the role may have been moved or given new permissions since it was set
    const roleError = me ? getAssignableRoleError(role, me) : null;
    if (roleError) {
      console.warn(`[BOOST] Not giving tier reward role ${role.name} in ${guild.name}: ${roleError}`);
      continue;
    }

    if (member.roles.cache.has(role.id)) {
      held.push(role);
      continue;
    }

    try {
      await member.roles.add(role, `Boost tier reward (${tier.boostCount}+ boosts)`);
      held.push(role);
      // Remembered so the role can be taken back when the boost ends
      await BoostTierGrant.updateOne(
        { guildId: guild.id, userId: member.id, roleId: role.id },
        { $setOnInsert: { guildId: guild.id, userId: member.id, roleId: role.id } },
        { upsert: true }
      ).catch(error => console.warn('[BOOST] Failed to record tier reward grant:', error.message));
    } catch (error) {
      console.warn(`[BOOST] Failed to give tier reward role ${role.name} to ${member.user.tag}:`, error.message);
    }
  }

  // Lower tiers replaced by a non-stackable tier
  for (const tier of replace) {
    const role = guild.roles.cache.get(tier.roleId);
    if (!role || !role.editable || !member.roles.cache.has(role.id)) continue;
    await member.roles.remove(role, 'Boost tier upgrade - replaced by a higher tier')
      .catch(error => console.warn(`[BOOST] Failed to remove replaced tier role ${role.name}:`, error.message));
  }

  return held;
}

function tierRewardLine(boost, tierRewards) {
  if (boost.showTierInMessage === false || tierRewards.length === 0) return '';
  const roles = tierRewards.map(role => `${role}`).join(', ');
  return `\n\n◆ **Tier Reward Unlocked**\nYou have earned the ${roles} role${tierRewards.length === 1 ? '' : 's'}.`;
}

/**
 * The full announcement for a boost: { content, embeds, allowedMentions }.
 * options: { boostCount, tierRewards (roles to list), silent (render the mention without pinging) }
 */
export function buildBoostMessage(member, boost = {}, { boostCount = DETECTABLE_BOOST_COUNT, tierRewards = [], silent = false } = {}) {
  const mention = boost.mentionUser !== false;
  const allowedMentions = mention && !silent ? { users: [member.id] } : { parse: [] };

  let text = parseBoostMessage(getBoostMessageTemplate(boost), member, boostCount);
  if (!text.trim()) text = parseBoostMessage(DEFAULT_BOOST_MESSAGE, member, boostCount);
  const tierLine = tierRewardLine(boost, tierRewards);

  if (boost.embedEnabled === false) {
    // Plain text mode: the message itself is the content
    return { content: clamp(text, LIMITS.content - tierLine.length) + tierLine, allowedMentions };
  }

  const embed = buildBoostEmbed(member, boost, { boostCount, text, tierLine });
  let content;
  if (mention) {
    const greeting = parseBoostMessage(getBoostGreetingTemplate(boost), member, boostCount);
    if (greeting.trim()) content = clamp(greeting, LIMITS.content);
  }

  return { content, embeds: [embed], allowedMentions };
}

/**
 * The boost embed. Keeps the whole embed under Discord's 6000 character limit.
 */
export function buildBoostEmbed(member, boost = {}, { boostCount = DETECTABLE_BOOST_COUNT, text, tierLine = '' } = {}) {
  const { guild, user } = member;
  const embed = new EmbedBuilder()
    .setColor(HEX_COLOR.test(boost.embedColor ?? '') ? boost.embedColor : DEFAULT_BOOST_COLOR);
  let used = 0;

  // Author section
  const authorType = boost.authorType || 'username';
  if (authorType !== 'none') {
    const author = authorType === 'server'
      ? { name: guild.name, iconURL: guild.iconURL({ size: 128 }) }
      : {
        name: authorType === 'displayname'
          ? (member.displayName || user.displayName || user.username)
          : user.username,
        iconURL: user.displayAvatarURL({ size: 128 })
      };
    author.name = clamp(author.name, LIMITS.author);
    embed.setAuthor({ name: author.name, iconURL: author.iconURL ?? undefined });
    used += author.name.length;
  }

  // Title: a single space means the title was removed
  const titleTemplate = boost.embedTitle;
  let title = null;
  if (titleTemplate?.trim()) {
    title = clamp(parseBoostMessage(titleTemplate, member, boostCount), LIMITS.title);
  } else if (titleTemplate !== ' ') {
    title = DEFAULT_BOOST_TITLE;
  }
  if (title?.trim()) {
    embed.setTitle(title);
    used += title.length;
  }

  // Footer: a single space means the footer was removed
  const footerTemplate = boost.footerText;
  let footer = null;
  if (footerTemplate?.trim()) {
    footer = clamp(parseBoostMessage(footerTemplate, member, boostCount), LIMITS.footer);
  } else if (footerTemplate !== ' ') {
    footer = `Boost #${guild.premiumSubscriptionCount || 1}`;
  }
  if (footer?.trim()) {
    embed.setFooter({ text: footer });
    used += footer.length;
  }

  // Description, with the tier reward line when one was earned
  let message = text ?? parseBoostMessage(getBoostMessageTemplate(boost), member, boostCount);
  if (!message.trim()) message = parseBoostMessage(DEFAULT_BOOST_MESSAGE, member, boostCount);
  const room = Math.min(LIMITS.description, LIMITS.embed - used) - tierLine.length;
  embed.setDescription(clamp(message, room) + tierLine);

  // Thumbnail
  if (boost.thumbnailType === 'avatar') {
    embed.setThumbnail(user.displayAvatarURL({ size: 256 }));
  } else if (boost.thumbnailType === 'server') {
    embed.setThumbnail(guild.iconURL({ size: 256 }));
  } else if (boost.thumbnailUrl) {
    embed.setThumbnail(toImageUrl(boost.thumbnailUrl));
  } else if (boost.thumbnailType !== 'none' && boost.thumbnailType !== null) {
    // Default to avatar if no specific type set
    embed.setThumbnail(user.displayAvatarURL({ size: 256 }));
  }

  if (boost.showTimestamp !== false) {
    embed.setTimestamp();
  }

  const banner = toImageUrl(boost.bannerUrl);
  if (banner) embed.setImage(banner);

  return embed;
}

/**
 * Parse boost message with variables. Replacer functions keep "$" in names literal.
 */
export function parseBoostMessage(msg, member, boostCount = DETECTABLE_BOOST_COUNT) {
  return String(msg ?? '')
    .replace(/{user}/gi, () => `<@${member.user.id}>`)
    .replace(/{username}/gi, () => member.user.username)
    .replace(/{displayname}/gi, () => member.displayName || member.user.displayName || member.user.username)
    .replace(/{tag}/gi, () => member.user.tag)
    .replace(/{id}/gi, () => member.user.id)
    .replace(/{server}/gi, () => member.guild.name)
    .replace(/{membercount}/gi, () => String(member.guild.memberCount ?? 0))
    .replace(/{boostcount}/gi, () => String(member.guild.premiumSubscriptionCount || 0))
    .replace(/{boostlevel}/gi, () => String(member.guild.premiumTier ?? 0))
    .replace(/{userboosts}/gi, () => String(boostCount))
    .replace(/{avatar}/gi, () => member.user.displayAvatarURL({ size: 256 }))
    .replace(/\\n/g, '\n');
}
