import { PermissionFlagsBits, EmbedBuilder, ChannelType } from 'discord.js';
import Guild from '../../models/Guild.js';
import BoosterRole from '../../models/BoosterRole.js';
import { successEmbed, errorEmbed, infoEmbed, GLYPHS } from '../../utils/embeds.js';
import { hasModPerms, getPrefix, getAssignableRoleError } from '../../utils/helpers.js';
import { parseBoostMessage, buildBoostEmbed } from '../../events/client/boostHandler.js';

export default {
  name: 'boost',
  description: 'Configure server boost appreciation protocols, Master',
  usage: '<enable|disable|channel|message|embed|test|...>',
  aliases: ['boostmsg', 'boostthanks', 'serverboost'],
  permissions: [PermissionFlagsBits.ManageGuild],
  cooldown: 3,

  async execute(message, args) {
    const guildConfig = await Guild.getGuild(message.guild.id, message.guild.name);
    const prefix = await getPrefix(message.guild.id);

    // Check for moderator permissions
    if (!hasModPerms(message.member, guildConfig)) {
      return message.reply({
        embeds: [await errorEmbed(message.guild.id, 'Permission Denied',
          `${GLYPHS.LOCK} You need Moderator/Staff permissions to configure boost messages.`)]
      });
    }

    if (!args[0]) {
      return showStatus(message, guildConfig, prefix);
    }

    const action = args[0].toLowerCase();

    switch (action) {
      case 'channel':
        const channel = message.mentions.channels.first() ||
          message.guild.channels.cache.get(args[1]);

        if (!channel) {
          return message.reply({
            embeds: [await errorEmbed(message.guild.id, 'No Channel',
              'Please mention a channel or provide a channel ID.')]
          });
        }

        if (channel.type !== ChannelType.GuildText) {
          return message.reply({
            embeds: [await errorEmbed(message.guild.id, 'Invalid Channel',
              'Please select a text channel.')]
          });
        }

        await Guild.updateGuild(message.guild.id, {
          $set: { 'features.boostSystem.channel': channel.id }
        });

        return message.reply({
          embeds: [await successEmbed(message.guild.id, 'Boost Channel Set',
            `${GLYPHS.SUCCESS} Boost thank you messages will be sent to ${channel}`)]
        });

      case 'message':
      case 'msg':
      case 'description':
      case 'desc':
        const boostMsg = args.slice(1).join(' ');

        if (!boostMsg) {
          const currentMsg = guildConfig.features?.boostSystem?.message || 'Thank you {user} for boosting {server}! 🎉';
          return message.reply({
            embeds: [await infoEmbed(message.guild.id, 'Boost Message Variables',
              `**Current Message:**\n${currentMsg}\n\n` +
              `**Available Variables:**\n` +
              `${GLYPHS.DOT} \`{user}\` - Mentions the user\n` +
              `${GLYPHS.DOT} \`{username}\` - User's username\n` +
              `${GLYPHS.DOT} \`{displayname}\` - User's display name\n` +
              `${GLYPHS.DOT} \`{tag}\` - User's tag\n` +
              `${GLYPHS.DOT} \`{id}\` - User's ID\n` +
              `${GLYPHS.DOT} \`{server}\` - Server name\n` +
              `${GLYPHS.DOT} \`{membercount}\` - Total member count\n` +
              `${GLYPHS.DOT} \`{boostcount}\` - Total boost count\n` +
              `${GLYPHS.DOT} \`{boostlevel}\` - Server boost level\n` +
              `${GLYPHS.DOT} \`{avatar}\` - User's avatar URL\n` +
              `${GLYPHS.DOT} \`\\n\` - New line\n\n` +
              `**Example:**\n\`${prefix}boost message 💎 Thank you {user} for boosting!\\nWe now have {boostcount} boosts!\``)]
          });
        }

        await Guild.updateGuild(message.guild.id, {
          $set: { 'features.boostSystem.message': boostMsg }
        });

        return message.reply({
          embeds: [await successEmbed(message.guild.id, 'Boost Message Set',
            `${GLYPHS.SUCCESS} Boost message has been updated.\n\n` +
            `**Preview:**\n${parseBoostMessage(boostMsg, message.member)}`)]
        });

      case 'embed':
        const embedOption = args[1]?.toLowerCase();

        if (!['on', 'off', 'enable', 'disable'].includes(embedOption)) {
          return message.reply({
            embeds: [await errorEmbed(message.guild.id, 'Invalid Option',
              `Use \`${prefix}boost embed on\` or \`${prefix}boost embed off\``)]
          });
        }

        const embedEnabled = ['on', 'enable'].includes(embedOption);
        await Guild.updateGuild(message.guild.id, {
          $set: { 'features.boostSystem.embedEnabled': embedEnabled }
        });

        return message.reply({
          embeds: [await successEmbed(message.guild.id, 'Embed Setting Updated',
            `${GLYPHS.SUCCESS} Boost embeds are now **${embedEnabled ? 'enabled' : 'disabled'}**`)]
        });

      case 'test':
        return sendTestBoost(message, guildConfig, prefix);

      case 'image':
      case 'banner':
        const imageUrl = args[1];

        if (!imageUrl) {
          const currentBanner = guildConfig.features?.boostSystem?.bannerUrl;
          return message.reply({
            embeds: [await infoEmbed(message.guild.id, 'Boost Banner',
              currentBanner
                ? `**Current Banner:**\n${currentBanner}`
                : `No banner set. Use \`${prefix}boost image <url>\` to set one, or \`${prefix}boost image remove\` to remove.`)]
          });
        }

        if (imageUrl === 'remove' || imageUrl === 'none') {
          await Guild.updateGuild(message.guild.id, {
            $set: { 'features.boostSystem.bannerUrl': null }
          });
          return message.reply({
            embeds: [await successEmbed(message.guild.id, 'Banner Removed',
              `${GLYPHS.SUCCESS} Boost banner has been removed.`)]
          });
        }

        if (!imageUrl.match(/^https?:\/\/.+/i)) {
          return message.reply({
            embeds: [await errorEmbed(message.guild.id, 'Invalid URL',
              'Please provide a valid image URL starting with http:// or https://')]
          });
        }

        await Guild.updateGuild(message.guild.id, {
          $set: { 'features.boostSystem.bannerUrl': imageUrl }
        });

        return message.reply({
          embeds: [await successEmbed(message.guild.id, 'Banner Set',
            `${GLYPHS.SUCCESS} Boost banner has been set.`)]
        });

      case 'thumbnail':
      case 'thumb':
        const thumbUrl = args[1];

        if (!thumbUrl) {
          return message.reply({
            embeds: [await infoEmbed(message.guild.id, 'Boost Thumbnail',
              guildConfig.features?.boostSystem?.thumbnailUrl
                ? `**Current Thumbnail:**\n${guildConfig.features.boostSystem.thumbnailUrl}`
                : 'No custom thumbnail set.\n\n' +
                `\`${prefix}boost thumbnail <url>\` - Set custom thumbnail\n` +
                `\`${prefix}boost thumbnail avatar\` - Use user's avatar\n` +
                `\`${prefix}boost thumbnail server\` - Use server icon\n` +
                `\`${prefix}boost thumbnail remove\` - Remove thumbnail`)]
          });
        }

        if (thumbUrl === 'remove' || thumbUrl === 'none' || thumbUrl === 'off') {
          await Guild.updateGuild(message.guild.id, {
            $set: { 'features.boostSystem.thumbnailUrl': null, 'features.boostSystem.thumbnailType': null }
          });
          return message.reply({
            embeds: [await successEmbed(message.guild.id, 'Thumbnail Removed',
              `${GLYPHS.SUCCESS} Boost thumbnail has been removed.`)]
          });
        }

        if (thumbUrl === 'avatar' || thumbUrl === 'user') {
          await Guild.updateGuild(message.guild.id, {
            $set: { 'features.boostSystem.thumbnailType': 'avatar', 'features.boostSystem.thumbnailUrl': null }
          });
          return message.reply({
            embeds: [await successEmbed(message.guild.id, 'Thumbnail Set',
              `${GLYPHS.SUCCESS} Thumbnail will show the user's avatar.`)]
          });
        }

        if (thumbUrl === 'server' || thumbUrl === 'guild') {
          await Guild.updateGuild(message.guild.id, {
            $set: { 'features.boostSystem.thumbnailType': 'server', 'features.boostSystem.thumbnailUrl': null }
          });
          return message.reply({
            embeds: [await successEmbed(message.guild.id, 'Thumbnail Set',
              `${GLYPHS.SUCCESS} Thumbnail will show the server icon.`)]
          });
        }

        if (!thumbUrl.match(/^https?:\/\/.+/i)) {
          return message.reply({
            embeds: [await errorEmbed(message.guild.id, 'Invalid URL',
              'Please provide a valid URL, or use `avatar`, `server`, or `remove`.')]
          });
        }

        await Guild.updateGuild(message.guild.id, {
          $set: { 'features.boostSystem.thumbnailUrl': thumbUrl, 'features.boostSystem.thumbnailType': 'custom' }
        });

        return message.reply({
          embeds: [await successEmbed(message.guild.id, 'Thumbnail Set',
            `${GLYPHS.SUCCESS} Boost thumbnail has been set.`)]
        });

      case 'title':
        const titleText = args.slice(1).join(' ');

        if (!titleText) {
          return message.reply({
            embeds: [await infoEmbed(message.guild.id, 'Embed Title',
              `**Current Title:**\n${guildConfig.features?.boostSystem?.embedTitle || 'Default decorative style'}\n\n` +
              `Use \`${prefix}boost title <text>\` to set a custom title.\n` +
              `Use \`${prefix}boost title reset\` for default style.\n` +
              `Use \`${prefix}boost title none\` to remove title entirely.\n\n` +
              `**Variables:** {username}, {server}, {boostcount}`)]
          });
        }

        if (titleText === 'reset' || titleText === 'default') {
          await Guild.updateGuild(message.guild.id, {
            $set: { 'features.boostSystem.embedTitle': null }
          });
          return message.reply({
            embeds: [await successEmbed(message.guild.id, 'Title Reset',
              `${GLYPHS.SUCCESS} Boost embed title reset to default decorative style.`)]
          });
        }

        if (titleText === 'none' || titleText === 'remove') {
          await Guild.updateGuild(message.guild.id, {
            $set: { 'features.boostSystem.embedTitle': ' ' }
          });
          return message.reply({
            embeds: [await successEmbed(message.guild.id, 'Title Removed',
              `${GLYPHS.SUCCESS} Boost embed title has been removed.`)]
          });
        }

        await Guild.updateGuild(message.guild.id, {
          $set: { 'features.boostSystem.embedTitle': titleText }
        });

        return message.reply({
          embeds: [await successEmbed(message.guild.id, 'Title Set',
            `${GLYPHS.SUCCESS} Boost embed title set to: ${titleText}`)]
        });

      case 'footer':
        const footerText = args.slice(1).join(' ');

        if (!footerText) {
          return message.reply({
            embeds: [await infoEmbed(message.guild.id, 'Embed Footer',
              `**Current Footer:**\n${guildConfig.features?.boostSystem?.footerText || 'Boost #X (default)'}\n\n` +
              `Use \`${prefix}boost footer <text>\` to set a custom footer.\n` +
              `Use \`${prefix}boost footer reset\` for default.\n` +
              `Use \`${prefix}boost footer none\` to remove footer.\n\n` +
              `**Variables:** {username}, {boostcount}, {boostlevel}`)]
          });
        }

        if (footerText === 'reset' || footerText === 'default') {
          await Guild.updateGuild(message.guild.id, {
            $set: { 'features.boostSystem.footerText': null }
          });
          return message.reply({
            embeds: [await successEmbed(message.guild.id, 'Footer Reset',
              `${GLYPHS.SUCCESS} Boost footer reset to default.`)]
          });
        }

        if (footerText === 'none' || footerText === 'remove') {
          await Guild.updateGuild(message.guild.id, {
            $set: { 'features.boostSystem.footerText': ' ' }
          });
          return message.reply({
            embeds: [await successEmbed(message.guild.id, 'Footer Removed',
              `${GLYPHS.SUCCESS} Boost footer has been removed.`)]
          });
        }

        await Guild.updateGuild(message.guild.id, {
          $set: { 'features.boostSystem.footerText': footerText }
        });

        return message.reply({
          embeds: [await successEmbed(message.guild.id, 'Footer Set',
            `${GLYPHS.SUCCESS} Boost footer set to: ${footerText}`)]
        });

      case 'color':
        const colorHex = args[1];

        if (!colorHex) {
          return message.reply({
            embeds: [await infoEmbed(message.guild.id, 'Embed Color',
              `**Current Color:**\n${guildConfig.features?.boostSystem?.embedColor || '#f47fff'}\n\n` +
              `Use \`${prefix}boost color #HEX\` to set a custom color.\n` +
              `Use \`${prefix}boost color reset\` for default pink.`)]
          });
        }

        if (colorHex === 'reset' || colorHex === 'default') {
          await Guild.updateGuild(message.guild.id, {
            $set: { 'features.boostSystem.embedColor': '#f47fff' }
          });
          return message.reply({
            embeds: [await successEmbed(message.guild.id, 'Color Reset',
              `${GLYPHS.SUCCESS} Boost embed color reset to default pink.`)]
          });
        }

        if (!colorHex.match(/^#?[0-9A-Fa-f]{6}$/)) {
          return message.reply({
            embeds: [await errorEmbed(message.guild.id, 'Invalid Color',
              'Please provide a valid hex color code (e.g., #f47fff)')]
          });
        }

        const normalizedColor = colorHex.startsWith('#') ? colorHex : `#${colorHex}`;
        await Guild.updateGuild(message.guild.id, {
          $set: { 'features.boostSystem.embedColor': normalizedColor }
        });

        return message.reply({
          embeds: [await successEmbed(message.guild.id, 'Color Set',
            `${GLYPHS.SUCCESS} Boost embed color set to: ${normalizedColor}`)]
        });

      case 'mention':
        const mentionOption = args[1]?.toLowerCase();

        if (!['on', 'off', 'enable', 'disable'].includes(mentionOption)) {
          return message.reply({
            embeds: [await errorEmbed(message.guild.id, 'Invalid Option',
              `Use \`${prefix}boost mention on\` or \`${prefix}boost mention off\``)]
          });
        }

        const mentionEnabled = ['on', 'enable'].includes(mentionOption);
        await Guild.updateGuild(message.guild.id, {
          $set: { 'features.boostSystem.mentionUser': mentionEnabled }
        });

        return message.reply({
          embeds: [await successEmbed(message.guild.id, 'Mention Setting Updated',
            `${GLYPHS.SUCCESS} User mention above embed is now **${mentionEnabled ? 'enabled' : 'disabled'}**`)]
        });

      case 'greeting':
        const greetingText = args.slice(1).join(' ');

        if (!greetingText) {
          return message.reply({
            embeds: [await infoEmbed(message.guild.id, 'Greeting Text',
              `**Current Greeting:**\n${guildConfig.features?.boostSystem?.greetingText || '💎 {user} just boosted the server!'}\n\n` +
              `This is the text that appears above the embed (when mention is enabled).\n\n` +
              `Use \`${prefix}boost greeting <text>\` to customize.\n` +
              `**Variables:** {user}, {username}, {server}`)]
          });
        }

        await Guild.updateGuild(message.guild.id, {
          $set: { 'features.boostSystem.greetingText': greetingText }
        });

        return message.reply({
          embeds: [await successEmbed(message.guild.id, 'Greeting Set',
            `${GLYPHS.SUCCESS} Greeting text set to: ${greetingText}`)]
        });

      case 'preview':
        return showPreview(message, guildConfig);

      case 'help':
        return showHelp(message, prefix);

      case 'author':
        const authorOption = args[1]?.toLowerCase();

        if (!authorOption) {
          return message.reply({
            embeds: [await infoEmbed(message.guild.id, 'Author Settings',
              `**Current:** ${guildConfig.features?.boostSystem?.authorType || 'username (with avatar)'}\n\n` +
              `\`${prefix}boost author username\` - Show username with avatar\n` +
              `\`${prefix}boost author displayname\` - Show display name with avatar\n` +
              `\`${prefix}boost author server\` - Show server name with icon\n` +
              `\`${prefix}boost author none\` - No author section`)]
          });
        }

        const validAuthorTypes = ['username', 'displayname', 'display', 'server', 'guild', 'none', 'remove'];
        if (!validAuthorTypes.includes(authorOption)) {
          return message.reply({
            embeds: [await errorEmbed(message.guild.id, 'Invalid Option',
              'Valid options: `username`, `displayname`, `server`, `none`')]
          });
        }

        let authorType = authorOption;
        if (authorOption === 'display') authorType = 'displayname';
        if (authorOption === 'guild') authorType = 'server';
        if (authorOption === 'remove') authorType = 'none';

        await Guild.updateGuild(message.guild.id, {
          $set: { 'features.boostSystem.authorType': authorType }
        });

        return message.reply({
          embeds: [await successEmbed(message.guild.id, 'Author Setting Updated',
            `${GLYPHS.SUCCESS} Author section set to: **${authorType}**`)]
        });

      case 'timestamp':
        const timestampOption = args[1]?.toLowerCase();

        if (!['on', 'off', 'enable', 'disable'].includes(timestampOption)) {
          return message.reply({
            embeds: [await errorEmbed(message.guild.id, 'Invalid Option',
              `Use \`${prefix}boost timestamp on\` or \`${prefix}boost timestamp off\``)]
          });
        }

        const timestampEnabled = ['on', 'enable'].includes(timestampOption);
        await Guild.updateGuild(message.guild.id, {
          $set: { 'features.boostSystem.showTimestamp': timestampEnabled }
        });

        return message.reply({
          embeds: [await successEmbed(message.guild.id, 'Timestamp Setting Updated',
            `${GLYPHS.SUCCESS} Timestamp is now **${timestampEnabled ? 'enabled' : 'disabled'}**`)]
        });

      case 'reset':
        await Guild.updateGuild(message.guild.id, {
          $set: {
            'features.boostSystem': {
              enabled: false,
              channel: null,
              message: null,
              embedEnabled: true,
              embedColor: '#f47fff',
              embedTitle: null,
              bannerUrl: null,
              thumbnailUrl: null,
              thumbnailType: 'avatar',
              footerText: null,
              showTimestamp: true,
              mentionUser: true,
              greetingText: null,
              authorType: 'username'
            }
          }
        });

        return message.reply({
          embeds: [await successEmbed(message.guild.id, 'Boost System Reset',
            `${GLYPHS.SUCCESS} All boost message settings have been reset to defaults.`)]
        });

      // Booster Role System commands
      case 'role':
      case 'setrole':
        return setBoosterRole(message, args, guildConfig, prefix);

      case 'give':
      case 'assign':
        return giveBoosterRole(message, args, guildConfig, prefix);

      case 'take':
      case 'revoke':
        return removeBoosterRole(message, args, guildConfig, prefix);

      case 'list':
      case 'active':
        return listActiveBoosterRoles(message, guildConfig, prefix);

      case 'duration':
      case 'time':
        return setRoleDuration(message, args, guildConfig, prefix);

      case 'clearrole':
        return clearBoosterRole(message, guildConfig, prefix);

      // Boost Tier Rewards commands
      case 'tier':
      case 'tiers':
      case 'rewards':
        return handleBoostTiers(message, args, guildConfig, prefix);

      case 'addtier':
      case 'settier':
        return addBoostTier(message, args, guildConfig, prefix);

      case 'removetier':
      case 'deletetier':
        return removeBoostTier(message, args, guildConfig, prefix);

      case 'listtiers':
      case 'tierlist':
        return listBoostTiers(message, guildConfig, prefix);

      case 'cleartiers':
        return clearBoostTiers(message, guildConfig, prefix);

      case 'stackable':
        return setTierStackable(message, args, guildConfig, prefix);

      // Booster Perks Announcement commands (text)
      case 'perks':
      case 'perk':
      case 'announcement':
        return handlePerksCommand(message, args, guildConfig, prefix);

      case 'publish':
      case 'send':
        return publishPerksAnnouncement(message, guildConfig, prefix);

      // Booster Perks Announcement commands (slash)
      case 'perks-channel':
        const perksChannel = message.mentions?.channels?.first() ||
          message.guild.channels.cache.get(args[1]);
        if (perksChannel) {
          await Guild.updateGuild(message.guild.id, {
            $set: { 'features.boostSystem.perksAnnouncement.channel': perksChannel.id }
          });
          return message.reply({
            embeds: [await successEmbed(message.guild.id, 'Perks Channel Set',
              `${GLYPHS.SUCCESS} Booster perks announcements will be sent to ${perksChannel}\n\nUse \`/boost perks-publish\` to send the announcement.`)]
          });
        }
        return message.reply({
          embeds: [await errorEmbed(message.guild.id, 'No Channel', 'Please provide a channel.')]
        });

      case 'perks-message':
        const perksMsg = args.slice(1).join(' ');
        if (perksMsg) {
          await Guild.updateGuild(message.guild.id, {
            $set: { 'features.boostSystem.perksAnnouncement.message': perksMsg }
          });
          return message.reply({
            embeds: [await successEmbed(message.guild.id, 'Perks Message Updated',
              `${GLYPHS.SUCCESS} Booster perks message has been updated!`)]
          });
        }
        return message.reply({
          embeds: [await errorEmbed(message.guild.id, 'No Message', 'Please provide a message.')]
        });

      case 'perks-title':
        const perksTitle = args.slice(1).join(' ');
        if (perksTitle?.toLowerCase() === 'reset') {
          await Guild.updateGuild(message.guild.id, {
            $unset: { 'features.boostSystem.perksAnnouncement.embedTitle': '' }
          });
          return message.reply({
            embeds: [await successEmbed(message.guild.id, 'Title Reset', 'Perks embed title has been reset to default.')]
          });
        }
        if (perksTitle) {
          await Guild.updateGuild(message.guild.id, {
            $set: { 'features.boostSystem.perksAnnouncement.embedTitle': perksTitle }
          });
          return message.reply({
            embeds: [await successEmbed(message.guild.id, 'Title Updated', `Perks embed title set to: **${perksTitle}**`)]
          });
        }
        return message.reply({
          embeds: [await errorEmbed(message.guild.id, 'No Title', 'Please provide a title.')]
        });

      case 'perks-color':
        const perksColor = args[1];
        if (perksColor?.toLowerCase() === 'reset') {
          await Guild.updateGuild(message.guild.id, {
            $set: { 'features.boostSystem.perksAnnouncement.embedColor': '#f47fff' }
          });
          return message.reply({
            embeds: [await successEmbed(message.guild.id, 'Color Reset', 'Perks embed color has been reset to default (#f47fff).')]
          });
        }
        if (perksColor && /^#?([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})$/.test(perksColor)) {
          const finalColor = perksColor.startsWith('#') ? perksColor : `#${perksColor}`;
          await Guild.updateGuild(message.guild.id, {
            $set: { 'features.boostSystem.perksAnnouncement.embedColor': finalColor }
          });
          return message.reply({
            embeds: [await successEmbed(message.guild.id, 'Color Updated', `Perks embed color set to: **${finalColor}**`)]
          });
        }
        return message.reply({
          embeds: [await errorEmbed(message.guild.id, 'Invalid Color', 'Please provide a valid hex color code.')]
        });

      case 'perks-image':
        const perksImageUrl = args[1];
        if (perksImageUrl?.toLowerCase() === 'remove') {
          await Guild.updateGuild(message.guild.id, {
            $unset: { 'features.boostSystem.perksAnnouncement.bannerUrl': '' }
          });
          return message.reply({
            embeds: [await successEmbed(message.guild.id, 'Banner Removed', 'Perks banner image has been removed.')]
          });
        }
        if (perksImageUrl?.startsWith('http')) {
          await Guild.updateGuild(message.guild.id, {
            $set: { 'features.boostSystem.perksAnnouncement.bannerUrl': perksImageUrl }
          });
          return message.reply({
            embeds: [await successEmbed(message.guild.id, 'Banner Set', 'Perks banner image has been updated!')]
          });
        }
        return message.reply({
          embeds: [await errorEmbed(message.guild.id, 'Invalid URL', 'Please provide a valid image URL or "remove".')]
        });

      case 'perks-thumbnail':
        const perksThumbnail = args[1]?.toLowerCase();
        if (perksThumbnail === 'server') {
          await Guild.updateGuild(message.guild.id, {
            $set: { 'features.boostSystem.perksAnnouncement.thumbnailType': 'server' }
          });
          return message.reply({
            embeds: [await successEmbed(message.guild.id, 'Thumbnail Updated', 'Perks thumbnail set to server icon.')]
          });
        } else if (perksThumbnail === 'remove') {
          await Guild.updateGuild(message.guild.id, {
            $set: { 'features.boostSystem.perksAnnouncement.thumbnailType': 'none' }
          });
          return message.reply({
            embeds: [await successEmbed(message.guild.id, 'Thumbnail Removed', 'Perks thumbnail has been removed.')]
          });
        }
        return message.reply({
          embeds: [await errorEmbed(message.guild.id, 'Invalid Option', 'Use "server" or "remove".')]
        });

      case 'perks-footer':
        const perksFooter = args.slice(1).join(' ');
        if (perksFooter?.toLowerCase() === 'reset') {
          await Guild.updateGuild(message.guild.id, {
            $unset: { 'features.boostSystem.perksAnnouncement.footerText': '' }
          });
          return message.reply({
            embeds: [await successEmbed(message.guild.id, 'Footer Removed', 'Perks footer has been removed.')]
          });
        }
        if (perksFooter) {
          await Guild.updateGuild(message.guild.id, {
            $set: { 'features.boostSystem.perksAnnouncement.footerText': perksFooter }
          });
          return message.reply({
            embeds: [await successEmbed(message.guild.id, 'Footer Updated', `Perks footer set to: **${perksFooter}**`)]
          });
        }
        return message.reply({
          embeds: [await errorEmbed(message.guild.id, 'No Footer', 'Please provide footer text.')]
        });

      case 'perks-tierlist':
        const perksTierList = args[1]?.toLowerCase() === 'true';
        await Guild.updateGuild(message.guild.id, {
          $set: { 'features.boostSystem.perksAnnouncement.showTierList': perksTierList }
        });
        return message.reply({
          embeds: [await successEmbed(message.guild.id, 'Tier List Setting Updated',
            `${GLYPHS.SUCCESS} Auto tier list in perks announcement is now **${perksTierList ? 'enabled' : 'disabled'}**.`)]
        });

      case 'perks-preview':
        return previewPerksAnnouncement(message, guildConfig, prefix);

      case 'perks-publish':
        return publishPerksAnnouncement(message, guildConfig, prefix);

      case 'perks-status':
        return showPerksStatus(message, guildConfig, prefix);

      case 'perks-reset':
        return resetPerksSettings(message, guildConfig, prefix);

      default:
        return message.reply({
          embeds: [await errorEmbed(message.guild.id, 'Unknown Option',
            `Unknown option: \`${action}\`\n\nUse \`${prefix}boost help\` for available commands.`)]
        });
    }
  }
};

async function showStatus(message, guildConfig, prefix) {
  const boost = guildConfig.features?.boostSystem || {};
  const boosterRole = guildConfig.features?.boosterRoleSystem || {};
  const channel = boost.channel ? message.guild.channels.cache.get(boost.channel) : null;
  const role = boosterRole.roleId ? message.guild.roles.cache.get(boosterRole.roleId) : null;

  const embed = new EmbedBuilder()
    .setColor(boost.embedColor || '#f47fff')
    .setTitle('『 Boost Thank You System 』')
    .setDescription(
      `**▸ Status:** ${boost.enabled ? '◉ Active' : '○ Inactive'}\n` +
      `**▸ Channel:** ${channel || 'Not configured'}\n` +
      `**▸ Embed Mode:** ${boost.embedEnabled !== false ? '◉' : '○'}\n` +
      `**▸ Mention User:** ${boost.mentionUser !== false ? '◉' : '○'}\n` +
      `**▸ Timestamp:** ${boost.showTimestamp !== false ? '◉' : '○'}\n\n` +
      `**▸ Color:** ${boost.embedColor || '#f47fff'}\n` +
      `**▸ Title:** ${boost.embedTitle ? 'Custom' : 'Default decorative'}\n` +
      `**▸ Author:** ${boost.authorType || 'username'}\n` +
      `**▸ Thumbnail:** ${boost.thumbnailType || boost.thumbnailUrl || 'avatar'}\n` +
      `**▸ Banner:** ${boost.bannerUrl ? '◉ Set' : '○ Not set'}\n\n` +
      `**▸ Temp Role:** ${role || 'Not set'}\n` +
      `**▸ Role Duration:** ${boosterRole.duration || 24} hours\n\n` +
      `**Current Message:**\n\`\`\`${(boost.message || 'Thank you {user} for boosting {server}! 🎉').slice(0, 100)}\`\`\`\n` +
      `Type \`${prefix}boost help\` for all commands.`
    )
    .setFooter({ text: `Use ${prefix}boost help for all customization options` });

  return message.reply({ embeds: [embed] });
}

async function showHelp(message, prefix) {
  const helpEmbed = new EmbedBuilder()
    .setColor('#f47fff')
    .setTitle('『 Boost Commands 』')
    .setDescription('All available commands for customizing boost thank you messages.')
    .addFields(
      {
        name: '🔧 Basic Setup', value:
          `${GLYPHS.DOT} \`${prefix}boost channel #channel\` - Set boost channel\n` +
          `${GLYPHS.DOT} \`${prefix}boost test\` - Test boost message\n` +
          `${GLYPHS.DOT} \`${prefix}boost preview\` - Preview current settings\n` +
          `${GLYPHS.DOT} \`${prefix}boost reset\` - Reset all settings\n` +
          `${GLYPHS.DOT} \`${prefix}feature enable/disable boost\` - Toggle system`, inline: false
      },
      {
        name: '📝 Content', value:
          `${GLYPHS.DOT} \`${prefix}boost message <text>\` - Embed description\n` +
          `${GLYPHS.DOT} \`${prefix}boost greeting <text>\` - Text above embed\n` +
          `${GLYPHS.DOT} \`${prefix}boost title <text>\` - Embed title\n` +
          `${GLYPHS.DOT} \`${prefix}boost footer <text>\` - Footer text`, inline: false
      },
      {
        name: '🎨 Appearance', value:
          `${GLYPHS.DOT} \`${prefix}boost color #HEX\` - Embed color\n` +
          `${GLYPHS.DOT} \`${prefix}boost image <url>\` - Banner image\n` +
          `${GLYPHS.DOT} \`${prefix}boost thumbnail <url|avatar|server>\`\n` +
          `${GLYPHS.DOT} \`${prefix}boost author <username|displayname|server|none>\``, inline: false
      },
      {
        name: '⚙️ Toggles', value:
          `${GLYPHS.DOT} \`${prefix}boost embed on/off\` - Toggle embed mode\n` +
          `${GLYPHS.DOT} \`${prefix}boost mention on/off\` - Ping user above embed\n` +
          `${GLYPHS.DOT} \`${prefix}boost timestamp on/off\` - Show timestamp`, inline: false
      },
      {
        name: '🎭 Temporary Booster Role', value:
          `${GLYPHS.DOT} \`${prefix}boost role @role\` - Set temp booster role\n` +
          `${GLYPHS.DOT} \`${prefix}boost give @user [reason]\` - Give role to user\n` +
          `${GLYPHS.DOT} \`${prefix}boost take @user\` - Remove role from user\n` +
          `${GLYPHS.DOT} \`${prefix}boost duration <hours>\` - Set role duration\n` +
          `${GLYPHS.DOT} \`${prefix}boost list\` - Show active booster roles\n` +
          `${GLYPHS.DOT} \`${prefix}boost clearrole\` - Remove role config`, inline: false
      },
      {
        name: '💎 Boost Tier Rewards', value:
          `${GLYPHS.DOT} \`${prefix}boost addtier <count> @role\` - Add tier reward\n` +
          `${GLYPHS.DOT} \`${prefix}boost removetier <count>\` - Remove tier\n` +
          `${GLYPHS.DOT} \`${prefix}boost listtiers\` - View all tiers\n` +
          `${GLYPHS.DOT} \`${prefix}boost stackable <count> <on/off>\` - Stack setting\n` +
          `${GLYPHS.DOT} \`${prefix}boost cleartiers\` - Clear all tiers`, inline: false
      },
      {
        name: '📢 Booster Perks Announcement', value:
          `${GLYPHS.DOT} \`${prefix}boost perks channel #channel\` - Set perks channel\n` +
          `${GLYPHS.DOT} \`${prefix}boost perks message <text>\` - Set perks message\n` +
          `${GLYPHS.DOT} \`${prefix}boost perks title <text>\` - Set title\n` +
          `${GLYPHS.DOT} \`${prefix}boost perks color #HEX\` - Set color\n` +
          `${GLYPHS.DOT} \`${prefix}boost perks image <url>\` - Set banner\n` +
          `${GLYPHS.DOT} \`${prefix}boost perks preview\` - Preview message\n` +
          `${GLYPHS.DOT} \`${prefix}boost publish\` - Send announcement`, inline: false
      }
    );

  const varsEmbed = new EmbedBuilder()
    .setColor('#f47fff')
    .setTitle('『 Variables 』')
    .setDescription(
      `Use these in message, title, footer, or greeting:\n\n` +
      `${GLYPHS.DOT} \`{user}\` - Mentions the user (@user)\n` +
      `${GLYPHS.DOT} \`{username}\` - Username\n` +
      `${GLYPHS.DOT} \`{displayname}\` - Display name\n` +
      `${GLYPHS.DOT} \`{tag}\` - User's tag\n` +
      `${GLYPHS.DOT} \`{id}\` - User's ID\n` +
      `${GLYPHS.DOT} \`{server}\` - Server name\n` +
      `${GLYPHS.DOT} \`{membercount}\` - Member count\n` +
      `${GLYPHS.DOT} \`{boostcount}\` - Total server boost count\n` +
      `${GLYPHS.DOT} \`{userboosts}\` - User's boost count\n` +
      `${GLYPHS.DOT} \`{boostlevel}\` - Server boost level (0-3)\n` +
      `${GLYPHS.DOT} \`{avatar}\` - Avatar URL\n` +
      `${GLYPHS.DOT} \`\\n\` - New line`
    );

  return message.reply({ embeds: [helpEmbed, varsEmbed] });
}

async function showPreview(message, guildConfig) {
  const boost = guildConfig.features?.boostSystem || {};
  const { embed, content } = buildBoostEmbed(message.member, boost, guildConfig);

  await message.reply({
    embeds: [await infoEmbed(message.guild.id, 'Boost Preview',
      'Here\'s how your boost message will look:')]
  });

  await message.channel.send({ content, embeds: embed ? [embed] : undefined });
}

async function sendTestBoost(message, guildConfig, prefix) {
  const boost = guildConfig.features?.boostSystem || {};
  const channel = boost.channel ? message.guild.channels.cache.get(boost.channel) : message.channel;

  if (!channel) {
    return message.reply({
      embeds: [await errorEmbed(message.guild.id, 'No Channel',
        `Boost channel is not set. Use \`${prefix}boost channel #channel\` to set one.`)]
    });
  }

  const { embed, content } = buildBoostEmbed(message.member, boost, guildConfig);

  if (embed) {
    await channel.send({ content, embeds: [embed] });
  } else {
    const boostMsg = parseBoostMessage(boost.message || 'Thank you {user} for boosting {server}! 🎉', message.member);
    await channel.send(content || boostMsg);
  }

  return message.reply({
    embeds: [await successEmbed(message.guild.id, 'Test Sent',
      `${GLYPHS.SUCCESS} Test boost message sent to ${channel}`)]
  });
}

// ============================================
// Booster Role System Functions
// ============================================

async function setBoosterRole(message, args, guildConfig, prefix) {
  const role = message.mentions.roles.first() || message.guild.roles.cache.get(args[1]);

  if (!role) {
    return message.reply({
      embeds: [await errorEmbed(message.guild.id, 'Role Not Found',
        `${GLYPHS.ERROR} Please mention a valid role!\n\n**Usage:** \`${prefix}boost role @role\``)]
    });
  }

  const roleError = getAssignableRoleError(role, message.member);
  if (roleError) {
    return message.reply({ embeds: [await errorEmbed(message.guild.id, 'Role Not Allowed', roleError)] });
  }

  // Check role hierarchy
  if (role.position >= message.guild.members.me.roles.highest.position) {
    return message.reply({
      embeds: [await errorEmbed(message.guild.id, 'Role Too High',
        `${GLYPHS.ERROR} I cannot manage ${role} because it's higher than or equal to my highest role.`)]
    });
  }

  if (role.managed) {
    return message.reply({
      embeds: [await errorEmbed(message.guild.id, 'Managed Role',
        `${GLYPHS.ERROR} ${role} is managed by an integration and cannot be assigned manually.`)]
    });
  }

  await Guild.updateGuild(message.guild.id, {
    $set: {
      'features.boosterRoleSystem.roleId': role.id,
      'features.boosterRoleSystem.enabled': true
    }
  });

  const duration = guildConfig.features?.boosterRoleSystem?.duration || 24;

  return message.reply({
    embeds: [await successEmbed(message.guild.id, 'Booster Role Set',
      `${GLYPHS.SUCCESS} The temporary booster role has been set to ${role}.\n\n` +
      `Users given this role will have it automatically removed after **${duration} hours**.`)]
  });
}

async function giveBoosterRole(message, args, guildConfig, prefix) {
  const boosterRoleId = guildConfig.features?.boosterRoleSystem?.roleId;

  if (!boosterRoleId) {
    return message.reply({
      embeds: [await errorEmbed(message.guild.id, 'No Role Configured',
        `${GLYPHS.ERROR} No booster role has been configured!\n\n**Usage:** \`${prefix}boost role @role\``)]
    });
  }

  if (!guildConfig.features?.boosterRoleSystem?.enabled) {
    return message.reply({
      embeds: [await errorEmbed(message.guild.id, 'System Disabled',
        `${GLYPHS.ERROR} The booster role system is disabled!\n\nSet a role first: \`${prefix}boost role @role\``)]
    });
  }

  const member = message.mentions.members.first() || await message.guild.members.fetch(args[1]).catch(() => null);

  if (!member) {
    return message.reply({
      embeds: [await errorEmbed(message.guild.id, 'User Not Found',
        `${GLYPHS.ERROR} Please mention a valid user!\n\n**Usage:** \`${prefix}boost give @user [reason]\``)]
    });
  }

  const role = message.guild.roles.cache.get(boosterRoleId);

  if (!role) {
    return message.reply({
      embeds: [await errorEmbed(message.guild.id, 'Role Not Found',
        `${GLYPHS.ERROR} The configured booster role no longer exists. Please set a new one.`)]
    });
  }

  // Check if user already has the role
  if (member.roles.cache.has(boosterRoleId)) {
    // Update the expiry time
    const duration = (guildConfig.features?.boosterRoleSystem?.duration || 24) * 60 * 60 * 1000;
    const reason = args.slice(2).join(' ') || null;

    await BoosterRole.addBoosterRole(
      message.guild.id,
      member.id,
      boosterRoleId,
      duration,
      message.author.id,
      reason
    );

    const expiresAt = new Date(Date.now() + duration);
    return message.reply({
      embeds: [await infoEmbed(message.guild.id, 'Role Extended',
        `${GLYPHS.INFO} ${member}'s booster role duration has been extended!\n\n` +
        `**Expires:** <t:${Math.floor(expiresAt.getTime() / 1000)}:R>`)]
    });
  }

  try {
    // Add the role to the user
    await member.roles.add(role);

    // Add to database for tracking
    const duration = (guildConfig.features?.boosterRoleSystem?.duration || 24) * 60 * 60 * 1000;
    const reason = args.slice(2).join(' ') || null;

    await BoosterRole.addBoosterRole(
      message.guild.id,
      member.id,
      boosterRoleId,
      duration,
      message.author.id,
      reason
    );

    const expiresAt = new Date(Date.now() + duration);

    return message.reply({
      embeds: [await successEmbed(message.guild.id, 'Booster Role Given',
        `${GLYPHS.SUCCESS} Successfully gave ${role} to ${member}!\n\n` +
        `**Expires:** <t:${Math.floor(expiresAt.getTime() / 1000)}:F> (<t:${Math.floor(expiresAt.getTime() / 1000)}:R>)` +
        (reason ? `\n**Reason:** ${reason}` : ''))]
    });
  } catch (error) {
    console.error('Error giving booster role:', error);
    return message.reply({
      embeds: [await errorEmbed(message.guild.id, 'Error',
        `${GLYPHS.ERROR} Failed to give the booster role. Make sure I have the proper permissions.`)]
    });
  }
}

async function removeBoosterRole(message, args, guildConfig, prefix) {
  const boosterRoleId = guildConfig.features?.boosterRoleSystem?.roleId;

  if (!boosterRoleId) {
    return message.reply({
      embeds: [await errorEmbed(message.guild.id, 'No Role Configured',
        `${GLYPHS.ERROR} No booster role has been configured!`)]
    });
  }

  const member = message.mentions.members.first() || await message.guild.members.fetch(args[1]).catch(() => null);

  if (!member) {
    return message.reply({
      embeds: [await errorEmbed(message.guild.id, 'User Not Found',
        `${GLYPHS.ERROR} Please mention a valid user!\n\n**Usage:** \`${prefix}boost take @user\``)]
    });
  }

  const role = message.guild.roles.cache.get(boosterRoleId);

  if (!member.roles.cache.has(boosterRoleId)) {
    return message.reply({
      embeds: [await errorEmbed(message.guild.id, 'No Role',
        `${GLYPHS.ERROR} ${member} doesn't have the booster role.`)]
    });
  }

  try {
    // Remove the role from the user
    if (role) {
      await member.roles.remove(role);
    }

    // Remove from database
    await BoosterRole.removeBoosterRole(message.guild.id, member.id, boosterRoleId);

    return message.reply({
      embeds: [await successEmbed(message.guild.id, 'Booster Role Removed',
        `${GLYPHS.SUCCESS} Successfully removed the booster role from ${member}.`)]
    });
  } catch (error) {
    console.error('Error removing booster role:', error);
    return message.reply({
      embeds: [await errorEmbed(message.guild.id, 'Error',
        `${GLYPHS.ERROR} Failed to remove the booster role. Make sure I have the proper permissions.`)]
    });
  }
}

async function listActiveBoosterRoles(message, guildConfig, prefix) {
  const activeRoles = await BoosterRole.getGuildBoosterRoles(message.guild.id);

  if (activeRoles.length === 0) {
    return message.reply({
      embeds: [await infoEmbed(message.guild.id, 'No Active Booster Roles',
        `${GLYPHS.INFO} There are no active temporary booster roles in this server.`)]
    });
  }

  const fields = [];
  for (const entry of activeRoles.slice(0, 25)) {
    const member = await message.guild.members.fetch(entry.userId).catch(() => null);
    const role = message.guild.roles.cache.get(entry.roleId);
    const expiresTimestamp = Math.floor(entry.expiresAt.getTime() / 1000);

    fields.push({
      name: member ? member.user.tag : `User ID: ${entry.userId}`,
      value: `**Role:** ${role ? role.toString() : 'Unknown'}\n` +
        `**Expires:** <t:${expiresTimestamp}:R>\n` +
        (entry.reason ? `**Reason:** ${entry.reason}` : ''),
      inline: true
    });
  }

  const embed = new EmbedBuilder()
    .setTitle(`${GLYPHS.SPARKLE} Active Booster Roles`)
    .setColor(guildConfig.embedStyle?.color || '#5865F2')
    .setDescription(`Showing ${activeRoles.length} active booster role(s)`)
    .addFields(fields)
    .setFooter({ text: 'Roles are automatically removed when they expire' });

  return message.reply({ embeds: [embed] });
}

async function setRoleDuration(message, args, guildConfig, prefix) {
  const hours = parseInt(args[1]);

  if (isNaN(hours) || hours < 1 || hours > 720) {
    return message.reply({
      embeds: [await errorEmbed(message.guild.id, 'Invalid Duration',
        `${GLYPHS.ERROR} Please provide a valid duration between 1 and 720 hours (30 days).\n\n` +
        `**Usage:** \`${prefix}boost duration <hours>\``)]
    });
  }

  await Guild.updateGuild(message.guild.id, {
    $set: { 'features.boosterRoleSystem.duration': hours }
  });

  return message.reply({
    embeds: [await successEmbed(message.guild.id, 'Duration Updated',
      `${GLYPHS.SUCCESS} Booster role duration has been set to **${hours} hours**.\n\n` +
      `This will apply to new role assignments. Existing assignments will keep their original expiry time.`)]
  });
}

async function clearBoosterRole(message, guildConfig, prefix) {
  await Guild.updateGuild(message.guild.id, {
    $unset: { 'features.boosterRoleSystem.roleId': '' },
    $set: { 'features.boosterRoleSystem.enabled': false }
  });

  return message.reply({
    embeds: [await successEmbed(message.guild.id, 'Booster Role Cleared',
      `${GLYPHS.SUCCESS} The booster role configuration has been cleared.\n\n` +
      `**Note:** Existing role assignments will still be tracked and removed when they expire.`)]
  });
}

// ============================================
// BOOST TIER REWARDS FUNCTIONS
// ============================================

async function handleBoostTiers(message, args, guildConfig, prefix) {
  const subAction = args[1]?.toLowerCase();

  if (!subAction) {
    return listBoostTiers(message, guildConfig, prefix);
  }

  switch (subAction) {
    case 'add':
    case 'set':
      return addBoostTier(message, args.slice(1), guildConfig, prefix);
    case 'remove':
    case 'delete':
      return removeBoostTier(message, args.slice(1), guildConfig, prefix);
    case 'list':
      return listBoostTiers(message, guildConfig, prefix);
    case 'clear':
      return clearBoostTiers(message, guildConfig, prefix);
    case 'help':
      return showTierHelp(message, prefix);
    default:
      return showTierHelp(message, prefix);
  }
}

async function addBoostTier(message, args, guildConfig, prefix) {
  // Usage: boost addtier <boost_count> @role [stackable]
  // or: boost tier add <boost_count> @role [stackable]
  const boostCount = parseInt(args[1]);
  const role = message.mentions.roles.first() || message.guild.roles.cache.get(args[2]);
  const stackableArg = args[3]?.toLowerCase();

  if (isNaN(boostCount) || boostCount < 1 || boostCount > 100) {
    return message.reply({
      embeds: [await errorEmbed(message.guild.id, 'Invalid Boost Count',
        `${GLYPHS.ERROR} Please provide a valid boost count between 1 and 100.\n\n` +
        `**Usage:** \`${prefix}boost addtier <boost_count> @role [stackable]\`\n` +
        `**Example:** \`${prefix}boost addtier 2 @DoubleBooster\` - Reward for 2+ boosts`)]
    });
  }

  if (!role) {
    return message.reply({
      embeds: [await errorEmbed(message.guild.id, 'No Role Specified',
        `${GLYPHS.ERROR} Please mention a role or provide a role ID.\n\n` +
        `**Usage:** \`${prefix}boost addtier <boost_count> @role\`\n` +
        `**Example:** \`${prefix}boost addtier 3 @TripleBooster\``)]
    });
  }

  const roleError = getAssignableRoleError(role, message.member);
  if (roleError) {
    return message.reply({ embeds: [await errorEmbed(message.guild.id, 'Role Not Allowed', roleError)] });
  }

  // Check if role is manageable
  if (role.position >= message.guild.members.me.roles.highest.position) {
    return message.reply({
      embeds: [await errorEmbed(message.guild.id, 'Role Too High',
        `${GLYPHS.ERROR} I cannot manage the ${role} role as it's higher than my highest role.`)]
    });
  }

  const stackable = stackableArg !== 'false' && stackableArg !== 'no';

  // Get current tiers
  const currentTiers = guildConfig.features?.boostSystem?.tierRewards || [];

  // Check if this boost count already has a tier
  const existingIndex = currentTiers.findIndex(t => t.boostCount === boostCount);

  if (existingIndex !== -1) {
    // Update existing tier
    currentTiers[existingIndex] = { boostCount, roleId: role.id, stackable };
  } else {
    // Add new tier
    currentTiers.push({ boostCount, roleId: role.id, stackable });
  }

  // Sort by boost count
  currentTiers.sort((a, b) => a.boostCount - b.boostCount);

  await Guild.updateGuild(message.guild.id, {
    $set: { 'features.boostSystem.tierRewards': currentTiers }
  });

  return message.reply({
    embeds: [await successEmbed(message.guild.id, 'Boost Tier Added',
      `${GLYPHS.SUCCESS} **Tier ${boostCount}** reward has been ${existingIndex !== -1 ? 'updated' : 'added'}!\n\n` +
      `**▸ Boosts Required:** ${boostCount}+\n` +
      `**▸ Reward Role:** ${role}\n` +
      `**▸ Stackable:** ${stackable ? 'Yes (keeps lower tier roles)' : 'No (replaces lower tier roles)'}\n\n` +
      `*When a user reaches ${boostCount} boosts, they will receive this role.*`)]
  });
}

async function removeBoostTier(message, args, guildConfig, prefix) {
  // Usage: boost removetier <boost_count>
  const boostCount = parseInt(args[1]);

  if (isNaN(boostCount)) {
    return message.reply({
      embeds: [await errorEmbed(message.guild.id, 'Invalid Boost Count',
        `${GLYPHS.ERROR} Please provide the boost count of the tier to remove.\n\n` +
        `**Usage:** \`${prefix}boost removetier <boost_count>\`\n` +
        `**Example:** \`${prefix}boost removetier 2\` - Remove tier for 2 boosts`)]
    });
  }

  const currentTiers = guildConfig.features?.boostSystem?.tierRewards || [];
  const tierIndex = currentTiers.findIndex(t => t.boostCount === boostCount);

  if (tierIndex === -1) {
    return message.reply({
      embeds: [await errorEmbed(message.guild.id, 'Tier Not Found',
        `${GLYPHS.ERROR} No tier found for ${boostCount} boosts.\n\n` +
        `Use \`${prefix}boost listtiers\` to see all configured tiers.`)]
    });
  }

  const removedTier = currentTiers.splice(tierIndex, 1)[0];
  const removedRole = message.guild.roles.cache.get(removedTier.roleId);

  await Guild.updateGuild(message.guild.id, {
    $set: { 'features.boostSystem.tierRewards': currentTiers }
  });

  return message.reply({
    embeds: [await successEmbed(message.guild.id, 'Boost Tier Removed',
      `${GLYPHS.SUCCESS} **Tier ${boostCount}** has been removed!\n\n` +
      `**▸ Removed Role:** ${removedRole || 'Unknown Role'}\n\n` +
      `*Users who already have this role will keep it. Use \`${prefix}boost listtiers\` to see remaining tiers.*`)]
  });
}

async function listBoostTiers(message, guildConfig, prefix) {
  const tiers = guildConfig.features?.boostSystem?.tierRewards || [];

  if (tiers.length === 0) {
    return message.reply({
      embeds: [await infoEmbed(message.guild.id, '💎 Boost Tier Rewards',
        `No boost tier rewards configured.\n\n` +
        `**Setup boost tiers to reward your boosters!**\n\n` +
        `${GLYPHS.DOT} \`${prefix}boost addtier 1 @Booster\` - Reward for 1 boost\n` +
        `${GLYPHS.DOT} \`${prefix}boost addtier 2 @DoubleBooster\` - Reward for 2 boosts\n` +
        `${GLYPHS.DOT} \`${prefix}boost addtier 3 @TripleBooster\` - Reward for 3 boosts\n\n` +
        `*Roles are automatically assigned when users reach the boost threshold.*`)]
    });
  }

  // Sort tiers by boost count
  const sortedTiers = [...tiers].sort((a, b) => a.boostCount - b.boostCount);

  let tierList = '';
  for (const tier of sortedTiers) {
    const role = message.guild.roles.cache.get(tier.roleId);
    const tierEmoji = getTierEmoji(tier.boostCount);
    tierList += `${tierEmoji} **${tier.boostCount}+ Boosts** → ${role || 'Unknown Role'}\n`;
    tierList += `   └─ Stackable: ${tier.stackable !== false ? '✅' : '❌'}\n`;
  }

  const embed = new EmbedBuilder()
    .setTitle('💎 Boost Tier Rewards')
    .setColor(guildConfig.features?.boostSystem?.embedColor || '#f47fff')
    .setDescription(
      `**Configured Tiers:**\n\n${tierList}\n\n` +
      `**Commands:**\n` +
      `${GLYPHS.DOT} \`${prefix}boost addtier <count> @role\` - Add tier\n` +
      `${GLYPHS.DOT} \`${prefix}boost removetier <count>\` - Remove tier\n` +
      `${GLYPHS.DOT} \`${prefix}boost cleartiers\` - Clear all tiers`
    )
    .setFooter({ text: `${tiers.length} tier(s) configured` });

  return message.reply({ embeds: [embed] });
}

async function clearBoostTiers(message, guildConfig, prefix) {
  const tiers = guildConfig.features?.boostSystem?.tierRewards || [];

  if (tiers.length === 0) {
    return message.reply({
      embeds: [await infoEmbed(message.guild.id, 'No Tiers to Clear',
        `There are no boost tier rewards configured.`)]
    });
  }

  await Guild.updateGuild(message.guild.id, {
    $set: { 'features.boostSystem.tierRewards': [] }
  });

  return message.reply({
    embeds: [await successEmbed(message.guild.id, 'Boost Tiers Cleared',
      `${GLYPHS.SUCCESS} All ${tiers.length} boost tier reward(s) have been removed.\n\n` +
      `*Users who already have tier roles will keep them.*`)]
  });
}

async function setTierStackable(message, args, guildConfig, prefix) {
  // Usage: boost stackable <boost_count> <on/off>
  const boostCount = parseInt(args[1]);
  const setting = args[2]?.toLowerCase();

  if (isNaN(boostCount)) {
    return message.reply({
      embeds: [await errorEmbed(message.guild.id, 'Invalid Boost Count',
        `${GLYPHS.ERROR} Please provide the boost count of the tier.\n\n` +
        `**Usage:** \`${prefix}boost stackable <boost_count> <on/off>\`\n` +
        `**Example:** \`${prefix}boost stackable 2 off\` - Make tier 2 replace lower tiers`)]
    });
  }

  if (!['on', 'off', 'true', 'false', 'yes', 'no'].includes(setting)) {
    return message.reply({
      embeds: [await errorEmbed(message.guild.id, 'Invalid Setting',
        `${GLYPHS.ERROR} Please specify \`on\` or \`off\`.\n\n` +
        `**Stackable ON:** Users keep all lower tier roles\n` +
        `**Stackable OFF:** Higher tiers replace lower tier roles`)]
    });
  }

  const currentTiers = guildConfig.features?.boostSystem?.tierRewards || [];
  const tierIndex = currentTiers.findIndex(t => t.boostCount === boostCount);

  if (tierIndex === -1) {
    return message.reply({
      embeds: [await errorEmbed(message.guild.id, 'Tier Not Found',
        `${GLYPHS.ERROR} No tier found for ${boostCount} boosts.`)]
    });
  }

  const stackable = ['on', 'true', 'yes'].includes(setting);
  currentTiers[tierIndex].stackable = stackable;

  await Guild.updateGuild(message.guild.id, {
    $set: { 'features.boostSystem.tierRewards': currentTiers }
  });

  return message.reply({
    embeds: [await successEmbed(message.guild.id, 'Tier Setting Updated',
      `${GLYPHS.SUCCESS} **Tier ${boostCount}** stackable setting is now **${stackable ? 'ON' : 'OFF'}**.\n\n` +
      (stackable
        ? `Users will keep lower tier roles when reaching this tier.`
        : `Lower tier roles will be removed when users reach this tier.`))]
  });
}

async function showTierHelp(message, prefix) {
  const embed = new EmbedBuilder()
    .setColor('#f47fff')
    .setTitle('💎 Boost Tier Rewards Help')
    .setDescription(
      `Reward your boosters with special roles based on how many times they've boosted!\n\n` +
      `**Commands:**\n\n` +
      `${GLYPHS.DOT} \`${prefix}boost addtier <count> @role\`\n` +
      `  Add a tier reward (e.g., \`addtier 2 @DoubleBooster\`)\n\n` +
      `${GLYPHS.DOT} \`${prefix}boost removetier <count>\`\n` +
      `  Remove a tier reward\n\n` +
      `${GLYPHS.DOT} \`${prefix}boost listtiers\`\n` +
      `  View all configured tiers\n\n` +
      `${GLYPHS.DOT} \`${prefix}boost cleartiers\`\n` +
      `  Remove all tier rewards\n\n` +
      `${GLYPHS.DOT} \`${prefix}boost stackable <count> <on/off>\`\n` +
      `  Set whether tier roles stack\n\n` +
      `**Example Setup:**\n` +
      `\`${prefix}boost addtier 1 @Booster\` - 1 boost\n` +
      `\`${prefix}boost addtier 2 @DoubleBooster\` - 2 boosts\n` +
      `\`${prefix}boost addtier 5 @SuperBooster\` - 5 boosts\n\n` +
      `*Roles are automatically assigned when users reach the boost threshold.*`
    )
    .setFooter({ text: 'Stackable: ON = keep all roles | OFF = replace with higher tier' });

  return message.reply({ embeds: [embed] });
}

function getTierEmoji(boostCount) {
  if (boostCount >= 10) return '💠';
  if (boostCount >= 5) return '🌟';
  if (boostCount >= 3) return '⭐';
  if (boostCount >= 2) return '✨';
  return '💎';
}

// ============================================
// BOOSTER PERKS ANNOUNCEMENT FUNCTIONS
// ============================================

async function handlePerksCommand(message, args, guildConfig, prefix) {
  const subAction = args[1]?.toLowerCase();

  if (!subAction) {
    return showPerksStatus(message, guildConfig, prefix);
  }

  switch (subAction) {
    case 'channel':
      return setPerksChannel(message, args.slice(1), guildConfig, prefix);
    case 'message':
    case 'msg':
    case 'description':
    case 'desc':
      return setPerksMessage(message, args.slice(1), guildConfig, prefix);
    case 'title':
      return setPerksTitle(message, args.slice(1), guildConfig, prefix);
    case 'color':
    case 'colour':
      return setPerksColor(message, args.slice(1), guildConfig, prefix);
    case 'image':
    case 'banner':
      return setPerksBanner(message, args.slice(1), guildConfig, prefix);
    case 'thumbnail':
    case 'thumb':
      return setPerksThumbnail(message, args.slice(1), guildConfig, prefix);
    case 'footer':
      return setPerksFooter(message, args.slice(1), guildConfig, prefix);
    case 'preview':
      return previewPerksAnnouncement(message, guildConfig, prefix);
    case 'publish':
    case 'send':
      return publishPerksAnnouncement(message, guildConfig, prefix);
    case 'tierlist':
    case 'showtiers':
      return togglePerksTierList(message, args.slice(1), guildConfig, prefix);
    case 'reset':
      return resetPerksSettings(message, guildConfig, prefix);
    case 'help':
    default:
      return showPerksHelp(message, prefix);
  }
}

async function showPerksStatus(message, guildConfig, prefix) {
  const perks = guildConfig.features?.boostSystem?.perksAnnouncement || {};
  const tiers = guildConfig.features?.boostSystem?.tierRewards || [];
  const channel = perks.channel ? message.guild.channels.cache.get(perks.channel) : null;

  const embed = new EmbedBuilder()
    .setColor(perks.embedColor || '#f47fff')
    .setTitle('📢 Booster Perks Announcement Status')
    .setDescription(
      `**▸ Perks Channel:** ${channel || 'Not configured'}\n` +
      `**▸ Show Tier List:** ${perks.showTierList !== false ? '◉' : '○'}\n` +
      `**▸ Embed Color:** ${perks.embedColor || '#f47fff'}\n` +
      `**▸ Title:** ${perks.embedTitle || 'Default'}\n` +
      `**▸ Banner:** ${perks.bannerUrl ? '◉ Set' : '○ Not set'}\n` +
      `**▸ Thumbnail:** ${perks.thumbnailType || 'server'}\n` +
      `**▸ Configured Tiers:** ${tiers.length}\n\n` +
      `**Current Message:**\n\`\`\`${(perks.message || 'Check out the amazing perks for our server boosters! 💎').slice(0, 100)}\`\`\`\n` +
      `Use \`${prefix}boost perks help\` for all commands.\n` +
      `Use \`${prefix}boost publish\` to send the announcement.`
    )
    .setFooter({ text: perks.lastPublished ? `Last published: ${new Date(perks.lastPublished).toLocaleDateString()}` : 'Never published' });

  return message.reply({ embeds: [embed] });
}

async function setPerksChannel(message, args, guildConfig, prefix) {
  const channel = message.mentions.channels.first() ||
    message.guild.channels.cache.get(args[1]);

  if (!channel) {
    return message.reply({
      embeds: [await errorEmbed(message.guild.id, 'No Channel',
        `${GLYPHS.ERROR} Please mention a channel or provide a channel ID.\n\n` +
        `**Usage:** \`${prefix}boost perks channel #booster-perks\``)]
    });
  }

  if (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement) {
    return message.reply({
      embeds: [await errorEmbed(message.guild.id, 'Invalid Channel',
        'Please select a text or announcement channel.')]
    });
  }

  await Guild.updateGuild(message.guild.id, {
    $set: { 'features.boostSystem.perksAnnouncement.channel': channel.id }
  });

  return message.reply({
    embeds: [await successEmbed(message.guild.id, 'Perks Channel Set',
      `${GLYPHS.SUCCESS} Booster perks announcements will be sent to ${channel}\n\n` +
      `Use \`${prefix}boost publish\` to send the announcement.`)]
  });
}

async function setPerksMessage(message, args, guildConfig, prefix) {
  const perksMsg = args.slice(1).join(' ');

  if (!perksMsg) {
    const currentMsg = guildConfig.features?.boostSystem?.perksAnnouncement?.message || 'Check out the amazing perks for our server boosters! 💎';
    return message.reply({
      embeds: [await infoEmbed(message.guild.id, 'Perks Message',
        `**Current Message:**\n${currentMsg}\n\n` +
        `**Usage:** \`${prefix}boost perks message <your message>\`\n\n` +
        `**Variables:**\n` +
        `${GLYPHS.DOT} \`{server}\` - Server name\n` +
        `${GLYPHS.DOT} \`{boostcount}\` - Total boost count\n` +
        `${GLYPHS.DOT} \`{boostlevel}\` - Server boost level\n` +
        `${GLYPHS.DOT} \`{membercount}\` - Member count`)]
    });
  }

  await Guild.updateGuild(message.guild.id, {
    $set: { 'features.boostSystem.perksAnnouncement.message': perksMsg }
  });

  return message.reply({
    embeds: [await successEmbed(message.guild.id, 'Perks Message Updated',
      `${GLYPHS.SUCCESS} Booster perks message has been updated!\n\n` +
      `**New Message:**\n${perksMsg.slice(0, 200)}${perksMsg.length > 200 ? '...' : ''}`)]
  });
}

async function setPerksTitle(message, args, guildConfig, prefix) {
  const title = args.slice(1).join(' ');

  if (!title) {
    return message.reply({
      embeds: [await errorEmbed(message.guild.id, 'No Title',
        `${GLYPHS.ERROR} Please provide a title.\n\n` +
        `**Usage:** \`${prefix}boost perks title 💎 Booster Perks & Rewards\`\n` +
        `Use \`${prefix}boost perks title reset\` to reset to default.`)]
    });
  }

  if (title.toLowerCase() === 'reset') {
    await Guild.updateGuild(message.guild.id, {
      $unset: { 'features.boostSystem.perksAnnouncement.embedTitle': '' }
    });
    return message.reply({
      embeds: [await successEmbed(message.guild.id, 'Title Reset',
        `${GLYPHS.SUCCESS} Perks embed title has been reset to default.`)]
    });
  }

  await Guild.updateGuild(message.guild.id, {
    $set: { 'features.boostSystem.perksAnnouncement.embedTitle': title }
  });

  return message.reply({
    embeds: [await successEmbed(message.guild.id, 'Title Updated',
      `${GLYPHS.SUCCESS} Perks embed title set to: **${title}**`)]
  });
}

async function setPerksColor(message, args, guildConfig, prefix) {
  const color = args[1];

  if (!color) {
    return message.reply({
      embeds: [await errorEmbed(message.guild.id, 'No Color',
        `${GLYPHS.ERROR} Please provide a hex color code.\n\n` +
        `**Usage:** \`${prefix}boost perks color #f47fff\``)]
    });
  }

  if (color.toLowerCase() === 'reset') {
    await Guild.updateGuild(message.guild.id, {
      $set: { 'features.boostSystem.perksAnnouncement.embedColor': '#f47fff' }
    });
    return message.reply({
      embeds: [await successEmbed(message.guild.id, 'Color Reset',
        `${GLYPHS.SUCCESS} Perks embed color has been reset to default (#f47fff).`)]
    });
  }

  const hexRegex = /^#?([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})$/;
  if (!hexRegex.test(color)) {
    return message.reply({
      embeds: [await errorEmbed(message.guild.id, 'Invalid Color',
        `${GLYPHS.ERROR} Please provide a valid hex color code (e.g., #f47fff).`)]
    });
  }

  const finalColor = color.startsWith('#') ? color : `#${color}`;
  await Guild.updateGuild(message.guild.id, {
    $set: { 'features.boostSystem.perksAnnouncement.embedColor': finalColor }
  });

  return message.reply({
    embeds: [await successEmbed(message.guild.id, 'Color Updated',
      `${GLYPHS.SUCCESS} Perks embed color set to: **${finalColor}**`)]
  });
}

async function setPerksBanner(message, args, guildConfig, prefix) {
  const url = args[1];

  if (!url) {
    return message.reply({
      embeds: [await errorEmbed(message.guild.id, 'No URL',
        `${GLYPHS.ERROR} Please provide an image URL.\n\n` +
        `**Usage:** \`${prefix}boost perks image <url>\`\n` +
        `Use \`${prefix}boost perks image remove\` to remove.`)]
    });
  }

  if (url.toLowerCase() === 'remove' || url.toLowerCase() === 'reset') {
    await Guild.updateGuild(message.guild.id, {
      $unset: { 'features.boostSystem.perksAnnouncement.bannerUrl': '' }
    });
    return message.reply({
      embeds: [await successEmbed(message.guild.id, 'Banner Removed',
        `${GLYPHS.SUCCESS} Perks banner image has been removed.`)]
    });
  }

  // Basic URL validation
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    return message.reply({
      embeds: [await errorEmbed(message.guild.id, 'Invalid URL',
        `${GLYPHS.ERROR} Please provide a valid image URL starting with http:// or https://`)]
    });
  }

  await Guild.updateGuild(message.guild.id, {
    $set: { 'features.boostSystem.perksAnnouncement.bannerUrl': url }
  });

  return message.reply({
    embeds: [await successEmbed(message.guild.id, 'Banner Set',
      `${GLYPHS.SUCCESS} Perks banner image has been updated!`)]
  });
}

async function setPerksThumbnail(message, args, guildConfig, prefix) {
  const option = args[1]?.toLowerCase();

  if (!option) {
    return message.reply({
      embeds: [await infoEmbed(message.guild.id, 'Thumbnail Options',
        `**Usage:** \`${prefix}boost perks thumbnail <option>\`\n\n` +
        `**Options:**\n` +
        `${GLYPHS.DOT} \`server\` - Server icon\n` +
        `${GLYPHS.DOT} \`<url>\` - Custom image URL\n` +
        `${GLYPHS.DOT} \`remove\` - No thumbnail`)]
    });
  }

  if (option === 'server' || option === 'guild') {
    await Guild.updateGuild(message.guild.id, {
      $set: { 'features.boostSystem.perksAnnouncement.thumbnailType': 'server' },
      $unset: { 'features.boostSystem.perksAnnouncement.thumbnailUrl': '' }
    });
    return message.reply({
      embeds: [await successEmbed(message.guild.id, 'Thumbnail Updated',
        `${GLYPHS.SUCCESS} Perks thumbnail set to server icon.`)]
    });
  }

  if (option === 'remove' || option === 'none') {
    await Guild.updateGuild(message.guild.id, {
      $set: { 'features.boostSystem.perksAnnouncement.thumbnailType': 'none' },
      $unset: { 'features.boostSystem.perksAnnouncement.thumbnailUrl': '' }
    });
    return message.reply({
      embeds: [await successEmbed(message.guild.id, 'Thumbnail Removed',
        `${GLYPHS.SUCCESS} Perks thumbnail has been removed.`)]
    });
  }

  // Custom URL
  if (option.startsWith('http://') || option.startsWith('https://')) {
    await Guild.updateGuild(message.guild.id, {
      $set: {
        'features.boostSystem.perksAnnouncement.thumbnailType': 'custom',
        'features.boostSystem.perksAnnouncement.thumbnailUrl': option
      }
    });
    return message.reply({
      embeds: [await successEmbed(message.guild.id, 'Thumbnail Updated',
        `${GLYPHS.SUCCESS} Perks thumbnail set to custom image.`)]
    });
  }

  return message.reply({
    embeds: [await errorEmbed(message.guild.id, 'Invalid Option',
      `${GLYPHS.ERROR} Invalid option. Use \`server\`, \`remove\`, or a valid image URL.`)]
  });
}

async function setPerksFooter(message, args, guildConfig, prefix) {
  const footer = args.slice(1).join(' ');

  if (!footer) {
    return message.reply({
      embeds: [await errorEmbed(message.guild.id, 'No Footer',
        `${GLYPHS.ERROR} Please provide footer text.\n\n` +
        `**Usage:** \`${prefix}boost perks footer Thank you for supporting us!\`\n` +
        `Use \`${prefix}boost perks footer reset\` to remove.`)]
    });
  }

  if (footer.toLowerCase() === 'reset' || footer.toLowerCase() === 'remove') {
    await Guild.updateGuild(message.guild.id, {
      $unset: { 'features.boostSystem.perksAnnouncement.footerText': '' }
    });
    return message.reply({
      embeds: [await successEmbed(message.guild.id, 'Footer Removed',
        `${GLYPHS.SUCCESS} Perks footer has been removed.`)]
    });
  }

  await Guild.updateGuild(message.guild.id, {
    $set: { 'features.boostSystem.perksAnnouncement.footerText': footer }
  });

  return message.reply({
    embeds: [await successEmbed(message.guild.id, 'Footer Updated',
      `${GLYPHS.SUCCESS} Perks footer set to: **${footer}**`)]
  });
}

async function togglePerksTierList(message, args, guildConfig, prefix) {
  const option = args[1]?.toLowerCase();

  if (!['on', 'off', 'enable', 'disable'].includes(option)) {
    return message.reply({
      embeds: [await errorEmbed(message.guild.id, 'Invalid Option',
        `${GLYPHS.ERROR} Use \`${prefix}boost perks tierlist on\` or \`off\`\n\n` +
        `When enabled, the tier rewards list will be automatically included in the perks announcement.`)]
    });
  }

  const enabled = ['on', 'enable'].includes(option);
  await Guild.updateGuild(message.guild.id, {
    $set: { 'features.boostSystem.perksAnnouncement.showTierList': enabled }
  });

  return message.reply({
    embeds: [await successEmbed(message.guild.id, 'Tier List Setting Updated',
      `${GLYPHS.SUCCESS} Auto tier list in perks announcement is now **${enabled ? 'enabled' : 'disabled'}**.`)]
  });
}

async function previewPerksAnnouncement(message, guildConfig, prefix) {
  const embed = buildPerksEmbed(message.guild, guildConfig);

  await message.reply({
    embeds: [await infoEmbed(message.guild.id, 'Perks Preview',
      'Here\'s how your booster perks announcement will look:')]
  });

  await message.channel.send({ embeds: [embed] });
}

async function publishPerksAnnouncement(message, guildConfig, prefix) {
  const perks = guildConfig.features?.boostSystem?.perksAnnouncement || {};
  const channelId = perks.channel;

  if (!channelId) {
    return message.reply({
      embeds: [await errorEmbed(message.guild.id, 'No Channel Set',
        `${GLYPHS.ERROR} Please set a perks announcement channel first.\n\n` +
        `**Usage:** \`${prefix}boost perks channel #booster-perks\``)]
    });
  }

  const channel = message.guild.channels.cache.get(channelId);
  if (!channel) {
    return message.reply({
      embeds: [await errorEmbed(message.guild.id, 'Channel Not Found',
        `${GLYPHS.ERROR} The configured perks channel no longer exists. Please set a new one.`)]
    });
  }

  // Check permissions
  const permissions = channel.permissionsFor(message.guild.members.me);
  if (!permissions?.has(['SendMessages', 'EmbedLinks'])) {
    return message.reply({
      embeds: [await errorEmbed(message.guild.id, 'Missing Permissions',
        `${GLYPHS.ERROR} I don't have permission to send messages in ${channel}.`)]
    });
  }

  const embed = buildPerksEmbed(message.guild, guildConfig);

  try {
    await channel.send({ embeds: [embed] });

    // Update last published timestamp
    await Guild.updateGuild(message.guild.id, {
      $set: { 'features.boostSystem.perksAnnouncement.lastPublished': new Date() }
    });

    return message.reply({
      embeds: [await successEmbed(message.guild.id, 'Announcement Published!',
        `${GLYPHS.SUCCESS} Booster perks announcement has been sent to ${channel}!`)]
    });
  } catch (error) {
    console.error('[BOOST PERKS] Error publishing announcement:', error);
    return message.reply({
      embeds: [await errorEmbed(message.guild.id, 'Failed to Publish',
        `${GLYPHS.ERROR} Failed to send the announcement. Please check my permissions.`)]
    });
  }
}

async function resetPerksSettings(message, guildConfig, prefix) {
  await Guild.updateGuild(message.guild.id, {
    $set: {
      'features.boostSystem.perksAnnouncement': {
        channel: null,
        message: 'Check out the amazing perks for our server boosters! 💎',
        embedEnabled: true,
        embedColor: '#f47fff',
        embedTitle: '💎 Booster Perks & Rewards',
        bannerUrl: null,
        thumbnailType: 'server',
        thumbnailUrl: null,
        footerText: null,
        showTimestamp: true,
        showTierList: true,
        lastPublished: null
      }
    }
  });

  return message.reply({
    embeds: [await successEmbed(message.guild.id, 'Perks Settings Reset',
      `${GLYPHS.SUCCESS} All booster perks announcement settings have been reset to defaults.`)]
  });
}

function buildPerksEmbed(guild, guildConfig) {
  const perks = guildConfig.features?.boostSystem?.perksAnnouncement || {};
  const tiers = guildConfig.features?.boostSystem?.tierRewards || [];

  const embed = new EmbedBuilder()
    .setColor(perks.embedColor || '#f47fff')
    .setTitle(perks.embedTitle || '💎 Booster Perks & Rewards');

  // Parse message with variables
  let description = (perks.message || 'Check out the amazing perks for our server boosters! 💎')
    .replace(/{server}/gi, guild.name)
    .replace(/{boostcount}/gi, (guild.premiumSubscriptionCount || 0).toString())
    .replace(/{boostlevel}/gi, guild.premiumTier.toString())
    .replace(/{membercount}/gi, guild.memberCount.toString())
    .replace(/\\n/g, '\n');

  // Add tier list if enabled
  if (perks.showTierList !== false && tiers.length > 0) {
    const sortedTiers = [...tiers].sort((a, b) => a.boostCount - b.boostCount);
    let tierList = '\n\n**🏆 Tier Rewards:**\n';

    for (const tier of sortedTiers) {
      const role = guild.roles.cache.get(tier.roleId);
      const tierEmoji = getTierEmoji(tier.boostCount);
      tierList += `${tierEmoji} **${tier.boostCount}+ Boost${tier.boostCount > 1 ? 's' : ''}** → ${role || 'Role not found'}\n`;
    }

    description += tierList;
  }

  embed.setDescription(description);

  // Thumbnail
  if (perks.thumbnailType === 'server' || !perks.thumbnailType) {
    embed.setThumbnail(guild.iconURL({ dynamic: true, size: 256 }));
  } else if (perks.thumbnailType === 'custom' && perks.thumbnailUrl) {
    embed.setThumbnail(perks.thumbnailUrl);
  }

  // Banner
  if (perks.bannerUrl) {
    embed.setImage(perks.bannerUrl);
  }

  // Footer
  if (perks.footerText) {
    embed.setFooter({ text: perks.footerText });
  } else {
    embed.setFooter({ text: `Server Boost Level: ${guild.premiumTier} • ${guild.premiumSubscriptionCount || 0} Boosts` });
  }

  // Timestamp
  if (perks.showTimestamp !== false) {
    embed.setTimestamp();
  }

  return embed;
}

async function showPerksHelp(message, prefix) {
  const embed = new EmbedBuilder()
    .setColor('#f47fff')
    .setTitle('📢 Booster Perks Announcement Help')
    .setDescription(
      `Create and publish a customizable booster perks announcement!\n\n` +
      `**Channel Setup:**\n` +
      `${GLYPHS.DOT} \`${prefix}boost perks channel #channel\` - Set announcement channel\n\n` +
      `**Content:**\n` +
      `${GLYPHS.DOT} \`${prefix}boost perks message <text>\` - Set description\n` +
      `${GLYPHS.DOT} \`${prefix}boost perks title <text>\` - Set title\n` +
      `${GLYPHS.DOT} \`${prefix}boost perks footer <text>\` - Set footer\n\n` +
      `**Appearance:**\n` +
      `${GLYPHS.DOT} \`${prefix}boost perks color #HEX\` - Set color\n` +
      `${GLYPHS.DOT} \`${prefix}boost perks image <url>\` - Set banner\n` +
      `${GLYPHS.DOT} \`${prefix}boost perks thumbnail <server|url|remove>\`\n\n` +
      `**Actions:**\n` +
      `${GLYPHS.DOT} \`${prefix}boost perks preview\` - Preview announcement\n` +
      `${GLYPHS.DOT} \`${prefix}boost publish\` - Send to channel\n` +
      `${GLYPHS.DOT} \`${prefix}boost perks tierlist on/off\` - Auto-show tiers\n` +
      `${GLYPHS.DOT} \`${prefix}boost perks reset\` - Reset all settings\n\n` +
      `**Variables:** {server}, {boostcount}, {boostlevel}, {membercount}`
    )
    .setFooter({ text: 'This is separate from the boost notification channel!' });

  return message.reply({ embeds: [embed] });
}
