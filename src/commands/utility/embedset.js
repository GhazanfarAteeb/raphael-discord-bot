import { PermissionFlagsBits } from 'discord.js';
import EmbedTemplate, { EMBED_LIMITS, clipText, isHttpUrl } from '../../models/EmbedTemplate.js';
import { errorEmbed, successEmbed } from '../../utils/embeds.js';
import { getPrefix } from '../../utils/helpers.js';

const PROPERTY_LIST = 'title, description, color, content, image, thumbnail, author, authorIcon, footer, footerIcon, addfield, removefield, timestamp, url, category, setdesc';
const VALID_CATEGORIES = ['welcome', 'announcement', 'rules', 'info', 'custom'];
const HEX_COLOR = /^#?([0-9A-F]{6})$/i;
const USER_KEYWORDS = ['useravatar', 'user'];
const USER_NAME_KEYWORDS = ['username', 'user'];
const BOT_KEYWORDS = ['botavatar', 'bot'];
const INLINE_FLAGS = ['inline', 'true'];
const FIELD_FLAGS = [...INLINE_FLAGS, 'false'];
// The template's own summary, shown in `embed list`
const TEMPLATE_DESCRIPTION_LENGTH = 200;
const DISPLAY_NAME_LENGTH = 64;

// Error text when a value is longer than Discord accepts, otherwise null
function lengthError(label, value, max) {
    return value.length > max
        ? `The ${label} is ${value.length} characters long, Master. Discord accepts at most ${max}.`
        : null;
}

const cleared = (title, text) => ({ cleared: { title, text } });
const failed = (error) => ({ error });

// Applies one property change to the template in memory.
// Returns { error } to reject it, { cleared } when a part was removed, or { note } / {} when updated.
function applyProperty(template, property, value, attachmentUrl, prefix) {
    const keyword = value.toLowerCase();

    switch (property) {
        case 'title': {
            if (!value) return failed('Please provide a title, Master.');
            const tooLong = lengthError('title', value, EMBED_LIMITS.TITLE);
            if (tooLong) return failed(tooLong);
            template.set('embed.title', value);
            return {};
        }

        case 'description':
        case 'desc': {
            if (!value) return failed('Please provide a description, Master.');
            const tooLong = lengthError('description', value, EMBED_LIMITS.DESCRIPTION);
            if (tooLong) return failed(tooLong);
            template.set('embed.description', value);
            return {};
        }

        case 'color':
        case 'colour': {
            if (!value) return failed('Please provide a hex color (e.g. #FF0000), Master.');
            const match = HEX_COLOR.exec(value);
            if (!match) return failed('Invalid hex color, Master. Use the format #FF0000.');
            template.set('embed.color', `#${match[1].toUpperCase()}`);
            return {};
        }

        case 'content':
        case 'message': {
            if (!value) {
                template.content = null;
                return cleared('Content Removed', 'The message content has been cleared, Master.');
            }
            const tooLong = lengthError('message content', value, EMBED_LIMITS.CONTENT);
            if (tooLong) return failed(tooLong);
            template.content = value;
            return {};
        }

        case 'image': {
            // An attached image counts as the value, so it is not mistaken for a removal
            const imageUrl = attachmentUrl || value;
            if (!imageUrl) {
                template.set('embed.image', null);
                return cleared('Image Removed', 'The large image has been removed, Master.');
            }
            if (!isHttpUrl(imageUrl)) return failed('Please provide a valid image URL (http or https) or attach an image, Master.');
            template.set('embed.image', { url: imageUrl });
            return {};
        }

        case 'thumbnail':
        case 'thumb': {
            if (!value && !attachmentUrl) {
                template.set('embed.thumbnail', null);
                return cleared('Thumbnail Removed', 'The thumbnail has been removed, Master.');
            }
            if (USER_KEYWORDS.includes(keyword)) {
                template.set('embed.thumbnail', { useUserAvatar: true });
                return {};
            }
            const thumbUrl = attachmentUrl || value;
            if (!isHttpUrl(thumbUrl)) return failed('Please provide a valid image URL (http or https), attach an image, or use "userAvatar", Master.');
            template.set('embed.thumbnail', { url: thumbUrl, useUserAvatar: false });
            return {};
        }

        case 'author':
        case 'authorname': {
            if (!value) {
                template.set('embed.author', null);
                return cleared('Author Removed', 'The author section has been removed, Master.');
            }
            if (USER_NAME_KEYWORDS.includes(keyword)) {
                template.set('embed.author.useUserName', true);
                template.set('embed.author.name', null);
                return {};
            }
            const tooLong = lengthError('author name', value, EMBED_LIMITS.AUTHOR_NAME);
            if (tooLong) return failed(tooLong);
            template.set('embed.author.name', value);
            template.set('embed.author.useUserName', false);
            return {};
        }

        case 'authoricon':
        case 'authorimage': {
            if (!value && !attachmentUrl) return failed('Please provide a URL, attach an image, or use "userAvatar", Master.');

            if (USER_KEYWORDS.includes(keyword)) {
                template.set('embed.author.useUserAvatar', true);
                template.set('embed.author.iconUrl', null);
            } else {
                const iconUrl = attachmentUrl || value;
                if (!isHttpUrl(iconUrl)) return failed('Please provide a valid image URL (http or https), attach an image, or use "userAvatar", Master.');
                template.set('embed.author.iconUrl', iconUrl);
                template.set('embed.author.useUserAvatar', false);
            }

            const hasName = template.embed.author?.name || template.embed.author?.useUserName;
            return hasName ? {} : { note: `The icon appears once an author name is set with \`${prefix}embedset ${template.name} author <text>\`.` };
        }

        case 'footer':
        case 'footertext': {
            if (!value) {
                template.set('embed.footer', null);
                return cleared('Footer Removed', 'The footer has been removed, Master.');
            }
            const tooLong = lengthError('footer', value, EMBED_LIMITS.FOOTER_TEXT);
            if (tooLong) return failed(tooLong);
            template.set('embed.footer.text', value);
            return {};
        }

        case 'footericon':
        case 'footerimage': {
            if (!value && !attachmentUrl) return failed('Please provide a URL, attach an image, or use "userAvatar" or "botAvatar", Master.');

            if (USER_KEYWORDS.includes(keyword)) {
                template.set('embed.footer.useUserAvatar', true);
                template.set('embed.footer.useBotAvatar', false);
                template.set('embed.footer.iconUrl', null);
            } else if (BOT_KEYWORDS.includes(keyword)) {
                template.set('embed.footer.useBotAvatar', true);
                template.set('embed.footer.useUserAvatar', false);
                template.set('embed.footer.iconUrl', null);
            } else {
                const iconUrl = attachmentUrl || value;
                if (!isHttpUrl(iconUrl)) return failed('Please provide a valid image URL (http or https), attach an image, or use "userAvatar" or "botAvatar", Master.');
                template.set('embed.footer.iconUrl', iconUrl);
                template.set('embed.footer.useUserAvatar', false);
                template.set('embed.footer.useBotAvatar', false);
            }

            return template.embed.footer?.text
                ? {}
                : { note: `The icon appears once footer text is set with \`${prefix}embedset ${template.name} footer <text>\`.` };
        }

        case 'addfield':
        case 'field': {
            const usage = `Usage: \`${prefix}embedset <name> addfield <field name> | <field value> [| inline]\``;
            if (!value) return failed(usage);

            const parts = value.split('|');
            // A trailing inline flag is an option; any other "|" belongs to the value
            const flag = parts.length > 2 ? parts[parts.length - 1].trim().toLowerCase() : null;
            const hasFlag = FIELD_FLAGS.includes(flag);
            const fieldName = parts[0].trim();
            const fieldValue = parts.slice(1, hasFlag ? -1 : undefined).join('|').trim();

            if (!fieldName || !fieldValue) {
                return failed(`A field needs both a name and a value, Master.\n${usage}`);
            }

            const tooLong = lengthError('field name', fieldName, EMBED_LIMITS.FIELD_NAME)
                || lengthError('field value', fieldValue, EMBED_LIMITS.FIELD_VALUE);
            if (tooLong) return failed(tooLong);

            if (!Array.isArray(template.embed.fields)) template.set('embed.fields', []);

            if (template.embed.fields.length >= EMBED_LIMITS.FIELDS) {
                return failed(`This embed already holds the maximum of ${EMBED_LIMITS.FIELDS} fields, Master. Remove one with \`${prefix}embedset ${template.name} removefield <number>\` first.`);
            }

            template.embed.fields.push({
                name: fieldName,
                value: fieldValue,
                inline: hasFlag && INLINE_FLAGS.includes(flag)
            });
            return {};
        }

        case 'removefield':
        case 'deletefield': {
            const fields = template.embed.fields || [];
            if (fields.length === 0) return failed('This embed has no fields to remove, Master.');

            const fieldIndex = Number.parseInt(value, 10) - 1;
            if (Number.isNaN(fieldIndex) || fieldIndex < 0 || fieldIndex >= fields.length) {
                return failed(`Invalid field number, Master. Choose a number from 1 to ${fields.length}.`);
            }

            fields.splice(fieldIndex, 1);
            return {};
        }

        case 'timestamp': {
            if (['on', 'true', 'yes'].includes(keyword)) {
                template.set('embed.timestamp', true);
            } else if (['off', 'false', 'no'].includes(keyword)) {
                template.set('embed.timestamp', false);
            } else {
                return failed('Use on/off, true/false, or yes/no, Master.');
            }
            return {};
        }

        case 'url': {
            if (!value) {
                template.set('embed.url', null);
                return cleared('URL Removed', 'The title link has been removed, Master.');
            }
            if (!isHttpUrl(value)) return failed('Please provide a valid URL beginning with http:// or https://, Master.');
            template.set('embed.url', value);
            return template.embed.title
                ? {}
                : { note: `The link applies once a title is set with \`${prefix}embedset ${template.name} title <text>\`.` };
        }

        case 'category': {
            if (!VALID_CATEGORIES.includes(keyword)) {
                return failed(`Invalid category, Master. Use: ${VALID_CATEGORIES.join(', ')}`);
            }
            template.category = keyword;
            return {};
        }

        // The template's own description (shown in `embed list`); `description` sets the embed's
        case 'setdesc': {
            if (!value) return failed('Please provide a description for this embed template, Master.');
            const tooLong = lengthError('template description', value, TEMPLATE_DESCRIPTION_LENGTH);
            if (tooLong) return failed(tooLong);
            template.description = value;
            return {};
        }

        default:
            return failed(`Unknown property: \`${clipText(property, DISPLAY_NAME_LENGTH)}\`\n\nAvailable: ${PROPERTY_LIST}`);
    }
}

export default {
    name: 'embedset',
    description: 'Configure embed properties',
    usage: 'embedset <name> <property> <value>',
    category: 'utility',
    permissions: [PermissionFlagsBits.ManageMessages],

    execute: async (message, args) => {
        const guildId = message.guild.id;

        try {
            const embedName = args[0];
            const property = args[1]?.toLowerCase();
            const value = args.slice(2).join(' ').trim();
            const attachmentUrl = message.attachments.first()?.url || null;
            const prefix = await getPrefix(guildId);

            if (!embedName || !property) {
                return message.reply({
                    embeds: [await errorEmbed(guildId, `Usage: \`${prefix}embedset <name> <property> <value>\`\n\nProperties: ${PROPERTY_LIST}`)]
                });
            }

            const template = await EmbedTemplate.findOne({ guildId, name: embedName });
            const displayName = clipText(embedName, DISPLAY_NAME_LENGTH);

            if (!template) {
                return message.reply({
                    embeds: [await errorEmbed(guildId, `Embed "${displayName}" was not found, Master. Create it first with \`${prefix}embed create ${embedName}\`.`)]
                });
            }

            const lengthBefore = template.getTextLength();
            const result = applyProperty(template, property, value, attachmentUrl, prefix);

            if (result.error) {
                return message.reply({ embeds: [await errorEmbed(guildId, result.error)] });
            }

            // Discord also caps the embed as a whole; changes that shrink an oversized template stay allowed
            const lengthAfter = template.getTextLength();
            if (lengthAfter > EMBED_LIMITS.TOTAL && lengthAfter > lengthBefore) {
                return message.reply({
                    embeds: [await errorEmbed(guildId, 'Embed Too Long',
                        `This change would bring the embed to ${lengthAfter} characters, Master. Discord accepts at most ${EMBED_LIMITS.TOTAL} across the title, description, author, footer and fields.`)]
                });
            }

            await template.save();

            if (result.cleared) {
                return message.reply({
                    embeds: [await successEmbed(guildId, result.cleared.title, result.cleared.text)]
                });
            }

            return message.reply({
                embeds: [await successEmbed(guildId, 'Embed Updated',
                    `Property **${property}** of template "${displayName}" has been updated, Master.` +
                    `${result.note ? `\n${result.note}` : ''}\n\nPreview it with \`${prefix}embed preview ${embedName}\`.`)]
            });
        } catch (error) {
            console.error('[EmbedSet] Error:', error);
            try {
                return await message.reply({
                    embeds: [await errorEmbed(guildId, 'The embed could not be updated, Master. Please try again.')]
                });
            } catch {
                return null;
            }
        }
    }
};
