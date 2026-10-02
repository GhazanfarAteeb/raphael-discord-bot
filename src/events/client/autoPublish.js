import Guild from '../../models/Guild.js';
import { ChannelType } from 'discord.js';

// Discord error code for a message that has already been crossposted
const ALREADY_CROSSPOSTED = 40033;

export default {
  name: 'messageCreate',

  async execute(message, client) {
    // Ignore bots
    if (message.author.bot) return;

    // Only handle announcement channels
    if (!message.guild || message.channel.type !== ChannelType.GuildAnnouncement) return;

    try {
      const guildConfig = await Guild.getGuild(message.guild.id);

      // Check if auto-publish is enabled and this channel is in the list
      if (!guildConfig?.autoPublish?.enabled) return;
      if (!guildConfig.autoPublish.channels?.includes(message.channel.id)) return;

      // Check if message can be published (not already published)
      if (message.crosspostable) {
        await message.crosspost();
        console.log(`[AutoPublish] Published message ${message.id} in ${message.guild.name}`);
      }

    } catch (error) {
      // Common errors: Missing permissions, rate limited, already published
      if (error.code === ALREADY_CROSSPOSTED) return;
      console.error('[AutoPublish] Error:', error.message);
    }
  }
};
