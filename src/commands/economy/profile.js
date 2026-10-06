import { AttachmentBuilder, EmbedBuilder } from 'discord.js';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import '../../utils/fonts.js';
import Economy from '../../models/Economy.js';
import Level from '../../models/Level.js';
import Guild from '../../models/Guild.js';
import { getCardBackground, loadCardBackground } from '../../utils/backgroundImages.js';
import { DEFAULT_COIN_NAME } from '../../utils/gameConfig.js';
import { errorEmbed, COLORS } from '../../utils/embeds.js';
import { getPrefix, formatNumber } from '../../utils/helpers.js';
import { getRandomFooter } from '../../utils/raphael.js';

// Description block layout: lines stop short of the coins/streak/rep row at the bottom
const DESC_LINE_HEIGHT = 24;
const DESC_BOTTOM_GAP = 22;
const ELLIPSIS = '...';
// Discord's embed field value limit
const MAX_FIELD_VALUE = 1024;

// Helper function to convert hex to rgba
function hexToRgba(hex, opacity) {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (!result) return `rgba(0, 0, 0, ${opacity})`;
  const r = parseInt(result[1], 16);
  const g = parseInt(result[2], 16);
  const b = parseInt(result[3], 16);
  return `rgba(${r}, ${g}, ${b}, ${opacity})`;
}

// Splits a word wider than maxWidth into pieces that fit (by code point, so emoji stay whole)
function breakWord(ctx, word, maxWidth) {
  const pieces = [];
  let current = '';
  for (const char of word) {
    if (current && ctx.measureText(current + char).width > maxWidth) {
      pieces.push(current);
      current = char;
    } else {
      current += char;
    }
  }
  if (current) pieces.push(current);
  return pieces;
}

// Helper function to wrap text; honours line breaks and breaks words too long for one line
function wrapText(ctx, text, maxWidth) {
  const lines = [];

  for (const paragraph of String(text).split(/\r?\n/)) {
    let currentLine = '';

    for (const word of paragraph.split(' ').filter(Boolean)) {
      const testLine = currentLine ? `${currentLine} ${word}` : word;

      if (ctx.measureText(testLine).width <= maxWidth) {
        currentLine = testLine;
        continue;
      }

      if (currentLine) lines.push(currentLine);

      if (ctx.measureText(word).width > maxWidth) {
        const pieces = breakWord(ctx, word, maxWidth);
        lines.push(...pieces.slice(0, -1));
        currentLine = pieces[pieces.length - 1];
      } else {
        currentLine = word;
      }
    }

    if (currentLine) lines.push(currentLine);
  }

  return lines;
}

// Shortens a line until it fits with a trailing ellipsis
function withEllipsis(ctx, line, maxWidth) {
  const chars = Array.from(line);
  while (chars.length > 0 && ctx.measureText(chars.join('') + ELLIPSIS).width > maxWidth) {
    chars.pop();
  }
  return chars.join('').trimEnd() + ELLIPSIS;
}

// The lines to draw: at most maxLines, the last one ellipsized when text was cut
function fitLines(ctx, text, maxWidth, maxLines) {
  const lines = wrapText(ctx, text, maxWidth);
  if (lines.length <= maxLines) return lines;
  const shown = lines.slice(0, maxLines);
  shown[maxLines - 1] = withEllipsis(ctx, shown[maxLines - 1], maxWidth);
  return shown;
}

// Helper function to draw rounded rectangle
function roundedRect(ctx, x, y, width, height, radius) {
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + width - radius, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
  ctx.lineTo(x + width, y + height - radius);
  ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
  ctx.lineTo(x + radius, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}

// Read-only: viewing a profile never creates documents (members or bots). Unsaved model
// instances supply the schema defaults when there is no data yet.
async function loadEconomy(userId, guildId) {
  return (await Economy.findOne({ userId, guildId })) ?? new Economy({ userId, guildId });
}

export default {
  name: 'profile',
  description: 'View your full profile card with bio and description',
  usage: 'profile [@user]',
  category: 'economy',
  aliases: ['prof', 'myprofile', 'fullprofile'],
  cooldown: 5,

  execute: async (message, args) => {
    const targetUser = message.mentions.users.first() || message.author;
    const userId = targetUser.id;
    const guildId = message.guild.id;
    const isSelf = userId === message.author.id;

    try {
      await message.channel.sendTyping();

      const prefix = await getPrefix(guildId);
      const economy = await loadEconomy(userId, guildId);

      // Try to get level data
      let levelData = null;
      let rankText = 'Rank —';
      try {
        levelData = await Level.findOne({ userId, guildId });
        if (levelData) {
          const ahead = await Level.countDocuments({ guildId, totalXP: { $gt: levelData.totalXP || 0 } });
          rankText = `Rank #${ahead + 1}`;
        }
      } catch (e) {
        // Level system might not be set up
      }

      const level = levelData ?? new Level({ userId, guildId });
      const currentLevel = level.level ?? 0;
      const currentXP = level.xp || 0;
      const totalXP = level.totalXP || 0;
      const dailyXP = level.dailyXP || 0;
      const messagesCount = level.messageCount || economy.stats?.messagesCount || 0;
      const neededXP = level.xpForNextLevel();

      const guildConfig = await Guild.getGuild(guildId);
      const coinName = guildConfig.economy?.coinName || DEFAULT_COIN_NAME;

      // Check if user customization is enabled (default: true)
      const customizationEnabled = guildConfig.economy?.profileCustomization?.enabled !== false;

      // Get overlay settings
      // If customization is enabled, use user's overlay; otherwise use server's cardOverlay
      let overlayColor = '#000000';
      let overlayOpacity = 0.5;

      if (customizationEnabled) {
        // Use user's overlay settings
        overlayColor = economy.profile.overlayColor || '#000000';
        overlayOpacity = economy.profile.overlayOpacity ?? 0.5;
      } else {
        // Use server's card overlay settings
        const cardOverlay = guildConfig.economy?.cardOverlay || { color: '#000000', opacity: 0.5 };
        overlayColor = cardOverlay.color || '#000000';
        overlayOpacity = cardOverlay.opacity ?? 0.5;
      }

      // The member's active background, else the server's fallback image, drawn from its
      // stored copy (null: no image, or it can't be loaded, so the card uses a gradient)
      const loadedBg = await loadCardBackground(guildId, getCardBackground(guildConfig, economy.profile.background));

      // Create canvas - taller for profile (rank is ~220, profile is ~420)
      const canvas = createCanvas(900, 420);
      const ctx = canvas.getContext('2d');

      const drawGradientBackground = () => {
        const bgGradient = ctx.createLinearGradient(0, 0, 900, 420);
        bgGradient.addColorStop(0, '#2C2F33');
        bgGradient.addColorStop(1, '#23272A');
        ctx.fillStyle = bgGradient;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
      };

      // Draw background
      if (loadedBg) {
        ctx.drawImage(loadedBg, 0, 0, canvas.width, canvas.height);
        // Add overlay for readability (uses user or guild customization)
        ctx.fillStyle = hexToRgba(overlayColor, overlayOpacity);
        ctx.fillRect(0, 0, canvas.width, canvas.height);
      } else {
        drawGradientBackground();
      }

      // Accent bar at TOP with gradient (same as rank card)
      const accentGradient = ctx.createLinearGradient(0, 0, 900, 0);
      accentGradient.addColorStop(0, '#667eea');
      accentGradient.addColorStop(1, '#764ba2');
      ctx.fillStyle = accentGradient;
      ctx.fillRect(0, 0, canvas.width, 10);

      // ========== RANK CARD SECTION (TOP) ==========

      // Draw avatar with glow (same style as rank card)
      const avatarX = 40;
      const avatarY = 110;
      const avatarSize = 140;

      try {
        const avatarURL = targetUser.displayAvatarURL({ extension: 'png', size: 256 });
        const avatar = await loadImage(avatarURL);

        // Draw circular avatar with glow
        ctx.shadowColor = '#667eea';
        ctx.shadowBlur = 20;
        ctx.save();
        ctx.beginPath();
        ctx.arc(avatarX + avatarSize / 2, avatarY, avatarSize / 2, 0, Math.PI * 2);
        ctx.closePath();
        ctx.clip();
        ctx.drawImage(avatar, avatarX, avatarY - avatarSize / 2, avatarSize, avatarSize);
        ctx.restore();
        ctx.shadowBlur = 0;

        // Avatar border
        ctx.strokeStyle = '#667eea';
        ctx.lineWidth = 5;
        ctx.beginPath();
        ctx.arc(avatarX + avatarSize / 2, avatarY, avatarSize / 2, 0, Math.PI * 2);
        ctx.stroke();
      } catch (error) {
        console.error('[Profile] Error loading avatar:', error);
      }

      // Text area starting position
      const textX = avatarX + avatarSize + 30;
      let textY = 50;

      // Draw username (bold)
      ctx.font = 'bold 32px "Poppins Bold", sans-serif';
      ctx.fillStyle = '#FFFFFF';
      ctx.fillText(targetUser.username, textX, textY);

      textY += 35;

      // Draw Rank
      ctx.font = '18px "Poppins", sans-serif';
      ctx.fillStyle = '#B9BBBE';
      ctx.fillText(rankText, textX, textY);

      textY += 30;

      // Draw Level in accent gradient color
      ctx.font = 'bold 22px "Poppins Bold", sans-serif';
      ctx.fillStyle = '#667eea';
      ctx.fillText(`Level ${currentLevel}`, textX, textY);

      textY += 30;

      // Draw XP text
      ctx.font = '16px "Poppins", sans-serif';
      ctx.fillStyle = '#B9BBBE';
      ctx.fillText(`${formatNumber(currentXP)} / ${formatNumber(neededXP)} XP`, textX, textY);

      textY += 20;

      // Draw XP progress bar
      const barWidth = 500;
      const barHeight = 20;
      const barX = textX;
      const barY = textY;
      const progress = Math.min(currentXP / neededXP, 1);

      // Bar background
      ctx.fillStyle = '#40444b';
      roundedRect(ctx, barX, barY, barWidth, barHeight, 10);
      ctx.fill();

      // Bar progress with gradient
      if (progress > 0) {
        const progressGradient = ctx.createLinearGradient(barX, 0, barX + barWidth, 0);
        progressGradient.addColorStop(0, '#667eea');
        progressGradient.addColorStop(1, '#764ba2');
        ctx.fillStyle = progressGradient;
        roundedRect(ctx, barX, barY, Math.max(barWidth * progress, 20), barHeight, 10);
        ctx.fill();
      }

      textY += 45;

      // Draw level stats (Messages, Total XP, Daily XP) - like rank card
      ctx.font = '14px "Poppins", sans-serif';
      ctx.fillStyle = '#72767D';

      const statsSpacing = 180;
      ctx.fillText(`Messages: ${formatNumber(messagesCount)}`, textX, textY);
      ctx.fillText(`Total XP: ${formatNumber(totalXP)}`, textX + statsSpacing, textY);
      ctx.fillText(`Daily XP: ${formatNumber(dailyXP)}`, textX + statsSpacing * 2, textY);

      // ========== DESCRIPTION SECTION (BOTTOM) ==========

      // Draw separator line with gradient
      const separatorY = 230;
      const sepGradient = ctx.createLinearGradient(30, 0, canvas.width - 30, 0);
      sepGradient.addColorStop(0, '#667eea');
      sepGradient.addColorStop(1, '#764ba2');
      ctx.fillStyle = sepGradient;
      ctx.fillRect(30, separatorY, canvas.width - 60, 3);

      // Description area
      const descStartY = separatorY + 30;
      const descPadding = 40;
      const bottomY = canvas.height - 30;

      // Draw "About Me" label
      ctx.font = 'bold 20px "Poppins Bold", sans-serif';
      ctx.fillStyle = '#667eea';
      ctx.fillText('About Me', descPadding, descStartY);

      // Draw underline for About Me with gradient
      const underlineGradient = ctx.createLinearGradient(descPadding, 0, descPadding + 100, 0);
      underlineGradient.addColorStop(0, '#667eea');
      underlineGradient.addColorStop(1, '#764ba2');
      ctx.fillStyle = underlineGradient;
      ctx.fillRect(descPadding, descStartY + 5, 100, 2);

      // Draw bio/description
      ctx.font = '16px "Poppins", sans-serif';
      ctx.fillStyle = '#DCDDDE';

      const description = economy.profile.description
        || (isSelf ? `No description set. Use ${prefix}setprofile description <text> to add one.` : 'No description set.');
      let descY = descStartY + 35;
      const maxDescLines = Math.max(1, Math.floor((bottomY - DESC_BOTTOM_GAP - descY) / DESC_LINE_HEIGHT) + 1);

      for (const line of fitLines(ctx, description, canvas.width - (descPadding * 2), maxDescLines)) {
        ctx.fillText(line, descPadding, descY);
        descY += DESC_LINE_HEIGHT;
      }

      // Draw economy stats at bottom
      ctx.font = '14px "Poppins", sans-serif';

      // Coins - draw colored dot indicator
      ctx.beginPath();
      ctx.arc(descPadding + 6, bottomY - 5, 6, 0, Math.PI * 2);
      ctx.fillStyle = '#FFD700';
      ctx.fill();
      ctx.fillStyle = '#DCDDDE';
      ctx.fillText(`${formatNumber(economy.coins)} ${coinName}`, descPadding + 20, bottomY);

      // Streak - draw colored dot indicator
      ctx.beginPath();
      ctx.arc(descPadding + 186, bottomY - 5, 6, 0, Math.PI * 2);
      ctx.fillStyle = '#FF6B6B';
      ctx.fill();
      ctx.fillStyle = '#DCDDDE';
      ctx.fillText(`${economy.daily?.streak || 0} day streak`, descPadding + 200, bottomY);

      // Reputation - draw colored dot indicator
      ctx.beginPath();
      ctx.arc(descPadding + 386, bottomY - 5, 6, 0, Math.PI * 2);
      ctx.fillStyle = '#FFC0CB';
      ctx.fill();
      ctx.fillStyle = '#DCDDDE';
      ctx.fillText(`${formatNumber(economy.reputation || 0)} rep`, descPadding + 400, bottomY);

      // Draw badges in top right if enabled
      const badges = economy.inventory?.badges || [];
      if (economy.profile.showBadges !== false && badges.length > 0) {
        const badgeY = 50;
        const badgeSize = 24;
        const badgeSpacing = 32;
        let badgeX = canvas.width - 50;

        for (let i = 0; i < Math.min(badges.length, 5); i++) {
          // Draw badge as a golden circle with star shape
          ctx.beginPath();
          ctx.arc(badgeX, badgeY, badgeSize / 2, 0, Math.PI * 2);
          ctx.fillStyle = '#FFD700';
          ctx.fill();
          ctx.strokeStyle = '#B8860B';
          ctx.lineWidth = 2;
          ctx.stroke();

          // Draw star in center
          ctx.fillStyle = '#FFFFFF';
          ctx.font = 'bold 12px sans-serif';
          ctx.textAlign = 'center';
          ctx.fillText('★', badgeX, badgeY + 4);
          ctx.textAlign = 'left';

          badgeX -= badgeSpacing;
        }
      }

      const attachment = new AttachmentBuilder(canvas.toBuffer('image/png'), { name: 'profile.png' });

      await message.reply({ files: [attachment] });

    } catch (error) {
      console.error('[Profile] Error generating card:', error);

      // Fallback to embed-based profile display
      try {
        const prefix = await getPrefix(guildId);
        const guildConfig = await Guild.getGuild(guildId);
        const coinName = guildConfig.economy?.coinName || DEFAULT_COIN_NAME;
        const economy = await loadEconomy(userId, guildId);
        const description = economy.profile.description || 'No description set.';

        const embed = new EmbedBuilder()
          .setColor(COLORS.RAPHAEL)
          .setAuthor({
            name: targetUser.tag,
            iconURL: targetUser.displayAvatarURL()
          })
          .setTitle(`『 ${economy.profile.title || `${targetUser.username}'s Profile`} 』`)
          .setThumbnail(targetUser.displayAvatarURL({ size: 256 }))
          .setDescription('The profile card could not be rendered, Master. A text summary follows.')
          .addFields(
            {
              name: '▸ Description',
              value: description.length > MAX_FIELD_VALUE ? `${description.slice(0, MAX_FIELD_VALUE - ELLIPSIS.length)}${ELLIPSIS}` : description,
              inline: false
            },
            { name: '▸ Balance', value: `**${formatNumber(economy.coins)}** ${coinName}`, inline: true },
            { name: '▸ Daily Streak', value: `**${economy.daily?.streak || 0}** day${economy.daily?.streak === 1 ? '' : 's'}`, inline: true },
            { name: '▸ Reputation', value: `**${formatNumber(economy.reputation || 0)}**`, inline: true }
          )
          .setFooter({ text: `${getRandomFooter()} | Use ${prefix}setprofile to customize` })
          .setTimestamp();

        await message.reply({ embeds: [embed] });
      } catch (fallbackError) {
        console.error('[Profile] Fallback embed failed:', fallbackError);
        await message.reply({
          embeds: [await errorEmbed(guildId, 'Profile Error', 'An error occurred while generating the profile card. Please try again, Master.')]
        }).catch(() => {});
      }
    }
  }
};
