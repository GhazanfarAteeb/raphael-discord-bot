import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType, MessageFlags } from 'discord.js';
import { errorEmbed, COLORS } from '../../utils/embeds.js';
import { getPrefix } from '../../utils/helpers.js';
import { getRandomFooter } from '../../utils/raphael.js';

// The opponent has this long to answer a challenge
const CHALLENGE_TIMEOUT = 30_000;
// A game ends when nobody moves for this long
const MOVE_TIMEOUT = 60_000;
// Label for an empty cell (button labels cannot be blank)
const EMPTY_LABEL = '•';
const WIN_PATTERNS = [
  [0, 1, 2], [3, 4, 5], [6, 7, 8], // Rows
  [0, 3, 6], [1, 4, 7], [2, 5, 8], // Columns
  [0, 4, 8], [2, 4, 6]             // Diagonals
];

// Every player in a challenge or game, keyed `${guildId}-${userId}`. Both players are
// registered when the challenge is issued and released however it ends.
const activeGames = new Map();

const playerKey = (guildId, userId) => `${guildId}-${userId}`;

function checkWinner(board) {
  for (const [a, b, c] of WIN_PATTERNS) {
    if (board[a] && board[a] === board[b] && board[b] === board[c]) {
      return board[a];
    }
  }
  return null;
}

function boardRows(game, allDisabled = false) {
  const rows = [];
  for (let i = 0; i < 3; i++) {
    const row = new ActionRowBuilder();
    for (let j = 0; j < 3; j++) {
      const index = i * 3 + j;
      const cell = game.board[index];
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(`ttt_cell_${index}`)
          .setLabel(cell ?? EMPTY_LABEL)
          .setStyle(cell === 'X' ? ButtonStyle.Primary : cell === 'O' ? ButtonStyle.Danger : ButtonStyle.Secondary)
          .setDisabled(allDisabled || cell !== null)
      );
    }
    rows.push(row);
  }
  return rows;
}

function matchLine(game) {
  return `**${game.players.X.username}** (X) vs **${game.players.O.username}** (O)`;
}

function turnEmbed(game) {
  const currentPlayer = game.players[game.currentTurn];
  return new EmbedBuilder()
    .setColor(COLORS.RAPHAEL)
    .setTitle('『 Strategic Challenge 』')
    .setDescription(`${matchLine(game)}\n\n▸ **Awaiting ${currentPlayer.username}'s move (${game.currentTurn})...**`)
    .setFooter({ text: `${getRandomFooter()} | ${MOVE_TIMEOUT / 1000} seconds per move` });
}

function endEmbed(game, color, title, text) {
  return new EmbedBuilder()
    .setColor(color)
    .setTitle(`『 ${title} 』`)
    .setDescription(`${matchLine(game)}\n\n${text}`)
    .setFooter({ text: getRandomFooter() });
}

function replyPrivately(interaction, content) {
  return interaction.reply({ content, flags: MessageFlags.Ephemeral }).catch(() => {});
}

// Plays the accepted game on `gameMsg`, which already shows the empty board
function runGame(gameMsg, game, release) {
  const collector = gameMsg.createMessageComponentCollector({
    componentType: ComponentType.Button,
    idle: MOVE_TIMEOUT
  });
  const isPlayer = (userId) => userId === game.players.X.id || userId === game.players.O.id;

  collector.on('collect', async (interaction) => {
    try {
      if (!isPlayer(interaction.user.id)) {
        return replyPrivately(interaction,
          `This match is between ${game.players.X.username} and ${game.players.O.username}, Master.`);
      }
      if (game.over) return interaction.deferUpdate().catch(() => {});

      const currentPlayer = game.players[game.currentTurn];
      if (interaction.user.id !== currentPlayer.id) {
        return replyPrivately(interaction, `It is ${currentPlayer.username}'s turn, Master.`);
      }

      const cellIndex = Number(interaction.customId.slice('ttt_cell_'.length));
      if (!Number.isInteger(cellIndex) || cellIndex < 0 || cellIndex > 8) {
        return interaction.deferUpdate().catch(() => {});
      }
      if (game.board[cellIndex] !== null) {
        return replyPrivately(interaction, 'That position is already occupied, Master. Select an empty one.');
      }

      // All state changes happen before the first await, so a second click can't act on a stale turn
      const mark = game.currentTurn;
      game.board[cellIndex] = mark;
      game.moves++;

      const winner = checkWinner(game.board);
      if (winner) {
        game.over = true;
        collector.stop('win');
        const winnerPlayer = game.players[winner];
        const loserPlayer = game.players[winner === 'X' ? 'O' : 'X'];
        return await interaction.update({
          embeds: [endEmbed(game, COLORS.RAPHAEL_SUCCESS, 'Game Over',
            `◉ **${winnerPlayer.username}** (${winner}) wins, Master.\n\nBetter luck next time, ${loserPlayer.username}.`)],
          components: boardRows(game, true)
        });
      }

      if (game.moves === game.board.length) {
        game.over = true;
        collector.stop('draw');
        return await interaction.update({
          embeds: [endEmbed(game, COLORS.RAPHAEL_WARNING, 'Draw', '◈ Neither side prevailed. The grid is full, Master.')],
          components: boardRows(game, true)
        });
      }

      game.currentTurn = mark === 'X' ? 'O' : 'X';
      await interaction.update({ embeds: [turnEmbed(game)], components: boardRows(game) });
    } catch (error) {
      console.error('[TicTacToe] Error handling move:', error);
      const reply = {
        embeds: [await errorEmbed(gameMsg.guildId, 'Game Error', 'That move could not be processed, Master. Please try again.')],
        flags: MessageFlags.Ephemeral
      };
      await (interaction.replied || interaction.deferred ? interaction.followUp(reply) : interaction.reply(reply)).catch(() => {});
    }
  });

  // Win, draw, idle or message deleted: the players are free either way
  collector.on('end', async (_collected, reason) => {
    release(game);
    if (game.over) return;
    game.over = true;
    if (reason !== 'idle') return;
    try {
      const idlePlayer = game.players[game.currentTurn];
      await gameMsg.edit({
        embeds: [endEmbed(game, COLORS.RAPHAEL_ERROR, 'Game Timed Out',
          `◆ ${idlePlayer.username} did not move within ${MOVE_TIMEOUT / 1000} seconds. The game has been cancelled, Master.`)],
        components: boardRows(game, true)
      });
    } catch (error) {
      // Message deleted or no longer editable
    }
  });
}

export default {
  name: 'tictactoe',
  description: 'Engage in strategic grid-based competition, Master',
  usage: 'tictactoe @user',
  category: 'fun',
  aliases: ['ttt', 'xo'],
  cooldown: 10,

  async execute(message, args) {
    const guildId = message.guild.id;
    const challenger = message.author;
    const opponent = message.mentions.users.first();
    const keys = opponent ? [playerKey(guildId, challenger.id), playerKey(guildId, opponent.id)] : [];
    let reserved = false;

    // Frees both players, but only if they are still registered to this game
    const release = (game) => {
      for (const key of keys) {
        if (activeGames.get(key) === game) activeGames.delete(key);
      }
    };

    try {
      // Check if opponent is mentioned
      if (!opponent) {
        const prefix = await getPrefix(guildId);
        return message.reply({
          embeds: [await errorEmbed(guildId, 'Opponent Required', `Please specify an opponent, Master.\n\n**Syntax:** \`${prefix}tictactoe @user\``)]
        });
      }

      // Can't play against yourself
      if (opponent.id === challenger.id) {
        return message.reply({ embeds: [await errorEmbed(guildId, 'Invalid Opponent', 'Self-challenge is not permitted, Master.')] });
      }

      // Can't play against bots
      if (opponent.bot) {
        return message.reply({ embeds: [await errorEmbed(guildId, 'Invalid Opponent', 'Automated systems cannot participate in games, Master.')] });
      }

      // Check and register both players with no await in between, so two challenges at once can't both pass
      if (keys.some(key => activeGames.has(key))) {
        return message.reply({
          embeds: [await errorEmbed(guildId, 'Session Active', 'One of you is already in an active game session or challenge, Master.')]
        });
      }

      const game = {
        board: Array(9).fill(null),
        players: { X: challenger, O: opponent },
        currentTurn: 'X',
        moves: 0,
        over: false
      };
      for (const key of keys) activeGames.set(key, game);
      reserved = true;

      // Create challenge embed
      const challengeEmbed = new EmbedBuilder()
        .setColor(COLORS.RAPHAEL)
        .setTitle('『 Strategic Challenge 』')
        .setDescription(
          `${challenger} has initiated a Tic Tac Toe challenge against ${opponent}.\n\n` +
          `${opponent}, do you accept this challenge?`
        )
        .setFooter({ text: `${getRandomFooter()} | Expires in ${CHALLENGE_TIMEOUT / 1000} seconds` });

      const challengeRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('ttt_accept').setLabel('Accept').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('ttt_decline').setLabel('Decline').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId('ttt_withdraw').setLabel('Withdraw').setStyle(ButtonStyle.Secondary)
      );

      const gameMsg = await message.reply({
        content: `${opponent}`,
        embeds: [challengeEmbed],
        components: [challengeRow]
      });

      const challengeCollector = gameMsg.createMessageComponentCollector({
        componentType: ComponentType.Button,
        time: CHALLENGE_TIMEOUT
      });
      let answered = false;

      challengeCollector.on('collect', async (interaction) => {
        const isChallenger = interaction.user.id === challenger.id;
        const isOpponent = interaction.user.id === opponent.id;

        if (interaction.customId === 'ttt_withdraw' && !isChallenger) {
          return replyPrivately(interaction, `Only ${challenger.username} can withdraw this challenge, Master.`);
        }
        if (interaction.customId !== 'ttt_withdraw' && !isOpponent) {
          return replyPrivately(interaction, `This challenge is addressed to ${opponent.username}, Master.`);
        }
        if (answered) return interaction.deferUpdate().catch(() => {});
        answered = true;

        try {
          if (interaction.customId === 'ttt_withdraw') {
            challengeCollector.stop('withdrawn');
            return await interaction.update({
              content: null,
              embeds: [endEmbed(game, COLORS.RAPHAEL_WARNING, 'Challenge Withdrawn', `**Notice:** ${challenger} has withdrawn the challenge.`)],
              components: []
            });
          }

          if (interaction.customId === 'ttt_decline') {
            challengeCollector.stop('declined');
            return await interaction.update({
              content: null,
              embeds: [endEmbed(game, COLORS.RAPHAEL_ERROR, 'Challenge Declined', `**Notice:** ${opponent} has declined the challenge.`)],
              components: []
            });
          }

          // Accepted: the same message becomes the board
          challengeCollector.stop('accepted');
          await interaction.update({ content: null, embeds: [turnEmbed(game)], components: boardRows(game) });
          runGame(gameMsg, game, release);
        } catch (error) {
          console.error('[TicTacToe] Error answering challenge:', error);
          game.over = true;
          release(game);
          const embed = await errorEmbed(guildId, 'Game Error', interaction.customId === 'ttt_accept'
            ? 'The game could not be started, Master. Please issue a new challenge.'
            : 'The challenge could not be updated, Master.');
          await gameMsg.edit({ content: null, embeds: [embed], components: [] }).catch(() => {});
        }
      });

      challengeCollector.on('end', async (_collected, reason) => {
        if (reason === 'accepted') return;
        release(game);
        if (reason !== 'time') return; // declined/withdrawn already updated; message deleted needs nothing
        try {
          await gameMsg.edit({
            content: null,
            embeds: [endEmbed(game, COLORS.RAPHAEL_WARNING, 'Challenge Expired', `**Notice:** ${opponent} did not respond in time.`)],
            components: []
          });
        } catch (error) {
          // Message deleted or no longer editable
        }
      });

    } catch (error) {
      console.error('[TicTacToe] Error:', error);
      if (reserved) release(activeGames.get(keys[0]));
      return message.reply({
        embeds: [await errorEmbed(guildId, 'Game Error', 'The challenge could not be issued, Master. Please try again.')]
      }).catch(() => {});
    }
  }
};
