import mongoose from 'mongoose';

// Discord's embed and message limits: buildEmbed() never exceeds them and embedset validates against them
export const EMBED_LIMITS = Object.freeze({
    TITLE: 256,
    DESCRIPTION: 4096,
    FIELDS: 25,
    FIELD_NAME: 256,
    FIELD_VALUE: 1024,
    FOOTER_TEXT: 2048,
    AUTHOR_NAME: 256,
    TOTAL: 6000,
    CONTENT: 2000
});

const TRUNCATION_MARK = '...';

// Shortens text to at most `max` characters, marking the cut and never splitting a surrogate pair
export function clipText(text, max) {
    if (typeof text !== 'string' || max <= 0) return '';
    if (text.length <= max) return text;

    const marked = max > TRUNCATION_MARK.length;
    let cut = text.slice(0, marked ? max - TRUNCATION_MARK.length : max);
    const lastCode = cut.charCodeAt(cut.length - 1);
    if (lastCode >= 0xD800 && lastCode <= 0xDBFF) cut = cut.slice(0, -1);

    return marked ? `${cut}${TRUNCATION_MARK}` : cut;
}

// Embed links and images must be absolute http(s) URLs
export function isHttpUrl(value) {
    if (typeof value !== 'string' || !value) return false;
    try {
        const { protocol } = new URL(value);
        return protocol === 'http:' || protocol === 'https:';
    } catch {
        return false;
    }
}

const embedTemplateSchema = new mongoose.Schema({
    guildId: {
        type: String,
        required: true
    },
    name: {
        type: String,
        required: true
    },
    description: String,

    // Embed configuration
    embed: {
        title: String,
        description: String,
        color: { type: String, default: '#5865F2' },
        url: String,

        // Author section
        author: {
            name: String,
            iconUrl: String,
            url: String,
            useUserAvatar: { type: Boolean, default: false },
            useUserName: { type: Boolean, default: false }
        },

        // Thumbnail and images
        thumbnail: {
            url: String,
            useUserAvatar: { type: Boolean, default: false }
        },
        image: {
            url: String
        },

        // Fields
        fields: [{
            name: { type: String, required: true },
            value: { type: String, required: true },
            inline: { type: Boolean, default: false }
        }],

        // Footer
        footer: {
            text: String,
            iconUrl: String,
            useUserAvatar: { type: Boolean, default: false },
            useBotAvatar: { type: Boolean, default: false }
        },

        // Timestamp
        timestamp: { type: Boolean, default: true }
    },

    // Message content (outside embed)
    content: String,

    // Variables that can be used in the embed
    // {user} - user mention
    // {user.name} - username
    // {user.tag} - user#discriminator
    // {user.id} - user ID
    // {server} - server name
    // {server.members} - member count
    // {channel} - channel mention
    // {date} - current date
    // {time} - current time

    // Metadata
    createdBy: String, // User ID
    usageCount: { type: Number, default: 0 },
    lastUsed: Date,
    category: { type: String, enum: ['welcome', 'announcement', 'rules', 'info', 'custom'], default: 'custom' }
}, {
    timestamps: true
});

// Compound index
embedTemplateSchema.index({ guildId: 1, name: 1 }, { unique: true });

// Method to replace variables in text
embedTemplateSchema.methods.replaceVariables = function(text, data = {}) {
    if (!text) return text;

    let result = String(text);
    // Function replacers insert names literally; a string replacer would expand "$&" or "$'" inside them
    const substitute = (pattern, value) => {
        const replacement = String(value);
        result = result.replace(pattern, () => replacement);
    };

    // User variables
    if (data.user) {
        substitute(/{user}/g, data.user.toString());
        substitute(/{user\.mention}/g, data.user.toString());
        substitute(/{user\.name}/g, data.user.username || 'Unknown');
        substitute(/{user\.displayName}/g, data.user.displayName || data.user.username || 'Unknown');
        substitute(/{user\.tag}/g, data.user.tag || 'Unknown');
        substitute(/{user\.id}/g, data.user.id || 'Unknown');
    }

    // Server variables
    if (data.guild) {
        substitute(/{server}/g, data.guild.name || 'Unknown');
        substitute(/{server\.name}/g, data.guild.name || 'Unknown');
        substitute(/{server\.members}/g, data.guild.memberCount?.toString() || '0');
        substitute(/{server\.id}/g, data.guild.id || 'Unknown');
    }

    // Channel variables
    if (data.channel) {
        substitute(/{channel}/g, data.channel.toString());
        substitute(/{channel\.name}/g, data.channel.name || 'Unknown');
        substitute(/{channel\.id}/g, data.channel.id || 'Unknown');
    }

    // Date/Time variables
    const now = new Date();
    substitute(/{date}/g, now.toLocaleDateString());
    substitute(/{time}/g, now.toLocaleTimeString());
    substitute(/{datetime}/g, now.toLocaleString());

    return result;
};

// Method to build Discord embed data (API shape) with variable replacement.
// Parts are only included when they resolve to something Discord accepts, and every text
// part is trimmed to its own limit and to the 6000-character total. Check the result with
// EmbedTemplate.isEmptyEmbed() before sending: Discord rejects an embed with nothing to show.
embedTemplateSchema.methods.buildEmbed = function(data = {}) {
    const source = this.embed || {};
    const embedData = {};

    // Text parts share one budget, spent in order: title, author, footer, description, fields
    let budget = EMBED_LIMITS.TOTAL;
    const resolve = (raw) => (raw ? String(this.replaceVariables(raw, data)).trim() : '');
    const take = (text, max) => {
        const clipped = clipText(text, Math.min(max, budget));
        budget -= clipped.length;
        return clipped;
    };
    const avatarOf = (user, size) => user?.displayAvatarURL?.({ size });

    // Title (a title link has nothing to attach to without a title)
    const title = take(resolve(source.title), EMBED_LIMITS.TITLE);
    if (title) {
        embedData.title = title;
        if (isHttpUrl(source.url)) embedData.url = source.url;
    }

    // Color
    const color = typeof source.color === 'string' ? parseInt(source.color.replace('#', ''), 16) : NaN;
    if (Number.isInteger(color) && color >= 0 && color <= 0xFFFFFF) embedData.color = color;

    // Author: Discord requires a name, so icon and link only come with one
    const author = source.author;
    const authorName = take(
        author?.useUserName && data.user
            ? String(data.user.displayName || data.user.username || '').trim()
            : resolve(author?.name),
        EMBED_LIMITS.AUTHOR_NAME
    );
    if (authorName) {
        embedData.author = { name: authorName };

        const iconUrl = author?.useUserAvatar && data.user ? avatarOf(data.user, 256) : author?.iconUrl;
        if (isHttpUrl(iconUrl)) embedData.author.icon_url = iconUrl;
        if (isHttpUrl(author?.url)) embedData.author.url = author.url;
    }

    // Footer: Discord requires text, so the icon only comes with it
    const footer = source.footer;
    const footerText = take(resolve(footer?.text), EMBED_LIMITS.FOOTER_TEXT);
    if (footerText) {
        embedData.footer = { text: footerText };

        let iconUrl = footer?.iconUrl;
        if (footer?.useUserAvatar && data.user) {
            iconUrl = avatarOf(data.user, 64);
        } else if (footer?.useBotAvatar && data.client?.user) {
            iconUrl = avatarOf(data.client.user, 64);
        }
        if (isHttpUrl(iconUrl)) embedData.footer.icon_url = iconUrl;
    }

    // Description
    const description = take(resolve(source.description), EMBED_LIMITS.DESCRIPTION);
    if (description) embedData.description = description;

    // Thumbnail
    const thumbnailUrl = source.thumbnail?.useUserAvatar && data.user
        ? avatarOf(data.user, 256)
        : source.thumbnail?.url;
    if (isHttpUrl(thumbnailUrl)) embedData.thumbnail = { url: thumbnailUrl };

    // Image
    if (isHttpUrl(source.image?.url)) embedData.image = { url: source.image.url };

    // Fields: Discord rejects a field without a name or value, and more than 25 of them
    const fields = [];
    for (const field of source.fields || []) {
        if (fields.length >= EMBED_LIMITS.FIELDS) break;

        const name = resolve(field?.name);
        const value = resolve(field?.value);
        if (!name || !value) continue;

        // Keep at least one character of the budget for the value
        const fieldName = clipText(name, Math.min(EMBED_LIMITS.FIELD_NAME, budget - 1));
        const fieldValue = clipText(value, Math.min(EMBED_LIMITS.FIELD_VALUE, budget - fieldName.length));
        if (!fieldName || !fieldValue) break;

        budget -= fieldName.length + fieldValue.length;
        fields.push({ name: fieldName, value: fieldValue, inline: Boolean(field.inline) });
    }
    if (fields.length > 0) embedData.fields = fields;

    // Timestamp
    if (source.timestamp) {
        embedData.timestamp = new Date().toISOString();
    }

    return embedData;
};

// Message content outside the embed, with variables replaced and within Discord's 2000 characters (null when unset)
embedTemplateSchema.methods.buildContent = function(data = {}) {
    if (!this.content) return null;
    const content = clipText(String(this.replaceVariables(this.content, data)).trim(), EMBED_LIMITS.CONTENT);
    return content || null;
};

// Characters the stored template counts toward Discord's 6000 total, before variables are replaced
embedTemplateSchema.methods.getTextLength = function() {
    const source = this.embed || {};
    let total = (source.title?.length || 0)
        + (source.description?.length || 0)
        + (source.author?.name?.length || 0)
        + (source.footer?.text?.length || 0);

    for (const field of source.fields || []) {
        total += (field?.name?.length || 0) + (field?.value?.length || 0);
    }

    return total;
};

// True when built embed data has nothing Discord would display (color, link and timestamp alone do not count)
embedTemplateSchema.statics.isEmptyEmbed = function(embedData) {
    if (!embedData) return true;
    return !(embedData.title
        || embedData.description
        || embedData.author
        || embedData.footer
        || embedData.image
        || embedData.thumbnail
        || embedData.fields?.length);
};

export default mongoose.model('EmbedTemplate', embedTemplateSchema);
