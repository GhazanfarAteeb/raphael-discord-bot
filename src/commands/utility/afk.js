import Afk from '../../models/Afk.js';
import { successEmbed, infoEmbed, errorEmbed, GLYPHS } from '../../utils/embeds.js';
import { getPrefix, parseDuration } from '../../utils/helpers.js';
import {
  AFK_NICKNAME_TAG,
  addAwayLinks,
  restoreAfkNickname,
  sendAfkReturnSummary,
  splitAwayReason,
  truncate
} from '../../events/client/afkHandler.js';

// `afk off` (alone) clears the status; `afk off to lunch` is still a reason
const OFF_KEYWORDS = ['off', 'remove', 'clear'];
const MAX_SCHEDULED_RETURN = 365 * 24 * 60 * 60 * 1000;
const NICKNAME_LIMIT = 32;
const MAX_REASON_DISPLAY = 1500;

export default {
  name: 'afk',
  category: 'utility',
  description: 'Configure away-from-keyboard status with optional parameters, Master',
  usage: '[reason] [--time <duration>] [--sticky] | off',
  aliases: ['away', 'brb'],
  cooldown: 5,

  async execute(message, args) {
    try {
      if (args.length === 1 && OFF_KEYWORDS.includes(args[0].toLowerCase())) {
        return await clearAfk(message);
      }

      return await setAfk(message, args);
    } catch (error) {
      console.error('[AFK] Command error:', error);
      try {
        await message.reply({
          embeds: [await errorEmbed(message.guild.id, 'Away Status Error',
            'The away status could not be updated, Master. Please try again shortly.')]
        });
      } catch {
        // Reply failed as well (message deleted or database unavailable)
      }
    }
  }
};

async function setAfk(message, args) {
  const guildId = message.guild.id;
  const prefix = await getPrefix(guildId);

  // Parse options
  const options = {
    autoRemove: true,
    scheduledReturn: null
  };

  // Filter out flags
  const reasonArgs = [];
  for (let i = 0; i < args.length; i++) {
    const flag = args[i].toLowerCase();

    if (flag === '--time' || flag === '-t') {
      const value = args[i + 1];
      const ms = value ? parseDuration(value.toLowerCase()) : 0;

      if (!ms || ms > MAX_SCHEDULED_RETURN) {
        return message.reply({
          embeds: [await errorEmbed(guildId, 'Invalid Duration',
            `**Notice:** \`--time\` requires a duration between 1 second and 365 days, Master. ` +
            `Valid formats: \`30m\`, \`2h\`, \`1d\`, \`1h30m\`.\n\n` +
            `Example: \`${prefix}afk lunch --time 1h\``)]
        });
      }

      options.scheduledReturn = new Date(Date.now() + ms);
      i++;
      continue;
    }

    if (flag === '--sticky' || flag === '-s') {
      options.autoRemove = false;
      continue;
    }

    reasonArgs.push(args[i]);
  }

  const reason = reasonArgs.join(' ') || 'AFK';

  // Re-running the command while away updates the status but keeps its start time and mentions
  const existing = await Afk.getAfk(guildId, message.author.id);
  const keepHistory = Boolean(existing) && !existing.isExpired();

  // Remember the real nickname (null = none) so it can be restored on return
  const currentNickname = message.member.nickname;
  let originalNickname = currentNickname ?? null;
  if (currentNickname?.startsWith(AFK_NICKNAME_TAG)) {
    originalNickname = existing
      ? existing.originalNickname ?? null
      : currentNickname.slice(AFK_NICKNAME_TAG.length).trim() || null;
  }

  // Set AFK status
  await Afk.setAfk(guildId, message.author.id, reason, {
    ...options,
    originalNickname,
    keepHistory
  });

  // Build response
  const { text, links } = splitAwayReason(reason);

  const lines = [
    keepHistory
      ? `**Notice:** ${message.author}, your away status has been updated, Master.`
      : `**Notice:** ${message.author} has entered away status, Master.`,
    '',
    `${GLYPHS.ARROW_RIGHT} **Reason:** ${text ? truncate(text, MAX_REASON_DISPLAY) : 'See the links below.'}`
  ];

  if (options.scheduledReturn) {
    lines.push(`${GLYPHS.ARROW_RIGHT} **Scheduled Return:** <t:${Math.floor(options.scheduledReturn.getTime() / 1000)}:R>`);
  }

  lines.push(options.autoRemove
    ? `${GLYPHS.ARROW_RIGHT} **Return:** Your next message clears this status, or use \`${prefix}afk off\`.`
    : `${GLYPHS.ARROW_RIGHT} **Sticky Mode:** Active. Use \`${prefix}afk off\` to deactivate.`);

  const embed = await successEmbed(guildId,
    keepHistory ? 'Away Status Updated' : 'Away Status Active',
    lines.join('\n'));

  if (links.length > 0) {
    embed.setAuthor({
      name: truncate(message.author.username, 256),
      iconURL: message.author.displayAvatarURL()
    });
    addAwayLinks(embed, links);
  }

  await message.reply({ embeds: [embed] });

  await applyAfkNickname(message.member);
}

async function clearAfk(message) {
  const guildId = message.guild.id;
  const removed = await Afk.removeAfk(guildId, message.author.id);

  if (!removed) {
    // Strip a leftover tag, if any, even though no status is stored
    await restoreAfkNickname(message.member);

    return message.reply({
      embeds: [await infoEmbed(guildId, 'Away Status',
        `${GLYPHS.INFO} You are not currently marked as away, Master. No changes were made.`)]
    });
  }

  await restoreAfkNickname(message.member, removed);
  await sendAfkReturnSummary(message, removed, { manual: true });
}

async function applyAfkNickname(member) {
  try {
    if (!member?.manageable || member.displayName.startsWith(AFK_NICKNAME_TAG)) return;

    const base = member.displayName.slice(0, NICKNAME_LIMIT - AFK_NICKNAME_TAG.length - 1);
    await member.setNickname(`${AFK_NICKNAME_TAG} ${base}`, 'Away status set');
  } catch {
    // Can't change nickname, that's fine
  }
}
