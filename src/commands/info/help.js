import { EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder, ButtonBuilder, ButtonStyle, PermissionsBitField, MessageFlags } from 'discord.js';
import { readdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { GLYPHS, COLORS } from '../../utils/embeds.js';
import { getPrefix, truncate } from '../../utils/helpers.js';
import { getRandomFooter } from '../../utils/raphael.js';
import Guild from '../../models/Guild.js';

const COMMANDS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const MAIN_MENU_TIMEOUT_MS = 5 * 60 * 1000;
const DETAIL_TIMEOUT_MS = 60 * 1000;
const FIELD_VALUE_LIMIT = 1024;
// Discord rejects embeds over 6000 characters in total; leave room for the footer
const EMBED_TEXT_BUDGET = 5800;
const SHORT_DESCRIPTION_LENGTH = 50;
const FALLBACK_CATEGORY = 'misc';
const SLASH_MARKER = '`/`';

// Display names for known categories, in menu order. Any other category a command
// declares is still listed, under its capitalised key.
const CATEGORY_INFO = {
  admin: { name: 'Admin', description: 'Bot owner and administrator commands' },
  config: { name: 'Configuration', description: 'Server setup, automod, and configuration' },
  moderation: { name: 'Moderation', description: 'Keep your server safe and moderated' },
  economy: { name: 'Economy', description: 'Coins, levels, profiles, and games of chance' },
  music: { name: 'Music', description: 'Play and control music in voice channels' },
  community: { name: 'Community', description: 'Birthdays, events, giveaways, and more' },
  social: { name: 'Social', description: 'Marriage and social interaction features' },
  fun: { name: 'Fun & Games', description: 'Interactive games and entertainment' },
  info: { name: 'Information', description: 'Bot and server information commands' },
  utility: { name: 'Utility', description: 'Handy tools and utility commands' },
  misc: { name: 'Miscellaneous', description: 'Skills without a declared category' }
};

// Examples for commands that do not declare their own (written without the prefix)
const COMMAND_EXAMPLES = {
  // Moderation
  ban: ['ban @user', 'ban @user spamming', 'ban @user raiding --delete'],
  kick: ['kick @user', 'kick @user breaking rules'],
  warn: ['warn @user', 'warn @user inappropriate language'],
  timeout: ['timeout @user 10m', 'timeout @user 1h spamming', 'timeout @user 1d'],
  untimeout: ['untimeout @user'],
  purge: ['purge 50', 'purge 20 @user', 'purge 100'],
  lockdown: ['lockdown', 'lockdown #channel', 'lockdown unlock'],
  verify: ['verify setup', 'verify panel', 'verify manual @user', 'verify config type button', 'verify config role @Verified', 'verify config unverifiedrole @Unverified', 'verify config channel #verify', 'verify config enable', 'verify config disable', 'verify status'],
  userhistory: ['userhistory @user', 'userhistory 123456789'],

  // Music
  play: ['play never gonna give you up', 'play https://youtube.com/watch?v=...', 'play lofi hip hop'],
  skip: ['skip', 'skip 3'],
  volume: ['volume 50', 'volume 100'],
  seek: ['seek 1:30', 'seek 0:45'],
  loop: ['loop track', 'loop queue', 'loop off'],
  remove: ['remove 3'],
  skipto: ['skipto 5'],

  // Economy
  daily: ['daily'],
  balance: ['balance', 'balance @user'],
  level: ['level', 'level @user'],
  shop: ['shop'],
  inventory: ['inventory', 'inventory badges', 'setbg Sunset'],
  profile: ['profile', 'profile @user'],
  setprofile: ['setprofile bio Hello world!', 'setprofile title Warrior'],
  rep: ['rep @user'],
  claim: ['claim'],
  adventure: ['adventure'],
  coinflip: ['coinflip heads 100', 'coinflip tails 500'],
  blackjack: ['blackjack 100', 'blackjack 1000'],
  slots: ['slots 50', 'slots 200'],
  dice: ['dice 100', 'dice 500 high'],
  roulette: ['roulette 100 red', 'roulette 500 black', 'roulette 200 7'],

  // Config - AutoMod
  automod: ['automod enable', 'automod disable', 'automod status', 'automod badwords add word1,word2', 'automod antispam on', 'automod antiraid on'],
  automodignore: ['automodignore add channel #general', 'automodignore remove channel #general', 'automodignore add role @Moderator', 'automodignore list'],
  antinuke: ['antinuke enable', 'antinuke disable', 'antinuke whitelist @user', 'antinuke status'],

  // Config - Welcome/Goodbye
  welcome: ['welcome enable', 'welcome disable', 'welcome channel #welcome', 'welcome message Welcome {user} to {server}!', 'welcome title Welcome', 'welcome color #5432A6', 'welcome image <url>', 'welcome thumbnail avatar', 'welcome author username', 'welcome mention on', 'welcome greet Hey {user}!', 'welcome role @Member', 'welcome status', 'welcome test', 'welcome reset'],
  goodbye: ['goodbye enable', 'goodbye disable', 'goodbye channel #goodbye', 'goodbye message Goodbye {user}!', 'goodbye status', 'goodbye test', 'goodbye reset'],

  // Config - Boost
  boost: ['boost status', 'boost enable', 'boost channel #boosts', 'boost message Thanks {user} for boosting!', 'boost title New Booster', 'boost color #f47fff', 'boost embed on', 'boost mention on', 'boost image <url>', 'boost thumbnail avatar', 'boost author username', 'boost test', 'boost preview', 'boost reset', 'boost role @BoosterRole', 'boost give @user', 'boost take @user', 'boost duration 24', 'boost list', 'boost addtier 1 @Tier1Role', 'boost removetier 1', 'boost listtiers', 'boost cleartiers', 'boost tiermessage off', 'boost perks channel #perks', 'boost publish'],

  // Config - Auto Role
  autorole: ['autorole enable', 'autorole disable', 'autorole add @Member', 'autorole remove @Member', 'autorole delay 5', 'autorole bot add @BotRole', 'autorole bot remove @BotRole', 'autorole list'],

  // Config - Logs
  setlogs: ['setlogs', 'setlogs set mod #mod-logs', 'setlogs set message #message-logs', 'setlogs set voice #voice-logs', 'setlogs set member #member-logs', 'setlogs disable mod', 'setlogs all #all-logs', 'setlogs list'],

  // Config - Levels
  levelroles: ['levelroles add 5 @Level5', 'levelroles remove 5', 'levelroles list'],
  levelup: ['levelup channel #level-up', 'levelup message Congrats {user}! Level {level}!', 'levelup status'],
  noxp: ['noxp add #channel', 'noxp remove #channel', 'noxp list', 'noxp clear'],
  xpmultiplier: ['xpmultiplier set @Booster 1.5', 'xpmultiplier remove @Booster', 'xpmultiplier list'],

  // Config - Other
  setoverlay: ['setoverlay color #FF5733', 'setoverlay opacity 0.7', 'setoverlay color #000000 opacity 0.5', 'setoverlay reset'],
  feature: ['feature enable economy', 'feature disable gambling', 'feature status economy', 'feature list'],
  setup: ['setup'],
  config: ['config', 'config susthreshold 5', 'config embedcolor #00CED1'],
  setprefix: ['setprefix !', 'setprefix ?'],
  setchannel: ['setchannel modlog #mod-logs', 'setchannel welcome #welcome'],
  setrole: ['setrole admin @Admin', 'setrole mod @Moderator', 'setrole muted @Muted'],
  cmdchannels: ['cmdchannels add economy #bot-commands', 'cmdchannels remove economy #bot-commands', 'cmdchannels list'],
  colorroles: ['colorroles setup #color-roles', 'colorroles list'],
  reactionroles: ['reactionroles create', 'reactionroles add', 'reactionroles list'],
  starboard: ['starboard', 'starboard channel #starboard', 'starboard threshold 3', 'starboard enable', 'starboard stats'],
  rules: ['rules set 1 No spamming', 'rules remove 5', 'rules list', 'rules post #rules'],
  manageshop: ['manageshop add "Cool Badge" 1000 badge', 'manageshop remove 1', 'manageshop list'],

  // Community - Birthdays (dates are month then day)
  setbirthday: ['setbirthday @user 12 25', 'setbirthday @user 12 25 2000', 'setbirthday @user 12 25 2000 --showage', 'setbirthday @user 12 25 --fake'],
  mybirthday: ['mybirthday'],
  birthdays: ['birthdays', 'birthdays 7', 'birthdays 90'],
  removebirthday: ['removebirthday'],
  cancelbirthday: ['cancelbirthday'],
  birthdaypreference: ['birthdaypreference status', 'birthdaypreference channel #birthdays', 'birthdaypreference role @Birthday', 'birthdaypreference message Happy Birthday {user}!', 'birthdaypreference enable'],
  birthdayconfig: ['birthdayconfig status', 'birthdayconfig channel #birthdays', 'birthdayconfig role @Birthday', 'birthdayconfig message Happy Birthday {user}!', 'birthdayconfig preview'],
  requestbirthday: ['requestbirthday 12 25', 'requestbirthday 12 25 2000', 'requestbirthday 12 25 2000 My birthday was entered incorrectly'],
  approvebday: ['approvebday 1', 'approvebday #0001'],
  rejectbday: ['rejectbday 1 Invalid date', 'rejectbday #0001 Please provide proof'],
  birthdayrequests: ['birthdayrequests', 'birthdayrequests all', 'birthdayrequests approved'],

  // Community - Events & Giveaways
  giveaway: ['giveaway start 1h 1 Discord Nitro', 'giveaway start 1d 3 @Members Steam Gift Card', 'giveaway end <messageId>', 'giveaway reroll <messageId>', 'giveaway list'],
  createevent: ['createevent 2h | Movie Night | Join us in VC!', 'createevent 1d12h | Tournament | Registration required', 'createevent 30m | Quick Meeting'],
  events: ['events'],
  joinevent: ['joinevent <event_id>'],
  cancelevent: ['cancelevent <event_id>'],

  // Utility
  leaderboard: ['leaderboard coins', 'leaderboard level'],
  avatar: ['avatar', 'avatar @user'],
  banner: ['banner', 'banner @user'],
  poll: ['poll Should we have movie night? | Yes | No', 'poll Best color? | Red | Blue | Green'],
  afk: ['afk', 'afk brb dinner'],
  remind: ['remind 1h Check the oven', 'remind 30m Meeting'],
  tempvc: ['tempvc setup', 'tempvc limit 5', 'tempvc name Chill Zone'],
  ticket: ['ticket create', 'ticket close', 'ticket add @user'],
  embed: ['embed create', 'embed edit <messageId>'],
  steal: ['steal :emoji:'],

  // Info
  help: ['help', 'help ban', 'help economy', 'help config'],
  serverinfo: ['serverinfo'],
  userinfo: ['userinfo', 'userinfo @user'],
  roleinfo: ['roleinfo @Role', 'roleinfo Moderator'],
  channelinfo: ['channelinfo', 'channelinfo #channel'],
  checkuser: ['checkuser @user', 'checkuser 123456789'],
  ping: ['ping'],

  // Social
  marry: ['marry @user'],
  divorce: ['divorce'],
  badges: ['badges', 'badges @user'],

  // Fun
  tictactoe: ['tictactoe @user'],
  trivia: ['trivia', 'trivia science'],
  meme: ['meme'],
};

// ---------------------------------------------------------------------------
// Command metadata
// ---------------------------------------------------------------------------

// File name -> folder, for commands that do not declare a category (read once)
let folderCategories = null;
function getFolderCategories() {
  if (folderCategories) return folderCategories;
  folderCategories = new Map();
  try {
    for (const folder of readdirSync(COMMANDS_DIR, { withFileTypes: true })) {
      if (!folder.isDirectory()) continue;
      for (const file of readdirSync(path.join(COMMANDS_DIR, folder.name))) {
        if (file.endsWith('.js')) folderCategories.set(file.slice(0, -3).toLowerCase(), folder.name);
      }
    }
  } catch (error) {
    console.error('[help] Could not read the command folders:', error);
  }
  return folderCategories;
}

function categoryOf(cmd) {
  // The Command base class defaults to "general" when a class command declares nothing
  const declared = cmd.category && cmd.category !== 'general' ? cmd.category : null;
  return (declared || getFolderCategories().get(cmd.name) || FALLBACK_CATEGORY).toLowerCase();
}

function categoryInfo(key) {
  return CATEGORY_INFO[key] || { name: key.charAt(0).toUpperCase() + key.slice(1), description: 'Additional skills' };
}

// Class-based commands keep their text under description.content/usage/examples
function descriptionOf(cmd) {
  const text = typeof cmd.description === 'string' ? cmd.description : cmd.description?.content;
  return text && text !== 'No description provided' ? text : 'No description available';
}

function usageOf(cmd) {
  const raw = typeof cmd.usage === 'string' ? cmd.usage : cmd.description?.usage;
  if (!raw || raw === 'No usage provided') return '';
  // Some usage strings repeat the command name ("setbirthday <@user> ..."); drop it
  return raw.replace(new RegExp(`^${cmd.name}\\b\\s*`, 'i'), '').trim();
}

function examplesOf(cmd) {
  const declared = (cmd.examples || cmd.description?.examples || []).filter(Boolean);
  return declared.length > 0 ? declared : (COMMAND_EXAMPLES[cmd.name] || []);
}

function permissionNames(value) {
  if (value === undefined || value === null) return [];
  try {
    return new PermissionsBitField(value).toArray();
  } catch {
    return [].concat(value).map(String);
  }
}

// Array form: Discord permissions, or a configured staff role (as the dispatcher checks).
// Object form: { user } permissions the member must hold.
function requiredPermissions(cmd) {
  const perms = cmd.permissions;
  if (!perms) return { names: [], staffRoleAccepted: false };
  if (Array.isArray(perms) || typeof perms !== 'object') {
    return { names: permissionNames(perms), staffRoleAccepted: Array.isArray(perms) };
  }
  return { names: permissionNames(perms.user), staffRoleAccepted: false };
}

function isOwner(userId) {
  return Boolean(process.env.BOT_OWNER_ID) && userId === process.env.BOT_OWNER_ID;
}

// Unique commands the viewer may use (owner-only tools are hidden from everyone else)
function visibleCommands(client, userId) {
  const seen = new Set();
  const result = [];
  for (const cmd of client.commands.values()) {
    if (!cmd?.name || seen.has(cmd.name)) continue;
    if (cmd.ownerOnly && !isOwner(userId)) continue;
    seen.add(cmd.name);
    result.push(cmd);
  }
  return result;
}

function groupByCategory(commands) {
  const groups = new Map();
  for (const cmd of commands) {
    const key = categoryOf(cmd);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(cmd);
  }
  for (const list of groups.values()) list.sort((a, b) => a.name.localeCompare(b.name));

  const order = Object.keys(CATEGORY_INFO);
  const rank = (key) => (order.includes(key) ? order.indexOf(key) : order.length);
  return new Map([...groups.entries()].sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b)));
}

function findCommand(client, name) {
  const key = name.toLowerCase();
  return client.commands.get(key) ||
    client.commands.get(client.aliases?.get(key)) ||
    client.commands.find(cmd => cmd.aliases?.includes(key));
}

function resolveCategoryKey(groups, input) {
  const key = input.toLowerCase();
  if (groups.has(key)) return key;
  for (const candidate of groups.keys()) {
    if (categoryInfo(candidate).name.toLowerCase() === key) return candidate;
  }
  return null;
}

// Names of the slash commands actually registered (src/utils/slashCommands.js); loaded once
let slashNamesPromise = null;
function getSlashNames() {
  slashNamesPromise ??= import('../../utils/slashCommands.js')
    .then(mod => new Set(mod.getSlashCommands().map(cmd => cmd.name)))
    .catch((error) => {
      console.error('[help] Could not read the registered slash commands:', error);
      return new Set();
    });
  return slashNamesPromise;
}

// Pack items into field values of at most 1024 characters, remembering how many items each holds
function packItems(items, separator = '\n', limit = FIELD_VALUE_LIMIT) {
  const chunks = [];
  let current = null;
  for (const item of items) {
    const safe = truncate(item, limit);
    if (current && current.text.length + separator.length + safe.length <= limit) {
      current.text += separator + safe;
      current.count++;
    } else {
      current = { text: safe, count: 1 };
      chunks.push(current);
    }
  }
  return chunks;
}

function embedTextLength(embed) {
  const data = embed.data;
  return (data.title?.length || 0) + (data.description?.length || 0) +
    (data.author?.name?.length || 0) + (data.footer?.text?.length || 0) +
    (data.fields || []).reduce((sum, f) => sum + f.name.length + f.value.length, 0);
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export default {
  name: 'help',
  description: 'Display all commands and information about the bot',
  usage: '[command | category]',
  category: 'info',
  aliases: ['h', 'commands', 'cmds', '?'],
  cooldown: 3,
  examples: ['help', 'help ban', 'help economy'],

  async execute(message, args, client) {
    try {
      const prefix = await getPrefix(message.guild.id);
      const guildData = await Guild.getGuild(message.guild.id);
      const ctx = {
        message,
        prefix,
        client,
        disabledCommands: guildData?.textCommands?.disabledCommands || [],
        commands: visibleCommands(client, message.author.id),
        slashNames: await getSlashNames()
      };
      ctx.groups = groupByCategory(ctx.commands);

      if (args[0]) {
        const categoryKey = resolveCategoryKey(ctx.groups, args[0]);
        if (categoryKey) {
          return message.reply({ embeds: [createCategoryEmbed(ctx, categoryKey)] });
        }
        return showCommandDetail(ctx, args[0]);
      }

      return showMainHelp(ctx);
    } catch (error) {
      console.error('[help] Error:', error);
      return message.reply({
        embeds: [new EmbedBuilder()
          .setColor(COLORS.RAPHAEL_ERROR)
          .setTitle('『 Alert 』')
          .setDescription('**Warning:** The skill archive could not be displayed, Master.')
          .setFooter({ text: getRandomFooter() })]
      });
    }
  }
};

function notYourMenu(interaction) {
  return interaction.reply({
    content: '**Notice:** Only the member who opened this menu can use it, Master.',
    flags: MessageFlags.Ephemeral
  });
}

async function showMainHelp(ctx) {
  const { message } = ctx;

  const selectMenu = new StringSelectMenuBuilder()
    .setCustomId('help_category')
    .setPlaceholder('◈ Select a skill category, Master...')
    .addOptions(
      [...ctx.groups.entries()].slice(0, 25).map(([key, commands]) => {
        const info = categoryInfo(key);
        return {
          label: info.name,
          description: truncate(`${commands.length} skills • ${info.description}`, 100),
          value: key
        };
      })
    );

  const row1 = new ActionRowBuilder().addComponents(selectMenu);
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('help_home').setLabel('Home').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('help_slash').setLabel('Slash Commands').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('help_features').setLabel('Features').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setLabel('Support').setStyle(ButtonStyle.Link).setURL('https://github.com/GhazanfarAteeb/jura-bot')
  );

  const reply = await message.reply({
    embeds: [createMainHelpEmbed(ctx)],
    components: [row1, row2]
  });

  const collector = reply.createMessageComponentCollector({ time: MAIN_MENU_TIMEOUT_MS });

  collector.on('collect', async (interaction) => {
    try {
      if (interaction.user.id !== message.author.id) return notYourMenu(interaction);

      await interaction.deferUpdate();

      let embed = null;
      if (interaction.isStringSelectMenu()) {
        embed = createCategoryEmbed(ctx, interaction.values[0]);
      } else if (interaction.customId === 'help_home') {
        embed = createMainHelpEmbed(ctx);
      } else if (interaction.customId === 'help_slash') {
        embed = createSlashCommandsEmbed(ctx);
      } else if (interaction.customId === 'help_features') {
        embed = createFeaturesEmbed(ctx);
      }

      if (embed) await interaction.editReply({ embeds: [embed] });
    } catch (error) {
      console.error('[help] Menu error:', error);
    }
  });

  collector.on('end', () => {
    const disabledRow1 = ActionRowBuilder.from(row1);
    const disabledRow2 = ActionRowBuilder.from(row2);
    disabledRow1.components[0].setDisabled(true);
    disabledRow2.components.forEach((btn) => {
      if (btn.data.style !== ButtonStyle.Link) btn.setDisabled(true);
    });
    reply.edit({ components: [disabledRow1, disabledRow2] }).catch(() => { });
  });
}

function createMainHelpEmbed(ctx) {
  const { message, prefix, client } = ctx;
  const totalCommands = ctx.commands.length;
  const disabledCount = ctx.commands.filter(cmd => ctx.disabledCommands.includes(cmd.name)).length;

  const embed = new EmbedBuilder()
    .setColor(COLORS.RAPHAEL)
    .setAuthor({
      name: '『 Raphael • Skill Archive 』',
      iconURL: client.user.displayAvatarURL({ dynamic: true })
    })
    .setDescription(
      '**Answer:** I am Raphael, the Ultimate Skill serving as your assistant, Master.\n\n' +
      'I possess numerous capabilities to aid you. Below is a summary of my available functions.\n\n' +
      `▸ **Activation Prefix:** \`${prefix}\`\n` +
      `▸ **Available Skills:** \`${totalCommands - disabledCount}\` active / \`${totalCommands}\` total\n` +
      `▸ **Skill Categories:** \`${ctx.groups.size}\`\n\n` +
      '**Quick Reference:**\n' +
      '◈ Use the selection menu below to browse categories\n' +
      `◈ Command \`${prefix}help <skill>\` for detailed analysis\n` +
      `◈ Command \`${prefix}help <category>\` for category overview`
    )
    .setThumbnail(client.user.displayAvatarURL({ dynamic: true, size: 256 }));

  const categories = [...ctx.groups.entries()].map(([key, commands]) => `${GLYPHS.ARROW_RIGHT} **${categoryInfo(key).name}** (${commands.length})`);
  const half = Math.ceil(categories.length / 2);

  embed.addFields(
    { name: '◈ Skill Categories', value: categories.slice(0, half).join('\n') || 'None', inline: true },
    { name: '\u200b', value: categories.slice(half).join('\n') || '\u200b', inline: true },
    {
      name: '◈ Advisory',
      value:
        `◇ Skills marked ${SLASH_MARKER} can also be activated as slash commands\n` +
        `◇ Use \`${prefix}feature\` to toggle system modules\n` +
        `◇ Use \`${prefix}setup\` for initial configuration protocol`,
      inline: false
    }
  );

  embed.setFooter({
    text: `${getRandomFooter()} • Requested by ${message.author.displayName}`,
    iconURL: message.author.displayAvatarURL({ dynamic: true })
  });
  embed.setTimestamp();

  return embed;
}

function createCategoryEmbed(ctx, categoryKey) {
  const { prefix, client } = ctx;
  const info = categoryInfo(categoryKey);
  const commands = ctx.groups.get(categoryKey) || [];

  const embed = new EmbedBuilder()
    .setColor(COLORS.RAPHAEL)
    .setAuthor({
      name: `『 ${info.name} Skills 』`,
      iconURL: client.user.displayAvatarURL({ dynamic: true })
    })
    .setDescription(
      `**Analysis:** ${info.description}.\n\n` +
      `**Total Skills:** ${commands.length} • Use \`${prefix}help <skill>\` for detailed analysis`
    )
    .setFooter({ text: `${getRandomFooter()} • ${info.name} • ${commands.length} skills` })
    .setTimestamp();

  const lines = commands.map(cmd => {
    const isDisabled = ctx.disabledCommands.includes(cmd.name);
    const name = isDisabled ? `~~${cmd.name}~~` : `**${cmd.name}**`;
    const slash = ctx.slashNames.has(cmd.name) ? ` ${SLASH_MARKER}` : '';
    return `▸ ${name}${slash}\n◇ ${truncate(descriptionOf(cmd), SHORT_DESCRIPTION_LENGTH)}`;
  });

  const legend = { name: '◈ Status Indicators', value: `${SLASH_MARKER} Slash command available • ~~struck~~ Currently deactivated` };
  const moreNoteReserve = 40;
  let shown = 0;

  for (const [i, chunk] of packItems(lines).entries()) {
    const field = { name: i === 0 ? '◈ Available Skills' : '\u200b', value: chunk.text };
    const projected = embedTextLength(embed) + field.name.length + field.value.length +
      legend.name.length + legend.value.length + moreNoteReserve;
    if (projected > EMBED_TEXT_BUDGET) break;
    embed.addFields(field);
    shown += chunk.count;
  }

  if (shown < lines.length) {
    embed.addFields({ name: '\u200b', value: `+${lines.length - shown} more skills` });
  }

  embed.addFields(legend);
  return embed;
}

function createSlashCommandsEmbed(ctx) {
  const { prefix, client } = ctx;

  const embed = new EmbedBuilder()
    .setColor(COLORS.RAPHAEL)
    .setAuthor({
      name: '『 Slash Command Registry 』',
      iconURL: client.user.displayAvatarURL({ dynamic: true })
    })
    .setDescription(
      '**Analysis:** These skills are registered as slash commands.\n\n' +
      'Slash commands provide enhanced input validation and autocomplete functionality.\n\n' +
      '*Tip: Input `/` in the chat interface to view all available slash commands, Master.*'
    );

  // Group registered slash commands by the category of the matching prefix command
  const byCategory = new Map();
  for (const name of [...ctx.slashNames].sort()) {
    const cmd = ctx.client.commands.get(name);
    const key = cmd ? categoryOf(cmd) : 'slash-only';
    if (!byCategory.has(key)) byCategory.set(key, []);
    byCategory.get(key).push(`\`/${name}\``);
  }

  for (const [key, names] of groupByCategoryOrder(byCategory)) {
    const label = key === 'slash-only' ? 'Slash Only' : categoryInfo(key).name;
    packItems(names, ' ').forEach((chunk, i) => {
      embed.addFields({ name: i === 0 ? `▸ ${label}` : '\u200b', value: chunk.text, inline: true });
    });
  }

  if (ctx.slashNames.size === 0) {
    embed.addFields({ name: '▸ Registry', value: 'No slash commands could be read at this time.' });
  }

  embed.addFields({
    name: '◈ Notice',
    value: `Most skills remain accessible via the \`${prefix}\` prefix.`,
    inline: false
  });

  embed.setFooter({ text: `${getRandomFooter()} • ${ctx.slashNames.size} slash commands registered` });
  embed.setTimestamp();

  return embed;
}

// Same ordering as the category menu for any map keyed by category
function groupByCategoryOrder(map) {
  const order = Object.keys(CATEGORY_INFO);
  const rank = (key) => (order.includes(key) ? order.indexOf(key) : order.length);
  return [...map.entries()].sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b));
}

function createFeaturesEmbed(ctx) {
  const { prefix, client } = ctx;

  const embed = new EmbedBuilder()
    .setColor(COLORS.RAPHAEL)
    .setAuthor({
      name: '『 System Capabilities 』',
      iconURL: client.user.displayAvatarURL({ dynamic: true })
    })
    .setDescription(
      '**Report:** The following modules are available for this server.\n\n' +
      `Use \`${prefix}setup\` to initiate configuration protocol.`
    );

  const features = [
    { name: '▸ Moderation & AutoMod', value: 'Bans, kicks, warnings, timeouts, anti-spam, anti-raid, anti-nuke, bad word filter, and more.' },
    { name: '▸ Economy System', value: 'Daily rewards, coins, leveling, XP multipliers, profiles, backgrounds, and shop system.' },
    { name: '▸ Games of Chance', value: 'Coinflip, slots, dice, roulette, and blackjack with customizable betting.' },
    { name: '▸ Music Player', value: 'High-quality music from YouTube, Spotify, and more with queue management.' },
    { name: '▸ Community Features', value: 'Birthdays, events, giveaways, starboard, confessions, tickets, and welcome messages.' },
    { name: '▸ Customization', value: 'Custom prefix, autoroles, reaction roles, color roles, and embed styling.' },
    { name: '▸ Logging', value: 'Message logs, member logs, moderation logs, and voice channel logs.' },
    { name: '▸ Security', value: 'Verification system, anti-nuke protection, and permission management.' }
  ];

  embed.addFields(features.map(feature => ({ ...feature, inline: true })));
  embed.setFooter({ text: `${getRandomFooter()} • ${prefix}help <category> to explore skills` });
  embed.setTimestamp();

  return embed;
}

async function showCommandDetail(ctx, commandName) {
  const { message, prefix, client } = ctx;
  const command = findCommand(client, commandName);

  if (!command || (command.ownerOnly && !isOwner(message.author.id))) {
    const embed = new EmbedBuilder()
      .setColor(COLORS.RAPHAEL_ERROR)
      .setTitle('『 Skill Not Found 』')
      .setDescription(
        `${GLYPHS.ERROR} **No skill matches** \`${truncate(commandName, 50)}\`, Master.\n\n` +
        `${GLYPHS.ARROW_RIGHT} Use \`${prefix}help\` to see all available skills.\n` +
        `${GLYPHS.ARROW_RIGHT} Try \`${prefix}help <category>\` to browse by category.`
      )
      .setFooter({ text: getRandomFooter() });
    return message.reply({ embeds: [embed] });
  }

  const isDisabled = ctx.disabledCommands.includes(command.name);
  const hasSlash = ctx.slashNames.has(command.name);
  const categoryKey = categoryOf(command);
  const info = categoryInfo(categoryKey);

  const embed = new EmbedBuilder()
    .setColor(isDisabled ? COLORS.MUTED : COLORS.RAPHAEL)
    .setAuthor({
      name: `『 Skill Analysis: ${command.name} 』`,
      iconURL: client.user.displayAvatarURL({ dynamic: true })
    })
    .setDescription(
      (isDisabled ? '**Warning:** This skill is currently deactivated.\n\n' : '') +
      `**Analysis:** ${descriptionOf(command)}`
    );

  const badges = [];
  if (hasSlash) badges.push(`${SLASH_MARKER} Slash`);
  if (isDisabled) badges.push('◇ Deactivated');
  if (command.cooldown) badges.push(`◈ ${command.cooldown}s cooldown`);

  if (badges.length > 0) {
    embed.addFields({ name: '▸ Status Indicators', value: badges.join(' • '), inline: false });
  }

  const usage = usageOf(command);
  embed.addFields({
    name: '▸ Activation Syntax',
    value: `\`\`\`${truncate(`${prefix}${command.name}${usage ? ` ${usage}` : ''}`, 1000)}\`\`\``,
    inline: false
  });

  if (command.aliases?.length > 0) {
    embed.addFields({
      name: '▸ Alternative Triggers',
      value: truncate(command.aliases.map(a => `\`${prefix}${a}\``).join(', '), 1024),
      inline: true
    });
  }

  embed.addFields({ name: '▸ Classification', value: info.name, inline: true });

  const { names: permissions, staffRoleAccepted } = requiredPermissions(command);
  if (permissions.length > 0) {
    embed.addFields({
      name: '▸ Required Authorization',
      value: truncate(
        permissions.map(p => `\`${p}\``).join(', ') + (staffRoleAccepted ? '\n◇ or a configured staff or moderator role' : ''),
        1024
      ),
      inline: false
    });
  }

  const examples = examplesOf(command);
  if (examples.length > 0) {
    const formatted = examples.map(ex => (ex.startsWith('@') ? `\`${ex}\`` : `\`${prefix}${ex}\``));
    embed.addFields({ name: '▸ Usage Examples', value: packItems(formatted)[0].text, inline: false });
  }

  if (hasSlash) {
    embed.addFields({ name: '▸ Slash Command', value: `This skill also responds to \`/${command.name}\`, Master.`, inline: false });
  }

  embed.setFooter({ text: `${getRandomFooter()} • Use ${prefix}help for skill archive` });
  embed.setTimestamp();

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`help_category_${categoryKey}`)
      .setLabel(truncate(`View ${info.name}`, 80))
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('help_home_detail')
      .setLabel('All Categories')
      .setStyle(ButtonStyle.Primary)
  );

  const reply = await message.reply({ embeds: [embed], components: [row] });

  const collector = reply.createMessageComponentCollector({ time: DETAIL_TIMEOUT_MS });

  collector.on('collect', async (interaction) => {
    try {
      if (interaction.user.id !== message.author.id) return notYourMenu(interaction);

      await interaction.deferUpdate();

      const next = interaction.customId === 'help_home_detail'
        ? createMainHelpEmbed(ctx)
        : createCategoryEmbed(ctx, interaction.customId.replace('help_category_', ''));

      // The buttons are removed here, so the end handler must not put them back
      await interaction.editReply({ embeds: [next], components: [] });
      collector.stop('navigated');
    } catch (error) {
      console.error('[help] Detail button error:', error);
    }
  });

  collector.on('end', (_collected, reason) => {
    if (reason === 'navigated') return;
    row.components.forEach(btn => btn.setDisabled(true));
    reply.edit({ components: [row] }).catch(() => { });
  });
}
