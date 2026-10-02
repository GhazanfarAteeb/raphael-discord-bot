import {
    Events,
    EmbedBuilder,
    ChannelType,
    PermissionFlagsBits,
    OverwriteType,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    AttachmentBuilder,
    MessageFlags
} from 'discord.js';
import Guild from '../../models/Guild.js';
import Ticket from '../../models/Ticket.js';
import { successEmbed, errorEmbed, warningEmbed, COLORS, GLYPHS } from '../../utils/embeds.js';
import { getRandomFooter } from '../../utils/raphael.js';

// Shared ticket logic. The ticket command (src/commands/utility/ticket.js) imports these helpers
// so the prefix command and the buttons below apply the same rules.

export const OPEN_STATUSES = ['open', 'claimed'];
export const CHANNEL_NAME_MAX = 100;

const DEFAULT_MAX_TICKETS = 5;
const DEFAULT_SUBJECT = 'Support Request';
const DEFAULT_CLOSE_REASON = 'No reason provided';
const SUBJECT_MAX_LENGTH = 1000;
const REASON_MAX_LENGTH = 1000;
const CHANNEL_TOPIC_MAX = 1024;
const FIELD_VALUE_MAX = 1024;
const DELETE_DELAY_MS = 5000;
const TRANSCRIPT_MAX_MESSAGES = 1000;
const FETCH_BATCH_SIZE = 100;

// Discord error codes handled explicitly
const UNKNOWN_CHANNEL = 10003;
const INVALID_FORM_BODY = 50035; // e.g. the category already holds the maximum of 50 channels

const PARTICIPANT_PERMISSIONS = [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.ReadMessageHistory,
    PermissionFlagsBits.AttachFiles
];
const BOT_PERMISSIONS = [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.ReadMessageHistory, // needed to fetch the history for the transcript
    PermissionFlagsBits.EmbedLinks,
    PermissionFlagsBits.AttachFiles,
    PermissionFlagsBits.ManageChannels,
    PermissionFlagsBits.ManageMessages
];

// Guild+user pairs with a ticket being created right now: stops a double click from
// slipping past the open-ticket limit before the first ticket is saved
const pendingCreations = new Set();

export function truncate(text, max) {
    const value = String(text ?? '');
    return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

export function getTicketSettings(guildConfig) {
    const ticketSystem = guildConfig?.features?.ticketSystem || {};
    const roles = guildConfig?.roles || {};
    const supportRoles = (ticketSystem.supportRoles || []).filter(Boolean);
    // No command sets supportRoles yet, so fall back to the staff/moderator roles from setrole;
    // otherwise only Discord administrators could see or work tickets
    const teamRoles = supportRoles.length > 0
        ? supportRoles
        : [...(roles.staffRoles || []), ...(roles.moderatorRoles || [])];
    const maxTickets = Number(ticketSystem.maxTickets);

    return {
        enabled: Boolean(ticketSystem.enabled),
        categoryId: ticketSystem.category || null,
        // channels.ticketLog is what setlogs edits; setup writes both to the same channel
        logChannelId: guildConfig?.channels?.ticketLog || ticketSystem.logChannel || null,
        maxTickets: Number.isInteger(maxTickets) && maxTickets > 0 ? maxTickets : DEFAULT_MAX_TICKETS,
        // Never treat @everyone as a staff role
        staffRoleIds: [...new Set(teamRoles)].filter(id => id && id !== guildConfig?.guildId),
        adminRoleIds: (roles.adminRoles || []).filter(id => id && id !== guildConfig?.guildId)
    };
}

function memberRoleIds(member) {
    if (member?.roles?.cache) return [...member.roles.cache.keys()];
    return Array.isArray(member?.roles) ? member.roles : [];
}

// Support team: Manage Channels (Administrator implies it), a ticket support role, or a bot admin role
export function isTicketStaff(member, guildConfig, permissions = member?.permissions) {
    if (!member) return false;
    if (permissions?.has?.(PermissionFlagsBits.ManageChannels)) return true;

    const { staffRoleIds, adminRoleIds } = getTicketSettings(guildConfig);
    const allowed = new Set([...staffRoleIds, ...adminRoleIds]);
    return memberRoleIds(member).some(roleId => allowed.has(roleId));
}

// The opener may close their own ticket; everything else is reserved for the support team
export function canCloseTicket(ticket, member, guildConfig, permissions) {
    if (!ticket || !member) return false;
    const memberId = member.id ?? member.user?.id;
    return ticket.userId === memberId || isTicketStaff(member, guildConfig, permissions);
}

export async function findChannelTicket(guildId, channelId) {
    return Ticket.findOne({ guildId, channelId }).sort({ createdAt: -1 }).lean();
}

async function resolveTextChannel(guild, channelId) {
    if (!channelId) return null;
    const channel = guild.channels.cache.get(channelId)
        ?? await guild.channels.fetch(channelId).catch(() => null);
    return channel?.isTextBased?.() ? channel : null;
}

async function sendTicketLog(guild, settings, payload) {
    try {
        const logChannel = await resolveTextChannel(guild, settings.logChannelId);
        if (!logChannel) return null;
        return await logChannel.send(payload);
    } catch (error) {
        console.error('[Ticket] Failed to write to the ticket log channel:', error);
        return null;
    }
}

// Open tickets whose channel was deleted by hand would count against the limit forever
async function countOpenTickets(guild, userId) {
    const tickets = await Ticket.find({ guildId: guild.id, userId, status: { $in: OPEN_STATUSES } })
        .select('_id channelId')
        .lean();

    const staleIds = [];
    for (const ticket of tickets) {
        if (ticket.channelId && guild.channels.cache.has(ticket.channelId)) continue;
        const exists = ticket.channelId
            ? await guild.channels.fetch(ticket.channelId)
                .then(Boolean)
                .catch(error => error?.code !== UNKNOWN_CHANNEL)
            : false;
        if (!exists) staleIds.push(ticket._id);
    }

    if (staleIds.length > 0) {
        await Ticket.updateMany(
            { _id: { $in: staleIds }, status: { $in: OPEN_STATUSES } },
            { $set: { status: 'closed', closedAt: new Date(), closeReason: 'Ticket channel no longer exists' } }
        ).catch(error => console.error('[Ticket] Failed to close stale tickets:', error));
    }

    return tickets.length - staleIds.length;
}

// A deleted or retyped category must not break every ticket: create without a parent instead
async function resolveCategory(guild, categoryId) {
    if (!categoryId) return { parentId: null, categoryMissing: false };
    const category = guild.channels.cache.get(categoryId)
        ?? await guild.channels.fetch(categoryId).catch(() => null);
    if (category?.type === ChannelType.GuildCategory) return { parentId: category.id, categoryMissing: false };
    return { parentId: null, categoryMissing: true };
}

async function createTicketChannel(guild, { name, topic, parentId, user, staffRoleIds }) {
    const me = guild.members.me;
    // A channel cannot be created with allow bits the bot does not hold itself
    const grantable = permissions => permissions.filter(permission => me.permissions.has(permission));

    const permissionOverwrites = [
        { id: guild.roles.everyone.id, type: OverwriteType.Role, deny: [PermissionFlagsBits.ViewChannel] },
        { id: user.id, type: OverwriteType.Member, allow: grantable(PARTICIPANT_PERMISSIONS) },
        { id: me.id, type: OverwriteType.Member, allow: grantable(BOT_PERMISSIONS) },
        ...staffRoleIds
            .filter(roleId => guild.roles.cache.has(roleId))
            .map(roleId => ({ id: roleId, type: OverwriteType.Role, allow: grantable(PARTICIPANT_PERMISSIONS) }))
    ];

    const options = {
        name,
        type: ChannelType.GuildText,
        topic,
        permissionOverwrites,
        reason: `Support ticket opened by ${user.tag}`
    };

    if (!parentId) return { channel: await guild.channels.create(options), parentDropped: false };

    try {
        return { channel: await guild.channels.create({ ...options, parent: parentId }), parentDropped: false };
    } catch (error) {
        if (error?.code !== INVALID_FORM_BODY) throw error;
        console.warn('[Ticket] Ticket category rejected the channel, creating it without a category:', error.message);
        return { channel: await guild.channels.create(options), parentDropped: true };
    }
}

function buildWelcomeEmbed(ticketNumber, subject) {
    return new EmbedBuilder()
        .setColor(COLORS.RAPHAEL)
        .setTitle(`『 Ticket #${ticketNumber} 』`)
        .setDescription(
            'Your support request has been registered, Master.\n\n' +
            'A member of the support team will attend to you shortly. ' +
            'In the meantime, please describe your issue in as much detail as possible.'
        )
        .addFields({ name: `${GLYPHS.ARROW_RIGHT} Subject`, value: truncate(subject, FIELD_VALUE_MAX) })
        .setFooter({ text: getRandomFooter() })
        .setTimestamp();
}

function buildTicketButtons() {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('ticket_close')
            .setLabel('Close Ticket')
            .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
            .setCustomId('ticket_claim')
            .setLabel('Claim Ticket')
            .setStyle(ButtonStyle.Primary)
    );
}

/**
 * Opens a ticket channel for a user.
 * @returns {Promise<{status: 'created'|'limit'|'busy'|'missing_permissions', channel?, ticket?, maxTickets?, categoryMissing?}>}
 */
export async function openTicket({ guild, user, subject, guildConfig }) {
    const settings = getTicketSettings(guildConfig);
    const lockKey = `${guild.id}:${user.id}`;
    if (pendingCreations.has(lockKey)) return { status: 'busy' };
    pendingCreations.add(lockKey);

    try {
        if (!guild.members.me?.permissions.has(PermissionFlagsBits.ManageChannels)) {
            return { status: 'missing_permissions' };
        }

        const openCount = await countOpenTickets(guild, user.id);
        if (openCount >= settings.maxTickets) {
            return { status: 'limit', maxTickets: settings.maxTickets };
        }

        const cleanSubject = truncate(subject?.trim() || DEFAULT_SUBJECT, SUBJECT_MAX_LENGTH);
        const ticketNumber = await Ticket.getNextTicketNumber(guild.id);
        const { parentId, categoryMissing } = await resolveCategory(guild, settings.categoryId);

        const { channel, parentDropped } = await createTicketChannel(guild, {
            name: `ticket-${ticketNumber}`,
            topic: truncate(`Ticket #${ticketNumber} | ${user.tag} | ${cleanSubject}`, CHANNEL_TOPIC_MAX),
            parentId,
            user,
            staffRoleIds: settings.staffRoleIds
        });

        let ticket;
        try {
            ticket = await Ticket.create({
                guildId: guild.id,
                ticketNumber,
                channelId: channel.id,
                userId: user.id,
                username: user.tag,
                subject: cleanSubject,
                status: 'open',
                participants: [user.id]
            });
        } catch (error) {
            // Without a record the channel could never be closed through the bot
            await channel.delete('Ticket record could not be saved').catch(() => null);
            throw error;
        }

        try {
            await channel.send({
                content: `${user}`,
                embeds: [buildWelcomeEmbed(ticketNumber, cleanSubject)],
                components: [buildTicketButtons()]
            });
        } catch (error) {
            console.error(`[Ticket] Failed to send the welcome message for ticket #${ticketNumber}:`, error);
        }

        const logEmbed = new EmbedBuilder()
            .setColor(COLORS.RAPHAEL_SUCCESS)
            .setTitle('『 Ticket Opened 』')
            .addFields(
                { name: `${GLYPHS.ARROW_RIGHT} Ticket`, value: `#${ticketNumber}`, inline: true },
                { name: `${GLYPHS.ARROW_RIGHT} Opened By`, value: `${user.tag} (${user.id})`, inline: true },
                { name: `${GLYPHS.ARROW_RIGHT} Channel`, value: `${channel}`, inline: true },
                { name: `${GLYPHS.ARROW_RIGHT} Subject`, value: truncate(cleanSubject, FIELD_VALUE_MAX) }
            )
            .setFooter({ text: getRandomFooter() })
            .setTimestamp();
        await sendTicketLog(guild, settings, { embeds: [logEmbed] });

        return { status: 'created', channel, ticket, categoryMissing: categoryMissing || parentDropped };
    } finally {
        pendingCreations.delete(lockKey);
    }
}

// Reply embed describing the result of openTicket, shared by the command and the panel button
export async function openResultEmbed(guildId, result) {
    switch (result.status) {
        case 'busy':
            return warningEmbed(guildId, 'Request In Progress',
                `${GLYPHS.WARNING} A ticket is already being opened for you, Master. Please wait a moment.`);
        case 'missing_permissions':
            return errorEmbed(guildId, 'Missing Permissions',
                `${GLYPHS.ERROR} I require the **Manage Channels** permission to open ticket channels, Master.`);
        case 'limit':
            return errorEmbed(guildId, 'Ticket Limit',
                `${GLYPHS.ERROR} You already have ${result.maxTickets} open ticket${result.maxTickets === 1 ? '' : 's'}, Master.\n\n` +
                'Please close an existing ticket before opening a new one.');
        default: {
            const note = result.categoryMissing
                ? '\n\n**Note:** The configured ticket category is missing or full, so this ticket was created ' +
                  'outside of it. An administrator should reconfigure the ticket category.'
                : '';
            return successEmbed(guildId, 'Ticket Created',
                `${GLYPHS.SUCCESS} Your ticket has been opened, Master: ${result.channel}${note}`);
        }
    }
}

function formatTimestamp(date) {
    if (!date) return 'unknown';
    return `${new Date(date).toISOString().replace('T', ' ').slice(0, 19)} UTC`;
}

// Fetches up to `maxMessages` of the most recent messages, oldest first
async function fetchChannelHistory(channel, maxMessages) {
    const messages = [];
    let before;

    while (messages.length < maxMessages) {
        const limit = Math.min(FETCH_BATCH_SIZE, maxMessages - messages.length);
        const batch = await channel.messages.fetch({ limit, before, cache: false });
        if (batch.size === 0) break;

        messages.push(...batch.values());
        before = batch.reduce((oldest, msg) => (BigInt(msg.id) < BigInt(oldest.id) ? msg : oldest)).id;
        if (batch.size < limit) break;
    }

    messages.sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
    return { messages, truncated: messages.length >= maxMessages };
}

function formatTranscript(ticket, guild, messages, truncated) {
    const lines = [
        `Transcript of ticket #${ticket.ticketNumber}`,
        `Server: ${guild.name} (${guild.id})`,
        `Subject: ${ticket.subject || DEFAULT_SUBJECT}`,
        `Opened by: ${ticket.username || 'Unknown'} (${ticket.userId})`,
        `Opened at: ${formatTimestamp(ticket.createdAt)}`,
        `Claimed by: ${ticket.claimedBy ? `${ticket.claimedByTag || 'Unknown'} (${ticket.claimedBy})` : 'Not claimed'}`,
        `Closed by: ${ticket.closedByTag || 'Unknown'} (${ticket.closedBy || 'unknown'})`,
        `Closed at: ${formatTimestamp(ticket.closedAt)}`,
        `Reason: ${ticket.closeReason || DEFAULT_CLOSE_REASON}`,
        `Messages: ${messages.length}${truncated ? ` (limited to the most recent ${TRANSCRIPT_MAX_MESSAGES})` : ''}`,
        '='.repeat(60),
        ''
    ];

    for (const msg of messages) {
        const author = msg.author ? `${msg.author.tag} (${msg.author.id})` : 'Unknown';
        const content = (msg.content || '').replace(/\n/g, '\n    ');
        lines.push(`[${formatTimestamp(msg.createdAt)}] ${author}: ${content}`.trimEnd());
        for (const attachment of msg.attachments.values()) {
            lines.push(`    Attachment: ${attachment.name} ${attachment.url}`);
        }
        for (const embed of msg.embeds) {
            if (embed.title) lines.push(`    Embed: ${embed.title}`);
        }
    }

    return lines.join('\n');
}

async function buildTranscript(channel, ticket, guild) {
    const { messages, truncated } = await fetchChannelHistory(channel, TRANSCRIPT_MAX_MESSAGES);
    return {
        buffer: Buffer.from(formatTranscript(ticket, guild, messages, truncated), 'utf8'),
        name: `ticket-${ticket.ticketNumber}-transcript.txt`,
        count: messages.length
    };
}

function transcriptAttachment(transcript) {
    return new AttachmentBuilder(transcript.buffer, { name: transcript.name });
}

async function sendTranscriptToOpener(client, ticket, guild, transcript) {
    try {
        const opener = await client.users.fetch(ticket.userId);
        const embed = new EmbedBuilder()
            .setColor(COLORS.RAPHAEL)
            .setTitle('『 Ticket Transcript 』')
            .setDescription(
                `Your ticket **#${ticket.ticketNumber}** in **${guild.name}** has been closed, Master. ` +
                'A transcript of the conversation is attached for your records.'
            )
            .addFields(
                { name: `${GLYPHS.ARROW_RIGHT} Closed By`, value: ticket.closedByTag || 'Unknown', inline: true },
                { name: `${GLYPHS.ARROW_RIGHT} Reason`, value: truncate(ticket.closeReason || DEFAULT_CLOSE_REASON, FIELD_VALUE_MAX) }
            )
            .setFooter({ text: getRandomFooter() })
            .setTimestamp();
        await opener.send({ embeds: [embed], files: [transcriptAttachment(transcript)] });
    } catch {
        // DMs closed or the opener left: the log channel keeps the transcript
    }
}

function scheduleChannelDeletion(channel, ticketNumber) {
    setTimeout(async () => {
        try {
            await channel.delete(`Ticket #${ticketNumber} closed`);
        } catch (error) {
            if (error?.code !== UNKNOWN_CHANNEL) {
                console.error(`[Ticket] Failed to delete the channel of ticket #${ticketNumber}:`, error);
            }
        }
    }, DELETE_DELAY_MS);
}

/**
 * Closes a ticket: records the closure, archives a transcript to the log channel and the
 * opener's DMs, then deletes the channel. Returns false when the ticket was already closed,
 * so a double click or a concurrent command only runs this once.
 */
export async function closeTicket({ guild, channel, ticket, closer, reason, guildConfig }) {
    const settings = getTicketSettings(guildConfig);
    const closeReason = truncate(reason?.trim() || DEFAULT_CLOSE_REASON, REASON_MAX_LENGTH);

    const closed = await Ticket.findOneAndUpdate(
        { _id: ticket._id, status: { $in: OPEN_STATUSES } },
        {
            $set: {
                status: 'closed',
                closedBy: closer.id,
                closedByTag: closer.tag,
                closedAt: new Date(),
                closeReason
            }
        },
        { new: true }
    ).lean();
    if (!closed) return false;

    try {
        const closeEmbed = new EmbedBuilder()
            .setColor(COLORS.RAPHAEL_ERROR)
            .setTitle('『 Ticket Closed 』')
            .setDescription(
                `This ticket has been closed by ${closer}.\n\n` +
                `**Reason:** ${closeReason}\n\n` +
                'A transcript is being archived. This channel will be deleted shortly, Master.'
            )
            .setFooter({ text: getRandomFooter() })
            .setTimestamp();
        await channel.send({ embeds: [closeEmbed] });
    } catch (error) {
        console.error(`[Ticket] Failed to announce the closure of ticket #${closed.ticketNumber}:`, error);
    }

    // A transcript failure must never keep the ticket open
    let transcript = null;
    try {
        transcript = await buildTranscript(channel, closed, guild);
    } catch (error) {
        console.error(`[Ticket] Failed to build the transcript of ticket #${closed.ticketNumber}:`, error);
    }

    const logFields = [
        { name: `${GLYPHS.ARROW_RIGHT} Ticket`, value: `#${closed.ticketNumber}`, inline: true },
        { name: `${GLYPHS.ARROW_RIGHT} Opened By`, value: closed.username || `<@${closed.userId}>`, inline: true },
        { name: `${GLYPHS.ARROW_RIGHT} Closed By`, value: closer.tag, inline: true }
    ];
    if (closed.claimedByTag) {
        logFields.push({ name: `${GLYPHS.ARROW_RIGHT} Claimed By`, value: closed.claimedByTag, inline: true });
    }
    logFields.push(
        { name: `${GLYPHS.ARROW_RIGHT} Reason`, value: truncate(closeReason, FIELD_VALUE_MAX) },
        {
            name: `${GLYPHS.ARROW_RIGHT} Transcript`,
            value: transcript ? `${transcript.count} message${transcript.count === 1 ? '' : 's'} archived (attached)` : 'Unavailable'
        }
    );
    const logEmbed = new EmbedBuilder()
        .setColor(COLORS.RAPHAEL_ERROR)
        .setTitle('『 Ticket Closed 』')
        .addFields(logFields)
        .setFooter({ text: getRandomFooter() })
        .setTimestamp();

    let logMessage = null;
    if (transcript) {
        logMessage = await sendTicketLog(guild, settings, { embeds: [logEmbed], files: [transcriptAttachment(transcript)] });
    }
    if (!logMessage) {
        // No transcript, or the log channel refused the file (e.g. no Attach Files permission)
        if (transcript) logEmbed.spliceFields(-1, 1, { name: `${GLYPHS.ARROW_RIGHT} Transcript`, value: 'Could not be attached' });
        await sendTicketLog(guild, settings, { embeds: [logEmbed] });
    }

    const transcriptUrl = logMessage?.attachments?.first()?.url;
    if (transcriptUrl) {
        await Ticket.updateOne({ _id: closed._id }, { $set: { transcriptUrl } })
            .catch(error => console.error(`[Ticket] Failed to save the transcript URL of ticket #${closed.ticketNumber}:`, error));
    }

    if (transcript) await sendTranscriptToOpener(channel.client, closed, guild, transcript);

    scheduleChannelDeletion(channel, closed.ticketNumber);
    return true;
}

/**
 * Claims an open ticket for a staff member. Returns the updated ticket, or null when it was
 * claimed or closed in the meantime.
 */
export async function claimTicket({ ticket, claimer, channel }) {
    const claimed = await Ticket.findOneAndUpdate(
        { _id: ticket._id, status: 'open' },
        { $set: { status: 'claimed', claimedBy: claimer.id, claimedByTag: claimer.tag, claimedAt: new Date() } },
        { new: true }
    ).lean();
    if (!claimed) return null;

    // Not awaited: Discord allows two renames per ten minutes and discord.js waits out the limit
    channel.setName(`claimed-${claimed.ticketNumber}`, `Ticket claimed by ${claimer.tag}`)
        .catch(error => console.error(`[Ticket] Failed to rename claimed ticket #${claimed.ticketNumber}:`, error));

    return claimed;
}

export async function claimAnnouncementEmbed(guildId, claimer) {
    return successEmbed(guildId, 'Ticket Claimed',
        `${GLYPHS.SUCCESS} ${claimer} has claimed this ticket and will be handling this request, Master.`);
}

// ==================== BUTTONS ====================

const TICKET_BUTTONS = new Set(['create_ticket', 'ticket_close', 'ticket_claim']);

export default {
    name: Events.InteractionCreate,
    once: false,

    async execute(interaction) {
        if (!interaction.isButton() || !TICKET_BUTTONS.has(interaction.customId)) return;
        if (!interaction.inGuild() || !interaction.guild) return;

        try {
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            const guildConfig = await Guild.getGuild(interaction.guild.id);

            switch (interaction.customId) {
                case 'create_ticket':
                    return await handleCreateButton(interaction, guildConfig);
                case 'ticket_close':
                    return await handleCloseButton(interaction, guildConfig);
                default:
                    return await handleClaimButton(interaction, guildConfig);
            }
        } catch (error) {
            console.error(`[Ticket] Button ${interaction.customId} failed:`, error);
            try {
                const embed = await errorEmbed(interaction.guild.id, 'Ticket Error',
                    `${GLYPHS.ERROR} I was unable to complete that ticket operation, Master. Please try again shortly.`);
                if (interaction.deferred || interaction.replied) {
                    await interaction.editReply({ embeds: [embed] });
                } else {
                    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
                }
            } catch {
                // The interaction expired or the channel is already gone
            }
        }
    }
};

async function handleCreateButton(interaction, guildConfig) {
    const guildId = interaction.guild.id;
    if (!getTicketSettings(guildConfig).enabled) {
        return interaction.editReply({
            embeds: [await errorEmbed(guildId, 'Tickets Disabled',
                `${GLYPHS.ERROR} The ticket system is not enabled on this server, Master.`)]
        });
    }

    const result = await openTicket({
        guild: interaction.guild,
        user: interaction.user,
        subject: DEFAULT_SUBJECT,
        guildConfig
    });
    return interaction.editReply({ embeds: [await openResultEmbed(guildId, result)] });
}

// Looks up the ticket of the button's channel; replies and returns null when it cannot be used
async function getActiveButtonTicket(interaction) {
    const guildId = interaction.guild.id;
    const ticket = await findChannelTicket(guildId, interaction.channelId);

    if (!ticket) {
        await interaction.editReply({
            embeds: [await errorEmbed(guildId, 'Not a Ticket', `${GLYPHS.ERROR} This is not a valid ticket channel, Master.`)]
        });
        return null;
    }
    if (!OPEN_STATUSES.includes(ticket.status)) {
        await interaction.editReply({
            embeds: [await warningEmbed(guildId, 'Ticket Closed', `${GLYPHS.WARNING} This ticket has already been closed, Master.`)]
        });
        return null;
    }
    return ticket;
}

async function handleCloseButton(interaction, guildConfig) {
    const guildId = interaction.guild.id;
    const ticket = await getActiveButtonTicket(interaction);
    if (!ticket) return;

    if (!canCloseTicket(ticket, interaction.member, guildConfig, interaction.memberPermissions)) {
        return interaction.editReply({
            embeds: [await errorEmbed(guildId, 'Permission Denied',
                `${GLYPHS.LOCK} Only the ticket opener or the support team may close this ticket, Master.`)]
        });
    }

    const channel = interaction.channel ?? await interaction.guild.channels.fetch(interaction.channelId);
    const closed = await closeTicket({
        guild: interaction.guild,
        channel,
        ticket,
        closer: interaction.user,
        reason: 'Closed via button',
        guildConfig
    });

    if (!closed) {
        return interaction.editReply({
            embeds: [await warningEmbed(guildId, 'Ticket Closed', `${GLYPHS.WARNING} This ticket is already being closed, Master.`)]
        });
    }
    return interaction.editReply({
        embeds: [await successEmbed(guildId, 'Ticket Closed',
            `${GLYPHS.SUCCESS} Closure confirmed, Master. The transcript has been archived and this channel will be deleted shortly.`)]
    });
}

async function handleClaimButton(interaction, guildConfig) {
    const guildId = interaction.guild.id;
    const ticket = await getActiveButtonTicket(interaction);
    if (!ticket) return;

    if (!isTicketStaff(interaction.member, guildConfig, interaction.memberPermissions)) {
        return interaction.editReply({
            embeds: [await errorEmbed(guildId, 'Permission Denied',
                `${GLYPHS.LOCK} Only the support team may claim tickets, Master.`)]
        });
    }

    const channel = interaction.channel ?? await interaction.guild.channels.fetch(interaction.channelId);
    const claimed = ticket.status === 'open'
        ? await claimTicket({ ticket, claimer: interaction.user, channel })
        : null;

    if (!claimed) {
        const current = await findChannelTicket(guildId, interaction.channelId);
        const holder = current?.claimedByTag ? ` by **${current.claimedByTag}**` : '';
        return interaction.editReply({
            embeds: [await warningEmbed(guildId, 'Already Claimed',
                `${GLYPHS.WARNING} This ticket has already been claimed${holder}, Master.`)]
        });
    }

    await channel.send({ embeds: [await claimAnnouncementEmbed(guildId, interaction.user)] });
    return interaction.editReply({
        embeds: [await successEmbed(guildId, 'Ticket Claimed',
            `${GLYPHS.SUCCESS} You have claimed ticket #${claimed.ticketNumber}, Master.`)]
    });
}
