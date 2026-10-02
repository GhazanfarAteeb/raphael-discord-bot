import { EmbedBuilder, PermissionFlagsBits, GuildOnboardingMode, GuildOnboardingPromptType } from 'discord.js';
import { successEmbed, errorEmbed, infoEmbed, GLYPHS, COLORS } from '../../utils/embeds.js';
import { getPrefix, getAssignableRoleError } from '../../utils/helpers.js';
import { getRandomFooter } from '../../utils/raphael.js';

// Discord limits
const PROMPT_TITLE_MAX = 100;
const OPTION_DESCRIPTION_MAX = 100;
const FIELD_VALUE_MAX = 1024;
const DESCRIPTION_MAX = 4096;

const YES_NO = new Map([
  ['yes', true], ['true', true], ['on', true], ['1', true],
  ['no', false], ['false', false], ['off', false], ['0', false]
]);

export default {
  name: 'onboarding',
  description: 'Manage server onboarding settings, questions, and default channels',
  usage: '<view|enable|disable|channels|questions> [options]',
  aliases: ['onboard', 'serveronboarding'],
  category: 'config',
  permissions: [PermissionFlagsBits.ManageGuild],
  cooldown: 3,

  async execute(message, args) {
    try {
      const prefix = await getPrefix(message.guild.id);

      if (!message.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
        return await replyError(message, 'Permission Denied',
          `${GLYPHS.LOCK} You need Manage Server permissions to manage onboarding, Master.`);
      }

      const subcommand = args[0]?.toLowerCase();

      // Awaited so Discord API errors reach the catch below
      switch (subcommand) {
        case 'view':
        case 'info':
        case 'status':
          return await viewOnboarding(message);

        case 'enable':
          return await toggleOnboarding(message, true, prefix);

        case 'disable':
          return await toggleOnboarding(message, false, prefix);

        case 'channels':
        case 'channel':
          return await manageChannels(message, args.slice(1), prefix);

        case 'questions':
        case 'question':
        case 'prompts':
        case 'prompt':
          return await manageQuestions(message, args.slice(1), prefix);

        default:
          return await showHelp(message, prefix);
      }
    } catch (error) {
      return replyOnboardingError(message, error);
    }
  }
};

// ============================================
// Helpers
// ============================================

async function replySuccess(message, title, description) {
  return message.reply({ embeds: [await successEmbed(message.guild.id, title, description)] });
}

async function replyError(message, title, description) {
  return message.reply({ embeds: [await errorEmbed(message.guild.id, title, description)] });
}

async function replyInfo(message, title, description) {
  return message.reply({ embeds: [await infoEmbed(message.guild.id, title, description)] });
}

async function replyOnboardingError(message, error) {
  console.error('Onboarding command error:', error);

  let title = 'Onboarding Error';
  let description = `${GLYPHS.ERROR} Discord rejected the change, Master: ${error.message}`;

  if (error.code === 50001 || error.code === 50013) {
    title = 'Missing Access';
    description = `${GLYPHS.ERROR} I do not have permission to manage onboarding, Master.\n\n` +
      'Make sure I have the **Manage Server** and **Manage Roles** permissions.';
  } else if (error.code === 30029 || /community/i.test(error.message ?? '')) {
    title = 'Community Required';
    description = `${GLYPHS.ERROR} Onboarding requires a **Community Server**, Master.\n\n` +
      'Enable Community in Server Settings › Enable Community.';
  }

  return replyError(message, title, description).catch(() => { });
}

function parseYesNo(value) {
  const key = String(value ?? '').toLowerCase();
  return YES_NO.has(key) ? YES_NO.get(key) : null;
}

function isKeyword(value, keywords) {
  return keywords.includes(String(value ?? '').toLowerCase());
}

// Joins lines, stopping before `max` characters with a note about what was left out
function fitLines(lines, max, separator = '\n') {
  const NOTE_ROOM = 30;
  let text = '';
  for (let i = 0; i < lines.length; i++) {
    const next = text ? text + separator + lines[i] : lines[i];
    const isLast = i === lines.length - 1;
    if (next.length > (isLast ? max : max - NOTE_ROOM)) {
      const note = `…and ${lines.length - i} more`;
      return text ? text + separator + note : note;
    }
    text = next;
  }
  return text;
}

function optionEmoji(option) {
  // The getter reads raw emoji data; treat anything unreadable as "no emoji"
  try {
    return option.emoji;
  } catch {
    return null;
  }
}

// discord.js exposes channels/roles as Collections (values may be uncached), while
// editOnboarding takes `channels`/`roles`/`defaultChannels` lists, so pass plain ID arrays.
function toOptionData(option) {
  const emoji = optionEmoji(option);
  return {
    id: option.id,
    title: option.title,
    description: option.description ?? null,
    emoji: emoji ? { id: emoji.id ?? null, name: emoji.name ?? null, animated: Boolean(emoji.animated) } : null,
    channels: [...option.channels.keys()],
    roles: [...option.roles.keys()]
  };
}

function toPromptData(prompt) {
  return {
    id: prompt.id,
    title: prompt.title,
    singleSelect: prompt.singleSelect,
    required: prompt.required,
    inOnboarding: prompt.inOnboarding,
    type: prompt.type,
    options: prompt.options.map(toOptionData)
  };
}

// All prompts as edit data, with `modify` applied to the one matching promptId
function mapPrompts(onboarding, promptId, modify) {
  return onboarding.prompts.map(prompt => {
    const data = toPromptData(prompt);
    if (prompt.id === promptId) modify(data);
    return data;
  });
}

// Resubmits the whole onboarding with the given changes; returns the updated onboarding
function saveOnboarding(guild, onboarding, changes = {}) {
  return guild.editOnboarding({
    enabled: changes.enabled ?? onboarding.enabled,
    mode: onboarding.mode,
    defaultChannels: changes.defaultChannels ?? [...onboarding.defaultChannels.keys()],
    prompts: changes.prompts ?? onboarding.prompts.map(toPromptData)
  });
}

function baseEmbed(title) {
  return new EmbedBuilder()
    .setTitle(`『 ${title} 』`)
    .setColor(COLORS.RAPHAEL)
    .setFooter({ text: getRandomFooter() })
    .setTimestamp();
}

// ============================================
// Views
// ============================================

async function showHelp(message, prefix) {
  let onboardingStatus;
  try {
    const onboarding = await message.guild.fetchOnboarding();
    onboardingStatus = onboarding.enabled ? '◉ Enabled' : '◇ Disabled';
  } catch {
    onboardingStatus = '⚠ Not available (Community required)';
  }

  const p = `${prefix}onboarding`;
  const embed = baseEmbed('Onboarding Management')
    .setDescription(
      `**Analysis:** Manage your server's onboarding experience for new members, Master.\n\n` +
      `**Current Status:** ${onboardingStatus}`
    )
    .addFields(
      {
        name: '▸ General',
        value: [
          `\`${p} view\` - View current settings`,
          `\`${p} enable\` / \`${p} disable\` - Toggle onboarding`
        ].join('\n')
      },
      {
        name: '▸ Default Channels',
        value: [
          `\`${p} channels list\` - View default channels`,
          `\`${p} channels add #channel\` - Add default channel`,
          `\`${p} channels remove #channel\` - Remove channel`
        ].join('\n')
      },
      {
        name: '▸ Questions',
        value: [
          `\`${p} questions list\` - View all questions`,
          `\`${p} questions add <title>\` - Create question`,
          `\`${p} questions edit <id> <setting> <value>\``,
          `\`${p} questions delete <id>\` - Delete question`
        ].join('\n')
      },
      {
        name: '▸ Question Options',
        value: [
          `\`${p} questions options <id>\` - List options`,
          `\`${p} questions options <id> add <title>\``,
          `\`${p} questions options <id> remove <optionId>\``,
          `\`${p} questions options <id> role <optionId> @role [remove]\``,
          `\`${p} questions options <id> channel <optionId> #channel [remove]\``
        ].join('\n')
      }
    )
    .setFooter({ text: 'Onboarding requires Community Server to be enabled' });

  return message.reply({ embeds: [embed] });
}

async function viewOnboarding(message) {
  const onboarding = await message.guild.fetchOnboarding();
  const channelIds = [...onboarding.defaultChannels.keys()];

  const embed = baseEmbed('Onboarding Settings')
    .setDescription(`**Analysis:** Server onboarding configuration for **${message.guild.name}**, Master.`)
    .addFields(
      {
        name: '▸ Status',
        value: [
          `**Enabled:** ${onboarding.enabled ? '◉ Yes' : '◇ No'}`,
          `**Mode:** ${onboarding.mode === GuildOnboardingMode.OnboardingDefault ? 'Default' : 'Advanced'}`
        ].join('\n'),
        inline: true
      },
      {
        name: '▸ Default Channels',
        value: channelIds.length > 0
          ? fitLines(channelIds.map(id => `<#${id}>`), FIELD_VALUE_MAX)
          : '*No default channels*',
        inline: true
      },
      {
        name: '▸ Questions',
        value: `${onboarding.prompts.size} question(s) configured`,
        inline: true
      }
    );

  if (onboarding.prompts.size > 0) {
    const questionLines = [...onboarding.prompts.values()].map((prompt, index) => {
      const flags = [];
      if (prompt.required) flags.push('Required');
      flags.push(prompt.singleSelect ? 'Single' : 'Multi');

      return `**${index + 1}.** ${prompt.title}\n` +
        `   └ ${prompt.options.size} options | ${flags.join(', ')} | ID: \`${prompt.id}\``;
    });

    embed.addFields({ name: '▸ Questions List', value: fitLines(questionLines, FIELD_VALUE_MAX) });
  }

  return message.reply({ embeds: [embed] });
}

async function toggleOnboarding(message, enable, prefix) {
  const onboarding = await message.guild.fetchOnboarding();

  if (onboarding.enabled === enable) {
    return replyInfo(message, 'No Change',
      `${GLYPHS.INFO} Onboarding is already ${enable ? 'enabled' : 'disabled'}, Master.`);
  }

  // To enable, we need at least some defaults
  if (enable && onboarding.defaultChannels.size === 0) {
    return replyError(message, 'Cannot Enable',
      `${GLYPHS.ERROR} You need at least **1 default channel** before enabling onboarding, Master.\n\n` +
      `Use \`${prefix}onboarding channels add #channel\` to add one.`);
  }

  await saveOnboarding(message.guild, onboarding, { enabled: enable });

  return replySuccess(message, `Onboarding ${enable ? 'Enabled' : 'Disabled'}`,
    `${GLYPHS.SUCCESS} Server onboarding has been ${enable ? 'enabled' : 'disabled'}.`);
}

// ============================================
// Default channels
// ============================================

async function manageChannels(message, args, prefix) {
  const action = args[0]?.toLowerCase();
  const onboarding = await message.guild.fetchOnboarding();
  const channelIds = [...onboarding.defaultChannels.keys()];

  if (!action || action === 'list') {
    const embed = baseEmbed('Default Channels')
      .setDescription(
        channelIds.length > 0
          ? fitLines(channelIds.map((id, i) => `**${i + 1}.** <#${id}>`), DESCRIPTION_MAX)
          : '*No default channels configured*'
      )
      .addFields({
        name: '▸ Commands',
        value: [
          `\`${prefix}onboarding channels add #channel\` - Add channel`,
          `\`${prefix}onboarding channels remove #channel\` - Remove channel`
        ].join('\n')
      })
      .setFooter({ text: `${channelIds.length} default channel(s)` });

    return message.reply({ embeds: [embed] });
  }

  const channel = message.mentions.channels.first() || message.guild.channels.cache.get(args[1]);

  if (action === 'add') {
    if (!channel) {
      return replyError(message, 'Channel Required',
        `${GLYPHS.ERROR} Please mention a channel to add, Master.\n\n**Usage:** \`${prefix}onboarding channels add #channel\``);
    }

    if (channelIds.includes(channel.id)) {
      return replyError(message, 'Already Added', `${GLYPHS.ERROR} ${channel} is already a default channel.`);
    }

    await saveOnboarding(message.guild, onboarding, { defaultChannels: [...channelIds, channel.id] });

    return replySuccess(message, 'Channel Added', `${GLYPHS.SUCCESS} ${channel} has been added to default channels.`);
  }

  if (action === 'remove') {
    if (!channel) {
      return replyError(message, 'Channel Required',
        `${GLYPHS.ERROR} Please mention a channel to remove, Master.\n\n**Usage:** \`${prefix}onboarding channels remove #channel\``);
    }

    if (!channelIds.includes(channel.id)) {
      return replyError(message, 'Not Found', `${GLYPHS.ERROR} ${channel} is not a default channel.`);
    }

    const newChannelIds = channelIds.filter(id => id !== channel.id);

    // Need at least 1 default channel while onboarding is enabled
    if (onboarding.enabled && newChannelIds.length === 0) {
      return replyError(message, 'Cannot Remove',
        `${GLYPHS.ERROR} You need at least 1 default channel while onboarding is enabled, Master.\n\n` +
        `Disable onboarding first or add another channel.`);
    }

    await saveOnboarding(message.guild, onboarding, { defaultChannels: newChannelIds });

    return replySuccess(message, 'Channel Removed', `${GLYPHS.SUCCESS} ${channel} has been removed from default channels.`);
  }

  return showHelp(message, prefix);
}

// ============================================
// Questions
// ============================================

async function manageQuestions(message, args, prefix) {
  const action = args[0]?.toLowerCase();
  const onboarding = await message.guild.fetchOnboarding();

  if (!action || action === 'list') {
    return listQuestions(message, onboarding, prefix);
  }

  if (action === 'add' || action === 'create') {
    return addQuestion(message, args, onboarding, prefix);
  }

  if (action === 'edit') {
    return editQuestion(message, args, onboarding, prefix);
  }

  if (action === 'delete' || action === 'remove') {
    return deleteQuestion(message, args, onboarding, prefix);
  }

  if (action === 'options' || action === 'option') {
    return manageOptions(message, args.slice(1), prefix, onboarding);
  }

  return showHelp(message, prefix);
}

async function listQuestions(message, onboarding, prefix) {
  const embed = baseEmbed('Onboarding Questions');

  if (onboarding.prompts.size === 0) {
    embed.setDescription('*No questions configured*');
  } else {
    const questionBlocks = [...onboarding.prompts.values()].map((prompt, index) => {
      const flags = [
        prompt.required ? 'Required' : 'Optional',
        prompt.singleSelect ? 'Single' : 'Multi'
      ];

      const optionsList = prompt.options.map(o => {
        const roleCount = o.roles.size;
        const channelCount = o.channels.size;
        return `    • ${o.title}${roleCount > 0 ? ` (${roleCount} roles)` : ''}${channelCount > 0 ? ` (${channelCount} channels)` : ''}`;
      }).join('\n');

      return `**${index + 1}. ${prompt.title}**\n` +
        `   ${flags.join(' | ')}\n` +
        `   ID: \`${prompt.id}\`\n` +
        (optionsList || '   *No options*');
    });

    embed.setDescription(fitLines(questionBlocks, DESCRIPTION_MAX, '\n\n'));
  }

  embed
    .addFields({
      name: '▸ Commands',
      value: [
        `\`${prefix}onboarding questions add <title>\` - Create question`,
        `\`${prefix}onboarding questions edit <id> <setting> <value>\``,
        `\`${prefix}onboarding questions delete <id>\``,
        `\`${prefix}onboarding questions options <id>\` - Manage options`
      ].join('\n')
    })
    .setFooter({ text: `${onboarding.prompts.size} question(s)` });

  return message.reply({ embeds: [embed] });
}

async function addQuestion(message, args, onboarding, prefix) {
  const title = args.slice(1).join(' ');

  if (!title) {
    return replyError(message, 'Title Required',
      `${GLYPHS.ERROR} Please provide a question title, Master.\n\n**Usage:** \`${prefix}onboarding questions add What do you want to do?\``);
  }

  if (title.length > PROMPT_TITLE_MAX) {
    return replyError(message, 'Title Too Long',
      `${GLYPHS.ERROR} Question title must be ${PROMPT_TITLE_MAX} characters or less, Master.`);
  }

  const newPrompt = {
    title,
    singleSelect: false,
    required: false,
    inOnboarding: true,
    type: GuildOnboardingPromptType.MultipleChoice,
    options: []
  };

  const existingIds = new Set(onboarding.prompts.keys());
  const updated = await saveOnboarding(message.guild, onboarding, {
    prompts: [...onboarding.prompts.map(toPromptData), newPrompt]
  });

  // The new prompt gets its ID from Discord
  const createdPrompt = updated.prompts.find(p => !existingIds.has(p.id));
  const createdId = createdPrompt?.id || '<id>';

  return replySuccess(message, 'Question Created',
    `${GLYPHS.SUCCESS} Question created.\n\n` +
    `**Title:** ${title}\n` +
    `**ID:** \`${createdPrompt?.id || 'Unknown'}\`\n` +
    `**Single Select:** No\n` +
    `**Required:** No\n\n` +
    `Use \`${prefix}onboarding questions options ${createdId} add <answer>\` to add options.`);
}

async function editQuestion(message, args, onboarding, prefix) {
  const promptId = args[1];
  const setting = args[2]?.toLowerCase();
  const value = args.slice(3).join(' ');

  if (!promptId) {
    return replyError(message, 'ID Required',
      `${GLYPHS.ERROR} Please provide the question ID, Master.\n\n**Usage:** \`${prefix}onboarding questions edit <id> <setting> <value>\`\n\n` +
      `**Settings:** title, required, singleselect`);
  }

  const prompt = onboarding.prompts.get(promptId);
  if (!prompt) {
    return replyError(message, 'Not Found',
      `${GLYPHS.ERROR} Question with ID \`${promptId}\` not found.\n\nUse \`${prefix}onboarding questions list\` to see all question IDs.`);
  }

  if (!setting) {
    const embed = baseEmbed('Edit Question')
      .setDescription(`**${prompt.title}**`)
      .addFields(
        { name: 'ID', value: `\`${prompt.id}\``, inline: true },
        { name: 'Required', value: prompt.required ? 'Yes' : 'No', inline: true },
        { name: 'Single Select', value: prompt.singleSelect ? 'Yes' : 'No', inline: true },
        { name: 'Options', value: `${prompt.options.size}`, inline: true },
        {
          name: '▸ Edit Commands',
          value: [
            `\`${prefix}onboarding questions edit ${promptId} title <new title>\``,
            `\`${prefix}onboarding questions edit ${promptId} required yes/no\``,
            `\`${prefix}onboarding questions edit ${promptId} singleselect yes/no\``
          ].join('\n')
        }
      );

    return message.reply({ embeds: [embed] });
  }

  let modify;
  let label;
  let display;

  if (setting === 'title') {
    if (!value) {
      return replyError(message, 'Title Required',
        `${GLYPHS.ERROR} Please provide a new title, Master.\n\n**Usage:** \`${prefix}onboarding questions edit ${promptId} title <new title>\``);
    }
    if (value.length > PROMPT_TITLE_MAX) {
      return replyError(message, 'Title Too Long',
        `${GLYPHS.ERROR} Question title must be ${PROMPT_TITLE_MAX} characters or less, Master.`);
    }
    modify = data => { data.title = value; };
    label = 'Title';
    display = value;
  } else if (setting === 'required' || setting === 'singleselect' || setting === 'single') {
    const enabled = parseYesNo(value);
    if (enabled === null) {
      return replyError(message, 'Value Required',
        `${GLYPHS.ERROR} Please specify \`yes\` or \`no\`, Master.\n\n` +
        `**Usage:** \`${prefix}onboarding questions edit ${promptId} ${setting} yes/no\``);
    }
    const key = setting === 'required' ? 'required' : 'singleSelect';
    modify = data => { data[key] = enabled; };
    label = setting === 'required' ? 'Required' : 'Single Select';
    display = enabled ? 'Yes' : 'No';
  } else {
    return replyError(message, 'Unknown Setting',
      `${GLYPHS.ERROR} Unknown setting: \`${setting}\`. Valid settings: title, required, singleselect.`);
  }

  await saveOnboarding(message.guild, onboarding, { prompts: mapPrompts(onboarding, promptId, modify) });

  return replySuccess(message, 'Question Updated',
    `${GLYPHS.SUCCESS} Question \`${promptId}\` has been updated.\n\n**${label}** — ${display}`);
}

async function deleteQuestion(message, args, onboarding, prefix) {
  const promptId = args[1];

  if (!promptId) {
    return replyError(message, 'ID Required',
      `${GLYPHS.ERROR} Please provide the question ID to delete, Master.\n\n**Usage:** \`${prefix}onboarding questions delete <id>\``);
  }

  const prompt = onboarding.prompts.get(promptId);
  if (!prompt) {
    return replyError(message, 'Not Found', `${GLYPHS.ERROR} Question with ID \`${promptId}\` not found.`);
  }

  const remaining = onboarding.prompts.filter(p => p.id !== promptId).map(toPromptData);
  await saveOnboarding(message.guild, onboarding, { prompts: remaining });

  return replySuccess(message, 'Question Deleted',
    `${GLYPHS.SUCCESS} Question **"${prompt.title}"** has been deleted.`);
}

// ============================================
// Question options
// ============================================

async function manageOptions(message, args, prefix, onboarding) {
  const promptId = args[0];
  const optionAction = args[1]?.toLowerCase();
  const base = `${prefix}onboarding questions options ${promptId}`;

  if (!promptId) {
    return replyError(message, 'ID Required',
      `${GLYPHS.ERROR} Please provide the question ID, Master.\n\n**Usage:** \`${prefix}onboarding questions options <questionId> <action>\``);
  }

  const prompt = onboarding.prompts.get(promptId);
  if (!prompt) {
    return replyError(message, 'Not Found', `${GLYPHS.ERROR} Question with ID \`${promptId}\` not found.`);
  }

  if (!optionAction || optionAction === 'list') {
    return listOptions(message, prompt, base);
  }

  if (optionAction === 'add' || optionAction === 'create') {
    const title = args.slice(2).join(' ');

    if (!title) {
      return replyError(message, 'Title Required',
        `${GLYPHS.ERROR} Please provide an option title, Master.\n\n**Usage:** \`${base} add <title>\``);
    }

    const existingIds = new Set(prompt.options.keys());
    const updated = await saveOnboarding(message.guild, onboarding, {
      prompts: mapPrompts(onboarding, promptId, data => {
        data.options.push({ title, description: null, emoji: null, channels: [], roles: [] });
      })
    });

    // The new option gets its ID from Discord
    const newOption = updated.prompts.get(promptId)?.options.find(o => !existingIds.has(o.id));
    const newId = newOption?.id || '<optionId>';

    return replySuccess(message, 'Option Added',
      `${GLYPHS.SUCCESS} Option added to **"${prompt.title}"**.\n\n` +
      `**Title:** ${title}\n` +
      `**ID:** \`${newOption?.id || 'Unknown'}\`\n\n` +
      `Use \`${base} role ${newId} @role\` to assign a role.`);
  }

  // The remaining actions all target one existing option
  const optionId = args[2];
  const usage = {
    remove: `${base} remove <optionId>`,
    delete: `${base} remove <optionId>`,
    role: `${base} role <optionId> @role`,
    channel: `${base} channel <optionId> #channel`,
    emoji: `${base} emoji <optionId> <emoji>`,
    desc: `${base} desc <optionId> <description>`,
    description: `${base} desc <optionId> <description>`
  };

  if (!Object.hasOwn(usage, optionAction)) {
    return replyError(message, 'Unknown Action',
      `${GLYPHS.ERROR} Unknown action: \`${optionAction}\`\n\n` +
      `**Valid actions:** list, add, remove, role, channel, emoji, desc`);
  }

  if (!optionId) {
    return replyError(message, 'Option ID Required',
      `${GLYPHS.ERROR} Please provide the option ID, Master.\n\n**Usage:** \`${usage[optionAction]}\``);
  }

  const option = prompt.options.get(optionId);
  if (!option) {
    return replyError(message, 'Not Found',
      `${GLYPHS.ERROR} Option with ID \`${optionId}\` not found in this question.`);
  }

  // Applies `modify` to this option's edit data and saves
  const updateOption = (modify) => saveOnboarding(message.guild, onboarding, {
    prompts: mapPrompts(onboarding, promptId, data => {
      const opt = data.options.find(o => o.id === optionId);
      if (opt) modify(opt);
    })
  });

  switch (optionAction) {
    case 'remove':
    case 'delete': {
      await saveOnboarding(message.guild, onboarding, {
        prompts: mapPrompts(onboarding, promptId, data => {
          data.options = data.options.filter(o => o.id !== optionId);
        })
      });
      return replySuccess(message, 'Option Removed', `${GLYPHS.SUCCESS} Option **"${option.title}"** has been removed.`);
    }

    case 'role':
      return linkOptionRole(message, args, option, base, updateOption);

    case 'channel':
      return linkOptionChannel(message, args, option, base, updateOption);

    case 'emoji': {
      const emojiArg = args[3];
      if (!emojiArg) {
        return replyError(message, 'Usage',
          `${GLYPHS.ERROR} **Usage:** \`${usage.emoji}\`\n\nUse \`none\` to remove the emoji.`);
      }

      let emoji = null;
      if (!isKeyword(emojiArg, ['none', 'remove'])) {
        const custom = emojiArg.match(/<(a?):(\w+):(\d+)>/);
        emoji = custom
          ? { id: custom[3], name: custom[2], animated: custom[1] === 'a' }
          : { id: null, name: emojiArg, animated: false };
      }

      await updateOption(opt => { opt.emoji = emoji; });

      return replySuccess(message, 'Emoji Updated',
        `${GLYPHS.SUCCESS} Emoji for **"${option.title}"** has been ${emoji ? 'updated' : 'removed'}.`);
    }

    default: {
      // desc / description
      const description = args.slice(3).join(' ');
      const remove = !description || isKeyword(description, ['none']);

      await updateOption(opt => {
        opt.description = remove ? null : description.substring(0, OPTION_DESCRIPTION_MAX);
      });

      return replySuccess(message, 'Description Updated',
        `${GLYPHS.SUCCESS} Description for **"${option.title}"** has been ${remove ? 'removed' : 'updated'}.` +
        (!remove && description.length > OPTION_DESCRIPTION_MAX
          ? `\n\nIt was shortened to ${OPTION_DESCRIPTION_MAX} characters, the Discord limit.`
          : ''));
    }
  }
}

async function listOptions(message, prompt, base) {
  const embed = baseEmbed(`Options: ${prompt.title}`);

  if (prompt.options.size === 0) {
    embed.setDescription('*No options configured*');
  } else {
    const optionBlocks = [...prompt.options.values()].map((opt, index) => {
      const roles = opt.roles.size > 0
        ? `\n     Roles: ${[...opt.roles.keys()].map(id => `<@&${id}>`).join(', ')}`
        : '';
      const channels = opt.channels.size > 0
        ? `\n     Channels: ${[...opt.channels.keys()].map(id => `<#${id}>`).join(', ')}`
        : '';
      const emoji = optionEmoji(opt);
      const emojiText = emoji ? `${emoji.name || emoji} ` : '';

      return `**${index + 1}. ${emojiText}${opt.title}**\n` +
        `   ID: \`${opt.id}\`` +
        (opt.description ? `\n   ${opt.description}` : '') +
        roles + channels;
    });

    embed.setDescription(fitLines(optionBlocks, DESCRIPTION_MAX, '\n\n'));
  }

  embed
    .addFields({
      name: '▸ Commands',
      value: [
        `\`${base} add <title>\``,
        `\`${base} remove <optionId>\``,
        `\`${base} role <optionId> @role [remove]\``,
        `\`${base} channel <optionId> #channel [remove]\``,
        `\`${base} emoji <optionId> <emoji>\``,
        `\`${base} desc <optionId> <description>\``
      ].join('\n').slice(0, FIELD_VALUE_MAX)
    })
    .setFooter({ text: `Question ID: ${prompt.id} | ${prompt.options.size} option(s)` });

  return message.reply({ embeds: [embed] });
}

async function linkOptionRole(message, args, option, base, updateOption) {
  const role = message.mentions.roles.first() || message.guild.roles.cache.get(args[3]);
  const remove = isKeyword(args[3], ['remove']) || isKeyword(args[4], ['remove']);
  const optionId = option.id;

  if (!role && !remove) {
    const currentRoles = option.roles.size > 0
      ? [...option.roles.keys()].map(id => `<@&${id}>`).join(', ')
      : '*None*';

    return replyInfo(message, `Roles for "${option.title}"`,
      `**Current Roles:** ${currentRoles}\n\n` +
      `**Add role:** \`${base} role ${optionId} @role\`\n` +
      `**Remove role:** \`${base} role ${optionId} @role remove\``);
  }

  if (!role) {
    return replyError(message, 'Role Required',
      `${GLYPHS.ERROR} Please mention the role to remove, Master.\n\n**Usage:** \`${base} role ${optionId} @role remove\``);
  }

  if (remove) {
    if (!option.roles.has(role.id)) {
      return replyError(message, 'Not Linked', `${GLYPHS.ERROR} ${role} is not linked to option **"${option.title}"**.`);
    }
    await updateOption(opt => { opt.roles = opt.roles.filter(id => id !== role.id); });
    return replySuccess(message, 'Role Removed', `${GLYPHS.SUCCESS} Removed ${role} from option **"${option.title}"**.`);
  }

  // Anyone completing onboarding can pick this option, so the role must be safe to hand out
  const roleError = getAssignableRoleError(role, message.member);
  if (roleError) {
    return replyError(message, 'Role Not Allowed', roleError);
  }

  if (!option.roles.has(role.id)) {
    await updateOption(opt => { opt.roles = [...opt.roles, role.id]; });
  }

  return replySuccess(message, 'Role Added', `${GLYPHS.SUCCESS} Added ${role} to option **"${option.title}"**.`);
}

async function linkOptionChannel(message, args, option, base, updateOption) {
  const channel = message.mentions.channels.first() || message.guild.channels.cache.get(args[3]);
  const remove = isKeyword(args[3], ['remove']) || isKeyword(args[4], ['remove']);
  const optionId = option.id;

  if (!channel && !remove) {
    const currentChannels = option.channels.size > 0
      ? [...option.channels.keys()].map(id => `<#${id}>`).join(', ')
      : '*None*';

    return replyInfo(message, `Channels for "${option.title}"`,
      `**Current Channels:** ${currentChannels}\n\n` +
      `**Add channel:** \`${base} channel ${optionId} #channel\`\n` +
      `**Remove channel:** \`${base} channel ${optionId} #channel remove\``);
  }

  if (!channel) {
    return replyError(message, 'Channel Required',
      `${GLYPHS.ERROR} Please mention the channel to remove, Master.\n\n**Usage:** \`${base} channel ${optionId} #channel remove\``);
  }

  if (remove) {
    if (!option.channels.has(channel.id)) {
      return replyError(message, 'Not Linked', `${GLYPHS.ERROR} ${channel} is not linked to option **"${option.title}"**.`);
    }
    await updateOption(opt => { opt.channels = opt.channels.filter(id => id !== channel.id); });
    return replySuccess(message, 'Channel Removed', `${GLYPHS.SUCCESS} Removed ${channel} from option **"${option.title}"**.`);
  }

  if (!option.channels.has(channel.id)) {
    await updateOption(opt => { opt.channels = [...opt.channels, channel.id]; });
  }

  return replySuccess(message, 'Channel Added', `${GLYPHS.SUCCESS} Added ${channel} to option **"${option.title}"**.`);
}
