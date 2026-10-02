import { PermissionFlagsBits, EmbedBuilder } from 'discord.js';
import EmbedTemplate, { EMBED_LIMITS, clipText } from '../../models/EmbedTemplate.js';
import { errorEmbed, successEmbed, infoEmbed, GLYPHS } from '../../utils/embeds.js';
import { getPrefix } from '../../utils/helpers.js';

const ACTION_LIST = '`create`, `edit`, `delete`, `list`, `send`, or `preview`';
const MAX_TEMPLATE_NAME_LENGTH = 32;
// Display caps so one template cannot crowd the others out of the list or a title
const DISPLAY_NAME_LENGTH = 64;
const LIST_SUMMARY_LENGTH = 100;
// Room left under the description limit for the "and N more" note
const LIST_OVERFLOW_RESERVE = 100;
const DUPLICATE_KEY_ERROR = 11000;

async function replyError(message, guildId, description) {
    return message.reply({ embeds: [await errorEmbed(guildId, description)] });
}

// The built template as message parts; `embed` is null when the template has nothing to display
function buildMessageParts(template, data) {
    const embedData = template.buildEmbed(data);
    return {
        embed: EmbedTemplate.isEmptyEmbed(embedData) ? null : new EmbedBuilder(embedData),
        content: template.buildContent(data)
    };
}

function emptyTemplateError(embedName, prefix) {
    return `Template "${clipText(embedName, DISPLAY_NAME_LENGTH)}" holds nothing to display yet, Master. ` +
        `Give it a title, description, image, author, footer or field first, e.g. \`${prefix}embedset ${embedName} title <text>\`.`;
}

async function listTemplates(message, guildId) {
    const prefix = await getPrefix(guildId);
    const templates = await EmbedTemplate.find({ guildId })
        .select('name description usageCount category')
        .sort({ name: 1 })
        .lean();

    if (templates.length === 0) {
        return replyError(message, guildId, `No custom embeds are registered, Master. Create one with \`${prefix}embed create <name>\`.`);
    }

    const entries = templates.map(t =>
        `**${clipText(t.name, DISPLAY_NAME_LENGTH)}** — ${clipText(t.description || 'No description', LIST_SUMMARY_LENGTH)}\n` +
        `${GLYPHS.ARROW_RIGHT} Used ${t.usageCount || 0} time(s) • Category: ${t.category || 'custom'}`
    );

    // Keep as many entries as fit in one embed description and summarize the rest
    const maxLength = EMBED_LIMITS.DESCRIPTION - LIST_OVERFLOW_RESERVE;
    const shown = [];
    let length = 0;
    for (const entry of entries) {
        const added = entry.length + (shown.length > 0 ? 2 : 0);
        if (length + added > maxLength) break;
        shown.push(entry);
        length += added;
    }

    let description = shown.join('\n\n');
    const hidden = entries.length - shown.length;
    if (hidden > 0) {
        description += `\n\n*...and ${hidden} more template(s), Master.*`;
    }

    return message.reply({
        embeds: [await infoEmbed(guildId, `Custom Embeds (${templates.length})`, description)]
    });
}

async function sendTemplate(message, args, guildId) {
    const embedName = args[1];
    const targetChannel = message.mentions.channels.first() || message.channel;
    const prefix = await getPrefix(guildId);

    if (!embedName) {
        return replyError(message, guildId, `Please specify an embed name, Master. Usage: \`${prefix}embed send <name> [#channel]\``);
    }

    // Channel mentions resolve from the whole client cache, so a channel of another server could be named
    if (targetChannel.guildId !== guildId || !targetChannel.isTextBased?.()) {
        return replyError(message, guildId, `${targetChannel} cannot receive messages from this server's templates, Master. Choose a text channel of this server.`);
    }

    const sendFlag = targetChannel.isThread?.()
        ? PermissionFlagsBits.SendMessagesInThreads
        : PermissionFlagsBits.SendMessages;
    const requiredPerms = [PermissionFlagsBits.ViewChannel, sendFlag, PermissionFlagsBits.EmbedLinks];

    // The sender must be able to post there themselves; the bot is not a way around channel permissions
    const senderPerms = targetChannel.permissionsFor(message.member);
    if (!senderPerms?.has(requiredPerms)) {
        return message.reply({
            embeds: [await errorEmbed(guildId, 'Access Denied', `You cannot post embeds in ${targetChannel}, Master.`)]
        });
    }

    const botPerms = targetChannel.permissionsFor(message.guild.members.me);
    if (!botPerms?.has(requiredPerms)) {
        return message.reply({
            embeds: [await errorEmbed(guildId, 'Missing Permissions', `I lack the View Channel, Send Messages or Embed Links permission in ${targetChannel}, Master.`)]
        });
    }

    const template = await EmbedTemplate.findOne({ guildId, name: embedName });

    if (!template) {
        return replyError(message, guildId, `Embed "${clipText(embedName, DISPLAY_NAME_LENGTH)}" was not found, Master.`);
    }

    const { embed, content } = buildMessageParts(template, {
        user: message.author,
        guild: message.guild,
        channel: targetChannel,
        client: message.client
    });

    if (!embed && !content) {
        return replyError(message, guildId, emptyTemplateError(embedName, prefix));
    }

    await targetChannel.send({
        ...(content ? { content } : {}),
        embeds: embed ? [embed] : [],
        // @everyone/@here and role pings only for members allowed to make them in that channel
        allowedMentions: senderPerms.has(PermissionFlagsBits.MentionEveryone)
            ? { parse: ['users', 'roles', 'everyone'] }
            : { parse: ['users'] }
    });

    // Update usage stats atomically, without re-validating the whole template
    await EmbedTemplate.updateOne(
        { _id: template._id },
        { $inc: { usageCount: 1 }, $set: { lastUsed: new Date() } }
    );

    if (targetChannel.id !== message.channel.id) {
        return message.reply({
            embeds: [await successEmbed(guildId, 'Embed Sent', `Template "${clipText(embedName, DISPLAY_NAME_LENGTH)}" has been delivered to ${targetChannel}, Master.`)]
        });
    }

    return;
}

async function previewTemplate(message, args, guildId) {
    const embedName = args[1];
    const prefix = await getPrefix(guildId);

    if (!embedName) {
        return replyError(message, guildId, `Please specify an embed name, Master. Usage: \`${prefix}embed preview <name>\``);
    }

    const template = await EmbedTemplate.findOne({ guildId, name: embedName });

    if (!template) {
        return replyError(message, guildId, `Embed "${clipText(embedName, DISPLAY_NAME_LENGTH)}" was not found, Master.`);
    }

    const { embed, content } = buildMessageParts(template, {
        user: message.author,
        guild: message.guild,
        channel: message.channel,
        client: message.client
    });

    if (!embed && !content) {
        return replyError(message, guildId, emptyTemplateError(embedName, prefix));
    }

    return message.reply({
        content: clipText(content ? `**Content:** ${content}` : '**Preview:**', EMBED_LIMITS.CONTENT),
        embeds: embed ? [embed] : [],
        // A preview shows the template; it does not ping anyone
        allowedMentions: { parse: [] }
    });
}

async function deleteTemplate(message, args, guildId) {
    const embedName = args[1];
    const prefix = await getPrefix(guildId);

    if (!embedName) {
        return replyError(message, guildId, `Please specify an embed name, Master. Usage: \`${prefix}embed delete <name>\``);
    }

    const result = await EmbedTemplate.deleteOne({ guildId, name: embedName });

    if (result.deletedCount === 0) {
        return replyError(message, guildId, `Embed "${clipText(embedName, DISPLAY_NAME_LENGTH)}" was not found, Master.`);
    }

    return message.reply({
        embeds: [await successEmbed(guildId, 'Embed Deleted', `Template "${clipText(embedName, DISPLAY_NAME_LENGTH)}" has been deleted, Master.`)]
    });
}

function setupGuide(prefix, embedName, created) {
    const cmd = `${prefix}embedset ${embedName}`;
    return `**Template ${created ? 'registered' : 'located'}, Master.** Configure it with \`${prefix}embedset\`:\n\n` +
        `${GLYPHS.ARROW_RIGHT} **Basic Setup**\n` +
        `\`${cmd} title <text>\` — Set title\n` +
        `\`${cmd} description <text>\` — Set description\n` +
        `\`${cmd} color <hex>\` — Set color (e.g. #FF0000)\n` +
        `\`${cmd} content <text>\` — Set message content\n\n` +
        `${GLYPHS.ARROW_RIGHT} **Images**\n` +
        `\`${cmd} image <url>\` — Set large image\n` +
        `\`${cmd} thumbnail <url>\` — Set thumbnail\n` +
        `\`${cmd} thumbnail userAvatar\` — Use the member's avatar\n\n` +
        `${GLYPHS.ARROW_RIGHT} **Author Section**\n` +
        `\`${cmd} author <text>\` — Set author name\n` +
        `\`${cmd} authorIcon <url>\` — Set author icon\n` +
        `\`${cmd} authorIcon userAvatar\` — Use the member's avatar\n\n` +
        `${GLYPHS.ARROW_RIGHT} **Footer**\n` +
        `\`${cmd} footer <text>\` — Set footer text\n` +
        `\`${cmd} footerIcon <url>\` — Set footer icon\n` +
        `\`${cmd} footerIcon userAvatar\` — Use the member's avatar\n` +
        `\`${cmd} footerIcon botAvatar\` — Use my avatar\n\n` +
        `${GLYPHS.ARROW_RIGHT} **Fields**\n` +
        `\`${cmd} addfield <name> | <value> [| inline]\` — Add field\n` +
        `\`${cmd} removefield <number>\` — Remove field\n\n` +
        `${GLYPHS.ARROW_RIGHT} **Variables:** \`{user}\` \`{user.name}\` \`{user.tag}\` \`{server}\` \`{server.members}\` \`{channel}\` \`{date}\` \`{time}\`\n\n` +
        `${GLYPHS.ARROW_RIGHT} **Preview:** \`${prefix}embed preview ${embedName}\`\n` +
        `${GLYPHS.ARROW_RIGHT} **Send:** \`${prefix}embed send ${embedName} [#channel]\`\n` +
        `${GLYPHS.ARROW_RIGHT} **Full guide:** \`${prefix}embedhelp\``;
}

async function setupTemplate(message, args, guildId, action) {
    const embedName = args[1];
    const prefix = await getPrefix(guildId);
    const creating = action === 'create';

    if (!embedName) {
        return replyError(message, guildId, `Please specify an embed name, Master. Usage: \`${prefix}embed ${action} <name>\``);
    }

    if (creating && embedName.length > MAX_TEMPLATE_NAME_LENGTH) {
        return replyError(message, guildId, `Template names may be at most ${MAX_TEMPLATE_NAME_LENGTH} characters long, Master.`);
    }

    const existingTemplate = await EmbedTemplate.findOne({ guildId, name: embedName });
    const alreadyExists = `Embed "${clipText(embedName, DISPLAY_NAME_LENGTH)}" already exists, Master. Use \`${prefix}embed edit ${embedName}\` to modify it.`;

    if (creating && existingTemplate) {
        return replyError(message, guildId, alreadyExists);
    }

    if (!creating && !existingTemplate) {
        return replyError(message, guildId, `Embed "${clipText(embedName, DISPLAY_NAME_LENGTH)}" was not found, Master. Use \`${prefix}embed create ${embedName}\` to create it.`);
    }

    // Create the template before confirming, so the guide is only shown for a template that exists
    if (creating) {
        try {
            await EmbedTemplate.create({
                guildId,
                name: embedName,
                createdBy: message.author.id,
                embed: {}
            });
        } catch (error) {
            // Another create of the same name won the race
            if (error?.code === DUPLICATE_KEY_ERROR) return replyError(message, guildId, alreadyExists);
            throw error;
        }
    }

    const setupEmbed = await infoEmbed(
        guildId,
        `${creating ? 'Creating' : 'Editing'} Embed: ${clipText(embedName, DISPLAY_NAME_LENGTH)}`,
        clipText(setupGuide(prefix, embedName, creating), EMBED_LIMITS.DESCRIPTION)
    );

    return message.reply({ embeds: [setupEmbed] });
}

export default {
    name: 'embed',
    description: 'Create and manage custom embeds',
    usage: 'embed <create/edit/delete/list/send/preview> [args]',
    category: 'utility',
    permissions: [PermissionFlagsBits.ManageMessages],

    execute: async (message, args) => {
        const guildId = message.guild.id;

        try {
            const action = args[0]?.toLowerCase();

            if (!action) {
                return await replyError(message, guildId, `Please specify an action, Master: ${ACTION_LIST}.`);
            }

            if (action === 'list') return await listTemplates(message, guildId);
            if (action === 'send') return await sendTemplate(message, args, guildId);
            if (action === 'preview') return await previewTemplate(message, args, guildId);
            if (action === 'delete' || action === 'remove') return await deleteTemplate(message, args, guildId);
            if (action === 'create' || action === 'edit') return await setupTemplate(message, args, guildId, action);

            return await replyError(message, guildId, `Invalid action, Master. Use ${ACTION_LIST}.`);
        } catch (error) {
            console.error('[Embed] Error:', error);
            try {
                return await replyError(message, guildId, 'An anomaly occurred while processing the embed command, Master. Please try again.');
            } catch {
                return null;
            }
        }
    }
};
