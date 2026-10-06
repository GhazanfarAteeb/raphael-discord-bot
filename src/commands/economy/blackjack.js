import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } from 'discord.js';
import Economy from '../../models/Economy.js';
import Guild from '../../models/Guild.js';
import { errorEmbed, COLORS } from '../../utils/embeds.js';
import { getPrefix, formatNumber } from '../../utils/helpers.js';
import { getCardEmojis, cardEmoji, cardBackEmoji } from '../../utils/cardEmojis.js';
import { BLACKJACK_MIN, BLACKJACK_MAX } from '../../utils/gameConfig.js';

// Card suits and values
const SUITS = ['♠️', '♥️', '♦️', '♣️'];
const VALUES = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];

// A hand left untouched this long is stood automatically and settled (never refunded)
const IDLE_TIMEOUT = 60_000;

// Active games by user ID. The entry is reserved before the first await, so a second
// command (e.g. !bj and !21 at once) can't start a parallel game with the same coins.
// Games live only in memory: on shutdown, unfinished ones are refunded (refundActiveGames).
const activeGames = new Map();

// Payouts in progress, awaited at shutdown so none is cut off halfway
const pendingSettlements = new Set();

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

// Deals the top card into a hand. Like OwO, only cards dealt during the current move
// flip in; cards already on the table show their static face, so they don't flip again
// every time the message is edited.
function deal(game, hand) {
  const card = game.deck.pop();
  hand.push(card);
  game.fresh.add(card);
  return card;
}

// Card emojis (text cards until the emojis are uploaded)
function getHandDisplay(game, hand, hideHoleCard = false) {
  return hand
    .map((card, i) => (hideHoleCard && i === 1
      ? cardBackEmoji(game.emojis)
      : cardEmoji(card, game.emojis, game.fresh.has(card))))
    .join(' ');
}

// Compact table: the bet as the header, both hands side by side with their totals,
// the state or result in the footer. Notes (an ace switching to 1, etc.) appear only when needed.
function buildGameEmbed(game, { reveal = false, footer = '◇ ~ Game in progress, Master', notes = [], color = COLORS.RAPHAEL }) {
  const dealerValue = reveal ? formatTotal(game.dealerHand, true) : `${formatTotal([game.dealerHand[0]])}+?`;
  const embed = new EmbedBuilder()
    .setColor(color)
    .setAuthor({
      name: `${game.playerName}, you bet ${formatNumber(game.bet)} ${game.currency} to play blackjack`,
      iconURL: game.avatarURL
    })
    .addFields(
      { name: `Dealer \`[${dealerValue}]\``, value: getHandDisplay(game, game.dealerHand, !reveal), inline: true },
      { name: `${game.playerName} \`[${formatTotal(game.playerHand, reveal)}]\``, value: getHandDisplay(game, game.playerHand), inline: true }
    )
    .setFooter({ text: footer });
  if (notes.length) embed.setDescription(notes.join('\n'));
  return embed;
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
    deal(game, game.dealerHand);
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

// One-line result for the footer (the totals are already in the field names)
function getResultFooter(result, game, payout, balance) {
  const coins = (n) => `${formatNumber(n)} ${game.currency}`;
  const won = coins(payout - game.bet);
  const lost = coins(game.bet);
  const text = {
    blackjack: `◉ ~ Blackjack! You won ${won}`,
    win: `◉ ~ You won ${won}`,
    dealer_bust: `◉ ~ The dealer went over 21! You won ${won}`,
    push: `◈ ~ Tie! Your ${lost} were returned`,
    bust: `◆ ~ Over 21! You lost ${lost}`,
    dealer_blackjack: `◆ ~ The dealer has blackjack. You lost ${lost}`
  }[result] ?? `◆ ~ You lost ${lost}`;
  return `${text}, Master | Balance: ${coins(balance)}`;
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
  const settlement = payOut(game, result, notes);
  pendingSettlements.add(settlement);
  try {
    return await settlement;
  } finally {
    pendingSettlements.delete(settlement);
  }
}

async function payOut(game, result, notes) {
  activeGames.delete(game.userId);
  // The dealer's hidden card is turned over now, so it flips in with the result
  game.fresh.add(game.dealerHand[1]);

  const payout = getPayout(result, game.bet);
  const economy = await Economy.getEconomy(game.userId, game.guildId);
  if (payout > 0) {
    await economy.addCoins(payout, 'Blackjack payout');
  }
  if (payout > game.bet) economy.gamblingWins = (economy.gamblingWins || 0) + 1;
  if (payout < game.bet) economy.gamblingLosses = (economy.gamblingLosses || 0) + 1;
  economy.gamblingTotal = (economy.gamblingTotal || 0) + game.bet;
  await economy.save();

  return buildGameEmbed(game, {
    reveal: true,
    footer: getResultFooter(result, game, payout, economy.coins),
    notes,
    color: RESULT_COLORS[result] ?? COLORS.RAPHAEL_ERROR
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Called on shutdown. Games can't resume after a restart (they live in memory and
 * the wager was taken up front), so every unfinished game is closed and its wager
 * returned, and payouts already under way are awaited. Resolves to the number of
 * games refunded.
 */
export async function refundActiveGames() {
  const open = [...activeGames.values()].filter((game) => !game.over && game.bet > 0);
  for (const game of open) {
    game.over = true; // any move still in flight stops at its next game.over check
    activeGames.delete(game.userId);
    game.collector?.stop('shutdown');
  }

  await Promise.all(open.map(async (game) => {
    try {
      const economy = await Economy.getEconomy(game.userId, game.guildId);
      await economy.addCoins(game.bet, 'Blackjack refund (bot restart)');
    } catch (error) {
      // Logged with what's needed to return the coins by hand
      console.error(`[Blackjack] Could not refund ${game.bet} to user ${game.userId} in guild ${game.guildId}:`, error);
      return;
    }
    if (!game.message) return;
    game.fresh.clear();
    const embed = buildGameEmbed(game, {
      footer: `◈ ~ Raphael is restarting. Your ${formatNumber(game.bet)} ${game.currency} were returned, Master`,
      color: COLORS.RAPHAEL_WARNING
    });
    // Best effort: shutdown doesn't wait on a slow edit
    await Promise.race([game.message.edit({ embeds: [embed], components: [] }).catch(() => {}), sleep(3000)]);
  }));

  await Promise.allSettled([...pendingSettlements]);
  return open.length;
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
    // The seat is the game itself, filled in as it is set up, so a shutdown at any
    // point finds it. `bet` is recorded before the wager is taken for the same reason.
    const game = { userId, guildId, bet: 0, over: false, busy: false };
    activeGames.set(userId, game);

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

      game.bet = bet;
      await economy.removeCoins(bet, 'Blackjack wager');
      wagerTaken = bet;

      Object.assign(game, {
        playerName: message.author.username,
        avatarURL: message.author.displayAvatarURL?.(),
        currency,
        originalBet: bet,
        deck: createDeck(),
        playerHand: [],
        dealerHand: [],
        fresh: new Set(),
        emojis: await getCardEmojis(client)
      });
      if (game.over) return; // refunded by a shutdown during setup
      deal(game, game.playerHand);
      deal(game, game.playerHand);
      deal(game, game.dealerHand);
      deal(game, game.dealerHand);

      // Naturals end the hand at once (the dealer checks for blackjack before play)
      if (isNatural(game.playerHand) || isNatural(game.dealerHand)) {
        game.over = true;
        const result = !isNatural(game.dealerHand) ? 'blackjack'
          : isNatural(game.playerHand) ? 'push' : 'dealer_blackjack';
        const embed = await settleGame(game, result);
        return message.reply({ embeds: [embed] });
      }

      const canDouble = economy.coins >= bet;
      const gameMessage = await message.reply({
        embeds: [buildGameEmbed(game, {})],
        components: [buildButtons(game, canDouble)]
      });
      game.message = gameMessage;
      if (game.over) return;

      // Ends when the game finishes, or after IDLE_TIMEOUT without a move
      const collector = gameMessage.createMessageComponentCollector({
        filter: (i) => i.customId.startsWith('blackjack_'),
        idle: IDLE_TIMEOUT
      });
      game.collector = collector;

      const finish = async (interaction, result, notes) => {
        if (game.over) return; // refunded by a shutdown meanwhile
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
        // Cards dealt by an earlier move are on the table now: only this move's cards flip
        game.fresh.clear();

        try {
          await interaction.deferUpdate();
          if (game.over) return; // refunded by a shutdown meanwhile

          if (interaction.customId === 'blackjack_hit') {
            const handBefore = [...game.playerHand];
            deal(game, game.playerHand);
            const aceNote = aceSwitchNote(handBefore, game.playerHand);
            const value = calculateHand(game.playerHand);
            if (value > 21) return await finish(interaction, 'bust');
            if (value === 21) return await finish(interaction, resolveStand(game), aceNote ? [aceNote] : []);
            return await interaction.editReply({
              embeds: [buildGameEmbed(game, { notes: aceNote ? [aceNote] : [] })],
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
            if (game.over) return;
            if (economy.coins < game.originalBet) {
              return await interaction.followUp({ content: `You lack the ${currency} to double down, Master.`, flags: MessageFlags.Ephemeral });
            }
            // Counted before the await, so a shutdown refund during it returns both wagers
            game.bet += game.originalBet;
            try {
              await economy.removeCoins(game.originalBet, 'Blackjack double down');
            } catch (error) {
              game.bet -= game.originalBet;
              throw error;
            }
            if (game.over) return;
            const handBefore = [...game.playerHand];
            deal(game, game.playerHand);
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
        game.fresh.clear();
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
      // The game never reached the table: free the seat and return the wager
      if (activeGames.get(userId) === game) activeGames.delete(userId);
      const refund = wagerTaken > 0 && !game.over;
      game.over = true;
      if (refund) {
        const economy = await Economy.getEconomy(userId, guildId).catch(() => null);
        await economy?.addCoins(wagerTaken, 'Blackjack refund').catch(() => {});
      }
      return message.reply({
        embeds: [await errorEmbed(guildId, 'Table Error',
          `The game could not be started${refund ? ' and your wager has been returned' : ''}, Master.`)]
      }).catch(() => {});
    }
  }
};
