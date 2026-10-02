import mongoose from 'mongoose';

const socialSchema = new mongoose.Schema({
  odId: {
    type: String,
    required: true
  },
  guildId: {
    type: String,
    required: true
  },

  // Marriage system
  marriage: {
    partnerId: String,
    marriedAt: Date,
    proposedBy: String, // Who proposed
    rings: {
      type: String,
      default: '💍'
    }
  },

  // Pending proposals (received)
  pendingProposals: [{
    odId: String,
    timestamp: { type: Date, default: Date.now },
    message: String
  }],

  // Profile badges
  badges: [{
    id: String,
    name: String,
    emoji: String,
    description: String,
    earnedAt: { type: Date, default: Date.now }
  }],

  // Profile customization
  profile: {
    bio: { type: String, maxlength: 200 },
    color: { type: String, default: '#5865F2' },
    birthday: Date,
    pronouns: String,
    socials: {
      twitter: String,
      instagram: String,
      youtube: String,
      twitch: String
    }
  },

  // Social stats
  stats: {
    hugsGiven: { type: Number, default: 0 },
    hugsReceived: { type: Number, default: 0 },
    patsGiven: { type: Number, default: 0 },
    patsReceived: { type: Number, default: 0 },
    cuddlesGiven: { type: Number, default: 0 },
    cuddlesReceived: { type: Number, default: 0 },
    kissesGiven: { type: Number, default: 0 },
    kissesReceived: { type: Number, default: 0 },
    slapsGiven: { type: Number, default: 0 },
    slapsReceived: { type: Number, default: 0 }
  },

  // Achievements
  achievements: [{
    id: String,
    name: String,
    description: String,
    unlockedAt: { type: Date, default: Date.now }
  }]
}, {
  timestamps: true
});

// Compound index
socialSchema.index({ odId: 1, guildId: 1 }, { unique: true });

// Static method to get or create social profile.
// One atomic upsert, so two first-time commands at once can't both insert (E11000).
// Only $setOnInsert is sent: an existing document is returned untouched (timestamps are
// skipped for the query and set by hand on insert, so reads never bump updatedAt).
socialSchema.statics.getSocial = async function (odId, guildId) {
  const now = new Date();
  try {
    return await this.findOneAndUpdate(
      { odId, guildId },
      { $setOnInsert: { createdAt: now, updatedAt: now } },
      { upsert: true, new: true, setDefaultsOnInsert: true, timestamps: false }
    );
  } catch (error) {
    // Servers that don't retry racing upserts report the loser as a duplicate key: the document exists now
    if (error?.code === 11000) return this.findOne({ odId, guildId });
    throw error;
  }
};

// Check if user is married
socialSchema.methods.isMarried = function () {
  return !!this.marriage?.partnerId;
};

// Get marriage duration
socialSchema.methods.getMarriageDuration = function () {
  if (!this.marriage?.marriedAt) return null;
  const now = new Date();
  const diff = now - this.marriage.marriedAt;
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));
  return days;
};

// Add badge
socialSchema.methods.addBadge = async function (badge) {
  const exists = this.badges.some(b => b.id === badge.id);
  if (!exists) {
    this.badges.push(badge);
    await this.save();
    return true;
  }
  return false;
};

// Available badges
socialSchema.statics.BADGES = {
  FIRST_MARRIAGE: { id: 'first_marriage', name: 'First Love', emoji: '💕', description: 'Got married for the first time' },
  LONG_MARRIAGE: { id: 'long_marriage', name: 'Eternal Love', emoji: '💖', description: 'Married for 100+ days' },
  SOCIAL_BUTTERFLY: { id: 'social_butterfly', name: 'Social Butterfly', emoji: '🦋', description: 'Gave 100+ hugs' },
  LEVEL_10: { id: 'level_10', name: 'Rising Star', emoji: '⭐', description: 'Reached level 10' },
  LEVEL_25: { id: 'level_25', name: 'Veteran', emoji: '🌟', description: 'Reached level 25' },
  LEVEL_50: { id: 'level_50', name: 'Legend', emoji: '✨', description: 'Reached level 50' },
  RICH: { id: 'rich', name: 'Millionaire', emoji: '💰', description: 'Earned 1,000,000 coins total' },
  GAMBLER: { id: 'gambler', name: 'High Roller', emoji: '🎰', description: 'Won 100+ gambling games' },
  HELPER: { id: 'helper', name: 'Helpful', emoji: '🤝', description: 'Gave 50+ reputation points' },
  EARLY_BIRD: { id: 'early_bird', name: 'Early Bird', emoji: '🐦', description: 'One of the first 100 members' },
  BOOSTER: { id: 'booster', name: 'Supporter', emoji: '💎', description: 'Boosted the server' },
  BIRTHDAY: { id: 'birthday', name: 'Birthday Star', emoji: '🎂', description: 'Celebrated a birthday' },
  VOICE_ADDICT: { id: 'voice_addict', name: 'Voice Addict', emoji: '🎤', description: 'Spent 24+ hours in voice' },
  MSG_MASTER: { id: 'msg_master', name: 'Chatterbox', emoji: '💬', description: 'Sent 10,000+ messages' }
};

export default mongoose.model('Social', socialSchema);
