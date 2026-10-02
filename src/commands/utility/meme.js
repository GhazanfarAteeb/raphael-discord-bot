import { AttachmentBuilder, EmbedBuilder } from 'discord.js';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import '../../utils/fonts.js';
import { getPrefix } from '../../utils/helpers.js';

const memeTemplates = {
  // Meme templates with overlay positions
  spongebob: {
    name: 'Spongebob Chicken',
    url: 'https://i.imgur.com/QvHMEfj.png',
    avatar: { x: 300, y: 120, size: 150 }
  },
  slap: {
    name: 'Slap',
    url: 'https://i.imgur.com/QvHMEfj.png', // You'll need to replace these with actual meme template URLs
    avatar: { x: 200, y: 100, size: 120 }
  },
  drake: {
    name: 'Drake',
    url: 'https://i.imgur.com/QvHMEfj.png',
    avatar: { x: 150, y: 150, size: 180 }
  },
  distracted: {
    name: 'Distracted Boyfriend',
    url: 'https://i.imgur.com/QvHMEfj.png',
    avatar: { x: 250, y: 80, size: 100 }
  },
  emergencymeeting: {
    name: 'Emergency Meeting',
    url: 'https://i.imgur.com/QvHMEfj.png',
    avatar: { x: 220, y: 140, size: 130 }
  },
  headpat: {
    name: 'Head Pat',
    url: 'https://i.imgur.com/QvHMEfj.png',
    avatar: { x: 180, y: 100, size: 110 }
  },
  tradeoffer: {
    name: 'Trade Offer',
    url: 'https://i.imgur.com/QvHMEfj.png',
    avatar: { x: 200, y: 90, size: 120 }
  },
  waddle: {
    name: 'Waddle',
    url: 'https://i.imgur.com/QvHMEfj.png',
    avatar: { x: 190, y: 110, size: 115 }
  },
  communism: {
    name: 'Our Comrade',
    url: 'https://i.imgur.com/QvHMEfj.png',
    avatar: { x: 210, y: 95, size: 125 }
  },
  eject: {
    name: 'Among Us Eject',
    url: 'https://i.imgur.com/QvHMEfj.png',
    avatar: { x: 175, y: 85, size: 105 }
  }
};

export default {
  name: 'meme',
  description: 'Generate memes with user avatars',
  usage: 'meme <template> [@user]',
  aliases: ['memegen', 'makememe'],
  category: 'utility',
  cooldown: 5,

  execute: async (message, args) => {
    if (!args.length) {
      const prefix = await getPrefix(message.guild.id);
      const templateList = Object.keys(memeTemplates).join(', ');
      return message.reply(
        `🎨 **Meme Generator**\n\n` +
        `**Available templates:**\n${templateList}\n\n` +
        `**Usage:** \`${prefix}meme <template> [@user]\`\n` +
        `**Example:** \`${prefix}meme spongebob @user\` or \`${prefix}meme drake\` (uses your avatar)`
      );
    }

    const template = args[0].toLowerCase();
    
    if (!memeTemplates[template]) {
      const templateList = Object.keys(memeTemplates).join(', ');
      return message.reply(`❌ Unknown template: **${template}**\n\n**Available templates:**\n${templateList}`);
    }

    const targetUser = message.mentions.users.first() || message.author;
    const memeData = memeTemplates[template];

    try {
      const msg = await message.reply('🎨 Generating meme...');

      // For now, we'll use a simpler implementation with just avatar overlay
      // You can add actual meme template images later
      const canvas = createCanvas(600, 600);
      const ctx = canvas.getContext('2d');

      // Background
      const gradient = ctx.createLinearGradient(0, 0, 600, 600);
      gradient.addColorStop(0, '#667eea');
      gradient.addColorStop(1, '#764ba2');
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, 600, 600);

      // Load user avatar
      const avatarURL = targetUser.displayAvatarURL({ extension: 'png', size: 512 });
      const avatar = await loadImage(avatarURL);

      // Draw circular avatar
      const centerX = 300;
      const centerY = 300;
      const radius = 150;

      ctx.save();
      ctx.beginPath();
      ctx.arc(centerX, centerY, radius, 0, Math.PI * 2);
      ctx.closePath();
      ctx.clip();
      ctx.drawImage(avatar, centerX - radius, centerY - radius, radius * 2, radius * 2);
      ctx.restore();

      // Border
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 8;
      ctx.beginPath();
      ctx.arc(centerX, centerY, radius, 0, Math.PI * 2);
      ctx.stroke();

      // Meme text
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 40px Arial';
      ctx.textAlign = 'center';
      ctx.strokeStyle = '#000000';
      ctx.lineWidth = 3;
      
      const memeText = memeData.name.toUpperCase();
      ctx.strokeText(memeText, 300, 80);
      ctx.fillText(memeText, 300, 80);

      // Bottom text
      ctx.font = 'bold 30px Arial';
      const bottomText = targetUser.username.toUpperCase();
      ctx.strokeText(bottomText, 300, 550);
      ctx.fillText(bottomText, 300, 550);

      const attachment = new AttachmentBuilder(canvas.toBuffer('image/png'), {
        name: `${template}-meme.png`
      });

      const embed = new EmbedBuilder()
        .setColor('#764ba2')
        .setTitle(`🎭 ${memeData.name} Meme`)
        .setDescription(`Featuring: **${targetUser.username}**`)
        .setImage(`attachment://${template}-meme.png`)
        .setFooter({
          text: `Requested by ${message.author.tag}`,
          iconURL: message.author.displayAvatarURL({ dynamic: true })
        })
        .setTimestamp();

      await msg.edit({ content: null, embeds: [embed], files: [attachment] });

    } catch (error) {
      console.error('Meme generation error:', error);
      return message.reply('❌ Failed to generate meme. Please try again later!');
    }
  }
};
