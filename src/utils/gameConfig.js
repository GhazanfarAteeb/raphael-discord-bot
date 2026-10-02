// Adventure NPCs - Customize this list as needed
export const ADVENTURE_NPCS = [
    'Mystic Merchant',
    'Ancient Guardian',
    'Friendly Dragon',
    'Lost Wanderer',
    'Legendary Knight',
    'Forest Spirit',
    'Desert Nomad',
    'Mountain Sage',
    'Ocean Keeper',
    'Sky Dancer',
    'Shadow Thief',
    'Noble Lord',
    'Wise Wizard',
    'Battle Master',
    'Crystal Keeper'
];

// Adventure rewards (min and max coins)
export const ADVENTURE_REWARDS = {
    min: 50,
    max: 500
};

// Adventure cooldown (in seconds)
export const ADVENTURE_COOLDOWN = 3600; // 1 hour

// Random adventure outcomes
export const ADVENTURE_MESSAGES = [
    'went on a mysterious adventure and returned safely',
    'explored a dangerous dungeon and made it out alive',
    'helped a stranger and was rewarded',
    'discovered a hidden treasure',
    'completed a challenging quest',
    'saved a village from danger',
    'won a mysterious game of chance',
    'found a rare artifact and sold it',
    'helped defeat a monster',
    'solved an ancient puzzle'
];

// Reputation settings
export const REPUTATION_COOLDOWN = 86400; // 24 hours per user
export const REPUTATION_AMOUNT = 1; // +1 rep per give

// Mini game settings
export const COINFLIP_MIN = 10;
export const COINFLIP_MAX = 10000;

// Blackjack bet limits ('all'/'max' bet up to BLACKJACK_MAX)
export const BLACKJACK_MIN = 10;
export const BLACKJACK_MAX = 10000;

export const SLOTS_MIN = 10;
export const SLOTS_MAX = 5000;
export const SLOTS_EMOJIS = ['🍒', '🍋', '🍊', '🍉', '💎', '7️⃣', '🔔'];

export const DICE_MIN = 10;
export const DICE_MAX = 1000;

export const ROULETTE_MIN = 10;
export const ROULETTE_MAX = 5000;

// Roulette payouts: total returned per coin wagered, stake included (single-zero wheel)
export const ROULETTE_PAYOUTS = {
    color: 2,     // red/black, 1:1
    straight: 36  // a single number, including green (0), 35:1
};

// Trivia: coins per correct answer (inclusive), paid at most once per cooldown per member
export const TRIVIA_REWARD = {
    min: 50,
    max: 150
};
export const TRIVIA_REWARD_COOLDOWN = 60; // seconds

// Marriage proposals expire after this long (seconds)
export const MARRIAGE_PROPOSAL_TIMEOUT = 60;

// Default coin emoji (can be customized per server)
export const DEFAULT_COIN_EMOJI = '💰';
export const DEFAULT_COIN_NAME = 'coins';
