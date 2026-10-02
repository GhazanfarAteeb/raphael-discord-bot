import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits, ChannelType } from 'discord.js';
import Confession from '../../models/Confession.js';
import Guild from '../../models/Guild.js';
import { successEmbed, errorEmbed, infoEmbed, COLORS } from '../../utils/embeds.js';
import { getPrefix, hasModPerms } from '../../utils/helpers.js';
import { getRandomFooter } from '../../utils/raphael.js';
import { postConfession } from '../../events/client/confessionHandler.js';

const MAX_COOLDOWN_SECONDS = 3600;
const MIN_LENGTH_RANGE = [1, 500];
const MAX_LENGTH_RANGE = [100, 4000];
const PENDING_SHOWN = 10;
const ON_VALUES = ['on', 'true', 'enable', 'yes'];
const OFF_VALUES = ['off', 'false', 'disable', 'no'];

// Toggle settings: subcommand name -> schema field and label
const TOGGLES = {
  replies: { field: 'allowReplies', label: 'Replies' },
  anonymous: { field: 'anonymousReplies', label: 'Anonymous replies' },
  approval: { field: 'requireApproval', label: 'Approval requirement' }
};

function onOff(value) {
  return value ? '◉ Yes' : '◇ No';
}

// "<@123>", "<@!123>" or a bare ID. Mentions are not used: a reply's author counts as a mention.
function parseUserId(arg) {
  const match = String(arg ?? '').match(/^(?:<@!?(\d{17,20})>|(\d{17,20}))$/);
  return match ? (match[1] || match[2]) : null;
}

function resolveChannel(message, arg) {
  return message.mentions.channels.first() ||
    message.guild.channels.cache.get(String(arg ?? '').replace(/[<#>]/g, ''));
}

export default {
  name: 'confession',
  aliases: [],
  description: 'Configure the anonymous confession system',
  usage: '<setup|disable|send|settings|ban|unban|pending|approve|reject|stats>',
  category: 'community',
  permissions: [PermissionFlagsBits.ManageGuild],
  cooldown: 3,
  examples: [
    'confession setup #confessions',
    'confession disable',
    'confession settings cooldown 120',
    'confession settings replies on',
    'confession settings approval on',
    'confession ban @user',
    'confession unban @user',
    'confession pending',
    'confession approve 1',
    'confession reject 1'
  ],

  async execute(message, args, client) {
    const guildId = message.guild.id;

    try {
      const guildConfig = await Guild.getGuild(guildId, message.guild.name);

      // Moderator permissions (admin, mod/staff role, or ManageGuild)
      if (!hasModPerms(message.member, guildConfig)) {
        return message.reply({
          embeds: [await errorEmbed(guildId, 'Permission Denied', 'Moderator or staff permissions are required for this skill, Master.')]
        });
      }

      const prefix = await getPrefix(guildId);
      const subcommand = args[0]?.toLowerCase();

      switch (subcommand) {
        case 'setup':
          return await setup(message, args, prefix);
        case 'disable':
          return await disable(message);
        case 'settings':
          return await settings(message, args, prefix);
        case 'ban':
          return await banUser(message, args, client, prefix);
        case 'unban':
          return await unbanUser(message, args, client, prefix);
        case 'pending':
          return await showPending(message, prefix);
        case 'approve':
          return await approveConfession(message, args, prefix);
        case 'reject':
          return await rejectConfession(message, args, prefix);
        case 'send':
          return await sendConfessionPanel(message, args, prefix);
        case 'stats':
          return await showStats(message);
        default:
          return await showHelp(message, prefix);
      }
    } catch (error) {
      console.error('[confession] Error:', error);
      return message.reply({
        embeds: [await errorEmbed(guildId, 'Operation Failed', 'An anomaly occurred in the confession system, Master.')]
      });
    }
  }
};

async function showHelp(message, prefix) {
  const embed = new EmbedBuilder()
    .setTitle('『 Confession System 』')
    .setDescription('**Analysis:** Members may submit anonymous confessions through the panel, Master.')
    .setColor(COLORS.RAPHAEL)
    .addFields(
      {
        name: '▸ Setup',
        value: [
          `\`${prefix}confession setup #channel\` — Set the confession channel`,
          `\`${prefix}confession disable\` — Disable confessions`,
          `\`${prefix}confession send [#channel]\` — Send the confession panel`
        ].join('\n'),
        inline: false
      },
      {
        name: '▸ Settings',
        value: [
          `\`${prefix}confession settings\` — View current settings`,
          `\`${prefix}confession settings cooldown <seconds>\` — Set the cooldown`,
          `\`${prefix}confession settings replies <on/off>\` — Toggle replies`,
          `\`${prefix}confession settings anonymous <on/off>\` — Anonymous replies`,
          `\`${prefix}confession settings approval <on/off>\` — Require approval`,
          `\`${prefix}confession settings minlength <chars>\` — Minimum length`,
          `\`${prefix}confession settings maxlength <chars>\` — Maximum length`
        ].join('\n'),
        inline: false
      },
      {
        name: '▸ Moderation',
        value: [
          `\`${prefix}confession ban @user\` — Bar a member from confessions`,
          `\`${prefix}confession unban @user\` — Lift the bar`,
          `\`${prefix}confession pending\` — View pending confessions`,
          `\`${prefix}confession approve <number>\` — Approve a pending confession`,
          `\`${prefix}confession reject <number>\` — Reject a pending confession`
        ].join('\n'),
        inline: false
      },
      {
        name: '▸ Information',
        value: `\`${prefix}confession stats\` — View confession statistics`,
        inline: false
      }
    )
    .setFooter({ text: `${getRandomFooter()} • Confessions are anonymous but logged for moderation` });

  return message.reply({ embeds: [embed] });
}

async function setup(message, args, prefix) {
  const guildId = message.guild.id;
  const channel = resolveChannel(message, args[1]);

  if (!channel) {
    return message.reply({
      embeds: [await errorEmbed(guildId, 'Channel Required',
        `Please mention a channel or provide a channel ID, Master.\n\n**Usage:** \`${prefix}confession setup #channel\``)]
    });
  }

  if (channel.type !== ChannelType.GuildText) {
    return message.reply({ embeds: [await errorEmbed(guildId, 'Invalid Channel', 'Please select a text channel, Master.')] });
  }

  const botPerms = channel.permissionsFor(message.guild.members.me);
  if (!botPerms?.has(['SendMessages', 'EmbedLinks'])) {
    return message.reply({
      embeds: [await errorEmbed(guildId, 'Missing Permissions', 'I need `Send Messages` and `Embed Links` permissions in that channel, Master.')]
    });
  }

  const confessionData = await Confession.findOneAndUpdate(
    { guildId },
    { guildId, channelId: channel.id, enabled: true },
    { upsert: true, new: true }
  );

  const panelMessage = await sendPanel(channel);
  confessionData.panelMessageId = panelMessage.id;
  await confessionData.save();

  return message.reply({
    embeds: [await successEmbed(guildId, 'Confessions Configured',
      `The confession system is now active in ${channel}, Master.\n\nA panel has been posted there; members can use its button to submit anonymous confessions.`)]
  });
}

async function sendPanel(channel) {
  const embed = new EmbedBuilder()
    .setTitle('『 Anonymous Confessions 』')
    .setDescription('Use the button below to submit an anonymous confession.\n\n*Your identity will remain hidden from other members.*')
    .setColor(COLORS.RAPHAEL)
    .setFooter({ text: 'Confessions are moderated • Be respectful' });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('confession_submit')
      .setLabel('Submit a Confession')
      .setStyle(ButtonStyle.Primary)
  );

  return channel.send({ embeds: [embed], components: [row] });
}

async function disable(message) {
  await Confession.findOneAndUpdate(
    { guildId: message.guild.id },
    { enabled: false, channelId: null }
  );

  return message.reply({
    embeds: [await successEmbed(message.guild.id, 'Confessions Disabled', 'The confession system has been disabled, Master.')]
  });
}

async function settings(message, args, prefix) {
  const guildId = message.guild.id;
  let confessionData = await Confession.findOne({ guildId });

  if (!confessionData) {
    confessionData = new Confession({ guildId });
    await confessionData.save();
  }

  const current = confessionData.settings;

  if (!args[1]) {
    const embed = new EmbedBuilder()
      .setTitle('『 Confession Settings 』')
      .setColor(COLORS.RAPHAEL)
      .addFields(
        { name: '▸ Status', value: confessionData.enabled ? '◉ Enabled' : '◇ Disabled', inline: true },
        { name: '▸ Channel', value: confessionData.channelId ? `<#${confessionData.channelId}>` : 'Not set', inline: true },
        { name: '▸ Total Confessions', value: `${confessionData.confessionCount}`, inline: true },
        { name: '▸ Cooldown', value: `${current.cooldown} seconds`, inline: true },
        { name: '▸ Allow Replies', value: onOff(current.allowReplies), inline: true },
        { name: '▸ Anonymous Replies', value: onOff(current.anonymousReplies), inline: true },
        { name: '▸ Require Approval', value: onOff(current.requireApproval), inline: true },
        { name: '▸ Min Length', value: `${current.minLength} chars`, inline: true },
        { name: '▸ Max Length', value: `${current.maxLength} chars`, inline: true },
        { name: '▸ Barred Users', value: `${current.bannedUsers.length} users`, inline: true }
      )
      .setFooter({ text: getRandomFooter() });

    return message.reply({ embeds: [embed] });
  }

  const setting = args[1].toLowerCase();
  const value = args[2]?.toLowerCase();

  if (TOGGLES[setting]) {
    const { field, label } = TOGGLES[setting];
    const enabled = ON_VALUES.includes(value) ? true : OFF_VALUES.includes(value) ? false : null;

    if (enabled === null) {
      return message.reply({
        embeds: [await errorEmbed(guildId, 'Invalid Value',
          `Please specify \`on\` or \`off\`, Master.\n\n**Usage:** \`${prefix}confession settings ${setting} <on/off>\``)]
      });
    }

    current[field] = enabled;
    await confessionData.save();
    return message.reply({
      embeds: [await successEmbed(guildId, 'Setting Updated', `${label} ${enabled ? 'enabled' : 'disabled'}, Master.`)]
    });
  }

  switch (setting) {
    case 'cooldown': {
      const cooldown = parseInt(value, 10);
      if (isNaN(cooldown) || cooldown < 0 || cooldown > MAX_COOLDOWN_SECONDS) {
        return message.reply({
          embeds: [await errorEmbed(guildId, 'Invalid Cooldown', `The cooldown must be between 0 and ${MAX_COOLDOWN_SECONDS} seconds, Master.`)]
        });
      }
      current.cooldown = cooldown;
      await confessionData.save();
      return message.reply({
        embeds: [await successEmbed(guildId, 'Setting Updated', `Confession cooldown set to **${cooldown} seconds**, Master.`)]
      });
    }

    case 'minlength': {
      const minLength = parseInt(value, 10);
      const [low, high] = MIN_LENGTH_RANGE;
      if (isNaN(minLength) || minLength < low || minLength > high) {
        return message.reply({
          embeds: [await errorEmbed(guildId, 'Invalid Length', `The minimum length must be between ${low} and ${high} characters, Master.`)]
        });
      }
      // The submission form rejects a minimum above the maximum
      if (minLength > current.maxLength) {
        return message.reply({
          embeds: [await errorEmbed(guildId, 'Invalid Length',
            `The minimum length cannot exceed the current maximum of ${current.maxLength} characters, Master.`)]
        });
      }
      current.minLength = minLength;
      await confessionData.save();
      return message.reply({
        embeds: [await successEmbed(guildId, 'Setting Updated', `Minimum confession length set to **${minLength} characters**, Master.`)]
      });
    }

    case 'maxlength': {
      const maxLength = parseInt(value, 10);
      const [low, high] = MAX_LENGTH_RANGE;
      if (isNaN(maxLength) || maxLength < low || maxLength > high) {
        return message.reply({
          embeds: [await errorEmbed(guildId, 'Invalid Length', `The maximum length must be between ${low} and ${high} characters, Master.`)]
        });
      }
      if (maxLength < current.minLength) {
        return message.reply({
          embeds: [await errorEmbed(guildId, 'Invalid Length',
            `The maximum length cannot be below the current minimum of ${current.minLength} characters, Master.`)]
        });
      }
      current.maxLength = maxLength;
      await confessionData.save();
      return message.reply({
        embeds: [await successEmbed(guildId, 'Setting Updated', `Maximum confession length set to **${maxLength} characters**, Master.`)]
      });
    }

    default:
      return message.reply({
        embeds: [await errorEmbed(guildId, 'Invalid Setting',
          'Use one of: `cooldown`, `replies`, `anonymous`, `approval`, `minlength`, `maxlength`, Master.')]
      });
  }
}

async function resolveTargetUser(message, arg, client, prefix, action) {
  const userId = parseUserId(arg);
  const user = userId ? await client.users.fetch(userId).catch(() => null) : null;
  if (!user) {
    await message.reply({
      embeds: [await errorEmbed(message.guild.id, 'User Required',
        `Please mention a user or provide a user ID, Master.\n\n**Usage:** \`${prefix}confession ${action} @user\``)]
    });
  }
  return user;
}

async function banUser(message, args, client, prefix) {
  const guildId = message.guild.id;
  const user = await resolveTargetUser(message, args[1], client, prefix, 'ban');
  if (!user) return null;

  const confessionData = await Confession.findOne({ guildId });
  if (!confessionData) {
    return message.reply({ embeds: [await errorEmbed(guildId, 'Not Configured', 'The confession system is not set up, Master.')] });
  }

  if (confessionData.settings.bannedUsers.includes(user.id)) {
    return message.reply({ embeds: [await errorEmbed(guildId, 'Already Barred', 'This user is already barred from confessions, Master.')] });
  }

  confessionData.settings.bannedUsers.push(user.id);
  await confessionData.save();

  return message.reply({
    embeds: [await successEmbed(guildId, 'User Barred', `**${user.tag}** can no longer submit confessions, Master.`)]
  });
}

async function unbanUser(message, args, client, prefix) {
  const guildId = message.guild.id;
  const user = await resolveTargetUser(message, args[1], client, prefix, 'unban');
  if (!user) return null;

  const confessionData = await Confession.findOne({ guildId });
  if (!confessionData) {
    return message.reply({ embeds: [await errorEmbed(guildId, 'Not Configured', 'The confession system is not set up, Master.')] });
  }

  const index = confessionData.settings.bannedUsers.indexOf(user.id);
  if (index === -1) {
    return message.reply({ embeds: [await errorEmbed(guildId, 'Not Barred', 'This user is not barred from confessions, Master.')] });
  }

  confessionData.settings.bannedUsers.splice(index, 1);
  await confessionData.save();

  return message.reply({
    embeds: [await successEmbed(guildId, 'Bar Lifted', `**${user.tag}** may submit confessions again, Master.`)]
  });
}

async function showPending(message, prefix) {
  const guildId = message.guild.id;
  const confessionData = await Confession.findOne({ guildId });

  if (!confessionData || confessionData.pendingConfessions.length === 0) {
    return message.reply({ embeds: [await infoEmbed(guildId, 'Pending Confessions', 'There are no pending confessions to review, Master.')] });
  }

  const pending = confessionData.pendingConfessions;
  const embed = new EmbedBuilder()
    .setTitle('『 Pending Confessions 』')
    .setColor(COLORS.RAPHAEL)
    .setDescription(pending.slice(0, PENDING_SHOWN).map((c, i) =>
      `**${i + 1}.** ${c.content.substring(0, 100)}${c.content.length > 100 ? '...' : ''}\n*Submitted <t:${Math.floor(c.timestamp.getTime() / 1000)}:R>*`
    ).join('\n\n'))
    .setFooter({ text: `Showing ${Math.min(PENDING_SHOWN, pending.length)} of ${pending.length} pending • ${prefix}confession approve <number>` });

  return message.reply({ embeds: [embed] });
}

// Parse a 1-based pending confession number into an index, replying with an error when invalid
async function resolvePendingIndex(message, arg, prefix, action) {
  const index = parseInt(arg, 10) - 1;
  if (isNaN(index) || index < 0) {
    await message.reply({
      embeds: [await errorEmbed(message.guild.id, 'Invalid Number',
        `Please provide a pending confession number, Master.\n\n**Usage:** \`${prefix}confession ${action} <number>\` (see \`${prefix}confession pending\`)`)]
    });
    return null;
  }
  return index;
}

async function approveConfession(message, args, prefix) {
  const guildId = message.guild.id;
  const index = await resolvePendingIndex(message, args[1], prefix, 'approve');
  if (index === null) return null;

  const confessionData = await Confession.findOne({ guildId });
  const pending = confessionData?.pendingConfessions[index];

  if (!pending) {
    return message.reply({ embeds: [await errorEmbed(guildId, 'Not Found', 'No pending confession has that number, Master.')] });
  }

  const channel = message.guild.channels.cache.get(confessionData.channelId);
  if (!channel?.isTextBased()) {
    return message.reply({ embeds: [await errorEmbed(guildId, 'Channel Missing', 'The confession channel could not be found, Master.')] });
  }

  // Same posting path as direct submissions (Reply button only while replies are allowed)
  const confessionNumber = await postConfession(channel, confessionData, pending.content, pending.userId);
  confessionData.pendingConfessions.splice(index, 1);
  await confessionData.save();

  return message.reply({
    embeds: [await successEmbed(guildId, 'Confession Approved', `Confession #${confessionNumber} has been approved and posted, Master.`)]
  });
}

async function rejectConfession(message, args, prefix) {
  const guildId = message.guild.id;
  const index = await resolvePendingIndex(message, args[1], prefix, 'reject');
  if (index === null) return null;

  const confessionData = await Confession.findOne({ guildId });

  if (!confessionData?.pendingConfessions[index]) {
    return message.reply({ embeds: [await errorEmbed(guildId, 'Not Found', 'No pending confession has that number, Master.')] });
  }

  confessionData.pendingConfessions.splice(index, 1);
  await confessionData.save();

  return message.reply({
    embeds: [await successEmbed(guildId, 'Confession Rejected', 'The confession has been rejected and removed, Master.')]
  });
}

async function sendConfessionPanel(message, args, prefix) {
  const guildId = message.guild.id;
  const confessionData = await Confession.findOne({ guildId });

  if (!confessionData || !confessionData.enabled) {
    return message.reply({
      embeds: [await errorEmbed(guildId, 'Not Configured',
        `The confession system is not set up. Use \`${prefix}confession setup #channel\` first, Master.`)]
    });
  }

  const channel = (args[1] ? resolveChannel(message, args[1]) : null) ||
    message.guild.channels.cache.get(confessionData.channelId);

  if (!channel?.isTextBased()) {
    return message.reply({ embeds: [await errorEmbed(guildId, 'Channel Missing', 'I could not find a text channel for the panel, Master.')] });
  }

  await sendPanel(channel);

  return message.reply({ embeds: [await successEmbed(guildId, 'Panel Sent', `Confession panel sent to ${channel}, Master.`)] });
}

async function showStats(message) {
  const guildId = message.guild.id;
  const confessionData = await Confession.findOne({ guildId });

  if (!confessionData) {
    return message.reply({ embeds: [await infoEmbed(guildId, 'Confession Statistics', 'No confession data exists yet, Master.')] });
  }

  // Replies are stored as confessions that point at another confession
  const totalReplies = confessionData.confessions.filter(c => c.replyTo).length;

  const embed = new EmbedBuilder()
    .setTitle('『 Confession Statistics 』')
    .setColor(COLORS.RAPHAEL)
    .addFields(
      { name: '▸ Total Confessions', value: `${confessionData.confessionCount}`, inline: true },
      { name: '▸ Total Replies', value: `${totalReplies}`, inline: true },
      { name: '▸ Pending Approval', value: `${confessionData.pendingConfessions.length}`, inline: true },
      { name: '▸ Barred Users', value: `${confessionData.settings.bannedUsers.length}`, inline: true },
      { name: '▸ Status', value: confessionData.enabled ? '◉ Active' : '◇ Disabled', inline: true },
      { name: '▸ Channel', value: confessionData.channelId ? `<#${confessionData.channelId}>` : 'Not set', inline: true }
    )
    .setFooter({ text: getRandomFooter() })
    .setTimestamp();

  return message.reply({ embeds: [embed] });
}
