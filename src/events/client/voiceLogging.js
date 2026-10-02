import { Events, EmbedBuilder, AuditLogEvent } from 'discord.js';
import Guild from '../../models/Guild.js';
import { COLORS, GLYPHS } from '../../utils/embeds.js';
import { sleep } from '../../utils/helpers.js';

// Audit log entries appear shortly after the gateway event
const AUDIT_LOG_DELAY_MS = 500;
const AUDIT_LOG_WINDOW_MS = 5000;
const AUDIT_LOG_FETCH_LIMIT = 5;
const GROUPED_ENTRY_CACHE_MAX = 1000;

// Move and disconnect audit entries have no target: Discord groups them per moderator and
// raises a count, so an action is recognised by a new entry or a higher count
const groupedEntryCounts = new Map(); // audit entry id -> last seen count

export default {
    name: 'voiceLogging',

    async initialize(client) {
        client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
            await logVoiceUpdate(oldState, newState);
        });

        console.log('[RAPHAEL] Voice logging initialized');
    }
};

// Whether a grouped (targetless) entry records an action that has just happened
function isFreshGroupedEntry(entry) {
    const count = entry.extra?.count ?? 1;
    const seen = groupedEntryCounts.get(entry.id);

    groupedEntryCounts.delete(entry.id);
    groupedEntryCounts.set(entry.id, count);
    if (groupedEntryCounts.size > GROUPED_ENTRY_CACHE_MAX) {
        groupedEntryCounts.delete(groupedEntryCounts.keys().next().value);
    }

    if (seen === undefined) return Date.now() - entry.createdTimestamp < AUDIT_LOG_WINDOW_MS;
    return count > seen;
}

/**
 * Who performed a voice action on `targetId`, from the audit log
 * @param {object} [filter]
 * @param {string} [filter.channelId] destination channel of a move
 * @param {string[]} [filter.changeKeys] only entries that changed one of these keys
 */
async function getVoiceActionExecutor(guild, targetId, actionType, { channelId = null, changeKeys = null } = {}) {
    try {
        await sleep(AUDIT_LOG_DELAY_MS);

        const auditLogs = await guild.fetchAuditLogs({
            limit: AUDIT_LOG_FETCH_LIMIT,
            type: actionType
        });

        let match = null;
        // Every entry is visited so the grouped counts stay current
        for (const entry of auditLogs.entries.values()) {
            let relevant;
            if (entry.target) {
                relevant = entry.target.id === targetId &&
                    Date.now() - entry.createdTimestamp < AUDIT_LOG_WINDOW_MS &&
                    (!changeKeys || entry.changes?.some(change => changeKeys.includes(change.key)));
            } else {
                relevant = isFreshGroupedEntry(entry) &&
                    (!channelId || !entry.extra?.channel?.id || entry.extra.channel.id === channelId);
            }

            if (relevant && !match) match = entry;
        }

        return match?.executor ?? null;
    } catch (error) {
        // Missing permissions to view audit logs
        return null;
    }
}

function describeExecutor(executor) {
    if (!executor) return 'Unknown';
    if (executor.id === executor.client.user.id) return 'System';
    if (executor.bot) return `${executor.username} (bot)`;
    return executor.username;
}

function formatChannel(channel, channelId) {
    if (channel) return `${channel} (${channel.name})`;
    return channelId ? `<#${channelId}>` : 'Unknown';
}

function voiceEmbed(member, title, color, description) {
    return new EmbedBuilder()
        .setTitle(`『 ${title} 』`)
        .setColor(color)
        .setDescription(description)
        .setThumbnail(member.user.displayAvatarURL())
        .setFooter({ text: `User ID: ${member.id}` })
        .setTimestamp();
}

function field(name, value, inline = true) {
    return { name: `${GLYPHS.ARROW_RIGHT} ${name}`, value, inline };
}

async function logVoiceUpdate(oldState, newState) {
    try {
        const member = newState.member || oldState.member;
        if (!member || member.user.bot) return;

        const guild = newState.guild || oldState.guild;
        const guildConfig = await Guild.getGuild(guild.id, guild.name);

        if (!guildConfig?.channels?.voiceLog) return;

        const logChannel = guild.channels.cache.get(guildConfig.channels.voiceLog);
        if (!logChannel) return;

        const oldId = oldState.channelId;
        const newId = newState.channelId;
        const memberField = field('Member', `${member.user.tag} (${member})`);
        let embed = null;

        // User joined a voice channel
        if (!oldId && newId) {
            embed = voiceEmbed(member, 'Voice Channel Joined', COLORS.RAPHAEL_SUCCESS,
                `${GLYPHS.ARROW_RIGHT} ${member} joined a voice channel.`)
                .addFields(
                    memberField,
                    field('Channel', formatChannel(newState.channel, newId))
                );
        }
        // User left a voice channel (could be disconnect by admin)
        else if (oldId && !newId) {
            const executor = await getVoiceActionExecutor(guild, member.id, AuditLogEvent.MemberDisconnect);
            const wasDisconnected = executor !== null;

            embed = voiceEmbed(member,
                wasDisconnected ? 'Voice Disconnect' : 'Voice Channel Left',
                wasDisconnected ? COLORS.RAPHAEL_WARNING : COLORS.RAPHAEL_ERROR,
                wasDisconnected
                    ? `${GLYPHS.ARROW_RIGHT} ${member} was disconnected from voice.`
                    : `${GLYPHS.ARROW_RIGHT} ${member} left a voice channel.`)
                .addFields(
                    memberField,
                    field('Channel', formatChannel(oldState.channel, oldId))
                );

            if (wasDisconnected) {
                embed.addFields(field('Disconnected By', describeExecutor(executor)));
            }
        }
        // User switched voice channels (could be moved by admin)
        else if (oldId && newId && oldId !== newId) {
            const executor = await getVoiceActionExecutor(guild, member.id, AuditLogEvent.MemberMove, { channelId: newId });
            const wasMoved = executor !== null;

            embed = voiceEmbed(member,
                wasMoved ? 'Voice Move' : 'Voice Channel Switch',
                wasMoved ? COLORS.RAPHAEL_WARNING : COLORS.RAPHAEL,
                wasMoved
                    ? `${GLYPHS.ARROW_RIGHT} ${member} was moved to another channel.`
                    : `${GLYPHS.ARROW_RIGHT} ${member} switched voice channels.`)
                .addFields(
                    memberField,
                    field('From', formatChannel(oldState.channel, oldId)),
                    field('To', formatChannel(newState.channel, newId))
                );

            if (wasMoved) {
                embed.addFields(field('Moved By', describeExecutor(executor)));
            }
        }
        // Voice state changes (mute/deafen/stream/video)
        else if (oldId && newId) {
            const changes = [];
            const serverChanges = [];

            // Self-performed actions
            if (oldState.selfMute !== newState.selfMute) {
                changes.push(newState.selfMute ? 'Self muted' : 'Self unmuted');
            }
            if (oldState.selfDeaf !== newState.selfDeaf) {
                changes.push(newState.selfDeaf ? 'Self deafened' : 'Self undeafened');
            }
            if (oldState.streaming !== newState.streaming) {
                changes.push(newState.streaming ? 'Started streaming' : 'Stopped streaming');
            }
            if (oldState.selfVideo !== newState.selfVideo) {
                changes.push(newState.selfVideo ? 'Camera on' : 'Camera off');
            }

            // Server-enforced actions (by admin/bot)
            if (oldState.serverMute !== newState.serverMute) {
                serverChanges.push(newState.serverMute ? 'Server muted' : 'Server unmuted');
            }
            if (oldState.serverDeaf !== newState.serverDeaf) {
                serverChanges.push(newState.serverDeaf ? 'Server deafened' : 'Server undeafened');
            }

            const asList = items => items.map(item => `${GLYPHS.DOT} ${item}`).join('\n');

            // Handle server-enforced changes with executor info
            if (serverChanges.length > 0) {
                const executor = await getVoiceActionExecutor(guild, member.id, AuditLogEvent.MemberUpdate, {
                    changeKeys: ['mute', 'deaf']
                });

                embed = voiceEmbed(member, 'Server Voice Action', COLORS.RAPHAEL_WARNING,
                    `${GLYPHS.ARROW_RIGHT} ${member}'s voice state was changed by the server.`)
                    .addFields(
                        memberField,
                        field('Channel', formatChannel(newState.channel, newId)),
                        field('By', describeExecutor(executor)),
                        field('Action', asList(serverChanges), false)
                    );
            }
            // Handle self-performed changes
            else if (changes.length > 0) {
                embed = voiceEmbed(member, 'Voice State Update', COLORS.RAPHAEL,
                    `${GLYPHS.ARROW_RIGHT} ${member}'s voice state changed.`)
                    .addFields(
                        memberField,
                        field('Channel', formatChannel(newState.channel, newId)),
                        field('By', 'Self'),
                        field('Changes', asList(changes), false)
                    );
            }
        }

        if (embed) {
            await logChannel.send({ embeds: [embed] });
        }

    } catch (error) {
        console.error('[VoiceLogging] Error logging voice update:', error);
    }
}
