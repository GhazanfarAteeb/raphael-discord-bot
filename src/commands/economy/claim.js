import { EmbedBuilder } from 'discord.js';
import Economy from '../../models/Economy.js';
import Guild from '../../models/Guild.js';
import { DEFAULT_COIN_NAME } from '../../utils/gameConfig.js';
import { errorEmbed, COLORS } from '../../utils/embeds.js';
import { getPrefix, formatNumber } from '../../utils/helpers.js';
import { getRandomFooter } from '../../utils/raphael.js';

// Define timed rewards here (can be configured per server later)
const TIMED_REWARDS = {
  hourly: {
    name: 'Hourly Reward',
    interval: 60, // minutes
    amount: 100,
    description: 'Claim every hour'
  },
  work: {
    name: 'Work',
    interval: 30,
    amount: 150,
    description: 'Do some work and earn coins'
  },
  bonus: {
    name: 'Bonus',
    interval: 120, // 2 hours
    amount: 300,
    description: 'Special bonus reward'
  }
};

const isReward = (key) => typeof key === 'string' && Object.hasOwn(TIMED_REWARDS, key);

const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// The name the command was invoked with (e.g. "work" for "!work"), matching the dispatcher:
// the guild prefix (case-insensitive) or a mention of the bot, then the first word, lowercased
function getInvokedName(message, prefix) {
  const prefixPattern = new RegExp(`^(<@!?${message.client.user.id}>|${escapeRegex(prefix)})\\s*`, 'i');
  const match = message.content.match(prefixPattern);
  if (!match) return null;
  return message.content.slice(match[0].length).trim().split(/\s+/)[0]?.toLowerCase() || null;
}

function formatInterval(minutes) {
  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    return `${hours} hour${hours === 1 ? '' : 's'}`;
  }
  return `${minutes} minute${minutes === 1 ? '' : 's'}`;
}

export default {
  name: 'claim',
  description: 'Claim timed rewards',
  usage: 'claim <hourly/work/bonus>',
  category: 'economy',
  aliases: ['hourly', 'work', 'bonus'],
  cooldown: 3,

  execute: async (message, args) => {
    const userId = message.author.id;
    const guildId = message.guild.id;

    try {
      const prefix = await getPrefix(guildId);
      const guildConfig = await Guild.getGuild(guildId);
      const coinName = guildConfig.economy?.coinName || DEFAULT_COIN_NAME;

      // "!work" claims work directly; "!claim work" names the reward as an argument
      const invokedName = getInvokedName(message, prefix);
      const rewardType = isReward(invokedName) ? invokedName : args[0]?.toLowerCase();

      if (!isReward(rewardType)) {
        const availableRewards = Object.entries(TIMED_REWARDS)
          .map(([key, reward]) =>
            `**${reward.name}** — ${reward.description}\n` +
            `◇ Reward: **${formatNumber(reward.amount)}** ${coinName}\n` +
            `◇ Cooldown: **${formatInterval(reward.interval)}**\n` +
            `◇ Command: \`${prefix}claim ${key}\` or \`${prefix}${key}\``
          )
          .join('\n\n');

        const embed = new EmbedBuilder()
          .setColor(COLORS.RAPHAEL)
          .setTitle('『 Temporal Rewards 』')
          .setDescription('**Answer:** Available reward protocols, Master.\n\n' + availableRewards)
          .setFooter({ text: getRandomFooter() })
          .setTimestamp();

        return message.reply({ embeds: [embed] });
      }

      const reward = TIMED_REWARDS[rewardType];
      const economy = await Economy.getEconomy(userId, guildId);

      let amount;
      try {
        amount = await economy.claimTimed(rewardType, reward.interval, reward.amount, `${reward.name} reward`);
      } catch (error) {
        if (error.code !== 'COOLDOWN') throw error;

        const embed = new EmbedBuilder()
          .setColor(COLORS.RAPHAEL_WARNING)
          .setTitle('『 Temporal Restriction 』')
          .setDescription(
            `The **${reward.name}** protocol is recharging, Master.\n\n` +
            `▸ **Available:** <t:${Math.floor(error.availableAt.getTime() / 1000)}:R>`
          )
          .setFooter({ text: getRandomFooter() })
          .setTimestamp();

        return message.reply({ embeds: [embed] });
      }

      const rewardData = economy.timedRewards.find(r => r.commandName === rewardType);
      const nextClaim = Math.floor((Date.now() + reward.interval * 60 * 1000) / 1000);

      const embed = new EmbedBuilder()
        .setColor(COLORS.RAPHAEL_SUCCESS)
        .setAuthor({
          name: message.author.tag,
          iconURL: message.author.displayAvatarURL()
        })
        .setTitle(`『 ${reward.name} Acquired 』`)
        .setDescription(`**Confirmed:** You have earned **${formatNumber(amount)}** ${coinName}, Master.`)
        .addFields(
          { name: '▸ Updated Balance', value: `**${formatNumber(economy.coins)}** ${coinName}`, inline: true },
          { name: '▸ Times Claimed', value: `**${formatNumber(rewardData?.claimCount ?? 1)}**`, inline: true },
          { name: '▸ Next Claim', value: `<t:${nextClaim}:R>`, inline: true }
        )
        .setFooter({ text: getRandomFooter() })
        .setTimestamp();

      await message.reply({ embeds: [embed] });

    } catch (error) {
      console.error('[Claim] Error:', error);
      return message.reply({
        embeds: [await errorEmbed(guildId, 'Claim Error', 'An anomaly occurred while processing your claim, Master.')]
      }).catch(() => {});
    }
  }
};
