import { PermissionFlagsBits, EmbedBuilder } from 'discord.js';
import Economy from '../../models/Economy.js';
import Level from '../../models/Level.js';
import Guild from '../../models/Guild.js';
import ModLog from '../../models/ModLog.js';
import { successEmbed, errorEmbed, infoEmbed, GLYPHS, createEmbed } from '../../utils/embeds.js';
import { getPrefix, hasAdminPerms } from '../../utils/helpers.js';
import { getRandomFooter } from '../../utils/raphael.js';

export default {
  name: 'award',
  description: 'Award or deduct XP, coins, or reputation from a user (Admin only)',
  usage: '<xp|coins|rep> <@user> <amount>',
  category: 'admin',
  aliases: ['give', 'modify'], // no 'take': it can't flip the sign; deduct with a negative amount
  permissions: [PermissionFlagsBits.ManageGuild],
  cooldown: 3,
  examples: [
    'award xp @user 500',
    'award coins @user -100',
    'award rep @user 5',
    'award xp @user -1000'
  ],

  async execute(message, args) {
    const guildId = message.guild.id;
    const prefix = await getPrefix(guildId);
    const guildConfig = await Guild.getGuild(guildId);

    // Admin only: awarding mints currency and XP
    if (!hasAdminPerms(message.member, guildConfig)) {
      return message.reply({
        embeds: [await errorEmbed(guildId, 'Permission Denied',
          'Awards can only be issued by administrators, Master.')]
      });
    }

    // No args - show help
    if (!args[0]) {
      return showHelp(message, prefix);
    }

    const type = args[0].toLowerCase();
    const targetUser = message.mentions.users.first();
    const amount = parseInt(args[2]);

    // Validate type
    if (!['xp', 'coins', 'coin', 'rep', 'reputation', 'money'].includes(type)) {
      return showHelp(message, prefix);
    }

    // Validate user
    if (!targetUser) {
      return message.reply({
        embeds: [await errorEmbed(guildId, 'Target Required',
          `**Notice:** Please specify a subject, Master.\n\nSyntax: \`${prefix}award <type> @user <amount>\``)]
      });
    }
    // Only the server owner may award themselves
    if (targetUser.id === message.author.id && message.author.id !== message.guild.ownerId) {
      return message.reply({
        embeds: [await errorEmbed(guildId, 'Invalid Target', 'You cannot award yourself, Master.')]
      });
    }
    // Check if target is a bot
    if (targetUser.bot) {
      return message.reply({
        embeds: [await errorEmbed(guildId, 'Invalid Target',
          '**Warning:** Automated systems cannot receive awards, Master.')]
      });
    }
    // Validate amount
    if (isNaN(amount) || amount === 0) {
      return message.reply({
        embeds: [await errorEmbed(guildId, 'Invalid Quantity',
          `**Warning:** Please provide a valid quantity (positive to grant, negative to revoke), Master.\n\nSyntax: \`${prefix}award <type> @user <amount>\``)]
      });
    }

    // Limit amount range
    if (Math.abs(amount) > 10000000) {
      return message.reply({
        embeds: [await errorEmbed(guildId, 'Quantity Exceeded',
          '**Warning:** Maximum quantity is 10,000,000 per transaction, Master.')]
      });
    }

    const isAdding = amount > 0;
    const absAmount = Math.abs(amount);

    try {
      let result;
      switch (type) {
        case 'xp':
          result = await handleXP(targetUser, guildId, amount, message.author);
          break;
        case 'coins':
        case 'coin':
        case 'money':
          result = await handleCoins(targetUser, guildId, amount, message.author, guildConfig);
          break;
        case 'rep':
        case 'reputation':
          result = await handleRep(targetUser, guildId, amount, message.author);
          break;
      }

      const actionWord = isAdding ? 'Granted' : 'Revoked';
      const embed = await successEmbed(guildId,
        `${result.typeName} ${actionWord}`,
        `**Confirmed:** Successfully ${isAdding ? 'granted' : 'revoked'} **${absAmount.toLocaleString()}** ${result.emoji} ${result.typeName.toLowerCase()} ${isAdding ? 'to' : 'from'} ${targetUser}, Master.\n\n` +
        `**${targetUser.username}'s New ${result.typeName}:** ${result.newValue.toLocaleString()} ${result.emoji}` +
        (result.levelInfo ? `\n${result.levelInfo}` : '')
      );

      await message.reply({ embeds: [embed] });

      // Send level up announcement if user leveled up
      if (type === 'xp' && result.leveledUp && result.leveledUp.length > 0) {
        await announceLevelUp(message.guild, guildConfig, targetUser, result.levelData, result.leveledUp);
      }

      // Log to mod log channel
      await logAward(message.guild, guildConfig, {
        type: type === 'coins' || type === 'coin' || type === 'money' ? 'coins' : (type === 'rep' || type === 'reputation' ? 'rep' : 'xp'),
        targetUser,
        moderator: message.author,
        amount,
        newValue: result.newValue,
        emoji: result.emoji,
        typeName: result.typeName
      });

      // Try to DM the user
      try {
        const dmEmbed = new EmbedBuilder()
          .setColor(isAdding ? '#00FF00' : '#FF6B6B')
          .setTitle(`${result.emoji} ${result.typeName} ${actionWord}`)
          .setDescription(
            `An administrator in **${message.guild.name}** has ${isAdding ? 'given you' : 'removed'} **${absAmount.toLocaleString()}** ${result.emoji} ${result.typeName.toLowerCase()}.\n\n` +
            `**Your new ${result.typeName.toLowerCase()}:** ${result.newValue.toLocaleString()} ${result.emoji}`
          )
          .setTimestamp();
        await targetUser.send({ embeds: [dmEmbed] });
      } catch {
        // User has DMs disabled
      }

    } catch (error) {
      console.error('Error in award command:', error);
      return message.reply({
        embeds: [await errorEmbed(guildId, 'Error', 'An error occurred while processing the award.')]
      });
    }
  }
};

async function showHelp(message, prefix) {
  const embed = await infoEmbed(message.guild.id,
    '『 Award System 』',
    `Award or deduct XP, coins, or reputation from users.\n\n` +
    `**Usage:**\n` +
    `\`${prefix}award <type> @user <amount>\`\n\n` +
    `**Types:**\n` +
    `${GLYPHS.DOT} \`xp\` - Experience points\n` +
    `${GLYPHS.DOT} \`coins\` - Currency\n` +
    `${GLYPHS.DOT} \`rep\` - Reputation\n\n` +
    `**Examples:**\n` +
    `${GLYPHS.DOT} \`${prefix}award xp @user 500\` - Add 500 XP\n` +
    `${GLYPHS.DOT} \`${prefix}award coins @user -100\` - Remove 100 coins\n` +
    `${GLYPHS.DOT} \`${prefix}award rep @user 5\` - Add 5 reputation\n\n` +
    `**Note:** Use negative numbers to deduct!`
  );
  return message.reply({ embeds: [embed] });
}

async function handleXP(user, guildId, amount, admin) {
  let levelData = await Level.findOne({ userId: user.id, guildId });

  if (!levelData) {
    levelData = new Level({
      userId: user.id,
      guildId,
      username: user.username
    });
  }

  const oldLevel = levelData.level;
  let leveledUp = [];

  // Handle negative XP
  if (amount < 0) {
    const absAmount = Math.abs(amount);
    // Remove from totalXP first
    levelData.totalXP = Math.max(0, levelData.totalXP - absAmount);
    // Remove from current XP
    levelData.xp = Math.max(0, levelData.xp - absAmount);

    // Recalculate level based on totalXP
    let newLevel = 0;
    let xpNeeded = 0;
    let accumulatedXP = 0;

    // Calculate what level they should be at based on totalXP
    while (true) {
      const xpForLevel = Math.floor(100 + (newLevel * 50) + Math.pow(newLevel, 1.5) * 25);
      if (accumulatedXP + xpForLevel > levelData.totalXP) {
        levelData.level = newLevel;
        levelData.xp = levelData.totalXP - accumulatedXP;
        break;
      }
      accumulatedXP += xpForLevel;
      newLevel++;
      if (newLevel > 1000) break; // Safety limit
    }
  } else {
    // Add XP normally
    leveledUp = levelData.addXP(amount) || [];
  }

  levelData.username = user.username;
  await levelData.save();

  return {
    emoji: '✨',
    typeName: 'XP',
    newValue: levelData.totalXP,
    levelInfo: `**Level:** ${levelData.level} • **Current XP:** ${levelData.xp}/${levelData.xpForNextLevel()}`,
    leveledUp,
    levelData
  };
}

async function handleCoins(user, guildId, amount, admin, guildConfig) {
  const economy = await Economy.getEconomy(user.id, guildId);

  if (amount < 0) {
    const absAmount = Math.abs(amount);
    economy.coins = Math.max(0, economy.coins - absAmount);
  } else {
    economy.coins += amount;
    economy.stats.totalEarned = (economy.stats.totalEarned || 0) + amount;
  }

  await economy.save();

  const coinEmoji = guildConfig.economy?.coinEmoji || '💰';

  return {
    emoji: coinEmoji,
    typeName: 'Coins',
    newValue: economy.coins,
    levelInfo: `**Wallet:** ${economy.coins.toLocaleString()}`
  };
}

async function handleRep(user, guildId, amount, admin) {
  const economy = await Economy.getEconomy(user.id, guildId);

  if (amount < 0) {
    economy.reputation = Math.max(0, economy.reputation - Math.abs(amount));
  } else {
    economy.reputation = (economy.reputation || 0) + amount;
  }

  await economy.save();

  return {
    emoji: '⭐',
    typeName: 'Reputation',
    newValue: economy.reputation
  };
}

// Log award action to mod log channel
async function logAward(guild, guildConfig, data) {
  try {
    // Check if mod log channel is configured
    if (!guildConfig?.channels?.modLog) return;

    const modLogChannel = guild.channels.cache.get(guildConfig.channels.modLog);
    if (!modLogChannel) return;

    const isAdding = data.amount > 0;
    const absAmount = Math.abs(data.amount);
    const actionType = `award_${data.type}`;

    // Get next case number
    const caseNumber = await ModLog.getNextCaseNumber(guild.id);

    // Create the log embed
    const embed = await createEmbed(guild.id, isAdding ? 'success' : 'warning');
    embed.setTitle(`${data.emoji} ${isAdding ? 'AWARD' : 'DEDUCT'} | Case #${caseNumber}`)
      .setDescription(`**${data.typeName}** has been ${isAdding ? 'awarded to' : 'deducted from'} a member.`)
      .addFields(
        { name: `${GLYPHS.ARROW_RIGHT} User`, value: `${data.targetUser.tag}\n\`${data.targetUser.id}\``, inline: true },
        { name: `${GLYPHS.ARROW_RIGHT} Moderator`, value: `${data.moderator.tag}`, inline: true },
        { name: `${GLYPHS.ARROW_RIGHT} Amount`, value: `${isAdding ? '+' : '-'}${absAmount.toLocaleString()} ${data.emoji}`, inline: true },
        { name: `${GLYPHS.ARROW_RIGHT} New Total`, value: `${data.newValue.toLocaleString()} ${data.emoji}`, inline: true }
      )
      .setThumbnail(data.targetUser.displayAvatarURL({ dynamic: true }))
      .setTimestamp();

    const logMessage = await modLogChannel.send({ embeds: [embed] });

    // Save to database
    await ModLog.create({
      guildId: guild.id,
      caseNumber,
      action: actionType,
      moderatorId: data.moderator.id,
      moderatorTag: data.moderator.tag,
      targetId: data.targetUser.id,
      targetTag: data.targetUser.tag,
      reason: `${isAdding ? 'Added' : 'Removed'} ${absAmount.toLocaleString()} ${data.typeName.toLowerCase()}`,
      details: {
        type: data.type,
        amount: data.amount,
        newValue: data.newValue
      },
      messageId: logMessage.id,
      channelId: modLogChannel.id
    });

  } catch (error) {
    console.error('Error logging award to mod log:', error);
  }
}

// Announce level up to the level up channel
async function announceLevelUp(guild, guildConfig, user, levelData, leveledUp) {
  try {
    const levelConfig = guildConfig.features?.levelSystem;

    // Check if level up announcements are enabled
    if (levelConfig?.announceLevelUp === false) return;

    const newLevel = Math.max(...leveledUp);

    // Get the level up channel
    const channelId = levelConfig?.levelUpChannel || guildConfig.channels?.levelUpChannel;
    if (!channelId) return;

    const channel = guild.channels.cache.get(channelId);
    if (!channel) return;

    // Build level up message
    let levelUpMessage = levelConfig?.levelUpMessage || '**Confirmed:** {user} has advanced to level {level}, Master.';
    levelUpMessage = levelUpMessage
      .replace(/{user}/g, `<@${user.id}>`)
      .replace(/{username}/g, user.username)
      .replace(/{level}/g, newLevel)
      .replace(/{totalxp}/g, levelData.totalXP.toLocaleString())
      .replace(/{server}/g, guild.name);

    // Create embed
    const embed = new EmbedBuilder()
      .setColor(guildConfig.embedStyle?.color || '#00CED1')
      .setTitle('『 Level Advancement 』')
      .setDescription(levelUpMessage)
      .setThumbnail(user.displayAvatarURL({ extension: 'png', size: 128 }))
      .addFields(
        { name: '▸ New Level', value: `**${newLevel}**`, inline: true },
        { name: '▸ Total XP', value: levelData.totalXP.toLocaleString(), inline: true }
      )
      .setFooter({ text: 'Awarded by admin' })
      .setTimestamp();

    await channel.send({
      content: `<@${user.id}>`,
      embeds: [embed]
    });

  } catch (error) {
    console.error('Error announcing level up:', error);
  }
}

// Export logAward for use in slash command handler
export { logAward, announceLevelUp };
