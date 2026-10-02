import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType, MessageFlags } from 'discord.js';
import { errorEmbed, COLORS } from '../../utils/embeds.js';
import Guild from '../../models/Guild.js';
import Economy from '../../models/Economy.js';
import { getRandomFooter } from '../../utils/raphael.js';
import { getPrefix, formatNumber } from '../../utils/helpers.js';
import { TRIVIA_REWARD, TRIVIA_REWARD_COOLDOWN, DEFAULT_COIN_NAME } from '../../utils/gameConfig.js';

// Trivia questions by category
const TRIVIA_QUESTIONS = {
  general: [
    { question: 'What is the capital of France?', answers: ['Paris', 'London', 'Berlin', 'Madrid'], correct: 0 },
    { question: 'How many continents are there?', answers: ['5', '6', '7', '8'], correct: 2 },
    { question: 'What is the largest planet in our solar system?', answers: ['Earth', 'Mars', 'Jupiter', 'Saturn'], correct: 2 },
    { question: 'What year did World War II end?', answers: ['1943', '1944', '1945', '1946'], correct: 2 },
    { question: 'What is the chemical symbol for gold?', answers: ['Go', 'Gd', 'Au', 'Ag'], correct: 2 },
    { question: 'Which country is known as the Land of the Rising Sun?', answers: ['China', 'Japan', 'Korea', 'Thailand'], correct: 1 },
    { question: 'How many colors are in a rainbow?', answers: ['5', '6', '7', '8'], correct: 2 },
    { question: 'What is the largest ocean on Earth?', answers: ['Atlantic', 'Indian', 'Arctic', 'Pacific'], correct: 3 },
    { question: 'Who painted the Mona Lisa?', answers: ['Michelangelo', 'Leonardo da Vinci', 'Raphael', 'Picasso'], correct: 1 },
    { question: 'What is the hardest natural substance?', answers: ['Gold', 'Iron', 'Diamond', 'Platinum'], correct: 2 }
  ],
  science: [
    { question: 'What is H2O commonly known as?', answers: ['Salt', 'Sugar', 'Water', 'Oxygen'], correct: 2 },
    { question: 'What planet is known as the Red Planet?', answers: ['Venus', 'Mars', 'Jupiter', 'Mercury'], correct: 1 },
    { question: 'What is the speed of light?', answers: ['299,792 km/s', '199,792 km/s', '399,792 km/s', '500,000 km/s'], correct: 0 },
    { question: 'How many bones are in the adult human body?', answers: ['186', '206', '226', '246'], correct: 1 },
    { question: 'What gas do plants absorb from the atmosphere?', answers: ['Oxygen', 'Nitrogen', 'Carbon Dioxide', 'Helium'], correct: 2 },
    { question: 'What is the smallest unit of matter?', answers: ['Molecule', 'Cell', 'Atom', 'Electron'], correct: 2 },
    { question: 'What force keeps us on the ground?', answers: ['Magnetism', 'Friction', 'Gravity', 'Inertia'], correct: 2 },
    { question: 'What is the study of living organisms called?', answers: ['Chemistry', 'Physics', 'Biology', 'Geology'], correct: 2 }
  ],
  gaming: [
    { question: 'What year was Minecraft released?', answers: ['2009', '2010', '2011', '2012'], correct: 2 },
    { question: 'What company created the PlayStation?', answers: ['Microsoft', 'Nintendo', 'Sony', 'Sega'], correct: 2 },
    { question: 'In which game would you find the character Master Chief?', answers: ['Call of Duty', 'Halo', 'Gears of War', 'Destiny'], correct: 1 },
    { question: 'What is the best-selling video game of all time?', answers: ['GTA V', 'Minecraft', 'Tetris', 'Wii Sports'], correct: 1 },
    { question: 'What color is Sonic the Hedgehog?', answers: ['Red', 'Green', 'Blue', 'Yellow'], correct: 2 },
    { question: 'In which game do you catch Pokemon?', answers: ['Digimon', 'Yu-Gi-Oh', 'Pokemon', 'Monster Hunter'], correct: 2 },
    { question: 'What is the name of Mario\'s brother?', answers: ['Wario', 'Luigi', 'Toad', 'Yoshi'], correct: 1 },
    { question: 'Which game features a battle royale on an island?', answers: ['Minecraft', 'Fortnite', 'Roblox', 'GTA V'], correct: 1 }
  ],
  movies: [
    { question: 'Who directed the movie "Titanic"?', answers: ['Steven Spielberg', 'James Cameron', 'Christopher Nolan', 'Martin Scorsese'], correct: 1 },
    { question: 'What year was the first Harry Potter movie released?', answers: ['1999', '2000', '2001', '2002'], correct: 2 },
    { question: 'Who plays Iron Man in the MCU?', answers: ['Chris Evans', 'Chris Hemsworth', 'Robert Downey Jr.', 'Mark Ruffalo'], correct: 2 },
    { question: 'Which movie features the quote "I\'ll be back"?', answers: ['Robocop', 'Terminator', 'Die Hard', 'Rambo'], correct: 1 },
    { question: 'What is the highest-grossing film of all time?', answers: ['Avengers: Endgame', 'Avatar', 'Titanic', 'Star Wars'], correct: 1 },
    { question: 'In which movie does a shark attack a beach resort?', answers: ['Deep Blue Sea', 'Jaws', 'The Meg', 'Sharknado'], correct: 1 },
    { question: 'Who voiced Woody in Toy Story?', answers: ['Tom Cruise', 'Tom Hardy', 'Tom Hanks', 'Tom Holland'], correct: 2 },
    { question: 'What is the name of Batman\'s butler?', answers: ['Alfred', 'Jarvis', 'Watson', 'Jeeves'], correct: 0 }
  ],
  discord: [
    { question: 'What year was Discord founded?', answers: ['2013', '2014', '2015', '2016'], correct: 2 },
    { question: 'What is the Discord mascot\'s name?', answers: ['Clyde', 'Wumpus', 'Nelly', 'Blob'], correct: 1 },
    { question: 'What is the maximum file size for free users?', answers: ['8 MB', '25 MB', '50 MB', '100 MB'], correct: 1 },
    { question: 'What is Discord Nitro\'s streaming quality limit?', answers: ['720p', '1080p', '4K', '8K'], correct: 2 },
    { question: 'What was Discord originally created for?', answers: ['Work', 'Gaming', 'Education', 'Dating'], correct: 1 },
    { question: 'What color is the Discord logo?', answers: ['Blue', 'Purple', 'Blurple', 'Indigo'], correct: 2 },
    { question: 'How many boosts for Level 3?', answers: ['7', '10', '14', '20'], correct: 2 },
    { question: 'What is the maximum message length?', answers: ['1000', '2000', '4000', '8000'], correct: 2 }
  ]
};

const CATEGORY_TIMEOUT = 30_000;
const ANSWER_TIMEOUT = 15_000;
const ANSWER_LABELS = ['A', 'B', 'C', 'D'];
const REWARD_COOLDOWN_MS = TRIVIA_REWARD_COOLDOWN * 1000;

// When each member (per server) was last paid. Anyone can keep playing; coins are paid at
// most once per REWARD_COOLDOWN_MS so the quiz can't be farmed.
const lastRewardAt = new Map();

const capitalize = (text) => text.charAt(0).toUpperCase() + text.slice(1);
const randomInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const toUnix = (ms) => Math.floor(ms / 1000);

// Takes the member's reward slot before any await, so two answers at once can't both pay.
// Returns the claim time, or null while the cooldown runs.
function claimRewardSlot(key) {
  const now = Date.now();
  for (const [entryKey, paidAt] of lastRewardAt) {
    if (now - paidAt >= REWARD_COOLDOWN_MS) lastRewardAt.delete(entryKey);
  }
  if (lastRewardAt.has(key)) return null;
  lastRewardAt.set(key, now);
  return now;
}

async function payReward(user, guildId) {
  const key = `${guildId}-${user.id}`;
  const claimedAt = claimRewardSlot(key);
  if (!claimedAt) {
    return { paid: false, availableAt: lastRewardAt.get(key) + REWARD_COOLDOWN_MS };
  }

  try {
    const amount = randomInt(TRIVIA_REWARD.min, TRIVIA_REWARD.max);
    const economy = await Economy.getEconomy(user.id, guildId);
    await economy.addCoins(amount, 'Trivia reward');
    return { paid: true, amount, balance: economy.coins };
  } catch (error) {
    // Nothing was paid: free the slot again
    if (lastRewardAt.get(key) === claimedAt) lastRewardAt.delete(key);
    throw error;
  }
}

// Picks a question and shuffles its answers, tracking where the correct one ends up
function createRound(category) {
  const questions = TRIVIA_QUESTIONS[category];
  const question = questions[Math.floor(Math.random() * questions.length)];
  const answers = [...question.answers];
  const correctAnswer = question.answers[question.correct];

  // Fisher-Yates shuffle
  for (let i = answers.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [answers[i], answers[j]] = [answers[j], answers[i]];
  }

  return { category, question: question.question, answers, correctIndex: answers.indexOf(correctAnswer) };
}

const formatAnswer = (round, index) => `**${ANSWER_LABELS[index]}.** ${round.answers[index]}`;

function questionPayload(round, user) {
  const embed = new EmbedBuilder()
    .setColor(COLORS.RAPHAEL)
    .setTitle(`『 ${capitalize(round.category)} Trivia 』`)
    .setDescription(
      `**${round.question}**\n\n` +
      round.answers.map((_, i) => formatAnswer(round, i)).join('\n')
    )
    .setFooter({ text: `Answer within ${ANSWER_TIMEOUT / 1000} seconds • ${user.username}` });

  const row = new ActionRowBuilder().addComponents(
    round.answers.map((_, i) =>
      new ButtonBuilder()
        .setCustomId(`trivia_answer_${i}`)
        .setLabel(ANSWER_LABELS[i])
        .setStyle(ButtonStyle.Secondary)
    )
  );

  return { embeds: [embed], components: [row] };
}

function replyPrivately(interaction, content) {
  return interaction.reply({ content, flags: MessageFlags.Ephemeral }).catch(() => {});
}

// Builds the result embed for an answer (and pays a correct one)
async function resultEmbed(round, selected, user, guildId, coinName) {
  if (selected !== round.correctIndex) {
    return new EmbedBuilder()
      .setColor(COLORS.RAPHAEL_ERROR)
      .setTitle('『 Incorrect Answer 』')
      .setDescription(
        `**${round.question}**\n\n` +
        `▸ **Your Response:** ${formatAnswer(round, selected)}\n` +
        `▸ **Correct Answer:** ${formatAnswer(round, round.correctIndex)}\n\n` +
        `Analysis suggests further study, Master.`
      )
      .setFooter({ text: `${getRandomFooter()} | ${user.username}` });
  }

  const reward = await payReward(user, guildId);
  const embed = new EmbedBuilder()
    .setColor(COLORS.RAPHAEL_SUCCESS)
    .setTitle('『 Correct Answer 』')
    .setFooter({ text: `${getRandomFooter()} | ${user.username}` });

  if (reward.paid) {
    return embed
      .setDescription(
        `**${round.question}**\n\n` +
        `▸ **Answer:** ${formatAnswer(round, round.correctIndex)}\n\n` +
        `**Confirmed:** **${formatNumber(reward.amount)}** ${coinName} credited to your account, Master.`
      )
      .addFields({ name: '▸ Updated Balance', value: `**${formatNumber(reward.balance)}** ${coinName}` });
  }

  return embed.setDescription(
    `**${round.question}**\n\n` +
    `▸ **Answer:** ${formatAnswer(round, round.correctIndex)}\n\n` +
    `Knowledge verified, Master. Rewards are limited to one every ${TRIVIA_REWARD_COOLDOWN} seconds; ` +
    `the next paid answer is available <t:${toUnix(reward.availableAt)}:R>.`
  );
}

// Waits for the player's answer on `questionMsg`, which already shows the round
function awaitAnswer(questionMsg, round, { user, guildId, coinName, prefix }) {
  const collector = questionMsg.createMessageComponentCollector({
    componentType: ComponentType.Button,
    time: ANSWER_TIMEOUT
  });
  let answered = false;

  collector.on('collect', async (interaction) => {
    if (interaction.user.id !== user.id) {
      return replyPrivately(interaction,
        `This question belongs to ${user.username}, Master. Start your own round with \`${prefix}trivia\`.`);
    }
    if (answered) return interaction.deferUpdate().catch(() => {});
    answered = true;
    collector.stop('answered');

    try {
      await interaction.deferUpdate();
      const selected = Number(interaction.customId.slice('trivia_answer_'.length));
      if (!Number.isInteger(selected) || selected < 0 || selected >= round.answers.length) {
        throw new Error(`Unexpected trivia button: ${interaction.customId}`);
      }

      const embed = await resultEmbed(round, selected, user, guildId, coinName);
      await interaction.editReply({ embeds: [embed], components: [] });
    } catch (error) {
      console.error('[Trivia] Error processing answer:', error);
      const embed = await errorEmbed(guildId, 'Assessment Error', 'Your answer could not be processed, Master. Please try again.');
      await interaction.editReply({ embeds: [embed], components: [] }).catch(() => {});
    }
  });

  collector.on('end', async (_collected, reason) => {
    if (reason !== 'time') return;
    try {
      const timeoutEmbed = new EmbedBuilder()
        .setColor(COLORS.RAPHAEL_WARNING)
        .setTitle('『 Time Expired 』')
        .setDescription(
          `**${round.question}**\n\n` +
          `▸ **Correct Answer:** ${formatAnswer(round, round.correctIndex)}\n\n` +
          `Response time exceeded the limit, Master.`
        )
        .setFooter({ text: `${getRandomFooter()} | ${user.username}` });

      await questionMsg.edit({ embeds: [timeoutEmbed], components: [] });
    } catch (error) {
      // Message deleted or no longer editable
    }
  });
}

export default {
  name: 'trivia',
  description: 'Play a trivia quiz game',
  usage: 'trivia [category]',
  category: 'fun',
  aliases: ['quiz', 'question'],
  cooldown: 5,

  async execute(message, args) {
    const guildId = message.guild.id;
    const user = message.author;

    try {
      const guildConfig = await Guild.getGuild(guildId);
      const context = {
        user,
        guildId,
        coinName: guildConfig.economy?.coinName || DEFAULT_COIN_NAME,
        prefix: await getPrefix(guildId)
      };

      // A valid category starts straight away (own keys only, so "constructor" etc. never match)
      const category = args[0]?.toLowerCase();
      if (category && Object.hasOwn(TRIVIA_QUESTIONS, category)) {
        const round = createRound(category);
        const questionMsg = await message.reply(questionPayload(round, user));
        return awaitAnswer(questionMsg, round, context);
      }

      // Otherwise ask for a category; the same message then becomes the question
      const categories = Object.keys(TRIVIA_QUESTIONS);
      const categoryEmbed = new EmbedBuilder()
        .setColor(COLORS.RAPHAEL)
        .setTitle('『 Knowledge Assessment 』')
        .setDescription(
          '**Answer:** Select a category to begin, Master.\n\n' +
          categories.map(cat => `▸ **${capitalize(cat)}**`).join('\n') +
          `\n\n**Reward:** ${formatNumber(TRIVIA_REWARD.min)}-${formatNumber(TRIVIA_REWARD.max)} ${context.coinName} per correct response ` +
          `(at most one paid answer every ${TRIVIA_REWARD_COOLDOWN} seconds).`
        )
        .setFooter({ text: getRandomFooter() });

      const row = new ActionRowBuilder().addComponents(
        categories.map(cat =>
          new ButtonBuilder()
            .setCustomId(`trivia_cat_${cat}`)
            .setLabel(capitalize(cat))
            .setStyle(ButtonStyle.Primary)
        )
      );

      const categoryMsg = await message.reply({ embeds: [categoryEmbed], components: [row] });

      const collector = categoryMsg.createMessageComponentCollector({
        componentType: ComponentType.Button,
        time: CATEGORY_TIMEOUT
      });
      let chosen = false;

      collector.on('collect', async (interaction) => {
        if (interaction.user.id !== user.id) {
          return replyPrivately(interaction,
            `This assessment belongs to ${user.username}, Master. Start your own with \`${context.prefix}trivia\`.`);
        }
        if (chosen) return interaction.deferUpdate().catch(() => {});
        chosen = true;
        collector.stop('selected');

        try {
          const selected = interaction.customId.slice('trivia_cat_'.length);
          if (!Object.hasOwn(TRIVIA_QUESTIONS, selected)) {
            throw new Error(`Unknown trivia category: ${selected}`);
          }
          const round = createRound(selected);
          await interaction.update(questionPayload(round, user));
          awaitAnswer(categoryMsg, round, context);
        } catch (error) {
          console.error('[Trivia] Error starting round:', error);
          const embed = await errorEmbed(guildId, 'Assessment Error', 'The question could not be loaded, Master. Please try again.');
          await categoryMsg.edit({ embeds: [embed], components: [] }).catch(() => {});
        }
      });

      collector.on('end', async (_collected, reason) => {
        if (reason !== 'time') return;
        const timeoutEmbed = new EmbedBuilder()
          .setColor(COLORS.RAPHAEL_WARNING)
          .setTitle('『 Session Expired 』')
          .setDescription('**Notice:** Category selection timed out, Master.')
          .setFooter({ text: getRandomFooter() });

        await categoryMsg.edit({ embeds: [timeoutEmbed], components: [] }).catch(() => {});
      });

    } catch (error) {
      console.error('[Trivia] Error:', error);
      return message.reply({
        embeds: [await errorEmbed(guildId, 'Assessment Error', 'The knowledge assessment could not be started, Master. Please try again.')]
      }).catch(() => {});
    }
  }
};
