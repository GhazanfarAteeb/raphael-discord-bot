import { AttachmentBuilder, EmbedBuilder } from 'discord.js';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import '../../utils/fonts.js';
import { getPrefix, escapeMarkdown, truncate } from '../../utils/helpers.js';
import { COLORS, errorEmbed, infoEmbed, warningEmbed } from '../../utils/embeds.js';
import { getRandomFooter } from '../../utils/raphael.js';

// There are no meme template images: the command draws a caption card (the avatar on a
// gradient, captioned with the meme's name). Each entry is only the caption text.
const memeCaptions = {
  spongebob: 'Spongebob Chicken',
  slap: 'Slap',
  drake: 'Drake',
  distracted: 'Distracted Boyfriend',
  emergencymeeting: 'Emergency Meeting',
  headpat: 'Head Pat',
  tradeoffer: 'Trade Offer',
  waddle: 'Waddle',
  communism: 'Our Comrade',
  eject: 'Among Us Eject'
};

const CANVAS_SIZE = 600;
const AVATAR_RADIUS = 150;
// Keep captions inside the card with a margin on both sides
const TEXT_MAX_WIDTH = CANVAS_SIZE - 40;

const captionList = () => Object.keys(memeCaptions).map(key => `\`${key}\``).join(', ');

export default {
  name: 'meme',
  description: 'Generate a captioned meme card from a user avatar',
  usage: 'meme <caption> [@user]',
  aliases: ['memegen', 'makememe'],
  category: 'utility',
  cooldown: 5,

  execute: async (message, args) => {
    const guildId = message.guild.id;

    try {
      if (!args.length) {
        const prefix = await getPrefix(guildId);
        return message.reply({
          embeds: [await infoEmbed(
            guildId,
            'Meme Card Generator',
            '**Analysis:** I render the chosen caption over the avatar on a generated card, Master. ' +
            'The original meme artwork is not used.\n\n' +
            `**Available captions:**\n${captionList()}\n\n` +
            `**Usage:** \`${prefix}meme <caption> [@user]\`\n` +
            `**Example:** \`${prefix}meme spongebob @user\` or \`${prefix}meme drake\` (uses your avatar)`
          )]
        });
      }

      const key = args[0].toLowerCase();

      if (!Object.hasOwn(memeCaptions, key)) {
        return message.reply({
          embeds: [await warningEmbed(
            guildId,
            'Unknown Caption',
            `No caption named \`${truncate(key.replace(/`/g, ''), 100)}\` exists, Master.\n\n**Available captions:**\n${captionList()}`
          )]
        });
      }

      const targetUser = message.mentions.users.first() || message.author;
      const caption = memeCaptions[key];

      await message.channel.sendTyping().catch(() => {});

      const canvas = createCanvas(CANVAS_SIZE, CANVAS_SIZE);
      const ctx = canvas.getContext('2d');

      // Background
      const gradient = ctx.createLinearGradient(0, 0, CANVAS_SIZE, CANVAS_SIZE);
      gradient.addColorStop(0, '#667eea');
      gradient.addColorStop(1, '#764ba2');
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);

      // Load user avatar (static frame, so animated avatars decode too)
      const avatarURL = targetUser.displayAvatarURL({ extension: 'png', size: 512, forceStatic: true });
      const avatar = await loadImage(avatarURL);

      // Draw circular avatar
      const center = CANVAS_SIZE / 2;

      ctx.save();
      ctx.beginPath();
      ctx.arc(center, center, AVATAR_RADIUS, 0, Math.PI * 2);
      ctx.closePath();
      ctx.clip();
      ctx.drawImage(avatar, center - AVATAR_RADIUS, center - AVATAR_RADIUS, AVATAR_RADIUS * 2, AVATAR_RADIUS * 2);
      ctx.restore();

      // Border
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 8;
      ctx.beginPath();
      ctx.arc(center, center, AVATAR_RADIUS, 0, Math.PI * 2);
      ctx.stroke();

      // Caption text (maxWidth squeezes long captions/usernames instead of clipping them)
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 40px Arial';
      ctx.textAlign = 'center';
      ctx.strokeStyle = '#000000';
      ctx.lineWidth = 3;

      const topText = caption.toUpperCase();
      ctx.strokeText(topText, center, 80, TEXT_MAX_WIDTH);
      ctx.fillText(topText, center, 80, TEXT_MAX_WIDTH);

      // Bottom text
      ctx.font = 'bold 30px Arial';
      const bottomText = targetUser.username.toUpperCase();
      ctx.strokeText(bottomText, center, 550, TEXT_MAX_WIDTH);
      ctx.fillText(bottomText, center, 550, TEXT_MAX_WIDTH);

      const fileName = `${key}-meme.png`;
      const attachment = new AttachmentBuilder(canvas.toBuffer('image/png'), { name: fileName });

      const embed = new EmbedBuilder()
        .setColor(COLORS.RAPHAEL)
        .setTitle(`『 ${caption} 』`)
        .setDescription(`**Analysis:** Meme card rendered, Master.\n› Featuring: **${escapeMarkdown(targetUser.username)}**`)
        .setImage(`attachment://${fileName}`)
        .setFooter({ text: getRandomFooter() })
        .setTimestamp();

      return message.reply({ embeds: [embed], files: [attachment] });

    } catch (error) {
      console.error('Meme generation error:', error);
      try {
        await message.reply({
          embeds: [await errorEmbed(guildId, 'Generation Failed', 'The meme card could not be generated, Master. Please try again later.')]
        });
      } catch {
        // Reply failed too (message deleted or no permission); nothing more to do
      }
    }
  }
};
