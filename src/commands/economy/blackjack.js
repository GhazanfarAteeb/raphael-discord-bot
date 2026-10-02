import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import Economy from '../../models/Economy.js';
import Guild from '../../models/Guild.js';
import { errorEmbed, GLYPHS } from '../../utils/embeds.js';
import { getPrefix, formatNumber } from '../../utils/helpers.js';
import { getRandomFooter } from '../../utils/raphael.js';
import { getCardEmojis, cardEmoji, cardBackEmoji } from '../../utils/cardEmojis.js';

// Card suits and values
const SUITS = ['♠️', '♥️', '♦️', '♣️'];
const VALUES = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];

// Active games storage
const activeGames = new Map();

// Create a deck of cards
function createDeck() {
  const deck = [];
  for (const suit of SUITS) {
    for (const value of VALUES) {
      deck.push({ suit, value });
    }
  }
  return shuffleDeck(deck);
}

// Shuffle deck using Fisher-Yates algorithm
function shuffleDeck(deck) {
  const shuffled = [...deck];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

// Get card value
function getCardValue(card) {
  if (['J', 'Q', 'K'].includes(card.value)) return 10;
  if (card.value === 'A') return 11;
  return parseInt(card.value);
}

// Calculate hand value (handles aces)
function calculateHand(hand) {
  let value = 0;
  let aces = 0;

  for (const card of hand) {
    value += getCardValue(card);
    if (card.value === 'A') aces++;
  }

  // Convert aces from 11 to 1 if over 21
  while (value > 21 && aces > 0) {
    value -= 10;
    aces--;
  }

  return value;
}

// Get hand display with card emojis (text cards until the emojis are uploaded)
function getHandDisplay(hand, emojis, hideSecond = false) {
  return hand
    .map((card, i) => (hideSecond && i === 1 ? cardBackEmoji(emojis) : cardEmoji(card, emojis)))
    .join(' ');
}

// Create game embed
function createGameEmbed(game, guildConfig, showResult = false) {
  const embed = new EmbedBuilder()
    .setTitle('『 Strategic Card Analysis 』')
    .setColor(guildConfig.embedStyle?.color || '#00CED1')
    .setFooter({ text: `${getRandomFooter()} | Wager: ${formatNumber(game.bet)} ${guildConfig.economy?.currencyName || 'coins'}` });

  const dealerValue = calculateHand(game.dealerHand);
  const playerValue = calculateHand(game.playerHand);

  // Dealer's hand
  if (showResult) {
    embed.addFields({
      name: `▸ Dealer (${dealerValue})`,
      value: getHandDisplay(game.dealerHand, game.cardEmojis),
      inline: false
    });
  } else {
    const hiddenValue = getCardValue(game.dealerHand[0]);
    embed.addFields({
      name: `▸ Dealer (${hiddenValue}+?)`,
      value: getHandDisplay(game.dealerHand, game.cardEmojis, true),
      inline: false
    });
  }

  // Player's hand
  embed.addFields({
    name: `▸ ${game.playerName} (${playerValue})`,
    value: getHandDisplay(game.playerHand, game.cardEmojis),
    inline: false
  });

  return embed;
}

// Create action buttons
function createButtons(disabled = false) {
  return new ActionRowBuilder()
    .addComponents(
      new ButtonBuilder()
        .setCustomId('blackjack_hit')
        .setLabel('Hit')
        .setStyle(ButtonStyle.Primary)
        .setEmoji('🎴')
        .setDisabled(disabled),
      new ButtonBuilder()
        .setCustomId('blackjack_stand')
        .setLabel('Stand')
        .setStyle(ButtonStyle.Secondary)
        .setEmoji('✋')
        .setDisabled(disabled),
      new ButtonBuilder()
        .setCustomId('blackjack_double')
        .setLabel('Double Down')
        .setStyle(ButtonStyle.Success)
        .setEmoji('💰')
        .setDisabled(disabled)
    );
}

// End game and calculate winnings
async function endGame(game, message, guildConfig, result) {
  activeGames.delete(game.odId);

  const economy = await Economy.getEconomy(game.odId, message.guild.id);
  const currencyName = guildConfig.economy?.currencyName || 'coins';
  let winnings = 0;
  let resultText = '';
  let color = '#5865F2';

  const dealerValue = calculateHand(game.dealerHand);
  const playerValue = calculateHand(game.playerHand);

  switch (result) {
    case 'blackjack':
      winnings = Math.floor(game.bet * 2.5); // 3:2 payout
      resultText = `◉ **OPTIMAL HAND ACHIEVED** — Natural 21 detected! Winnings: **${formatNumber(winnings)}** ${currencyName}`;
      color = '#FFD700';
      break;
    case 'win':
      winnings = game.bet * 2;
      resultText = `◉ **VICTORY CONFIRMED** — You have earned **${formatNumber(winnings)}** ${currencyName}, Master.`;
      color = '#00FF7F';
      break;
    case 'push':
      winnings = game.bet;
      resultText = `◈ **DRAW DETECTED** — Your wager of **${formatNumber(game.bet)}** ${currencyName} has been returned.`;
      color = '#FFD700';
      break;
    case 'bust':
      resultText = `○ **THRESHOLD EXCEEDED** — Hand value surpassed 21. Loss: **${formatNumber(game.bet)}** ${currencyName}.`;
      color = '#FF4757';
      break;
    case 'lose':
      resultText = `○ **DEFEAT RECORDED** — You have lost **${formatNumber(game.bet)}** ${currencyName}, Master.`;
      color = '#FF4757';
      break;
    case 'dealer_bust':
      winnings = game.bet * 2;
      resultText = `◉ **DEALER EXCEEDED** — Opponent bust! Winnings: **${formatNumber(winnings)}** ${currencyName}`;
      color = '#00FF7F';
      break;
  }

  // Update balance
  if (winnings > 0) {
    await economy.addCoins(winnings);
  }

  // Create result embed
  const embed = createGameEmbed(game, { ...guildConfig, embedStyle: { ...guildConfig.embedStyle, color } }, true);
  embed.setDescription(resultText);
  embed.addFields({
    name: '▸ Updated Balance',
    value: `**${formatNumber(economy.coins + (winnings > 0 ? 0 : 0))}** ${currencyName}`,
    inline: true
  });

  return embed;
}

// Dealer plays
async function dealerPlay(game) {
  while (calculateHand(game.dealerHand) < 17) {
    game.dealerHand.push(game.deck.pop());
  }
}

export default {
  name: 'blackjack',
  description: 'Play a game of Blackjack against the dealer',
  usage: '<bet>',
  aliases: ['bj', '21'],
  category: 'economy',
  cooldown: 3,

  async execute(message, args, client) {
    const prefix = await getPrefix(message.guild.id);
    const guildConfig = await Guild.getGuild(message.guild.id, message.guild.name);
    const currencyName = guildConfig.economy?.currencyName || 'coins';

    // Check for existing game
    if (activeGames.has(message.author.id)) {
      const embed = await errorEmbed(message.guild.id, 'Game In Progress',
        `${GLYPHS.ERROR} You already have an active Blackjack game! Finish it first.`
      );
      return message.reply({ embeds: [embed] });
    }

    // Parse bet amount
    let bet = parseInt(args[0]);
    if (!args[0]) {
      const embed = await errorEmbed(message.guild.id, 'Missing Bet',
        `${GLYPHS.ERROR} Please specify a bet amount!\n\n**Usage:** \`${prefix}blackjack <amount>\`\n**Example:** \`${prefix}blackjack 100\``
      );
      return message.reply({ embeds: [embed] });
    }

    // Handle 'all' bet
    const economy = await Economy.getEconomy(message.author.id, message.guild.id);
    if (args[0].toLowerCase() === 'all' || args[0].toLowerCase() === 'max') {
      bet = economy.coins;
    }

    if (isNaN(bet) || bet <= 0) {
      const embed = await errorEmbed(message.guild.id, 'Invalid Bet',
        `${GLYPHS.ERROR} Please enter a valid bet amount!`
      );
      return message.reply({ embeds: [embed] });
    }

    // Check balance
    if (economy.coins < bet) {
      const embed = await errorEmbed(message.guild.id, 'Insufficient Funds',
        `${GLYPHS.ERROR} You don't have enough ${currencyName}!\n\n**Your Balance:** ${formatNumber(economy.coins)} ${currencyName}\n**Bet Amount:** ${formatNumber(bet)} ${currencyName}`
      );
      return message.reply({ embeds: [embed] });
    }

    // Deduct bet
    await economy.addCoins(-bet);

    // Create game
    const deck = createDeck();
    const game = {
      odId: message.author.id,
      odName: message.author.username,
      playerName: message.author.username,
      bet,
      originalBet: bet,
      deck,
      playerHand: [deck.pop(), deck.pop()],
      dealerHand: [deck.pop(), deck.pop()],
      doubled: false,
      cardEmojis: await getCardEmojis(client)
    };

    activeGames.set(message.author.id, game);

    // Check for natural blackjack
    const playerValue = calculateHand(game.playerHand);
    const dealerValue = calculateHand(game.dealerHand);

    if (playerValue === 21) {
      // Natural blackjack!
      if (dealerValue === 21) {
        // Both have blackjack - push
        const embed = await endGame(game, message, guildConfig, 'push');
        return message.reply({ embeds: [embed] });
      } else {
        // Player wins with blackjack
        const embed = await endGame(game, message, guildConfig, 'blackjack');
        return message.reply({ embeds: [embed] });
      }
    }

    // Create initial game embed
    const embed = createGameEmbed(game, guildConfig);
    embed.setDescription(`${GLYPHS.INFO} **Hit** to draw a card, **Stand** to hold, or **Double Down** to double your bet and draw one card.`);

    // Check if player can double down
    const canDouble = economy.coins >= bet && game.playerHand.length === 2;
    const buttons = new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId('blackjack_hit')
          .setLabel('Hit')
          .setStyle(ButtonStyle.Primary)
          .setEmoji('🎴'),
        new ButtonBuilder()
          .setCustomId('blackjack_stand')
          .setLabel('Stand')
          .setStyle(ButtonStyle.Secondary)
          .setEmoji('✋'),
        new ButtonBuilder()
          .setCustomId('blackjack_double')
          .setLabel('Double Down')
          .setStyle(ButtonStyle.Success)
          .setEmoji('💰')
          .setDisabled(!canDouble)
      );

    const gameMessage = await message.reply({ embeds: [embed], components: [buttons] });

    // Create button collector
    const collector = gameMessage.createMessageComponentCollector({
      filter: i => i.user.id === message.author.id && i.customId.startsWith('blackjack_'),
      time: 60000 // 1 minute timeout
    });

    collector.on('collect', async (interaction) => {
      const game = activeGames.get(message.author.id);
      if (!game) {
        await interaction.update({ components: [] });
        return;
      }

      const economy = await Economy.getEconomy(message.author.id, message.guild.id);

      switch (interaction.customId) {
        case 'blackjack_hit':
          // Draw a card
          game.playerHand.push(game.deck.pop());
          const hitValue = calculateHand(game.playerHand);

          if (hitValue > 21) {
            // Bust!
            const bustEmbed = await endGame(game, message, guildConfig, 'bust');
            await interaction.update({ embeds: [bustEmbed], components: [] });
            collector.stop();
          } else if (hitValue === 21) {
            // Auto-stand on 21
            await dealerPlay(game);
            const dealerFinal = calculateHand(game.dealerHand);

            let result;
            if (dealerFinal > 21) result = 'dealer_bust';
            else if (dealerFinal === 21) result = 'push';
            else result = 'win';

            const standEmbed = await endGame(game, message, guildConfig, result);
            await interaction.update({ embeds: [standEmbed], components: [] });
            collector.stop();
          } else {
            // Continue game
            const gameEmbed = createGameEmbed(game, guildConfig);
            gameEmbed.setDescription(`${GLYPHS.INFO} You drew ${cardEmoji(game.playerHand[game.playerHand.length - 1], game.cardEmojis)}`);

            // Disable double down after first hit
            const newButtons = new ActionRowBuilder()
              .addComponents(
                new ButtonBuilder()
                  .setCustomId('blackjack_hit')
                  .setLabel('Hit')
                  .setStyle(ButtonStyle.Primary)
                  .setEmoji('🎴'),
                new ButtonBuilder()
                  .setCustomId('blackjack_stand')
                  .setLabel('Stand')
                  .setStyle(ButtonStyle.Secondary)
                  .setEmoji('✋'),
                new ButtonBuilder()
                  .setCustomId('blackjack_double')
                  .setLabel('Double Down')
                  .setStyle(ButtonStyle.Success)
                  .setEmoji('💰')
                  .setDisabled(true)
              );

            await interaction.update({ embeds: [gameEmbed], components: [newButtons] });
          }
          break;

        case 'blackjack_stand':
          // Dealer plays
          await dealerPlay(game);
          const dealerValue = calculateHand(game.dealerHand);
          const playerValue = calculateHand(game.playerHand);

          let result;
          if (dealerValue > 21) result = 'dealer_bust';
          else if (dealerValue > playerValue) result = 'lose';
          else if (playerValue > dealerValue) result = 'win';
          else result = 'push';

          const standEmbed = await endGame(game, message, guildConfig, result);
          await interaction.update({ embeds: [standEmbed], components: [] });
          collector.stop();
          break;

        case 'blackjack_double':
          // Double down - double bet, draw one card, then stand
          if (economy.coins < game.originalBet) {
            await interaction.reply({ content: `${GLYPHS.ERROR} You don't have enough ${currencyName} to double down!`, ephemeral: true });
            return;
          }

          // Deduct additional bet
          await economy.addCoins(-game.originalBet);
          game.bet = game.bet * 2;
          game.doubled = true;

          // Draw one card
          game.playerHand.push(game.deck.pop());
          const doubleValue = calculateHand(game.playerHand);

          if (doubleValue > 21) {
            // Bust!
            const bustEmbed = await endGame(game, message, guildConfig, 'bust');
            await interaction.update({ embeds: [bustEmbed], components: [] });
          } else {
            // Dealer plays
            await dealerPlay(game);
            const dealerFinal = calculateHand(game.dealerHand);

            let doubleResult;
            if (dealerFinal > 21) doubleResult = 'dealer_bust';
            else if (dealerFinal > doubleValue) doubleResult = 'lose';
            else if (doubleValue > dealerFinal) doubleResult = 'win';
            else doubleResult = 'push';

            const doubleEmbed = await endGame(game, message, guildConfig, doubleResult);
            doubleEmbed.setDescription(doubleEmbed.data.description + `\n\n📈 You doubled down!`);
            await interaction.update({ embeds: [doubleEmbed], components: [] });
          }
          collector.stop();
          break;
      }
    });

    collector.on('end', async (collected, reason) => {
      if (reason === 'time') {
        const game = activeGames.get(message.author.id);
        if (game) {
          activeGames.delete(message.author.id);
          // Refund bet on timeout
          const economy = await Economy.getEconomy(message.author.id, message.guild.id);
          await economy.addCoins(game.bet);

          const timeoutEmbed = new EmbedBuilder()
            .setTitle('🃏 Blackjack - Timed Out')
            .setColor('#FF0000')
            .setDescription(`⏰ Game timed out! Your bet of **${formatNumber(game.bet)}** ${currencyName} has been refunded.`);

          try {
            await gameMessage.edit({ embeds: [timeoutEmbed], components: [] });
          } catch (e) {
            // Message might be deleted
          }
        }
      }
    });
  }
};
