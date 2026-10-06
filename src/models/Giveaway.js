import { randomInt } from 'node:crypto';
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
  // When entries close. Ending a giveaway early moves this to the moment it was ended.
  endsAt: {
    type: Date,
    required: true
  },
  // Set together with winnerIds and endedAt when the giveaway is claimed for its draw
  ended: {
    type: Boolean,
    default: false
  },
  endedAt: {
    type: Date
  },
  // Results posted. A claimed giveaway still unannounced after a restart is announced again.
  announced: {
    type: Boolean,
    default: false
  },
  participants: [{
    type: String // User IDs
  }],
  // Everyone drawn so far (the draw and every reroll); rerolls never draw them again
  winnerIds: [{
    type: String
  }],
  requirements: {
    roleId: String // Must hold this role to enter and to win
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

// Listing a guild's giveaways
giveawaySchema.index({ guildId: 1, ended: 1 });
// The scheduler's due query
giveawaySchema.index({ endsAt: 1, ended: 1 });
// Interrupted announcements (claimed, never announced)
giveawaySchema.index({ endedAt: 1 }, { partialFilterExpression: { announced: false } });

// Giveaways whose end time has passed and that nobody has claimed yet, oldest first
giveawaySchema.statics.getDueGiveaways = function (limit = 25) {
  return this.find({ ended: false, endsAt: { $lte: new Date() } })
    .sort({ endsAt: 1 })
    .limit(limit)
    .select('_id guildId messageId')
    .lean();
};

// Giveaways claimed before `claimedBefore` whose results were never posted (the bot stopped mid-way)
giveawaySchema.statics.getInterruptedGiveaways = function (claimedBefore, limit = 25) {
  return this.find({ ended: true, announced: false, endedAt: { $lte: claimedBefore } })
    .sort({ endedAt: 1 })
    .limit(limit)
    .select('_id guildId messageId endedAt')
    .lean();
};

// A guild's active giveaways (soonest first) or concluded ones (latest first), with the
// participant count instead of the full participant list
giveawaySchema.statics.listGuildGiveaways = function (guildId, { ended = false, limit = 0 } = {}) {
  const pipeline = [
    { $match: { guildId, ended } },
    { $sort: ended ? { endedAt: -1, endsAt: -1 } : { endsAt: 1 } }
  ];
  if (limit > 0) pipeline.push({ $limit: limit });
  pipeline.push({
    $project: {
      prize: 1,
      channelId: 1,
      messageId: 1,
      endsAt: 1,
      endedAt: 1,
      winners: 1,
      winnerIds: 1,
      requirements: 1,
      participantCount: { $size: { $ifNull: ['$participants', []] } }
    }
  });
  return this.aggregate(pipeline);
};

// Add a participant atomically (concurrent clicks cannot overwrite each other).
// Resolves to the updated giveaway, or null if entries have closed or the user had already entered.
giveawaySchema.methods.addParticipant = async function (userId) {
  return this.constructor.findOneAndUpdate(
    { _id: this._id, ended: false, endsAt: { $gt: new Date() }, participants: { $ne: userId } },
    { $addToSet: { participants: userId } },
    { new: true }
  );
};

// Remove a participant atomically. Resolves to the updated giveaway, or null if nothing changed
// (not entered, or entries have closed: the draw may already be under way).
giveawaySchema.methods.removeParticipant = async function (userId) {
  return this.constructor.findOneAndUpdate(
    { _id: this._id, ended: false, endsAt: { $gt: new Date() }, participants: userId },
    { $pull: { participants: userId } },
    { new: true }
  );
};

// Pick up to `count` random participants, skipping anyone in `exclude`.
// By default previous winners are skipped, so a reroll never redraws someone who already won.
// Partial Fisher-Yates shuffle with a CSPRNG: every eligible participant is equally likely.
giveawaySchema.methods.pickWinners = function (count = this.winners, exclude = this.winnerIds || []) {
  const excluded = new Set(exclude);
  const pool = [...new Set(this.participants)].filter(id => !excluded.has(id));
  const winnerCount = Math.max(0, Math.min(count, pool.length));

  for (let i = 0; i < winnerCount; i++) {
    const j = randomInt(i, pool.length);
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }

  return pool.slice(0, winnerCount);
};

export default mongoose.model('Giveaway', giveawaySchema);
