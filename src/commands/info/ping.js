import { infoEmbed, errorEmbed, COLORS } from '../../utils/embeds.js';
import { getRandomFooter } from '../../utils/raphael.js';

// Worst of the two latencies decides the status; thresholds in milliseconds
const STATUS_LEVELS = [
    { above: 1000, label: '⚠ Critical Latency Detected', color: COLORS.RAPHAEL_ERROR },
    { above: 500, label: '◇ Suboptimal Performance', color: '#FF8C00' },
    { above: 200, label: '◈ Acceptable Parameters', color: COLORS.RAPHAEL_WARNING },
    { above: -Infinity, label: '◉ Optimal Performance', color: COLORS.RAPHAEL_SUCCESS }
];

export default {
    name: 'ping',
    description: 'Check bot latency and response time',
    usage: '',
    aliases: ['latency', 'pong', 'diagnostics'],
    category: 'info',
    cooldown: 5,

    async execute(message, args, client) {
        try {
            const sent = await message.reply('**Notice:** Initiating system diagnostics...');

            const roundtrip = sent.createdTimestamp - message.createdTimestamp;
            // The gateway reports -1 until its first heartbeat has been acknowledged
            const wsLatency = client.ws.ping >= 0 ? client.ws.ping : null;

            const worst = Math.max(roundtrip, wsLatency ?? 0);
            const status = STATUS_LEVELS.find(level => worst > level.above);

            const embed = await infoEmbed(message.guild.id, 'System Diagnostics',
                '**Analysis complete.** All systems operational, Master.');

            embed.addFields(
                { name: '▸ Response Latency', value: `\`${roundtrip}ms\``, inline: true },
                { name: '▸ Connection Latency', value: wsLatency === null ? '`measuring`' : `\`${wsLatency}ms\``, inline: true },
                { name: '▸ System Status', value: status.label, inline: true }
            );

            embed.setColor(status.color);
            embed.setFooter({ text: getRandomFooter() });

            await sent.edit({ content: null, embeds: [embed] });
        } catch (error) {
            console.error('[ping] Error:', error);
            return message.reply({
                embeds: [await errorEmbed(message.guild.id, 'Diagnostics Failed', 'I was unable to complete the diagnostics, Master.')]
            });
        }
    }
};
