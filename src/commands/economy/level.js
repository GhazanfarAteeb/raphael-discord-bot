import { AttachmentBuilder } from 'discord.js';
import Level from '../../models/Level.js';
import Economy from '../../models/Economy.js';
import Guild from '../../models/Guild.js';
import { errorEmbed } from '../../utils/embeds.js';
import { formatNumber } from '../../utils/helpers.js';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import '../../utils/fonts.js';
import { getBackground } from '../../utils/shopItems.js';

// Helper function to convert hex to rgba
function hexToRgba(hex, opacity) {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (!result) return `rgba(0, 0, 0, ${opacity})`;
  const r = parseInt(result[1], 16);
  const g = parseInt(result[2], 16);
  const b = parseInt(result[3], 16);
  return `rgba(${r}, ${g}, ${b}, ${opacity})`;
}

export default {
  name: 'level',
  aliases: ['lvl', 'rank', 'xp', 'card', 'me'],
  description: 'Generate progression status visualization, Master',
  usage: 'level [@user]',
  category: 'economy',
  cooldown: 5,

  async execute(message, args) {
    const guildId = message.guild.id;
    const targetUser = message.mentions.users.first() || message.author;

    try {
      await message.channel.sendTyping();

      // Read-only: viewing a card never creates Level/Economy documents (members or bots);
      // unsaved model instances supply the schema defaults when there is no data yet
      const levelData = await Level.findOne({ userId: targetUser.id, guildId });
      const level = levelData ?? new Level({ userId: targetUser.id, guildId });

      // Get economy for profile settings (background)
      const economy = (await Economy.findOne({ userId: targetUser.id, guildId }))
        ?? new Economy({ userId: targetUser.id, guildId });

      // Get guild config for fallback background
      const guildConfig = await Guild.getGuild(guildId);
      const fallbackBg = guildConfig.economy?.fallbackBackground;

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

      // Get background - check user's background, then custom shop items, then fallback
      let background = getBackground(economy.profile.background || 'default');

      // If user has a custom background from shop, find it in custom items
      if (!background || !background.image) {
        const customBg = (guildConfig.customShopItems || []).find(
          item => item.type === 'background' && item.id === economy.profile.background
        );
        if (customBg) {
          background = {
            id: customBg.id,
            name: customBg.name,
            image: customBg.image || '',
            color: customBg.color || '#2C2F33'
          };
        }
      }

      // Use fallback if no image
      const bgImage = background?.image || fallbackBg?.image || '';

      // Rank by total XP; members without level data are unranked
      const rankText = levelData
        ? `Rank #${(await Level.countDocuments({ guildId, totalXP: { $gt: levelData.totalXP || 0 } })) + 1}`
        : 'Rank —';

      // Create rank card
      const canvas = createCanvas(900, 300);
      const ctx = canvas.getContext('2d');

      // Draw background
      if (bgImage) {
        try {
          const loadedBg = await loadImage(bgImage).catch(() => null);
          if (loadedBg) {
            ctx.drawImage(loadedBg, 0, 0, canvas.width, canvas.height);
            // Add overlay for readability (uses user or guild customization)
            ctx.fillStyle = hexToRgba(overlayColor, overlayOpacity);
            ctx.fillRect(0, 0, canvas.width, canvas.height);
          } else {
            // Background gradient fallback
            const gradient = ctx.createLinearGradient(0, 0, 900, 300);
            gradient.addColorStop(0, '#2C2F33');
            gradient.addColorStop(1, '#23272A');
            ctx.fillStyle = gradient;
            ctx.fillRect(0, 0, 900, 300);
          }
        } catch {
          // Background gradient fallback
          const gradient = ctx.createLinearGradient(0, 0, 900, 300);
          gradient.addColorStop(0, '#2C2F33');
          gradient.addColorStop(1, '#23272A');
          ctx.fillStyle = gradient;
          ctx.fillRect(0, 0, 900, 300);
        }
      } else {
        // Background gradient
        const gradient = ctx.createLinearGradient(0, 0, 900, 300);
        gradient.addColorStop(0, '#2C2F33');
        gradient.addColorStop(1, '#23272A');
        ctx.fillStyle = gradient;
        ctx.fillRect(0, 0, 900, 300);
      }

      // Accent bar at TOP with gradient
      const accentGradient = ctx.createLinearGradient(0, 0, 900, 0);
      accentGradient.addColorStop(0, '#667eea');
      accentGradient.addColorStop(1, '#764ba2');
      ctx.fillStyle = accentGradient;
      ctx.fillRect(0, 0, 900, 10);

      // Load and draw avatar
      try {
        const avatarURL = targetUser.displayAvatarURL({ extension: 'png', size: 256 });
        const avatar = await loadImage(avatarURL);

        // Draw circular avatar with glow
        ctx.shadowColor = '#667eea';
        ctx.shadowBlur = 20;
        ctx.save();
        ctx.beginPath();
        ctx.arc(120, 150, 70, 0, Math.PI * 2);
        ctx.closePath();
        ctx.clip();
        ctx.drawImage(avatar, 50, 80, 140, 140);
        ctx.restore();
        ctx.shadowBlur = 0;

        // Avatar border
        ctx.strokeStyle = '#667eea';
        ctx.lineWidth = 5;
        ctx.beginPath();
        ctx.arc(120, 150, 70, 0, Math.PI * 2);
        ctx.stroke();
      } catch (error) {
        console.error('Error loading avatar:', error);
      }

      // Username
      ctx.font = 'bold 36px "Poppins Bold", Arial';
      ctx.fillStyle = '#ffffff';
      ctx.textAlign = 'left';
      ctx.fillText(targetUser.username, 230, 90);

      // Rank and Level
      ctx.font = 'bold 24px "Poppins Bold", Arial';
      ctx.fillStyle = '#b9bbbe';
      ctx.fillText(rankText, 230, 130);
      ctx.fillText(`Level ${level.level}`, 230, 165);

      // XP Progress
      const xpForNext = level.xpForNextLevel();
      ctx.font = '20px "Poppins", Arial';
      ctx.fillStyle = '#b9bbbe';
      ctx.fillText(`${formatNumber(level.xp)} / ${formatNumber(xpForNext)} XP`, 230, 200);

      // Progress bar background
      ctx.fillStyle = '#40444b';
      ctx.beginPath();
      ctx.roundRect(230, 215, 620, 35, 17.5);
      ctx.fill();

      // Progress bar fill with gradient
      const progress = Math.min(level.xp / xpForNext, 1);
      if (progress > 0) {
        const progressGradient = ctx.createLinearGradient(230, 0, 850, 0);
        progressGradient.addColorStop(0, '#667eea');
        progressGradient.addColorStop(1, '#764ba2');
        ctx.fillStyle = progressGradient;
        ctx.beginPath();
        ctx.roundRect(230, 215, Math.max(620 * progress, 35), 35, 17.5);
        ctx.fill();
      }

      // Stats at bottom
      ctx.font = '18px "Poppins", Arial';
      ctx.fillStyle = '#72767d';
      ctx.fillText(`Messages: ${formatNumber(level.messageCount || 0)}`, 230, 280);
      ctx.fillText(`Total XP: ${formatNumber(level.totalXP || 0)}`, 450, 280);
      ctx.fillText(`Daily XP: ${formatNumber(level.dailyXP || 0)}`, 670, 280);

      // Create attachment
      const attachment = new AttachmentBuilder(canvas.toBuffer('image/png'), {
        name: 'rank.png'
      });

      await message.reply({ files: [attachment] });

    } catch (error) {
      console.error('[Level] Error creating rank card:', error);
      return message.reply({
        embeds: [await errorEmbed(guildId, 'Rank Card Error', 'The rank card could not be generated, Master. Please try again later.')]
      }).catch(() => {});
    }
  }
};
