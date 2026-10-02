import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { COLORS, errorEmbed } from '../../utils/embeds.js';
import { getRandomFooter } from '../../utils/raphael.js';
import { escapeMarkdown } from '../../utils/helpers.js';

const SNOWFLAKE = /^\d{17,20}$/;
const MAX_SIZE = 4096;
const SIZES = [128, 256, 512, 1024, 4096];

// Size links for a CDN image URL ("128 • 256 • ..."); default avatars have no size option
function formatLinks(url) {
    if (!/size=\d+/.test(url)) return `[Open image](${url})`;
    return SIZES.map(size => `[${size}](${url.replace(/size=\d+/, `size=${size}`)})`).join(' • ');
}

const linkButton = (label, url) => new ButtonBuilder().setLabel(label).setStyle(ButtonStyle.Link).setURL(url);

export default {
    name: 'avatar',
    aliases: ['av', 'pfp', 'icon'],
    description: 'Retrieve a user\'s visual profile image, Master',
    usage: 'avatar [@user | user ID]',
    category: 'utility',
    cooldown: 3,

    async execute(message, args, client) {
        const guildId = message.guild.id;

        try {
            // Target: mention, then a user ID, then the requester
            const user = message.mentions.users.first()
                || (SNOWFLAKE.test(args[0] ?? '') ? await client.users.fetch(args[0]).catch(() => null) : null)
                || message.author;

            // Fetch the member if it is not cached, so server avatars are not missed
            const member = message.guild.members.cache.get(user.id)
                ?? await message.guild.members.fetch(user.id).catch(() => null);

            // Static PNG for the main image; animated avatars get a separate GIF button
            const globalAvatar = user.displayAvatarURL({ extension: 'png', size: MAX_SIZE, forceStatic: true });
            const serverAvatar = member?.avatar
                ? member.avatarURL({ extension: 'png', size: MAX_SIZE, forceStatic: true })
                : null;

            const embed = new EmbedBuilder()
                .setTitle(`『 ${user.username}'s Visual Profile 』`)
                .setDescription(`**Report:** Image data for **${escapeMarkdown(user.username)}** retrieved successfully, Master.`)
                .setColor(COLORS.RAPHAEL)
                .setImage(globalAvatar)
                .setFooter({ text: getRandomFooter() })
                .setTimestamp();

            embed.addFields({
                name: user.avatar ? '▸ Global Image' : '▸ Global Image (default avatar)',
                value: formatLinks(globalAvatar),
                inline: false
            });

            if (serverAvatar) {
                embed.addFields({
                    name: '▸ Server-Specific Image',
                    value: formatLinks(serverAvatar),
                    inline: false
                });
                embed.setThumbnail(serverAvatar);
            }

            // Link buttons for quick access (at most 4, within the 5-per-row limit)
            const row = new ActionRowBuilder().addComponents(linkButton('Global Avatar', globalAvatar));

            if (serverAvatar) {
                row.addComponents(linkButton('Server Avatar', serverAvatar));
            }

            if (user.avatar?.startsWith('a_')) {
                row.addComponents(linkButton('Global GIF', user.displayAvatarURL({ extension: 'gif', size: MAX_SIZE })));
            }

            if (member?.avatar?.startsWith('a_')) {
                row.addComponents(linkButton('Server GIF', member.avatarURL({ extension: 'gif', size: MAX_SIZE })));
            }

            return await message.reply({ embeds: [embed], components: [row] });
        } catch (error) {
            console.error('Avatar command error:', error);
            try {
                await message.reply({
                    embeds: [await errorEmbed(guildId, 'Retrieval Failed', 'The profile image could not be retrieved, Master. Please try again.')]
                });
            } catch {
                // Reply failed too (message deleted or no permission); nothing more to do
            }
        }
    }
};
