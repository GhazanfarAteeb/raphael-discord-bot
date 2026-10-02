import { PermissionFlagsBits, ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType, EmbedBuilder, MessageFlags, ModalBuilder, TextInputBuilder, TextInputStyle } from 'discord.js';
import { successEmbed, errorEmbed, infoEmbed, COLORS, GLYPHS } from '../../utils/embeds.js';
import { getPrefix } from '../../utils/helpers.js';
import { getRandomFooter } from '../../utils/raphael.js';

const OPTIONS_TIMEOUT_MS = 60000; // buttons
const MODAL_TIMEOUT_MS = 120000; // name prompt
const EMOJI_NAME_MAX = 32;
const STICKER_NAME_MAX = 30;
const MAX_ERROR_DETAIL = 1000;
const CUSTOM_EMOJI_PATTERN = /<(a)?:(\w{2,32}):(\d{17,19})>/g;
// Sticker formats: 1 PNG, 2 APNG, 3 Lottie, 4 GIF
const ANIMATED_STICKER_FORMATS = [2, 4];

export default {
    name: 'steal',
    aliases: ['addemoji', 'stealemoji', 'yoink'],
    description: 'Add an emoji or sticker from another server, URL, or replied message to this server',
    usage: 'steal [emoji or URL] [name] OR reply to a message with steal [name]',
    category: 'utility',
    cooldown: 5,
    permissions: ['ManageGuildExpressions'],

    async execute(message, args, client) {
        const guildId = message.guild.id;

        try {
            const prefix = await getPrefix(guildId);

            // Check permissions
            if (!message.member.permissions.has(PermissionFlagsBits.ManageGuildExpressions)) {
                return await message.reply({
                    embeds: [await errorEmbed(guildId, 'You require the **Manage Expressions** permission to add emojis or stickers, Master.')]
                });
            }

            if (!message.guild.members.me.permissions.has(PermissionFlagsBits.ManageGuildExpressions)) {
                return await message.reply({
                    embeds: [await errorEmbed(guildId, 'I require the **Manage Expressions** permission to add emojis or stickers, Master.')]
                });
            }

            // Check if replying to a message
            const repliedMessage = message.reference ? await message.channel.messages.fetch(message.reference.messageId).catch(() => null) : null;

            // Collect stealable items from replied message
            const stealableItems = repliedMessage ? collectStealableItems(repliedMessage, args) : [];

            // If we have stealable items from reply, show options
            if (stealableItems.length > 0) {
                const customName = args[0] || null;

                // One or more items - use the first emoji, sticker or image found
                const item = stealableItems[0];
                const itemName = customName || item.name;

                return await showStealOptions(message, item, itemName, guildId);
            }

            // No reply or no stealable items in reply - check args
            if (!args[0] && !repliedMessage) {
                return await message.reply({
                    embeds: [await errorEmbed(guildId,
                        'Please provide an emoji, an image URL, or reply to a message, Master.\n\n' +
                        '**Usage:**\n' +
                        `\`${prefix}steal :emoji:\` - Steal an emoji from another server\n` +
                        `\`${prefix}steal :emoji: newname\` - Steal with a custom name\n` +
                        `\`${prefix}steal <url> name\` - Add emoji from image URL\n` +
                        `Reply to a message with \`${prefix}steal [name]\` - Steal emoji/sticker from the replied message`
                    )]
                });
            }

            if (!args[0] && repliedMessage) {
                return await message.reply({
                    embeds: [await errorEmbed(guildId, 'No stealable emoji, sticker, or image was found in the replied message, Master.')]
                });
            }

            let emojiUrl = null;
            let emojiName = args[1] || null;
            let isAnimated = false;

            // Check if it's a custom emoji
            const emojiRegex = /<?(a)?:?(\w{2,32}):(\d{17,19})>?/;
            const emojiMatch = args[0].match(emojiRegex);

            if (emojiMatch) {
                isAnimated = !!emojiMatch[1];
                emojiName = emojiName || emojiMatch[2];
                const emojiId = emojiMatch[3];
                emojiUrl = `https://cdn.discordapp.com/emojis/${emojiId}.${isAnimated ? 'gif' : 'png'}?size=128`;
            }
            // Check if it's a URL
            else if (args[0].match(/^https?:\/\/.+\.(png|jpg|jpeg|gif|webp)/i)) {
                emojiUrl = args[0];
                isAnimated = args[0].toLowerCase().endsWith('.gif');

                if (!emojiName) {
                    return await message.reply({
                        embeds: [await errorEmbed(guildId, `Please provide a name for the emoji, Master.\n\n\`${prefix}steal <url> <name>\``)]
                    });
                }
            }
            // Check for emoji in message attachments
            else if (message.attachments?.size > 0) {
                const attachment = message.attachments.first();
                if (attachment.contentType?.startsWith('image/')) {
                    emojiUrl = attachment.url;
                    emojiName = args[0];
                    isAnimated = attachment.contentType === 'image/gif';
                }
            }

            if (!emojiUrl) {
                return await message.reply({
                    embeds: [await errorEmbed(guildId, 'No valid emoji or image URL could be identified, Master.')]
                });
            }

            // Validate emoji name
            if (!emojiName || emojiName.length < 2 || emojiName.length > EMOJI_NAME_MAX) {
                return await message.reply({
                    embeds: [await errorEmbed(guildId, `The emoji name must be between 2 and ${EMOJI_NAME_MAX} characters, Master.`)]
                });
            }

            // Remove invalid characters from name
            emojiName = emojiName.replace(/[^a-zA-Z0-9_]/g, '_');

            // Show steal options with buttons
            const item = {
                type: 'emoji',
                name: emojiName,
                url: emojiUrl,
                isAnimated
            };

            return await showStealOptions(message, item, emojiName, guildId);
        } catch (error) {
            console.error('[Steal] Error in steal command:', error);
            try {
                return await message.reply({
                    embeds: [await errorEmbed(guildId, 'The acquisition request could not be processed, Master. Please try again.')]
                });
            } catch (replyError) {
                console.error('[Steal] Failed to send error reply:', replyError);
            }
        }
    }
};

function stickerItem(sticker) {
    return {
        type: 'sticker',
        name: sticker.name,
        url: sticker.url,
        id: sticker.id,
        format: sticker.format,
        isAnimated: ANIMATED_STICKER_FORMATS.includes(sticker.format)
    };
}

function emojiItemsFromContent(content) {
    const items = [];
    for (const match of (content || '').matchAll(CUSTOM_EMOJI_PATTERN)) {
        const isAnimated = !!match[1];
        const emojiName = match[2];
        const emojiId = match[3];
        items.push({
            type: 'emoji',
            name: emojiName,
            id: emojiId,
            url: `https://cdn.discordapp.com/emojis/${emojiId}.${isAnimated ? 'gif' : 'png'}?size=128`,
            isAnimated
        });
    }
    return items;
}

// Stickers, custom emojis, image attachments and image embeds found in a replied
// (or forwarded) message, without duplicate URLs
function collectStealableItems(repliedMessage, args) {
    const stealableItems = [];

    // Check if it's a forwarded message (has messageSnapshots)
    if (repliedMessage.messageSnapshots?.size > 0) {
        for (const snapshot of repliedMessage.messageSnapshots.values()) {
            // Check for stickers in forwarded message
            if (snapshot.stickers?.size > 0) {
                for (const sticker of snapshot.stickers.values()) {
                    stealableItems.push(stickerItem(sticker));
                }
            }

            // Check for custom emojis in forwarded message content
            stealableItems.push(...emojiItemsFromContent(snapshot.content));

            // Check for image attachments in forwarded message
            if (snapshot.attachments?.size > 0) {
                for (const attachment of snapshot.attachments.values()) {
                    if (attachment.contentType?.startsWith('image/')) {
                        stealableItems.push({
                            type: 'image',
                            name: args[0] || attachment.name?.split('.')[0] || 'stolen',
                            url: attachment.url,
                            isAnimated: attachment.contentType === 'image/gif'
                        });
                    }
                }
            }

            // Check for embeds with images/GIFs in forwarded message
            if (snapshot.embeds?.length > 0) {
                for (const embed of snapshot.embeds) {
                    if (embed.video?.url) {
                        const gifUrl = embed.thumbnail?.url || embed.image?.url;
                        if (gifUrl) {
                            stealableItems.push({
                                type: 'image',
                                name: args[0] || '',
                                url: gifUrl,
                                isAnimated: true
                            });
                        }
                    } else if (embed.image?.url) {
                        stealableItems.push({
                            type: 'image',
                            name: args[0] || '',
                            url: embed.image.url,
                            isAnimated: embed.image.url.toLowerCase().includes('.gif')
                        });
                    } else if (embed.thumbnail?.url && !embed.video) {
                        stealableItems.push({
                            type: 'image',
                            name: args[0] || '',
                            url: embed.thumbnail.url,
                            isAnimated: embed.thumbnail.url.toLowerCase().includes('.gif')
                        });
                    }
                }
            }
        }
    }

    // Check for stickers in replied message (non-forwarded)
    if (repliedMessage.stickers?.size > 0) {
        for (const sticker of repliedMessage.stickers.values()) {
            stealableItems.push(stickerItem(sticker));
        }
    }

    // Check for custom emojis in replied message content
    stealableItems.push(...emojiItemsFromContent(repliedMessage.content));

    // Check for image attachments in replied message
    if (repliedMessage.attachments?.size > 0) {
        for (const attachment of repliedMessage.attachments.values()) {
            if (attachment.contentType?.startsWith('image/')) {
                stealableItems.push({
                    type: 'image',
                    name: args[0] || attachment.name?.split('.')[0] || 'stolen',
                    url: attachment.url,
                    isAnimated: attachment.contentType === 'image/gif'
                });
            }
        }
    }

    // Check for embeds with images/GIFs (Tenor, Giphy, etc.)
    if (repliedMessage.embeds?.length > 0) {
        for (const embed of repliedMessage.embeds) {
            // Check for video embeds (Tenor/Giphy GIFs are usually video type)
            if (embed.video?.url) {
                // Try to get the GIF URL from Tenor/Giphy
                let gifUrl = null;
                const gifName = args[0] || 'stolen_gif';

                // Tenor GIFs
                if (embed.url?.includes('tenor.com')) {
                    // Use the thumbnail or image as it's usually a GIF
                    gifUrl = embed.thumbnail?.url || embed.image?.url;
                    if (!gifUrl && embed.video?.url) {
                        // Convert mp4 to gif for tenor
                        gifUrl = embed.video.url.replace('.mp4', '.gif');
                    }
                }
                // Giphy GIFs
                else if (embed.url?.includes('giphy.com')) {
                    gifUrl = embed.thumbnail?.url || embed.image?.url;
                }
                // Generic video embed with thumbnail
                else if (embed.thumbnail?.url) {
                    gifUrl = embed.thumbnail.url;
                }

                if (gifUrl) {
                    stealableItems.push({
                        type: 'image',
                        name: gifName,
                        url: gifUrl,
                        isAnimated: true
                    });
                }
            }
            // Check for image embeds
            else if (embed.image?.url) {
                const url = embed.image.url;
                stealableItems.push({
                    type: 'image',
                    name: args[0] || '',
                    url,
                    isAnimated: url.toLowerCase().includes('.gif')
                });
            }
            // Check for thumbnail only embeds
            else if (embed.thumbnail?.url && !embed.video) {
                const url = embed.thumbnail.url;
                stealableItems.push({
                    type: 'image',
                    name: args[0] || '',
                    url,
                    isAnimated: url.toLowerCase().includes('.gif')
                });
            }
        }
    }

    // Remove duplicates based on URL
    return stealableItems.filter((item, index, self) =>
        index === self.findIndex((t) => t.url === item.url)
    );
}

// Discord names: letters, digits and underscores, 2 to maxLength characters
function sanitizeName(name, maxLength) {
    const clean = String(name ?? '').replace(/[^a-zA-Z0-9_]/g, '_').substring(0, maxLength);
    if (clean.length >= 2) return clean;
    return clean ? clean.padEnd(2, '_') : 'stolen';
}

function describeFailure(prefixText, error, knownErrors) {
    const detail = String(error?.message ?? '');
    const known = knownErrors.find(([needle]) => detail.includes(needle));
    const reason = known ? known[1] : detail.substring(0, MAX_ERROR_DETAIL) || 'Unknown error.';
    return `${prefixText} ${reason}`;
}

function buildOptionsRow(messageId, disabled = false) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`steal_emoji_${messageId}`)
            .setLabel('Add as Emoji')
            .setStyle(ButtonStyle.Primary)
            .setDisabled(disabled),
        new ButtonBuilder()
            .setCustomId(`steal_sticker_${messageId}`)
            .setLabel('Add as Sticker')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(disabled),
        new ButtonBuilder()
            .setCustomId(`steal_cancel_${messageId}`)
            .setLabel('Cancel')
            .setStyle(ButtonStyle.Danger)
            .setDisabled(disabled)
    );
}

function buildNameModal(asSticker, modalId, defaultName) {
    const maxLength = asSticker ? STICKER_NAME_MAX : EMOJI_NAME_MAX;
    const nameInput = new TextInputBuilder()
        .setCustomId(asSticker ? 'sticker_name' : 'emoji_name')
        .setLabel(asSticker ? 'Sticker Name' : 'Emoji Name')
        .setPlaceholder(`Enter ${asSticker ? 'sticker' : 'emoji'} name (2-${maxLength} characters)`)
        .setStyle(TextInputStyle.Short)
        .setValue(defaultName.substring(0, maxLength))
        .setMinLength(2)
        .setMaxLength(maxLength)
        .setRequired(true);

    return new ModalBuilder()
        .setCustomId(modalId)
        .setTitle(asSticker ? 'Add as Sticker' : 'Add as Emoji')
        .addComponents(new ActionRowBuilder().addComponents(nameInput));
}

async function addEmoji(message, item, name, guildId) {
    try {
        const newEmoji = await message.guild.emojis.create({
            attachment: item.url,
            name,
            reason: `Stolen by ${message.author.tag}`
        });

        return await successEmbed(guildId, 'Emoji Added',
            `${newEmoji} has been added as **:${newEmoji.name}:**, Master.\n\n` +
            `${GLYPHS.ARROW_RIGHT} **ID:** \`${newEmoji.id}\`\n` +
            `${GLYPHS.ARROW_RIGHT} **Animated:** ${newEmoji.animated ? 'Yes' : 'No'}\n` +
            `${GLYPHS.ARROW_RIGHT} **Added by:** ${message.author}`
        );
    } catch (error) {
        console.error('[Steal] Emoji creation failed:', error);
        return errorEmbed(guildId, 'Emoji Not Added', describeFailure('The emoji could not be added, Master.', error, [
            ['Maximum number of emojis reached', 'This server has reached its emoji limit.'],
            ['File cannot be larger than', 'The image is too large. Emojis must be under 256 KB.'],
            ['Invalid Form Body', 'The image format is not supported.']
        ]));
    }
}

async function addSticker(message, item, name, guildId) {
    // Permissions may have changed while the name prompt was open
    if (!message.guild.members.me.permissions.has(PermissionFlagsBits.ManageGuildExpressions)) {
        return errorEmbed(guildId, 'I require the **Manage Expressions** permission to add stickers, Master.');
    }

    try {
        const newSticker = await message.guild.stickers.create({
            file: item.url,
            name,
            tags: 'stolen',
            description: `Stolen by ${message.author.tag}`,
            reason: `Stolen by ${message.author.tag}`
        });

        const formatName = { 1: 'PNG', 2: 'APNG', 3: 'Lottie', 4: 'GIF' }[newSticker.format] || 'Unknown';
        return await successEmbed(guildId, 'Sticker Added',
            `Sticker **${newSticker.name}** has been added, Master.\n\n` +
            `${GLYPHS.ARROW_RIGHT} **ID:** \`${newSticker.id}\`\n` +
            `${GLYPHS.ARROW_RIGHT} **Format:** ${formatName}\n` +
            `${GLYPHS.ARROW_RIGHT} **Added by:** ${message.author}`
        );
    } catch (error) {
        console.error('[Steal] Sticker creation failed:', error);
        return errorEmbed(guildId, 'Sticker Not Added', describeFailure('The sticker could not be added, Master.', error, [
            ['Maximum number of stickers reached', 'This server has reached its sticker limit.'],
            ['File cannot be larger than', 'The image is too large. Stickers must be under 512 KB.'],
            ['Invalid Form Body', 'The image format is not supported for stickers. Stickers require PNG, APNG or GIF format.'],
            ['Invalid Asset', 'Invalid image. Stickers must be 320x320 pixels in PNG format.']
        ]));
    }
}

async function showStealOptions(message, item, itemName, guildId) {
    const sanitizedName = sanitizeName(itemName, EMOJI_NAME_MAX);
    const typeLabel = item.type === 'sticker' ? 'Sticker' : item.type === 'emoji' ? 'Emoji' : 'Image';

    const embed = new EmbedBuilder()
        .setTitle('『 Expression Acquisition 』')
        .setDescription(
            '**Analysis:** A stealable expression has been located, Master.\n\n' +
            `${GLYPHS.ARROW_RIGHT} **Found:** ${typeLabel}\n` +
            `${GLYPHS.ARROW_RIGHT} **Name:** \`${sanitizedName}\`\n` +
            `${GLYPHS.ARROW_RIGHT} **Animated:** ${item.isAnimated ? 'Yes' : 'No'}\n\n` +
            'Choose how it should be added to this server.'
        )
        .setThumbnail(item.url)
        .setColor(COLORS.RAPHAEL)
        .setFooter({ text: `Options expire in 60 seconds • ${getRandomFooter()}` });

    const response = await message.reply({
        embeds: [embed],
        components: [buildOptionsRow(message.id)]
    });

    const collector = response.createMessageComponentCollector({
        componentType: ComponentType.Button,
        time: OPTIONS_TIMEOUT_MS,
        filter: (i) => i.user.id === message.author.id
    });

    // Only the first selection is acted on; later presses (double clicks) are turned away
    let claimed = false;

    collector.on('ignore', async (interaction) => {
        try {
            await interaction.reply({
                content: '**Notice:** These options respond only to the member who issued the command, Master.',
                flags: MessageFlags.Ephemeral
            });
        } catch (error) {
            console.error('[Steal] Failed to answer a foreign button press:', error);
        }
    });

    collector.on('collect', async (interaction) => {
        if (claimed) {
            await interaction.reply({
                content: '**Notice:** This request is already being processed, Master.',
                flags: MessageFlags.Ephemeral
            }).catch(() => {});
            return;
        }
        claimed = true;
        // Stop before anything is awaited so the 60 second timer cannot fire mid-prompt
        collector.stop('selected');

        try {
            const action = interaction.customId.split('_')[1]; // emoji | sticker | cancel

            if (action === 'cancel') {
                await interaction.update({
                    embeds: [await infoEmbed(guildId, 'Cancelled', 'The acquisition has been cancelled, Master.')],
                    components: []
                });
                return;
            }

            const asSticker = action === 'sticker';
            const modalId = `steal_${asSticker ? 'sticker' : 'emoji'}_modal_${message.id}`;

            // The modal must be the first response to the button press
            await interaction.showModal(buildNameModal(asSticker, modalId, sanitizedName));

            // Lock the options while the name prompt is open
            await response.edit({
                embeds: [embed.setFooter({ text: `Awaiting name confirmation • ${getRandomFooter()}` })],
                components: [buildOptionsRow(message.id, true)]
            }).catch(() => {});

            let modalInteraction;
            try {
                modalInteraction = await interaction.awaitModalSubmit({
                    time: MODAL_TIMEOUT_MS,
                    filter: (i) => i.customId === modalId && i.user.id === message.author.id
                });
            } catch (error) {
                if (error?.code !== 'InteractionCollectorError') throw error;
                // Modal timed out or was dismissed
                await response.edit({
                    embeds: [await infoEmbed(guildId, 'Cancelled', 'The name prompt was closed or timed out, Master. Run the command again to retry.')],
                    components: []
                }).catch(() => {});
                return;
            }

            const fieldId = asSticker ? 'sticker_name' : 'emoji_name';
            const finalName = sanitizeName(
                modalInteraction.fields.getTextInputValue(fieldId),
                asSticker ? STICKER_NAME_MAX : EMOJI_NAME_MAX
            );

            await modalInteraction.deferUpdate();
            await response.edit({
                embeds: [embed.setFooter({ text: `Processing request • ${getRandomFooter()}` })],
                components: []
            });

            const resultEmbed = asSticker
                ? await addSticker(message, item, finalName, guildId)
                : await addEmoji(message, item, finalName, guildId);

            await response.edit({ embeds: [resultEmbed], components: [] });
        } catch (error) {
            console.error('[Steal] Error handling selection:', error);
            try {
                await response.edit({
                    embeds: [await errorEmbed(guildId, 'The acquisition could not be completed, Master. Please try again.')],
                    components: []
                });
            } catch {
                // Message may have been deleted
            }
        }
    });

    collector.on('end', async (_collected, reason) => {
        // A selection manages the message itself
        if (reason === 'selected') return;

        try {
            if (reason === 'time') {
                await response.edit({
                    embeds: [await infoEmbed(guildId, 'Timed Out', 'No option was selected in time, Master. Please run the command again.')],
                    components: [buildOptionsRow(message.id, true)]
                });
            } else {
                await response.edit({ components: [buildOptionsRow(message.id, true)] });
            }
        } catch {
            // Message might be deleted
        }
    });
}
