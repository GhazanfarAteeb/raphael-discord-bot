import { Events, EmbedBuilder, ChannelType, GuildVerificationLevel, PermissionsBitField } from 'discord.js';
import Guild from '../../models/Guild.js';
import { COLORS, GLYPHS } from '../../utils/embeds.js';
import { truncate } from '../../utils/helpers.js';

const FIELD_VALUE_MAX = 1024;
// Longest side of a single "before → after" line, so one long topic cannot fill the field
const CHANGE_SIDE_MAX = 300;

const CHANNEL_TYPES = {
  [ChannelType.GuildText]: 'Text Channel',
  [ChannelType.GuildVoice]: 'Voice Channel',
  [ChannelType.GuildCategory]: 'Category',
  [ChannelType.GuildAnnouncement]: 'Announcement Channel',
  [ChannelType.GuildStageVoice]: 'Stage Channel',
  [ChannelType.GuildForum]: 'Forum Channel',
  [ChannelType.GuildMedia]: 'Media Channel'
};

const VERIFICATION_LEVELS = {
  [GuildVerificationLevel.None]: 'None',
  [GuildVerificationLevel.Low]: 'Low',
  [GuildVerificationLevel.Medium]: 'Medium',
  [GuildVerificationLevel.High]: 'High',
  [GuildVerificationLevel.VeryHigh]: 'Very High'
};

export default {
  name: 'serverLogging',

  async initialize(client) {
    // Channel events
    client.on(Events.ChannelCreate, async (channel) => {
      await logChannelEvent(channel, 'create');
    });

    client.on(Events.ChannelDelete, async (channel) => {
      await logChannelEvent(channel, 'delete');
    });

    client.on(Events.ChannelUpdate, async (oldChannel, newChannel) => {
      await logChannelUpdate(oldChannel, newChannel);
    });

    // Role events
    client.on(Events.GuildRoleCreate, async (role) => {
      await logRoleEvent(role, 'create');
    });

    client.on(Events.GuildRoleDelete, async (role) => {
      await logRoleEvent(role, 'delete');
    });

    client.on(Events.GuildRoleUpdate, async (oldRole, newRole) => {
      await logRoleUpdate(oldRole, newRole);
    });

    // Emoji events
    client.on(Events.GuildEmojiCreate, async (emoji) => {
      await logEmojiEvent(emoji, 'create');
    });

    client.on(Events.GuildEmojiDelete, async (emoji) => {
      await logEmojiEvent(emoji, 'delete');
    });

    // Server update
    client.on(Events.GuildUpdate, async (oldGuild, newGuild) => {
      await logGuildUpdate(oldGuild, newGuild);
    });

    // Invite events
    client.on(Events.InviteCreate, async (invite) => {
      await logInviteEvent(invite, 'create');
    });

    client.on(Events.InviteDelete, async (invite) => {
      await logInviteEvent(invite, 'delete');
    });

    console.log('[RAPHAEL] Server logging initialized');
  }
};

// The configured server log channel, or null
async function getServerLogChannel(guild) {
  const guildConfig = await Guild.getGuild(guild.id, guild.name);
  const logChannelId = guildConfig?.channels?.serverLog;
  return logChannelId ? guild.channels.cache.get(logChannelId) ?? null : null;
}

function field(name, value, inline = true) {
  return { name: `${GLYPHS.ARROW_RIGHT} ${name}`, value: truncate(String(value || 'None'), FIELD_VALUE_MAX), inline };
}

function logEmbed(title, color) {
  return new EmbedBuilder()
    .setTitle(`『 ${title} 』`)
    .setColor(color)
    .setTimestamp();
}

// "**Label:** before → after", each side kept short
function changeLine(label, before, after) {
  const side = value => truncate(String(value), CHANGE_SIDE_MAX);
  return `${GLYPHS.DOT} **${label}:** ${side(before)} → ${side(after)}`;
}

// Fit whole change lines into one field value
function joinChanges(changes) {
  return truncate(changes.join('\n'), FIELD_VALUE_MAX);
}

function yesNo(value) {
  return value ? 'Yes' : 'No';
}

function formatPermissionName(name) {
  return name.replace(/([a-z])([A-Z])/g, '$1 $2');
}

async function logChannelEvent(channel, type) {
  try {
    if (!channel.guild) return;

    const logChannel = await getServerLogChannel(channel.guild);
    if (!logChannel) return;

    const created = type === 'create';
    const embed = logEmbed(created ? 'Channel Created' : 'Channel Deleted',
      created ? COLORS.RAPHAEL_SUCCESS : COLORS.RAPHAEL_ERROR)
      .addFields(
        field('Channel', created ? `${channel} (${channel.name})` : channel.name),
        field('Type', CHANNEL_TYPES[channel.type] || 'Unknown'),
        field('ID', channel.id)
      );

    if (channel.parent) {
      embed.addFields(field('Category', channel.parent.name));
    }

    await logChannel.send({ embeds: [embed] });

  } catch (error) {
    console.error('[ServerLogging] Error logging channel event:', error);
  }
}

async function logChannelUpdate(oldChannel, newChannel) {
  try {
    if (!newChannel.guild) return;

    const changes = [];

    if (oldChannel.name !== newChannel.name) {
      changes.push(changeLine('Name', oldChannel.name, newChannel.name));
    }
    if ((oldChannel.topic ?? null) !== (newChannel.topic ?? null)) {
      changes.push(changeLine('Topic', oldChannel.topic || '*None*', newChannel.topic || '*None*'));
    }
    if (oldChannel.nsfw !== newChannel.nsfw) {
      changes.push(changeLine('NSFW', yesNo(oldChannel.nsfw), yesNo(newChannel.nsfw)));
    }
    if (oldChannel.rateLimitPerUser !== newChannel.rateLimitPerUser) {
      changes.push(changeLine('Slowmode', `${oldChannel.rateLimitPerUser ?? 0}s`, `${newChannel.rateLimitPerUser ?? 0}s`));
    }
    if (oldChannel.parentId !== newChannel.parentId) {
      changes.push(changeLine('Category', oldChannel.parent?.name || 'None', newChannel.parent?.name || 'None'));
    }

    if (changes.length === 0) return;

    const logChannel = await getServerLogChannel(newChannel.guild);
    if (!logChannel) return;

    const embed = logEmbed('Channel Updated', COLORS.RAPHAEL_WARNING)
      .setDescription(`${GLYPHS.ARROW_RIGHT} ${newChannel} was updated.`)
      .addFields(field('Changes', joinChanges(changes), false))
      .setFooter({ text: `Channel ID: ${newChannel.id}` });

    await logChannel.send({ embeds: [embed] });

  } catch (error) {
    console.error('[ServerLogging] Error logging channel update:', error);
  }
}

async function logRoleEvent(role, type) {
  try {
    const logChannel = await getServerLogChannel(role.guild);
    if (!logChannel) return;

    const created = type === 'create';
    const embed = logEmbed(created ? 'Role Created' : 'Role Deleted',
      created ? COLORS.RAPHAEL_SUCCESS : COLORS.RAPHAEL_ERROR)
      .addFields(
        field('Role', created ? `${role} (${role.name})` : role.name),
        field('Color', role.hexColor),
        field('ID', role.id)
      );

    if (created) {
      embed.addFields(
        field('Mentionable', yesNo(role.mentionable)),
        field('Hoisted', yesNo(role.hoist))
      );
    }

    await logChannel.send({ embeds: [embed] });

  } catch (error) {
    console.error('[ServerLogging] Error logging role event:', error);
  }
}

async function logRoleUpdate(oldRole, newRole) {
  try {
    const changes = [];

    if (oldRole.name !== newRole.name) {
      changes.push(changeLine('Name', oldRole.name, newRole.name));
    }
    if (oldRole.hexColor !== newRole.hexColor) {
      changes.push(changeLine('Color', oldRole.hexColor, newRole.hexColor));
    }
    if (oldRole.hoist !== newRole.hoist) {
      changes.push(changeLine('Hoisted', yesNo(oldRole.hoist), yesNo(newRole.hoist)));
    }
    if (oldRole.mentionable !== newRole.mentionable) {
      changes.push(changeLine('Mentionable', yesNo(oldRole.mentionable), yesNo(newRole.mentionable)));
    }

    const oldBits = oldRole.permissions.bitfield;
    const newBits = newRole.permissions.bitfield;
    const grantedPermissions = new PermissionsBitField(newBits & ~oldBits).toArray().map(formatPermissionName);
    const revokedPermissions = new PermissionsBitField(oldBits & ~newBits).toArray().map(formatPermissionName);

    if (changes.length === 0 && grantedPermissions.length === 0 && revokedPermissions.length === 0) return;

    const logChannel = await getServerLogChannel(newRole.guild);
    if (!logChannel) return;

    const embed = logEmbed('Role Updated', COLORS.RAPHAEL_WARNING)
      .setDescription(`${GLYPHS.ARROW_RIGHT} ${newRole} was updated.`)
      .setFooter({ text: `Role ID: ${newRole.id}` });

    if (changes.length > 0) {
      embed.addFields(field('Changes', joinChanges(changes), false));
    }
    if (grantedPermissions.length > 0) {
      embed.addFields(field('Permissions Granted', grantedPermissions.join(', '), false));
    }
    if (revokedPermissions.length > 0) {
      embed.addFields(field('Permissions Revoked', revokedPermissions.join(', '), false));
    }

    await logChannel.send({ embeds: [embed] });

  } catch (error) {
    console.error('[ServerLogging] Error logging role update:', error);
  }
}

async function logEmojiEvent(emoji, type) {
  try {
    const logChannel = await getServerLogChannel(emoji.guild);
    if (!logChannel) return;

    const created = type === 'create';
    // The emoji itself is server data; a deleted one can no longer be rendered
    const embed = logEmbed(created ? 'Emoji Added' : 'Emoji Removed',
      created ? COLORS.RAPHAEL_SUCCESS : COLORS.RAPHAEL_ERROR)
      .addFields(
        field('Emoji', created ? `${emoji}` : emoji.name),
        field('Name', `:${emoji.name}:`),
        field('ID', emoji.id)
      )
      .setThumbnail(emoji.imageURL({ extension: emoji.animated ? 'gif' : 'png' }));

    await logChannel.send({ embeds: [embed] });

  } catch (error) {
    console.error('[ServerLogging] Error logging emoji event:', error);
  }
}

async function logGuildUpdate(oldGuild, newGuild) {
  try {
    const changes = [];

    if (oldGuild.name !== newGuild.name) {
      changes.push(changeLine('Name', oldGuild.name, newGuild.name));
    }
    if (oldGuild.icon !== newGuild.icon) {
      changes.push(`${GLYPHS.DOT} **Icon:** Changed`);
    }
    if (oldGuild.banner !== newGuild.banner) {
      changes.push(`${GLYPHS.DOT} **Banner:** Changed`);
    }
    if (oldGuild.description !== newGuild.description) {
      changes.push(changeLine('Description', oldGuild.description || '*None*', newGuild.description || '*None*'));
    }
    if (oldGuild.verificationLevel !== newGuild.verificationLevel) {
      changes.push(changeLine('Verification Level',
        VERIFICATION_LEVELS[oldGuild.verificationLevel] ?? oldGuild.verificationLevel,
        VERIFICATION_LEVELS[newGuild.verificationLevel] ?? newGuild.verificationLevel));
    }
    if (oldGuild.afkChannelId !== newGuild.afkChannelId) {
      changes.push(changeLine('AFK Channel',
        oldGuild.afkChannelId ? `<#${oldGuild.afkChannelId}>` : 'None',
        newGuild.afkChannelId ? `<#${newGuild.afkChannelId}>` : 'None'));
    }
    if (oldGuild.afkTimeout !== newGuild.afkTimeout) {
      changes.push(changeLine('AFK Timeout', `${oldGuild.afkTimeout}s`, `${newGuild.afkTimeout}s`));
    }

    if (changes.length === 0) return;

    const logChannel = await getServerLogChannel(newGuild);
    if (!logChannel) return;

    const embed = logEmbed('Server Updated', COLORS.RAPHAEL)
      .setDescription(`${GLYPHS.ARROW_RIGHT} Server settings were changed.`)
      .addFields(field('Changes', joinChanges(changes), false))
      .setThumbnail(newGuild.iconURL());

    await logChannel.send({ embeds: [embed] });

  } catch (error) {
    console.error('[ServerLogging] Error logging guild update:', error);
  }
}

async function logInviteEvent(invite, type) {
  try {
    if (!invite.guild) return;

    // A deleted invite may only carry a partial guild
    const guild = invite.client.guilds.cache.get(invite.guild.id);
    if (!guild) return;

    const logChannel = await getServerLogChannel(guild);
    if (!logChannel) return;

    const created = type === 'create';
    const embed = logEmbed(created ? 'Invite Created' : 'Invite Deleted',
      created ? COLORS.RAPHAEL_SUCCESS : COLORS.RAPHAEL_ERROR)
      .addFields(
        field('Code', invite.code),
        field('Channel', invite.channel ? `${invite.channel} (${invite.channel.name})` : 'Unknown')
      );

    if (created && invite.inviter) {
      embed.addFields(
        field('Created By', invite.inviter.tag),
        field('Max Uses', `${invite.maxUses || 'Unlimited'}`),
        field('Expires', invite.expiresTimestamp ? `<t:${Math.floor(invite.expiresTimestamp / 1000)}:R>` : 'Never')
      );
    }

    await logChannel.send({ embeds: [embed] });

  } catch (error) {
    console.error('[ServerLogging] Error logging invite event:', error);
  }
}
