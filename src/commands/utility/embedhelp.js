import { EmbedBuilder, embedLength } from 'discord.js';
import { COLORS, GLYPHS, errorEmbed } from '../../utils/embeds.js';
import { getRandomFooter } from '../../utils/raphael.js';
import { getPrefix } from '../../utils/helpers.js';

// Discord accepts at most 10 embeds and 6000 embed characters in one message
const MAX_EMBEDS_PER_MESSAGE = 10;
const MAX_EMBED_CHARS_PER_MESSAGE = 6000;

function guideSection(title) {
    return new EmbedBuilder()
        .setColor(COLORS.RAPHAEL)
        .setTitle(`『 ${title} 』`)
        .setFooter({ text: getRandomFooter() })
        .setTimestamp();
}

function buildGuide(prefix) {
    const set = `${prefix}embedset`;
    const head = (name) => `${GLYPHS.ARROW_RIGHT} ${name}`;

    const overview = guideSection('Custom Embed System Guide')
        .setDescription('Master, custom embeds may carry images, GIFs and member avatars. The reference below covers every option.')
        .addFields(
            {
                name: head('Quick Start'),
                value: `\`\`\`\n${prefix}embed create welcome\n${set} welcome title Welcome to {server}!\n${set} welcome description Hello {user}!\n${set} welcome thumbnail userAvatar\n${prefix}embed send welcome\n\`\`\``,
                inline: false
            },
            {
                name: head('Basic Commands'),
                value: `\`${prefix}embed create <name>\` — Create new embed\n` +
                       `\`${prefix}embed list\` — List all embeds\n` +
                       `\`${prefix}embed preview <name>\` — Preview embed\n` +
                       `\`${prefix}embed send <name> [#channel]\` — Send embed\n` +
                       `\`${prefix}embed delete <name>\` — Delete embed`,
                inline: false
            },
            {
                name: head('Configuration'),
                value: `\`${set} <name> title <text>\` — Set title\n` +
                       `\`${set} <name> description <text>\` — Set description\n` +
                       `\`${set} <name> color <hex>\` — Set color (#FF0000)\n` +
                       `\`${set} <name> content <text>\` — Set message text`,
                inline: false
            }
        );

    const images = guideSection('Images and Avatars')
        .addFields(
            {
                name: head('Images'),
                value: `\`${set} <name> image <url>\` — Large image\n` +
                       `\`${set} <name> thumbnail <url>\` — Small thumbnail\n` +
                       '• Attach an image instead of a URL\n' +
                       '• Use GIF URLs for animated images',
                inline: false
            },
            {
                name: head('Member Avatars'),
                value: `\`${set} <name> thumbnail userAvatar\` — Member's avatar as thumbnail\n` +
                       `\`${set} <name> authorIcon userAvatar\` — Member's avatar in author\n` +
                       `\`${set} <name> footerIcon userAvatar\` — Member's avatar in footer\n` +
                       `\`${set} <name> footerIcon botAvatar\` — My avatar in footer`,
                inline: false
            },
            {
                name: head('Example: Welcome Embed with Avatar'),
                value: `\`\`\`\n${prefix}embed create welcome\n${set} welcome title Welcome {user.name}!\n${set} welcome thumbnail userAvatar\n${set} welcome color #00FF00\n${prefix}embed send welcome\n\`\`\``,
                inline: false
            }
        );

    const advanced = guideSection('Advanced Features')
        .addFields(
            {
                name: head('Author Section'),
                value: `\`${set} <name> author <text>\` — Set author name\n` +
                       `\`${set} <name> author username\` — Use the member's name\n` +
                       `\`${set} <name> authorIcon <url>\` — Set author icon\n` +
                       `\`${set} <name> authorIcon userAvatar\` — Use the member's avatar\n` +
                       '• The icon is shown only alongside an author name',
                inline: false
            },
            {
                name: head('Footer'),
                value: `\`${set} <name> footer <text>\` — Set footer text\n` +
                       `\`${set} <name> footerIcon <url>\` — Set footer icon\n` +
                       `\`${set} <name> footerIcon userAvatar\` — Member's avatar\n` +
                       `\`${set} <name> footerIcon botAvatar\` — My avatar\n` +
                       '• The icon is shown only alongside footer text',
                inline: false
            },
            {
                name: head('Fields'),
                value: `\`${set} <name> addfield <name> | <value>\` — Add field\n` +
                       `\`${set} <name> addfield <name> | <value> | inline\` — Inline field\n` +
                       `\`${set} <name> removefield <number>\` — Remove field\n` +
                       '• Every field needs a name and a value\n' +
                       '• Maximum 25 fields per embed',
                inline: false
            },
            {
                name: head('Other Options'),
                value: `\`${set} <name> url <link>\` — Make title clickable\n` +
                       `\`${set} <name> timestamp on/off\` — Toggle timestamp\n` +
                       `\`${set} <name> category <type>\` — Set category\n` +
                       `\`${set} <name> setdesc <text>\` — Describe the template in the list`,
                inline: false
            },
            {
                name: head('Limits'),
                value: 'Title 256 • Description 4096 • Field name 256 • Field value 1024\n' +
                       'Author 256 • Footer 2048 • Message content 2000 • Whole embed 6000',
                inline: false
            }
        );

    const variables = guideSection('Variables and Placeholders')
        .setDescription('Use these in any text field to insert information dynamically, Master:')
        .addFields(
            {
                name: head('User Variables'),
                value: '`{user}` — Mention user (@User)\n' +
                       '`{user.name}` — Username only\n' +
                       '`{user.displayName}` — Display name\n' +
                       '`{user.tag}` — User#1234 or @username\n' +
                       '`{user.id}` — User ID',
                inline: true
            },
            {
                name: head('Server Variables'),
                value: '`{server}` — Server name\n' +
                       '`{server.name}` — Server name\n' +
                       '`{server.members}` — Member count\n' +
                       '`{server.id}` — Server ID',
                inline: true
            },
            {
                name: head('Channel Variables'),
                value: '`{channel}` — Mention channel\n' +
                       '`{channel.name}` — Channel name\n' +
                       '`{channel.id}` — Channel ID',
                inline: true
            },
            {
                name: head('Date/Time Variables'),
                value: '`{date}` — Current date\n' +
                       '`{time}` — Current time\n' +
                       '`{datetime}` — Date and time',
                inline: true
            },
            {
                name: head('Example Usage'),
                value: '```\nWelcome {user} to {server}!\nWe now have {server.members} members!\nYou joined on {date}\n```',
                inline: false
            }
        );

    const examples = guideSection('Example Templates')
        .setDescription('Templates are saved and may be reused at any time, Master.')
        .addFields(
            {
                name: '#1 — Welcome Message with Avatar',
                value: `\`\`\`\n${prefix}embed create welcome\n${set} welcome title Welcome to {server}!\n${set} welcome description Hey {user}, welcome to our community!\n${set} welcome thumbnail userAvatar\n${set} welcome color #00FF00\n${set} welcome footer Enjoy your stay!\n${set} welcome footerIcon botAvatar\n\`\`\``,
                inline: false
            },
            {
                name: '#2 — Announcement with Image',
                value: `\`\`\`\n${prefix}embed create announcement\n${set} announcement title Important Announcement\n${set} announcement description Check out this update!\n${set} announcement image https://i.imgur.com/example.gif\n${set} announcement color #FF0000\n\`\`\``,
                inline: false
            },
            {
                name: '#3 — Rules Embed with Fields',
                value: `\`\`\`\n${prefix}embed create rules\n${set} rules title Server Rules\n${set} rules color #5865F2\n${set} rules addfield Rule 1 | Be respectful | inline\n${set} rules addfield Rule 2 | No spam | inline\n${set} rules addfield Rule 3 | Have fun! | inline\n\`\`\``,
                inline: false
            },
            {
                name: '#4 — User Info Card',
                value: `\`\`\`\n${prefix}embed create usercard\n${set} usercard author username\n${set} usercard authorIcon userAvatar\n${set} usercard thumbnail userAvatar\n${set} usercard description Member since {date}\n${set} usercard color #9B59B6\n\`\`\``,
                inline: false
            }
        );

    return [overview, images, advanced, variables, examples];
}

// Groups embeds into as few messages as Discord allows
function packEmbeds(embeds) {
    const batches = [];
    let current = [];
    let chars = 0;

    for (const embed of embeds) {
        const size = embedLength(embed.data);
        const full = current.length >= MAX_EMBEDS_PER_MESSAGE || chars + size > MAX_EMBED_CHARS_PER_MESSAGE;
        if (current.length > 0 && full) {
            batches.push(current);
            current = [];
            chars = 0;
        }
        current.push(embed);
        chars += size;
    }
    if (current.length > 0) batches.push(current);

    return batches;
}

export default {
    name: 'embedhelp',
    description: 'Guide for creating custom embeds',
    usage: 'embedhelp',
    category: 'utility',
    aliases: ['embedguide', 'embedinfo'],

    execute: async (message) => {
        const guildId = message.guild.id;

        try {
            const prefix = await getPrefix(guildId);
            const [first, ...rest] = packEmbeds(buildGuide(prefix));

            await message.reply({ embeds: first });
            for (const batch of rest) {
                await message.channel.send({ embeds: batch });
            }
        } catch (error) {
            console.error('[EmbedHelp] Error:', error);
            try {
                await message.reply({
                    embeds: [await errorEmbed(guildId, 'The embed guide could not be displayed, Master. Please try again.')]
                });
            } catch {
                // Nothing more can be reported
            }
        }
    }
};
