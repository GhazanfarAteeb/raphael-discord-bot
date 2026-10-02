import { EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder, ButtonBuilder, ButtonStyle, MessageFlags, escapeMarkdown } from 'discord.js';
import Member from '../../models/Member.js';
import Guild from '../../models/Guild.js';
import { errorEmbed, COLORS, GLYPHS } from '../../utils/embeds.js';
import { getRandomFooter } from '../../utils/raphael.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const COLLECTOR_TIME_MS = 300000; // 5 minutes
const TOP_CHANNEL_COUNT = 5;
const RANK_GLYPHS = ['◆', '◈', '◇'];

// days: null means all time (uses the running totals instead of the 30-day history)
const TIME_RANGES = {
    '1d': { label: 'Last 24 Hours', description: 'View stats from the last day', days: 1 },
    '7d': { label: 'Last 7 Days', description: 'View stats from the last week', days: 7 },
    '14d': { label: 'Last 14 Days', description: 'View stats from the last 2 weeks', days: 14 },
    'total': { label: 'All Time', description: 'View all-time statistics', days: null }
};

export default {
    name: 'stats',
    description: 'View detailed server statistics with filters',
    usage: 'stats [@user]',
    category: 'utility',
    aliases: ['statistics', 'serverstats', 'userstats'],
    cooldown: 10,

    execute: async (message, args) => {
        const guildId = message.guild.id;
        const targetUser = message.mentions.users.first() || message.author;

        try {
            await message.channel.sendTyping().catch(() => {});

            const guildConfig = await Guild.getGuild(guildId);
            const footer = {
                text: `${message.guild?.name || guildConfig?.guildName || 'Unknown server'} • ${getRandomFooter()}`,
                iconURL: message.guild?.iconURL() || undefined
            };

            let snapshot = await loadSnapshot(targetUser, guildId);

            // Create select menu for time filter
            const timeFilterMenu = new StringSelectMenuBuilder()
                .setCustomId('stats_time_filter')
                .setPlaceholder('Select time range')
                .addOptions(Object.entries(TIME_RANGES).map(([value, range]) => ({
                    label: range.label,
                    description: range.description,
                    value
                })));

            const row1 = new ActionRowBuilder().addComponents(timeFilterMenu);

            // Create buttons for different stat views
            const row2 = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId('stats_messages')
                    .setLabel('Messages')
                    .setStyle(ButtonStyle.Primary),
                new ButtonBuilder()
                    .setCustomId('stats_voice')
                    .setLabel('Voice Activity')
                    .setStyle(ButtonStyle.Primary),
                new ButtonBuilder()
                    .setCustomId('stats_channels')
                    .setLabel('Top Channels')
                    .setStyle(ButtonStyle.Secondary),
                new ButtonBuilder()
                    .setCustomId('stats_refresh')
                    .setLabel('Refresh')
                    .setStyle(ButtonStyle.Success)
            );

            const reply = await message.reply({
                embeds: [renderView('overview', targetUser, snapshot, 'total', message.guild, footer)],
                components: [row1, row2]
            });

            // Create collector for interactions
            const collector = reply.createMessageComponentCollector({
                filter: (i) => i.user.id === message.author.id,
                time: COLLECTOR_TIME_MS
            });

            let currentTimeRange = 'total';
            let currentView = 'overview';

            collector.on('ignore', async (interaction) => {
                try {
                    await interaction.reply({
                        content: '**Notice:** These controls respond only to the member who requested these statistics, Master.',
                        flags: MessageFlags.Ephemeral
                    });
                } catch (error) {
                    console.error('[Stats] Failed to answer a foreign interaction:', error);
                }
            });

            collector.on('collect', async (interaction) => {
                try {
                    await interaction.deferUpdate();

                    if (interaction.isStringSelectMenu()) {
                        const value = interaction.values[0];
                        currentTimeRange = TIME_RANGES[value] ? value : 'total';
                    }

                    if (interaction.isButton()) {
                        if (interaction.customId === 'stats_messages') {
                            currentView = 'messages';
                        } else if (interaction.customId === 'stats_voice') {
                            currentView = 'voice';
                        } else if (interaction.customId === 'stats_channels') {
                            currentView = 'channels';
                        } else if (interaction.customId === 'stats_refresh') {
                            currentView = 'overview';
                            // Refresh data, ranks and time windows for every view
                            snapshot = await loadSnapshot(targetUser, guildId);
                        }
                    }

                    await interaction.editReply({
                        embeds: [renderView(currentView, targetUser, snapshot, currentTimeRange, message.guild, footer)]
                    });
                } catch (error) {
                    console.error('[Stats] Error handling interaction:', error);
                    try {
                        const payload = {
                            embeds: [await errorEmbed(guildId, 'The requested statistics could not be displayed, Master. Please try again.')],
                            flags: MessageFlags.Ephemeral
                        };
                        if (interaction.deferred || interaction.replied) await interaction.followUp(payload);
                        else await interaction.reply(payload);
                    } catch (replyError) {
                        console.error('[Stats] Failed to report interaction error:', replyError);
                    }
                }
            });

            collector.on('end', async () => {
                try {
                    // Disable components when collector ends
                    row1.components[0].setDisabled(true);
                    row2.components.forEach(btn => btn.setDisabled(true));
                    await reply.edit({ components: [row1, row2] });
                } catch {
                    // Message may have been deleted
                }
            });

        } catch (error) {
            console.error('[Stats] Error in stats command:', error);
            try {
                return await message.reply({
                    embeds: [await errorEmbed(guildId, 'An error occurred while compiling the statistics, Master. Please try again later.')]
                });
            } catch (replyError) {
                console.error('[Stats] Failed to send error reply:', replyError);
            }
        }
    }
};

// Load the member's record and everything derived from it, so every view and the
// refresh button work from the same data
async function loadSnapshot(targetUser, guildId) {
    const memberData = await Member.getMember(targetUser.id, guildId, {
        username: targetUser.username,
        discriminator: targetUser.discriminator,
        displayName: targetUser.displayName,
        globalName: targetUser.globalName,
        avatarUrl: targetUser.displayAvatarURL({ extension: 'png', size: 256 }),
        tag: targetUser.tag,
        createdAt: targetUser.createdAt
    });

    const now = Date.now();
    const totals = {
        messages: memberData.stats?.messagesCount || 0,
        voiceTime: memberData.stats?.voiceTime || 0
    };

    const ranges = {};
    for (const [key, range] of Object.entries(TIME_RANGES)) {
        ranges[key] = range.days
            ? calculateStatsForTimeRange(memberData, new Date(now - range.days * DAY_MS))
            : totals;
    }

    // Days this member has been tracked, for all-time averages
    const trackedSince = memberData.createdAt ? new Date(memberData.createdAt).getTime() : now;
    const trackedDays = Math.max(1, Math.ceil((now - trackedSince) / DAY_MS));

    // Ranks are counted in the database instead of loading every member record
    const [messageRank, voiceRank] = await Promise.all([
        calculateRank(guildId, 'stats.messagesCount', totals.messages),
        calculateRank(guildId, 'stats.voiceTime', totals.voiceTime)
    ]);

    return { memberData, totals, ranges, trackedDays, messageRank, voiceRank };
}

function calculateStatsForTimeRange(memberData, startDate) {
    const messageHistory = memberData.stats?.messageHistory || [];
    const voiceHistory = memberData.stats?.voiceHistory || [];

    // Filter messages within time range
    const messagesInRange = messageHistory.filter(entry => {
        return new Date(entry.date) >= startDate;
    }).reduce((sum, entry) => sum + (entry.count || 0), 0);

    // Filter voice time within time range
    const voiceInRange = voiceHistory.filter(entry => {
        return new Date(entry.date) >= startDate;
    }).reduce((sum, entry) => sum + (entry.minutes || 0), 0);

    return {
        messages: messagesInRange,
        voiceTime: voiceInRange
    };
}

// Competition rank (ties share a position) among members with a non-zero value
async function calculateRank(guildId, statField, value) {
    if (!value || value <= 0) return 'N/A';
    const ahead = await Member.countDocuments({ guildId, [statField]: { $gt: value } });
    return `#${(ahead + 1).toLocaleString()}`;
}

// Days to average over: the range length, or the tracked period when shorter / all time
function averagingDays(timeRange, trackedDays) {
    const days = TIME_RANGES[timeRange]?.days;
    return days ? Math.min(days, trackedDays) : trackedDays;
}

function formatMinutes(totalMinutes) {
    const minutes = Math.round(totalMinutes || 0);
    return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function baseEmbed(user, authorSuffix, footer) {
    return new EmbedBuilder()
        .setColor(COLORS.RAPHAEL)
        .setAuthor({
            name: `${user.displayName || user.username}'s ${authorSuffix}`,
            iconURL: user.displayAvatarURL()
        })
        .setThumbnail(user.displayAvatarURL({ size: 256 }))
        .setFooter(footer)
        .setTimestamp();
}

function renderView(view, user, snapshot, timeRange, guild, footer) {
    if (view === 'messages') return createMessageStatsEmbed(user, snapshot, timeRange, footer);
    if (view === 'voice') return createVoiceStatsEmbed(user, snapshot, timeRange, footer);
    if (view === 'channels') return createChannelStatsEmbed(user, snapshot, guild, footer);
    return createStatsEmbed(user, snapshot, timeRange, footer);
}

function createStatsEmbed(user, snapshot, timeRange, footer) {
    const stats = snapshot.ranges[timeRange];

    return baseEmbed(user, 'Statistics', footer)
        .setTitle(`『 Server Statistics — ${TIME_RANGES[timeRange].label} 』`)
        .setDescription('**Analysis:** Use the menu to change the time range, or the buttons for a detailed breakdown, Master.')
        .addFields(
            {
                name: `${GLYPHS.ARROW_RIGHT} Messages`,
                value: `**${stats.messages.toLocaleString()}** messages\nAll-time rank: ${snapshot.messageRank}`,
                inline: true
            },
            {
                name: `${GLYPHS.ARROW_RIGHT} Voice Activity`,
                value: `**${formatMinutes(stats.voiceTime)}**\nAll-time rank: ${snapshot.voiceRank}`,
                inline: true
            },
            {
                name: '​',
                value: '​',
                inline: true
            }
        );
}

function createMessageStatsEmbed(user, snapshot, timeRange, footer) {
    const stats = snapshot.ranges[timeRange];
    const avgPerDay = Math.round(stats.messages / averagingDays(timeRange, snapshot.trackedDays));

    return baseEmbed(user, 'Message Statistics', footer)
        .setTitle(`『 Message Activity — ${TIME_RANGES[timeRange].label} 』`)
        .setDescription('**Analysis:** Detailed breakdown of message activity, Master.')
        .addFields(
            {
                name: `${GLYPHS.ARROW_RIGHT} Messages Sent`,
                value: `**${stats.messages.toLocaleString()}** messages`,
                inline: true
            },
            {
                name: `${GLYPHS.ARROW_RIGHT} Daily Average`,
                value: `**${avgPerDay.toLocaleString()}** per day`,
                inline: true
            },
            {
                name: `${GLYPHS.ARROW_RIGHT} Total Messages`,
                value: `**${snapshot.totals.messages.toLocaleString()}**`,
                inline: true
            }
        );
}

function createVoiceStatsEmbed(user, snapshot, timeRange, footer) {
    const stats = snapshot.ranges[timeRange];
    const avgMinutesPerDay = stats.voiceTime / averagingDays(timeRange, snapshot.trackedDays);

    return baseEmbed(user, 'Voice Statistics', footer)
        .setTitle(`『 Voice Activity — ${TIME_RANGES[timeRange].label} 』`)
        .setDescription('**Analysis:** Detailed breakdown of voice channel activity, Master.')
        .addFields(
            {
                name: `${GLYPHS.ARROW_RIGHT} Time Spent`,
                value: `**${formatMinutes(stats.voiceTime)}**`,
                inline: true
            },
            {
                name: `${GLYPHS.ARROW_RIGHT} Daily Average`,
                value: `**${formatMinutes(avgMinutesPerDay)}**`,
                inline: true
            },
            {
                name: `${GLYPHS.ARROW_RIGHT} Total Time`,
                value: `**${formatMinutes(snapshot.totals.voiceTime)}**`,
                inline: true
            }
        );
}

// Channel counts are cumulative (no per-day history), so this view ignores the time filter
function createChannelStatsEmbed(user, snapshot, guild, footer) {
    const channelStats = snapshot.memberData.stats?.topChannels || [];
    const topChannels = [...channelStats]
        .sort((a, b) => (b.messageCount || 0) - (a.messageCount || 0))
        .slice(0, TOP_CHANNEL_COUNT);

    const lines = topChannels.map((channel, index) => {
        const channelLabel = guild.channels.cache.has(channel.channelId)
            ? `<#${channel.channelId}>`
            : channel.channelName ? `#${escapeMarkdown(channel.channelName)}` : 'Unknown Channel';
        const marker = index < RANK_GLYPHS.length ? RANK_GLYPHS[index] : GLYPHS.DOT;
        return `${marker} **#${index + 1}** ${channelLabel}\n${GLYPHS.ARROW_RIGHT} **${(channel.messageCount || 0).toLocaleString()}** messages`;
    });

    const intro = '**Analysis:** Most active channels by message count (all time; the time filter does not apply to this view), Master.';

    return baseEmbed(user, 'Top Channels', footer)
        .setTitle('『 Top Channels — All Time 』')
        .setDescription(lines.length
            ? `${intro}\n\n${lines.join('\n\n')}`
            : `${intro}\n\nNo channel activity has been recorded yet.`);
}
