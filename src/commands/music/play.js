/**
 * Play Command
 * Play a track or add to queue
 */

import Command from '../../structures/Command.js';
import { EmbedBuilder } from 'discord.js';
import { getRandomFooter } from '../../utils/raphael.js';

/**
 * Wait for a Riffy player's voice connection to be established.
 * Polls player.connected with a timeout.
 */
function waitForConnection(player, timeout = 10000) {
    return new Promise((resolve, reject) => {
        if (player.connected) return resolve();
        const start = Date.now();
        const interval = setInterval(() => {
            if (player.connected) {
                clearInterval(interval);
                resolve();
            } else if (Date.now() - start > timeout) {
                clearInterval(interval);
                reject(new Error('Voice connection timed out'));
            }
        }, 100);
    });
}

export default class Play extends Command {
    constructor(client) {
        super(client, {
            name: 'play',
            description: {
                content: 'Play a song or add it to the queue',
                usage: '<song name or URL>',
                examples: ['play Never Gonna Give You Up', 'play https://www.youtube.com/watch?v=dQw4w9WgXcQ']
            },
            aliases: ['p'],
            category: 'music',
            cooldown: 3,
            args: true,
            player: {
                voice: true,
                dj: false,
                active: false,
                djPerm: null
            },
            permissions: {
                dev: false,
                client: ['SendMessages', 'ViewChannel', 'EmbedLinks', 'Connect', 'Speak'],
                user: []
            },
            slashCommand: true,
            options: [
                {
                    name: 'query',
                    description: 'The song name or URL to play',
                    type: 3, // STRING
                    required: true
                }
            ]
        });
    }

    async run(client, ctx, args) {
        const query = args.join(' ');

        if (!query) {
            return ctx.sendMessage({
                embeds: [{
                    color: 0xFF4757,
                    title: '『 Audio System 』',
                    description: '**Warning:** No audio source specified, Master.\n\nPlease provide a track name or URL.'
                }]
            });
        }

        // Check if Riffy is initialized
        if (!client.riffy) {
            return ctx.sendMessage({
                embeds: [{
                    color: 0xFF4757,
                    title: '『 System Alert 』',
                    description: '**Warning:** Audio subsystem is currently unavailable, Master.\n\nPlease attempt again later.'
                }]
            });
        }

        const member = ctx.member;
        const voiceChannel = member.voice.channel;

        // Create or get player
        let player = client.riffy.players.get(ctx.guild.id);

        if (!player) {
            player = client.riffy.createConnection({
                guildId: ctx.guild.id,
                voiceChannel: voiceChannel.id,
                textChannel: ctx.channel.id,
                deaf: true
            });
        }

        // Resolve the query
        const resolve = await client.riffy.resolve({ query, requester: member });
        const { loadType, tracks, playlistInfo } = resolve;

        if (loadType === 'error') {
            return ctx.sendMessage({
                embeds: [{
                    color: 0xFF4757,
                    title: '『 Audio System 』',
                    description: '**Warning:** An anomaly occurred during track resolution, Master.'
                }]
            });
        }

        if (loadType === 'empty' || !tracks.length) {
            return ctx.sendMessage({
                embeds: [{
                    color: 0xFF4757,
                    title: '『 Audio System 』',
                    description: '**Notice:** No matching audio sources detected for your query, Master.'
                }]
            });
        }

        if (loadType === 'playlist') {
            for (const track of tracks) {
                track.info.requester = member;
                player.queue.add(track);
            }

            const embed = new EmbedBuilder()
                .setColor('#00CED1')
                .setTitle('『 Playlist Loaded 』')
                .setDescription(`**Confirmed.** Added **${tracks.length}** tracks from **${playlistInfo.name}** to the queue, Master.`)
                .setFooter({ text: getRandomFooter() })
                .setTimestamp();

            await ctx.sendMessage({ embeds: [embed] });

            if (!player.playing && !player.paused) {
                try {
                    await waitForConnection(player);
                    player.play();
                } catch (err) {
                    return ctx.sendMessage({
                        embeds: [{ color: 0xFF4757, title: '『 Audio System 』', description: '**Warning:** Failed to establish voice connection, Master. Please try again.' }]
                    });
                }
            }

        } else if (loadType === 'search' || loadType === 'track') {
            const track = tracks[0];
            track.info.requester = member;
            player.queue.add(track);

            // Format duration
            const formatDuration = (ms) => {
                const seconds = Math.floor((ms / 1000) % 60);
                const minutes = Math.floor((ms / (1000 * 60)) % 60);
                const hours = Math.floor(ms / (1000 * 60 * 60));

                if (hours > 0) {
                    return `${hours}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
                }
                return `${minutes}:${seconds.toString().padStart(2, '0')}`;
            };

            const embed = new EmbedBuilder()
                .setColor('#00CED1')
                .setTitle('『 Track Queued 』')
                .setDescription(`**Notice:** Audio source acquired and queued, Master.\n\n▸ [${track.info.title}](${track.info.uri})`)
                .addFields(
                    { name: '▸ Duration', value: formatDuration(track.info.length), inline: true },
                    { name: '▸ Artist', value: track.info.author || 'Unknown', inline: true },
                    { name: '▸ Queue Position', value: `#${player.queue.length}`, inline: true }
                )
                .setThumbnail(track.info.thumbnail || track.info.artworkUrl || null)
                .setFooter({ text: getRandomFooter() })
                .setTimestamp();

            await ctx.sendMessage({ embeds: [embed] });

            if (!player.playing && !player.paused) {
                try {
                    await waitForConnection(player);
                    player.play();
                } catch (err) {
                    return ctx.sendMessage({
                        embeds: [{ color: 0xFF4757, title: '『 Audio System 』', description: '**Warning:** Failed to establish voice connection, Master. Please try again.' }]
                    });
                }
            }
        }
    }
}
