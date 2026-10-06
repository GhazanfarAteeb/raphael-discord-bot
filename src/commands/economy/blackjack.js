import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } from 'discord.js';
import Economy from '../../models/Economy.js';
import Guild from '../../models/Guild.js';
import { errorEmbed, COLORS } from '../../utils/embeds.js';
import { getPrefix, formatNumber } from '../../utils/helpers.js';
import { getRandomFooter } from '../../utils/raphael.js';
import { getCardEmojis, cardEmoji, cardBackEmoji } from '../../utils/cardEmojis.js';
import { BLACKJACK_MIN, BLACKJACK_MAX } from '../../utils/gameConfig.js';

// Card suits and values
const SUITS = ['♠️', '♥️', '♦️', '♣️'];
const VALUES = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];

// A hand left untouched this long is stood automatically and settled (never refunded)
const IDLE_TIMEOUT = 60_000;

// Active games by user ID. The entry is reserved before the first await, so a second
// command (e.g. !bj and !21 at once) can't start a parallel game with the same coins.
const activeGames = new Map();

// Create a shuffled deck of cards
function createDeck() {
  const deck = [];
  for (const suit of SUITS) {
    for (const value of VALUES) {
      deck.push({ suit, value });
    }
  }
  // Fisher-Yates shuffle
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function getCardValue(card) {
  if (['J', 'Q', 'K'].includes(card.value)) return 10;
  if (card.value === 'A') return 11;
  return parseInt(card.value, 10);
}

// Hand total, counting each ace as 11 unless that would bust. `soft` means an ace
// still counts as 11, so the next card can lower the total by 10 instead of busting.
function getHandTotal(hand) {
  let total = 0;
  let aces = 0;
  for (const card of hand) {
    total += getCardValue(card);
    if (card.value === 'A') aces++;
  }
  while (total > 21 && aces > 0) {
    total -= 10;
    aces--;
  }
  return { total, soft: aces > 0 };
}

const calculateHand = (hand) => getHandTotal(hand).total;

const isNatural = (hand) => hand.length === 2 && calculateHand(hand) === 21;

// A soft hand in play reads "10/20" (both of its possible totals), so a hit that drops
// it to the lower one is expected. Once the hand is over, only the final total counts.
function formatTotal(hand, final = false) {
  const { total, soft } = getHandTotal(hand);
  return soft && !final && total < 21 ? `${total - 10}/${total}` : `${total}`;
}

// Explains a drawn card that left the total lower than expected: an ace switched to 1
function aceSwitchNote(handBefore, hand) {
  const drawn = hand[hand.length - 1];
  const total = calculateHand(hand);
  if (calculateHand(handBefore) + getCardValue(drawn) === total) return null;
  return `◈ An ace now counts as 1 (11 would take you over 21), so your hand is **${total}**.`;
}

// Card emojis (text cards until the emojis are uploaded)
function getHandDisplay(hand, emojis, hideHoleCard = false) {
  return hand
    .map((card, i) => (hideHoleCard && i === 1 ? cardBackEmoji(emojis) : cardEmoji(card, emojis)))
    .join(' ');
}

function buildGameEmbed(game, { reveal = false, status, color = COLORS.RAPHAEL }) {
  const dealerValue = reveal ? formatTotal(game.dealerHand, true) : `${formatTotal([game.dealerHand[0]])}+?`;
  return new EmbedBuilder()
    .setTitle('『 Strategic Card Analysis 』')
    .setColor(color)
    .setDescription(status)
    .addFields(
      { name: `▸ Dealer (${dealerValue})`, value: getHandDisplay(game.dealerHand, game.emojis, !reveal) },
      { name: `▸ ${game.playerName} (${formatTotal(game.playerHand, reveal)})`, value: getHandDisplay(game.playerHand, game.emojis) }
    )
    .setFooter({ text: `${getRandomFooter()} | Wager: ${formatNumber(game.bet)} ${game.currency}` });
}

function buildButtons(game, canDouble) {
  const hit = new ButtonBuilder().setCustomId('blackjack_hit').setLabel('Hit').setStyle(ButtonStyle.Primary);
  const cardBack = game.emojis.get('card_back');
  if (cardBack) hit.setEmoji(cardBack);

  return new ActionRowBuilder().addComponents(
    hit,
    new ButtonBuilder().setCustomId('blackjack_stand').setLabel('Stand').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('blackjack_double')
      .setLabel('Double Down')
      .setStyle(ButtonStyle.Success)
      .setDisabled(!canDouble)
  );
}

// Dealer draws to 17, then the hands are compared
function resolveStand(game) {
  while (calculateHand(game.dealerHand) < 17) {
    game.dealerHand.push(game.deck.pop());
  }
  const dealer = calculateHand(game.dealerHand);
  const player = calculateHand(game.playerHand);
  if (dealer > 21) return 'dealer_bust';
  if (player > dealer) return 'win';
  if (player < dealer) return 'lose';
  return 'push';
}

// Total returned to the player for each result (the wager was already taken)
function getPayout(result, bet) {
  switch (result) {
    case 'blackjack': return Math.floor(bet * 2.5); // 3:2
    case 'win':
    case 'dealer_bust': return bet * 2;
    case 'push': return bet;
    default: return 0;
  }
}

function getResultText(result, game, payout) {
  const amount = (n) => `**${formatNumber(n)}** ${game.currency}`;
  const net = payout - game.bet;
  const player = calculateHand(game.playerHand);
  const dealer = calculateHand(game.dealerHand);
  switch (result) {
    case 'blackjack':
      return `◉ **OPTIMAL HAND ACHIEVED** — Natural 21 detected. Net gain: ${amount(net)}, Master.`;
    case 'win':
      return `◉ **VICTORY CONFIRMED** — Your **${player}** beats the dealer's **${dealer}**. Net gain: ${amount(net)}, Master.`;
    case 'dealer_bust':
      return `◉ **DEALER EXCEEDED** — The dealer reached **${dealer}**, over 21. Net gain: ${amount(net)}, Master.`;
    case 'push':
      return `◈ **DRAW DETECTED** — Both hands total **${player}**. Your wager of ${amount(game.bet)} has been returned, Master.`;
    case 'bust':
      return `◆ **THRESHOLD EXCEEDED** — Your hand reached **${player}**, over 21. Loss: ${amount(game.bet)}, Master.`;
    case 'dealer_blackjack':
      return `◆ **DEALER NATURAL 21** — The dealer holds blackjack. Loss: ${amount(game.bet)}, Master.`;
    default:
      return `◆ **DEFEAT RECORDED** — The dealer's **${dealer}** beats your **${player}**. Loss: ${amount(game.bet)}, Master.`;
  }
}

const RESULT_COLORS = {
  blackjack: COLORS.RAPHAEL_WARNING,
  win: COLORS.RAPHAEL_SUCCESS,
  dealer_bust: COLORS.RAPHAEL_SUCCESS,
  push: COLORS.RAPHAEL_WARNING
};

// Pays out, records gambling stats and returns the final embed. Callers mark the game
// over (synchronously) before calling, so a game can only ever be settled once.
async function settleGame(game, result, notes = []) {
  activeGames.delete(game.userId);

  const payout = getPayout(result, game.bet);
  const economy = await Economy.getEconomy(game.userId, game.guildId);
  if (payout > 0) {
    await economy.addCoins(payout, 'Blackjack payout');
  }
  if (payout > game.bet) economy.gamblingWins = (economy.gamblingWins || 0) + 1;
  if (payout < game.bet) economy.gamblingLosses = (economy.gamblingLosses || 0) + 1;
  economy.gamblingTotal = (economy.gamblingTotal || 0) + game.bet;
  await economy.save();

  const status = [getResultText(result, game, payout), ...notes].join('\n');
  return buildGameEmbed(game, { reveal: true, status, color: RESULT_COLORS[result] ?? COLORS.RAPHAEL_ERROR })
    .addFields({ name: '▸ Updated Balance', value: `**${formatNumber(economy.coins)}** ${game.currency}` });
}

// Parses "100", "all" or "max" into a wager, or returns an error message
function parseBet(input, coins) {
  const value = input?.toLowerCase();
  if (value === 'all' || value === 'max') return Math.min(coins, BLACKJACK_MAX);
  if (!/^\d+$/.test(value ?? '')) return null;
  return parseInt(value, 10);
}

export default {
  name: 'blackjack',
  description: 'Play a game of Blackjack against the dealer',
  usage: '<bet|all>',
  aliases: ['bj', '21'],
  category: 'economy',
  cooldown: 3,

  async execute(message, args, client) {
    const userId = message.author.id;
    const guildId = message.guild.id;

    if (activeGames.has(userId)) {
      return message.reply({
        embeds: [await errorEmbed(guildId, 'Game In Progress', 'You already have an active game at the table, Master. Finish it first.')]
      });
    }
    activeGames.set(userId, { pending: true });

    let wagerTaken = 0;
    try {
      const prefix = await getPrefix(guildId);
      const guildConfig = await Guild.getGuild(guildId, message.guild.name);
      const currency = guildConfig.economy?.coinName || 'coins';
      const economy = await Economy.getEconomy(userId, guildId);

      const bet = parseBet(args[0], economy.coins);
      if (bet === null) {
        activeGames.delete(userId);
        return message.reply({
          embeds: [await errorEmbed(guildId, 'Missing Wager',
            `Specify a wager, Master.\n\n**Usage:** \`${prefix}blackjack <amount|all>\`\n**Example:** \`${prefix}blackjack 100\``)]
        });
      }
      if (bet < BLACKJACK_MIN || bet > BLACKJACK_MAX) {
        activeGames.delete(userId);
        return message.reply({
          embeds: [await errorEmbed(guildId, 'Invalid Wager',
            `Wagers must be between **${formatNumber(BLACKJACK_MIN)}** and **${formatNumber(BLACKJACK_MAX)}** ${currency}, Master.`)]
        });
      }
      if (economy.coins < bet) {
        activeGames.delete(userId);
        return message.reply({
          embeds: [await errorEmbed(guildId, 'Insufficient Funds',
            `Your balance of **${formatNumber(economy.coins)}** ${currency} cannot cover a wager of **${formatNumber(bet)}**, Master.`)]
        });
      }

      await economy.removeCoins(bet, 'Blackjack wager');
      wagerTaken = bet;

      const deck = createDeck();
      const game = {
        userId,
        guildId,
        playerName: message.author.username,
        currency,
        bet,
        originalBet: bet,
        deck,
        playerHand: [deck.pop(), deck.pop()],
        dealerHand: [deck.pop(), deck.pop()],
        emojis: await getCardEmojis(client),
        over: false,
        busy: false
      };
      activeGames.set(userId, game);

      // Naturals end the hand at once (the dealer checks for blackjack before play)
      if (isNatural(game.playerHand) || isNatural(game.dealerHand)) {
        game.over = true;
        const result = !isNatural(game.dealerHand) ? 'blackjack'
          : isNatural(game.playerHand) ? 'push' : 'dealer_blackjack';
        const embed = await settleGame(game, result);
        return message.reply({ embeds: [embed] });
      }

      const canDouble = economy.coins >= bet;
      const opening = ['◇ **Hit** to draw a card, **Stand** to hold, or **Double Down** to double your wager and draw one final card.'];
      if (getHandTotal(game.playerHand).soft) {
        opening.push('◇ Aces count as 11, or as 1 whenever 11 would take you over 21.');
      }
      const gameMessage = await message.reply({
        embeds: [buildGameEmbed(game, { status: opening.join('\n') })],
        components: [buildButtons(game, canDouble)]
      });

      // Ends when the game finishes, or after IDLE_TIMEOUT without a move
      const collector = gameMessage.createMessageComponentCollector({
        filter: (i) => i.customId.startsWith('blackjack_'),
        idle: IDLE_TIMEOUT
      });

      const finish = async (interaction, result, notes) => {
        game.over = true;
        collector.stop('finished');
        const embed = await settleGame(game, result, notes);
        return interaction.editReply({ embeds: [embed], components: [] });
      };

      collector.on('collect', async (interaction) => {
        if (interaction.user.id !== userId) {
          return interaction.reply({
            content: `This table belongs to ${game.playerName}, Master. Start your own game with \`${prefix}blackjack\`.`,
            flags: MessageFlags.Ephemeral
          }).catch(() => {});
        }
        // One action at a time; ignore clicks while busy or after the game ended
        if (game.over || game.busy) return interaction.deferUpdate().catch(() => {});
        game.busy = true;

        try {
          await interaction.deferUpdate();

          if (interaction.customId === 'blackjack_hit') {
            const handBefore = [...game.playerHand];
            game.playerHand.push(game.deck.pop());
            const aceNote = aceSwitchNote(handBefore, game.playerHand);
            const value = calculateHand(game.playerHand);
            if (value > 21) return await finish(interaction, 'bust');
            if (value === 21) return await finish(interaction, resolveStand(game), aceNote ? [aceNote] : []);
            const drawn = game.playerHand[game.playerHand.length - 1];
            const status = [`◇ You drew ${cardEmoji(drawn, game.emojis)}`, aceNote].filter(Boolean).join('\n');
            return await interaction.editReply({
              embeds: [buildGameEmbed(game, { status })],
              components: [buildButtons(game, false)]
            });
          }

          if (interaction.customId === 'blackjack_stand') {
            return await finish(interaction, resolveStand(game));
          }

          if (interaction.customId === 'blackjack_double') {
            if (game.playerHand.length !== 2) {
              return await interaction.followUp({ content: 'Double Down is only available on your first two cards, Master.', flags: MessageFlags.Ephemeral });
            }
            const economy = await Economy.getEconomy(userId, guildId);
            if (economy.coins < game.originalBet) {
              return await interaction.followUp({ content: `You lack the ${currency} to double down, Master.`, flags: MessageFlags.Ephemeral });
            }
            await economy.removeCoins(game.originalBet, 'Blackjack double down');
            game.bet += game.originalBet;
            const handBefore = [...game.playerHand];
            game.playerHand.push(game.deck.pop());
            const aceNote = aceSwitchNote(handBefore, game.playerHand);
            const result = calculateHand(game.playerHand) > 21 ? 'bust' : resolveStand(game);
            return await finish(interaction, result, ['◈ Wager doubled.', aceNote].filter(Boolean));
          }
        } catch (error) {
          console.error('[Blackjack] Error handling action:', error);
          await interaction.followUp({ content: '**Warning:** That action could not be processed, Master. Please try again.', flags: MessageFlags.Ephemeral }).catch(() => {});
        } finally {
          game.busy = false;
        }
      });

      // Idle, message deleted, etc.: the hand stands and is settled, so walking away is never a refund
      collector.on('end', async (_collected, reason) => {
        if (game.over) return;
        game.over = true;
        try {
          const note = reason === 'idle' ? `◈ No action for ${IDLE_TIMEOUT / 1000} seconds: the hand stood automatically.` : null;
          const embed = await settleGame(game, resolveStand(game), note ? [note] : []);
          await gameMessage.edit({ embeds: [embed], components: [] }).catch(() => {});
        } catch (error) {
          console.error('[Blackjack] Error settling an abandoned game:', error);
        }
      });
    } catch (error) {
      console.error('[Blackjack] Error starting game:', error);
      // The game never reached the table: return the wager and free the seat
      const game = activeGames.get(userId);
      activeGames.delete(userId);
      if (wagerTaken && !game?.over) {
        const economy = await Economy.getEconomy(userId, guildId).catch(() => null);
        await economy?.addCoins(wagerTaken, 'Blackjack refund').catch(() => {});
      }
      return message.reply({
        embeds: [await errorEmbed(guildId, 'Table Error', 'The game could not be started and your wager has been returned, Master.')]
      }).catch(() => {});
    }
  }
};
