import { PermissionFlagsBits, EmbedBuilder, ChannelType } from 'discord.js';
import Guild from '../../models/Guild.js';
import { successEmbed, errorEmbed, infoEmbed, GLYPHS } from '../../utils/embeds.js';
import { hasModPerms, getAssignableRoleError } from '../../utils/helpers.js';

export default {
  name: 'welcome',
  description: 'Configure new member greeting protocols, Master',
  usage: '<enable|disable|channel|message|embed|dm|test|...>',
  aliases: ['welcomemsg', 'greet'],
  permissions: [PermissionFlagsBits.ManageGuild],
  cooldown: 3,

  async execute(message, args) {
    const guildConfig = await Guild.getGuild(message.guild.id, message.guild.name);

    // Check for moderator permissions (admin, mod role, or ManageGuild)
    if (!hasModPerms(message.member, guildConfig)) {
      return message.reply({
        embeds: [await errorEmbed(message.guild.id, 'Permission Denied',
          `${GLYPHS.LOCK} You need Moderator/Staff permissions to configure welcome messages.`)]
      });
    }

    if (!args[0]) {
      return showStatus(message, guildConfig);
    }

    const action = args[0].toLowerCase();

    switch (action) {
      case 'enable':
      case 'on':
        await Guild.updateGuild(message.guild.id, {
          $set: { 'features.welcomeSystem.enabled': true }
        });
        return message.reply({
          embeds: [await successEmbed(message.guild.id, 'Welcome System Enabled',
            `${GLYPHS.SUCCESS} Welcome messages are now enabled.\n\n` +
            `Make sure to set a channel: \`welcome channel #channel\``)]
        });

      case 'disable':
      case 'off':
        await Guild.updateGuild(message.guild.id, {
          $set: { 'features.welcomeSystem.enabled': false }
        });
        return message.reply({
          embeds: [await successEmbed(message.guild.id, 'Welcome System Disabled',
            `${GLYPHS.SUCCESS} Welcome messages are now disabled.`)]
        });

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
          $set: {
            'features.welcomeSystem.channel': channel.id,
            'channels.welcomeChannel': channel.id
          }
        });

        return message.reply({
          embeds: [await successEmbed(message.guild.id, 'Welcome Channel Set',
            `${GLYPHS.SUCCESS} Welcome messages will be sent to ${channel}`)]
        });

      case 'message':
      case 'msg':
      case 'description':
      case 'desc':
        const welcomeMsg = args.slice(1).join(' ');

        if (!welcomeMsg) {
          return message.reply({
            embeds: [await infoEmbed(message.guild.id, 'Welcome Message Variables',
              `**Current Message:**\n${guildConfig.features.welcomeSystem.message || 'Not set'}\n\n` +
              `**Available Variables:**\n` +
              `${GLYPHS.DOT} \`{user}\` - Mentions the user\n` +
              `${GLYPHS.DOT} \`{username}\` - User's username\n` +
              `${GLYPHS.DOT} \`{displayname}\` - User's display name\n` +
              `${GLYPHS.DOT} \`{tag}\` - User's tag\n` +
              `${GLYPHS.DOT} \`{id}\` - User's ID\n` +
              `${GLYPHS.DOT} \`{server}\` - Server name\n` +
              `${GLYPHS.DOT} \`{membercount}\` - Total member count\n` +
              `${GLYPHS.DOT} \`{usercreated}\` - Account creation date\n` +
              `${GLYPHS.DOT} \`{avatar}\` - User's avatar URL\n` +
              `${GLYPHS.DOT} \`\\n\` - New line\n\n` +
              `**Example:**\n\`welcome message ₊˚⊹☆ Welcome to {server}!\\n₊˚⊹☆ Read <#rules>!\``)]
          });
        }

        await Guild.updateGuild(message.guild.id, {
          $set: { 'features.welcomeSystem.message': welcomeMsg }
        });

        return message.reply({
          embeds: [await successEmbed(message.guild.id, 'Welcome Message Set',
            `${GLYPHS.SUCCESS} Welcome message has been updated.\n\n` +
            `**Preview:**\n${parseWelcomeMessage(welcomeMsg, message.member)}`)]
        });

      case 'embed':
        const embedOption = args[1]?.toLowerCase();

        if (!['on', 'off', 'enable', 'disable'].includes(embedOption)) {
          return message.reply({
            embeds: [await errorEmbed(message.guild.id, 'Invalid Option',
              'Use `welcome embed on` or `welcome embed off`')]
          });
        }

        const embedEnabled = ['on', 'enable'].includes(embedOption);
        await Guild.updateGuild(message.guild.id, {
          $set: { 'features.welcomeSystem.embedEnabled': embedEnabled }
        });

        return message.reply({
          embeds: [await successEmbed(message.guild.id, 'Embed Setting Updated',
            `${GLYPHS.SUCCESS} Welcome embeds are now **${embedEnabled ? 'enabled' : 'disabled'}**`)]
        });

      case 'dm':
        const dmOption = args[1]?.toLowerCase();

        if (!['on', 'off', 'enable', 'disable'].includes(dmOption)) {
          return message.reply({
            embeds: [await errorEmbed(message.guild.id, 'Invalid Option',
              'Use `welcome dm on` or `welcome dm off`')]
          });
        }

        const dmEnabled = ['on', 'enable'].includes(dmOption);
        await Guild.updateGuild(message.guild.id, {
          $set: { 'features.welcomeSystem.dmWelcome': dmEnabled }
        });

        return message.reply({
          embeds: [await successEmbed(message.guild.id, 'DM Setting Updated',
            `${GLYPHS.SUCCESS} DM welcome messages are now **${dmEnabled ? 'enabled' : 'disabled'}**`)]
        });

      case 'test':
        return sendTestWelcome(message, guildConfig);

      case 'image':
      case 'banner':
        const imageUrl = args[1];

        if (!imageUrl) {
          return message.reply({
            embeds: [await infoEmbed(message.guild.id, 'Welcome Banner',
              guildConfig.features.welcomeSystem.bannerUrl
                ? `**Current Banner:**\n${guildConfig.features.welcomeSystem.bannerUrl}`
                : 'No banner set. Use `welcome image <url>` to set one, or `welcome image remove` to remove.')]
          });
        }

        if (imageUrl === 'remove' || imageUrl === 'none') {
          await Guild.updateGuild(message.guild.id, {
            $set: { 'features.welcomeSystem.bannerUrl': null }
          });
          return message.reply({
            embeds: [await successEmbed(message.guild.id, 'Banner Removed',
              `${GLYPHS.SUCCESS} Welcome banner has been removed.`)]
          });
        }

        // More lenient URL validation - just check if it's a valid URL
        if (!imageUrl.match(/^https?:\/\/.+/i)) {
          return message.reply({
            embeds: [await errorEmbed(message.guild.id, 'Invalid URL',
              'Please provide a valid image URL starting with http:// or https://')]
          });
        }

        await Guild.updateGuild(message.guild.id, {
          $set: { 'features.welcomeSystem.bannerUrl': imageUrl }
        });

        return message.reply({
          embeds: [await successEmbed(message.guild.id, 'Banner Set',
            `${GLYPHS.SUCCESS} Welcome banner has been set.`)]
        });

      case 'thumbnail':
      case 'thumb':
        const thumbUrl = args[1];

        if (!thumbUrl) {
          return message.reply({
            embeds: [await infoEmbed(message.guild.id, 'Welcome Thumbnail',
              guildConfig.features.welcomeSystem.thumbnailUrl
                ? `**Current Thumbnail:**\n${guildConfig.features.welcomeSystem.thumbnailUrl}`
                : 'No thumbnail set.\n\n' +
                '`welcome thumbnail <url>` - Set custom thumbnail\n' +
                '`welcome thumbnail avatar` - Use user\'s avatar\n' +
                '`welcome thumbnail server` - Use server icon\n' +
                '`welcome thumbnail remove` - Remove thumbnail')]
          });
        }

        if (thumbUrl === 'remove' || thumbUrl === 'none' || thumbUrl === 'off') {
          await Guild.updateGuild(message.guild.id, {
            $set: { 'features.welcomeSystem.thumbnailUrl': null, 'features.welcomeSystem.thumbnailType': null }
          });
          return message.reply({
            embeds: [await successEmbed(message.guild.id, 'Thumbnail Removed',
              `${GLYPHS.SUCCESS} Welcome thumbnail has been removed.`)]
          });
        }

        if (thumbUrl === 'avatar' || thumbUrl === 'user') {
          await Guild.updateGuild(message.guild.id, {
            $set: { 'features.welcomeSystem.thumbnailType': 'avatar', 'features.welcomeSystem.thumbnailUrl': null }
          });
          return message.reply({
            embeds: [await successEmbed(message.guild.id, 'Thumbnail Set',
              `${GLYPHS.SUCCESS} Thumbnail will show the user's avatar.`)]
          });
        }

        if (thumbUrl === 'server' || thumbUrl === 'guild') {
          await Guild.updateGuild(message.guild.id, {
            $set: { 'features.welcomeSystem.thumbnailType': 'server', 'features.welcomeSystem.thumbnailUrl': null }
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
          $set: { 'features.welcomeSystem.thumbnailUrl': thumbUrl, 'features.welcomeSystem.thumbnailType': 'custom' }
        });

        return message.reply({
          embeds: [await successEmbed(message.guild.id, 'Thumbnail Set',
            `${GLYPHS.SUCCESS} Welcome thumbnail has been set.`)]
        });

      case 'title':
        const titleText = args.slice(1).join(' ');

        if (!titleText) {
          return message.reply({
            embeds: [await infoEmbed(message.guild.id, 'Embed Title',
              `**Current Title:**\n${guildConfig.features.welcomeSystem.embedTitle || 'Default decorative stars'}\n\n` +
              `Use \`welcome title <text>\` to set a custom title.\n` +
              `Use \`welcome title reset\` for default stars.\n` +
              `Use \`welcome title none\` to remove title entirely.\n\n` +
              `**Variables:** {username}, {server}, {membercount}`)]
          });
        }

        if (titleText === 'reset' || titleText === 'default') {
          await Guild.updateGuild(message.guild.id, {
            $set: { 'features.welcomeSystem.embedTitle': null }
          });
          return message.reply({
            embeds: [await successEmbed(message.guild.id, 'Title Reset',
              `${GLYPHS.SUCCESS} Welcome embed title reset to default decorative style.`)]
          });
        }

        if (titleText === 'none' || titleText === 'remove') {
          await Guild.updateGuild(message.guild.id, {
            $set: { 'features.welcomeSystem.embedTitle': ' ' }
          });
          return message.reply({
            embeds: [await successEmbed(message.guild.id, 'Title Removed',
              `${GLYPHS.SUCCESS} Welcome embed title has been removed.`)]
          });
        }

        await Guild.updateGuild(message.guild.id, {
          $set: { 'features.welcomeSystem.embedTitle': titleText }
        });

        return message.reply({
          embeds: [await successEmbed(message.guild.id, 'Title Set',
            `${GLYPHS.SUCCESS} Welcome embed title set to:\n${titleText}`)]
        });

      case 'color':
      case 'colour':
        const colorValue = args[1];

        if (!colorValue) {
          return message.reply({
            embeds: [await infoEmbed(message.guild.id, 'Embed Color',
              `**Current Color:** ${guildConfig.features.welcomeSystem.embedColor || 'Default'}\n\n` +
              `Use \`welcome color #HEX\` to set (e.g., \`welcome color #5432A6\`)\n` +
              `Use \`welcome color reset\` for default color.`)]
          });
        }

        if (colorValue === 'reset' || colorValue === 'default') {
          await Guild.updateGuild(message.guild.id, {
            $set: { 'features.welcomeSystem.embedColor': null }
          });
          return message.reply({
            embeds: [await successEmbed(message.guild.id, 'Color Reset',
              `${GLYPHS.SUCCESS} Welcome embed color reset to default.`)]
          });
        }

        if (!colorValue.match(/^#?[0-9A-Fa-f]{6}$/)) {
          return message.reply({
            embeds: [await errorEmbed(message.guild.id, 'Invalid Color',
              'Please provide a valid hex color (e.g., `#5432A6`)')]
          });
        }

        const hex = colorValue.startsWith('#') ? colorValue : `#${colorValue}`;
        await Guild.updateGuild(message.guild.id, {
          $set: { 'features.welcomeSystem.embedColor': hex }
        });

        return message.reply({
          embeds: [await successEmbed(message.guild.id, 'Color Set',
            `${GLYPHS.SUCCESS} Welcome embed color set to \`${hex}\``)]
        });

      case 'mention':
      case 'ping':
        const mentionOption = args[1]?.toLowerCase();

        if (!['on', 'off', 'enable', 'disable'].includes(mentionOption)) {
          return message.reply({
            embeds: [await errorEmbed(message.guild.id, 'Invalid Option',
              'Use `welcome mention on` or `welcome mention off`\n\n' +
              'When enabled, sends "welcome, @user!" above the embed (Mimu style).')]
          });
        }

        const mentionEnabled = ['on', 'enable'].includes(mentionOption);
        await Guild.updateGuild(message.guild.id, {
          $set: { 'features.welcomeSystem.mentionUser': mentionEnabled }
        });

        return message.reply({
          embeds: [await successEmbed(message.guild.id, 'Mention Setting Updated',
            `${GLYPHS.SUCCESS} User mention above embed is now **${mentionEnabled ? 'enabled' : 'disabled'}**`)]
        });

      case 'greet':
      case 'greeting':
      case 'content':
        const greetText = args.slice(1).join(' ');

        if (!greetText) {
          return message.reply({
            embeds: [await infoEmbed(message.guild.id, 'Greeting Text',
              `**Current Greeting:**\n${guildConfig.features.welcomeSystem.greetingText || 'welcome, {user}!'}\n\n` +
              `This is the text shown ABOVE the embed when mention is enabled.\n\n` +
              `Use \`welcome greet <text>\` to customize.\n` +
              `Use \`welcome greet reset\` for default.\n\n` +
              `**Variables:** {user}, {username}, {server}`)]
          });
        }

        if (greetText === 'reset' || greetText === 'default') {
          await Guild.updateGuild(message.guild.id, {
            $set: { 'features.welcomeSystem.greetingText': null }
          });
          return message.reply({
            embeds: [await successEmbed(message.guild.id, 'Greeting Reset',
              `${GLYPHS.SUCCESS} Greeting text reset to "welcome, @user!"`)]
          });
        }

        await Guild.updateGuild(message.guild.id, {
          $set: { 'features.welcomeSystem.greetingText': greetText }
        });

        return message.reply({
          embeds: [await successEmbed(message.guild.id, 'Greeting Set',
            `${GLYPHS.SUCCESS} Greeting text set to:\n${greetText.replace(/{user}/gi, message.author)}`)]
        });

      case 'footer':
        const footerText = args.slice(1).join(' ');

        if (!footerText) {
          return message.reply({
            embeds: [await infoEmbed(message.guild.id, 'Footer Text',
              `**Current Footer:**\n${guildConfig.features.welcomeSystem.footerText || 'Member #{membercount}'}\n\n` +
              `Use \`welcome footer <text>\` to customize.\n` +
              `Use \`welcome footer reset\` for default.\n` +
              `Use \`welcome footer none\` to remove footer.\n\n` +
              `**Variables:** {username}, {server}, {membercount}`)]
          });
        }

        if (footerText === 'reset' || footerText === 'default') {
          await Guild.updateGuild(message.guild.id, {
            $set: { 'features.welcomeSystem.footerText': null }
          });
          return message.reply({
            embeds: [await successEmbed(message.guild.id, 'Footer Reset',
              `${GLYPHS.SUCCESS} Footer text reset to default.`)]
          });
        }

        if (footerText === 'none' || footerText === 'remove') {
          await Guild.updateGuild(message.guild.id, {
            $set: { 'features.welcomeSystem.footerText': ' ' }
          });
          return message.reply({
            embeds: [await successEmbed(message.guild.id, 'Footer Removed',
              `${GLYPHS.SUCCESS} Footer has been removed.`)]
          });
        }

        await Guild.updateGuild(message.guild.id, {
          $set: { 'features.welcomeSystem.footerText': footerText }
        });

        return message.reply({
          embeds: [await successEmbed(message.guild.id, 'Footer Set',
            `${GLYPHS.SUCCESS} Footer text set to: ${footerText}`)]
        });

      case 'author':
        const authorOption = args[1]?.toLowerCase();

        if (!authorOption) {
          return message.reply({
            embeds: [await infoEmbed(message.guild.id, 'Author Settings',
              `**Current:** ${guildConfig.features.welcomeSystem.authorType || 'username (with avatar)'}\n\n` +
              `\`welcome author username\` - Show username with avatar\n` +
              `\`welcome author displayname\` - Show display name with avatar\n` +
              `\`welcome author server\` - Show server name with icon\n` +
              `\`welcome author none\` - No author section`)]
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
          $set: { 'features.welcomeSystem.authorType': authorType }
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
              'Use `welcome timestamp on` or `welcome timestamp off`')]
          });
        }

        const timestampEnabled = ['on', 'enable'].includes(timestampOption);
        await Guild.updateGuild(message.guild.id, {
          $set: { 'features.welcomeSystem.showTimestamp': timestampEnabled }
        });

        return message.reply({
          embeds: [await successEmbed(message.guild.id, 'Timestamp Setting Updated',
            `${GLYPHS.SUCCESS} Timestamp is now **${timestampEnabled ? 'enabled' : 'disabled'}**`)]
        });

      case 'autorole':
      case 'role':
        const roleArg = args[1];

        if (!roleArg) {
          const currentRole = guildConfig.features.welcomeSystem.autoRole
            ? message.guild.roles.cache.get(guildConfig.features.welcomeSystem.autoRole)
            : null;
          return message.reply({
            embeds: [await infoEmbed(message.guild.id, 'Welcome Auto Role',
              `**Current Role:** ${currentRole || 'None'}\n\n` +
              `Use \`welcome role @role\` to set a role given on join.\n` +
              `Use \`welcome role remove\` to disable.`)]
          });
        }

        if (roleArg === 'remove' || roleArg === 'none') {
          await Guild.updateGuild(message.guild.id, {
            $set: { 'features.welcomeSystem.autoRole': null }
          });
          return message.reply({
            embeds: [await successEmbed(message.guild.id, 'Auto Role Removed',
              `${GLYPHS.SUCCESS} Welcome auto role has been disabled.`)]
          });
        }

        const role = message.mentions.roles.first() || message.guild.roles.cache.get(roleArg);
        if (!role) {
          return message.reply({
            embeds: [await errorEmbed(message.guild.id, 'Role Not Found',
              'Please mention a role or provide a valid role ID.')]
          });
        }

        const roleError = getAssignableRoleError(role, message.member);
        if (roleError) {
          return message.reply({ embeds: [await errorEmbed(message.guild.id, 'Role Not Allowed', roleError)] });
        }

        await Guild.updateGuild(message.guild.id, {
          $set: { 'features.welcomeSystem.autoRole': role.id }
        });

        return message.reply({
          embeds: [await successEmbed(message.guild.id, 'Auto Role Set',
            `${GLYPHS.SUCCESS} New members will receive ${role}`)]
        });

      case 'preview':
        return showPreview(message, guildConfig);

      case 'reset':
        await Guild.updateGuild(message.guild.id, {
          $set: {
            'features.welcomeSystem': {
              enabled: false,
              channel: null,
              message: null,
              embedEnabled: true,
              dmWelcome: false,
              bannerUrl: null,
              thumbnailUrl: null,
              thumbnailType: null,
              embedTitle: null,
              embedColor: null,
              mentionUser: false,
              greetingText: null,
              footerText: null,
              authorType: 'username',
              showTimestamp: true,
              autoRole: null
            }
          }
        });

        return message.reply({
          embeds: [await successEmbed(message.guild.id, 'Welcome System Reset',
            `${GLYPHS.SUCCESS} All welcome settings have been reset to defaults.`)]
        });

      case 'help':
        return showHelp(message, guildConfig);

      default:
        return showStatus(message, guildConfig);
    }
  }
};

async function showStatus(message, guildConfig) {
  const welcome = guildConfig.features.welcomeSystem || {};
  const channel = welcome.channel ? message.guild.channels.cache.get(welcome.channel) : null;
  const autoRole = welcome.autoRole ? message.guild.roles.cache.get(welcome.autoRole) : null;

  const embed = await infoEmbed(message.guild.id, '『 Welcome System Status 』',
    `**▸ Status:** ${welcome.enabled ? '◉ Active' : '○ Inactive'}\n` +
    `**▸ Channel:** ${channel || 'Not configured'}\n` +
    `**▸ Embed Mode:** ${welcome.embedEnabled !== false ? '◉' : '○'}\n` +
    `**▸ DM Welcome:** ${welcome.dmWelcome ? '◉' : '○'}\n` +
    `**▸ Mention User:** ${welcome.mentionUser ? '◉' : '○'}\n` +
    `**▸ Timestamp:** ${welcome.showTimestamp !== false ? '◉' : '○'}\n` +
    `**▸ Auto Role:** ${autoRole || 'None'}\n\n` +
    `**▸ Color:** ${welcome.embedColor || 'Default'}\n` +
    `**▸ Title:** ${welcome.embedTitle ? 'Custom' : 'Decorative stars'}\n` +
    `**▸ Author:** ${welcome.authorType || 'username'}\n` +
    `**▸ Thumbnail:** ${welcome.thumbnailType || welcome.thumbnailUrl || 'None'}\n` +
    `**▸ Banner:** ${welcome.bannerUrl ? '◉ Set' : '○ Not set'}\n\n` +
    `**Current Message:**\n\`\`\`${welcome.message || 'Welcome {user} to {server}!'}\`\`\`\n` +
    `Type \`welcome help\` for all commands.`
  );

  return message.reply({ embeds: [embed] });
}

async function showHelp(message, guildConfig) {
  const helpEmbed = await infoEmbed(message.guild.id, '『 Welcome Commands 』',
    `**Basic:**\n` +
    `${GLYPHS.DOT} \`welcome enable/disable\` - Toggle system\n` +
    `${GLYPHS.DOT} \`welcome channel #channel\` - Set welcome channel\n` +
    `${GLYPHS.DOT} \`welcome test\` - Test welcome message\n` +
    `${GLYPHS.DOT} \`welcome preview\` - Preview current settings\n` +
    `${GLYPHS.DOT} \`welcome reset\` - Reset all settings\n\n` +
    `**Content:**\n` +
    `${GLYPHS.DOT} \`welcome message <text>\` - Embed description\n` +
    `${GLYPHS.DOT} \`welcome greet <text>\` - Text above embed\n` +
    `${GLYPHS.DOT} \`welcome title <text>\` - Embed title\n` +
    `${GLYPHS.DOT} \`welcome footer <text>\` - Footer text\n\n` +
    `**Appearance:**\n` +
    `${GLYPHS.DOT} \`welcome color #HEX\` - Embed color\n` +
    `${GLYPHS.DOT} \`welcome image <url>\` - Banner image\n` +
    `${GLYPHS.DOT} \`welcome thumbnail <url|avatar|server>\`\n` +
    `${GLYPHS.DOT} \`welcome author <username|displayname|server|none>\`\n\n` +
    `**Toggles:**\n` +
    `${GLYPHS.DOT} \`welcome embed on/off\` - Toggle embed mode\n` +
    `${GLYPHS.DOT} \`welcome mention on/off\` - Ping user above embed\n` +
    `${GLYPHS.DOT} \`welcome dm on/off\` - Send DM on join\n` +
    `${GLYPHS.DOT} \`welcome timestamp on/off\` - Show timestamp\n` +
    `${GLYPHS.DOT} \`welcome role @role\` - Auto role on join`
  );

  const varsEmbed = await infoEmbed(message.guild.id, '『 Variables 』',
    `Use these in message, title, footer, or greet:\n\n` +
    `${GLYPHS.DOT} \`{user}\` - Mentions the user (@user)\n` +
    `${GLYPHS.DOT} \`{username}\` - Username\n` +
    `${GLYPHS.DOT} \`{displayname}\` - Display name\n` +
    `${GLYPHS.DOT} \`{tag}\` - User's tag\n` +
    `${GLYPHS.DOT} \`{id}\` - User's ID\n` +
    `${GLYPHS.DOT} \`{server}\` - Server name\n` +
    `${GLYPHS.DOT} \`{membercount}\` - Member count\n` +
    `${GLYPHS.DOT} \`{usercreated}\` - Account age\n` +
    `${GLYPHS.DOT} \`{avatar}\` - Avatar URL\n` +
    `${GLYPHS.DOT} \`\\n\` - New line`
  );

  return message.reply({ embeds: [helpEmbed, varsEmbed] });
}

async function showPreview(message, guildConfig) {
  const welcome = guildConfig.features.welcomeSystem || {};
  const { embed, content } = buildWelcomeEmbed(message.member, welcome, guildConfig);

  await message.reply({
    embeds: [await infoEmbed(message.guild.id, 'Welcome Preview',
      'Here\'s how your welcome message will look:')]
  });

  await message.channel.send({ content, embeds: embed ? [embed] : undefined });
}

async function sendTestWelcome(message, guildConfig) {
  const welcome = guildConfig.features.welcomeSystem || {};
  const channel = welcome.channel ? message.guild.channels.cache.get(welcome.channel) : message.channel;

  if (!channel) {
    return message.reply({
      embeds: [await errorEmbed(message.guild.id, 'No Channel',
        'Welcome channel is not set. Use `welcome channel #channel` to set one.')]
    });
  }

  const { embed, content } = buildWelcomeEmbed(message.member, welcome, guildConfig);

  if (embed) {
    await channel.send({ content, embeds: [embed] });
  } else {
    const welcomeMsg = parseWelcomeMessage(welcome.message || 'Welcome {user} to {server}!', message.member);
    await channel.send(content || welcomeMsg);
  }

  return message.reply({
    embeds: [await successEmbed(message.guild.id, 'Test Sent',
      `${GLYPHS.SUCCESS} Test welcome message sent to ${channel}`)]
  });
}

/**
 * Build the welcome embed based on settings
 */
function buildWelcomeEmbed(member, welcome, guildConfig) {
  if (!welcome.embedEnabled && welcome.embedEnabled !== undefined) {
    // Plain text mode
    const welcomeMsg = parseWelcomeMessage(welcome.message || 'Welcome {user} to {server}!', member);
    return { embed: null, content: welcomeMsg };
  }

  // Decorative title with stars (Mimu style)
  const decorativeTitle = '˚　　　　✦　　　.　　. 　 ˚　.　　　　　 . ✦　　　 　˚　　　　 . ★⋆. ࿐࿔  　　　.　　 　　˚　　 　　*　　 　　✦　　　.　　.　　　✦　˚ 　　　　 ˚　.˚　　　　✦　　　.　　. 　 ˚　.　　　　 　　 　　　　        ੈ✧̣̇˳·˖✶   ✦';

  const welcomeMsg = parseWelcomeMessage(welcome.message || 'Welcome {user} to {server}!', member);

  const embed = new EmbedBuilder()
    .setColor(welcome.embedColor || guildConfig?.embedStyle?.color || '#5865F2');

  // Author section
  const authorType = welcome.authorType || 'username';
  if (authorType !== 'none') {
    if (authorType === 'server') {
      embed.setAuthor({
        name: member.guild.name,
        iconURL: member.guild.iconURL({ dynamic: true, size: 128 })
      });
    } else if (authorType === 'displayname') {
      embed.setAuthor({
        name: member.displayName || member.user.displayName || member.user.username,
        iconURL: member.user.displayAvatarURL({ dynamic: true, size: 128 })
      });
    } else {
      embed.setAuthor({
        name: member.user.username,
        iconURL: member.user.displayAvatarURL({ dynamic: true, size: 128 })
      });
    }
  }

  // Title
  const title = welcome.embedTitle;
  if (title && title.trim()) {
    embed.setTitle(parseWelcomeMessage(title, member));
  } else if (title !== ' ') {
    embed.setTitle(decorativeTitle);
  }

  // Description
  embed.setDescription(welcomeMsg);

  // Thumbnail
  if (welcome.thumbnailType === 'avatar') {
    embed.setThumbnail(member.user.displayAvatarURL({ dynamic: true, size: 256 }));
  } else if (welcome.thumbnailType === 'server') {
    embed.setThumbnail(member.guild.iconURL({ dynamic: true, size: 256 }));
  } else if (welcome.thumbnailUrl) {
    embed.setThumbnail(welcome.thumbnailUrl);
  }

  // Footer
  const footerText = welcome.footerText;
  if (footerText && footerText.trim() && footerText !== ' ') {
    embed.setFooter({ text: parseWelcomeMessage(footerText, member) });
  } else if (footerText !== ' ') {
    embed.setFooter({ text: `Member #${member.guild.memberCount}` });
  }

  // Timestamp
  if (welcome.showTimestamp !== false) {
    embed.setTimestamp();
  }

  // Banner image
  if (welcome.bannerUrl) {
    embed.setImage(welcome.bannerUrl);
  }

  // Build greeting content (text above embed)
  let content = undefined;
  if (welcome.mentionUser) {
    const greetingTemplate = welcome.greetingText || 'welcome, {user}!';
    content = parseWelcomeMessage(greetingTemplate, member);
  }

  return { embed, content };
}

/**
 * Parse welcome message with variables
 */
function parseWelcomeMessage(msg, member) {
  return msg
    .replace(/{user}/gi, `<@${member.user.id}>`)
    .replace(/{username}/gi, member.user.username)
    .replace(/{displayname}/gi, member.displayName || member.user.displayName || member.user.username)
    .replace(/{tag}/gi, member.user.tag)
    .replace(/{id}/gi, member.user.id)
    .replace(/{server}/gi, member.guild.name)
    .replace(/{membercount}/gi, member.guild.memberCount.toString())
    .replace(/{usercreated}/gi, `<t:${Math.floor(member.user.createdTimestamp / 1000)}:D>`)
    .replace(/{avatar}/gi, member.user.displayAvatarURL({ dynamic: true, size: 256 }))
    .replace(/\\n/g, '\n');
}

export { parseWelcomeMessage, buildWelcomeEmbed };
