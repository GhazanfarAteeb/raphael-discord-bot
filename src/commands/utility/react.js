import { EmbedBuilder } from 'discord.js';
import logger from '../../utils/logger.js';
import { getPrefix, escapeMarkdown, truncate } from '../../utils/helpers.js';
import { COLORS, errorEmbed, infoEmbed, warningEmbed } from '../../utils/embeds.js';
import { getRandomFooter } from '../../utils/raphael.js';

// Per-endpoint request timeout, so one slow GIF API cannot stall the command
const FETCH_TIMEOUT_MS = 8000;

const reactions = {
  // Positive reactions
  hug: {
    queries: ['hug'],
    endpoints: ['otaku', 'rndm', 'kawaii', 'nekos'],
    kawaiiEndpoint: 'hug',
    nekosEndpoint: 'hug',
    titles: ['Warm Hugs Incoming!', 'Hug Attack!', 'Spreading the Love!', 'Cuddle Mode: Activated!', 'Virtual Hugs!', 'Bear Hug Time!', 'Group Hug Energy!', 'Sending Warm Vibes!']
  },
  kiss: {
    queries: ['kiss', 'airkiss'],
    endpoints: ['otaku', 'rndm', 'kawaii', 'nekos'],
    kawaiiEndpoint: 'kiss',
    nekosEndpoint: 'kiss',
    titles: ['Smooch Alert!', 'Kiss Kiss!', 'Love is in the Air!', 'Mwah!', 'Kissing Spree!', 'Sweet Kiss!', 'Blown Kisses!', 'Romantic Moment!']
  },
  pat: {
    queries: ['pat'],
    endpoints: ['otaku', 'rndm', 'kawaii', 'nekos'],
    kawaiiEndpoint: 'pat',
    nekosEndpoint: 'pat',
    titles: ['Good Job! *pat pat*', 'Head Pats for Days!', 'You Deserve This! *pat*', 'Pat Pat Time!', 'Gentle Pats!', 'Encouraging Pats!', '*pats gently*', 'Proud of You! *pats*']
  },
  cuddle: {
    queries: ['cuddle'],
    endpoints: ['otaku', 'rndm', 'kawaii', 'nekos'],
    kawaiiEndpoint: 'cuddle',
    nekosEndpoint: 'cuddle',
    titles: ['Cuddle Puddle Time!', 'Maximum Comfy Mode!', 'Snuggle Party!', 'Warm & Fuzzy!', 'Cozy Cuddles!', 'Comfort Zone Activated!', 'Snug Life!', 'Ultimate Cuddle Session!']
  },
  highfive: {
    queries: ['brofist', 'clap'],
    endpoints: ['otaku', 'kawaii', 'nekos'],
    kawaiiEndpoint: 'highfive',
    nekosEndpoint: 'highfive',
    titles: ['Up Top!', 'High Five Energy!', 'Slap Hands!', 'Yeah! *high five*', 'Epic High Five!', 'Hand Slap Success!', 'Celebration High Five!', 'Perfect Sync!']
  },
  wave: {
    queries: ['wave'],
    endpoints: ['otaku', 'kawaii', 'nekos'],
    kawaiiEndpoint: 'wave',
    nekosEndpoint: 'wave',
    titles: ['Hellooo!', 'Wave Squad!', '*waves enthusiastically*', 'Greetings!', 'Friendly Wave!', 'Hey There!', 'Big Wave Energy!', 'Waving Back!']
  },
  smile: {
    queries: ['smile'],
    endpoints: ['otaku', 'kawaii', 'nekos'],
    kawaiiEndpoint: 'smile',
    nekosEndpoint: 'smile',
    titles: ['Smile Time!', 'Happiness Overload!', 'Grinning!', 'Wholesome Vibes!', 'Beaming with Joy!', 'Radiant Smile!', 'Smiling Ear to Ear!', 'Pure Happiness!']
  },
  blush: {
    queries: ['blush'],
    endpoints: ['otaku', 'kawaii', 'nekos'],
    kawaiiEndpoint: 'blush',
    nekosEndpoint: 'blush',
    titles: ['So Flustered!', 'Blushing Hard! >///<', 'Aww Shucks!', 'Getting All Red!', 'Shy Mode Activated!', 'Blushing Intensifies!', 'Face Red Alert!', 'Embarrassed Cuteness!']
  },
  love: {
    queries: ['love'],
    endpoints: ['otaku', 'kawaii'],
    kawaiiEndpoint: 'love',
    titles: ['Love Struck!', 'Heart Eyes!', 'Falling Hard!', 'Cupid Strikes!', 'Love Overload!', 'Smitten!', 'Hearts Everywhere!', 'Love at First Sight!']
  },
  headpat: {
    queries: ['pat'],
    endpoints: ['otaku', 'rndm', 'kawaii', 'nekos'],
    kawaiiEndpoint: 'pat',
    nekosEndpoint: 'pat',
    titles: ['*pat pat pat*', 'You\'re Doing Great!', 'Good Human! *pats*', 'Headpat Combo!', 'Infinite Headpats!', 'Supreme Headpat!', 'Legendary Pats!', 'Headpat Heaven!']
  },

  // Fun reactions
  dance: {
    queries: ['dance'],
    endpoints: ['otaku', 'rndm', 'kawaii', 'nekos'],
    kawaiiEndpoint: 'dance',
    nekosEndpoint: 'dance',
    titles: ['Dance Party!', 'Busting Moves!', 'Groove Time!', 'Dance Like Nobody\'s Watching!', 'Dancing Queen!', 'Rhythm Master!', 'Dance Floor Domination!', 'Let\'s Boogie!']
  },
  celebrate: {
    queries: ['celebrate', 'yay'],
    endpoints: ['otaku'],
    titles: ['Party Time!', 'Let\'s Celebrate!', 'Woohoo!', 'Victory Dance!', 'Celebration Mode!', 'Time to Party!', 'Winner Winner!', 'Festive Vibes!']
  },
  laugh: {
    queries: ['laugh'],
    endpoints: ['otaku', 'rndm', 'kawaii', 'nekos'],
    kawaiiEndpoint: 'laugh',
    nekosEndpoint: 'laugh',
    titles: ['HAHAHA!', 'Can\'t Stop Laughing!', 'Too Funny!', 'LOL Moment!', 'Dying of Laughter!', 'Cracking Up!', 'Giggle Fest!', 'Comedy Gold!']
  },
  cry: {
    queries: ['cry', 'sad'],
    endpoints: ['otaku', 'kawaii', 'nekos'],
    kawaiiEndpoint: 'cry',
    nekosEndpoint: 'cry',
    titles: ['The Tears!', 'Waterworks!', 'Big Sad Energy...', 'Need Tissues!', 'Crying Rivers!', 'Emotional Breakdown!', 'Tear Fountain!', 'Sad Hours...']
  },
  poke: {
    queries: ['poke'],
    endpoints: ['otaku', 'rndm', 'kawaii', 'nekos'],
    kawaiiEndpoint: 'poke',
    nekosEndpoint: 'poke',
    titles: ['Poke! *boop*', 'Poke Poke!', 'Gotcha! *pokes*', 'Boop the Snoot!', 'Poke War!', 'Annoying Pokes!', 'Poke Combo!', 'Surprise Poke!']
  },
  bonk: {
    queries: ['smack', 'punch'],
    endpoints: ['otaku'],
    titles: ['BONK!', 'Go to Horny Jail!', '*bonks* No!', 'Bonk Attack!', 'Critical Bonk!', 'Bonk Incoming!', 'Mega Bonk!', 'Bonked to Oblivion!']
  },
  nom: {
    queries: ['nom', 'bite'],
    endpoints: ['otaku', 'rndm', 'nekos'],
    nekosEndpoint: 'nom',
    titles: ['Nom Nom Nom!', 'Munch Time!', 'Tasty!', 'Food Coma Incoming!', 'Delicious!', 'Eating Everything!', 'Foodie Mode!', 'Can\'t Stop Eating!']
  },
  bread: {
    queries: ['bread'],
    endpoints: ['rndm'],
    titles: ['Bread Time!', 'Nom Nom Bread!', 'Carb Loading!', 'Fresh Baked!', 'Bread Love!', 'Gluten Heaven!', 'Bread Obsessed!', 'Loaf Life!']
  },
  chocolate: {
    queries: ['chocolate'],
    endpoints: ['rndm'],
    titles: ['Chocolate Time!', 'Sweet Tooth!', 'Choco Addict!', 'Cocoa Heaven!', 'Chocolate Bliss!', 'Sugar Rush!', 'Chocoholic!', 'Dessert Mode!']
  },
  cookie: {
    queries: ['cookie'],
    endpoints: ['rndm'],
    titles: ['Cookie Time!', 'Om Nom Cookies!', 'Cookie Monster!', 'Sweet Treat!', 'Cookie Heaven!', 'Baked Goods!', 'Cookie Jar Raid!', 'Crumbs Everywhere!']
  },
  wink: {
    queries: ['wink'],
    endpoints: ['otaku', 'kawaii', 'nekos'],
    kawaiiEndpoint: 'wink',
    nekosEndpoint: 'wink',
    titles: ['*wink wink*', 'Smooth!', 'Wink Attack!', 'You Know It!', 'Sly Wink!', 'Charming Wink!', 'Sneaky Wink!', 'Flirty Wink!']
  },
  thumbsup: {
    queries: ['thumbsup'],
    endpoints: ['otaku', 'nekos'],
    nekosEndpoint: 'thumbsup',
    titles: ['Nicely Done!', 'Approved!', 'You Got This!', 'Great Work!', 'Excellent!', 'Perfect Score!', 'Amazing Job!', 'You\'re the Best!']
  },
  salute: {
    queries: ['yes'],
    endpoints: ['otaku', 'kawaii'],
    kawaiiEndpoint: 'salute',
    titles: ['Yes Sir! o7', 'Salute!', 'Respect!', 'Roger That!', 'At Your Service!', 'Honored!', 'Reporting for Duty!', 'Soldier On!']
  },

  // Negative reactions
  slap: {
    queries: ['slap'],
    endpoints: ['otaku', 'rndm', 'kawaii', 'nekos'],
    kawaiiEndpoint: 'slap',
    nekosEndpoint: 'slap',
    titles: ['*SLAP!*', 'Ouch! That Hurts!', 'Take That!', 'Slap Delivered!', 'Face Slap!', 'Reality Check!', 'Slap of Justice!', 'Wake Up Call!']
  },
  punch: {
    queries: ['punch'],
    endpoints: ['otaku', 'rndm', 'kawaii', 'nekos'],
    kawaiiEndpoint: 'punch',
    nekosEndpoint: 'punch',
    titles: ['POW! Right in the Kisser!', 'Falcon PUNCH!', 'Taste My Fist!', 'K.O.!', 'One Punch!', 'Critical Hit!', 'Knockout Blow!', 'Fist of Fury!']
  },
  kick: {
    queries: ['kick'],
    endpoints: ['rndm', 'nekos'],
    nekosEndpoint: 'kick',
    titles: ['YEET!', 'Kicked to the Curb!', 'Sparta Kick!', 'Boot to the Head!', 'Flying Kick!', 'Roundhouse!', 'Kick Attack!', 'Sent Flying!']
  },
  angry: {
    queries: ['angry'],
    endpoints: ['rndm', 'nekos'],
    nekosEndpoint: 'angry',
    titles: ['Big Mad!', 'Rage Mode!', 'Not Happy!', 'Fuming!', 'Angry Face!', 'Grumpy!', 'Irritated!', 'Furious!']
  },
  rage: {
    queries: ['mad', 'shout'],
    endpoints: ['otaku'],
    titles: ['MAXIMUM RAGE!', 'Seeing Red!', 'AAAARGH!', 'Anger Levels: MAX!']
  },
  stab: {
    queries: ['punch', 'smack'],
    endpoints: ['otaku'],
    titles: ['Stabby Stabby!', 'Yandere Mode!', 'Dangerous!', 'Knife-kun Says Hi!']
  },
  spank: {
    queries: ['spank'],
    endpoints: ['rndm'],
    titles: ['*SPANK!*', 'Naughty!', 'Spanking Time!', 'Bad Behavior!', 'Punishment!', 'Spank Attack!', 'Discipline!', 'Booty Slap!']
  },
  spit: {
    queries: ['spit'],
    endpoints: ['rndm'],
    titles: ['*SPIT!*', 'Gross!', 'Spitting Mad!', 'Disgusted!', 'Ptooey!', 'Disrespect!', 'Spit Take!', 'Rejection!']
  },
  steal: {
    queries: ['steal'],
    endpoints: ['rndm'],
    titles: ['Yoink!', 'Stealing!', 'Mine Now!', 'Thief Mode!', 'Sneaky Steal!', 'Got Your Stuff!', 'Kleptomaniac!', 'Stolen!']
  },
  bite: {
    queries: ['bite', 'nom'],
    endpoints: ['otaku', 'rndm', 'kawaii', 'nekos'],
    kawaiiEndpoint: 'bite',
    nekosEndpoint: 'bite',
    titles: ['Chomp!', 'Bite Attack!', 'Nom... Wait, OW!', 'Vampire Mode!']
  },

  // Misc
  think: {
    queries: ['confused', 'huh'],
    endpoints: ["otaku", "nekos"],
    nekosEndpoint: 'think',
    titles: ['Hmm...', 'Big Brain Time!', 'Thinking Hard!', 'Processing...']
  },
  bored: {
    queries: ['bored'],
    endpoints: ['rndm', 'nekos'],
    nekosEndpoint: 'bored',
    titles: ['So Bored...', 'Nothing to Do!', 'Boredom Strikes!', 'Ugh, Boring!', 'Yawn Fest!', 'Need Entertainment!', 'Tedious!', 'Dullsville!']
  },
  drunk: {
    queries: ['drunk'],
    endpoints: ['rndm'],
    titles: ['Drunk Mode!', 'Too Much Sake!', 'Tipsy!', 'Wasted!', 'Intoxicated!', 'Had Too Many!', 'Drunk Vibes!', 'Party Too Hard!']
  },
  shrug: {
    queries: ['shrug'],
    endpoints: ["otaku", "kawaii", "nekos"],
    kawaiiEndpoint: 'shrug',
    nekosEndpoint: 'shrug',
    // Escaped so Discord markdown keeps the backslash and the underscores
    titles: ['¯\\\\\\_(ツ)\\_/¯', 'I Dunno!', 'Not My Problem!', 'Whatever!']
  },
  sleep: {
    queries: ['sleep'],
    endpoints: ["otaku", "rndm", "kawaii", "nekos"],
    kawaiiEndpoint: 'sleepy',
    nekosEndpoint: 'sleep',
    titles: ['Zzz...', 'Nap Time!', 'Gone to Dreamland!', 'Sleep Mode: ON']
  },
  yawn: {
    queries: ['yawn', 'tired'],
    endpoints: ["otaku", "nekos"],
    nekosEndpoint: 'yawn',
    titles: ['*yawns* So Tired...', 'Need Coffee!', 'Sleepy Vibes!', 'Big Yawn Energy!']
  },
  confused: {
    queries: ['confused'],
    endpoints: ["otaku", "kawaii"],
    kawaiiEndpoint: 'confused',
    titles: ['So Confused!', 'What?', 'Brain.exe Stopped!', 'Confused Screaming!']
  },
  facepalm: {
    queries: ['facepalm'],
    endpoints: ["otaku", "kawaii", "nekos"],
    kawaiiEndpoint: 'facepalm',
    nekosEndpoint: 'facepalm',
    titles: ['*facepalm*', 'Seriously?', 'I Can\'t Even...', 'Done with This!']
  },
  nervous: {
    queries: ['nervous', 'sweat'],
    endpoints: ["otaku"],
    titles: ['Nervous Sweating!', 'Uh Oh...', 'Anxious Vibes!', 'Help!']
  },
  excited: {
    queries: ['happy', 'yay'],
    endpoints: ["otaku"],
    titles: ['SO EXCITED!', 'Hype!', 'Can\'t Contain It!', 'Bouncing Off Walls!']
  },
  shocked: {
    queries: ['surprised', 'woah'],
    endpoints: ["otaku", "kawaii"],
    kawaiiEndpoint: 'shocked',
    titles: ['WHAT?!', 'Mind Blown!', 'No Way!', 'Jaw Drop!']
  },
  smug: {
    queries: ['smug'],
    endpoints: ["otaku", "kawaii", "nekos"],
    kawaiiEndpoint: 'smug',
    nekosEndpoint: 'smug',
    titles: ['Feeling Smug!', 'I Told You So!', 'Smugness Overload!', 'Too Cool!']
  },

  // More owo-style reactions
  lick: {
    queries: ['lick'],
    endpoints: ["otaku", "rndm", "kawaii"],
    kawaiiEndpoint: 'lick',
    titles: ['*lick*', 'Sloppy Kiss!', 'bleh!', 'Taste Test!']
  },
  boop: {
    queries: ['poke'],
    endpoints: ["otaku", "rndm", "kawaii"],
    kawaiiEndpoint: 'boop',
    titles: ['Boop! *boops nose*', 'Boop the Snoot!', 'Beep Boop!', '*boops* Gotcha!']
  },
  greet: {
    queries: ['wave'],
    endpoints: ["otaku"],
    titles: ['Hey There!', 'Greetings Friend!', 'What\'s Up!', 'Hello Hello!']
  },
  handholding: {
    queries: ['handhold'],
    endpoints: ["otaku"],
    titles: ['Hand Holding!', 'So Lewd!', 'Holding Hands!', 'Together!']
  },
  tickle: {
    queries: ['tickle'],
    endpoints: ['otaku', 'rndm', 'kawaii', 'nekos'],
    kawaiiEndpoint: 'tickle',
    nekosEndpoint: 'tickle',
    titles: ['Tickle Attack!', 'Tickle Tickle!', 'Can\'t Stop Laughing!', 'Tickle Monster!']
  },
  kill: {
    queries: ['kill'],
    endpoints: ['rndm', 'kawaii'],
    kawaiiEndpoint: 'kill',
    titles: ['Omae Wa Mou...', 'Nothing Personal Kid!', 'Fatality!', 'You\'re Already Dead!']
  },
  lonely: {
    queries: ['lonely'],
    endpoints: ['rndm', 'kawaii'],
    kawaiiEndpoint: 'lonely',
    titles: ['So Lonely...', 'Forever Alone...', 'Need Company!', 'Feeling Isolated...', 'Lonely Vibes...', 'All By Myself...', 'Missing You...', 'Solitude Mode...']
  },
  hold: {
    queries: ['hug', 'cuddle'],
    endpoints: ["otaku", "rndm"],
    titles: ['Holding You!', 'Safe in My Arms!', 'Got You!', 'Hold Tight!']
  },
  pats: {
    queries: ['pat'],
    endpoints: ["otaku", "rndm"],
    titles: ['Pat Pat Pat!', 'All the Pats!', 'Unlimited Pats!', 'Pat Overload!']
  },
  snuggle: {
    queries: ['cuddle', 'hug'],
    endpoints: ["otaku", "rndm"],
    titles: ['Snuggle Time!', 'So Cozy!', 'Snug as a Bug!', 'Maximum Snuggles!']
  },
  bully: {
    queries: ['punch', 'smack', 'slap'],
    endpoints: ["otaku"],
    titles: ['Bully Mode!', 'Get Rekt!', 'Gottem!', 'Too Easy!']
  },
  stare: {
    queries: ['stare'],
    endpoints: ["otaku", "kawaii", "nekos"],
    kawaiiEndpoint: 'stare',
    nekosEndpoint: 'stare',
    titles: ['Staring Intensely!', '*stares*', 'The Stare Down!', 'What You Looking At?']
  },
  pout: {
    queries: ['pout'],
    endpoints: ["otaku", "kawaii", "nekos"],
    kawaiiEndpoint: 'pout',
    nekosEndpoint: 'pout',
    titles: ['*pouts*', 'Hmph!', 'Not Fair!', 'Pouting Face!']
  },
  lewd: {
    queries: ['lick', 'nosebleed', 'blush'],
    endpoints: ["otaku"],
    titles: ['Too Lewd!', 'How Scandalous!', 'Inappropriate! >///<', 'NSFW Alert!']
  },
  triggered: {
    queries: ['mad', 'pout', 'shout'],
    endpoints: ["otaku", "kawaii"],
    kawaiiEndpoint: 'triggered',
    titles: ['TRIGGERED!', 'Activating Rage!', 'Mad Mad Mad!', 'Triggering Intensifies!']
  },
  smirk: {
    queries: ['smug'],
    endpoints: ["otaku"],
    titles: ['*smirks*', 'Sly Fox!', 'Clever Girl!', 'Up to Something!']
  },
  happy: {
    queries: ['happy'],
    endpoints: ["otaku", "rndm", "kawaii", "nekos"],
    kawaiiEndpoint: 'happy',
    nekosEndpoint: 'happy',
    titles: ['So Happy!', 'Pure Joy!', 'Happiness!', 'Feeling Great!']
  },
  thumbs: {
    queries: ['thumbsup'],
    endpoints: ["otaku"],
    titles: ['Thumbs Up!', 'Double Approval!', 'You Rock!', 'Awesome!']
  },
  wag: {
    queries: ['happy', 'dance'],
    endpoints: ["otaku", "rndm"],
    titles: ['*wags tail*', 'Happy Puppy!', 'Tail Wag!', 'So Excited!']
  },
  teehee: {
    queries: ['laugh', 'smile'],
    endpoints: ["otaku"],
    titles: ['Teehee!', 'Giggling!', 'Hehe!', 'Cute Laugh!']
  },
  scoff: {
    queries: ['shrug', 'smug'],
    endpoints: ["otaku"],
    titles: ['*scoffs*', 'As If!', 'Whatever!', 'Pfft!']
  },
  grin: {
    queries: ['smile', 'smug'],
    endpoints: ["otaku"],
    titles: ['Big Grin!', 'Grinning!', 'Cheese!', 'Smile Wide!']
  },
  sleepy: {
    queries: ['tired', 'yawn', 'sleep'],
    endpoints: ["otaku"],
    titles: ['So Sleepy...', 'Tired Mode!', 'Need Sleep!', 'Energy Low!']
  },
  thonking: {
    queries: ['confused', 'huh'],
    endpoints: ["otaku"],
    titles: ['Thonking...', 'Hmmmm!', 'Deep Thoughts!', 'Contemplating!']
  },
  triggered2: {
    queries: ['mad', 'shout', 'pout'],
    endpoints: ["otaku"],
    titles: ['REEEEE!', 'Anger!', 'Mad Lad!', 'Furious!']
  },

  // Physical interactions
  push: {
    queries: ['punch', 'smack'],
    endpoints: ["otaku"],
    titles: ['*PUSH!*', 'YEET! Out the Way!', 'Outta My Way!', 'Down You Go!']
  },

  tackle: {
    queries: ['hug'],
    endpoints: ["otaku", "rndm"],
    titles: ['Tackle Hug!', 'INCOMING!', 'Flying Tackle!', 'Gotcha!']
  },
  throw: {
    queries: ['punch', 'smack'],
    endpoints: ["otaku", "rndm"],
    titles: ['YEET!', 'Going Flying!', 'Toss Time!', 'Launching!']
  },
  grab: {
    queries: ['hug'],
    endpoints: ["otaku", "rndm"],
    titles: ['Got You!', 'Grab!', 'Come Here!', 'Gotcha!']
  },

  // Personality reactions (anime dere types)
  tsundere: {
    queries: ['pout', 'blush'],
    endpoints: ["otaku"],
    titles: ['I-It\'s Not Like I Like You!', 'B-Baka! >///<', 'Tsundere Mode!', 'Hmph! Don\'t Get the Wrong Idea!']
  },
  deredere: {
    queries: ['love', 'happy'],
    endpoints: ["otaku"],
    titles: ['So Much Love!', 'Lovey Dovey!', 'Adorable!', 'Pure Sweetness!']
  },
  yandere: {
    queries: ['stare', 'love'],
    endpoints: ["otaku"],
    titles: ['Mine Forever!', 'Nobody Else!', 'Obsessed!', 'You\'re Not Going Anywhere!']
  },
  kuudere: {
    queries: ['stare', 'cool'],
    endpoints: ["otaku"],
    titles: ['Cool & Collected...', 'Emotionless Stare...', 'Whatever...', 'Not Interested...']
  },
  dandere: {
    queries: ['shy', 'blush'],
    endpoints: ["otaku"],
    titles: ['S-So Shy...', 'Too Nervous!', '*hides*', 'Quiet Mode...']
  },

  // More fun actions
  run: {
    queries: ['run'],
    endpoints: ["otaku", "rndm", "kawaii", "nekos"],
    kawaiiEndpoint: 'run',
    nekosEndpoint: 'run',
    titles: ['Running Away!', 'Gotta Go Fast!', 'Escape!', 'Nope! *runs*']
  },
  chase: {
    queries: ['run'],
    endpoints: ["otaku", "rndm", "kawaii", "nekos"],
    kawaiiEndpoint: 'run',
    nekosEndpoint: 'run',
    titles: ['Get Back Here!', 'Chasing You!', 'Can\'t Escape!', 'Pursuit!']
  },
  feed: {
    queries: ['nom'],
    endpoints: ["otaku", "rndm", "nekos"],
    nekosEndpoint: 'feed',
    titles: ['Say Ahh!', 'Feeding Time!', 'Open Wide!', 'Nom Time!']
  },
  piggyback: {
    queries: ['hug'],
    endpoints: ["otaku", "rndm"],
    titles: ['Piggyback Ride!', 'Hop On!', 'Carrying You!', 'Up We Go!']
  },
  nosebleed: {
    queries: ['nosebleed'],
    endpoints: ["otaku", "kawaii"],
    kawaiiEndpoint: 'nosebleed',
    titles: ['NOSEBLEED!', 'Too Hot!', 'Can\'t Handle It!', 'Blood Fountain!']
  },
  faint: {
    queries: ['tired', 'sleep'],
    endpoints: ["otaku"],
    titles: ['*faints*', 'Passed Out!', 'Too Much!', 'Gone!']
  },
  nod: {
    queries: ['yes'],
    endpoints: ["otaku", "nekos"],
    nekosEndpoint: 'nod',
    titles: ['*nods*', 'Yep!', 'Agreed!', 'Understood!']
  },
  peek: {
    queries: ['peek'],
    endpoints: ["otaku", "kawaii"],
    kawaiiEndpoint: 'peek',
    titles: ['*peeks*', 'Peekaboo!', 'Sneaky Look!', 'What\'s This?']
  },
  spin: {
    queries: ['roll', 'dance'],
    endpoints: ["otaku", "kawaii"],
    kawaiiEndpoint: 'spin',
    titles: ['Spinning!', 'Round and Round!', 'Wheee!', 'Tornado Mode!']
  },
  trip: {
    queries: ['surprised', 'woah'],
    endpoints: ["otaku"],
    titles: ['*trips*', 'Whoops!', 'Falling!', 'Clumsy!']
  },
  headbutt: {
    queries: ['smack', 'punch'],
    endpoints: ["otaku"],
    titles: ['BONK! Head Clash!', 'Headbutt!', 'Skull Bash!', 'Ouch!']
  },
  lurk: {
    queries: ['peek', 'stare'],
    endpoints: ["otaku", "kawaii", "nekos"],
    kawaiiEndpoint: 'stare',
    nekosEndpoint: 'lurk',
    titles: ['Lurking...', 'In the Shadows...', 'Watching...', 'Stalker Mode!']
  },
  spray: {
    queries: ['smack'],
    endpoints: ["otaku"],
    titles: ['Spray Bottle!', 'Bad! *spray spray*', 'Squirt!', 'Cooling Off!']
  },
  flirt: {
    queries: ['wink', 'kiss'],
    endpoints: ["otaku"],
    titles: ['Smooth Talker!', 'Flirty!', 'Charming!', 'Hey There~']
  },
  nuzzle: {
    queries: ['nuzzle'],
    endpoints: ["otaku"],
    titles: ['*nuzzles*', 'Snuggle Snuggle!', 'Cute!', 'Rubbing Noses!']
  },
  bleh: {
    queries: ['bleh'],
    endpoints: ["otaku"],
    titles: ['bleh!', 'Tongue Out!', 'Derp!', 'Silly Face!']
  },
  carry: {
    queries: ['hug'],
    endpoints: ["otaku", "rndm"],
    titles: ['Princess Carry!', 'In My Arms!', 'Carrying You!', 'Bridal Style!']
  },

  // Additional API reactions
  airkiss: {
    queries: ['airkiss', 'kiss'],
    endpoints: ["otaku"],
    titles: ['Sending Air Kisses!', 'Smooch from Afar!', 'Blown Kisses!']
  },
  angrystare: {
    queries: ['angrystare', 'stare', 'mad'],
    endpoints: ["otaku"],
    titles: ['Staring Angrily!', 'The Death Stare!', 'Angry Eyes!']
  },
  brofist: {
    queries: ['brofist'],
    endpoints: ["otaku"],
    titles: ['Brofist!', 'Pound It!', 'Fist Bump!', 'Epic Brofist!']
  },
  cheers: {
    queries: ['cheers'],
    endpoints: ["otaku"],
    titles: ['Cheers!', 'To Good Times!', 'Bottoms Up!', 'Kanpai!']
  },
  clap: {
    queries: ['clap'],
    endpoints: ["otaku", "kawaii"],
    kawaiiEndpoint: 'clap',
    titles: ['Clapping!', 'Round of Applause!', 'Well Done!', 'Bravo!']
  },
  cool: {
    queries: ['cool'],
    endpoints: ["otaku"],
    titles: ['So Cool!', 'Cool Vibes!', 'Too Smooth!', 'Ice Cold!']
  },
  drool: {
    queries: ['drool'],
    endpoints: ["otaku"],
    titles: ['Drooling!', 'So Delicious!', 'Can\'t Help It!', 'Mouth Watering!']
  },
  evillaugh: {
    queries: ['evillaugh'],
    endpoints: ["otaku"],
    titles: ['MUHAHA!', 'Evil Laugh!', 'Villainous!', 'Sinister!']
  },
  handhold: {
    queries: ['handhold'],
    endpoints: ["otaku", "rndm", "nekos"],
    nekosEndpoint: 'handhold',
    titles: ['Hand Holding!', 'So Lewd!', 'Holding Hands!', 'Together!']
  },
  headbang: {
    queries: ['headbang'],
    endpoints: ["otaku"],
    titles: ['Headbanging!', 'Rock On!', 'Metal Mode!', 'Headbang Time!']
  },
  huh: {
    queries: ['huh'],
    endpoints: ["otaku"],
    titles: ['Huh?', 'What Was That?', 'Say Again?', 'Confused!']
  },
  no: {
    queries: ['no'],
    endpoints: ["otaku"],
    titles: ['Nope!', 'No Way!', 'Denied!', 'Absolutely Not!']
  },
  nyah: {
    queries: ['nyah'],
    endpoints: ["otaku"],
    titles: ['Nyah!', 'Teasing!', 'Mischievous!', 'Gotcha!']
  },
  pinch: {
    queries: ['pinch'],
    endpoints: ["otaku"],
    titles: ['*pinch*', 'Pinching Cheeks!', 'Gotcha!', 'Cheeky Pinch!']
  },
  roll: {
    queries: ['roll'],
    endpoints: ["otaku"],
    titles: ['Rolling Around!', '*rolls*', 'Barrel Roll!', 'Tumbling!']
  },
  sad: {
    queries: ['sad', 'cry'],
    endpoints: ["otaku"],
    titles: ['So Sad...', 'Big Sad!', 'Feeling Down...', 'Sadness...']
  },
  scared: {
    queries: ['scared'],
    endpoints: ["otaku", "kawaii"],
    kawaiiEndpoint: 'scared',
    titles: ['Scared!', 'So Frightened!', 'Help!', 'Terrified!']
  },
  shout: {
    queries: ['shout'],
    endpoints: ["otaku"],
    titles: ['AAAHHH!', 'Shouting!', 'Yelling!', 'Loud Noises!']
  },
  shy: {
    queries: ['shy'],
    endpoints: ["otaku"],
    titles: ['So Shy...', 'Feeling Bashful!', '*hides*', 'Too Embarrassed!']
  },
  sigh: {
    queries: ['sigh'],
    endpoints: ["otaku"],
    titles: ['*sigh*', 'Tired Sigh...', 'Deep Breath...', 'Exhale...']
  },
  sing: {
    queries: ['sing'],
    endpoints: ["otaku"],
    titles: ['Singing!', 'La La La!', 'Music Time!', 'Vocal Performance!']
  },
  sip: {
    queries: ['sip'],
    endpoints: ["otaku", "kawaii"],
    kawaiiEndpoint: 'sip',
    titles: ['*sip*', 'Tea Time!', 'Sipping!', 'Refreshing!']
  },
  slowclap: {
    queries: ['slowclap'],
    endpoints: ["otaku"],
    titles: ['Slow Clap...', 'Sarcastic Applause...', '*claps slowly*', 'Very Impressive...']
  },
  smack: {
    queries: ['smack'],
    endpoints: ["otaku"],
    titles: ['*SMACK!*', 'Bonk!', 'Whack!', 'Hit!']
  },
  sneeze: {
    queries: ['sneeze'],
    endpoints: ["otaku"],
    titles: ['Achoo!', 'Sneezing!', 'Bless You!', '*sneeze*']
  },
  sorry: {
    queries: ['sorry'],
    endpoints: ["otaku"],
    titles: ['So Sorry!', 'My Apologies!', 'Forgive Me!', 'Sorry!']
  },
  stop: {
    queries: ['stop'],
    endpoints: ["otaku"],
    titles: ['Stop!', 'Halt!', 'No More!', 'Cease!']
  },
  surprised: {
    queries: ['surprised'],
    endpoints: ["otaku"],
    titles: ['WHAT?!', 'So Shocked!', 'Surprise!', 'Didn\'t Expect That!']
  },
  sweat: {
    queries: ['sweat'],
    endpoints: ["otaku"],
    titles: ['Sweating!', 'Nervous Sweat!', 'Breaking a Sweat!', 'So Hot!']
  },
  woah: {
    queries: ['woah'],
    endpoints: ["otaku"],
    titles: ['Woah!', 'Whoa There!', 'Amazing!', 'Mind Blown!']
  },
  yay: {
    queries: ['yay'],
    endpoints: ["otaku"],
    titles: ['Yay!', 'Woohoo!', 'Excited!', 'Celebration!']
  },
  yes: {
    queries: ['yes'],
    endpoints: ["otaku"],
    titles: ['Yes!', 'Affirmative!', 'Absolutely!', 'You Bet!']
  }
};

// Sentence for each action: [with a target ({t} = target), without a target, optional self-target].
// Self-targets default to the first form with {t} = "themselves"; the third form overrides
// that where it would read badly. Every phrase reads after "**Name** " and is followed by "!".
const actionPhrases = {
  hug: ['hugs {t}', 'wants a hug'],
  kiss: ['kisses {t}', 'blows a kiss'],
  pat: ['pats {t}', 'hands out pats'],
  cuddle: ['cuddles {t}', 'wants to cuddle'],
  highfive: ['high-fives {t}', 'raises a hand for a high five'],
  wave: ['waves at {t}', 'waves'],
  smile: ['smiles at {t}', 'smiles'],
  blush: ['blushes at {t}', 'blushes'],
  love: ['showers {t} with love', 'is feeling the love'],
  headpat: ['gives {t} a headpat', 'hands out headpats'],
  dance: ['dances with {t}', 'dances'],
  celebrate: ['celebrates with {t}', 'celebrates'],
  laugh: ['laughs at {t}', 'laughs'],
  cry: ['cries to {t}', 'cries'],
  poke: ['pokes {t}', 'pokes around'],
  bonk: ['bonks {t}', 'swings the bonk hammer'],
  nom: ['noms on {t}', 'noms'],
  bread: ['shares bread with {t}', 'eats some bread'],
  chocolate: ['shares chocolate with {t}', 'enjoys some chocolate'],
  cookie: ['gives {t} a cookie', 'eats a cookie'],
  wink: ['winks at {t}', 'winks'],
  thumbsup: ['gives {t} a thumbs up', 'gives a thumbs up'],
  salute: ['salutes {t}', 'salutes'],
  slap: ['slaps {t}', 'is looking for someone to slap'],
  punch: ['punches {t}', 'throws a punch'],
  kick: ['kicks {t}', 'throws a kick'],
  angry: ['is angry at {t}', 'is angry'],
  rage: ['rages at {t}', 'is raging'],
  stab: ['stabs {t}', 'brandishes a knife', 'drops the knife'],
  spank: ['spanks {t}', 'threatens a spanking'],
  spit: ['spits at {t}', 'spits'],
  steal: ['steals from {t}', 'steals something'],
  bite: ['bites {t}', 'is looking for something to bite'],
  think: ['thinks about {t}', 'is thinking'],
  bored: ['is bored of {t}', 'is bored'],
  drunk: ['gets drunk with {t}', 'is drunk', 'drinks alone'],
  shrug: ['shrugs at {t}', 'shrugs'],
  sleep: ['falls asleep on {t}', 'falls asleep', 'falls asleep'],
  yawn: ['yawns at {t}', 'yawns'],
  confused: ['is confused by {t}', 'is confused'],
  facepalm: ['facepalms at {t}', 'facepalms'],
  nervous: ['is nervous around {t}', 'is nervous', 'is nervous'],
  excited: ['is excited to see {t}', 'is excited'],
  shocked: ['is shocked by {t}', 'is shocked'],
  smug: ['looks smugly at {t}', 'looks smug'],
  lick: ['licks {t}', 'licks their lips'],
  boop: ['boops {t}', 'boops a nose'],
  greet: ['greets {t}', 'greets everyone'],
  handholding: ['holds hands with {t}', 'wants to hold hands'],
  tickle: ['tickles {t}', 'is in a tickling mood'],
  kill: ['kills {t}', 'is out for blood', 'plays dead'],
  lonely: ['feels lonely without {t}', 'feels lonely', 'feels lonely'],
  hold: ['holds {t}', 'wants to be held'],
  pats: ['pats {t} over and over', 'hands out pats'],
  snuggle: ['snuggles {t}', 'wants to snuggle'],
  bully: ['bullies {t}', 'is feeling mischievous'],
  stare: ['stares at {t}', 'stares'],
  pout: ['pouts at {t}', 'pouts'],
  lewd: ['finds {t} too lewd', 'is getting flustered'],
  triggered: ['is triggered by {t}', 'is triggered'],
  smirk: ['smirks at {t}', 'smirks'],
  happy: ['is happy to see {t}', 'is happy'],
  thumbs: ['gives {t} two thumbs up', 'gives two thumbs up'],
  wag: ['wags their tail at {t}', 'wags their tail'],
  teehee: ['giggles at {t}', 'giggles'],
  scoff: ['scoffs at {t}', 'scoffs'],
  grin: ['grins at {t}', 'grins'],
  sleepy: ['dozes off on {t}', 'is sleepy', 'dozes off'],
  thonking: ['ponders {t}', 'is thonking'],
  triggered2: ['is triggered by {t}', 'is triggered'],
  push: ['pushes {t}', 'pushes everyone aside'],
  tackle: ['tackles {t}', 'charges in for a tackle'],
  throw: ['throws {t}', 'throws something'],
  grab: ['grabs {t}', 'grabs at the air'],
  tsundere: ['acts tsundere toward {t}', 'is being tsundere'],
  deredere: ['acts deredere toward {t}', 'is being deredere'],
  yandere: ['acts yandere toward {t}', 'is being yandere'],
  kuudere: ['acts kuudere toward {t}', 'is being kuudere'],
  dandere: ['acts dandere toward {t}', 'is being dandere'],
  run: ['runs away from {t}', 'runs away'],
  chase: ['chases {t}', 'gives chase'],
  feed: ['feeds {t}', 'is handing out food'],
  piggyback: ['gives {t} a piggyback ride', 'wants a piggyback ride'],
  nosebleed: ['gets a nosebleed because of {t}', 'gets a nosebleed'],
  faint: ['faints because of {t}', 'faints'],
  nod: ['nods at {t}', 'nods'],
  peek: ['peeks at {t}', 'peeks'],
  spin: ['spins {t} around', 'spins around'],
  trip: ['trips over {t}', 'trips'],
  headbutt: ['headbutts {t}', 'lowers their head for a headbutt'],
  lurk: ['lurks behind {t}', 'lurks in the shadows', 'lurks in the shadows'],
  spray: ['sprays {t} with water', 'readies the spray bottle'],
  flirt: ['flirts with {t}', 'is feeling flirty'],
  nuzzle: ['nuzzles {t}', 'wants to nuzzle'],
  bleh: ['sticks their tongue out at {t}', 'sticks their tongue out'],
  carry: ['carries {t}', 'offers to carry someone'],
  airkiss: ['blows a kiss to {t}', 'blows a kiss'],
  angrystare: ['glares at {t}', 'glares'],
  brofist: ['brofists {t}', 'holds out a fist for a brofist'],
  cheers: ['raises a glass to {t}', 'raises a glass'],
  clap: ['claps for {t}', 'claps'],
  cool: ['plays it cool with {t}', 'is playing it cool', 'is playing it cool'],
  drool: ['drools over {t}', 'drools'],
  evillaugh: ['laughs evilly at {t}', 'laughs evilly'],
  handhold: ['holds hands with {t}', 'wants to hold hands'],
  headbang: ['headbangs with {t}', 'headbangs', 'headbangs alone'],
  huh: ['looks at {t} in confusion', 'is confused'],
  no: ['says no to {t}', 'says no'],
  nyah: ['teases {t}', 'goes nyah'],
  pinch: ['pinches {t}', 'is looking for cheeks to pinch'],
  roll: ['rolls around with {t}', 'rolls around', 'rolls around'],
  sad: ['is sad because of {t}', 'is sad'],
  scared: ['is scared of {t}', 'is scared'],
  shout: ['shouts at {t}', 'shouts'],
  shy: ['is shy around {t}', 'is feeling shy'],
  sigh: ['sighs at {t}', 'sighs'],
  sing: ['sings to {t}', 'sings'],
  sip: ['sips tea with {t}', 'sips some tea', 'sips tea alone'],
  slowclap: ['slow claps for {t}', 'slow claps'],
  smack: ['smacks {t}', 'smacks the table'],
  sneeze: ['sneezes on {t}', 'sneezes'],
  sorry: ['apologizes to {t}', 'apologizes'],
  stop: ['tells {t} to stop', 'says stop'],
  surprised: ['is surprised by {t}', 'is surprised'],
  sweat: ['sweats nervously around {t}', 'is sweating', 'is sweating nervously'],
  woah: ['is amazed by {t}', 'says woah'],
  yay: ['cheers for {t}', 'cheers'],
  yes: ['says yes to {t}', 'says yes']
};

// Usernames may contain markdown characters (e.g. underscores)
const boldName = (user) => `**${escapeMarkdown(user.username)}**`;

function buildActionText(action, author, target) {
  const [withTarget, alone, self] = actionPhrases[action] ?? ['reacts to {t}', 'reacts'];
  if (!target) return `${boldName(author)} ${alone}!`;
  if (target.id === author.id) return `${boldName(author)} ${self ?? withTarget.replace('{t}', 'themselves')}!`;
  return `${boldName(author)} ${withTarget.replace('{t}', () => boldName(target))}!`;
}

export default {
  name: 'react',
  description: 'Send anime reaction GIFs',
  usage: 'react <action> [@user]',
  aliases: ['reaction', 'anime'],
  category: 'utility',
  cooldown: 3,

  execute: async (message, args) => {
    const guildId = message.guild.id;

    try {
      if (!args.length) {
        const prefix = await getPrefix(guildId);

        // Organized reaction categories with descriptions
        const categories = {
          'Affectionate': {
            subtitle: 'Show your love and care',
            reactions: ['hug', 'kiss', 'airkiss', 'pat', 'headpat', 'pats', 'cuddle', 'snuggle', 'nuzzle', 'love', 'hold', 'handhold', 'handholding', 'carry']
          },
          'Positive Vibes': {
            subtitle: 'Spread positivity and encouragement',
            reactions: ['highfive', 'brofist', 'wave', 'greet', 'smile', 'blush', 'happy', 'wink', 'thumbsup', 'thumbs', 'salute', 'nod', 'yes', 'yay', 'cheers', 'clap', 'slowclap']
          },
          'Fun & Playful': {
            subtitle: 'Have fun and mess around',
            reactions: ['dance', 'celebrate', 'laugh', 'excited', 'spin', 'wag', 'poke', 'boop', 'lick', 'bleh', 'tickle', 'bonk', 'nom', 'feed', 'bread', 'chocolate', 'cookie', 'drunk', 'teehee', 'grin', 'flirt', 'nyah', 'pinch', 'headbang', 'sing', 'sip', 'drool']
          },
          'Aggressive': {
            subtitle: 'Express your anger (playfully)',
            reactions: ['slap', 'punch', 'kick', 'push', 'throw', 'tackle', 'grab', 'headbutt', 'stab', 'bite', 'kill', 'spit', 'angry', 'angrystare', 'rage', 'triggered', 'bully', 'smack', 'spank', 'steal']
          },
          'Physical Actions': {
            subtitle: 'Get physical with these moves',
            reactions: ['spray', 'run', 'chase', 'piggyback', 'trip', 'faint', 'roll']
          },
          'Sleepy Time': {
            subtitle: 'When you\'re feeling tired',
            reactions: ['sleep', 'sleepy', 'yawn', 'sigh']
          },
          'Emotional': {
            subtitle: 'Express your feelings',
            reactions: ['cry', 'sad', 'lonely', 'pout', 'nervous', 'sweat', 'scared', 'sorry', 'shy']
          },
          'Thoughtful': {
            subtitle: 'When you need to think or react',
            reactions: ['think', 'thonking', 'confused', 'huh', 'shrug', 'facepalm', 'scoff', 'bored']
          },
          'Observing': {
            subtitle: 'Watch from the shadows',
            reactions: ['stare', 'peek', 'lurk']
          },
          'Anime Dere Types': {
            subtitle: 'Show your personality type',
            reactions: ['tsundere', 'deredere', 'yandere', 'kuudere', 'dandere']
          },
          'Special Reactions': {
            subtitle: 'Unique and special moments',
            reactions: ['lewd', 'nosebleed', 'shocked', 'surprised', 'woah', 'smug', 'smirk', 'cool']
          },
          'Communication': {
            subtitle: 'Express yourself verbally',
            reactions: ['shout', 'sneeze', 'stop', 'no', 'evillaugh']
          }
        };

        const embed = await infoEmbed(
          guildId,
          'Reaction Archive',
          `**Analysis:** The following reactions are available, Master.\nUse \`${prefix}react <action> [@user]\` to perform one.`
        );

        // One field per category (12 categories + 2 info fields stays under the 25-field limit)
        for (const [category, data] of Object.entries(categories)) {
          embed.addFields({
            name: `▸ ${category}`,
            value: `*${data.subtitle}*\n${data.reactions.map(r => `\`${r}\``).join(', ')}`,
            inline: false
          });
        }

        embed.addFields(
          {
            name: '▸ Usage',
            value: `\`${prefix}react <action> [@user]\``,
            inline: false
          },
          {
            name: '▸ Examples',
            value: `• \`${prefix}react hug @user\` — hug someone\n• \`${prefix}react dance\` — dance by yourself\n• \`${prefix}react tsundere @user\` — B-Baka! >///<`,
            inline: false
          }
        );

        return message.reply({ embeds: [embed] });
      }

      const action = args[0].toLowerCase();
      const targetUser = message.mentions.users.first();

      if (!Object.hasOwn(reactions, action)) {
        const prefix = await getPrefix(guildId);
        return message.reply({
          embeds: [await warningEmbed(
            guildId,
            'Unknown Reaction',
            `No reaction named \`${truncate(action.replace(/`/g, ''), 100)}\` exists, Master.\nUse \`${prefix}react\` without arguments to view every available reaction.`
          )]
        });
      }

      const reactionData = reactions[action];
      const randomQuery = reactionData.queries[Math.floor(Math.random() * reactionData.queries.length)];
      const randomTitle = reactionData.titles[Math.floor(Math.random() * reactionData.titles.length)];

      // Get endpoints (default to otaku if not specified for backwards compatibility)
      const endpoints = reactionData.endpoints || ['otaku'];

      let gifUrl = null;
      let usedEndpoint = null;

      // Try each endpoint until we get a result
      for (const endpoint of endpoints) {
        logger.info(`React command: Trying endpoint ${endpoint} for action ${action}`);

        try {
          let response;
          const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);

          if (endpoint === 'otaku') {
            logger.info(`React command: Fetching from OtakuGifs for action ${action} with query ${randomQuery}`);
            response = await fetch(
              `https://api.otakugifs.xyz/gif?reaction=${randomQuery}&format=gif`,
              { signal }
            );
          } else if (endpoint === 'rndm') {
            logger.info(`React command: Fetching from RndmServ for action ${action} with query ${randomQuery}`);
            response = await fetch(
              `https://gifs.rndmserv.de/api/gif/${randomQuery}`,
              { signal }
            );
          } else if (endpoint === 'kawaii') {
            const kawaiiEndpoint = reactionData.kawaiiEndpoint || randomQuery;
            const kawaiiToken = process.env.KAWAII_API_TOKEN || 'anonymous';
            logger.info(`React command: Fetching from Kawaii API for action ${action} with endpoint ${kawaiiEndpoint}`);
            response = await fetch(
              `https://kawaii.red/api/gif/${kawaiiEndpoint}?token=${encodeURIComponent(kawaiiToken)}`,
              { signal }
            );
          } else if (endpoint === 'nekos') {
            const nekosEndpoint = reactionData.nekosEndpoint || randomQuery;
            logger.info(`React command: Fetching from Nekos.best API for action ${action} with endpoint ${nekosEndpoint}`);
            response = await fetch(
              `https://nekos.best/api/v2/${nekosEndpoint}?amount=1`,
              { signal }
            );
          }

          if (response && response.status === 200) {
            logger.info(`React command: Fetched from ${endpoint} for action ${action}`);
            const data = await response.json();
            logger.info(`React command: ${endpoint} API response: ${JSON.stringify(data)}`);
            if (endpoint === 'otaku' && data && data.url) {
              gifUrl = data.url;
              usedEndpoint = 'OtakuGifs';
              break;
            } else if (endpoint === 'rndm' && data && data.url) {
              gifUrl = data.url;
              usedEndpoint = 'RndmServ';
              break;
            } else if (endpoint === 'kawaii' && data && data.response && !data.error) {
              gifUrl = data.response;
              usedEndpoint = 'Kawaii API';
              break;
            } else if (endpoint === 'nekos' && data && data.results && data.results.length > 0) {
              gifUrl = data.results[0].url;
              usedEndpoint = 'Nekos.best';
              break;
            }
          }
        } catch (err) {
          // Timeout, network error or bad JSON: try the next endpoint
          logger.warn(`React command: ${endpoint} failed for action ${action}: ${err?.message || err}`);
          continue;
        }
      }

      if (!gifUrl) {
        return message.reply({
          embeds: [await warningEmbed(guildId, 'No Reaction Data', 'No reaction image could be retrieved from any source. Please retry shortly, Master.')]
        });
      }

      const embed = new EmbedBuilder()
        .setColor(COLORS.RAPHAEL)
        .setTitle(`『 ${randomTitle} 』`)
        .setDescription(`${buildActionText(action, message.author, targetUser)}\n› Source: ${usedEndpoint}`)
        .setImage(gifUrl)
        .setFooter({ text: getRandomFooter() })
        .setTimestamp();

      await message.reply({ embeds: [embed] });

    } catch (error) {
      console.error('React command error:', error);
      try {
        await message.reply({
          embeds: [await errorEmbed(guildId, 'Reaction Failed', 'The reaction image could not be retrieved, Master. Please try again later.')]
        });
      } catch {
        // Reply failed too (message deleted or no permission); nothing more to do
      }
    }
  }
};
