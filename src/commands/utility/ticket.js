import {
    EmbedBuilder,
    PermissionFlagsBits,
    OverwriteType,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle
} from 'discord.js';
import Guild from '../../models/Guild.js';
import Ticket from '../../models/Ticket.js';
import { successEmbed, errorEmbed, warningEmbed, infoEmbed, COLORS, GLYPHS } from '../../utils/embeds.js';
import { getRandomFooter } from '../../utils/raphael.js';
import { getPrefix } from '../../utils/helpers.js';
import {
    OPEN_STATUSES,
    CHANNEL_NAME_MAX,
    getTicketSettings,
    isTicketStaff,
    canCloseTicket,
    findChannelTicket,
    openTicket,
    openResultEmbed,
    closeTicket,
    claimTicket,
    claimAnnouncementEmbed
} from '../../events/client/ticketHandler.js';

const RENAME_PREFIX = 'ticket-';
const ADDED_USER_PERMISSIONS = {
    ViewChannel: true,
    SendMessages: true,
    ReadMessageHistory: true
};
const UNKNOWN_OVERWRITE = 10009;

export default {
    name: 'ticket',
    description: 'Manage support request protocols, Master',
    usage: 'ticket create [subject] | ticket close [reason] | ticket claim | ticket add @user | ticket remove @user | ticket rename <name> | ticket panel',
    category: 'utility',
    aliases: ['tickets', 'support'],
    cooldown: 5,

    async execute(message, args) {
        const guildId = message.guild.id;

        try {
            const guildConfig = await Guild.getGuild(guildId);
            const subCommand = args[0]?.toLowerCase();
            const rest = args.slice(1);

            switch (subCommand) {
                case 'create':
                case 'new':
                case 'open':
                    return await createTicket(message, rest, guildConfig);
                case 'close':
                    return await closeCurrentTicket(message, rest, guildConfig);
                case 'add':
                    return await addUser(message, rest, guildConfig);
                case 'remove':
                    return await removeUser(message, rest, guildConfig);
                case 'claim':
                    return await claimCurrentTicket(message, guildConfig);
                case 'rename':
                    return await renameTicket(message, rest, guildConfig);
                case 'panel':
                    return await createPanel(message, guildConfig);
                default:
                    return await showHelp(message, guildConfig);
            }
        } catch (error) {
            console.error('[Ticket] Command error:', error);
            try {
                const embed = await errorEmbed(guildId, 'Ticket Error',
                    `${GLYPHS.ERROR} I was unable to complete that ticket operation, Master. Please try again shortly.`);
                await message.reply({ embeds: [embed] });
            } catch {
                // The channel may already be gone (e.g. the ticket was just closed)
            }
        }
    }
};

// Permissions in this channel, overwrites included (Administrator implies everything)
function memberPermissions(message) {
    return message.channel.permissionsFor?.(message.member) ?? message.member?.permissions;
}

async function replyDisabled(message) {
    const prefix = await getPrefix(message.guild.id);
    const embed = await errorEmbed(message.guild.id, 'Tickets Disabled',
        `${GLYPHS.ERROR} The ticket system is not enabled, Master.\n\n` +
        `Use \`${prefix}setup\` to set up the ticket system.`
    );
    return message.reply({ embeds: [embed] });
}

async function replyStaffOnly(message, action) {
    const embed = await errorEmbed(message.guild.id, 'Permission Denied',
        `${GLYPHS.LOCK} Only the support team may ${action}, Master.`);
    return message.reply({ embeds: [embed] });
}

// The open ticket of the current channel, or null after telling the user why there is none
async function requireOpenTicket(message) {
    const guildId = message.guild.id;
    const ticket = await findChannelTicket(guildId, message.channel.id);

    if (!ticket) {
        const embed = await errorEmbed(guildId, 'Not a Ticket',
            `${GLYPHS.ERROR} This command can only be used in a ticket channel, Master.`);
        await message.reply({ embeds: [embed] });
        return null;
    }
    if (!OPEN_STATUSES.includes(ticket.status)) {
        const embed = await warningEmbed(guildId, 'Ticket Closed',
            `${GLYPHS.WARNING} This ticket has already been closed, Master.`);
        await message.reply({ embeds: [embed] });
        return null;
    }
    return ticket;
}

// Accepts a mention or a raw user ID as the first argument
function resolveTargetUserId(message, args) {
    const match = args[0]?.match(/^<@!?(\d{17,20})>$/) ?? args[0]?.match(/^(\d{17,20})$/);
    return match?.[1] ?? message.mentions?.users?.first()?.id ?? null;
}

async function showHelp(message, guildConfig) {
    const guildId = message.guild.id;
    if (!getTicketSettings(guildConfig).enabled) return replyDisabled(message);

    const prefix = await getPrefix(guildId);
    const embed = await infoEmbed(guildId, 'Support Protocol',
        '**Commands:**\n' +
        `${GLYPHS.ARROW_RIGHT} \`${prefix}ticket create [subject]\` — Open a new ticket\n` +
        `${GLYPHS.ARROW_RIGHT} \`${prefix}ticket close [reason]\` — Close the current ticket (opener or support team)\n\n` +
        '**Support Team:**\n' +
        `${GLYPHS.ARROW_RIGHT} \`${prefix}ticket claim\` — Claim the current ticket\n` +
        `${GLYPHS.ARROW_RIGHT} \`${prefix}ticket add @user\` — Grant a user access to the ticket\n` +
        `${GLYPHS.ARROW_RIGHT} \`${prefix}ticket remove @user\` — Revoke a user's access to the ticket\n` +
        `${GLYPHS.ARROW_RIGHT} \`${prefix}ticket rename <name>\` — Rename the ticket channel\n\n` +
        '**Administration:**\n' +
        `${GLYPHS.ARROW_RIGHT} \`${prefix}ticket panel\` — Post the ticket panel (Manage Server)`
    );
    return message.reply({ embeds: [embed] });
}

async function createTicket(message, args, guildConfig) {
    if (!getTicketSettings(guildConfig).enabled) return replyDisabled(message);

    const result = await openTicket({
        guild: message.guild,
        user: message.author,
        subject: args.join(' '),
        guildConfig
    });
    return message.reply({ embeds: [await openResultEmbed(message.guild.id, result)] });
}

async function closeCurrentTicket(message, args, guildConfig) {
    const ticket = await requireOpenTicket(message);
    if (!ticket) return;

    if (!canCloseTicket(ticket, message.member, guildConfig, memberPermissions(message))) {
        const embed = await errorEmbed(message.guild.id, 'Permission Denied',
            `${GLYPHS.LOCK} Only the ticket opener or the support team may close this ticket, Master.`);
        return message.reply({ embeds: [embed] });
    }

    const closed = await closeTicket({
        guild: message.guild,
        channel: message.channel,
        ticket,
        closer: message.author,
        reason: args.join(' '),
        guildConfig
    });

    if (!closed) {
        const embed = await warningEmbed(message.guild.id, 'Ticket Closed',
            `${GLYPHS.WARNING} This ticket is already being closed, Master.`);
        return message.reply({ embeds: [embed] });
    }
    // closeTicket announces the closure in the channel, which is about to be deleted
}

async function addUser(message, args, guildConfig) {
    const guildId = message.guild.id;
    const ticket = await requireOpenTicket(message);
    if (!ticket) return;

    if (!isTicketStaff(message.member, guildConfig, memberPermissions(message))) {
        return replyStaffOnly(message, 'add users to a ticket');
    }

    const userId = resolveTargetUserId(message, args);
    const member = userId
        ? message.mentions?.members?.get(userId) ?? await message.guild.members.fetch(userId).catch(() => null)
        : null;
    if (!member) {
        const prefix = await getPrefix(guildId);
        const embed = await errorEmbed(guildId, 'No User',
            `${GLYPHS.ERROR} Please mention a member of this server to add, Master.\n\n` +
            `**Usage:** \`${prefix}ticket add @user\``
        );
        return message.reply({ embeds: [embed] });
    }

    // Replacing the opener's or the bot's overwrite would strip permissions they need
    if (member.id === ticket.userId || member.id === message.client.user.id) {
        const embed = await warningEmbed(guildId, 'Already Present',
            `${GLYPHS.WARNING} ${member} already has access to this ticket, Master.`);
        return message.reply({ embeds: [embed] });
    }

    await message.channel.permissionOverwrites.create(member.id, ADDED_USER_PERMISSIONS, {
        type: OverwriteType.Member,
        reason: `Added to ticket #${ticket.ticketNumber} by ${message.author.tag}`
    });
    await Ticket.updateOne({ _id: ticket._id }, { $addToSet: { participants: member.id } });

    const embed = await successEmbed(guildId, 'User Added',
        `${GLYPHS.SUCCESS} ${member} has been added to this ticket, Master.`);
    return message.reply({ embeds: [embed] });
}

async function removeUser(message, args, guildConfig) {
    const guildId = message.guild.id;
    const ticket = await requireOpenTicket(message);
    if (!ticket) return;

    if (!isTicketStaff(message.member, guildConfig, memberPermissions(message))) {
        return replyStaffOnly(message, 'remove users from a ticket');
    }

    const userId = resolveTargetUserId(message, args);
    if (!userId) {
        const prefix = await getPrefix(guildId);
        const embed = await errorEmbed(guildId, 'No User',
            `${GLYPHS.ERROR} Please mention a user to remove, Master.\n\n` +
            `**Usage:** \`${prefix}ticket remove @user\``
        );
        return message.reply({ embeds: [embed] });
    }

    if (userId === ticket.userId) {
        const embed = await errorEmbed(guildId, 'Cannot Remove',
            `${GLYPHS.ERROR} The ticket creator cannot be removed from their own ticket, Master.`);
        return message.reply({ embeds: [embed] });
    }
    if (userId === message.client.user.id) {
        const embed = await errorEmbed(guildId, 'Cannot Remove',
            `${GLYPHS.ERROR} I must retain access to this channel in order to manage the ticket, Master.`);
        return message.reply({ embeds: [embed] });
    }

    try {
        await message.channel.permissionOverwrites.delete(userId,
            `Removed from ticket #${ticket.ticketNumber} by ${message.author.tag}`);
    } catch (error) {
        if (error?.code !== UNKNOWN_OVERWRITE) throw error;
    }
    await Ticket.updateOne({ _id: ticket._id }, { $pull: { participants: userId } });

    const embed = await successEmbed(guildId, 'User Removed',
        `${GLYPHS.SUCCESS} <@${userId}> has been removed from this ticket, Master.`);
    return message.reply({ embeds: [embed] });
}

async function claimCurrentTicket(message, guildConfig) {
    const guildId = message.guild.id;
    const ticket = await requireOpenTicket(message);
    if (!ticket) return;

    if (!isTicketStaff(message.member, guildConfig, memberPermissions(message))) {
        return replyStaffOnly(message, 'claim tickets');
    }

    const claimed = ticket.status === 'open'
        ? await claimTicket({ ticket, claimer: message.author, channel: message.channel })
        : null;

    if (!claimed) {
        const current = await findChannelTicket(guildId, message.channel.id);
        const holder = current?.claimedByTag ? ` by **${current.claimedByTag}**` : '';
        const embed = await warningEmbed(guildId, 'Already Claimed',
            `${GLYPHS.WARNING} This ticket has already been claimed${holder}, Master.`);
        return message.reply({ embeds: [embed] });
    }

    return message.reply({ embeds: [await claimAnnouncementEmbed(guildId, message.author)] });
}

async function renameTicket(message, args, guildConfig) {
    const guildId = message.guild.id;
    const ticket = await requireOpenTicket(message);
    if (!ticket) return;

    if (!isTicketStaff(message.member, guildConfig, memberPermissions(message))) {
        return replyStaffOnly(message, 'rename tickets');
    }

    const newName = args.join('-')
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, '')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, CHANNEL_NAME_MAX - RENAME_PREFIX.length);
    if (!newName) {
        const prefix = await getPrefix(guildId);
        const embed = await errorEmbed(guildId, 'Invalid Name',
            `${GLYPHS.ERROR} Please provide a valid name, Master.\n\n` +
            `**Usage:** \`${prefix}ticket rename <name>\``
        );
        return message.reply({ embeds: [embed] });
    }

    await message.channel.setName(`${RENAME_PREFIX}${newName}`, `Renamed by ${message.author.tag}`);

    const embed = await successEmbed(guildId, 'Ticket Renamed',
        `${GLYPHS.SUCCESS} This ticket has been renamed to \`${RENAME_PREFIX}${newName}\`, Master.`);
    return message.reply({ embeds: [embed] });
}

async function createPanel(message, guildConfig) {
    const guildId = message.guild.id;
    if (!getTicketSettings(guildConfig).enabled) return replyDisabled(message);

    if (!message.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
        const embed = await errorEmbed(guildId, 'Permission Denied',
            `${GLYPHS.LOCK} You require the **Manage Server** permission to post the ticket panel, Master.`);
        return message.reply({ embeds: [embed] });
    }

    const panelEmbed = new EmbedBuilder()
        .setColor(COLORS.RAPHAEL)
        .setTitle('『 Support Tickets 』')
        .setDescription(
            '**Assistance is available upon request.**\n\n' +
            'Select the button below to open a private support ticket. ' +
            'A member of the support team will attend to you as soon as possible.\n\n' +
            '**Guidelines:**\n' +
            `${GLYPHS.DOT} Remain patient and respectful\n` +
            `${GLYPHS.DOT} Describe your issue clearly and in detail\n` +
            `${GLYPHS.DOT} Open one ticket per issue`
        )
        .setFooter({ text: getRandomFooter() })
        .setTimestamp();

    const ticketButton = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('create_ticket')
            .setLabel('Create Ticket')
            .setStyle(ButtonStyle.Primary)
    );

    await message.channel.send({ embeds: [panelEmbed], components: [ticketButton] });

    try {
        await message.delete();
    } catch {
        // Missing Manage Messages, or the invocation was not a deletable message
    }
}
