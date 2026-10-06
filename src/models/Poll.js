import mongoose from 'mongoose';

// How long a concluded poll is kept before MongoDB removes it (TTL on endedAt)
const ENDED_POLL_RETENTION_SECONDS = 30 * 24 * 60 * 60;

const pollOptionSchema = new mongoose.Schema({
  label: {
    type: String,
    required: true
  },
  // User IDs. A user is in at most one option's list (single choice); votes are changed
  // only with atomic $addToSet/$pull updates (see pollButtonHandler.js)
  votes: {
    type: [String],
    default: []
  }
}, { _id: false });

const pollSchema = new mongoose.Schema({
  guildId: {
    type: String,
    required: true
  },
  channelId: {
    type: String,
    required: true
  },
  // The poll message; also the poll ID shown in its footer and used by "poll end <pollId>"
  messageId: {
    type: String,
    required: true,
    unique: true
  },
  creatorId: {
    type: String,
    required: true
  },
  creatorName: String,
  question: {
    type: String,
    required: true
  },
  options: {
    type: [pollOptionSchema],
    validate: {
      validator: options => options.length >= 2 && options.length <= 4,
      message: 'A poll needs between 2 and 4 options'
    }
  },
  // Footer phrase picked at creation, so it stays the same on every edit
  footerTag: String,
  endsAt: {
    type: Date,
    required: true
  },
  ended: {
    type: Boolean,
    default: false
  },
  endedAt: Date,
  createdAt: {
    type: Date,
    default: Date.now
  }
});

// Open polls due to end (the expiry sweep)
pollSchema.index({ ended: 1, endsAt: 1 });
// Polls of a guild
pollSchema.index({ guildId: 1, ended: 1 });
// Concluded polls are removed after the retention period; open polls have no endedAt
pollSchema.index({ endedAt: 1 }, { expireAfterSeconds: ENDED_POLL_RETENTION_SECONDS });

export default mongoose.model('Poll', pollSchema);
