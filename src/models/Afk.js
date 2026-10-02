import mongoose from 'mongoose';

// Only the most recent mentions are kept; totalMentions still counts every one
const MAX_STORED_MENTIONS = 100;

const afkSchema = new mongoose.Schema({
  guildId: {
    type: String,
    required: true
  },
  odId: {
    type: String,
    required: true
  },
  reason: {
    type: String,
    default: 'AFK'
  },
  timestamp: {
    type: Date,
    default: Date.now
  },
  // Enhanced features
  autoRemove: {
    type: Boolean,
    default: true // Auto-remove when user sends a message (false = sticky)
  },
  scheduledReturn: {
    type: Date, // Optional: the status lapses at this time
    default: null
  },
  originalNickname: {
    type: String, // Server nickname before the [AFK] tag (null = no nickname)
    default: null
  },
  mentions: [{
    odId: String,
    username: String,
    channelId: String,
    messageId: String,
    messageContent: String,
    timestamp: { type: Date, default: Date.now }
  }],
  // Stats
  totalMentions: {
    type: Number,
    default: 0
  },
  timesAfk: {
    type: Number,
    default: 1
  }
});

// Compound index for quick lookups
afkSchema.index({ guildId: 1, odId: 1 }, { unique: true });
afkSchema.index({ scheduledReturn: 1 }); // For scheduled return queries

// Static method to set AFK.
// options.keepHistory keeps the original start time and recorded mentions
// (used when an already-away member only changes their reason or options).
afkSchema.statics.setAfk = async function (guildId, odId, reason = 'AFK', options = {}) {
  const set = {
    reason,
    autoRemove: options.autoRemove !== false,
    scheduledReturn: options.scheduledReturn || null,
    originalNickname: options.originalNickname ?? null
  };
  const update = { $set: set, $setOnInsert: { guildId, odId } };

  if (!options.keepHistory) {
    set.timestamp = new Date();
    set.mentions = [];
    set.totalMentions = 0;
    update.$inc = { timesAfk: 1 };
  }

  return await this.findOneAndUpdate(
    { guildId, odId },
    update,
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
};

// Static method to remove AFK (returns the removed record, or null if there was none)
afkSchema.statics.removeAfk = async function (guildId, odId) {
  return await this.findOneAndDelete({ guildId, odId });
};

// Static method to get AFK status
afkSchema.statics.getAfk = async function (guildId, odId) {
  return await this.findOne({ guildId, odId });
};

// Static method to get the AFK records of several members at once
afkSchema.statics.getAfkUsers = async function (guildId, odIds) {
  if (!odIds?.length) return [];
  return await this.find({ guildId, odId: { $in: odIds } });
};

// Static method to add a mention to one member (odId) or several (array of odIds)
afkSchema.statics.addMention = async function (guildId, odId, mention) {
  return await this.updateMany(
    { guildId, odId: Array.isArray(odId) ? { $in: odId } : odId },
    {
      $push: { mentions: { $each: [mention], $slice: -MAX_STORED_MENTIONS } },
      $inc: { totalMentions: 1 }
    }
  );
};

// Static method to get all AFK users in a guild
afkSchema.statics.getGuildAfk = async function (guildId) {
  return await this.find({ guildId });
};

// Static method to get scheduled AFK returns that are due
afkSchema.statics.getScheduledReturns = async function () {
  return await this.find({
    scheduledReturn: { $lte: new Date() }
  });
};

// Whether the scheduled return time (--time) has passed
afkSchema.methods.isExpired = function (now = Date.now()) {
  return Boolean(this.scheduledReturn) && new Date(this.scheduledReturn).getTime() <= now;
};

// Get time since AFK
afkSchema.methods.getAfkDuration = function () {
  const diff = Date.now() - this.timestamp;
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
};

export default mongoose.model('Afk', afkSchema);
