import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { COLORS, errorEmbed, infoEmbed } from '../../utils/embeds.js';
import { getRandomFooter } from '../../utils/raphael.js';
import { escapeMarkdown } from '../../utils/helpers.js';

const SNOWFLAKE = /^\d{17,20}$/;
const MAX_SIZE = 4096;
const SIZES = [256, 512, 1024, 2048, 4096];

const linkButton = (label, url) => new ButtonBuilder().setLabel(label).setStyle(ButtonStyle.Link).setURL(url);

export default {
    name: 'banner',
    aliases: ['userbanner', 'profilebanner'],
    description: 'Get a user\'s profile banner in full size',
    usage: 'banner [@user | user ID]',
    category: 'utility',
    cooldown: 3,

    async execute(message, args, client) {
        const guildId = message.guild.id;

        try {
            // Target: mention, then a user ID, then the requester
            const mentioned = message.mentions.users.first();
            if (!mentioned && args[0] && !SNOWFLAKE.test(args[0])) {
                return message.reply({
                    embeds: [await errorEmbed(guildId, 'Invalid Target', 'Specify a user by mention or user ID, Master.')]
                });
            }
            const userId = mentioned?.id || args[0] || message.author.id;

            // Banner and accent color are only present on a forced fetch.
            // Unknown User (10013) / invalid ID (50035) mean "no such user"; anything else is a real failure.
            const user = await client.users.fetch(userId, { force: true }).catch(error => {
                if (error?.code === 10013 || error?.code === 50035) return null;
                throw error;
            });
            if (!user) {
                return message.reply({
                    embeds: [await errorEmbed(guildId, 'User Not Found', 'No user matches that ID, Master.')]
                });
            }

            const name = escapeMarkdown(user.username);

            if (!user.banner) {
                // The profile color is shown instead, when one is set
                if (user.accentColor != null) {
                    const embed = new EmbedBuilder()
                        .setTitle(`『 ${user.username}'s Profile 』`)
                        .setDescription(`**Analysis:** **${name}** has no profile banner, Master. Their profile color is **${user.hexAccentColor}**.`)
                        .setColor(user.accentColor)
                        .setThumbnail(user.displayAvatarURL({ extension: 'png', size: 256 }))
                        .setFooter({ text: getRandomFooter() })
                        .setTimestamp();

                    return message.reply({ embeds: [embed] });
                }

                return message.reply({
                    embeds: [await infoEmbed(guildId, 'No Banner', `**Analysis:** **${name}** has no profile banner or profile color, Master.`)]
                });
            }

            // Static PNG for the main image; animated banners get a separate GIF button
            const bannerUrl = user.bannerURL({ extension: 'png', size: MAX_SIZE, forceStatic: true });

            const sizeLinks = SIZES
                .map(size => `[${size}](${bannerUrl.replace(/size=\d+/, `size=${size}`)})`)
                .join(' • ');

            const embed = new EmbedBuilder()
                .setTitle(`『 ${user.username}'s Banner 』`)
                .setDescription(`**Report:** Banner data for **${name}** retrieved successfully, Master.`)
                .setColor(user.accentColor ?? COLORS.RAPHAEL)
                .setImage(bannerUrl)
                .addFields({ name: '▸ Sizes', value: sizeLinks, inline: false })
                .setFooter({ text: getRandomFooter() })
                .setTimestamp();

            const row = new ActionRowBuilder().addComponents(linkButton('Open Banner', bannerUrl));

            if (user.banner.startsWith('a_')) {
                row.addComponents(linkButton('GIF Version', user.bannerURL({ extension: 'gif', size: MAX_SIZE })));
            }

            return await message.reply({ embeds: [embed], components: [row] });

        } catch (error) {
            console.error('Banner fetch error:', error);
            try {
                await message.reply({
                    embeds: [await errorEmbed(guildId, 'Retrieval Failed', 'The user banner could not be retrieved, Master. Please try again.')]
                });
            } catch {
                // Reply failed too (message deleted or no permission); nothing more to do
            }
        }
    }
};
