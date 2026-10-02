import mongoose from 'mongoose';

const modLogSchema = new mongoose.Schema({
  guildId: {
    type: String,
    required: true
  },
  caseNumber: {
    type: Number,
    required: true
  },
  action: {
    type: String,
    required: true,
    enum: [
      'warn', 'mute', 'unmute', 'kick', 'ban', 'unban', 'purge', 'slowmode', 'note', 'invite_delete', 'sus_alert',
      'timeout', 'untimeout',
      // AutoMod actions
      'automod_badWords', 'automod_spam', 'automod_caps', 'automod_links', 'automod_invites',
      'automod_mentions', 'automod_emojis', 'automod_zalgo', 'automod_newlines',
      'automod_massMention', 'automod_invite', 'automod_link',
      // Award actions
      'award_xp', 'award_coins', 'award_rep'
    ]
  },
  moderatorId: {
    type: String,
    required: true
  },
  moderatorTag: String,
  targetId: String,
  targetTag: String,
  reason: String,
  details: mongoose.Schema.Types.Mixed,
  duration: String,
  messageId: String, // ID of the log message in Discord
  channelId: String,
  deletedMessage: String // The content of the deleted message (for automod logs)
}, {
  timestamps: true
});

// Compound index
modLogSchema.index({ guildId: 1, caseNumber: 1 }, { unique: true });

// Per-guild case counter. Reading the highest case and adding one let two concurrent
// actions pick the same number and fail on the unique index, so numbers come from an
// atomic $inc instead.
const modLogCounterSchema = new mongoose.Schema({
  _id: { type: String, required: true }, // guildId
  seq: { type: Number, default: 0 }
}, {
  versionKey: false
});

const ModLogCounter = mongoose.models.ModLogCounter
  || mongoose.model('ModLogCounter', modLogCounterSchema, 'modlogcounters');

const DUPLICATE_KEY = 11000;

// Get next case number for guild
modLogSchema.statics.getNextCaseNumber = async function (guildId) {
  const increment = () => ModLogCounter.findOneAndUpdate(
    { _id: guildId },
    { $inc: { seq: 1 } },
    { new: true }
  ).lean();

  let counter = await increment();
  if (counter) return counter.seq;

  // First use for this guild: continue from the cases recorded before the counter existed.
  // $max keeps this safe when another call seeds (or increments) the counter at the same time.
  const lastCase = await this.findOne({ guildId })
    .sort({ caseNumber: -1 })
    .select('caseNumber')
    .lean();
  try {
    await ModLogCounter.updateOne(
      { _id: guildId },
      { $max: { seq: lastCase?.caseNumber ?? 0 } },
      { upsert: true }
    );
  } catch (error) {
    if (error.code !== DUPLICATE_KEY) throw error; // a concurrent call created the counter first
  }

  counter = await increment();
  return counter.seq;
};

export default mongoose.model('ModLog', modLogSchema);
