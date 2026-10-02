import mongoose from 'mongoose';

const giveawaySchema = new mongoose.Schema({
  guildId: {
    type: String,
    required: true
  },
  channelId: {
    type: String,
    required: true
  },
  messageId: {
    type: String,
    required: true,
    unique: true
  },
  hostId: {
    type: String,
    required: true
  },
  prize: {
    type: String,
    required: true
  },
  winners: {
    type: Number,
    default: 1
  },
  endsAt: {
    type: Date,
    required: true
  },
  ended: {
    type: Boolean,
    default: false
  },
  participants: [{
    type: String // User IDs
  }],
  winnerIds: [{
    type: String
  }],
  requirements: {
    roleId: String, // Must have this role
    minLevel: Number, // Minimum level required
    minMessages: Number // Minimum messages required
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

// Index for finding active giveaways
giveawaySchema.index({ guildId: 1, ended: 1 });
giveawaySchema.index({ endsAt: 1, ended: 1 });

// Static method to get active giveaways
giveawaySchema.statics.getActiveGiveaways = async function () {
  return await this.find({ ended: false, endsAt: { $lte: new Date() } });
};

// Static method to get guild giveaways
giveawaySchema.statics.getGuildGiveaways = async function (guildId, includeEnded = false) {
  const query = { guildId };
  if (!includeEnded) query.ended = false;
  return await this.find(query).sort({ endsAt: 1 });
};

// Add a participant atomically (concurrent clicks cannot overwrite each other).
// Resolves to the updated giveaway, or null if the giveaway ended or the user had already entered.
giveawaySchema.methods.addParticipant = async function (userId) {
  return this.constructor.findOneAndUpdate(
    { _id: this._id, ended: false, participants: { $ne: userId } },
    { $addToSet: { participants: userId } },
    { new: true }
  );
};

// Remove a participant atomically. Resolves to the updated giveaway, or null if nothing changed.
giveawaySchema.methods.removeParticipant = async function (userId) {
  return this.constructor.findOneAndUpdate(
    { _id: this._id, ended: false, participants: userId },
    { $pull: { participants: userId } },
    { new: true }
  );
};

// Pick up to `count` random participants, skipping anyone in `exclude`.
// By default previous winners are skipped, so a reroll never redraws someone who already won.
giveawaySchema.methods.pickWinners = function (count = this.winners, exclude = this.winnerIds || []) {
  const excluded = new Set(exclude);
  const pool = this.participants.filter(id => !excluded.has(id));
  const winners = [];
  const winnerCount = Math.min(count, pool.length);

  for (let i = 0; i < winnerCount; i++) {
    const randomIndex = Math.floor(Math.random() * pool.length);
    winners.push(pool.splice(randomIndex, 1)[0]);
  }

  return winners;
};

export default mongoose.model('Giveaway', giveawaySchema);
